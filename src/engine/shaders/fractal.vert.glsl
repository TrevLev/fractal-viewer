#version 300 es

// Emits a single full-screen triangle from gl_VertexID alone — no vertex
// buffer needed. VertexIDs 0,1,2 map to clip-space (-1,-1), (3,-1), (-1,3),
// which more than covers the viewport. The fragment shader does all the work.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
