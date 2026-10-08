import type { Viewer } from "@photo-sphere-viewer/core";
import type { EquirectangularVideoPanorama } from "@photo-sphere-viewer/equirectangular-video-adapter";
import log from "ente-base/log";
import { isSupportedSphericalVideo } from "ente-gallery/utils/spherical-video";
import type { SphericalVideoMetadata } from "ente-media/file-metadata";
import type { Hls } from "hls-video-element";
import { t } from "i18next";

export interface SphericalVideoPlaybackState {
    currentTime: number;
    muted: boolean;
    volume: number;
    paused: boolean;
    yaw: number;
    pitch: number;
    zoom: number;
}

interface StreamingOptions {
    playlistURL?: string;
    original?: boolean;
    playbackState?: SphericalVideoPlaybackState;
    onQualityChange?: (state: SphericalVideoPlaybackState) => void;
}

const playbackStates = new WeakMap<
    HTMLVideoElement,
    SphericalVideoPlaybackState
>();

/** A synchronous disposer also cancels initialization when the user navigates away. */
export const mountSphericalVideo = (
    container: HTMLElement,
    metadata: SphericalVideoMetadata,
    autoPlayMuted: boolean,
    options: StreamingOptions = {},
) => {
    let disposed = false;
    let failed = false;
    let viewer: Viewer | undefined;
    let hls: Hls | undefined;
    const video = container.querySelector("video")!;
    const previous = playbackStates.get(video) ?? options.playbackState;
    const resumeAt = previous?.currentTime ?? video.currentTime;
    if (previous) video.muted = previous.muted;
    const surface = container.querySelector<HTMLElement>(
        ".ente-spherical-surface",
    )!;
    const snapshot = (): SphericalVideoPlaybackState => ({
        currentTime: video.readyState >= 1 ? video.currentTime : resumeAt,
        muted: video.muted,
        volume: video.volume,
        paused: video.paused,
        yaw: viewer?.getPosition().yaw ?? previous?.yaw ?? 0,
        pitch: viewer?.getPosition().pitch ?? previous?.pitch ?? 0,
        zoom: viewer?.getZoomLevel() ?? previous?.zoom ?? 50,
    });
    const showError = (message: string) => {
        video.pause();
        surface.textContent = message;
        surface.classList.add("ente-spherical-error");
        if (options.playlistURL && options.onQualityChange) {
            const button = document.createElement("button");
            button.textContent = t("original");
            button.onclick = () =>
                options.onQualityChange?.(
                    playbackStates.get(video) ?? snapshot(),
                );
            surface.append(button);
        }
    };
    const handleFailure = (error: unknown) => {
        if (disposed || failed) return;
        failed = true;
        log.error("Failed to initialize spherical video", error);
        const state = snapshot();
        hls?.destroy();
        hls = undefined;
        viewer?.destroy();
        viewer = undefined;
        playbackStates.set(video, state);
        container.prepend(video);
        showError(t("spherical_video_playback_error"));
    };
    const onMediaError = () =>
        handleFailure(video.error ?? new Error("Video playback failed"));
    video.addEventListener("error", onMediaError);

    if (!isSupportedSphericalVideo(metadata)) {
        showError(t("spherical_video_unsupported"));
    } else {
        void Promise.all([
            import("@photo-sphere-viewer/core"),
            import("@photo-sphere-viewer/equirectangular-video-adapter"),
            import("@photo-sphere-viewer/video-plugin"),
            options.playlistURL ? import("hls-video-element") : undefined,
        ])
            .then(
                ([
                    { Viewer, utils },
                    { EquirectangularVideoAdapter },
                    { VideoPlugin },
                    streaming,
                ]) => {
                    if (disposed) return;
                    surface.replaceChildren();
                    surface.classList.remove("ente-spherical-error");
                    // The upstream adapter does not cancel a pending metadata load.
                    // Guard late completion before it can touch a destroyed renderer.
                    class VideoAdapter extends EquirectangularVideoAdapter {
                        override async loadTexture(
                            panorama: EquirectangularVideoPanorama,
                        ) {
                            const textureData = await super.loadTexture(
                                panorama,
                            );
                            if (disposed || failed) {
                                this.disposeTexture(textureData);
                                throw utils.getAbortError();
                            }
                            return textureData;
                        }
                    }
                    viewer = new Viewer({
                        container: surface,
                        adapter: [
                            VideoAdapter,
                            { shader: true, muted: video.muted },
                        ],
                        plugins: [[VideoPlugin, { progressbar: true }]],
                        keyboard: false,
                        defaultYaw: previous?.yaw ?? 0,
                        defaultPitch: previous?.pitch ?? 0,
                        defaultZoomLvl: previous?.zoom ?? 50,
                        navbar: [
                            "videoPlay",
                            "videoVolume",
                            "videoTime",
                            ...(options.onQualityChange
                                ? [
                                      {
                                          id: "video-quality",
                                          className:
                                              "ente-spherical-quality-button",
                                          content: options.original
                                              ? t("original")
                                              : t("auto"),
                                          title: t("quality"),
                                          onClick: () =>
                                              options.onQualityChange?.(
                                                  snapshot(),
                                              ),
                                      },
                                  ]
                                : []),
                            "zoom",
                            {
                                id: "reset-view",
                                content: "↺",
                                title: t("reset_view"),
                                onClick: (viewer) =>
                                    viewer.rotate({ yaw: 0, pitch: 0 }),
                            },
                            "fullscreen",
                        ],
                        lang: {
                            zoom: t("zoom"),
                            fullscreen: t("toggle_fullscreen"),
                            videoPlay: t("play_pause"),
                            videoVolume: t("audio"),
                            loadError: t("spherical_video_playback_error"),
                        },
                        sphereCorrection: {
                            pan: `${metadata.yaw}deg`,
                            tilt: `${metadata.pitch}deg`,
                            roll: `${metadata.roll}deg`,
                        },
                    });
                    // Explicitly handle load failures instead of falling back to a flat image.
                    const loaded = viewer.setPanorama({ source: video });
                    // Register metadata listeners before attaching the MediaSource.
                    // Calling video.load() after hls.js attaches would reset its source.
                    if (options.playlistURL && streaming) {
                        if (streaming.Hls.isSupported()) {
                            hls = new streaming.Hls({
                                maxBufferLength: 10,
                                maxMaxBufferLength: 20,
                            });
                            hls.on(streaming.Hls.Events.ERROR, (_, data) => {
                                if (data.fatal)
                                    handleFailure(new Error(data.details));
                            });
                            hls.loadSource(options.playlistURL);
                            hls.attachMedia(video);
                        } else if (
                            video.canPlayType("application/vnd.apple.mpegurl")
                        ) {
                            video.src = options.playlistURL;
                            video.load();
                        } else {
                            handleFailure(
                                new Error("HLS playback is unsupported"),
                            );
                        }
                    } else {
                        video.load();
                    }
                    return loaded.then(() => {
                        if (disposed || failed) return;
                        if (resumeAt > 0 && resumeAt < video.duration)
                            video.currentTime = resumeAt;
                        if (previous) video.volume = previous.volume;
                        if (previous ? !previous.paused : autoPlayMuted) {
                            if (!previous) video.muted = true;
                            void video
                                .play()
                                .catch(() =>
                                    log.debug(
                                        () => "Spherical autoplay was blocked",
                                    ),
                                );
                        }
                    });
                },
            )
            .catch(handleFailure);
    }

    return () => {
        if (disposed) return;
        if (viewer && !failed) playbackStates.set(video, snapshot());
        disposed = true;
        video.removeEventListener("error", onMediaError);
        video.pause();
        hls?.destroy();
        if (options.playlistURL) {
            video.removeAttribute("src");
            video.load();
        }
        viewer?.destroy();
        // The adapter removes the supplied element; PhotoSwipe reuses slide content.
        container.prepend(video);
        surface.replaceChildren();
    };
};
