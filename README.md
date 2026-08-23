# @voxelkloud/format-las

The LAS point record, shared. Part of [voxelkloud](../../README.md).

```sh
npm install @voxelkloud/format-las
```

**Not a driver.** Three of them stand on it: a COPC node is a LAS 1.4 record, an
EPT `laszip` node is a whole LAS file, and the single-file tier is a `.las` or
`.laz` outright. The record layout is fixed by the spec and identical in all
three, so it is stated once here rather than three times with two of them
subtly wrong.

What is here:

- **the dimension layout for point formats 0–10** — where each field sits, how
  wide it is, and which of them are bit runs sharing a byte.
- **the Extra Bytes VLR** (`LASF_Spec`, record 4), so a custom dimension is a
  named attribute instead of four unreadable bytes.
- **the decode** into the neutral `DecodedPointData` from
  [`@voxelkloud/core`](../core/): relative float32 positions with the origin
  carried as data, colour repacked to RGBA with a once-per-source narrowing,
  and 4-byte GPU lanes for scalars.

```ts
import { createLasDecodePlan, decodeLasRecords, lasLayout } from "@voxelkloud/format-las";

const layout = lasLayout({ format: 7, pointSize: 40, extraBytes, bounds });
const plan = createLasDecodePlan(layout, { scale, offset, cloudOrigin });
const data = decodeLasRecords(plan, node, rawRecords);
```

## Two decisions worth knowing

**The names are PotreeConverter's.** `"position"`, `"intensity"`,
`"return number"`, `"scan angle rank"`, `"gps-time"`, `"rgb"` — not the LAS
spec's CamelCase. A colour mode that keys off `"classification"` has to work on
a COPC cloud and a Potree cloud without the renderer knowing which it got, and
Potree shipped first.

**Bit runs come apart.** LAS packs the return number, the number of returns, the
classification flags and the scanner channel into shared bytes. Every writer in
this space presents them as separate dimensions, and so does this: a
`{ kind: "bits", at, shift, width }` accessor alongside the plain offsets.

The decode makes the same choices as Potree's DEFAULT decoder field for field —
the same output kinds, the same GPU lanes, the same colour narrowing decided
once from the declared max rather than per value. Two drivers that disagreed
about any of those would render the same LiDAR two different ways.

Wave packet fields (formats 4, 5, 9, 10) are deliberately absent. Their bytes
are still counted in the stride, so nothing is misaligned by leaving them out —
only unavailable.

MIT.
