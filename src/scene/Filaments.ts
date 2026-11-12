import { AdditiveBlending, BufferAttribute, BufferGeometry, LineSegments, ShaderMaterial } from 'three';
import { PRELUDE } from '../shaders/common';
import { shared, type Quality } from './uniforms';

const vert = /* glsl */ `
attribute vec4 aAB;      // two surface coordinates
attribute vec3 aInfo;    // t along chord, along-filament coordinate, seed
attribute float aKind;   // 0 surface curve, 1 interior chord
varying float vAlpha;
varying vec3 vColor;
${PRELUDE}
void main(){
  float seed=aInfo.z;
  vec3 A=form(aAB.xy);
  vec3 p=A;
  if(aKind>.5){
    vec3 B=form(aAB.zw);
    p=mix(A,B,aInfo.x)*(1.-.24*sin(3.14159*aInfo.x));
  } else {
    p*=1.035;
  }
  vec3 df=p-uFocus;
  float prox=exp(-dot(df,df)*.8);
  float k=smoothstep(seed*.6, seed*.6+.35, uCoherence);
  float reveal=uFormVis*(k*uCoherence + prox*(.25*uEnergy+.8*uHold)*(1.-.5*aKind));
  // when attention leaves, each thread drifts off its own way
  vec3 off=sin(vec3(seed*91., seed*57., seed*33.)+uTime*.18+aInfo.y*vec3(7.,9.,11.));
  p+=off*(1.-k)*(.35+uTurb*.6);

  vec4 mv=viewMatrix*vec4(p,1.);
  gl_Position=projectionMatrix*mv;

  float ph=fract(aInfo.y-uTime*(.03+seed*.05)+seed*7.);
  float pulse=exp(-ph*ph*260.)+exp(-(1.-ph)*(1.-ph)*260.);
  float a=reveal*(.10+pulse*.75)*mix(1., .45, aKind);
  a*=exp(mv.z*.06);
  vAlpha=a;
  vec3 spec=mix(CYAN, VIOLET, seed);
  spec=mix(spec, AMBER, step(.85, seed));
  vColor=mix(WARM, spec, uColor*(.5+.5*aKind));
}`;

const frag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main(){ gl_FragColor=vec4(vColor, vAlpha); }`;

/**
 * Threads: curves that wind over the surface, and chords that cross its
 * interior like a nervous system. Both are bound to the same form().
 */
export class Filaments {
  readonly lines: LineSegments;

  constructor(q: Quality) {
    const curves = q.lite ? 22 : 46;
    const seg = q.lite ? 120 : 220;
    const chords = q.lite ? 120 : 300;
    const sub = 8;
    const nv = curves * (seg + 1) + chords * (sub + 1);
    const ab = new Float32Array(nv * 4);
    const info = new Float32Array(nv * 3);
    const kind = new Float32Array(nv);
    const idx: number[] = [];
    let v = 0;
    for (let c = 0; c < curves; c++) {
      const u0 = Math.random();
      const v0 = Math.random();
      const span = 0.35 + Math.random() * 0.65;
      const wind = (Math.floor(Math.random() * 3) + 1) * (Math.random() < 0.5 ? -1 : 1);
      const s = Math.random();
      for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        ab[v * 4] = ab[v * 4 + 2] = u0 + t * span;
        ab[v * 4 + 1] = ab[v * 4 + 3] = v0 + t * span * wind * 0.5;
        info[v * 3] = 0;
        info[v * 3 + 1] = t;
        info[v * 3 + 2] = s;
        kind[v] = 0;
        if (i < seg) idx.push(v, v + 1);
        v++;
      }
    }
    for (let c = 0; c < chords; c++) {
      const a0 = Math.random();
      const a1 = Math.random();
      const b0 = a0 + (Math.random() - 0.5) * 0.5;
      const b1 = Math.random();
      const s = Math.random();
      for (let i = 0; i <= sub; i++) {
        const t = i / sub;
        ab[v * 4] = a0;
        ab[v * 4 + 1] = a1;
        ab[v * 4 + 2] = b0;
        ab[v * 4 + 3] = b1;
        info[v * 3] = t;
        info[v * 3 + 1] = t;
        info[v * 3 + 2] = s;
        kind[v] = 1;
        if (i < sub) idx.push(v, v + 1);
        v++;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setAttribute('aAB', new BufferAttribute(ab, 4));
    geo.setAttribute('aInfo', new BufferAttribute(info, 3));
    geo.setAttribute('aKind', new BufferAttribute(kind, 1));
    geo.setIndex(idx);
    const mat = new ShaderMaterial({
      uniforms: shared,
      vertexShader: vert,
      fragmentShader: frag,
      defines: q.lite ? { LITE: '' } : {},
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.lines = new LineSegments(geo, mat);
    this.lines.frustumCulled = false;
  }
}
