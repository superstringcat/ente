import type { Viewer } from "@photo-sphere-viewer/core";
import type { EquirectangularVideoPanorama } from "@photo-sphere-viewer/equirectangular-video-adapter";
import log from "ente-base/log";
import { isSupportedSphericalVideo } from "ente-gallery/utils/spherical-video";
import type { SphericalVideoMetadata } from "ente-media/file-metadata";
import { t } from "i18next";

/** A synchronous disposer also cancels initialization when the user navigates away. */
export const mountSphericalVideo = (
    container: HTMLElement,
    metadata: SphericalVideoMetadata,
    autoPlayMuted: boolean,
) => {
    let disposed = false;
    let viewer: Viewer | undefined;
    const video = container.querySelector("video")!;
    const resumeAt = video.currentTime;
    const surface = container.querySelector<HTMLElement>(
        ".ente-spherical-surface",
    )!;
    const showError = (message: string) => {
        video.pause();
        surface.textContent = message;
        surface.classList.add("ente-spherical-error");
    };

    if (!isSupportedSphericalVideo(metadata)) {
        showError(t("spherical_video_unsupported"));
    } else {
        void Promise.all([
            import("@photo-sphere-viewer/core"),
            import("@photo-sphere-viewer/equirectangular-video-adapter"),
            import("@photo-sphere-viewer/video-plugin"),
        ])
            .then(
                ([
                    { Viewer, utils },
                    { EquirectangularVideoAdapter },
                    { VideoPlugin },
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
                            if (disposed) {
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
                        navbar: [
                            "videoPlay",
                            "videoVolume",
                            "videoTime",
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
                    // Register the adapter's listeners before loading, including revisits.
                    video.load();
                    return loaded.then(() => {
                        if (disposed) return;
                        if (resumeAt > 0 && resumeAt < video.duration)
                            video.currentTime = resumeAt;
                        if (autoPlayMuted) {
                            video.muted = true;
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
            .catch((e: unknown) => {
                if (disposed) return;
                log.error("Failed to initialize spherical video", e);
                viewer?.destroy();
                viewer = undefined;
                container.prepend(video);
                showError(t("spherical_video_playback_error"));
            });
    }

    return () => {
        if (disposed) return;
        disposed = true;
        video.pause();
        viewer?.destroy();
        // The adapter removes the supplied element; PhotoSwipe reuses slide content.
        container.prepend(video);
        surface.replaceChildren();
    };
};
