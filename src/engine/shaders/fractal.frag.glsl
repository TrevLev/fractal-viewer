#version 300 es
precision highp float;

uniform vec2      uResolution;   // drawing-buffer size in pixels
uniform float     uScaleM;       // view scale mantissa  (scale = uScaleM · 2^uScaleE)
uniform int       uScaleE;       // view scale exponent
uniform int       uMaxIter;
uniform sampler2D uRefTex;       // reference orbit: RG = (Zx, Zy) per iteration
uniform int       uRefLen;
uniform int       uRefTexWidth;

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

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  // δc = uv · scale, as floatexp. uv·mantissa is O(1); the deep magnitude rides
  // entirely in the exponent, so it never underflows the way uv·scale (f32) did.
  FE dc = fe_norm(uv * uScaleM, uScaleE);

  FE   dz = FE(vec2(0.0), 0);   // δz = z − Z_m
  int  m  = 0;
  bool  escaped = false;
  float sIter   = 0.0;

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

    if (zz > 65536.0) {                  // bailout |z| > 256
      sIter = float(n + 1) - log2(log2(zz)) + 4.0;
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
    float t = sIter * 0.15;
    col = 0.5 + 0.5 * cos(3.0 + t + vec3(0.0, 0.6, 1.0));
  }
  fragColor = vec4(col, 1.0);
}
