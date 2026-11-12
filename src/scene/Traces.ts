import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Line,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { TRAIL_N, UNIFORMS } from '../shaders/common';
import { shared } from './uniforms';

const N = 640;

const vert = /* glsl */ `
attribute vec2 aLife; // birth time, on/off
varying float vAlpha;
varying float vAge;
${UNIFORMS}
void main(){
  float age=uTime-aLife.x;
  vec3 p=position;
  // traces loosen like smoke as they age, but keep their gesture
  p+=vec3(sin(p.y*2.1+age*.11), sin(p.z*1.7+age*.09+1.), sin(p.x*1.9+age*.1+2.))*min(age,40.)*.006;
  vec4 mv=viewMatrix*vec4(p,1.);
  gl_Position=projectionMatrix*mv;
  float fresh=exp(-age/2.2);
  float ghost=exp(-age/48.)*.085;      // the afterimage: almost imperceptible
  vAlpha=aLife.y*(fresh*.85+ghost)*exp(mv.z*.05);
  vAge=age;
  gl_PointSize=(2.+fresh*5.)*uPixelRatio*uViewH/(-mv.z*300.);
}`;

const fragLine = /* glsl */ `
varying float vAlpha; varying float vAge;
${UNIFORMS}
void main(){
  vec3 col=mix(WARM, mix(CYAN, VIOLET, .5+.5*sin(vAge*.4)), uColor*.7);
  gl_FragColor=vec4(col, vAlpha);
}`;

const fragPoint = /* glsl */ `
varying float vAlpha; varying float vAge;
${UNIFORMS}
void main(){
  vec2 p=gl_PointCoord-.5; float r2=dot(p,p)*4.;
  if(r2>1.) discard;
  gl_FragColor=vec4(mix(WARM, AMBER, uColor*.5), vAlpha*exp(-r2*3.)*.5);
}`;

/**
 * Spatial memory. Every gesture is written into a ring of world-space points
 * that is drawn as a thread of light, and a sparse sample of it is handed to
 * the other shaders so particles and membrane keep responding to where the
 * visitor has been.
 */
export class Traces {
  readonly group = new Group();
  private pos = new Float32Array(N * 3);
  private life = new Float32Array(N * 2);
  private geo = new BufferGeometry();
  private last = new Vector3(1e3, 0, 0);
  private lastTime = -10;
  private sinceSample = 0;
  private slot = 0;
  private birth = new Float32Array(TRAIL_N).fill(-1e3);

  constructor() {
    const pa = new BufferAttribute(this.pos, 3);
    const la = new BufferAttribute(this.life, 2);
    pa.setUsage(DynamicDrawUsage);
    la.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('position', pa);
    this.geo.setAttribute('aLife', la);
    for (let i = 0; i < N; i++) this.life[i * 2] = -1e3;
    const base = { uniforms: shared, vertexShader: vert, transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending };
    const line = new Line(this.geo, new ShaderMaterial({ ...base, fragmentShader: fragLine }));
    const pts = new Points(this.geo, new ShaderMaterial({ ...base, fragmentShader: fragPoint }));
    line.frustumCulled = pts.frustumCulled = false;
    this.group.add(line, pts);
  }

  private push(p: Vector3, time: number, on: number) {
    this.pos.copyWithin(0, 3);
    this.life.copyWithin(0, 2);
    const i = N - 1;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.life[i * 2] = time;
    this.life[i * 2 + 1] = on;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
  }

  update(focus: Vector3, time: number, energy: number) {
    const d = focus.distanceTo(this.last);
    if (energy > 0.04 && d > 0.07) {
      // a pause or a jump starts a new stroke
      if (time - this.lastTime > 0.6 || d > 1.2) this.push(focus, time, 0);
      this.push(focus, time, 1);
      this.last.copy(focus);
      this.lastTime = time;
      if (++this.sinceSample >= 7) {
        this.sinceSample = 0;
        this.slot = (this.slot + 1) % TRAIL_N;
        const u = shared.uTrail.value[this.slot];
        u.set(focus.x, focus.y, focus.z, 1);
        this.birth[this.slot] = time;
      }
    }
    const tr = shared.uTrail.value;
    for (let i = 0; i < TRAIL_N; i++) {
      const age = time - this.birth[i];
      tr[i].w = age > 300 ? 0 : 0.8 * Math.exp(-age / 2.6) + 0.2 * Math.exp(-age / 42);
    }
  }

  clear() {
    for (let i = 0; i < N; i++) this.life[i * 2 + 1] = 0;
    this.geo.attributes.aLife.needsUpdate = true;
    this.birth.fill(-1e3);
    this.last.set(1e3, 0, 0);
  }
}
