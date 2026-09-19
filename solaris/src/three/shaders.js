/* ══════════════════════════════════════════════════════════════════════
   GLSL used across the scene. Kept as strings so Vite needs no plugins.
   All shaders work in linear space; OutputPass does ACES + sRGB encode.
   ══════════════════════════════════════════════════════════════════════ */

export const GLSL_NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-0.5;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
    + i.y+vec4(0.0,i1.y,i2.y,1.0))
    + i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*vec3(2.0,1.0,0.0)-vec3(1.0,0.5,0.0);
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm3(vec3 p){
  float s=0.0,a=0.5;
  for(int i=0;i<5;i++){ s+=a*snoise(p); p*=2.07; a*=0.5; }
  return s;
}
float fbm3(vec3 p,int oct){
  float s=0.0,a=0.5;
  for(int i=0;i<oct;i++){ s+=a*snoise(p); p*=2.03; a*=0.52; }
  return s;
}
`;

/* ── star: photosphere ────────────────────────────────────────────────── */
export const SUN_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uIntensity;
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uCool;
uniform vec3 uSpot;
varying vec3 vNormalW;
varying vec3 vPosL;
varying vec3 vViewDir;
${GLSL_NOISE}

// signed simplex → 0..1, so every threshold below means what it says
float nrm(float x) { return clamp(x * 0.5 + 0.5, 0.0, 1.0); }

void main(){
  vec3 p = normalize(vPosL);
  float t = uTime * 0.035;

  // granulation: a cellular field advected by a slower, larger plasma flow
  vec3 flow = vec3(fbm3(p * 1.5 + t * 0.6), fbm3(p * 1.3 - t * 0.5 + 12.0), fbm3(p * 1.7 + t * 0.4 + 31.0));
  float gran = nrm(fbm3(p * 6.5 + (flow - 0.5) * 0.9 + vec3(0.0, t * 1.3, 0.0), 4));
  float cell = 1.0 - abs(gran * 2.0 - 1.0);
  float super_ = nrm(fbm3(p * 2.1 + (flow - 0.5) * 0.5 - vec3(t * 0.7, 0.0, t * 0.4)));
  float spots = smoothstep(0.70, 0.90, nrm(fbm3(p * 1.6 + vec3(9.0, -t * 0.3, 4.0))));

  float energy = 0.34 + cell * 0.42 + super_ * 0.5 - spots * 0.34;

  vec3 N = normalize(vNormalW);
  float mu = clamp(dot(N, normalize(vViewDir)), 0.0, 1.0);
  float limb = mix(0.34, 1.0, pow(mu, 0.5));            // limb darkening
  energy = clamp(energy, 0.0, 1.6) * limb;

  vec3 col = mix(uCool, uMid, smoothstep(0.10, 0.58, energy));
  col = mix(col, uHot, smoothstep(0.56, 1.02, energy));
  col = mix(col, uSpot, spots * 0.62);

  // faculae riding the bright network, plus a blowout core for the bloom to grab
  float fil = pow(smoothstep(0.62, 1.0, cell * 0.6 + super_ * 0.6), 2.4);
  col += uHot * fil * 0.85;
  col += vec3(1.0, 0.86, 0.66) * pow(smoothstep(0.72, 1.0, energy), 3.0) * 1.4;

  col *= uIntensity * limb;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const WORLD_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosL;
varying vec3 vViewDir;
void main(){
  vPosL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDir = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* ── star: chromosphere / corona shell ────────────────────────────────── */
export const CORONA_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uColor;
uniform float uPower;
uniform float uStrength;
varying vec3 vNormalW;
varying vec3 vPosL;
varying vec3 vViewDir;
${GLSL_NOISE}
void main(){
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewDir);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uPower);
  vec3 p = normalize(vPosL);
  float t = uTime * 0.06;
  float n = clamp(
    (fbm3(p * 2.4 + vec3(0.0, t, t * 0.4)) * 0.62 + fbm3(p * 6.0 - vec3(t * 0.8, 0.0, 0.0)) * 0.38) * 0.5 + 0.5,
    0.0, 1.0);
  float flick = 0.62 + 0.62 * n;
  // filamentary streamers reaching out from the limb
  float stream = pow(smoothstep(0.55, 1.0, n), 2.0);
  float a = rim * uStrength * flick + stream * rim * uStrength * 0.9;
  gl_FragColor = vec4(uColor * a * 2.6, a);
}
`;

/* ── planets ──────────────────────────────────────────────────────────── */
export const PLANET_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vUv;
varying vec3 vPosL;
void main(){
  vUv = uv;
  vPosL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PLANET_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform sampler2D uNormalMap;
uniform sampler2D uRoughMap;
uniform sampler2D uNightMap;
uniform vec3 uSunPos;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAtmoColor;
uniform float uAtmoStrength;
uniform float uBump;
uniform float uTime;
uniform float uHasNight;
uniform float uHighlight;
uniform float uRing;          // 0 / 1
uniform vec3 uRingCenter;
uniform vec3 uRingNormal;
uniform vec2 uRingSpan;
uniform sampler2D uRingTex;
uniform vec3 uAmbient;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vUv;
varying vec3 vPosL;

void main(){
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);

  // tangent frame from screen-space derivatives: no extra vertex attributes
  vec3 dPos1 = dFdx(vWorld);
  vec3 dPos2 = dFdy(vWorld);
  vec2 dUv1 = dFdx(vUv);
  vec2 dUv2 = dFdy(vUv);
  float det = dUv1.x * dUv2.y - dUv2.x * dUv1.y;
  if (abs(det) > 1e-8) {
    vec3 T = normalize((dUv2.y * dPos1 - dUv1.y * dPos2) / det);
    vec3 B = normalize((dUv1.x * dPos2 - dUv2.x * dPos1) / det);
    vec3 mapN = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
    N = normalize(mat3(T, B, N) * vec3(mapN.xy * uBump, max(mapN.z, 0.2)));
  }

  vec3 L = normalize(uSunPos - vWorld);
  vec4 roughTex = texture2D(uRoughMap, vUv);
  float rough = clamp(roughTex.r, 0.02, 1.0);
  float specMask = roughTex.b;

  float wrap = 0.16;
  float ndl = dot(N, L);
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  diff = pow(diff, 1.12);

  vec3 albedo = texture2D(uMap, vUv).rgb;
  vec3 light = uSunColor * uSunIntensity;

  vec3 col = albedo * diff * light;

  // specular: oceans for Earth, faint sheen elsewhere
  vec3 H = normalize(L + V);
  float ndh = clamp(dot(N, H), 0.0, 1.0);
  float gloss = mix(110.0, 8.0, rough);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  float spec = pow(ndh, gloss) * (0.02 + specMask * 0.9) * (1.0 - rough * 0.6);
  col += light * spec * 0.65;
  col += light * fres * 0.05 * (1.0 - rough);

  // ring shadow, analytic: surface point → sun ray vs. ring plane
  if (uRing > 0.5) {
    float denom = dot(L, uRingNormal);
    if (abs(denom) > 1e-4) {
      float tt = dot(uRingCenter - vWorld, uRingNormal) / denom;
      if (tt > 0.0) {
        vec3 hit = vWorld + L * tt;
        float r = length(hit - uRingCenter);
        float u = clamp((r - uRingSpan.x) / max(uRingSpan.y - uRingSpan.x, 0.001), 0.0, 1.0);
        float alpha = texture2D(uRingTex, vec2(u, 0.5)).a;
        col *= 1.0 - alpha * 0.82;
      }
    }
  }

  // night side: city lights + a whisper of starlight so the dark isn't dead
  float terminator = 1.0 - smoothstep(-0.12, 0.24, ndl);
  if (uHasNight > 0.5) {
    vec3 night = texture2D(uNightMap, vUv).rgb;
    col += night * terminator * 1.55;
  }
  col += albedo * uAmbient * (0.25 + terminator * 0.75);

  // atmospheric scattering: rim glow, stronger on the lit limb and around
  // the terminator (twilight ring), plus forward scattering when backlit
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.4);
  float scatter = smoothstep(-0.45, 0.75, ndl);
  float twilight = exp(-pow((ndl - 0.02) * 3.4, 2.0)) * 0.5;
  col += uAtmoColor * uAtmoStrength * rim * (scatter * 1.35 + twilight) * light * 0.9;

  // hover / selection feedback
  col += uAtmoColor * uHighlight * (0.10 + rim * 0.5);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ── cloud shells ─────────────────────────────────────────────────────── */
export const CLOUD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uSunPos;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uColor;
uniform vec3 uAtmoColor;
uniform float uTime;
uniform float uOpacity;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vUv;

void main(){
  vec4 tex = texture2D(uMap, vUv + vec2(uTime * 0.0009, 0.0));
  float a = tex.a * uOpacity;
  if (a < 0.008) discard;
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunPos - vWorld);
  float ndl = dot(N, L);
  float diff = clamp((ndl + 0.2) / 1.2, 0.0, 1.0);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
  vec3 col = uColor * uSunColor * uSunIntensity * (diff * 0.95 + 0.04);
  col += uAtmoColor * rim * 0.35 * clamp(ndl * 2.0, 0.0, 1.0);
  // soft edge so the shell never shows a hard silhouette
  a *= smoothstep(0.0, 0.22, dot(N, V) + 0.06);
  gl_FragColor = vec4(col, a);
}
`;

/* ── outer atmosphere halo ────────────────────────────────────────────── */
export const ATMO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunPos;
uniform vec3 uCenter;
uniform vec3 uColor;
uniform float uStrength;
uniform float uPower;
varying vec3 vWorld;
varying vec3 vNormalW;

void main(){
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunPos - vWorld);
  vec3 radial = normalize(vWorld - uCenter);
  // halo thickness peaks on the limb, in both silhouette directions
  float rim = pow(clamp(1.0 - abs(dot(radial, V)), 0.0, 1.0), uPower);
  float lit = smoothstep(-0.55, 0.6, dot(radial, L));
  float back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * (1.0 - lit);
  float a = rim * uStrength * (0.16 + lit * 1.15 + back * 0.7);
  gl_FragColor = vec4(uColor * a * 2.2, a);
}
`;

/* ── rings ────────────────────────────────────────────────────────────── */
export const RING_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uSunPos;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uOpacity;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vUv;

void main(){
  vec4 tex = texture2D(uMap, vec2(vUv.x, 0.5));
  float alpha = tex.a * uOpacity;
  if (alpha < 0.004) discard;
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunPos - vWorld);

  // Lambert on both faces of a very thin disc
  float facing = abs(dot(N, L));
  float diff = 0.18 + facing * 0.95;

  // planet shadow: sphere vs. the ray toward the sun
  vec3 oc = uPlanetCenter - vWorld;
  float proj = dot(oc, L);
  float shadow = 1.0;
  if (proj > 0.0) {
    float d = sqrt(max(dot(oc, oc) - proj * proj, 0.0));
    shadow = smoothstep(uPlanetRadius * 0.82, uPlanetRadius * 1.12, d);
  }

  // ice scatters forward: rings glow when you look through them sunward
  float fwd = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0);
  float viewGraze = clamp(1.0 - abs(dot(N, V)), 0.0, 1.0);

  vec3 col = tex.rgb * uSunColor * uSunIntensity * diff * mix(0.14, 1.0, shadow);
  col += tex.rgb * uSunColor * fwd * 0.75 * alpha;
  col *= mix(1.0, 1.5, viewGraze * 0.5);
  float a = alpha * (0.55 + fwd * 0.45 + viewGraze * 0.25);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

export const RING_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* ── starfield: instanced billboards that stretch into warp streaks ───── */
export const STARS_VERT = /* glsl */ `
precision highp float;
attribute vec3 aPos;
attribute vec2 aSeed;    // x: base size, y: phase
attribute float aTemp;   // colour temperature 0..1
uniform float uTime;
uniform float uWarp;
uniform float uPixelRatio;
uniform float uSizeScale;
varying float vTemp;
varying float vFade;
varying vec2 vQuad;
void main(){
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float dist = max(-mv.z, 0.001);
  float size = aSeed.x * uSizeScale * (300.0 / dist);

  // radial streak direction in view space, from screen centre outward
  vec2 dir = normalize(mv.xy + vec2(1e-5));
  float perp = abs(dot(normalize(aPos.xy + vec2(1e-5)), dir));
  vec2 q = uv * 2.0 - 1.0;
  float along = q.y * (1.0 + uWarp * (14.0 + 34.0 * perp));
  vec2 off = dir * along * size + vec2(-dir.y, dir.x) * q.x * size;

  mv.xy += off;
  mv.z -= uWarp * size * 8.0;

  vTemp = aTemp;
  vQuad = q;
  vFade = 1.0 - smoothstep(0.0, 1.0, uWarp) * 0.25;
  float tw = 0.72 + 0.3 * sin(uTime * (1.3 + aSeed.y * 2.4) + aSeed.y * 33.0);
  vFade *= tw;
  gl_Position = projectionMatrix * mv;
}
`;

export const STARS_FRAG = /* glsl */ `
precision highp float;
uniform float uWarp;
uniform float uExposure;
varying float vTemp;
varying float vFade;
varying vec2 vQuad;
void main(){
  vec2 p = vQuad;
  // round dot when calm, an elongated streak while warping
  float r = length(vec2(p.x, p.y));
  float core = smoothstep(1.0, 0.0, r);
  float glow = pow(core, 3.0);
  float len = 1.0 + uWarp * 20.0;
  float streak = exp(-abs(p.x) * 3.0) * exp(-abs(p.y / len) * 1.6);
  float a = glow * 0.9 + clamp(streak * uWarp * 1.4, 0.0, 1.0);
  vec3 cool = vec3(0.62, 0.74, 1.0);
  vec3 warm = vec3(1.0, 0.82, 0.62);
  vec3 col = mix(cool, warm, vTemp);
  col = mix(col, vec3(1.0), 0.35);
  gl_FragColor = vec4(col * a * uExposure * vFade, a * vFade);
}
`;

/* ── deep sky: nebula + milky way on a giant inverted sphere ──────────── */
export const SKY_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform float uExposure;
varying vec3 vPosL;
${GLSL_NOISE}
void main(){
  vec3 d = normalize(vPosL);
  float t = uTime * 0.004;
  float n = fbm3(d * 2.4 + vec3(t, 0.0, -t)) * 0.6 + fbm3(d * 6.0 - vec3(0.0, t, 0.0)) * 0.4;
  float n01 = clamp(n * 0.5 + 0.5, 0.0, 1.0);
  float clouds = pow(n01, 2.6);
  // galactic band: a bright, dust-mottled strip across the sky
  float band = exp(-pow((d.y + 0.2 + n * 0.14) * 2.7, 2.0));
  float dust = clamp(fbm3(d * 8.0 + 40.0) * 0.5 + 0.5, 0.0, 1.0);
  band *= 0.45 + 0.85 * smoothstep(0.2, 0.7, dust);
  float wisps = pow(smoothstep(0.5, 1.0, n01), 3.0) * band;

  vec3 col = mix(uA, uB, clouds) * 0.16;
  col += uC * band * 0.5;
  col += uB * wisps * 0.35;
  col *= uExposure;
  // a faint floor of starlight so empty space is never pure black
  col += vec3(0.006, 0.008, 0.016);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const SKY_VERT = /* glsl */ `
varying vec3 vPosL;
void main(){
  vPosL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;   // pin to the far plane
}
`;

/* ── orbit tracks: fade with distance, comet-tail highlight on the body ─ */
export const ORBIT_VERT = /* glsl */ `
attribute float aAngle;
uniform float uPhase;
uniform float uFadeNear;
uniform float uFadeFar;
varying float vA;
varying float vTail;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  float near = 1.0 - smoothstep(0.0, uFadeNear, dist);
  float far = smoothstep(uFadeFar, uFadeFar * 0.35, dist);
  float tail = fract(uPhase - aAngle);
  vTail = exp(-tail * 26.0) + exp(-(1.0 - tail) * 90.0) * 0.5;
  vA = (0.10 + vTail * 0.9) * mix(0.35, 1.0, near) * far;
  gl_Position = projectionMatrix * mv;
}
`;
export const ORBIT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vA;
varying float vTail;
void main(){
  gl_FragColor = vec4(uColor * (0.35 + vTail * 1.8), vA * 0.85);
}
`;

/* ── HUD reticle drawn in world space around the focused body ─────────── */
export const RETICLE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uTime;
uniform float uOpen;
varying vec2 vUv;
void main(){
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float open = clamp(uOpen, 0.0, 1.0);
  float ring = smoothstep(0.985, 0.97, r) * smoothstep(0.86, 0.885, r);
  // ticks, longer every 90°
  float tick = step(0.5, fract((ang + 3.14159) / 6.28318 * 24.0));
  float band = smoothstep(0.9, 0.86, r);
  float ticks = band * tick * step(0.86, r);
  // sweeping radar arc
  float sweep = fract((ang + 3.14159) / 6.28318 - uTime * 0.16);
  float arc = pow(1.0 - sweep, 7.0) * smoothstep(0.99, 0.75, r) * step(0.75, r);
  // brackets
  float bracket = smoothstep(0.99, 0.94, r) * step(0.9, r) *
    (1.0 - step(0.18, abs(fract((ang + 3.14159) / 6.28318 * 4.0) - 0.5) ));
  float a = (ring * 0.8 + ticks * 0.75 + arc * 0.5 + bracket * 0.9) * open;
  gl_FragColor = vec4(uColor * (0.6 + arc * 1.6), a);
}
`;
export const RETICLE_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ── final grade: CA, grain, vignette, filmic tint ───────────────────── */
export const GRADE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uWarp;
uniform float uVignette;
uniform float uGrain;
uniform vec2 uRes;
uniform vec2 uSunScreen;
uniform float uSunVis;
varying vec2 vUv;

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main(){
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  // chromatic aberration grows with travel speed
  float ca = (0.0012 + uWarp * 0.0075) * (0.25 + r2 * 2.2);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + c * ca).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - c * ca).b;

  // anamorphic streak from the sun, smeared across the frame
  vec2 sc = (uv - uSunScreen) * vec2(uRes.x / uRes.y, 1.0);
  float streak = exp(-abs(sc.y) * 190.0) * exp(-abs(sc.x) * 1.6);
  col += vec3(1.0, 0.72, 0.42) * streak * uSunVis * (0.16 + uWarp * 0.2);

  // teal shadows / warm highlights
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, col * vec3(0.86, 0.95, 1.16), smoothstep(0.45, 0.02, luma) * 0.5);
  col = mix(col, col * vec3(1.06, 1.0, 0.9), smoothstep(0.5, 1.4, luma) * 0.35);

  // vignette + slight bleed toward black at the corners
  float vig = 1.0 - r2 * uVignette;
  col *= clamp(vig, 0.0, 1.0);

  // film grain, animated
  float g = hash12(uv * uRes + fract(uTime) * 137.0) - 0.5;
  col += g * uGrain * (0.6 + 0.8 * (1.0 - luma));

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ── probe trail / energy ribbons ─────────────────────────────────────── */
export const TRAIL_VERT = /* glsl */ `
attribute float aT;
varying float vT;
void main(){
  vT = aT;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const TRAIL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
varying float vT;
void main(){
  float a = pow(clamp(vT, 0.0, 1.0), 2.2) * uOpacity;
  gl_FragColor = vec4(uColor * (0.5 + a * 2.0), a);
}
`;
