import { createFileViewerDataSource } from "ente-gallery/components/viewer/data-source-core";
import type { RenderableSourceURLs } from "ente-gallery/services/download-core";
import type { EnteFile } from "ente-media/file";
import { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import { FileType } from "ente-media/file-type";
import { afterAll, expect, test, vi } from "vitest";

vi.mock("ente-base/log", () => ({ default: { error: vi.fn() } }));
vi.stubGlobal(
    "Image",
    class {
        onload: (() => void) | undefined;
        naturalWidth = 320;
        naturalHeight = 160;
        set src(_url: string) {
            queueMicrotask(() => this.onload?.());
        }
    },
);
afterAll(() => vi.unstubAllGlobals());

const sphericalVideo = {
    projection: "equirectangular",
    stereoMode: "mono",
    cropped: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
};
const file = (data: FilePublicMagicMetadataData = {}) =>
    ({
        id: 42,
        metadata: { fileType: FileType.video },
        pubMagicMetadata: { data, version: 1 },
    }) as EnteFile;
const route = async (
    file: EnteFile,
    dimensions: { width: number; height: number },
    detected?: typeof sphericalVideo | null,
    videoQuality: "auto" | "original" = "auto",
) => {
    const renderableSourceURLs = vi
        .fn<() => Promise<RenderableSourceURLs>>()
        .mockResolvedValue({
            type: "video",
            videoURL: "blob:original",
            sphericalVideo: detected,
        });
    const source = createFileViewerDataSource({
        downloadManager: {
            publicAlbumsCredentials: undefined,
            renderableThumbnailURL: () => Promise.resolve("blob:thumb"),
            renderableSourceURLs,
        },
        hlsPlaylistDataForFile: () =>
            Promise.resolve({ playlistURL: "blob:hls", ...dimensions }),
        extractRawExif: vi.fn(),
        parseExif: vi.fn(),
    });
    source.itemDataForFile(file, { videoQuality }, vi.fn());
    await vi.waitFor(() =>
        expect(
            source.itemDataForFile(file, { videoQuality }, vi.fn())
                .isContentLoading,
        ).toBeUndefined(),
    );
    return {
        item: source.itemDataForFile(file, { videoQuality }, vi.fn()),
        renderableSourceURLs,
        source,
    };
};

test("known panoramas stream without downloading the original", async () => {
    const { item, renderableSourceURLs } = await route(
        file({ sphericalVideo, sphericalVideoChecked: true }),
        { width: 1440, height: 720 },
        sphericalVideo,
    );
    expect(renderableSourceURLs).not.toHaveBeenCalled();
    expect(item).toMatchObject({
        videoPlaylistURL: "blob:hls",
        sphericalVideo,
    });
    expect(item.videoURL).toBeUndefined();
});

test("uninspected 2:1 previews trigger inspection of the original", async () => {
    const { item, renderableSourceURLs } = await route(
        file(),
        { width: 1440, height: 720 },
        sphericalVideo,
    );
    expect(item.sphericalVideo).toEqual(sphericalVideo);
    expect(item.videoPlaylistURL).toBe("blob:hls");
    expect(renderableSourceURLs).toHaveBeenCalledOnce();
});

test("ordinary 2:1 videos remain flat after inspection", async () => {
    const { item } = await route(file(), { width: 1440, height: 720 }, null);
    expect(item.sphericalVideo).toBeUndefined();
    expect(item.videoPlaylistURL).toBe("blob:hls");
});

test("checked ordinary videos and non-2:1 previews keep fast HLS playback", async () => {
    const checked = await route(file({ sphericalVideoChecked: true }), {
        width: 1440,
        height: 720,
    });
    const regular = await route(file(), { width: 1280, height: 720 });
    expect(checked.renderableSourceURLs).not.toHaveBeenCalled();
    expect(regular.renderableSourceURLs).not.toHaveBeenCalled();
    expect(checked.item.videoPlaylistURL).toBe("blob:hls");
});

test("encrypted public metadata schema retains projection data and unrelated fields", () => {
    expect(
        FilePublicMagicMetadataData.parse({
            sphericalVideoChecked: true,
            sphericalVideo,
            caption: "Trip",
            futureField: "keep",
        }),
    ).toMatchObject({
        sphericalVideoChecked: true,
        sphericalVideo,
        caption: "Trip",
        futureField: "keep",
    });
});

test("original-quality selection keeps spherical metadata and the stream switch", async () => {
    const { item, renderableSourceURLs } = await route(
        file({ sphericalVideo, sphericalVideoChecked: true }),
        { width: 1440, height: 720 },
        sphericalVideo,
        "original",
    );
    expect(renderableSourceURLs).toHaveBeenCalledOnce();
    expect(item).toMatchObject({
        videoURL: "blob:original",
        videoPlaylistURL: "blob:hls",
        sphericalVideo,
    });
});

test("a preview with an incompatible projection aspect ratio falls back to the spherical original", async () => {
    const { item, renderableSourceURLs } = await route(
        file({ sphericalVideo, sphericalVideoChecked: true }),
        { width: 1280, height: 720 },
        sphericalVideo,
    );
    expect(renderableSourceURLs).toHaveBeenCalledOnce();
    expect(item).toMatchObject({ videoURL: "blob:original", sphericalVideo });
    expect(item.videoPlaylistURL).toBeUndefined();
});

test("legacy detection is reused when a quality change refreshes the slide", async () => {
    const legacy = file();
    const { source, renderableSourceURLs } = await route(
        legacy,
        { width: 1440, height: 720 },
        sphericalVideo,
    );
    source.forgetItemDataForFileID(legacy.id);
    source.itemDataForFile(legacy, { videoQuality: "auto" }, vi.fn());
    await vi.waitFor(() =>
        expect(
            source.itemDataForFile(legacy, { videoQuality: "auto" }, vi.fn())
                .videoPlaylistURL,
        ).toBe("blob:hls"),
    );
    expect(renderableSourceURLs).toHaveBeenCalledOnce();
    expect(
        source.itemDataForFile(legacy, undefined, vi.fn()).sphericalVideo,
    ).toEqual(sphericalVideo);
});
