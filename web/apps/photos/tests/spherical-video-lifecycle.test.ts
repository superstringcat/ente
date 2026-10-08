// @vitest-environment jsdom
import { mountSphericalVideo } from "ente-gallery/components/viewer/spherical-video";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
    created: vi.fn(),
    destroyed: vi.fn(),
    pending: undefined as Promise<void> | undefined,
    textureDisposed: vi.fn(),
    hlsCreated: vi.fn(),
    hlsDestroyed: vi.fn(),
    attach: vi.fn(),
    playlist: vi.fn(),
    supported: true,
    error: undefined as
        | ((event: string, data: { fatal: boolean; details: string }) => void)
        | undefined,
}));
vi.mock("ente-base/log", () => ({
    default: { error: vi.fn(), debug: vi.fn() },
}));
vi.mock("i18next", () => ({ t: (key: string) => key }));
vi.mock("@photo-sphere-viewer/core", () => ({
    Viewer: class {
        adapter: {
            loadTexture: (panorama: {
                source: HTMLVideoElement;
            }) => Promise<unknown>;
        };
        video: HTMLVideoElement | undefined;
        constructor(options: {
            adapter: [
                new () => {
                    loadTexture: (panorama: {
                        source: HTMLVideoElement;
                    }) => Promise<unknown>;
                },
                unknown,
            ];
        }) {
            state.created(options);
            this.adapter = new options.adapter[0]();
        }
        setPanorama(panorama: { source: HTMLVideoElement }) {
            this.video = panorama.source;
            return this.adapter.loadTexture(panorama);
        }
        getPosition() {
            return { yaw: 0.4, pitch: 0.2 };
        }
        getZoomLevel() {
            return 60;
        }
        destroy() {
            state.destroyed();
            this.video?.remove();
        }
    },
    utils: {
        getAbortError: () =>
            Object.assign(new Error("aborted"), { name: "AbortError" }),
    },
}));
vi.mock("@photo-sphere-viewer/equirectangular-video-adapter", () => ({
    EquirectangularVideoAdapter: class {
        async loadTexture() {
            await state.pending;
            return {};
        }
        disposeTexture() {
            state.textureDisposed();
        }
    },
}));
vi.mock("@photo-sphere-viewer/video-plugin", () => ({ VideoPlugin: vi.fn() }));

vi.mock("hls-video-element", () => ({
    Hls: class {
        static isSupported() {
            return state.supported;
        }
        static Events = { ERROR: "error" };
        constructor(options: unknown) {
            state.hlsCreated(options);
        }
        on(_event: string, callback: typeof state.error) {
            state.error = callback;
        }
        loadSource(url: string) {
            state.playlist(url);
        }
        attachMedia(video: HTMLVideoElement) {
            state.attach(video);
        }
        destroy() {
            state.hlsDestroyed();
        }
    },
}));

const metadata = {
    projection: "equirectangular",
    stereoMode: "mono",
    cropped: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
};
const container = () => {
    const element = document.createElement("div");
    element.innerHTML =
        '<video src="blob:original"></video><div class="ente-spherical-surface"></div>';
    return element;
};
const load = vi.fn();
const play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
beforeEach(() => {
    vi.clearAllMocks();
    state.pending = undefined;
    state.supported = true;
    state.error = undefined;
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(load);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
});
afterEach(() => vi.restoreAllMocks());

test("navigation before lazy imports complete never creates a renderer", async () => {
    const element = container();
    mountSphericalVideo(element, metadata, false)();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.created).not.toHaveBeenCalled();
});

test("closing and revisiting reused content retains the video and destroys each renderer once", async () => {
    const element = container();
    const video = element.querySelector("video");
    const dispose = mountSphericalVideo(element, metadata, false);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    dispose();
    dispose();
    expect(state.destroyed).toHaveBeenCalledOnce();
    expect(element.querySelector("video")).toBe(video);
    const disposeAgain = mountSphericalVideo(element, metadata, false);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledTimes(2));
    disposeAgain();
    expect(state.destroyed).toHaveBeenCalledTimes(2);
});

test("a metadata load completing after close is cancelled before rendering", async () => {
    let finish!: () => void;
    state.pending = new Promise((resolve) => {
        finish = resolve;
    });
    const dispose = mountSphericalVideo(container(), metadata, false);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    dispose();
    finish();
    await vi.waitFor(() =>
        expect(state.textureDisposed).toHaveBeenCalledOnce(),
    );
    expect(state.destroyed).toHaveBeenCalledOnce();
});

test("unsupported projections show an explanation without a flat fallback or renderer", () => {
    const element = container();
    const dispose = mountSphericalVideo(
        element,
        { ...metadata, stereoMode: "top-bottom" },
        false,
    );
    expect(element.textContent).toContain("spherical_video_unsupported");
    expect(state.created).not.toHaveBeenCalled();
    dispose();
});

test("muted autoplay follows the viewer preference", async () => {
    const element = container();
    const dispose = mountSphericalVideo(element, metadata, true);
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(element.querySelector("video")?.muted).toBe(true);
    dispose();
});

test("reloading metadata restores the previous playback position", async () => {
    const element = container();
    const video = element.querySelector("video")!;
    Object.defineProperty(video, "duration", { value: 10 });
    video.currentTime = 3;
    load.mockImplementationOnce(() => {
        video.currentTime = 0;
    });
    const dispose = mountSphericalVideo(element, metadata, false);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(video.currentTime).toBe(3));
    dispose();
});

test("HLS attaches to the panorama video without resetting its MediaSource", async () => {
    const element = container();
    const video = element.querySelector("video")!;
    video.removeAttribute("src");
    const dispose = mountSphericalVideo(element, metadata, false, {
        playlistURL: "blob:hls",
    });
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledWith(video));
    expect(state.playlist).toHaveBeenCalledWith("blob:hls");
    expect(load).not.toHaveBeenCalled();
    dispose();
    dispose();
    expect(state.hlsDestroyed).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
});

test("native HLS fallback uses the playlist and releases it on close", async () => {
    state.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
        "probably",
    );
    const element = container();
    const dispose = mountSphericalVideo(element, metadata, false, {
        playlistURL: "blob:hls",
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(element.querySelector("video")?.getAttribute("src")).toBe(
        "blob:hls",
    );
    expect(state.hlsCreated).not.toHaveBeenCalled();
    dispose();
    expect(element.querySelector("video")?.hasAttribute("src")).toBe(false);
});

test("a fatal HLS failure releases the loader and offers original spherical playback", async () => {
    const onQualityChange = vi.fn();
    const element = container();
    const dispose = mountSphericalVideo(element, metadata, false, {
        playlistURL: "blob:hls",
        onQualityChange,
    });
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledOnce());
    state.error?.("error", { fatal: true, details: "fragment failed" });
    expect(state.hlsDestroyed).toHaveBeenCalledOnce();
    expect(element.textContent).toContain("spherical_video_playback_error");
    element.querySelector("button")?.click();
    expect(onQualityChange).toHaveBeenCalledOnce();
    dispose();
    expect(state.destroyed).toHaveBeenCalledOnce();
});

test("quality changes restore playback time, mute, view and play state", async () => {
    const element = container();
    const video = element.querySelector("video")!;
    Object.defineProperty(video, "duration", { value: 20 });
    const dispose = mountSphericalVideo(element, metadata, false, {
        playbackState: {
            currentTime: 7,
            muted: true,
            volume: 0.3,
            paused: false,
            yaw: 1,
            pitch: 0.3,
            zoom: 70,
        },
    });
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(video.currentTime).toBe(7);
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.3);
    expect(state.created).toHaveBeenCalledWith(
        expect.objectContaining({
            defaultYaw: 1,
            defaultPitch: 0.3,
            defaultZoomLvl: 70,
        }),
    );
    dispose();
});
