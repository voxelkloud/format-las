// The CRS a LAS file declares, read out of two real ones.
//
// Both spellings appear in this repo's source tiles and neither can be checked
// against a synthetic fixture with any confidence: the GeoTIFF key directory is
// a flat table of magic numbers, and getting a key id or an offset wrong
// produces a plausible-looking code for the wrong place on the planet. The
// files are gitignored, so the two that need them skip when they are absent.

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lasCrs } from "./crs.js";

const AZ = fileURLToPath(
  new URL("../../../demo/data/_src/20m/36112C3116.laz", import.meta.url),
);
const NL = fileURLToPath(
  new URL("../../../demo/data/_src/rotterdam/37HN1_02.LAZ", import.meta.url),
);
const HAS_AZ = existsSync(AZ);
const HAS_NL = existsSync(NL);
if (!HAS_AZ || !HAS_NL) {
  console.warn(
    "@voxelkloud/format-las: the source LiDAR tiles under demo/data/_src are " +
      "missing, so the CRS tests against real declarations are skipped. " +
      "Fetch them with demo/data/fetch-large.sh and fetch-stress.sh.",
  );
}

/**
 * Every VLR of a LAS file, by user id and record id.
 *
 * Reads only the head: these are multi-gigabyte tiles and the VLR directory
 * ends before the point data begins, so pulling the whole file in costs four
 * seconds to reach bytes in the first few kilobytes.
 */
function vlrsOf(path: string): Map<string, Uint8Array> {
  const handle = openSync(path, "r");
  const buffer = new Uint8Array(64 * 1024);
  try {
    readSync(handle, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(handle);
  }
  const bytes = buffer;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(94, true);
  const count = view.getUint32(100, true);
  const out = new Map<string, Uint8Array>();
  let at = headerSize;
  for (let i = 0; i < count; i++) {
    const userId = new TextDecoder()
      .decode(bytes.subarray(at + 2, at + 18))
      .replace(/\0+$/u, "");
    const recordId = view.getUint16(at + 18, true);
    const length = view.getUint16(at + 20, true);
    out.set(`${userId}:${recordId}`, bytes.subarray(at + 54, at + 54 + length));
    at += 54 + length;
  }
  return out;
}

describe.skipIf(!HAS_AZ)("a LAS 1.2 file with GeoTIFF keys", () => {
  it("reads NAD83 / UTM zone 12N out of the key directory", () => {
    const vlrs = vlrsOf(AZ);
    const crs = lasCrs({
      geoKeyDirectory: vlrs.get("LASF_Projection:34735"),
      geoAscii: vlrs.get("LASF_Projection:34737"),
    })!;

    expect(crs).toBeDefined();
    expect(crs.format).toBe("epsg");
    // ProjectedCSTypeGeoKey. Getting the key id or the entry stride wrong
    // yields another key's value, which is also a plausible number.
    expect(crs.epsg).toBe(26912);
    // VerticalCSTypeGeoKey — NAVD88. Kept separate because nothing here
    // transforms heights between vertical datums.
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.raw).toBe("EPSG:26912");
  });

  it("does not mistake the datum's geographic code for the projected one", () => {
    // The file carries GeogCitation and GeogAngularUnits too. A reader that
    // fell back to GeographicType would report NAD83 the datum rather than
    // UTM zone 12N the grid, and every coordinate would be off by 500 km.
    const vlrs = vlrsOf(AZ);
    const crs = lasCrs({ geoKeyDirectory: vlrs.get("LASF_Projection:34735") })!;
    expect(crs.epsg).toBe(26912);
    expect(crs.epsg).not.toBe(4269);
  });
});

describe.skipIf(!HAS_NL)("a LAS 1.4 file with OGC WKT", () => {
  it("reads Amersfoort / RD New out of a compound WKT", () => {
    const vlrs = vlrsOf(NL);
    const crs = lasCrs({ wkt: vlrs.get("LASF_Projection:2112") })!;

    expect(crs).toBeDefined();
    expect(crs.format).toBe("wkt");
    expect(crs.name).toBe("Amersfoort / RD New + NAP height");
    // The horizontal system. The LAST authority in this string is 7415, the
    // compound as a whole, and projecting through that resolves to nothing.
    expect(crs.epsg).toBe(28992);
    expect(crs.verticalEpsg).toBe(5709);
    expect(crs.raw).toContain("COMPD_CS");
    // No trailing NUL survived: LAS pads its strings, and one left on the end
    // fails every downstream parse on a character that is not there.
    expect(crs.raw.endsWith("]")).toBe(true);
  });

  it("prefers the WKT when a file carries both spellings", () => {
    const vlrs = vlrsOf(NL);
    const crs = lasCrs({
      wkt: vlrs.get("LASF_Projection:2112"),
      // A directory that would resolve to something else entirely.
      geoKeyDirectory: new Uint8Array([
        1, 0, 1, 0, 0, 0, 1, 0, 0, 12, 0, 0, 1, 0, 1, 0,
      ]),
    })!;
    expect(crs.format).toBe("wkt");
    expect(crs.epsg).toBe(28992);
  });
});

describe("lasCrs, on what a file may not have", () => {
  it("returns undefined when nothing is declared", () => {
    expect(lasCrs({})).toBeUndefined();
    expect(lasCrs({ wkt: "" })).toBeUndefined();
    expect(lasCrs({ wkt: new Uint8Array([0, 0, 0]) })).toBeUndefined();
  });

  it("returns undefined for a user-defined projection", () => {
    // GTModelType=1 (projected), ProjectedCSType=32767 (user-defined). The file
    // is saying the code space cannot name this one; reading 32767 as a code
    // would resolve to nothing, or worse, to something.
    const directory = new Uint8Array(24);
    const view = new DataView(directory.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(6, 2, true); // two keys
    view.setUint16(8, 1024, true);
    view.setUint16(14, 1, true); // GTModelType = projected
    view.setUint16(16, 3072, true);
    view.setUint16(22, 32767, true); // user-defined
    expect(lasCrs({ geoKeyDirectory: directory })).toBeUndefined();
  });

  it("survives a truncated key directory", () => {
    const directory = new Uint8Array(8);
    new DataView(directory.buffer).setUint16(6, 40, true); // claims 40 keys
    expect(lasCrs({ geoKeyDirectory: directory })).toBeUndefined();
    expect(lasCrs({ geoKeyDirectory: new Uint8Array(3) })).toBeUndefined();
  });

  it("reads a geographic file through GeographicTypeGeoKey", () => {
    const directory = new Uint8Array(24);
    const view = new DataView(directory.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(6, 2, true);
    view.setUint16(8, 1024, true);
    view.setUint16(14, 2, true); // GTModelType = geographic
    view.setUint16(16, 2048, true);
    view.setUint16(22, 4326, true);
    expect(lasCrs({ geoKeyDirectory: directory })?.epsg).toBe(4326);
  });
});
