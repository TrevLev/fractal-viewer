#version 300 es
precision highp float;

uniform vec2      uResolution;   // drawing-buffer size in pixels
uniform float     uScale;        // vertical extent of the view, in complex units
uniform int       uMaxIter;
uniform sampler2D uRefTex;       // reference orbit: RG = (Zx, Zy) per iteration
uniform int       uRefLen;       // number of valid reference points
uniform int       uRefTexWidth;  // width of the reference texture, for indexing

out vec4 fragColor;

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Fetch reference orbit point Z_m from the texture (nearest, no filtering).
vec2 fetchRef(int m) {
  int x = m % uRefTexWidth;
  int y = m / uRefTexWidth;
  return texelFetch(uRefTex, ivec2(x, y), 0).xy;
}

void main() {
  // The pixel's offset from the reference point C (= screen center), in complex
  // units. This is the ONLY coordinate the GPU sees — it stays small, so f32
  // keeps full relative precision long after a direct c = center + uv*scale
  // would have collapsed into blocky pixelation.
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec2 dc = uv * uScale;

  vec2 dz = vec2(0.0);   // δz = z - Z_m, the perturbation
  int  m  = 0;           // index into the reference orbit
  bool  escaped = false;
  float sIter   = 0.0;

  for (int n = 0; n < uMaxIter; n++) {
    vec2 Zm = fetchRef(m);
    // δz_{m+1} = 2·Z_m·δz + δz² + δc
    dz = cmul(2.0 * Zm, dz) + cmul(dz, dz) + dc;
    m += 1;

    vec2 Zm1 = fetchRef(m);
    vec2 z = Zm1 + dz;             // reconstruct the full orbit value
    float zz = dot(z, z);

    if (zz > 65536.0) {           // bailout |z| > 256
      sIter = float(n) - log2(log2(zz)) + 4.0;
      escaped = true;
      break;
    }

    // Rebasing (Zhuoran): when the orbit value drops below the perturbation, or
    // we reach the end of the reference, re-express z relative to Z_0 = 0. This
    // is exact (Z_0 = 0, so δz becomes z) and keeps δz small — which is what
    // prevents glitch blobs in deep, minibrot-rich regions.
    if (zz < dot(dz, dz) || m >= uRefLen - 1) {
      dz = z;
      m = 0;
    }
  }

  vec3 col;
  if (!escaped) {
    col = vec3(0.0);
  } else {
    float t = sIter * 0.15;
    col = 0.5 + 0.5 * cos(3.0 + t + vec3(0.0, 0.6, 1.0));
  }
  fragColor = vec4(col, 1.0);
}
