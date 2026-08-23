// The LAS point record, formats 0 through 10.
//
// Every format in this project that stores a LAS point shares this: COPC nodes
// are LAS 1.4 records, EPT's `laszip` payload is a LAS file per node, and the
// single-file tier is a `.las`/`.laz` outright. The record layout is fixed by
// the spec and identical in all three, so it is stated once here rather than
// three times with two of them subtly wrong.
//
// What this module is NOT: a decoder. It says where each dimension sits and how
// wide it is. Turning that into typed arrays is `decode.ts`, and finding the
// bytes at all is the driver's.

import { VoxelkloudError } from "@voxelkloud/core";
import type { PointAttributeTypeName } from "@voxelkloud/core";

/** How one dimension is read out of a record. */
export type LasAccess =
  /** A whole little-endian value at a byte offset. */
  | { readonly kind: "scalar"; readonly at: number }
  /**
   * An unsigned bit run inside one byte.
   *
   * LAS packs return numbers, the classification flags and the scanner channel
   * into shared bytes, and every writer in this space — PotreeConverter
   * included — presents them as separate dimensions. Doing the same is what
   * lets one colour mode key off `"classification"` whichever driver produced
   * the cloud.
   */
  | {
      readonly kind: "bits";
      readonly at: number;
      readonly shift: number;
      readonly width: number;
    };

/** One dimension of a LAS point record. */
export interface LasDimension {
  /**
   * VERBATIM the name PotreeConverter emits for the same field, so an
   * attribute lookup does not depend on which driver loaded the cloud:
   * `"position"`, `"intensity"`, `"return number"`, `"gps-time"`, `"rgb"`.
   */
  readonly name: string;
  readonly type: PointAttributeTypeName;
  readonly numElements: number;
  readonly access: LasAccess;
  /** Declared domain, from the LAS spec. Position's comes from the header. */
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly description: string;
}

/** Bytes of one record before any extra bytes, per point format. */
const BASE_SIZE: Readonly<Record<number, number>> = {
  0: 20,
  1: 28,
  2: 26,
  3: 34,
  4: 57,
  5: 63,
  6: 30,
  7: 36,
  8: 38,
  9: 59,
  10: 67,
};

/** Point data record length, before extra bytes. */
export function lasBaseSize(format: number): number {
  const size = BASE_SIZE[format];
  if (size === undefined) {
    throw new VoxelkloudError(
      "unsupported-point-data",
      `LAS point data record format ${format} is not one of 0-10.`,
    );
  }
  return size;
}

const U8 = { min: [0], max: [255] };
const U16 = { min: [0], max: [65535] };

function scalar(
  name: string,
  type: PointAttributeTypeName,
  at: number,
  range: { min: readonly number[]; max: readonly number[] },
  description = "",
  numElements = 1,
): LasDimension {
  return {
    name,
    type,
    numElements,
    access: { kind: "scalar", at },
    min: range.min,
    max: range.max,
    description,
  };
}

function bits(
  name: string,
  at: number,
  shift: number,
  width: number,
  description = "",
): LasDimension {
  return {
    name,
    type: "uint8",
    numElements: 1,
    access: { kind: "bits", at, shift, width },
    min: [0],
    max: [(1 << width) - 1],
    description,
  };
}

/**
 * The dimensions of one point format, in record order.
 *
 * `min`/`max` on position are placeholders: the header's bounding box is the
 * real domain and the caller substitutes it, because only the header knows it.
 *
 * Wave packet fields (formats 4, 5, 9, 10) are deliberately absent. They are
 * five fields describing a waveform this project has no way to render, they
 * appear in a vanishing fraction of files, and their bytes are still counted in
 * the stride — so nothing is misaligned by leaving them out, only unavailable.
 */
export function lasDimensions(format: number): readonly LasDimension[] {
  const legacy = format <= 5;
  const out: LasDimension[] = [
    {
      name: "position",
      type: "int32",
      numElements: 3,
      access: { kind: "scalar", at: 0 },
      min: [0, 0, 0],
      max: [0, 0, 0],
      description: "",
    },
    scalar("intensity", "uint16", 12, U16),
  ];

  if (legacy) {
    out.push(
      bits("return number", 14, 0, 3),
      bits("number of returns", 14, 3, 3),
      bits("scan direction flag", 14, 6, 1),
      bits("edge of flight line", 14, 7, 1),
      // The whole byte, flags included. PotreeConverter does the same for
      // legacy formats, and the synthetic/keypoint/withheld bits above class 31
      // are almost never set in files that reach a viewer.
      scalar("classification", "uint8", 15, U8),
      scalar("scan angle rank", "int8", 16, { min: [-90], max: [90] }, "degrees"),
      scalar("user data", "uint8", 17, U8),
      scalar("point source id", "uint16", 18, U16),
    );
  } else {
    out.push(
      bits("return number", 14, 0, 4),
      bits("number of returns", 14, 4, 4),
      bits("classification flags", 15, 0, 4),
      bits("scanner channel", 15, 4, 2),
      bits("scan direction flag", 15, 6, 1),
      bits("edge of flight line", 15, 7, 1),
      scalar("classification", "uint8", 16, U8),
      scalar("user data", "uint8", 17, U8),
      scalar(
        "scan angle",
        "int16",
        18,
        { min: [-30000], max: [30000] },
        "0.006 degree increments",
      ),
      scalar("point source id", "uint16", 20, U16),
    );
  }

  const gpsAt = legacy ? 20 : 22;
  const hasGps = legacy ? format === 1 || format === 3 || format >= 4 : true;
  if (hasGps) {
    out.push(scalar("gps-time", "double", gpsAt, { min: [0], max: [0] }));
  }

  // Colour sits after GPS time where there is one. Format 2 is the only one
  // with colour and no GPS time.
  const rgbAt = legacy ? (format === 2 ? 20 : 28) : 30;
  // NOT `format >= 7`: point format 9 is format 6 plus wave packets and has no
  // colour at all, so a `>= 7` test lands "rgb" on top of the wave packet
  // descriptor and decodes five bytes of waveform as a colour.
  if (format === 2 || format === 3 || format === 5 || format === 7 || format === 8 || format === 10) {
    out.push(
      scalar(
        "rgb",
        "uint16",
        rgbAt,
        { min: [0, 0, 0], max: [65535, 65535, 65535] },
        "",
        3,
      ),
    );
  }
  if (format === 8 || format === 10) {
    out.push(scalar("nir", "uint16", rgbAt + 6, U16));
  }

  return out;
}
