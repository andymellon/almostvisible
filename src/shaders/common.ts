/**
 * GLSL shared by every visual system. Particles, membrane and filaments all
 * evaluate the same `form()` function, so they are literally one organism:
 * a single parametric surface seen as points, as skin and as threads.
 */

export const TRAIL_N = 16;

export const UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3  uMorph;      // blend weights of the three topologies
uniform float uDeform;     // fbm displacement amount
uniform mat3  uFormRot;    // slow tumble + elastic response
uniform vec3  uFocus;      // point of attention, world space
uniform float uPull;       // sprung bulge toward attention
uniform float uCoherence;  // 0 dissolved .. 1 coherent
uniform float uEnergy;     // unified perceptual energy
uniform float uTurb;       // turbulence from fast gestures
uniform float uHold;       // focused attention
uniform float uColor;      // spectral colour unlocked by depth
uniform float uMemory;     // afterimage residue
uniform float uStill;      // periodic approach to stillness
uniform float uFormVis;    // distance based visibility of the form
uniform float uDetail;     // closeness based detail
uniform vec3  uCamDir;
uniform float uFocusDist;
uniform float uPixelRatio;
uniform float uViewH;
uniform vec4  uTrail[${TRAIL_N}]; // xyz + strength : spatial memory of gestures

const float TAU = 6.28318530718;
const vec3 WARM   = vec3(0.949, 0.941, 0.918);
const vec3 SILVER = vec3(0.682, 0.714, 0.737);
const vec3 VIOLET = vec3(0.651, 0.576, 1.000);
const vec3 CYAN   = vec3(0.549, 0.898, 0.918);
const vec3 AMBER  = vec3(0.910, 0.741, 0.545);
`;

export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){
  float a=.5, s=0.;
  for(int i=0;i<3;i++){ s+=a*snoise(p); p=p*2.03+vec3(17.1,3.7,9.2); a*=.5; }
  return s;
}
vec3 snoise3(vec3 x){
  return vec3(snoise(x), snoise(vec3(x.y-19.1,x.z+33.4,x.x+47.2)), snoise(vec3(x.z+74.2,x.x-124.5,x.y+99.4)));
}
#ifdef LITE
vec3 curl(vec3 p){
  return vec3(sin(p.y*1.7+p.z*1.3)+cos(p.z*2.1), sin(p.z*1.9+p.x*1.1)+cos(p.x*2.3), sin(p.x*1.5+p.y*1.2)+cos(p.y*2.7))*.6;
}
#else
vec3 curl(vec3 p){
  const float e=.12;
  vec3 dx=vec3(e,0.,0.), dy=vec3(0.,e,0.), dz=vec3(0.,0.,e);
  vec3 x0=snoise3(p-dx), x1=snoise3(p+dx);
  vec3 y0=snoise3(p-dy), y1=snoise3(p+dy);
  vec3 z0=snoise3(p-dz), z1=snoise3(p+dz);
  return vec3(y1.z-y0.z-z1.y+z0.y, z1.x-z0.x-x1.z+x0.z, x1.y-x0.y-y1.x+y0.x)/(2.*e);
}
#endif
`;

export const FORM = /* glsl */ `
// Figure-eight immersion of the Klein bottle: a surface with no inside.
vec3 formKlein(float u,float v){
  float cu=cos(u*.5), su=sin(u*.5);
  float w=2.+cu*sin(v)-su*sin(2.*v);
  return vec3(w*cos(u), w*sin(u), su*sin(v)+cu*sin(2.*v))*.66;
}
// A trefoil wound on a torus, with a breathing cross-section.
vec3 formKnot(float u,float v){
  float rho=.36+.12*sin(3.*u+v);
  float w=1.6+.66*cos(3.*u)+rho*cos(v);
  return vec3(w*cos(2.*u), w*sin(2.*u), .66*sin(3.*u)+rho*sin(v))*.84;
}
// A flattened band with three half-twists: a thick Moebius membrane.
vec3 formBand(float u,float v){
  float tw=1.5*u;
  float a=1.05+.25*sin(2.*u), b=.26;
  float cx=a*cos(v), cy=b*sin(v);
  float px=cx*cos(tw)-cy*sin(tw), pz=cx*sin(tw)+cy*cos(tw);
  float w=1.75+px;
  return vec3(w*cos(u), w*sin(u), pz)*.86;
}
vec3 form(vec2 uv){
  float u=uv.x*TAU, v=uv.y*TAU;
  vec3 p=uMorph.x*formKlein(u,v)+uMorph.y*formKnot(u,v)+uMorph.z*formBand(u,v);
  float n=fbm(p*.5+vec3(0.,0.,uTime*.06));
  p+=normalize(p+1e-4)*n*uDeform;
  p=uFormRot*p;
  vec3 d=uFocus-p;
  p+=d*exp(-dot(d,d)*1.1)*uPull;   // elastic bulge toward attention
  return p;
}
`;

export const PRELUDE = UNIFORMS + NOISE + FORM;
