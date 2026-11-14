/**
 * RESONANT MATTER — the signature material.
 *
 * One tessellated surface drawn as N instanced lamellae (gl_InstanceID = layer; instance 0 is
 * the base sheet, drawn first and furthest from the eye).
 *
 * Vertex
 *   - Displaces the surface along its normal by the superposed wave field of the bridge sources
 *     (+ the object's own standing mode, + slack noise, + strike wavefronts, + the excite ripple,
 *     + the hover lean), with the ANALYTIC gradient for the normal — twice: the full gradient
 *     (highlights) and a low-passed one in which the high partials are rolled off (refraction),
 *     so colour arrives in broad calm pools while the sheen keeps the fine ripple.
 *   - Offsets each lamella along that normal. The fan opens with harmonic complexity and with
 *     the local interference envelope, and its analytic gradient is passed on so that every
 *     lamella leans a little more than the one beneath it. Lamellae beyond the open part of the
 *     fan are not drawn at all: one pitch is one barely-there sheet.
 *   - Low coherence: strips whose slits are open tear loose and drift.
 *
 * Fragment: clear-glass optics against the procedural studio (./env.ts).
 *   - Open sheets are optically absent where undisturbed: only the wave-borne tilt of the normal
 *     bends light, so colour pools on slopes and flat regions stay black. Closed bodies refract
 *     with their true normal (uOptic).
 *   - Refraction (IOR 1.45; per-channel dispersion grows with bridge.spectral, none on LITE),
 *     Schlick Fresnel, absorption along the path, a restrained two-tone thin film, and a
 *     flow-aligned anisotropic sheen (streaks that run along the wave crests, like silk).
 *   - Cut edges. An open sheet never shows its geometric border: every lamella is cut along its
 *     own long flowing curves, evaluated ANALYTICALLY per fragment in sheet space (so they are
 *     smooth whatever the tessellation), each lamella a little inside the one beneath it — a
 *     terraced stack, like the edge of a pile of acrylic. The lines are few (two per lamella),
 *     long and open; they fan apart where the interference envelope is high and pinch where it
 *     is low. The ends of a sheet feather out to nothing well before the border.
 *     A line is a bright core 1–2 px wide (its weight varies slowly along its length) inside a
 *     soft glow several px wide, anti-aliased from the screen-space gradient of the cut function.
 *   - Coherence tears the sheet along the same family of long curves (slits shared by the stack).
 *   - Closed bodies carry a rim line instead of cut edges; crystals draw their facet edges;
 *     tiny bodies get a crisp luminous core so that a single point of light is never lost.
 *
 * Output: PREMULTIPLIED alpha, for NormalBlending with premultipliedAlpha = true
 * (dst = src.rgb + dst · (1 − src.a)), depthWrite off. The glass body contributes
 * colour·alpha with a low per-layer alpha, so stacked layers absorb what is behind them and
 * can go genuinely black; lines are near-opaque coverage; only sheen, glints and mirror
 * highlights are added on top. Display-referred values, highlights may exceed 1.
 *
 * Defines: WAVE_TERMS (8 | 4), LITE (optional).
 */
import { MAX_ATTACKS } from '../shared';
import { SHARED, SILK, WAVES } from './common';
import { STUDIO } from './env';

const VARYINGS = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;   // displaced normal, world (full detail: highlights)
varying vec3 vSoft;     // displaced normal with the high partials rolled off (refraction)
varying vec3 vBase;     // undisplaced normal, world
varying vec4 vField;    // x height (field units)  y how far this lamella has unfolded 0..1  z wavefront glow  w reveal threshold
varying vec4 vSheet;    // xy uv (sheet space, linear in the surface)  z interference envelope  w hover proximity
varying vec4 vLayer;    // x signed layer -1..1  y layer hash  z draw rank 0..1  w radius of the object on screen (css px)
varying vec3 vFan;      // d(lamella offset)/dx per unit of signed layer: how the fan tilts each sheet
varying vec3 vBary;
`;

/** The strip coordinate coherence tears along: long meandering curves, staggered a little per lamella. */
const STRIP = /* glsl */ `
float stripCoord(vec2 st, float lh) {
  return st.y * uStripes + 1.1 * sin(st.x * 2.3 + st.y * 1.7 + uSeed * 40.0) + 0.35 * sin(st.x * 7.1 + uSeed * 17.0)
    + (lh - 0.5) * 0.3 + uTime * uTimeScale * 0.06;
}
`;

export const MATTER_VERT = /* glsl */ `
attribute float aEdge;
attribute vec3 aBary;
${SHARED}
${WAVES}
${SILK}
uniform float uReveal;
uniform float uExcite;
uniform float uHover;
uniform float uTension;
uniform float uCoherence;
uniform float uSeed;
uniform float uSpread;
uniform float uLayers;
uniform float uFlip;       // sheets: +1 / -1 keeps the far lamella first in draw order. bodies: -1, outer shell first
uniform float uOpen;       // 1 open sheet, 0 closed body
uniform float uFanBase;
uniform float uDisp;
uniform float uGap;
uniform float uKScale;
uniform float uLag;
uniform float uNoiseAmp;
uniform float uNoiseFreq;
uniform float uTimeScale;
uniform float uLocalK;
uniform float uLocalAmp;
uniform float uStripes;
uniform float uTear;
uniform float uExtent;
uniform float uUnit;       // one unit of deformation, local (world unit for sheets, radius for bodies)
uniform float uHoverAmp;
uniform float uHoverReach;
uniform float uExciteAmp;
uniform float uExciteK;
uniform float uExciteW;
${VARYINGS}
${STRIP}

const float ATTACK_SPEED = 2.6;
const float ATTACK_K = 5.0;

void main() {
  float li = float(gl_InstanceID);
  float rank = (li + 0.5) / uLayers;
  float tl = (rank * 2.0 - 1.0) * uFlip;
  float lh = hash11(li * 7.31 + uSeed * 53.7 + 1.7);

  vec3 pw = (modelMatrix * vec4(position, 1.0)).xyz;
  mat3 m3 = mat3(modelMatrix);
  float s2 = max(dot(m3[0], m3[0]), 1e-8);
  vec3 nw = normalize(m3 * normal);
  vec3 origin = modelMatrix[3].xyz;
  float sc = sqrt(s2);            // world scale of the object
  float unit = uUnit * sc;
  float ext = uExtent * sc;

  float slack = 1.0 - uTension;
  float shimmer = 1.0 - uState.x;
  float silence = uState.w;

  // ── travelling superposition of the bridge sources ──────────────────────
  float lag = tl * uLag * (0.35 + 0.65 * slack) + shimmer * 0.1 * sin(uTime * 2.3 + li * 1.9 + uSeed * 6.0);
  float f;
  vec3 g;
  vec2 cs;
  vec3 gcx;
  vec3 gcy;
  float sum;
  waveField(pw, lag, uKScale, f, g, cs, gcx, gcy, sum);
  float H = f * uWaveNorm;
  vec3 G = g * uWaveNorm;
  // The same slope with every source weighted toward the low partials (gcy is exactly that
  // gradient): the broad swell without the fine ripple. Refraction looks through this one.
  vec3 Gs = gcy * uEnvNorm;
  // The interference envelope |cs|, smoothed where it vanishes: a node of the envelope is a
  // round bowl, never the tip of a cone (which every lamella would show as a pinched dimple).
  float e2 = dot(cs, cs) * uEnvNorm * uEnvNorm;
  float env = min(e2 * inversesqrt(e2 + 0.12), 1.5);

  // ── the object's own pitch: a standing (Chladni-like) mode in local space ─
  if (uLocalK > 0.0) {
    vec3 q = position * uLocalK + uSeed * vec3(3.1, 5.3, 7.7);
    vec3 s1 = sin(q);
    vec3 c1 = cos(q);
    vec3 sd = sin(2.0 * q);
    vec3 c2 = cos(2.0 * q);
    float W = c1.x * c2.y - c2.x * c1.y + c1.y * c2.z - c2.y * c1.z + c1.z * c2.x - c2.z * c1.x;
    vec3 dW = vec3(
      -s1.x * c2.y + 2.0 * sd.x * c1.y - 2.0 * c1.z * sd.x + c2.z * s1.x,
      -2.0 * c1.x * sd.y + c2.x * s1.y - s1.y * c2.z + 2.0 * sd.y * c1.z,
      -2.0 * c1.y * sd.z + c2.y * s1.z - s1.z * c2.x + 2.0 * sd.z * c1.x);
    float breath = uLocalAmp * cos(uTime * 0.85 + uSeed * TAU + tl * uLag * 0.4);
    H += W * breath;
    vec3 dg = (m3 * dW) * (uLocalK * breath / s2);
    G += dg;
    Gs += dg;
  }

  // ── slack: low-amplitude domain-warped noise ─────────────────────────────
  {
    vec3 ng;
    float na = uNoiseAmp * slack * (0.45 + 0.55 * shimmer);
    float nf = uNoiseFreq / sc;
    float n = silk(pw * nf + vec3(uSeed * 17.0 + tl * 0.12), uTime * uTimeScale, ng);
    H += n * na;
    G += ng * (nf * na);
    Gs += ng * (nf * na);
#ifndef LITE
    n = silk(pw * (nf * 2.3) + vec3(31.0 - uSeed * 9.0), uTime * uTimeScale * 1.4, ng);
    H += n * na * 0.4;
    G += ng * (nf * 2.3 * na * 0.4);
#endif
  }

  // ── strikes: radial wavefronts launched from bridge.attackAt ─────────────
  float front = 0.0;
  for (int i = 0; i < ${MAX_ATTACKS}; i++) {
    float ag = uAttackGain[i];
    if (ag > 0.001) {
      vec3 d = pw - uAttack[i].xyz;
      float r = sqrt(dot(d, d) + WAVE_SOFT);
      float u = r - (uTime - uAttack[i].w) * ATTACK_SPEED;
      float pk = exp(-1.6 * u * u) / (1.0 + 0.03 * r * r);
      float sn = sin(ATTACK_K * u);
      float cn = cos(ATTACK_K * u);
      H += 0.5 * ag * pk * sn;
      vec3 dg = d * (0.5 * ag * pk * (ATTACK_K * cn - 3.2 * u * sn) / r);
      G += dg;
      Gs += 0.6 * dg;
      front += ag * pk;
    }
  }

  // ── excite: a ripple that leaves the object's centre as the impulse decays ─
  if (uExcite > 0.001) {
    vec3 d = pw - origin;
    float r = sqrt(dot(d, d) + 0.01 * ext * ext);
    float u = r / ext - (1.0 - uExcite) * 1.15;
    float pk = exp(-uExciteW * u * u);
    float sn = sin(uExciteK * u);
    float cn = cos(uExciteK * u);
    float a = uExcite * uExciteAmp;
    H += a * pk * sn;
    vec3 dg = d * (a * pk * (uExciteK * cn - 2.0 * uExciteW * u * sn) / (r * ext));
    G += dg;
    Gs += 0.6 * dg;
    front += uExcite * pk;
  }

  // ── hover: the surface leans toward the pointer ──────────────────────────
  // Proximity is measured to the pointer RAY, so it is what the visitor sees, at any depth.
  vec3 ray = uPointer.xyz - uCamPos;
  ray /= max(length(ray), 1e-4);
  vec3 dp = pw - uPointer.xyz;
  dp -= ray * dot(dp, ray);
  float reach = uHoverReach * unit;
  float hov = uHover * exp(-dot(dp, dp) / (reach * reach));
  float facing = dot(normalize(uCamPos - pw), nw);
  float side = mix(0.5 + 0.5 * facing, facing >= 0.0 ? 1.0 : -1.0, uOpen);
  float hh = side * uHoverAmp * unit * hov;
  vec3 hg = dp * (-2.0 * hh / (reach * reach));

  float dispMul = uDisp * unit * mix(1.2, 0.8, uTension) * (0.8 + 0.6 * uBands.x);
  float height = H * dispMul + hh;
  vec3 grad = G * dispMul + hg;
  vec3 gradS = mix(Gs, G, 0.22) * dispMul + hg;
  vec3 N = normalize(nw - (grad - nw * dot(nw, grad)));
  vec3 NS = normalize(nw - (gradS - nw * dot(nw, gradS)));
  vec3 P = pw + nw * height;

  // ── lamella offset: opens with harmonic complexity and local field energy ─
  float fan = uSpread * (uFanBase + (1.0 - uFanBase) * uComplexity);
  float thin = 1.0 - smoothstep(0.1, 0.9, silence);
  float gapU = uGap * unit * fan * thin;
  float swell = exp(-1.4 * env);                      // the stack opens with the envelope, and saturates
  // (only as far as the envelope is broad: under high voices alone its nodes are a fine
  // lattice, and a stack pinched at every one of them would be pocked, not flowing)
  float broad = smoothstep(0.1, 0.5, uWaveNorm / max(uEnvNorm, 1e-3));
  P += NS * (tl * gapU * (0.3 + 1.6 * mix(0.45, 1.0 - swell, broad)));
  // The fan opens along the gradient of the envelope, so every sheet leans a little more than
  // the one beneath it.
  vec3 fanG = (cs.x * gcx + cs.y * gcy)
    * (uEnvNorm * uEnvNorm * gapU * 2.24 * broad * swell * (e2 + 0.24) * pow(e2 + 0.12, -1.5) * step(env, 1.499));
  fanG -= nw * dot(nw, fanG);

  // ── low coherence: strips tear loose and drift ───────────────────────────
  float coh = uCoherence * (1.0 - smoothstep(0.15, 0.85, silence));
  float sid = floor(stripCoord(uv, lh));
  float sh = hash21(vec2(sid, li + uSeed * 31.0));
  // only a strip whose two slits are open is free to drift (the same hashes as the fragment stage)
  float share = 1.2 * pow(1.0 - coh, 1.6);
  float free = smoothstep(0.5, 1.0, clamp((share - hash21(vec2(sid, uSeed * 31.0))) * 6.0, 0.0, 1.0))
    * smoothstep(0.5, 1.0, clamp((share - hash21(vec2(sid + 1.0, uSeed * 31.0))) * 6.0, 0.0, 1.0));
  float torn = uTear * unit * (1.0 - smoothstep(0.1, 0.42, coh)) * free;
  float dph = uTime * (0.12 + 0.5 * uTimeScale) + sh * TAU;
  P += N * (((sh - 0.5) * 1.6 + 0.35 * sin(dph)) * torn);
  P += vec3(sin(dph * 1.3 + 1.0), cos(dph * 0.9), sin(dph * 0.7 + 2.0)) * (0.3 * torn);

  // ── reveal threshold of a sheet: crests near the centre first, troughs at the rim last ─
  // (a closed body has none: its reveal is simply how present it is)
  float rr = clamp(length(pw - origin) / ext, 0.0, 1.0);
  float thr = uOpen * clamp(0.5 * rr + 0.25 - 0.25 * clamp(H, -1.0, 1.0) + (lh - 0.5) * 0.1, 0.0, 1.0);

  vWorld = P;
  vNormal = N;
  vSoft = NS;
  vBase = nw;
  // one pitch is one barely-there sheet; the rest of the stack unfolds as the fan opens
  float shown = clamp(1.0 + fan * 1.6 * (uLayers - 1.0) - li, 0.0, 1.0);

  // radius of the whole object on screen, css px (a tiny body is drawn as a point of light)
  float rpx = ext * projectionMatrix[1][1] * 0.5 * uViewport.y / max(length(uCamPos - origin), 0.05);

  vField = vec4(H, shown, front, thr);
  vSheet = vec4(uv, env, hov);
  vLayer = vec4(tl, lh, rank, rpx);
  vFan = fanG;
  vBary = aBary;

  vec4 clip = projectionMatrix * viewMatrix * vec4(P, 1.0);
  gl_Position = (uReveal * uState.y * shown > 0.0015) ? clip : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const MATTER_FRAG = /* glsl */ `
${SHARED}
${STUDIO}
uniform float uReveal;
uniform float uExcite;
uniform float uCoherence;
uniform float uSeed;
uniform float uWarmth;
uniform float uSpread;
uniform float uLayers;
uniform float uFanBase;
uniform float uStripes;
uniform float uTimeScale;
uniform float uOpen;
uniform float uDisc;       // open sheets: 0 a ribbon cut along two long curves, 1 a disc cut along its rim
uniform float uFacet;
uniform float uTerrace;    // share of the sheet's width taken by the stair of cut edges, fully fanned
uniform float uAlpha;
uniform float uDeep;
uniform float uTransGain;
uniform float uReflGain;
uniform float uLineGain;
uniform float uLineLum;
uniform float uSilGain;
uniform float uGlint;
uniform float uShine;
uniform float uEnvSoft;
uniform float uOptic;
uniform float uBend;
uniform float uTiltGain;
uniform float uBackGain;
uniform float uFilm;
uniform float uFlash;
uniform float uSheen;
uniform float uCore;
${VARYINGS}
${STRIP}

vec3 rayFrame(vec3 d, vec3 X, vec3 Y, vec3 Z) {
  return normalize(vec3(dot(d, X), dot(d, Y), dot(d, Z)));
}

// Signed distance to the zero set of a smooth function, in CSS pixels.
float pxTo(float d) {
  return d / ((length(vec2(dFdx(d), dFdy(d))) + 1e-7) * uViewport.z);
}

// A cut at px = signed distance in CSS pixels (+ inside the sheet); w = width of the line's core.
//   x  coverage of the sheet
//   y  the line: a bright core lying just inside the cut, within a soft glow several px wide
vec2 cutEdge(float px, float w) {
  float ax = abs(px - 0.5 * w);
  float core = 1.0 - smoothstep(0.5 * w - 0.45, 0.5 * w + 0.7, ax);
  return vec2(smoothstep(-0.6, 0.6, px), core + 0.26 * exp(-0.36 * ax) * (1.0 - core));
}

void main() {
  float presence = uState.y;
  float spectral = uState.z;
  float silence = uState.w;
  float envS = 1.0 - exp(-1.4 * vSheet.z);      // the envelope, softly saturated (no kink where it peaks)
  float tl = vLayer.x;
  float lh = vLayer.y;
  float rank = vLayer.z;
  float hov = vSheet.w;
  float fan = uSpread * (uFanBase + (1.0 - uFanBase) * uComplexity);
  float coh = clamp(uCoherence * (1.0 - smoothstep(0.15, 0.85, silence)), 0.0, 1.0);
  float nShown = clamp(1.0 + fan * 1.6 * (uLayers - 1.0), 1.0, uLayers);

  // ── reveal: matter condenses from the centre outward, softly; the glass thickens behind ──
  float rv = uReveal * 1.2 - 0.1 - vField.w;
  float shape = mix(smoothstep(0.0, 0.15, uReveal), smoothstep(0.0, 0.22, rv), uOpen);   // gates everything
  float grown = mix(0.3 + 0.7 * uReveal, 0.3 + 0.7 * smoothstep(0.05, 0.4, rv), uOpen);
  float cover = 1.0;                                // the glass itself: cuts and slits
  float lines = 0.0;
  float bevel = 0.0;

  // ── cut edges of an open sheet ───────────────────────────────────────────
  // Every lamella is cut along long flowing curves, analytic in sheet space, each a little
  // inside the one beneath it; the stack's edge is a sheaf of lines that fans and pinches.
  if (uOpen > 0.5) {
    vec2 q = vSheet.xy * 2.0 - 1.0;
    float ph = uSeed * TAU + uTime * uTimeScale * 0.04;
    // A sheared stack. The base sheet spans the ribbon; every further lamella that has unfolded
    // ends a step inside the one beneath it: across one flank a broad stair of edges (the steps
    // grow inward: a sheaf at the rim that opens toward the middle), on the other a tight sheaf.
    float step1 = (rank * uLayers - 0.5) / nShown;
    float s1 = 0.8 * uTerrace * (0.4 + 0.6 * step1);
    float s2 = 0.09 * uTerrace;
    float u;          // 0 on one flank of the sheet … 1 on the other
    float wr;         // where the stair leans: lines fan apart on one side and pinch on the other
    float feather = 1.0;
    float along;
    if (uDisc > 0.5) {
      float th = atan(q.y, q.x);
      along = th;
      u = 1.0 - length(q) / (0.86 + 0.06 * sin(2.0 * th + ph) + 0.035 * sin(3.0 * th - ph * 1.7 + 1.0));
      wr = 0.6 * sin(th + ph * 2.0);
      s2 = 0.0;
    } else {
      float a = q.x;
      along = a * 2.2;
      float taper = 1.0 - 0.3 * a * a;
      float top = 0.62 * taper + 0.14 * sin(a * 2.1 + ph) + 0.06 * sin(a * 4.7 - ph * 1.7 + 1.0);
      float bot = -0.62 * taper + 0.14 * sin(a * 1.8 + ph * 2.3 + 2.0) + 0.06 * sin(a * 5.1 + ph * 0.7);
      u = (q.y - bot) / (top - bot);
      wr = 0.55 * sin(a * 1.9 + ph * 3.1);
      // the two ends of the ribbon dissolve: no edge is ever drawn across it
      feather = 1.0 - smoothstep(0.46, 0.93, abs(a) + 0.06 * sin(q.y * 2.4 + ph * 5.0) + 0.06 * (lh - 0.5));
    }
    // … and the stair opens toward wherever the interference envelope is high
    float uc = clamp(u, 0.0, 1.0);
    float uw = u + clamp(wr + 0.34 * (envS - 0.5), -0.85, 0.85) * uc * (1.0 - uc);
    float d1 = 1.0 - step1 * s1 - uw;
    float d2 = uDisc > 0.5 ? 1.0 : uw - step1 * s2;
    float p1 = pxTo(d1);
    float p2 = pxTo(d2);
    // the weight of a line varies slowly along its length, and from one lamella to the next
    float wv = 0.5 + 0.5 * sin(along * 1.3 + rank * 2.6 + lh * 2.0 + ph * 4.0);
    float w = mix(1.1, 2.1, wv);
    vec2 c1 = cutEdge(p1, w);
    vec2 c2 = cutEdge(p2, w);
    // neighbouring cuts closer than they can be resolved merge into one calm band, not a white bar
    float lone = 1.0 - smoothstep(1.0, 2.0, nShown);
    float r1 = max(lone, smoothstep(0.8, 3.2, abs(p1) * s1 / (nShown * (abs(d1) + 1e-6))));
    float r2 = max(lone, smoothstep(0.8, 3.2, abs(p2) * s2 / (nShown * (abs(d2) + 1e-6))));
    cover = c1.x * c2.x * feather;
    lines = max(c1.y * c2.x * mix(0.3, 1.0, r1), c2.y * c1.x * mix(0.3, 1.0, r2)) * feather * feather * (0.4 + 0.6 * wv) * (0.6 + 0.4 * lh);
    // a cut face has thickness: a short bevel of light just inside the line
    bevel = max(exp(-max(p1, 0.0) * 0.14), exp(-max(p2, 0.0) * 0.14)) * cover;
  }

  // ── coherence. Falling from 1, long slits open between strips of the sheet, more of them
  //    and wider; below ~0.4 the strips thin into ribbons and fewer and fewer remain:
  //    at 0, a sparse drift of glass filaments. The slits are shared by the whole stack
  //    (each lamella staggered a little), so a tear shows a sheaf of edges too.
  float strand = 0.0;
  if (coh < 0.999) {
    float s = stripCoord(vSheet.xy, lh);
    float sid = floor(s);
    float fs = s - sid;
    float lk = uSeed * 31.0;
    float slit = 0.46 * pow(1.0 - coh, 2.2);
    float share = 1.2 * pow(1.0 - coh, 1.6);
    float keep = clamp((mix(0.14, 1.2, smoothstep(0.0, 0.45, coh)) - hash21(vec2(sid * 1.7 + 3.1, lk + rank * 37.0))) * 5.0, 0.0, 1.0);
    float gl = mix(0.5, slit * clamp((share - hash21(vec2(sid, lk))) * 6.0, 0.0, 1.0), keep);
    float gu = mix(0.5, slit * clamp((share - hash21(vec2(sid + 1.0, lk))) * 6.0, 0.0, 1.0), keep);
    // (the gradient of the continuous coordinate, not of its fractional part: no seam between strips)
    float fw = (length(vec2(dFdx(s), dFdy(s))) + 1e-7) * uViewport.z;
    vec2 cl = cutEdge((fs - gl) / fw, 1.3);
    vec2 cu = cutEdge((1.0 - fs - gu) / fw, 1.3);
    float wl = smoothstep(0.0, 1.0, gl / fw);          // a slit thinner than a pixel is not there yet
    float wu = smoothstep(0.0, 1.0, gu / fw);
    float within = cover;                              // a tear ends where the sheet does
    cover *= mix(1.0, cl.x, wl) * mix(1.0, cu.x, wu);
    // a ribbon only a few pixels wide is drawn by its body, not by two edges fused into a white bar
    // … and only the base sheet and a few others carry a line along a tear: the rest of the
    // stack shows it as steps in the glass, so a torn sheet stays a handful of long calm curves
    strand = max(cl.y * wl, cu.y * wu) * mix(0.3, 1.0, smoothstep(2.5, 8.0, (1.0 - gl - gu) / fw))
      * max(step(rank, 1.0 / uLayers), 0.08 + 0.92 * smoothstep(0.72, 0.86, lh)) * within;
    lines *= mix(1.0, cl.x, wl) * mix(1.0, cu.x, wu);
  }

  // ── normals ──────────────────────────────────────────────────────────────
  vec3 V = normalize(uCamPos - vWorld);
  vec3 Ns = normalize(vNormal - vFan * tl);           // each lamella leans with the fan
  float flipN = dot(Ns, V) < 0.0 ? -1.0 : 1.0;
  Ns *= flipN;
  vec3 Nr = normalize(vSoft - vFan * tl) * flipN;     // what refraction sees: the broad swell
  vec3 Nb = normalize(vBase) * flipN;
  float ndvS = dot(Ns, V);
  float sPx = ndvS / ((fwidth(ndvS) + 1e-5) * uViewport.z);
  float graze = 1.0 - smoothstep(0.3, 0.6, ndvS);
  float rim = smoothstep(0.0, 1.1, sPx);
  float sil = cutEdge(sPx, 1.3).y * rim * graze;      // silhouette line (closed bodies)
  // a sheet seen edge-on lets go well before its (tessellated) silhouette can show
  float silFade = mix(smoothstep(0.04, 0.4, ndvS), rim, 1.0 - uOpen);

  float top = step(rank, 1.0 / uLayers);              // the one lamella that is always there
  vec3 N = Ns;
  float wire = 0.0;
  float facetLit = 0.0;
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 X = normalize(cross(camUp, V));
  vec3 Y = cross(V, X);
  if (uFacet > 0.5) {
    vec3 Nf = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(Nf, V) < 0.0) Nf = -Nf;
    N = Nf;
    Nr = Nf;
    float b = min(vBary.x, min(vBary.y, vBary.z));
    wire = cutEdge(b / ((fwidth(b) + 1e-6) * uViewport.z), 1.2).y * (0.22 + 0.78 * top) * (1.0 - 0.6 * uOpen);
    // a facet turned toward one of the two lights lights up whole: cut glass
    float f1 = dot(Nf, normalize(normalize(X * -0.35 + Y * 0.75 + V * 0.55) + V));
    float f2 = dot(Nf, normalize(normalize(X * 0.6 + Y * -0.25 + V * 0.76) + V));
    facetLit = smoothstep(0.93, 0.995, f1) + 0.55 * smoothstep(0.95, 0.997, f2);
    sil = 0.0;
    silFade = smoothstep(0.0, 0.22, ndvS);
  }
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  // ── glints (closed bodies): small, sharp, white ──────────────────────────
  // Two point lights fixed to the camera. A glint is measured in PIXELS from its specular
  // point, so it is the same few pixels wide on a gentle swell as on a tight fold: never a smudge.
  float glint = 0.0;
  if (uGlint > 0.0) {
    float gr = 60.0 * uViewport.z * inversesqrt(uShine);
    float g1 = sqrt(max(2.0 - 2.0 * dot(N, normalize(normalize(X * -0.35 + Y * 0.75 + V * 0.55) + V)), 0.0));
    float g2 = sqrt(max(2.0 - 2.0 * dot(N, normalize(normalize(X * 0.6 + Y * -0.25 + V * 0.76) + V)), 0.0));
    float q1 = g1 / ((fwidth(g1) + 1e-5) * gr);
    float q2 = g2 / ((fwidth(g2) + 1e-5) * gr * 0.75);
    glint = exp(-q1 * q1) * (1.0 - smoothstep(0.05, 0.11, g1)) + 0.6 * exp(-q2 * q2) * (1.0 - smoothstep(0.05, 0.11, g2));
  }

  // ── lines ────────────────────────────────────────────────────────────────
  float energy = mix(0.5, 1.0, smoothstep(0.0, 0.5, vSheet.z));
  // (a cut seen edge-on cannot be resolved: let it go rather than let it break up)
  float L = (lines + (0.3 + 0.5 * uOpen) * strand) * uLineGain * energy * smoothstep(0.02, 0.14, ndvS)
    + sil * uSilGain * (0.14 + 0.86 * top) * (energy + 0.8 * hov)
    + wire * energy * (gl_FrontFacing ? 1.0 : 0.3) * mix(1.0, cover, uOpen);
  L = clamp(L, 0.0, 1.0) * shape * mix(0.4 + 0.6 * uReveal, 1.0, uOpen);
  cover *= shape;

  // every screen-space derivative has been taken: safe to drop empty fragments now
  float m = vField.y * presence * (1.0 - smoothstep(0.6, 1.0, silence)) * silFade * (gl_FrontFacing ? 1.0 : uBackGain);
  if ((cover + L) * m < 0.003) discard;

  // ── optics ───────────────────────────────────────────────────────────────
  // Optical normal: for sheets it is the view vector plus the wave-borne tilt, so an
  // undisturbed surface neither reflects nor refracts anything; bodies and crystals
  // blend toward their true normal (uOptic).
  vec3 tilt = Nr - Nb * dot(Nr, Nb);
  vec3 No = normalize(mix(V + tilt * uTiltGain, Nr, uOptic));

  // every lamella bends the light a little differently: the refracted pools arrive as a
  // sheaf of soft overlapping edges, one per sheet
  float bend = uBend * (1.0 + 0.16 * tl);
  vec3 Tg = -V + (refract(-V, No, 0.6897) + V) * bend;
  vec3 dT = rayFrame(Tg, X, Y, V);
  vec3 envT = studioBack(dT, uEnvSoft, uWarmth);
  // Where the waves are strong but the sheet happens to lie flat (a crest, a trough, a saddle)
  // the glass still holds a little of the pale light: no pinched dark eye at every antinode.
  // An undisturbed sheet has no envelope, and stays black.
  vec2 pT = dT.xy / max(-dT.z, 0.2);
  envT += (uEnvCol[1] * (0.5 - 0.2 * uWarmth) + uEnvCol[3] * (0.5 + 0.2 * uWarmth)) * (exp(-dot(pT, pT) * 60.0) * 0.32 * envS * uOpen);
#ifndef LITE
  // restrained dispersion, earned with colour: IOR 1.45 → 1.42 / 1.45 / 1.49 as spectral rises
  float disp = 0.011 * smoothstep(0.15, 0.85, spectral);
  if (disp > 0.0) {
    vec3 Tr = -V + (refract(-V, No, 0.6897 + disp) + V) * bend;
    vec3 Tb = -V + (refract(-V, No, 0.6897 - disp * 1.2) + V) * bend;
    envT.r = studioBack(rayFrame(Tr, X, Y, V), uEnvSoft, uWarmth).r;
    envT.b = studioBack(rayFrame(Tb, X, Y, V), uEnvSoft, uWarmth).b;
  }
#endif

  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);

  // absorption along the path through the sheet: steeper view → deeper, darker glass
  float path = 1.0 / max(ndv, 0.2);
  vec3 sigma = mix(vec3(1.0), vec3(1.25, 0.95, 0.8), spectral);
  vec3 through = exp(-sigma * (uDeep * (path - 0.85))) * (0.78 + 0.44 * lh);

  // thin film, restrained: two tones of the palette, never a rainbow
  float cosT = sqrt(1.0 - (1.0 - ndv * ndv) * 0.4756);
  float orders = 0.85 + 1.9 * envS + 0.3 * tl + 0.2 * vField.x;
  vec3 film = mix(vec3(0.3, 0.78, 0.9), vec3(1.05, 0.84, 0.52), 0.5 + 0.5 * cos(TAU * orders * cosT));
  float irid = uFilm * spectral * spectral * (0.2 + 0.8 * envS) * (0.35 + 0.65 * pow(1.0 - ndv, 1.5));

  float flash = uFlash * (0.9 * vField.z + 0.5 * uExcite) + 0.35 * hov;
  vec3 body = (envT * through * ((1.0 - fres) * uTransGain) + film * (irid * fres * 0.5)) * (1.0 + flash);
  // (a body's outer shell is its skin: it holds more than the shells inside it)
  float a = clamp(uAlpha * (0.7 + 2.2 * fres + 0.6 * envS) * grown * (1.0 + 1.6 * top * (1.0 - uOpen)), 0.0, 0.9);
  vec3 pale = mix(vec3(0.62, 0.64, 0.68), uEnvCol[1] * 0.6 + uEnvCol[3] * 0.5, min(spectral * 1.2, 1.0) * 0.8);
  vec3 rgb = body * a + pale * (bevel * 0.05 * (0.4 + 0.6 * envS));

  // ── flow-aligned sheen: soft streaks that run along the wave crests, like silk ──
  // (measured on the wave-borne tilt, so an undisturbed sheet shows none)
  if (uSheen > 0.0) {
    vec3 tf = Ns - Nb * dot(Ns, Nb);
    vec2 t2 = vec2(dot(tf, X), dot(tf, Y));
    float sl = length(t2) + 1e-4;
    vec2 dir = t2 / sl;
    vec2 e1 = t2 - vec2(-0.1, 0.2);
    vec2 e2 = t2 - vec2(0.17, -0.09);
    float al1 = e1.x * dir.y - e1.y * dir.x;
    float ac1 = dot(e1, dir);
    float al2 = e2.x * dir.y - e2.y * dir.x;
    float ac2 = dot(e2, dir);
    float sheen = exp(-(al1 * al1 * 14.0 + ac1 * ac1 * 240.0)) + 0.55 * exp(-(al2 * al2 * 14.0 + ac2 * ac2 * 240.0));
    sheen *= smoothstep(0.04, 0.14, sl);
    vec3 sheenCol = mix(vec3(0.95, 0.94, 0.9), uEnvCol[3] * 0.55 + uEnvCol[1] * 0.5, 0.5 * spectral);
    rgb += sheenCol * (sheen * uSheen * (0.55 + 0.45 * envS) * grown * (1.0 + flash));
  }

  // One lamella carries the surface — reflections, glints, the core: the base sheet, or a
  // body's outer shell (always drawn; whatever is drawn over it is compensated).
  float over = pow(1.0 - min(uAlpha * 1.3, 0.5), 1.0 - nShown);
  if (top * uReflGain > 0.0) {
    vec3 envR = studioAll(rayFrame(reflect(-V, mix(No, N, uFacet)), X, Y, V), uEnvSoft, uWarmth);
    rgb += envR * mix(vec3(1.0), film * 1.4, irid * 0.3) * ((0.22 + 0.78 * fres) * uReflGain * over * (1.0 + flash));
    rgb += vec3(1.0, 0.98, 0.94) * (facetLit * 0.9 * over * (1.0 + flash));
  }
  rgb += vec3(1.0, 0.985, 0.95) * (glint * uGlint * top * over * (1.0 + 0.5 * flash));

  // a tiny body is a point of light: a crisp core in a restrained halo
  if (uCore > 0.0) {
    float cd = abs(dot(normalize(vBase), V));
    float r2 = 1.0 - cd * cd;
    float cr = clamp(2.2 / max(vLayer.w, 1.0), 0.14, 0.75);
    float small = 1.0 - smoothstep(12.0, 64.0, vLayer.w);
    float core = exp(-r2 / (cr * cr)) + 0.14 * exp(-r2 * 3.5);
    rgb += vec3(1.0, 0.98, 0.93) * (core * uCore * mix(0.22, 1.0, small) * top * over * (gl_FrontFacing ? 1.0 : 0.0) * (1.0 + flash));
  }

  vec3 lineCol = mix(vec3(1.0, 0.985, 0.955), film * 1.2 + 0.25, 0.1 * irid) * (uLineLum * (1.0 + 0.6 * flash));
  rgb = rgb * (cover * (1.0 - L)) + lineCol * L;
  a = a * cover * (1.0 - L) + 0.85 * L;

  // ── silence extinguishes; presence is the master ─────────────────────────
  gl_FragColor = vec4(rgb * m, a * m);
}
`;
