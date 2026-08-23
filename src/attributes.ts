// From a LAS record layout to the neutral attribute vocabulary.
//
// The names are PotreeConverter's for the same fields, on purpose: a colour
// mode that keys off `"classification"` must work on a COPC cloud and a Potree
// cloud without the renderer knowing which it got.

import { POINT_ATTRIBUTE_TYPE_SIZE } from "@voxelkloud/core";
import type {
  BoundingBox,
  PointAttribute,
  PointAttributeTypeName,
  PointCloudWarning,
} from "@voxelkloud/core";
import { parseExtraBytes } from "./extra-bytes.js";
import type { ExtraByteField } from "./extra-bytes.js";
import { lasBaseSize, lasDimensions } from "./point-format.js";
import type { LasAccess } from "./point-format.js";

export type LasWarningCode =
  | "extra-bytes-mismatch"
  | "undecodable-attribute"
  | "degenerate-range"
  | "duplicate-attribute-name";

export type LasWarning = PointCloudWarning<LasWarningCode>;

/** One attribute plus how to read it out of a record. */
export interface LasAttribute {
  readonly attribute: PointAttribute;
  readonly access: LasAccess;
}

export interface LasLayoutOptions {
  readonly format: number;
  /** `point_data_record_length` from the header, extra bytes included. */
  readonly pointSize: number;
  /** Payload of the Extra Bytes VLR (`LASF_Spec`, record 4), when present. */
  readonly extraBytes?: Uint8Array | undefined;
  /** Position's true domain, in absolute CRS units. */
  readonly bounds: BoundingBox;
  /** GPS time's true domain, when the container knows it. COPC's info VLR does. */
  readonly gpsTimeRange?: readonly [number, number] | undefined;
}

export interface LasLayout {
  readonly attributes: readonly LasAttribute[];
  readonly attributesByName: ReadonlyMap<string, LasAttribute>;
  /** Bytes per record. Equal to the header's `point_data_record_length`. */
  readonly stride: number;
  readonly warnings: readonly LasWarning[];
}

function roleFor(name: string): "position" | "color" | undefined {
  if (name === "position") return "position";
  if (name === "rgb") return "color";
  return undefined;
}

/**
 * Build the attribute list for a LAS record.
 *
 * @throws Never. A record that does not add up produces a warning and a layout
 *   that is still self-consistent, because refusing a file over a mislabelled
 *   extra dimension would be worse than showing it without that dimension.
 */
export function lasLayout(options: LasLayoutOptions): LasLayout {
  const warnings: LasWarning[] = [];
  const emitted = new Set<LasWarningCode>();
  const warn = (code: LasWarningCode, path: string, message: string): void => {
    if (emitted.has(code)) return;
    emitted.add(code);
    warnings.push({ code, path, message });
  };

  const base = lasBaseSize(options.format);
  const declaredExtra = options.pointSize - base;

  let extras: readonly ExtraByteField[] = [];
  if (options.extraBytes !== undefined && options.extraBytes.byteLength > 0) {
    extras = parseExtraBytes(options.extraBytes, base);
    const described = extras.reduce((sum, f) => sum + f.byteSize, 0);
    if (described !== declaredExtra) {
      warn(
        "extra-bytes-mismatch",
        "extraBytes",
        `The Extra Bytes VLR describes ${described} bytes past the ` +
          `${base}-byte format ${options.format} record, but the header ` +
          `declares a ${options.pointSize}-byte record (${declaredExtra} extra). ` +
          `Fields past the declared end are dropped.`,
      );
      extras = extras.filter((f) => f.byteOffset + f.byteSize <= options.pointSize);
    }
  }

  const attributes: LasAttribute[] = [];
  const attributesByName = new Map<string, LasAttribute>();

  const push = (attribute: PointAttribute, access: LasAccess): void => {
    const entry = { attribute, access };
    attributes.push(entry);
    if (attributesByName.has(attribute.name)) {
      warn(
        "duplicate-attribute-name",
        attribute.name,
        `Attribute name ${JSON.stringify(attribute.name)} appears more than ` +
          `once. Lookups by name resolve to the first occurrence; both keep ` +
          `their own byte offsets.`,
      );
    } else {
      attributesByName.set(attribute.name, entry);
    }
  };

  const normalizationFor = (
    name: string,
    numElements: number,
    elementSize: number,
    min: readonly number[],
    max: readonly number[],
  ): { offset: number; scale: number } | undefined => {
    // Wide scalars get packed into float32 downstream; a degenerate range would
    // make `1 / (max - min)` Infinity and every decoded value NaN.
    if (!(numElements === 1 && elementSize > 4)) return undefined;
    const lo = min[0] ?? 0;
    const hi = max[0] ?? 0;
    if (lo === hi) {
      warn(
        "degenerate-range",
        name,
        `Attribute ${JSON.stringify(name)} has min === max (${lo}), so it ` +
          `cannot be normalised into float32. Using a denominator of 1; every ` +
          `value will decode to 0.`,
      );
    }
    return { offset: lo, scale: 1 / (hi - lo || 1) };
  };

  for (const dim of lasDimensions(options.format)) {
    const elementSize = POINT_ATTRIBUTE_TYPE_SIZE[dim.type];
    let min = dim.min;
    let max = dim.max;
    if (dim.name === "position") {
      // Absolute CRS, post scale and offset — the same convention Potree's
      // manifest uses for its position attribute.
      min = options.bounds.min;
      max = options.bounds.max;
    } else if (dim.name === "gps-time" && options.gpsTimeRange !== undefined) {
      min = [options.gpsTimeRange[0]];
      max = [options.gpsTimeRange[1]];
    }

    push(
      {
        name: dim.name,
        role: roleFor(dim.name),
        description: dim.description,
        type: dim.type,
        numElements: dim.numElements,
        elementSize,
        byteSize: dim.numElements * elementSize,
        // For a bit run this is the byte the run lives in. Nothing reads it as
        // an addressable offset — `access` is what the decoder uses — but it is
        // the honest answer to "where in the record is this".
        byteOffset: dim.access.at,
        min,
        max,
        scale: new Array<number>(dim.numElements).fill(1),
        offset: new Array<number>(dim.numElements).fill(0),
        histogram: undefined,
        normalization: normalizationFor(
          dim.name,
          dim.numElements,
          elementSize,
          min,
          max,
        ),
      },
      dim.access,
    );
  }

  for (const field of extras) {
    if (field.type === "undefined") {
      warn(
        "undecodable-attribute",
        field.name,
        `Extra dimension ${JSON.stringify(field.name)} is declared as ` +
          `${field.byteSize} undocumented bytes (data_type 0), which carry no ` +
          `interpretation. It is skipped; the record stride still counts it.`,
      );
      continue;
    }
    const type: PointAttributeTypeName = field.type;
    const elementSize = POINT_ATTRIBUTE_TYPE_SIZE[type];
    const min = field.min ?? new Array<number>(field.numElements).fill(0);
    const max = field.max ?? new Array<number>(field.numElements).fill(0);
    push(
      {
        name: field.name,
        role: undefined,
        description: field.description,
        type,
        numElements: field.numElements,
        elementSize,
        byteSize: field.byteSize,
        byteOffset: field.byteOffset,
        min,
        max,
        scale: field.scale ?? new Array<number>(field.numElements).fill(1),
        offset: field.offset ?? new Array<number>(field.numElements).fill(0),
        histogram: undefined,
        normalization: normalizationFor(
          field.name,
          field.numElements,
          elementSize,
          min,
          max,
        ),
      },
      { kind: "scalar", at: field.byteOffset },
    );
  }

  return {
    attributes,
    attributesByName,
    stride: options.pointSize,
    warnings,
  };
}
