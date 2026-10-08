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
    source.itemDataForFile(file, undefined, vi.fn());
    await vi.waitFor(() =>
        expect(
            source.itemDataForFile(file, undefined, vi.fn()).isContentLoading,
        ).toBeUndefined(),
    );
    return {
        item: source.itemDataForFile(file, undefined, vi.fn()),
        renderableSourceURLs,
    };
};

test("known panoramas use the original even if a flat HLS preview exists", async () => {
    const { item, renderableSourceURLs } = await route(
        file({ sphericalVideo, sphericalVideoChecked: true }),
        { width: 1280, height: 720 },
        sphericalVideo,
    );
    expect(renderableSourceURLs).toHaveBeenCalledOnce();
    expect(item).toMatchObject({ videoURL: "blob:original", sphericalVideo });
    expect(item.videoPlaylistURL).toBeUndefined();
});

test("uninspected 2:1 previews trigger inspection of the original", async () => {
    const { item, renderableSourceURLs } = await route(
        file(),
        { width: 1440, height: 720 },
        sphericalVideo,
    );
    expect(item.sphericalVideo).toEqual(sphericalVideo);
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
