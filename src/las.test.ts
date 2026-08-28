// The LAS record, tested directly.
//
// The COPC and EPT drivers exercise this package end to end, but between them
// they only ever meet point formats 2 and 7. The layout for 0, 1, 3, 4, 5, 6, 8
// and the whole Extra Bytes descriptor are reachable only from here, and a
// wrong offset in any of them is silent: it decodes a neighbouring field and
// renders something plausible.

import { describe, expect, it } from "vitest";
import { POINT_ATTRIBUTE_TYPE_SIZE } from "@voxelkloud/core";
import { lasBaseSize, lasDimensions } from "./point-format.js";
import { parseExtraBytes } from "./extra-bytes.js";
import { lasLayout } from "./attributes.js";
import { createLasDecodePlan, decodeLasRecords } from "./decode.js";

const BOUNDS = { min: [0, 0, 0], max: [100, 100, 100] } as const;
const box = () => ({ min: [...BOUNDS.min], max: [...BOUNDS.max] }) as {
  min: [number, number, number];
  max: [number, number, number];
};

const NODE = {
  index: 0,
  name: "r",
  numPoints: 0,
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 100,
  maxY: 100,
  maxZ: 100,
};

describe("lasDimensions", () => {
  it("knows every point format's record size", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(lasBaseSize)).toEqual([
      20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67,
    ]);
    expect(() => lasBaseSize(11)).toThrow(/not one of 0-10/);
  });

  it("puts colour after gps-time, except in format 2 which has none", () => {
    // The one asymmetry in the legacy layouts, and the one a reader gets wrong.
    const at = (format: number, name: string) => {
      const dim = lasDimensions(format).find((d) => d.name === name);
      return dim === undefined ? undefined : dim.access.at;
    };
    expect(at(2, "gps-time")).toBeUndefined();
    expect(at(2, "rgb")).toBe(20);
    expect(at(3, "gps-time")).toBe(20);
    expect(at(3, "rgb")).toBe(28);
    expect(at(7, "gps-time")).toBe(22);
    expect(at(7, "rgb")).toBe(30);
    expect(at(8, "nir")).toBe(36);
    expect(at(0, "rgb")).toBeUndefined();
    expect(at(6, "rgb")).toBeUndefined();
  });

  it("widens the bit runs from 3 bits to 4 at format 6", () => {
    // Legacy packs return number and count into three bits each and shares the
    // byte with two flags; 1.4 gives each four bits and moves the flags on.
    const legacy = lasDimensions(1);
    const rn = legacy.find((d) => d.name === "return number")!;
    expect(rn.access).toEqual({ kind: "bits", at: 14, shift: 0, width: 3 });
    expect(legacy.find((d) => d.name === "scan direction flag")!.access).toEqual(
      { kind: "bits", at: 14, shift: 6, width: 1 },
    );
    expect(legacy.find((d) => d.name === "classification flags")).toBeUndefined();

    const modern = lasDimensions(6);
    expect(modern.find((d) => d.name === "return number")!.access).toEqual({
      kind: "bits",
      at: 14,
      shift: 0,
      width: 4,
    });
    expect(modern.find((d) => d.name === "classification flags")!.access).toEqual(
      { kind: "bits", at: 15, shift: 0, width: 4 },
    );
    expect(modern.find((d) => d.name === "scanner channel")!.access).toEqual({
      kind: "bits",
      at: 15,
      shift: 4,
      width: 2,
    });
  });

  it("names the scan angle differently either side of format 6", () => {
    // Not a rename for its own sake: legacy stores a signed byte of degrees,
    // 1.4 a 16-bit value in 0.006 degree increments. Same idea, different units.
    expect(lasDimensions(1).find((d) => d.name === "scan angle rank")!.type).toBe(
      "int8",
    );
    expect(lasDimensions(6).find((d) => d.name === "scan angle")!.type).toBe(
      "int16",
    );
    expect(lasDimensions(6).find((d) => d.name === "scan angle rank")).toBeUndefined();
  });

  it("leaves the wave packet fields out without losing the stride", () => {
    // Formats 4 and 5 add 29 bytes of waveform this project cannot render.
    // Leaving them out must not shift anything: every offset stays where the
    // spec puts it and the caller's `pointSize` still accounts for the bytes.
    const four = lasDimensions(4);
    expect(four.find((d) => d.name.includes("wave"))).toBeUndefined();
    expect(four.find((d) => d.name === "gps-time")!.access).toEqual({
      kind: "scalar",
      at: 20,
    });
    expect(lasBaseSize(4) - lasBaseSize(1)).toBe(29);
  });

  it("gives colour to exactly the formats that have it", () => {
    // Point format 9 is format 6 plus wave packets, so it has NO colour, and a
    // `format >= 7` test would put "rgb" at byte 30 — on top of the wave packet
    // descriptor, decoding waveform bytes as a colour that looks plausible.
    const coloured = [2, 3, 5, 7, 8, 10];
    for (let format = 0; format <= 10; format++) {
      const has = lasDimensions(format).some((d) => d.name === "rgb");
      expect(has, `point format ${format}`).toBe(coloured.includes(format));
    }
  });

  it("keeps every dimension inside the base record", () => {
    // The failure this catches produces plausible garbage rather than an error:
    // one dimension overlapping another decodes without complaint.
    for (let format = 0; format <= 10; format++) {
      for (const dim of lasDimensions(format)) {
        const size =
          dim.access.kind === "bits"
            ? 1
            : dim.numElements * POINT_ATTRIBUTE_TYPE_SIZE[dim.type];
        expect(
          dim.access.at + size,
          `point format ${format}: ${dim.name}`,
        ).toBeLessThanOrEqual(lasBaseSize(format));
      }
    }
  });
});

describe("parseExtraBytes", () => {
  /** One 192-byte descriptor. */
  function descriptor(options: {
    dataType: number;
    name: string;
    flags?: number;
    values?: { at: number; value: number }[];
  }): Uint8Array {
    const bytes = new Uint8Array(192);
    const view = new DataView(bytes.buffer);
    view.setUint8(2, options.dataType);
    view.setUint8(3, options.flags ?? 0);
    bytes.set(new TextEncoder().encode(options.name), 4);
    for (const { at, value } of options.values ?? []) {
      view.setFloat64(at, value, true);
    }
    return bytes;
  }

  it("reads a named dimension and places it after the base record", () => {
    const fields = parseExtraBytes(
      descriptor({ dataType: 5, name: "OriginId" }),
      36,
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe("OriginId");
    expect(fields[0]!.type).toBe("uint32");
    expect(fields[0]!.byteSize).toBe(4);
    expect(fields[0]!.byteOffset).toBe(36);
  });

  it("packs several descriptors back to back", () => {
    const record = new Uint8Array(384);
    record.set(descriptor({ dataType: 1, name: "a" }), 0);
    record.set(descriptor({ dataType: 10, name: "b" }), 192);
    const fields = parseExtraBytes(record, 30);
    expect(fields.map((f) => [f.name, f.type, f.byteOffset, f.byteSize])).toEqual([
      ["a", "uint8", 30, 1],
      ["b", "double", 31, 8],
    ]);
  });

  it("counts undocumented bytes without pretending to read them", () => {
    // data_type 0 means "options IS the byte count". Skipping the bytes rather
    // than counting them would shift every field after it.
    const record = new Uint8Array(384);
    record.set(descriptor({ dataType: 0, name: "blob", flags: 6 }), 0);
    record.set(descriptor({ dataType: 3, name: "after" }), 192);
    const fields = parseExtraBytes(record, 20);
    expect(fields[0]!.type).toBe("undefined");
    expect(fields[0]!.byteSize).toBe(6);
    expect(fields[1]!.byteOffset).toBe(26);
  });

  it("reads min, max, scale and offset only when the flags say so", () => {
    const withScale = parseExtraBytes(
      descriptor({
        dataType: 6,
        name: "scaled",
        // bit 1 min, bit 2 max, bit 3 scale, bit 4 offset.
        flags: 0b1_1110,
        values: [
          { at: 64, value: -5 },
          { at: 88, value: 5 },
          { at: 112, value: 0.5 },
          { at: 136, value: 2 },
        ],
      }),
      20,
    );
    expect(withScale[0]!.min).toEqual([-5]);
    expect(withScale[0]!.max).toEqual([5]);
    expect(withScale[0]!.scale).toEqual([0.5]);
    expect(withScale[0]!.offset).toEqual([2]);

    const bare = parseExtraBytes(descriptor({ dataType: 6, name: "bare" }), 20);
    expect(bare[0]!.min).toBeUndefined();
    expect(bare[0]!.scale).toBeUndefined();
  });
});

describe("lasLayout", () => {
  it("warns when the descriptors and the header disagree, and keeps what fits", () => {
    // A four-byte dimension declared past a record that has no room for it.
    const record = new Uint8Array(192);
    new DataView(record.buffer).setUint8(2, 5);
    record.set(new TextEncoder().encode("Extra"), 4);

    const layout = lasLayout({
      format: 6,
      pointSize: 30, // no extra bytes at all
      extraBytes: record,
      bounds: box(),
    });
    expect(layout.warnings.map((w) => w.code)).toContain("extra-bytes-mismatch");
    expect(layout.attributes.map((a) => a.attribute.name)).not.toContain("Extra");
  });

  it("gives position the header's own extent, not the type's range", () => {
    const layout = lasLayout({ format: 6, pointSize: 30, bounds: box() });
    const position = layout.attributesByName.get("position")!.attribute;
    expect(position.min).toEqual([0, 0, 0]);
    expect(position.max).toEqual([100, 100, 100]);
    expect(position.role).toBe("position");
  });

  it("normalises gps-time against the declared domain, and warns if it is flat", () => {
    const wide = lasLayout({
      format: 6,
      pointSize: 30,
      bounds: box(),
      gpsTimeRange: [100, 200],
    });
    expect(wide.attributesByName.get("gps-time")!.attribute.normalization).toEqual({
      offset: 100,
      scale: 1 / 100,
    });
    expect(wide.warnings).toEqual([]);

    const flat = lasLayout({ format: 6, pointSize: 30, bounds: box() });
    // 1/(0 || 1) rather than 1/0: a degenerate range would make every decoded
    // value NaN instead of 0.
    expect(flat.attributesByName.get("gps-time")!.attribute.normalization).toEqual({
      offset: 0,
      scale: 1,
    });
    expect(flat.warnings.map((w) => w.code)).toEqual(["degenerate-range"]);
  });
});

describe("decodeLasRecords", () => {
  /** One synthetic format 6 record. */
  function record(values: {
    x: number;
    y: number;
    z: number;
    intensity: number;
    returnNumber: number;
    numberOfReturns: number;
    classFlags: number;
    scannerChannel: number;
    classification: number;
    gps: number;
  }): Uint8Array {
    const bytes = new Uint8Array(30);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, values.x, true);
    view.setInt32(4, values.y, true);
    view.setInt32(8, values.z, true);
    view.setUint16(12, values.intensity, true);
    view.setUint8(
      14,
      (values.returnNumber & 0xf) | ((values.numberOfReturns & 0xf) << 4),
    );
    view.setUint8(15, (values.classFlags & 0xf) | ((values.scannerChannel & 3) << 4));
    view.setUint8(16, values.classification);
    view.setFloat64(22, values.gps, true);
    return bytes;
  }

  const POINTS = [
    {
      x: 1000,
      y: 2000,
      z: 3000,
      intensity: 40_000,
      returnNumber: 2,
      numberOfReturns: 5,
      classFlags: 9,
      scannerChannel: 3,
      classification: 200,
      gps: 150,
    },
    {
      x: -1000,
      y: 500,
      z: 250,
      intensity: 7,
      returnNumber: 1,
      numberOfReturns: 1,
      classFlags: 0,
      scannerChannel: 0,
      classification: 2,
      gps: 200,
    },
  ];

  function decode(options: Parameters<typeof createLasDecodePlan>[1]) {
    const layout = lasLayout({
      format: 6,
      pointSize: 30,
      bounds: box(),
      gpsTimeRange: [100, 200],
    });
    const plan = createLasDecodePlan(layout, options);
    const bytes = new Uint8Array(30 * POINTS.length);
    POINTS.forEach((p, i) => bytes.set(record(p), i * 30));
    return decodeLasRecords(plan, { ...NODE, numPoints: POINTS.length }, bytes);
  }

  const BASE = {
    scale: [0.01, 0.01, 0.01],
    offset: [10, 20, 30],
    cloudOrigin: [0, 0, 0],
  } as const;

  it("reconstructs absolute positions through scale and offset", () => {
    const data = decode({ ...BASE });
    expect(data.frame.format).toBe("float32");
    // 1000 * 0.01 + 10, relative to an origin of 0.
    expect(data.positions[0]).toBeCloseTo(20, 5);
    expect(data.positions[1]).toBeCloseTo(40, 5);
    expect(data.positions[2]).toBeCloseTo(60, 5);
    expect(data.positions[3]).toBeCloseTo(0, 5);
  });

  it("emits positions relative to the origin the policy names", () => {
    const node = { ...NODE, numPoints: 2, minX: 5, minY: 5, minZ: 5 };
    const layout = lasLayout({ format: 6, pointSize: 30, bounds: box() });
    const bytes = new Uint8Array(60);
    POINTS.forEach((p, i) => bytes.set(record(p), i * 30));

    const cloud = decodeLasRecords(
      createLasDecodePlan(layout, { ...BASE, cloudOrigin: [1, 2, 3] }),
      node,
      bytes,
    );
    expect(cloud.frame.origin).toEqual([1, 2, 3]);
    expect(cloud.positions[0]).toBeCloseTo(20 - 1, 5);

    const perNode = decodeLasRecords(
      createLasDecodePlan(layout, { ...BASE, origin: "node" }),
      node,
      bytes,
    );
    expect(perNode.frame.origin).toEqual([5, 5, 5]);
    expect(perNode.positions[0]).toBeCloseTo(20 - 5, 5);

    // int32 forces the file frame: the stored integers are quantised about the
    // file's own offset and re-basing them would need a non-integer shift.
    const exact = decodeLasRecords(
      createLasDecodePlan(layout, {
        ...BASE,
        positionFormat: "int32",
        origin: "node",
      }),
      node,
      bytes,
    );
    expect(exact.frame.originPolicy).toBe("file");
    expect(exact.frame.origin).toEqual([10, 20, 30]);
    expect(exact.positions[0]).toBe(1000);
    expect(exact.frame.maxPositionError).toBe(0);
  });

  it("unpacks each bit run out of its shared byte", () => {
    const data = decode({
      ...BASE,
      attributes: [
        "return number",
        "number of returns",
        "classification flags",
        "scanner channel",
        "classification",
      ],
    });
    const at = (name: string, i: number) =>
      data.attributesByName.get(name)!.array[i];
    expect(at("return number", 0)).toBe(2);
    expect(at("number of returns", 0)).toBe(5);
    expect(at("classification flags", 0)).toBe(9);
    expect(at("scanner channel", 0)).toBe(3);
    // The full byte, which in 1.4 is a real class number above 31.
    expect(at("classification", 0)).toBe(200);
    expect(at("return number", 1)).toBe(1);
    expect(at("scanner channel", 1)).toBe(0);
  });

  it("packs a wide scalar into f32 and carries the inverse", () => {
    const data = decode({
      ...BASE,
      attributes: ["gps-time"],
      scalarFormat: "gpu",
    });
    const gps = data.attributesByName.get("gps-time")!;
    expect(gps.array).toBeInstanceOf(Float32Array);
    // (150 - 100) / 100.
    expect(gps.array[0]).toBeCloseTo(0.5, 6);
    expect(gps.array[1]).toBeCloseTo(1, 6);
    // Recoverable: array * inverse.scale + inverse.offset.
    expect(gps.array[0]! * gps.inverse!.scale + gps.inverse!.offset).toBeCloseTo(
      150,
      4,
    );
  });

  it("takes the signed lane for an unsigned type declaring a negative min", () => {
    // A real stock output: PotreeConverter ships "scan angle rank" as uint8
    // with min -21, and its raw bytes really are two's-complement.
    const layout = lasLayout({ format: 1, pointSize: 28, bounds: box() });
    const bytes = new Uint8Array(28);
    new DataView(bytes.buffer).setInt8(16, -30);
    const plan = createLasDecodePlan(layout, {
      ...BASE,
      attributes: ["scan angle rank"],
      scalarFormat: "gpu",
    });
    const data = decodeLasRecords(plan, { ...NODE, numPoints: 1 }, bytes);
    const angle = data.attributesByName.get("scan angle rank")!;
    expect(angle.array).toBeInstanceOf(Int32Array);
    expect(angle.array[0]).toBe(-30);
  });

  it("refuses a buffer shorter than the point count claims", () => {
    const layout = lasLayout({ format: 6, pointSize: 30, bounds: box() });
    const plan = createLasDecodePlan(layout, { ...BASE });
    expect(() =>
      decodeLasRecords(plan, { ...NODE, numPoints: 10 }, new Uint8Array(60)),
    ).toThrow(/only 60 bytes/);
  });

  it("refuses an attribute the record does not have", () => {
    const layout = lasLayout({ format: 6, pointSize: 30, bounds: box() });
    expect(() =>
      createLasDecodePlan(layout, { ...BASE, attributes: ["intensty"] }),
    ).toThrow(/no attribute named "intensty"/);
  });

  it("computes bounds from the data, not from the node box", () => {
    const data = decode({ ...BASE, computeBounds: true });
    // min x is -1000 * 0.01 + 10 = 0, max is 1000 * 0.01 + 10 = 20.
    expect(data.bounds!.min[0]).toBeCloseTo(0, 6);
    expect(data.bounds!.max[0]).toBeCloseTo(20, 6);
    expect(decode({ ...BASE }).bounds).toBeUndefined();
  });

  it("lists every output buffer exactly once for a worker transfer", () => {
    const data = decode({ ...BASE, attributes: ["intensity", "classification"] });
    const buffers = [
      data.positions.buffer,
      ...data.attributes.map((a) => a.array.buffer),
    ];
    expect(new Set(data.transferList).size).toBe(data.transferList.length);
    for (const b of buffers) expect(data.transferList).toContain(b);
    expect(data.byteLength).toBe(
      data.transferList.reduce((n, b) => n + b.byteLength, 0),
    );
  });
});

describe("decodeLasRecords: narrowing 16-bit colour to bytes", () => {
  // Point formats 7 and 8 DECLARE 0..65535 for colour because the format says
  // so, not because the file was read — `lasDimensions` synthesises that range
  // from the format number. So the declared max is not evidence of anything,
  // and a blind `>>> 8` renders every 8-bit-in-a-16-bit-field producer solid
  // black while merely dimming everything that peaks below 65535. The decoder
  // scans instead, and settles the narrowing once for the whole cloud.
  const RGB_AT = 30;
  const SIZE = 36;

  const OPTIONS = {
    scale: [0.01, 0.01, 0.01],
    offset: [0, 0, 0],
    cloudOrigin: [0, 0, 0],
  } as const;

  /** A format 7 node carrying nothing but the colours under test. */
  function node(colors: readonly (readonly [number, number, number])[]): Uint8Array {
    const bytes = new Uint8Array(SIZE * colors.length);
    const view = new DataView(bytes.buffer);
    colors.forEach((rgb, i) => {
      for (let c = 0; c < 3; c++) {
        view.setUint16(i * SIZE + RGB_AT + c * 2, rgb[c]!, true);
      }
    });
    return bytes;
  }

  function planFor(options: Record<string, unknown> = {}) {
    return createLasDecodePlan(
      lasLayout({ format: 7, pointSize: SIZE, bounds: box() }),
      { ...OPTIONS, ...options } as Parameters<typeof createLasDecodePlan>[1],
    );
  }

  function decode(
    plan: ReturnType<typeof planFor>,
    colors: readonly (readonly [number, number, number])[],
  ) {
    return decodeLasRecords(
      plan,
      { ...NODE, numPoints: colors.length },
      node(colors),
    );
  }

  /** The red channel of each point, which is all these cases vary. */
  const reds = (data: ReturnType<typeof decode>, n: number): number[] =>
    Array.from({ length: n }, (_, i) => data.colors!.array[4 * i]!);

  it("passes 8-bit values through a field that declares 16", () => {
    // The case that rendered black: a producer writing 0..255 into the u16
    // colour of a format 7 file. Nothing here may be shifted.
    const data = decode(planFor(), [
      [10, 10, 10],
      [200, 200, 200],
      [255, 255, 255],
    ]);
    expect(reds(data, 3)).toEqual([10, 200, 255]);
  });

  it("scales by the widest value present, not by the declared one", () => {
    // A survey peaking at 8000. `>>> 8` would put its brightest point at 31 —
    // eight times too dark — because the shift assumes a full 16-bit span.
    const data = decode(planFor(), [
      [8000, 8000, 8000],
      [4000, 4000, 4000],
      [0, 0, 0],
    ]);
    expect(reds(data, 3)).toEqual([255, 128, 0]);
  });

  it("agrees with a plain shift when the file really does span 16 bits", () => {
    // The case the shift was written for must not regress: widest 65535 makes
    // the scale 255/65535, which is `>>> 8` to within the rounding.
    const data = decode(planFor(), [
      [65535, 65535, 65535],
      [32768, 32768, 32768],
      [256, 256, 256],
    ]);
    expect(reds(data, 3)).toEqual([255, 128, 1]);
  });

  it("settles once for the cloud, so two nodes cannot disagree", () => {
    // Per-node narrowing would make a dim tile brighter than a bright one and
    // put a visible seam down the middle of a survey. The second node here
    // holds only dark points and must stay dark on the first node's scale.
    const plan = planFor();
    expect(reds(decode(plan, [[8000, 8000, 8000]]), 1)).toEqual([255]);
    expect(reds(decode(plan, [[100, 100, 100]]), 1)).toEqual([3]);
  });

  it("lets a node too small to be representative decide nothing", () => {
    // Three dark points are not proof the cloud is 8-bit, so the decision stays
    // open and the next node still gets to make it.
    const plan = planFor();
    expect(reds(decode(plan, [[10, 10, 10]]), 1)).toEqual([10]);
    expect(reds(decode(plan, [[60000, 60000, 60000]]), 1)).toEqual([255]);
  });

  it("closes the decision on a node large enough to be evidence", () => {
    // 1024 points that never break 255 IS evidence, and the cloud is 8-bit.
    // Without this the scan re-runs on every node for the whole load.
    const plan = planFor();
    const many = Array.from({ length: 1024 }, () => [12, 12, 12] as const);
    expect(reds(decode(plan, many), 1)).toEqual([12]);
    // A later point above the settled range saturates. It must NOT wrap: a
    // Uint8Array takes 60000 to 96 on its own, which is a mid grey where the
    // brightest point in the file should be.
    expect(reds(decode(plan, [[60000, 60000, 60000]]), 1)).toEqual([255]);
  });

  it("leaves native colour alone — there is nothing to narrow", () => {
    const data = decode(planFor({ colorFormat: "native" }), [
      [8000, 8000, 8000],
      [65535, 65535, 65535],
    ]);
    expect(reds(data, 2)).toEqual([8000, 65535]);
  });
});
