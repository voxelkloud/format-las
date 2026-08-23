// The CRS a LAS file declares, from either of the two ways it can.
//
// LAS carries its projection in `LASF_Projection` VLRs, and which one depends
// on the version. 1.4 requires OGC WKT in record 2112. 1.2 and earlier use the
// GeoTIFF key directory — records 34735, 34736 and 34737 — which is a flat
// table of numeric keys borrowed wholesale from the TIFF spec.
//
// Both appear in real files in this repo, so both are here. A 1.4 file may also
// carry the GeoTIFF keys for compatibility, and then the WKT wins: it is the
// one the version requires and the one that can express a compound system.

import { crsFromEpsg, crsFromWkt } from "@voxelkloud/core";
import type { CrsDeclaration } from "@voxelkloud/core";

/** User id of every projection VLR. */
export const PROJECTION_USER_ID = "LASF_Projection";
/** OGC coordinate system WKT. LAS 1.4's required form. */
export const WKT_RECORD_ID = 2112;
/** GeoTIFF key directory: the key table itself. */
export const GEOKEY_DIRECTORY_RECORD_ID = 34735;
/** GeoTIFF double parameters, referenced by key. */
export const GEOKEY_DOUBLE_RECORD_ID = 34736;
/** GeoTIFF ASCII parameters, referenced by key. */
export const GEOKEY_ASCII_RECORD_ID = 34737;

/** GeoTIFF key ids this reader acts on. */
const GT_MODEL_TYPE = 1024;
const GEOGRAPHIC_TYPE = 2048;
const PROJECTED_CS_TYPE = 3072;
const PROJECTED_CITATION = 3073;
const VERTICAL_CS_TYPE = 4096;

/** `GTModelTypeGeoKey` values. */
const MODEL_PROJECTED = 1;
const MODEL_GEOGRAPHIC = 2;

/**
 * "User-defined" and "undefined" in the GeoTIFF key space.
 *
 * A file that sets `ProjectedCSType` to 32767 is saying "the code space cannot
 * name this one" — reading it as a code would resolve to nothing, or worse, to
 * something.
 */
const USER_DEFINED = 32767;
const UNDEFINED = 0;

/** The VLR payloads this reader needs, by record id. */
export interface LasProjectionVlrs {
  readonly wkt?: Uint8Array | string | undefined;
  readonly geoKeyDirectory?: Uint8Array | undefined;
  readonly geoAscii?: Uint8Array | undefined;
}

function text(value: Uint8Array | string): string {
  const decoded =
    typeof value === "string" ? value : new TextDecoder().decode(value);
  // LAS pads its strings with NULs, and a trailing one inside a WKT makes every
  // downstream parse of it fail on a character that is not there.
  return decoded.replace(/\0+$/u, "").trim();
}

/**
 * Read the CRS out of a LAS file's projection VLRs.
 *
 * @returns `undefined` when the file declares nothing this can resolve. That is
 *   common and not an error — the majority of photogrammetry output has no CRS
 *   at all.
 */
export function lasCrs(vlrs: LasProjectionVlrs): CrsDeclaration | undefined {
  // WKT first. A 1.4 file may carry the GeoTIFF keys too, for readers that
  // predate the requirement, and the WKT is both authoritative and the only one
  // of the two that can express a compound system.
  if (vlrs.wkt !== undefined) {
    const wkt = text(vlrs.wkt);
    if (wkt !== "") return crsFromWkt(wkt);
  }
  if (vlrs.geoKeyDirectory !== undefined) {
    return geoKeyCrs(vlrs.geoKeyDirectory, vlrs.geoAscii);
  }
  return undefined;
}

/**
 * Read the GeoTIFF key directory.
 *
 * The layout is four `uint16` of header — version, revision, minor revision,
 * key count — then one four-`uint16` entry per key: id, the record the value
 * lives in, how many values, and either the value itself or an offset into that
 * record. `location === 0` means the value IS the fourth field, which is the
 * case for every key that matters here.
 */
function geoKeyCrs(
  directory: Uint8Array,
  ascii: Uint8Array | undefined,
): CrsDeclaration | undefined {
  if (directory.byteLength < 8) return undefined;
  const view = new DataView(
    directory.buffer,
    directory.byteOffset,
    directory.byteLength,
  );
  const count = view.getUint16(6, true);

  const keys = new Map<number, { location: number; count: number; value: number }>();
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 8;
    if (at + 8 > directory.byteLength) break;
    keys.set(view.getUint16(at, true), {
      location: view.getUint16(at + 2, true),
      count: view.getUint16(at + 4, true),
      value: view.getUint16(at + 6, true),
    });
  }

  const codeOf = (id: number): number | undefined => {
    const key = keys.get(id);
    if (key === undefined || key.location !== 0) return undefined;
    if (key.value === USER_DEFINED || key.value === UNDEFINED) return undefined;
    return key.value;
  };

  const model = keys.get(GT_MODEL_TYPE)?.value;
  // Prefer the projected code, and fall back to the geographic one: a file that
  // declares itself geographic has no projected key at all, and one that
  // declares itself projected may still carry the geographic code of its datum
  // — which is NOT the system the coordinates are in.
  const projected = codeOf(PROJECTED_CS_TYPE);
  const geographic = codeOf(GEOGRAPHIC_TYPE);
  const epsg =
    model === MODEL_GEOGRAPHIC
      ? geographic
      : (projected ?? (model === MODEL_PROJECTED ? undefined : geographic));
  if (epsg === undefined) return undefined;

  return crsFromEpsg(epsg, {
    ...(codeOf(VERTICAL_CS_TYPE) !== undefined
      ? { verticalEpsg: codeOf(VERTICAL_CS_TYPE)! }
      : {}),
    ...(asciiValue(keys.get(PROJECTED_CITATION), ascii) !== undefined
      ? { name: asciiValue(keys.get(PROJECTED_CITATION), ascii)! }
      : {}),
  });
}

/**
 * An ASCII-valued key, out of the 34737 record.
 *
 * GeoTIFF concatenates every ASCII value into one string separated by `|`, and
 * a key's `value` is the offset into it while `count` is the length including
 * that separator.
 */
function asciiValue(
  key: { location: number; count: number; value: number } | undefined,
  ascii: Uint8Array | undefined,
): string | undefined {
  if (key === undefined || ascii === undefined) return undefined;
  if (key.location !== GEOKEY_ASCII_RECORD_ID) return undefined;
  const start = key.value;
  const end = Math.min(start + key.count, ascii.byteLength);
  if (start >= end) return undefined;
  return new TextDecoder()
    .decode(ascii.subarray(start, end))
    .replace(/[|\0]+$/u, "")
    .trim();
}
