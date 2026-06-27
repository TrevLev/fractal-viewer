// Arbitrary-precision real numbers as BigInt fixed-point: a value is stored as
// an integer mantissa with an implicit scale of 2^-FRAC. Addition is exact
// (just add the BigInts); multiplication shifts back down by FRAC. This is the
// CPU-side precision that lets the reference orbit be computed correctly far
// deeper than f64 (~1e-15) could ever reach.
//
// FRAC = 256 fractional bits ≈ 77 decimal digits — comfortably more than the
// GPU's f32 deltas can exploit (they underflow around 1e-38), so the reference
// is never the limiting factor at the depths this engine currently supports.

const FRAC = 256n;
const TWO_POW_FRAC = 2 ** 256; // exact as an IEEE-754 double (256 < 1024)

/** Convert a JS number to fixed-point, preserving its bits at its own scale. */
export function fromNumber(x: number): bigint {
  if (!Number.isFinite(x) || x === 0) return 0n;
  // x * 2^FRAC lands x's 53 mantissa bits at the correct magnitude; rounding
  // to an integer and widening to BigInt keeps exactly those bits. Adding such
  // a value to a wider fixed-point accumulator is then exact.
  return BigInt(Math.round(x * TWO_POW_FRAC));
}

/** Convert fixed-point back to the nearest JS number (used for O(1) values). */
export function toNumber(a: bigint): number {
  return Number(a) / TWO_POW_FRAC;
}

/** Fixed-point multiply: (a * b) >> FRAC. Floor bias is < 2^-256, negligible. */
function mul(a: bigint, b: bigint): bigint {
  return (a * b) >> FRAC;
}

/**
 * Format a fixed-point value (value = a · 2^-FRAC) as a decimal string with
 * `decimals` digits after the point, rounded half-up. This is what lets a
 * read-out show a deep-zoom coordinate to its true precision instead of
 * collapsing it to an f64 (~16 digits) right when the extra digits are the
 * only thing locating you. (FRAC = 256 bits ≈ 77 meaningful decimal digits.)
 */
export function toDecimalString(a: bigint, decimals: number): string {
  const neg = a < 0n;
  const x = neg ? -a : a;
  const pow10 = 10n ** BigInt(decimals);
  const half = 1n << (FRAC - 1n);
  const scaled = (x * pow10 + half) >> FRAC; // round(value · 10^decimals)
  const sign = neg && scaled !== 0n ? '-' : '';
  if (decimals === 0) return `${sign}${scaled}`;
  const s = scaled.toString().padStart(decimals + 1, '0');
  const cut = s.length - decimals;
  return `${sign}${s.slice(0, cut)}.${s.slice(cut)}`;
}

export interface ReferenceOrbit {
  /** Flat [Zx0, Zy0, Zx1, Zy1, …] in f32-range values, one pair per iteration. */
  data: Float32Array;
  /** Number of orbit points stored. */
  length: number;
}

/**
 * Compute the reference orbit Z_{n+1} = Z_n² + C (Z_0 = 0) at high precision,
 * storing each point as ordinary (f32-range) numbers for the GPU. The orbit
 * values are O(1), so storing them in low precision is fine — it's the
 * *trajectory* that needs high precision, and that's done here in BigInt.
 */
export function computeReferenceOrbit(
  cr: bigint,
  ci: bigint,
  maxIter: number,
): ReferenceOrbit {
  const data = new Float32Array(maxIter * 2);
  let zr = 0n;
  let zi = 0n;
  let n = 0;
  for (; n < maxIter; n++) {
    const zrd = toNumber(zr);
    const zid = toNumber(zi);
    data[n * 2] = zrd;
    data[n * 2 + 1] = zid;
    // Reference escape radius (1e3) sits above the pixel bailout (256), so the
    // stored orbit is long enough to cover pixels before they escape.
    if (zrd * zrd + zid * zid > 1e6) {
      n++;
      break;
    }
    // Z = Z² + C
    const nzr = mul(zr, zr) - mul(zi, zi) + cr;
    const nzi = 2n * mul(zr, zi) + ci;
    zr = nzr;
    zi = nzi;
  }
  return { data: data.subarray(0, n * 2), length: n };
}