import { Vector2, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Camera, Scene } from 'three';
import type { Quality } from './uniforms';

/** Final grade: dispersion, obsidian base, haze around attention, vignette, grain. */
const Grade = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAb: { value: 0.0 },
    uGrain: { value: 0.05 },
    uGlow: { value: 0.0 },
    uFocus: { value: new Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uColor: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAb, uGrain, uGlow, uAspect, uColor;
    uniform vec2 uFocus;
    varying vec2 vUv;
    float hash(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
    float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
    void main(){
      vec2 c=vUv-.5;
      float r2=dot(c,c);
      vec2 off=c*(r2*uAb+uAb*.06);
      vec3 col=vec3(texture2D(tDiffuse,vUv-off).r, texture2D(tDiffuse,vUv).g, texture2D(tDiffuse,vUv+off).b);

      // atmosphere: obsidian, never pure black, with slow uneven haze
      float haze=vnoise(vUv*vec2(uAspect,1.)*2.2+uTime*.012)*.6+vnoise(vUv*5.+uTime*.02)*.4;
      vec3 base=vec3(.031,.035,.043)*(1.05-r2*1.9)+vec3(.010,.011,.014)*haze;

      // attention itself is faintly luminous
      vec2 fd=(vUv-uFocus)*vec2(uAspect,1.);
      float g=exp(-dot(fd,fd)*9.);
      vec3 gcol=mix(vec3(.95,.94,.92), vec3(.65,.58,1.), uColor*.6);
      col+=gcol*g*uGlow*(.6+.4*haze);

      col=1.-exp(-col*1.35);            // soft shoulder, no clipping
      col+=base;
      col*=1.-r2*.85;
      float n=hash(gl_FragCoord.xy+fract(uTime)*417.);
      col+=(n-.5)*uGrain*(.5+1.5*dot(col,vec3(.333)));
      gl_FragColor=vec4(max(col,0.),1.);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly after: AfterimagePass | null;
  readonly grade: ShaderPass;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera, q: Quality) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.after = q.reduced ? null : new AfterimagePass(0.8);
    if (this.after) this.composer.addPass(this.after);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.5, 0.9, 0.0);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(Grade);
    this.composer.addPass(this.grade);
  }

  setSize(w: number, h: number, pr: number) {
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  set persistence(v: number) {
    if (this.after) this.after.uniforms['damp'].value = v;
  }
}
