import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { PRELUDE, TRAIL_N } from '../shaders/common';
import { shared, type Quality } from './uniforms';

const vert = /* glsl */ `
attribute vec4 aSeed;
varying float vAlpha;
varying vec3 vColor;
${PRELUDE}
void main(){
  float t=uTime;
  vec3 home=position;
  // a very slow lateral drift, wrapped inside the volume
  home.x=mod(home.x+t*.035*(aSeed.w-.35)+9., 18.)-9.;
  float edge=smoothstep(9., 7., abs(home.x));

  // curl-noise flow: divergence free, so the field never clumps or drains
  vec3 flow=curl(home*.17+vec3(0., t*.014, t*.006));
  vec3 p=home+flow*(.5+uTurb*1.5)*mix(1., .3, uStill);

  // most particles also know a place on the hidden form
  float isForm=step(aSeed.w, .62);
  vec2 uv=aSeed.xy;
  vec3 target=form(uv);
  vec3 dt3=target-uFocus;
  float local=exp(-dot(dt3,dt3)*.8)*(uHold+.35*uEnergy);
  float thr=aSeed.z*.7;
  float c=smoothstep(thr, thr+.3, uCoherence+local*.5)*isForm;
  c*=1.-uTurb*.7*fract(aSeed.w*13.37);
  c=c*c*(3.-2.*c);
  vec3 jit=fract(aSeed.xyz*vec3(91.7,37.3,57.1)+aSeed.w)-.5;
  target+=jit*(.05+.55*(1.-c))+flow*.03*(1.+uEnergy*2.);

  vec3 q=mix(p, target, c);
  q+=flow*.3*sin(c*3.14159);              // arrive along an arc, not a line

  // attention attracts and gently swirls whatever has not yet condensed
  vec3 d=uFocus-q;
  float pull=exp(-dot(d,d)*.55);
  float free=1.-c*.85;
  q+=d*pull*(.16*uEnergy+.42*uHold)*free;
  q+=cross(uCamDir, d)*pull*uEnergy*.4*free;

  // earlier gestures still bend the field
  float tr=0.;
  for(int i=0;i<${TRAIL_N};i++){
    vec3 dd=uTrail[i].xyz-q;
    float w=uTrail[i].w*exp(-dot(dd,dd)*2.4);
    tr+=w; q+=dd*w*.07*free;
  }

  vec4 mv=viewMatrix*vec4(q,1.);
  gl_Position=projectionMatrix*mv;
  float depth=max(-mv.z, .05);

  // shallow depth of field: out-of-focus points swell and thin
  float coc=abs(depth-uFocusDist)*.085;
  float size=(.011+aSeed.w*.016)*(1.+coc*2.6)*(1.+c*.25)*mix(1., .6, uDetail*c);
  float px=size*uViewH/depth;
  gl_PointSize=clamp(px, 1., 48.)*uPixelRatio;

  float base=.085+.26*uEnergy+.05*uMemory;
  float reveal=pull*(.55*uEnergy+1.1*uHold)+tr*.9;
  float onForm=c*(.5+.5*uCoherence)*uFormVis*mix(1., .3, uDetail);
  float a=base*(1.-c)+reveal*.45*(1.-c*.75)+onForm*.11;
  a*=.72+.28*sin(t*(.4+aSeed.x*1.9)+aSeed.y*40.);
  a*=exp(-depth*.075)*edge;
  a/=(1.+coc*coc*7.);
  a*=min(px,1.)*mix(1., .28, uStill*(1.-c));
  vAlpha=a;

  vec3 col=mix(SILVER, WARM, aSeed.x*.8+.2*c);
  vec3 spec=mix(VIOLET, CYAN, smoothstep(.15,.85, fract(uv.x*2.+uv.y+t*.012)));
  spec=mix(spec, AMBER, step(.9, aSeed.y));
  col=mix(col, spec, uColor*c*(.55+.45*aSeed.z));
  col=mix(col, AMBER, clamp(tr,0.,1.)*uColor*.5);
  vColor=col;
}`;

const frag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main(){
  vec2 p=gl_PointCoord-.5;
  float r2=dot(p,p)*4.;
  if(r2>1.) discard;
  float g=exp(-r2*3.2)-.04;
  gl_FragColor=vec4(vColor, vAlpha*g);
}`;

/** The field: thousands of points that can each be either dust or sculpture. */
export class ParticleField {
  readonly points: Points;

  constructor(q: Quality) {
    const n = q.lite ? 24000 : 72000;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 18;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 10;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 16;
      seed[i * 4] = Math.random();
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new BufferAttribute(seed, 4));
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
    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
  }
}
