// Arbitrary-precision real numbers as BigInt fixed-point: a value is stored as
// an integer mantissa with an implicit scale of 2^-FRAC. Addition is exact
// (just add the BigInts); multiplication shifts back down by FRAC. This is the
// CPU-side precision behind the reference orbit AND the precision of the view
// center — so it sets how deep you can *navigate*, not just render.
//
// FRAC = 1024 fractional bits ≈ 308 decimal digits. The center's resolution is
// 1 ULP = 2^-1024 ≈ 5.6e-309; panning works until a one-pixel step (≈ scale /
// height) drops below that, i.e. to roughly 1e-305. (At FRAC=256 that wall was
// ~1e-77, where sub-ULP pan steps rounded to zero and pinned the view.)
//
// fromNumber/toNumber are written to be valid for ANY FRAC — they never form
// 2^FRAC as a double (which overflows to Infinity past 1023 bits).

const FRAC = 1024n;
const TWO_POW_53 = 9007199254740992; // 2^53

interface Frexp {
  /** Significand in [0.5, 1) (sign-carrying), so x = mantissa · 2^exponent. */
  mantissa: number;
  exponent: number;
}

/**
 * Decompose a double into significand · 2^exponent (significand in [0.5, 1)).
 * Used both by fromNumber and to hand `scale` to the shader as a mantissa+
 * exponent pair so a deep (sub-1e-38) scale survives the trip to the GPU.
 */
export function frexp(x: number): Frexp {
  if (x === 0 || !Number.isFinite(x)) return { mantissa: x, exponent: 0 };
  let e = Math.ceil(Math.log2(Math.abs(x)));
  let m = x / 2 ** e;
  // log2 rounding can be off by one either way — clamp into [0.5, 1).
  while (Math.abs(m) >= 1) { m /= 2; e += 1; }
  while (Math.abs(m) < 0.5) { m *= 2; e -= 1; }
  return { mantissa: m, exponent: e };
}

/** Convert a double to fixed-point exactly, valid for any FRAC (no 2^FRAC overflow). */
export function fromNumber(x: number): bigint {
  if (x === 0 || !Number.isFinite(x)) return 0n;
  const { mantissa, exponent } = frexp(x);
  const mInt = BigInt(Math.round(mantissa * TWO_POW_53)); // 53-bit integer
  const shift = BigInt(exponent - 53) + FRAC;             // place at value·2^FRAC
  return shift >= 0n ? mInt << shift : mInt >> -shift;
}

/** Convert fixed-point back to the nearest double (for O(1) magnitudes). */
export function toNumber(a: bigint): number {
  if (a === 0n) return 0;
  const scaled = a >> (FRAC - 53n); // ≈ value · 2^53, fits a double after Number()
  return Number(scaled) / TWO_POW_53;
}

/** Fixed-point multiply: (a · b) >> FRAC. */
function mul(a: bigint, b: bigint): bigint {
  return (a * b) >> FRAC;
}

/**
 * Format a fixed-point value (value = a · 2^-FRAC) as a decimal string with
 * `decimals` digits after the point, rounded half-up. This is what lets a
 * read-out show a deep-zoom coordinate to its true precision instead of
 * collapsing it to an f64 (~16 digits) right when the extra digits are the
 * only thing locating you.
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

/**
 * Parse a decimal string into fixed-point — the inverse of toDecimalString.
 * Accepts an optional sign, a decimal point, and optional scientific exponent
 * ("-0.7436…", "1.25e-7"). This is what lets a deep-zoom coordinate be typed
 * (or pasted) back in at full precision instead of being clamped to f64.
 * Throws on malformed input so callers can reject it rather than navigate to 0.
 */
export function fromDecimalString(s: string): bigint {
  const str = s.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new Error(`Invalid number: "${s}"`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  const exp = m[4] ? parseInt(m[4], 10) : 0;

  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '') || '0';
  const n = BigInt(digits);            // unsigned magnitude, all digits
  const pow10 = exp - fracPart.length; // value = n · 10^pow10
  const scaled = n << FRAC;            // n · 2^FRAC

  let mag: bigint;
  if (pow10 >= 0) {
    mag = scaled * 10n ** BigInt(pow10);
  } else {
    const den = 10n ** BigInt(-pow10);
    mag = (scaled + den / 2n) / den;   // round half up
  }
  return sign * mag;
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