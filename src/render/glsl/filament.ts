/**
 * FILAMENT — a thin luminous connection between two points.
 *
 * A screen-space ribbon (never GL_LINES): geometry carries only (t, side); the vertex shader
 * evaluates the strand — catenary sag from slack, string modes pinned at both ends, a
 * travelling wave — and extrudes it perpendicular to its projected tangent, so it always
 * faces the camera and keeps a controlled width in pixels.
 *
 * Fragment: a fine bright core (≈ 1.5 css px) inside a faint glass rod (brighter toward its
 * walls, cool on one side and warm on the other as bridge.spectral rises), beads of energy
 * travelling from A to B, brightness falling gently with distance. reveal draws it from A to B.
 *
 * Output: PREMULTIPLIED alpha (NormalBlending, premultipliedAlpha = true), depthWrite off.
 * Almost purely emissive: alpha is small, so it never darkens what it crosses.
 */
import { SHARED } from './common';

export const FILAMENT_VERT = /* glsl */ `
${SHARED}
uniform vec3 uA;
uniform vec3 uB;
uniform float uReveal;
uniform float uEnergy;
uniform float uTension;
uniform float uSeed;
varying vec4 vRib;   // x across -1..1, y along 0..1, z half width (device px), w distance brightness
varying float vLen;

vec3 strand(float t, vec3 side, vec3 lift, float len) {
  float slack = 1.0 - uTension;
  vec3 p = mix(uA, uB, t);
  p.y -= 4.0 * t * (1.0 - t) * len * 0.14 * slack * slack;
  float pin = sin(PI * clamp(t, 0.0, 1.0));
  float ph = uSeed * TAU;
  float amp = len * (0.003 + 0.013 * uEnergy) * (0.35 + 0.65 * slack);
  float a1 = sin(TAU * t) * cos(uTime * 2.3 + ph) + 0.6 * sin(3.0 * PI * t) * cos(uTime * 3.7 + ph * 1.7);
  float a2 = sin(3.0 * PI * t) * sin(uTime * 2.9 + ph * 0.6) + 0.5 * sin(5.0 * PI * t) * cos(uTime * 4.9 + ph);
  float run = t * len * 5.0 - uTime * 3.4 + ph;
  p += side * (amp * (a1 + 0.5 * pin * sin(run)));
  p += lift * (amp * (a2 + 0.5 * pin * cos(run)));
  return p;
}

void main() {
  float t = position.x;
  vec3 ab = uB - uA;
  float len = max(length(ab), 1e-4);
  vec3 dir = ab / len;
  vec3 up = abs(dir.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(dir, up));
  vec3 lift = cross(side, dir);

  vec3 p0 = strand(t, side, lift, len);
  vec3 p1 = strand(t + 0.01, side, lift, len);
  vec4 c0 = projectionMatrix * viewMatrix * vec4(p0, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * vec4(p1, 1.0);

  vec2 halfPx = uViewport.xy * uViewport.z * 0.5;
  vec2 tang = c1.xy / max(c1.w, 1e-4) * halfPx - c0.xy / max(c0.w, 1e-4) * halfPx;
  float tl = length(tang);
  tang = tl > 1e-5 ? tang / tl : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tang.y, tang.x);

  float dist = length(uCamPos - p0);
  float pxPerUnit = projectionMatrix[1][1] * halfPx.y / max(dist, 0.05);
  float halfW = clamp(0.022 * pxPerUnit, 3.0 * uViewport.z, 11.0 * uViewport.z);
  c0.xy += nrm * (position.y * halfW) / halfPx * c0.w;

  vRib = vec4(position.y, t, halfW, 1.0 / (1.0 + dist * dist / 196.0));
  vLen = len;
  gl_Position = (uReveal * uState.y > 0.0015) ? c0 : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const FILAMENT_FRAG = /* glsl */ `
${SHARED}
uniform float uReveal;
uniform float uEnergy;
uniform float uWarmth;
uniform float uSeed;
varying vec4 vRib;
varying float vLen;

void main() {
  float t = vRib.y;
  float halfW = vRib.z;
  float pr = uViewport.z;
  float ax = abs(vRib.x) * halfW;                       // device px from the centre line
  float u = ax / halfW;

  float core = exp(-(ax * ax) / (0.56 * pr * pr));
  float rod = 1.0 - smoothstep(halfW - 1.5 * pr, halfW, ax);
  float wall = u * u * u * u * rod;

  // energy travelling from A to B, over a slower swell
  float ph = uSeed * TAU;
  float beads = pow(0.5 + 0.5 * sin(t * vLen * 7.0 - uTime * 3.1 + ph), 8.0);
  float swell = 0.5 + 0.5 * sin(t * vLen * 1.9 - uTime * 0.9 + ph * 2.3);
  float flow = uEnergy * (0.45 * swell + 0.75 * beads);

  // reveal: drawn from A toward B, with a brighter head while it grows
  float tip = uReveal * 1.06;
  float vis = 1.0 - smoothstep(tip - 0.06, tip, t);
  float head = exp(-pow((t - tip + 0.05) / 0.04, 2.0)) * (1.0 - smoothstep(0.85, 1.0, uReveal));
  float taper = smoothstep(0.0, 0.025, t) * smoothstep(0.0, 0.025, 1.0 - t);

  float spectral = uState.z;
  vec3 ivory = mix(vec3(0.9, 0.96, 1.06), vec3(1.06, 0.98, 0.88), uWarmth * 0.5 + 0.5);
  vec3 fringe = mix(vec3(0.5, 0.72, 1.1), vec3(1.1, 0.8, 0.5), vRib.x * 0.5 + 0.5);
  fringe = mix(vec3(0.82, 0.84, 0.86), fringe, 0.2 + 0.8 * spectral);

  float coreI = (0.3 + 0.55 * uEnergy + 0.9 * flow + 1.2 * head) * 1.15;
  float rodI = 0.035 + 0.1 * uEnergy + 0.25 * flow + 0.3 * head;

  vec3 rgb = ivory * (core * coreI) + fringe * ((0.18 * rod + wall) * rodI);
  float a = core * 0.4 + wall * 0.06;

  float ext = 1.0 - smoothstep(0.5, 1.0, uState.w);
  float m = vis * taper * uState.y * ext * (0.35 + 0.65 * vRib.w);
  gl_FragColor = vec4(rgb * m, a * m);
}
`;
