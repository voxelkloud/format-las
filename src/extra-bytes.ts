// The Extra Bytes VLR: LASF_Spec record 4.
//
// A LAS record may carry dimensions the spec never named — an origin id, a
// per-point return-path metric, a scanner temperature — and this 192-byte
// descriptor per dimension is how the file says what they are. Without it the
// bytes are there and unreadable, which is how the COPC demo file's `OriginId`
// would look.

import type { PointAttributeTypeName } from "@voxelkloud/core";

/** Bytes of one descriptor. Fixed by the spec, and the record's own length / 192. */
const DESCRIPTOR_SIZE = 192;

/** `options` bit flags: which of the optional value fields are meaningful. */
const HAS_NO_DATA = 0b0_0001;
const HAS_MIN = 0b0_0010;
const HAS_MAX = 0b0_0100;
const HAS_SCALE = 0b0_1000;
const HAS_OFFSET = 0b1_0000;

/**
 * `data_type` to a neutral type name and width.
 *
 * Values 11-30 are the deprecated 2- and 3-element variants, removed in LAS
 * 1.4 R15. They are mapped rather than rejected because files written against
 * the older spec exist, and reading one dimension of the pair is better than
 * refusing the file.
 */
const TYPES: Readonly<
  Record<number, { type: PointAttributeTypeName; size: number; elements: number }>
> = {
  1: { type: "uint8", size: 1, elements: 1 },
  2: { type: "int8", size: 1, elements: 1 },
  3: { type: "uint16", size: 2, elements: 1 },
  4: { type: "int16", size: 2, elements: 1 },
  5: { type: "uint32", size: 4, elements: 1 },
  6: { type: "int32", size: 4, elements: 1 },
  7: { type: "uint64", size: 8, elements: 1 },
  8: { type: "int64", size: 8, elements: 1 },
  9: { type: "float", size: 4, elements: 1 },
  10: { type: "double", size: 8, elements: 1 },
};

export interface ExtraByteField {
  readonly name: string;
  readonly description: string;
  /** `"undefined"` for `data_type` 0, raw bytes with no interpretation. */
  readonly type: PointAttributeTypeName | "undefined";
  readonly numElements: number;
  /** Bytes this field occupies in the record. */
  readonly byteSize: number;
  /** Offset within the record, filled in by {@link parseExtraBytes}. */
  readonly byteOffset: number;
  readonly min: readonly number[] | undefined;
  readonly max: readonly number[] | undefined;
  readonly scale: readonly number[] | undefined;
  readonly offset: readonly number[] | undefined;
}

function fixedString(view: DataView, at: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + at, length);
  let end = bytes.indexOf(0);
  if (end < 0) end = length;
  return new TextDecoder()
    .decode(bytes.subarray(0, end))
    .replace(/\s+$/u, "");
}

/**
 * Parse an Extra Bytes VLR payload into fields, in record order.
 *
 * @param record The VLR's payload, a whole number of 192-byte descriptors.
 * @param firstOffset Byte offset of the first extra field within one point
 *   record — the point format's base size.
 */
export function parseExtraBytes(
  record: Uint8Array,
  firstOffset: number,
): readonly ExtraByteField[] {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const count = Math.floor(record.byteLength / DESCRIPTOR_SIZE);
  const out: ExtraByteField[] = [];
  let at = firstOffset;

  for (let i = 0; i < count; i++) {
    const base = i * DESCRIPTOR_SIZE;
    const dataType = view.getUint8(base + 2);
    const options = view.getUint8(base + 3);
    const name = fixedString(view, base + 4, 32);
    const description = fixedString(view, base + 160, 32);

    // `data_type` 0 means "undocumented bytes", and then `options` IS the byte
    // count rather than a flag word. Nothing can interpret them, but they still
    // occupy the record, so they must be counted or every later field shifts.
    if (dataType === 0) {
      const byteSize = options;
      out.push({
        name: name === "" ? `extra ${i}` : name,
        description,
        type: "undefined",
        numElements: 1,
        byteSize,
        byteOffset: at,
        min: undefined,
        max: undefined,
        scale: undefined,
        offset: undefined,
      });
      at += byteSize;
      continue;
    }

    const spec = TYPES[dataType] ?? TYPES[((dataType - 11) % 10) + 1];
    const elements = dataType > 10 ? (dataType <= 20 ? 2 : 3) : 1;
    const size = (spec?.size ?? 1) * elements;

    // The optional triples are stored as three 8-byte slots whatever the
    // dimension's own width, so they are read as doubles for the integer types
    // too — which is what every writer does, and what `anytype` means.
    const triple = (offset: number, n: number): number[] => {
      const values: number[] = [];
      for (let k = 0; k < n; k++) {
        values.push(view.getFloat64(base + offset + k * 8, true));
      }
      return values;
    };

    out.push({
      name: name === "" ? `extra ${i}` : name,
      description,
      type: spec?.type ?? "uint8",
      numElements: elements,
      byteSize: size,
      byteOffset: at,
      min: options & HAS_MIN ? triple(64, elements) : undefined,
      max: options & HAS_MAX ? triple(88, elements) : undefined,
      scale: options & HAS_SCALE ? triple(112, elements) : undefined,
      offset: options & HAS_OFFSET ? triple(136, elements) : undefined,
    });
    at += size;
    // `no_data` at offset 40 is deliberately unread: nothing downstream can act
    // on a sentinel without a per-point branch in the hot loop.
    void HAS_NO_DATA;
  }

  return out;
}
