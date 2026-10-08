import { createDownloadManager } from "ente-gallery/services/download-core";
import { tryDetectSphericalVideo } from "ente-gallery/utils/spherical-video";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("ente-base/crypto", () => ({
    initChunkDecryption: () =>
        Promise.resolve({ pullState: {}, decryptionChunkSize: 1024 }),
    decryptStreamChunk: (data: Uint8Array) => Promise.resolve(data),
}));
vi.mock("ente-base/log", () => ({
    default: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("ente-base/blob-cache", () => ({ blobCache: vi.fn() }));
vi.mock("ente-gallery/utils/spherical-video", () => ({
    tryDetectSphericalVideo: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

const sphericalVideo = {
    projection: "equirectangular",
    stereoMode: "mono",
    cropped: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
};
const file = {
    id: 42,
    metadata: { fileType: FileType.video, title: "panorama.mp4" },
    file: { decryptionHeader: "header" },
    key: "key",
} as EnteFile;
const setup = () => {
    const playableVideoURL = vi.fn().mockResolvedValue("blob:converted");
    const manager = createDownloadManager({
        downloadFile: () => Promise.resolve(new Response("original bytes")),
        downloadThumbnail: vi.fn(),
        renderableImageBlob: vi.fn(),
        playableVideoURL,
    });
    return { manager, playableVideoURL };
};

test("detects metadata from decrypted original bytes before compatibility conversion", async () => {
    vi.mocked(tryDetectSphericalVideo).mockResolvedValueOnce(sphericalVideo);
    const { manager, playableVideoURL } = setup();
    const result = await manager.renderableSourceURLs(file);
    expect(
        await vi.mocked(tryDetectSphericalVideo).mock.calls[0]![0].text(),
    ).toBe("original bytes");
    expect(tryDetectSphericalVideo).toHaveBeenCalledBefore(playableVideoURL);
    expect(result).toEqual({
        type: "video",
        videoURL: "blob:converted",
        sphericalVideo,
    });
});

test("known positive and negative metadata avoid repeated container parsing", async () => {
    const { manager } = setup();
    expect(
        await manager.renderableSourceURLs({
            ...file,
            pubMagicMetadata: {
                data: { sphericalVideo, sphericalVideoChecked: true },
                version: 1,
                count: 2,
            },
        }),
    ).toMatchObject({ sphericalVideo });
    const regular = setup();
    await regular.manager.renderableSourceURLs({
        ...file,
        pubMagicMetadata: {
            data: { sphericalVideoChecked: true },
            version: 1,
            count: 1,
        },
    });
    expect(tryDetectSphericalVideo).not.toHaveBeenCalled();
});
