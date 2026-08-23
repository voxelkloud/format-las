// Raw LAS point records to a decoded node.
//
// The record is interleaved and every field sits at a fixed offset, which makes
// this the same shape as Potree's DEFAULT decoder — and it deliberately makes
// the same decisions, field for field: the same output kinds, the same 4-byte
// GPU lanes, the same once-per-source colour narrowing, the same relative
// float32 positions with the origin carried as data. Two drivers that disagreed
// about any of those would render the same LiDAR two different ways.
//
// What is NOT shared with Potree is the record itself: LAS packs return numbers
// and classification flags into bit runs, which no Potree attribute does.

import { UNDECODABLE_ATTRIBUTE_TYPES, VoxelkloudError } from "@voxelkloud/core";
import type {
  BoundingBox,
  DecodedArray,
  DecodedAttribute,
  DecodedColors,
  DecodedPointData,
  GpuVertexFormat,
  OriginPolicy,
  PointAttribute,
  PointDataOptions,
  PointNodeRef,
  PointPositionFrame,
  PositionFormat,
  ScalarLane,
  Vec3,
} from "@voxelkloud/core";
import type { LasAttribute, LasLayout, LasWarning } from "./attributes.js";
import type { LasAccess } from "./point-format.js";

type OutKind = "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "f32" | "f64";

const OUT_FOR_TYPE: Record<string, OutKind> = {
  int8: "i8",
  uint8: "u8",
  int16: "i16",
  uint16: "u16",
  int32: "i32",
  uint32: "u32",
  float: "f32",
  double: "f64",
  int64: "f64",
  uint64: "f64",
};

const GPU_FORMAT: Partial<
  Record<OutKind, Partial<Record<number, GpuVertexFormat>>>
> = {
  f32: { 1: "float32", 2: "float32x2", 3: "float32x3", 4: "float32x4" },
  i32: { 1: "sint32", 2: "sint32x2", 3: "sint32x3", 4: "sint32x4" },
  u32: { 1: "uint32", 2: "uint32x2", 3: "uint32x3", 4: "uint32x4" },
  u8: { 4: "uint8x4" },
  i8: { 4: "sint8x4" },
  u16: { 2: "uint16x2", 4: "uint16x4" },
  i16: { 2: "sint16x2", 4: "sint16x4" },
};

const BYTES_FOR_OUT: Record<OutKind, number> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  f32: 4,
  f64: 8,
};

function makeArray(kind: OutKind, length: number): DecodedArray {
  switch (kind) {
    case "i8":
      return new Int8Array(length);
    case "u8":
      return new Uint8Array(length);
    case "i16":
      return new Int16Array(length);
    case "u16":
      return new Uint16Array(length);
    case "i32":
      return new Int32Array(length);
    case "u32":
      return new Uint32Array(length);
    case "f32":
      return new Float32Array(length);
    case "f64":
      return new Float64Array(length);
  }
}

/**
 * Which 4-byte lane a scalar takes under `scalarFormat: "gpu"`.
 *
 * An unsigned type whose DECLARED min is negative takes the signed lane, which
 * is a real stock output: PotreeConverter ships `"scan angle rank"` as uint8
 * with `min: [-21]`, and its raw bytes really are two's-complement.
 */
function laneFor(
  attribute: PointAttribute,
  override: ScalarLane | undefined,
): ScalarLane {
  if (override !== undefined) return override;
  if (attribute.type === "float" || attribute.type === "double") return "f32";
  const signed =
    attribute.type === "int8" ||
    attribute.type === "int16" ||
    attribute.type === "int32" ||
    attribute.min.some((v) => v < 0);
  return signed ? "i32" : "u32";
}

interface PlannedField {
  readonly attribute: PointAttribute;
  readonly access: LasAccess;
  readonly out: OutKind;
  readonly itemSize: 1 | 2 | 3 | 4;
  readonly gpuFormat: GpuVertexFormat | undefined;
  readonly pack: { readonly offset: number; readonly scale: number } | undefined;
}

/** Everything decided once per cloud, before any node arrives. */
export interface LasDecodePlan {
  readonly stride: number;
  readonly positionFormat: PositionFormat;
  readonly originPolicy: OriginPolicy;
  /** File quantization, from the LAS header. */
  readonly scale: Vec3;
  readonly offset: Vec3;
  /** Indexing box min — the origin under `"cloud"`. */
  readonly cloudOrigin: Vec3;
  readonly computeBounds: boolean;
  readonly fields: readonly PlannedField[];
  readonly position: PlannedField;
  readonly color:
    | { readonly field: PlannedField; readonly shift: 0 | 8; readonly declaredMax: number }
    | undefined;
  readonly warnings: readonly LasWarning[];
  /** Output bytes per point, across every selected field. */
  readonly bytesPerPoint: number;
}

export interface LasDecodeOptions extends PointDataOptions {
  /** File quantization from the LAS header. */
  readonly scale: Vec3;
  readonly offset: Vec3;
  /** The octree's indexing box min. Positions come back relative to it. */
  readonly cloudOrigin: Vec3;
}

/**
 * Resolve the attribute selection and the addressing, once per cloud.
 *
 * @throws {VoxelkloudError} `"unsupported-attribute"` for a name the record does
 *   not have. A typo'd `"intensty"` that silently yields nothing is a worse bug
 *   than a thrown one.
 */
export function createLasDecodePlan(
  layout: LasLayout,
  options: LasDecodeOptions,
): LasDecodePlan {
  const warnings: LasWarning[] = [...layout.warnings];
  const position = layout.attributesByName.get("position");
  if (position === undefined) {
    throw new VoxelkloudError(
      "unsupported-point-data",
      `This LAS record has no position dimension, which cannot happen for a ` +
        `well-formed point format and means the layout was built wrong.`,
    );
  }
  const color = layout.attributesByName.get("rgb");

  const selected = resolveSelection(layout, position, color, options);
  const colorFormat = options.colorFormat ?? "unorm8";
  const scalarFormat = options.scalarFormat ?? "native";

  const fields: PlannedField[] = [];
  let positionField: PlannedField | undefined;
  let colorPlan: LasDecodePlan["color"];
  let bytesPerPoint = 0;

  for (const entry of layout.attributes) {
    if (!selected.has(entry.attribute.name)) continue;
    const attribute = entry.attribute;
    const isPosition = entry === position;
    const isColor = color !== undefined && entry === color;

    let out: OutKind;
    let itemSize: 1 | 2 | 3 | 4;
    let pack: { offset: number; scale: number } | undefined;

    if (isPosition) {
      out = (options.positionFormat ?? "float32") === "int32" ? "i32" : "f32";
      itemSize = 3;
    } else if (isColor) {
      out = colorFormat === "native" ? "u16" : "u8";
      itemSize = 4;
    } else {
      itemSize = attribute.numElements as 1 | 2 | 3 | 4;
      if (scalarFormat === "gpu" && attribute.numElements === 1) {
        const lane = laneFor(attribute, options.lanes?.[attribute.name]);
        out = lane === "u32" ? "u32" : lane === "i32" ? "i32" : "f32";
        if (lane === "f32" && attribute.normalization !== undefined) {
          pack = { ...attribute.normalization };
        }
      } else {
        out = OUT_FOR_TYPE[attribute.type] ?? "f64";
      }
    }

    const planned: PlannedField = {
      attribute,
      access: entry.access,
      out,
      itemSize,
      // Colour binds NORMALIZED — a shader wants 0..1, not 0..255 — so it does
      // not come from the generic table, which would report the integer format
      // and disagree with what the decoder emits.
      gpuFormat: isColor
        ? colorFormat === "native"
          ? "uint16x4"
          : "unorm8x4"
        : GPU_FORMAT[out]?.[itemSize],
      pack,
    };
    fields.push(planned);
    bytesPerPoint += itemSize * BYTES_FOR_OUT[out];
    if (isPosition) positionField = planned;
    if (isColor) {
      const declaredMax = Math.max(...attribute.max);
      colorPlan = {
        field: planned,
        // Decided ONCE from the declared max, never per value: a per-scalar
        // `c > 255 ? c / 256 : c` destroys the hue of any genuinely 16-bit
        // channel that happens to land at or below 255.
        shift:
          colorFormat === "native" || attribute.elementSize !== 2
            ? 0
            : declaredMax > 255
              ? 8
              : 0,
        declaredMax,
      };
    }
  }

  const positionFormat: PositionFormat = options.positionFormat ?? "float32";
  // int32 emits the stored integers verbatim, and those are quantized about the
  // file's own offset — re-basing them would need a non-integer shift.
  const originPolicy: OriginPolicy =
    positionFormat === "int32" ? "file" : (options.origin ?? "cloud");

  return {
    stride: layout.stride,
    positionFormat,
    originPolicy,
    scale: options.scale,
    offset: options.offset,
    cloudOrigin: options.cloudOrigin,
    computeBounds: options.computeBounds ?? false,
    fields,
    position: positionField!,
    color: colorPlan,
    warnings,
    bytesPerPoint,
  };
}

function resolveSelection(
  layout: LasLayout,
  position: LasAttribute,
  color: LasAttribute | undefined,
  options: PointDataOptions,
): Set<string> {
  const wanted = options.attributes;
  if (wanted === "all") {
    const all = new Set<string>();
    for (const entry of layout.attributes) {
      if (UNDECODABLE_ATTRIBUTE_TYPES.has(entry.attribute.type)) continue;
      all.add(entry.attribute.name);
    }
    return all;
  }
  if (wanted === undefined) {
    // Position plus colour, and nothing else — the same default Potree's
    // decoder takes, and for the same reason: it is what a renderer binds.
    const set = new Set<string>([position.attribute.name]);
    if (color !== undefined) set.add(color.attribute.name);
    return set;
  }
  const set = new Set<string>([position.attribute.name]);
  for (const name of wanted) {
    const entry = layout.attributesByName.get(name);
    if (entry === undefined) {
      throw new VoxelkloudError(
        "unsupported-attribute",
        `This cloud has no attribute named ${JSON.stringify(name)}. It has: ` +
          `${layout.attributes.map((a) => JSON.stringify(a.attribute.name)).join(", ")}.`,
      );
    }
    if (UNDECODABLE_ATTRIBUTE_TYPES.has(entry.attribute.type)) {
      throw new VoxelkloudError(
        "unsupported-attribute",
        `Attribute ${JSON.stringify(name)} has type ${entry.attribute.type}, ` +
          `which cannot be decoded without losing precision above 2^53.`,
      );
    }
    set.add(name);
  }
  return set;
}

/** Read one field's element `e` of point `i` as a number. */
function readElement(
  view: DataView,
  base: number,
  access: LasAccess,
  type: string,
  elementSize: number,
  e: number,
): number {
  if (access.kind === "bits") {
    const byte = view.getUint8(base + access.at);
    return (byte >>> access.shift) & ((1 << access.width) - 1);
  }
  const at = base + access.at + e * elementSize;
  switch (type) {
    case "int8":
      return view.getInt8(at);
    case "uint8":
      return view.getUint8(at);
    case "int16":
      return view.getInt16(at, true);
    case "uint16":
      return view.getUint16(at, true);
    case "int32":
      return view.getInt32(at, true);
    case "uint32":
      return view.getUint32(at, true);
    case "float":
      return view.getFloat32(at, true);
    default:
      return view.getFloat64(at, true);
  }
}

/**
 * Half a float32 ULP at the largest magnitude this node's box can produce,
 * widened by one quantum because decoded values may sit just outside the box.
 *
 * Computed A PRIORI from the box, never from the data, so it is valid before
 * the first point is read.
 */
function positionError(
  node: PointNodeRef,
  origin: Vec3,
  scale: Vec3,
): number {
  const reach = Math.max(
    Math.abs(node.minX - origin[0]),
    Math.abs(node.maxX - origin[0]),
    Math.abs(node.minY - origin[1]),
    Math.abs(node.maxY - origin[1]),
    Math.abs(node.minZ - origin[2]),
    Math.abs(node.maxZ - origin[2]),
  );
  const ulp = reach === 0 ? 0 : 2 ** (Math.floor(Math.log2(reach)) - 23);
  return ulp / 2 + Math.max(scale[0], scale[1], scale[2]);
}

/**
 * Decode one node's records.
 *
 * `records` must hold exactly `node.numPoints * plan.stride` bytes; a short
 * buffer throws rather than emitting a partly-zeroed node, because a hole in a
 * point cloud is invisible and a thrown error is not.
 */
export function decodeLasRecords(
  plan: LasDecodePlan,
  node: PointNodeRef,
  records: Uint8Array,
  options: { readonly computeBounds?: boolean } = {},
): DecodedPointData {
  const count = node.numPoints;
  const need = count * plan.stride;
  if (records.byteLength < need) {
    throw new VoxelkloudError(
      "unsupported-point-data",
      `Node ${node.name} declares ${count} points of ${plan.stride} bytes ` +
        `(${need}), but only ${records.byteLength} bytes were decoded.`,
    );
  }

  const view = new DataView(
    records.buffer,
    records.byteOffset,
    records.byteLength,
  );
  const computeBounds = options.computeBounds ?? plan.computeBounds;

  const origin: Vec3 =
    plan.originPolicy === "file"
      ? [plan.offset[0], plan.offset[1], plan.offset[2]]
      : plan.originPolicy === "node"
        ? [node.minX, node.minY, node.minZ]
        : [plan.cloudOrigin[0], plan.cloudOrigin[1], plan.cloudOrigin[2]];

  const positions =
    plan.positionFormat === "int32"
      ? new Int32Array(3 * count)
      : new Float32Array(3 * count);

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const posAt = plan.position.access.kind === "scalar" ? plan.position.access.at : 0;

  for (let i = 0; i < count; i++) {
    const base = i * plan.stride;
    for (let k = 0; k < 3; k++) {
      const raw = view.getInt32(base + posAt + k * 4, true);
      if (plan.positionFormat === "int32") {
        (positions as Int32Array)[3 * i + k] = raw;
      }
      // The absolute value is needed for bounds whichever format is emitted,
      // and for the relative float32 in the common case.
      const absolute = raw * plan.scale[k]! + plan.offset[k]!;
      if (plan.positionFormat !== "int32") {
        (positions as Float32Array)[3 * i + k] = absolute - origin[k]!;
      }
      if (computeBounds) {
        if (absolute < lo[k]!) lo[k] = absolute;
        if (absolute > hi[k]!) hi[k] = absolute;
      }
    }
  }

  const frame: PointPositionFrame = {
    format: plan.positionFormat,
    origin,
    scale:
      plan.positionFormat === "int32"
        ? [plan.scale[0], plan.scale[1], plan.scale[2]]
        : [1, 1, 1],
    originPolicy: plan.originPolicy,
    maxPositionError:
      plan.positionFormat === "int32"
        ? 0
        : positionError(node, origin, plan.scale),
  };

  let colors: DecodedColors | undefined;
  if (plan.color !== undefined) {
    const { field, shift, declaredMax } = plan.color;
    const wide = field.out === "u16";
    const array = wide ? new Uint16Array(4 * count) : new Uint8Array(4 * count);
    const maxValue = wide ? 65535 : 255;
    const at = field.access.kind === "scalar" ? field.access.at : 0;
    const elementSize = field.attribute.elementSize;
    for (let i = 0; i < count; i++) {
      const base = i * plan.stride + at;
      for (let c = 0; c < 3; c++) {
        const raw =
          elementSize === 2
            ? view.getUint16(base + c * 2, true)
            : view.getUint8(base + c);
        array[4 * i + c] = shift === 8 ? raw >>> 8 : raw;
      }
      // Alpha is filled rather than left at zero: LAS has no alpha channel and
      // a shader that binds vec4 would render the whole cloud transparent.
      array[4 * i + 3] = maxValue;
    }
    colors = {
      array,
      gpuFormat: field.gpuFormat!,
      maxValue,
      declaredMax,
      shift,
    };
  }

  const attributes: DecodedAttribute[] = [];
  const attributesByName = new Map<string, DecodedAttribute>();

  for (const field of plan.fields) {
    if (field === plan.position) continue;
    if (plan.color !== undefined && field === plan.color.field) continue;

    const { attribute, itemSize, out, access } = field;
    const array = makeArray(out, itemSize * count);
    const elementSize = attribute.elementSize;
    const pack = field.pack;

    for (let i = 0; i < count; i++) {
      const base = i * plan.stride;
      for (let e = 0; e < itemSize; e++) {
        const raw = readElement(
          view,
          base,
          access,
          attribute.type,
          elementSize,
          e,
        );
        array[itemSize * i + e] =
          pack === undefined ? raw : (raw - pack.offset) * pack.scale;
      }
    }

    const decoded: DecodedAttribute = {
      name: attribute.name,
      source: attribute,
      array,
      itemSize,
      byteStride: itemSize * array.BYTES_PER_ELEMENT,
      gpuFormat: field.gpuFormat,
      inverse:
        pack === undefined
          ? undefined
          : { scale: 1 / pack.scale, offset: pack.offset },
    };
    attributes.push(decoded);
    if (!attributesByName.has(decoded.name)) {
      attributesByName.set(decoded.name, decoded);
    }
  }

  const buffers = new Set<ArrayBuffer>();
  buffers.add(positions.buffer as ArrayBuffer);
  if (colors !== undefined) buffers.add(colors.array.buffer as ArrayBuffer);
  for (const a of attributes) buffers.add(a.array.buffer as ArrayBuffer);
  const transferList = [...buffers];

  let bounds: BoundingBox | undefined;
  if (computeBounds && count > 0) {
    bounds = {
      min: [lo[0]!, lo[1]!, lo[2]!],
      max: [hi[0]!, hi[1]!, hi[2]!],
    };
  }

  return {
    nodeIndex: node.index,
    nodeName: node.name,
    numPoints: count,
    positions,
    frame,
    colors,
    attributes,
    attributesByName,
    bounds,
    transferList,
    byteLength: transferList.reduce((sum, b) => sum + b.byteLength, 0),
  };
}
