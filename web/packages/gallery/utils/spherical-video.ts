import log from "ente-base/log";
import type { SphericalVideoMetadata } from "ente-media/file-metadata";

const sphericalUUID = "ffcc8263f8554a938814587a02521fdd";
const sphericalNamespace = "http://ns.google.com/videos/1.0/spherical/";
const maxMetadataBytes = 16 * 1024 * 1024;

/** Inspect container metadata without reading or decoding the media payload. */
export const detectSphericalVideo = async (
    blob: Blob,
): Promise<SphericalVideoMetadata | null> => {
    const { createFile } = await import("mp4box");
    const mp4 = createFile(false);
    let offset = 0;
    // A bounded scan also handles moov placed after a multi-GB mdat.
    for (let count = 0; offset + 8 <= blob.size && count < 1024; count++) {
        const header = await blob.slice(offset, offset + 16).arrayBuffer();
        const view = new DataView(header);
        const type = new TextDecoder().decode(new Uint8Array(header, 4, 4));
        if (offset == 0 && type != "ftyp") return null;
        let size = view.getUint32(0);
        let headerSize = 8;
        if (size == 1) {
            if (header.byteLength < 16) throw Error("Truncated MP4 box");
            size = Number(view.getBigUint64(8));
            headerSize = 16;
        } else if (size == 0) {
            size = blob.size - offset;
        }
        if (
            !Number.isSafeInteger(size) ||
            size < headerSize ||
            offset + size > blob.size
        )
            throw Error("Invalid MP4 box size");
        if (type == "moov") {
            if (size > maxMetadataBytes)
                throw Error("MP4 metadata is too large");
            const buffer = await blob
                .slice(offset, offset + size)
                .arrayBuffer();
            // Parse the isolated moov; no media samples are requested.
            mp4.appendBuffer(Object.assign(buffer, { fileStart: 0 }));
            break;
        }
        offset += size;
    }

    // MP4Box's declaration is non-nullable even before a moov has been parsed.
    const moov = (mp4 as { moov?: typeof mp4.moov }).moov;
    if (!moov) throw Error("MP4 movie metadata is missing");
    for (const track of moov.traks) {
        if (track.mdia.hdlr.handler != "vide") continue;
        const entry = track.mdia.minf.stbl.stsd.entries[0];
        const spherical = entry?.boxes?.find((box) => box.type == "sv3d");
        if (spherical?.data) {
            const stereo = entry?.boxes?.find(
                (box) => box.type == "st3d",
            )?.data;
            const result = readV2(
                new Uint8Array(spherical.data),
                stereo ? new Uint8Array(stereo) : undefined,
            );
            if (result) return result;
        }
        for (const box of track.boxes ?? []) {
            if (box.uuid == sphericalUUID) {
                const result = readV1(
                    new TextDecoder().decode(new Uint8Array(box.data)),
                    entry as { width?: number; height?: number } | undefined,
                );
                if (result) return result;
            }
        }
    }
    return null;
};

/** Detection failures must never prevent uploading or viewing an ordinary video. */
export const tryDetectSphericalVideo = async (blob: Blob) => {
    try {
        return await detectSphericalVideo(blob);
    } catch (e) {
        log.warn("Could not inspect spherical video metadata", e);
        return undefined;
    }
};

export const isSupportedSphericalVideo = (metadata: SphericalVideoMetadata) =>
    metadata.projection == "equirectangular" &&
    metadata.stereoMode == "mono" &&
    !metadata.cropped;

const baseMetadata = (): SphericalVideoMetadata => ({
    projection: "unknown",
    stereoMode: "mono",
    cropped: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
});

const readV1 = (
    xml: string,
    dimensions?: { width?: number; height?: number },
): SphericalVideoMetadata | undefined => {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.querySelector("parsererror")) return undefined;
    const text = (name: string) =>
        document
            .getElementsByTagNameNS(sphericalNamespace, name)[0]
            ?.textContent.trim();
    if (text("Spherical") != "true" || text("Stitched") != "true")
        return undefined;
    const result = baseMetadata();
    result.projection = text("ProjectionType") ?? "unknown";
    result.stereoMode = text("StereoMode") ?? "mono";
    // V1 initial-view angles describe the camera, not projection correction.
    const fullWidth = Number(text("FullPanoWidthPixels") ?? dimensions?.width);
    const fullHeight = Number(
        text("FullPanoHeightPixels") ?? dimensions?.height,
    );
    const croppedWidth = Number(
        text("CroppedAreaImageWidthPixels") ?? dimensions?.width,
    );
    const croppedHeight = Number(
        text("CroppedAreaImageHeightPixels") ?? dimensions?.height,
    );
    result.cropped = !!(
        (Number.isFinite(fullWidth) &&
            Number.isFinite(croppedWidth) &&
            fullWidth != croppedWidth) ||
        (Number.isFinite(fullHeight) &&
            Number.isFinite(croppedHeight) &&
            fullHeight != croppedHeight) ||
        Number(text("CroppedAreaLeftPixels") ?? 0) ||
        Number(text("CroppedAreaTopPixels") ?? 0)
    );
    return result;
};

const boxes = (data: Uint8Array) => {
    const result = new Map<string, Uint8Array>();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < data.length; ) {
        if (offset + 8 > data.length) return undefined;
        const size = view.getUint32(offset);
        if (size < 8 || offset + size > data.length) return undefined;
        const type = new TextDecoder().decode(
            data.subarray(offset + 4, offset + 8),
        );
        result.set(type, data.subarray(offset + 8, offset + size));
        offset += size;
    }
    return result;
};

const readV2 = (
    data: Uint8Array,
    stereo?: Uint8Array,
): SphericalVideoMetadata | undefined => {
    const projection = boxes(data)?.get("proj");
    if (!projection) return undefined;
    const children = boxes(projection);
    if (!children) return undefined;
    const result = baseMetadata();
    result.stereoMode = stereo
        ? (["mono", "top-bottom", "left-right"][stereo[4] ?? -1] ?? "unknown")
        : "mono";
    const pose = children.get("prhd");
    if (pose && pose.length >= 16) {
        const view = new DataView(
            pose.buffer,
            pose.byteOffset,
            pose.byteLength,
        );
        result.yaw = view.getInt32(4) / 65536;
        result.pitch = view.getInt32(8) / 65536;
        result.roll = view.getInt32(12) / 65536;
    }
    const equi = children.get("equi");
    if (equi && equi.length >= 20) {
        result.projection = "equirectangular";
        result.cropped = equi.subarray(4, 20).some((byte) => byte != 0);
    } else if (children.has("cbmp")) result.projection = "cubemap";
    else if (children.has("mshp")) result.projection = "mesh";
    return result;
};
