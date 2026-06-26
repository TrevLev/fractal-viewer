#version 300 es
precision highp float;

uniform vec2  uResolution;  // drawing-buffer size in pixels
uniform vec2  uCenter;      // view center in the complex plane
uniform float uScale;       // vertical extent of the view, in complex units
uniform int   uMaxIter;     // escape-time iteration cap

out vec4 fragColor;

void main() {
  // Pixel -> complex plane. Normalize by height so pixels stay square
  // regardless of the canvas aspect ratio.
  //
  // NOTE: this mapping is where double-float emulation will eventually go for
  // deep zoom — 32-bit float runs out of precision around 1e5–1e6x.
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec2 c  = uCenter + uv * uScale;

  vec2  z = vec2(0.0);
  float B = 256.0;       // bailout radius (large -> smoother coloring)
  bool  escaped = false;
  float sIter   = 0.0;   // smooth (continuous) iteration count

  for (int i = 0; i < uMaxIter; i++) {
    // The whole fractal family lives on this one line:
    //   Mandelbrot:    z = z^2 + c
    //   Burning Ship:  z = abs(z)^2 + c
    //   Julia:         z = z^2 + k   (c fixed, z starts at the pixel)
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

    if (dot(z, z) > B * B) {
      // Continuous iteration count removes integer "banding" so the gradient
      // is smooth. At escape, dot(z,z) ~ B^2, so the +4.0 cancels the offset.
      sIter   = float(i) - log2(log2(dot(z, z))) + 4.0;
      escaped = true;
      break;
    }
  }

  vec3 col;
  if (!escaped) {
    col = vec3(0.0);                                   // inside the set
  } else {
    // Cosine palette over the smooth iteration count. This block is your
    // swappable "coloring method" once you add more.
    float t = sIter * 0.15;
    col = 0.5 + 0.5 * cos(3.0 + t + vec3(0.0, 0.6, 1.0));
  }

  fragColor = vec4(col, 1.0);
}
