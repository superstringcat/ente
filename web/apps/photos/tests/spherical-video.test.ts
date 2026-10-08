// @vitest-environment jsdom
import {
    detectSphericalVideo,
    isSupportedSphericalVideo,
    tryDetectSphericalVideo,
} from "ente-gallery/utils/spherical-video";
import { Box, createFile } from "mp4box";
import { Blob as NodeBlob } from "node:buffer";
import { readFile } from "node:fs/promises";
import { afterAll, expect, test, vi } from "vitest";

vi.mock("ente-base/log", () => ({ default: { warn: vi.fn() } }));
vi.stubGlobal("Blob", NodeBlob);
afterAll(() => vi.unstubAllGlobals());

const rawBox = (type: string, data: Uint8Array) => {
    const box = new Box();
    box.type = type;
    box.data = data;
    return box;
};
const encodeBox = (type: string, data: Uint8Array) => {
    const result = new Uint8Array(8 + data.length);
    new DataView(result.buffer).setUint32(0, result.length);
    result.set(new TextEncoder().encode(type), 4);
    result.set(data, 8);
    return result;
};
const join = (...arrays: Uint8Array[]) => {
    const result = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let offset = 0;
    for (const array of arrays) {
        result.set(array, offset);
        offset += array.length;
    }
    return result;
};
const movie = (v1?: string, v2?: Uint8Array, stereo = 0) => {
    const file = createFile();
    file.addTrack({ type: "avc1", width: 3840, height: 1920 });
    const track = file.moov.traks[0]!;
    if (v1) {
        const uuid = rawBox("uuid", new TextEncoder().encode(v1));
        uuid.uuid = "ffcc8263f8554a938814587a02521fdd";
        track.addBox(uuid);
    }
    if (v2) {
        const entry = track.mdia.minf.stbl.stsd.entries[0]!;
        entry.addBox(rawBox("sv3d", v2));
        entry.addBox(rawBox("st3d", new Uint8Array([0, 0, 0, 0, stereo])));
    }
    return new Blob([file.getBuffer().buffer]);
};
const xml = (extra = "", projection = "equirectangular") =>
    `<rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="http://ns.google.com/videos/1.0/spherical/">
    <p:Spherical>true</p:Spherical><p:Stitched>true</p:Stitched>
    <p:ProjectionType>${projection}</p:ProjectionType>${extra}</rdf:SphericalVideo>`;
const v2 = (cropped = false) => {
    const equi = new Uint8Array(20);
    if (cropped) equi[7] = 1;
    const pose = new Uint8Array(16);
    new DataView(pose.buffer).setInt32(4, 90 * 65536);
    return encodeBox(
        "proj",
        join(encodeBox("prhd", pose), encodeBox("equi", equi)),
    );
};

test("reads namespace-independent V1 metadata without mistaking a 2:1 movie for a panorama", async () => {
    expect(await detectSphericalVideo(movie())).toBeNull();
    const metadata = await detectSphericalVideo(movie(xml()));
    expect(metadata).toEqual({
        projection: "equirectangular",
        stereoMode: "mono",
        cropped: false,
        yaw: 0,
        pitch: 0,
        roll: 0,
    });
    expect(isSupportedSphericalVideo(metadata!)).toBe(true);
});

test("V2 wins over V1 and reads fixed-point pose and stereo layout", async () => {
    const metadata = await detectSphericalVideo(movie(xml(), v2(), 2));
    expect(metadata).toMatchObject({ yaw: 90, stereoMode: "left-right" });
    expect(isSupportedSphericalVideo(metadata!)).toBe(false);
});

test("recognizes unsupported projections and partial spheres without displaying them flat", async () => {
    const cubemap = await detectSphericalVideo(movie(xml("", "cubemap")));
    expect(isSupportedSphericalVideo(cubemap!)).toBe(false);
    const cropped = await detectSphericalVideo(movie(undefined, v2(true)));
    expect(cropped?.cropped).toBe(true);
    expect(isSupportedSphericalVideo(cropped!)).toBe(false);
});

test("defaults omitted crop dimensions to the full frame", async () => {
    expect(
        await detectSphericalVideo(
            movie(xml("<p:FullPanoWidthPixels>3840</p:FullPanoWidthPixels>")),
        ),
    ).toMatchObject({ cropped: false });
});

test("does not accept malformed XML or an unrelated UUID", async () => {
    expect(await detectSphericalVideo(movie(xml().slice(0, -10)))).toBeNull();
});

test("skips a large mdat before a tail moov using bounded reads", async () => {
    const bytes = new Uint8Array(await movie(xml()).arrayBuffer());
    const ftypSize = new DataView(bytes.buffer).getUint32(0);
    const blob = new Blob([
        bytes.slice(0, ftypSize),
        encodeBox("mdat", new Uint8Array(2 * 1024 * 1024)),
        bytes.slice(ftypSize),
    ]);
    const slice = vi.spyOn(blob, "slice");
    expect(await detectSphericalVideo(blob)).toMatchObject({
        projection: "equirectangular",
    });
    expect(slice.mock.calls.every(([start, end]) => end! - start! < 4096)).toBe(
        true,
    );
});

test("bad box sizes fail softly so ordinary uploads remain usable", async () => {
    const bytes = encodeBox("ftyp", new Uint8Array(4));
    new DataView(bytes.buffer).setUint32(0, 1000);
    expect(await tryDetectSphericalVideo(new Blob([bytes]))).toBeUndefined();
    expect(
        await detectSphericalVideo(
            new Blob([new TextEncoder().encode("not an mp4 file")]),
        ),
    ).toBeNull();
});

test.skipIf(!process.env.ENTE_SPHERICAL_SAMPLE)(
    "recognizes a local sample without adding user footage to the repository",
    async () => {
        const bytes = await readFile(process.env.ENTE_SPHERICAL_SAMPLE!);
        expect(await detectSphericalVideo(new Blob([bytes]))).toMatchObject({
            projection: "equirectangular",
            stereoMode: "mono",
            cropped: false,
        });
    },
);
