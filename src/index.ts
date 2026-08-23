// @voxelkloud/format-las — the LAS point record, shared.
//
// Not a driver. Three of them stand on it: COPC nodes are LAS 1.4 records, an
// EPT `laszip` node is a LAS file, and the single-file tier is a `.las` or
// `.laz` outright. What is here is the record — where each dimension sits, how
// the bit-packed ones come apart, what the Extra Bytes VLR declares, and how
// all of it becomes the neutral `DecodedPointData` from @voxelkloud/core.
//
// The attribute NAMES are PotreeConverter's for the same fields, deliberately:
// a colour mode that keys off `"classification"` has to work on a COPC cloud
// and a Potree cloud without the renderer knowing which it got.

export { lasBaseSize, lasDimensions } from "./point-format.js";
export type { LasAccess, LasDimension } from "./point-format.js";

export { parseExtraBytes } from "./extra-bytes.js";
export type { ExtraByteField } from "./extra-bytes.js";

export { lasLayout } from "./attributes.js";
export type {
  LasAttribute,
  LasLayout,
  LasLayoutOptions,
  LasWarning,
  LasWarningCode,
} from "./attributes.js";

export { lasCrs } from "./crs.js";
export type { LasProjectionVlrs } from "./crs.js";
export {
  GEOKEY_ASCII_RECORD_ID,
  GEOKEY_DIRECTORY_RECORD_ID,
  GEOKEY_DOUBLE_RECORD_ID,
  PROJECTION_USER_ID,
  WKT_RECORD_ID,
} from "./crs.js";

export { createLasDecodePlan, decodeLasRecords } from "./decode.js";
export type { LasDecodeOptions, LasDecodePlan } from "./decode.js";
