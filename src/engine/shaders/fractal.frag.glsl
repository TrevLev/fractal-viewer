#version 300 es
precision highp float;

uniform vec2      uResolution;   // drawing-buffer size in pixels
uniform float     uScaleM;       // view scale mantissa  (scale = uScaleM · 2^uScaleE)
uniform int       uScaleE;       // view scale exponent
uniform int       uMaxIter;
uniform sampler2D uRefTex;       // reference orbit: RG = (Zx, Zy) per iteration
uniform int       uRefLen;
uniform int       uRefTexWidth;

uniform int   uColorMode;  // 0 = smooth iter, 1 = escape angle, 2 = stripe average
uniform int   uPalette;    // palette index (see paletteColor)
uniform float uCycle;      // gradient frequency
uniform float uOffset;     // palette phase, in turns
uniform float uStripe;     // stripe density (mode 2 only)

out vec4 fragColor;

// ---------------------------------------------------------------------------
// "floatexp" complex number: value = m · 2^e, a shared integer exponent for the
// (real, imaginary) pair. Plain f32 underflows around 1e-38; carrying the
// exponent in a full int lets the per-pixel deltas shrink as deep as the zoom
// demands without collapsing to zero — the collapse is what produced the
// crosshair (and, when total, the solid screen).
//
// NOTE: this uses only exp2()/log2(), deliberately NOT frexp()/ldexp(). Those
// are spec'd in GLSL ES 3.00 but unreliable across WebGL2/ANGLE backends, and
// were the most likely reason the earlier floatexp attempt rendered one color.
// The mantissa is always renormalized to O(1), so every exp2 shift here is
// either small or a *correct* underflow of a genuinely negligible term.
// ---------------------------------------------------------------------------
struct FE { vec2 m; int e; };

FE fe_norm(vec2 m, int e) {
  float a = max(abs(m.x), abs(m.y));
  if (a == 0.0) return FE(vec2(0.0), 0);
  int p = int(floor(log2(a)));            // a ≈ 2^p  ->  m·2^-p lands in [1, 2)
  return FE(m * exp2(float(-p)), e + p);
}

FE   fe_fromF32(vec2 v) { return fe_norm(v, 0); }
vec2 fe_toF32(FE a)     { return a.m * exp2(float(a.e)); } // 0 when tiny — correct

FE fe_add(FE a, FE b) {
  // A zero operand's exponent is meaningless; short-circuit so it can't drag
  // the other operand into a bogus alignment shift.
  if (a.m.x == 0.0 && a.m.y == 0.0) return b;
  if (b.m.x == 0.0 && b.m.y == 0.0) return a;
  // Align the smaller-exponent operand down. Its mantissa underflows to 0 only
  // when it is genuinely negligible against the larger term.
  if (a.e >= b.e) return fe_norm(a.m + b.m * exp2(float(b.e - a.e)), a.e);
  else            return fe_norm(a.m * exp2(float(a.e - b.e)) + b.m, b.e);
}

FE fe_cmul(FE a, FE b) {
  vec2 m = vec2(a.m.x * b.m.x - a.m.y * b.m.y,
                a.m.x * b.m.y + a.m.y * b.m.x);
  return fe_norm(m, a.e + b.e);
}

vec2 fetchRef(int i) {
  return texelFetch(uRefTex, ivec2(i % uRefTexWidth, i / uRefTexWidth), 0).xy;
}

const float TAU = 6.2831853;

// Cosine palette (Inigo Quilez style): a per-channel phase selects the palette;
// `x` is the final argument in radians. Palette 0 reproduces the original look.
vec3 paletteColor(float x, int pal) {
  vec3 ph;
  if (pal == 1)      ph = vec3(0.0, 0.8, 1.6);   // ember  (warm)
  else if (pal == 2) ph = vec3(4.0, 4.6, 5.4);   // ice    (cool)
  else if (pal == 3) ph = vec3(0.0, 0.0, 0.0);   // mono   (grayscale)
  else               ph = vec3(0.0, 0.6, 1.0);   // spectrum (default)
  return 0.5 + 0.5 * cos(x + ph);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  // δc = uv · scale, as floatexp. uv·mantissa is O(1); the deep magnitude rides
  // entirely in the exponent, so it never underflows the way uv·scale (f32) did.
  FE dc = fe_norm(uv * uScaleM, uScaleE);

  FE   dz = FE(vec2(0.0), 0);   // δz = z − Z_m
  int  m  = 0;
  bool  escaped = false;
  float sIter   = 0.0;
  vec2  zEsc    = vec2(0.0);    // full z at escape (for angle coloring)

  // Stripe-average accumulators (mode 2): running mean of a sine of the orbit
  // angle. We keep the previous sum too, to interpolate across the escape using
  // the same fractional iteration that smooths the count — otherwise it bands.
  float stripeSum  = 0.0;
  float stripePrev = 0.0;
  int   stripeN    = 0;

  for (int n = 0; n < uMaxIter; n++) {
    vec2 Z = fetchRef(m);
    // δz = 2·Z·δz + δz² + δc
    dz = fe_add(fe_add(fe_cmul(fe_fromF32(2.0 * Z), dz), fe_cmul(dz, dz)), dc);
    m += 1;

    // Full orbit value z = Z_{m} + δz, kept in floatexp so the rebase below
    // can't lose a still-tiny δz to an f32 round-off.
    FE    zFE = fe_add(fe_fromF32(fetchRef(m)), dz);
    vec2  z   = fe_toF32(zFE);
    float zz  = dot(z, z);

    // Accumulate the stripe term from the full orbit point (guarded at 0).
    float ang = zz > 1e-20 ? atan(z.y, z.x) : 0.0;
    stripePrev = stripeSum;
    stripeSum += 0.5 + 0.5 * sin(uStripe * ang);
    stripeN   += 1;

    if (zz > 65536.0) {                  // bailout |z| > 256
      sIter = float(n + 1) - log2(log2(zz)) + 4.0;
      zEsc  = z;
      escaped = true;
      break;
    }

    // Rebase (Zhuoran): when the orbit drops below the delta, or we reach the
    // end of the reference, restart against Z_0 = 0 with δz := z (kept exact).
    vec2 dzf = fe_toF32(dz);
    if (zz < dot(dzf, dzf) || m >= uRefLen - 1) {
      dz = zFE;
      m  = 0;
    }
  }

  vec3 col;
  if (!escaped) {
    col = vec3(0.0);                                    // inside the set
  } else {
    // A method-specific scalar, in "natural" units; uCycle then sets how fast
    // the palette runs over it. The 50× on the bounded modes just brings their
    // [0,1] range up to where uCycle behaves like it does for the iter count.
    float natural;
    if (uColorMode == 1) {
      natural = (0.5 + 0.5 * atan(zEsc.y, zEsc.x) / 3.14159265) * 50.0;
    } else if (uColorMode == 2) {
      float frac  = fract(sIter);
      float avgN  = stripeSum / float(stripeN);
      float avgNm = stripeN > 1 ? stripePrev / float(stripeN - 1) : avgN;
      natural = mix(avgNm, avgN, frac) * 50.0;
    } else {
      natural = sIter;                                 // smooth iteration count
    }
    float arg = uCycle * natural + TAU * uOffset;
    col = paletteColor(arg, uPalette);
  }
  fragColor = vec4(col, 1.0);
}
