import { AdditiveBlending, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { PRELUDE, TRAIL_N } from '../shaders/common';
import { shared, type Quality } from './uniforms';

const vert = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vTrail;
varying float vDepth;
${PRELUDE}
void main(){
  vec3 p=form(uv);
  vec3 pu=form(uv+vec2(.004,0.));
  vec3 pv=form(uv+vec2(0.,.004));
  vNormal=normalize(cross(pu-p, pv-p));
  vWorld=p; vUv=uv;
  float tr=0.;
  for(int i=0;i<${TRAIL_N};i++){ vec3 dd=uTrail[i].xyz-p; tr+=uTrail[i].w*exp(-dot(dd,dd)*1.6); }
  vTrail=tr;
  vec4 mv=viewMatrix*vec4(p,1.);
  vDepth=-mv.z;
  gl_Position=projectionMatrix*mv;
}`;

const frag = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vTrail;
varying float vDepth;
${PRELUDE}
float line(float x, float w){
  float f=abs(fract(x)-.5);
  float fw=fwidth(x);
  return 1.-smoothstep(w*fw, (w+1.2)*fw, f);
}
void main(){
  vec3 N=normalize(vNormal);
  vec3 V=normalize(cameraPosition-vWorld);
  float ndv=abs(dot(N,V));
  float fres=pow(1.-ndv, 3.);

  vec3 df=vWorld-uFocus;
  float prox=exp(-dot(df,df)*.75);
  // visibility is a function of attention: global coherence, local focus, remembered gestures
  float reveal=uFormVis*(uCoherence*uCoherence*.95 + prox*(.3*uEnergy+.95*uHold) + vTrail*.35 + uMemory*.035);

  // a surface that only answers at one angle
  vec3 L=normalize(vec3(sin(uTime*.11), .6+.3*sin(uTime*.07), cos(uTime*.11)));
  float glint=pow(abs(dot(N, normalize(L+V))), 90.);

  // measurement lines drawn on the skin, finer when close
  float iso=line(vUv.x*36.,.0)*.6+line(vUv.y*14.,.0)*.4;
  iso+=uDetail*(line(vUv.x*144.,.0)*.35+line(vUv.y*56.,.0)*.25);

  // one thread of light crossing the invisible object
  float th=abs(fract(vUv.x-uTime*.021)-.5);
  float thread=exp(-th*th*14000.)*(.5+.5*sin(vUv.y*TAU*3.+uTime));
  float th2=abs(fract(vUv.y+uTime*.013)-.5);
  thread+=exp(-th2*th2*22000.)*.6;

  // internal scattering: light held inside the thickness
  float inner=(1.-fres)*(.5+.5*snoise(vWorld*1.7+uTime*.05));

  vec3 film=mix(VIOLET, CYAN, .5+.5*sin(ndv*8.+vUv.x*TAU*2.+uTime*.15));
  film=mix(film, AMBER, pow(fres,2.5)*.55);
  vec3 col=mix(WARM, film*film*1.15, uColor);
  col=mix(col, SILVER, .35*(1.-fres)*(1.-uColor));

  float a=fres*reveal*.2*mix(1., .5, uDetail)
        + iso*reveal*.05*(.4+fres)
        + thread*(reveal*.32+.012)
        + inner*reveal*.012
        + glint*(reveal*.3+.03*(1.-uStill));
  a*=exp(-vDepth*.06);
  gl_FragColor=vec4(col, a);
}`;

/** The skin of the form. It has no body colour at all, only Fresnel rim, glints and threads. */
export class Membrane {
  readonly mesh: Mesh;

  constructor(q: Quality) {
    const geo = new PlaneGeometry(1, 1, q.lite ? 160 : 360, q.lite ? 56 : 112);
    const mat = new ShaderMaterial({
      uniforms: shared,
      vertexShader: vert,
      fragmentShader: frag,
      defines: q.lite ? { LITE: '' } : {},
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }
}
