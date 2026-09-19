import * as THREE from 'three';
import { clamp, rng, smoothstep, mix } from './math.js';
import { value3, stampCraters, heightToNormal } from './noise.js';

/* ── palette helpers ──────────────────────────────────────────────────── */

function toRGB(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** multi-stop ramp over hex colours; t in 0..1 */
function ramp(stops) {
  const cols = stops.map((c) => (typeof c === 'string' ? toRGB(c) : c));
  return (t, out) => {
    const x = clamp(t) * (cols.length - 1);
    const i = Math.min(cols.length - 2, Math.floor(x));
    const f = x - i;
    const a = cols[i];
    const b = cols[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * f;
    out[1] = a[1] + (b[1] - a[1]) * f;
    out[2] = a[2] + (b[2] - a[2]) * f;
    return out;
  };
}

/**
 * fbm that is seamless in longitude: the u axis is wrapped onto a circle in the
 * noise field, so `freqU` is a *cycle count* around the planet and `freqV` a
 * cycle count from pole to pole. (Working in cycles, not texels, is what keeps
 * features round instead of smeared into meridians.)
 */
function makeFbm(w, freqU, freqV, octaves = 5, gain = 0.5, seed = 0) {
  const ru = freqU / (Math.PI * 2);
  return (u, v, zShift = 0) => {
    let amp = 0.5,
      sum = 0,
      norm = 0,
      f = 1,
      r = ru;
    const a = u * Math.PI * 2;
    const ca = Math.cos(a),
      sa = Math.sin(a);
    for (let i = 0; i < octaves; i++) {
      sum += amp * value3(ca * r + 7.2, v * freqV * f + 3.4 + zShift, sa * r - 2.1 + seed);
      norm += amp;
      amp *= gain;
      f *= 2.02;
      r *= 2.02;
    }
    return sum / norm;
  };
}

/* ── surface painters (one per planet family) ─────────────────────────── */

/** fold the height field back into the albedo: crater rims, ejecta, floors */
function shadeFromHeight(data, height, w, h, amount = 0.5, slope = 0) {
  if (amount) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < w * h; i++) {
      const v = height[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const span = mx - mn || 1;
    for (let i = 0; i < w * h; i++) {
      const t = clamp((height[i] - mn) / span - 0.45) * amount;
      const o = i * 4;
      data[o] *= 1 + t;
      data[o + 1] *= 1 + t * 0.94;
      data[o + 2] *= 1 + t * 0.86;
    }
  }
  if (slope) {
    // cheap baked aspect shading: sunlit vs shaded crater walls. Keeps relief
    // readable even where the dynamic normal map is mip-filtered away.
    for (let y = 0; y < h; y++) {
      const up = ((y - 1 + h) % h) * w;
      const dn = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) {
        const l = y * w + ((x - 1 + w) % w);
        const r = y * w + ((x + 1) % w);
        const dy = height[dn + x] - height[up + x];
        const dx = height[r] - height[l];
        const a = (clamp(0.5 + (dx * 0.62 + dy * 0.78) * slope, 0, 1) - 0.5) * 0.85;
        const o = (y * w + x) * 4;
        const k = 1 + a;
        data[o] *= k;
        data[o + 1] *= k;
        data[o + 2] *= k;
      }
    }
  }
}

function paintRocky(ctx) {
  const { w, h, height, data, spec } = ctx;
  const base = makeFbm(w, 6, 3.4, 6, 0.55, spec.seed);
  const detail = makeFbm(w, 22, 13, 4, 0.5, spec.seed + 3);
  const mare = makeFbm(w, 2.6, 1.8, 3, 0.62, spec.seed + 9);
  const col = ramp(spec.palette);
  const c = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      const n = base(u, v);
      const d = detail(u, v);
      const m = mare(u, v, 1.5);
      const mareMask = smoothstep(0.6, 0.72, m);
      let t = 0.36 + n * 0.5 + (d - 0.5) * 0.2;
      t += Math.pow(Math.abs(v - 0.5) * 2, 5) * 0.1;
      height[i] = (n - 0.5) * 0.5 + (d - 0.5) * 0.16;
      col(clamp(t), c);
      const lm = 1 - mareMask * 0.34;
      const o = i * 4;
      data[o] = c[0] * lm;
      data[o + 1] = c[1] * lm * 0.99;
      data[o + 2] = c[2] * lm * 0.97;
    }
  }
  if (spec.craters) {
    const dens = mareField(ctx, mare, 0.55, 0.7);
    stampCraters(height, w, h, spec.craters, rng(spec.seed * 7 + 3), { minScale: 0.2, maxScale: 1.0, rim: 0.3, depth: -0.44, density: dens });
    stampCraters(height, w, h, Math.round(spec.craters * 0.16), rng(spec.seed * 31 + 9), { minScale: 1.1, maxScale: 3.1, rim: 0.36, depth: -0.3 });
  }
  shadeFromHeight(data, height, w, h, 0.4, 0.34);
}

function paintMars(ctx) {
  const { w, h, height, data, spec } = ctx;
  const base = makeFbm(w, 5.5, 3.4, 6, 0.55, spec.seed);
  const dark = makeFbm(w, 2.6, 2, 3, 0.62, spec.seed + 5);
  const dune = makeFbm(w, 34, 16, 3, 0.5, spec.seed + 11);
  const col = ramp(spec.palette);
  const c = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const latAbs = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      const n = base(u, v);
      const d = dark(u, v, 0.4);
      const g = dune(u, v);
      height[i] = (n - 0.5) * 0.62 + (g - 0.5) * 0.07;
      // Valles Marineris: a narrow trough dragged across the south
      const canyon = Math.exp(-Math.pow((v - 0.6) / 0.017, 2)) * smoothstep(0.14, 0.3, u) * smoothstep(0.6, 0.46, u);
      height[i] -= canyon * 0.7;
      // Tharsis bulge + a shield volcano on top of it
      const bulge = Math.exp(-Math.pow((u - 0.3) / 0.1, 2)) * Math.exp(-Math.pow((v - 0.42) / 0.09, 2));
      const volc = Math.exp(-Math.pow((u - 0.29) / 0.022, 2)) * Math.exp(-Math.pow((v - 0.44) / 0.018, 2));
      height[i] += bulge * 0.62 + volc * 0.55;
      let t = 0.3 + n * 0.44 - (d - 0.5) * 0.36 + (g - 0.5) * 0.1;
      col(clamp(t), c);
      // frost caps that only settle on the cold poles
      const cap = smoothstep(0.86, 0.97, latAbs + (n - 0.5) * 0.2);
      const o = i * 4;
      data[o] = c[0] + (244 - c[0]) * cap;
      data[o + 1] = c[1] + (240 - c[1]) * cap;
      data[o + 2] = c[2] + (236 - c[2]) * cap;
    }
  }
  if (spec.craters) {
    const dens = mareField(ctx, dark, 0.42, 0.68);
    stampCraters(height, w, h, spec.craters, rng(spec.seed * 13 + 1), { minScale: 0.2, maxScale: 0.95, rim: 0.26, depth: -0.36, density: dens });
    stampCraters(height, w, h, Math.round(spec.craters * 0.1), rng(spec.seed * 23 + 5), { minScale: 1.2, maxScale: 3.4, rim: 0.3, depth: -0.26 });
  }
  shadeFromHeight(data, height, w, h, 0.3, 0.3);
}

/**
 * Gas giants: coherent latitude belts, sheared by anisotropic turbulence
 * (long in longitude, thin across latitude) so the flow reads like weather.
 */
function paintBands(ctx) {
  const { w, h, height, data, spec } = ctx;
  const bands = spec.bands ?? 15;
  const soft = spec.softness ?? 0.42;
  const shear = makeFbm(w, 3.2, 15, 5, 0.56, spec.seed);
  const eddy = makeFbm(w, 7, 30, 4, 0.5, spec.seed + 7);
  const fine = makeFbm(w, 20, 62, 3, 0.52, spec.seed + 15);
  const col = ramp(spec.palette);
  const c = [0, 0, 0];
  const spot = spec.spot ? toRGB(typeof spec.spot === 'string' ? spec.spot : '#b5533a') : null;
  const spotU = 0.68,
    spotV = 0.585,
    spotW = 0.075,
    spotH = 0.032;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      const s1 = shear(u, v, 0) - 0.5;
      const s2 = eddy(u, v, 2.2) - 0.5;
      const f = fine(u, v) - 0.5;
      // differential rotation: the belts wander, the poles barely move
      const latN = Math.abs(v - 0.5) * 2;
      const warp = s1 * 0.3 + s2 * 0.1 + f * 0.035;
      const vv = v + warp * (0.55 - latN * 0.2);
      let b = Math.sin(vv * bands * Math.PI * 2) * 0.5 + 0.5;
      b = smoothstep(0.5 - soft, 0.5 + soft, b);
      const interleave = Math.sin(vv * bands * Math.PI * 4 + s2 * 2.4) * 0.5 + 0.5;
      let t = 0.16 + b * 0.6 + interleave * 0.08 + f * 0.1 + s2 * 0.06;
      t *= 1 - Math.pow(latN, 2.2) * 0.3;
      height[i] = b * 0.1 + f * 0.05;
      col(clamp(t), c);
      let r = c[0],
        g = c[1],
        bl = c[2];
      if (spot) {
        const du = Math.min(Math.abs(u - spotU), 1 - Math.abs(u - spotU)) / spotW;
        const dv = (v - spotV) / spotH;
        const dd = Math.sqrt(du * du + dv * dv);
        const m = smoothstep(1.02, 0.5, dd);
        const swirlT = 0.6 + fine(u * 2.2, v * 2.2) * 0.6;
        r += (spot[0] * swirlT * 1.55 - r) * m;
        g += (spot[1] * swirlT * 1.4 - g) * m;
        bl += (spot[2] * swirlT * 1.3 - bl) * m;
        height[i] -= m * 0.1;
      }
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = bl;
    }
  }
}

/** Venus: thick, slow, sulphuric — broad soft bands and a bright polar collar */
function paintSwirl(ctx) {
  const { w, h, height, data, spec } = ctx;
  const big = makeFbm(w, 3.4, 5.5, 5, 0.58, spec.seed);
  const mid = makeFbm(w, 8, 14, 4, 0.5, spec.seed + 6);
  const col = ramp(spec.palette);
  const c = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const latN = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      const b1 = big(u, v, 0);
      const b2 = mid(u, v, 1.5);
      // V-shaped aphrodite-pateres style waves wrapped around the equator
      const wave = Math.sin((v - 0.5) * 22 + (b1 - 0.5) * 9) * 0.5 + 0.5;
      let t = 0.34 + b1 * 0.34 + b2 * 0.12 + wave * 0.12;
      t += Math.pow(latN, 3) * 0.12;
      height[i] = (b1 - 0.5) * 0.1 + (b2 - 0.5) * 0.04;
      col(clamp(t), c);
      const o = i * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
    }
  }
}

/** ice giants: near-featureless methane haze, a few bright convective plumes */
function paintIce(ctx) {
  const { w, h, height, data, spec } = ctx;
  const bands = spec.bands ?? 9;
  const soft = spec.softness ?? 0.8;
  const turb = makeFbm(w, 3.4, 7, 5, 0.52, spec.seed);
  const puff = makeFbm(w, 11, 17, 5, 0.55, spec.seed + 4);
  const col = ramp(spec.palette);
  const c = [0, 0, 0];
  const spot = spec.spot ? toRGB(spec.spot) : null;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      const t1 = turb(u, v);
      const p = puff(u, v, 1.1);
      const latN = Math.abs(v - 0.5) * 2;
      const b = Math.sin((v + (t1 - 0.5) * 0.2) * bands * Math.PI * 2) * 0.5 + 0.5;
      let t = 0.26 + smoothstep(0.5 - soft, 0.5 + soft, b) * 0.3 + (p - 0.5) * 0.3 + latN * 0.12;
      height[i] = (p - 0.5) * 0.09 + (t1 - 0.5) * 0.05;
      col(clamp(t), c);
      let r = c[0],
        g = c[1],
        bl = c[2];
      if (spot) {
        const du = Math.min(Math.abs(u - 0.42), 1 - Math.abs(u - 0.42)) / 0.07;
        const dv = (v - 0.63) / 0.03;
        const m = smoothstep(1.05, 0.35, Math.sqrt(du * du + dv * dv));
        r += (spot[0] - r) * m * 0.8;
        g += (spot[1] - g) * m * 0.8;
        bl += (spot[2] - bl) * m * 0.8;
      }
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = bl;
    }
  }
}

/** highlands are old and battered, maria are young and smooth — reuse the
 *  large-scale field that drove the albedo so relief and colour agree */
function mareField(ctx, fieldFn, lo, hi) {
  const { w, h } = ctx;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) out[y * w + x] = smoothstep(hi, lo, fieldFn(x / w, v, 1.5));
  }
  return out;
}

function paintEarth(ctx, extra) {
  const { w, h, height, data, spec } = ctx;
  const land = makeFbm(w, 4.6, 3.1, 7, 0.52, spec.seed);
  const detail = makeFbm(w, 15, 10, 5, 0.5, spec.seed + 6);
  const arid = makeFbm(w, 3.4, 4.4, 4, 0.6, spec.seed + 12);
  const shelf = makeFbm(w, 8, 6, 4, 0.55, spec.seed + 21);
  const ocean = makeFbm(w, 2.2, 1.8, 3, 0.6, spec.seed + 27);
  const c = [0, 0, 0];
  const night = extra.night;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const latAbs = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      const n = land(u, v);
      const d = detail(u, v);
      const s = shelf(u, v);
      const a = arid(u, v);
      const o2 = ocean(u, v, 0.5);
      const elevation = (n - 0.5) * 1.5 + (d - 0.5) * 0.46 + (s - 0.5) * 0.2;
      const sea = 0.035;
      const isLand = elevation > sea;
      const iceCap = smoothstep(0.8, 0.96, latAbs + (n - 0.5) * 0.2);
      let r, g, b, rough, nightV;
      if (isLand) {
        const alt = clamp((elevation - sea) * 2.6);
        const dry = smoothstep(0.44, 0.74, a) * Math.exp(-Math.pow((latAbs - 0.29) / 0.15, 2));
        const cold = smoothstep(0.5, 0.78, latAbs);
        // veg → ochre → rock → snow
        r = 46 + alt * 118 + dry * 96;
        g = 74 + alt * 88 + dry * 62;
        b = 40 + alt * 78 + dry * 22;
        r = mix(r, 150, cold * 0.35);
        g = mix(g, 142, cold * 0.35);
        b = mix(b, 128, cold * 0.35);
        const snow = smoothstep(0.62, 0.9, alt + cold * 0.5);
        r = mix(r, 238, snow);
        g = mix(g, 242, snow);
        b = mix(b, 246, snow);
        r = mix(r, 236, iceCap);
        g = mix(g, 241, iceCap);
        b = mix(b, 246, iceCap);
        rough = 0.82;
        height[i] = 0.1 + elevation * 0.5 + (d - 0.5) * 0.3;
        const pop =
          smoothstep(0.5, 0.74, detail(u, v, 4) * 0.6 + clamp((elevation - sea) * 4) * 0.5) *
          (1 - smoothstep(0.55, 0.88, latAbs)) *
          smoothstep(0.0, 0.07, elevation) *
          (1 - dry * 0.5);
        nightV = pop;
      } else {
        const depth = clamp((sea - elevation) * 2.6);
        const tropic = 1 - latAbs * 0.35;
        r = mix(8, 26, 1 - depth) + (o2 - 0.5) * 8;
        g = mix(30, 76, 1 - depth) + (o2 - 0.5) * 10;
        b = mix(52, 122, 1 - depth) * (0.86 + tropic * 0.2);
        r = mix(r, 232, iceCap);
        g = mix(g, 238, iceCap);
        b = mix(b, 244, iceCap);
        rough = 0.05;
        height[i] = -0.08 + (s - 0.5) * 0.04;
        nightV = 0;
      }
      const oc = i * 4;
      data[oc] = r;
      data[oc + 1] = g;
      data[oc + 2] = b;
      extra.rough[i] = rough * 255;
      extra.spec[i] = isLand ? 0 : 1;
      night[i] = nightV;
    }
  }
}

/* ── cloud layers ─────────────────────────────────────────────────────── */

const PAINTERS = { rocky: paintRocky, mars: paintMars, bands: paintBands, ice: paintIce, earth: paintEarth, swirl: paintSwirl };

function bakeCloud(w, h, kind, seed, turb = 5.5, coverage = 0.52) {
  const data = new Uint8ClampedArray(w * h * 4);
  const big = makeFbm(w, kind === 'venus' ? 4.5 : 6.5, kind === 'venus' ? 2.2 : 4.2, 7, 0.55, seed + 31);
  const small = makeFbm(w, 19, 13, 4, 0.5, seed + 44);
  const lat = makeFbm(w, 2, 6, 3, 0.6, seed + 61);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const latAbs = Math.abs(v - 0.5) * 2;
    // hadley-cell banding: bands of plenty near the equator and 60°
    const cell = 0.5 + 0.5 * Math.cos((v - 0.5) * Math.PI * 6);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      let n = big(u, v) * 0.72 + small(u, v) * 0.28 + (lat(u, v) - 0.5) * 0.2;
      if (kind === 'venus') n = n * 0.7 + cell * 0.3;
      else n = n * (0.9 + cell * 0.24);
      const a = smoothstep(coverage, coverage + turb * 0.07, n) * (1 - Math.pow(latAbs, 6) * 0.4);
      const o = (y * w + x) * 4;
      const g = 255;
      data[o] = data[o + 1] = data[o + 2] = g;
      data[o + 3] = clamp(a) * 255;
    }
  }
  return data;
}

/* ── rings ────────────────────────────────────────────────────────────── */

/** the ring ramp is shared with the preview tool so the size can never drift
 *  away from the buffer the writer fills (it did: `w*4` vs a 4-row loop) */
export const RING_TEX = { w: 1024, h: 4 };

function bakeRing(kind, seed = 5) {
  const w = RING_TEX.w;
  const h = RING_TEX.h;
  const data = new Uint8ClampedArray(w * h * 4);
  const r = rng(seed);
  const bands = [];
  const n = kind === 'uranus' ? 26 : 150;
  for (let i = 0; i < n; i++) bands.push({ p: r(), w: 0.001 + r() * (kind === 'uranus' ? 0.006 : 0.02), a: r() });
  const col = kind === 'uranus' ? ramp(['#3c4b52', '#8fa6ad', '#cfe0e4']) : ramp(['#5a4f3d', '#b7a483', '#efe3c9', '#fffaf0']);
  const c = [0, 0, 0];
  for (let x = 0; x < w; x++) {
    const p = x / (w - 1);
    // base porosity: ring density falls off toward both edges
    let a = smoothstep(0, 0.05, p) * smoothstep(1, 0.9, p) * (0.35 + Math.pow(Math.sin(p * Math.PI), 0.45) * 0.65);
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      a *= 1 - Math.exp(-Math.pow((p - b.p) / b.w, 2)) * (0.25 + b.a * 0.62);
    }
    if (kind !== 'uranus') {
      a *= 1 - Math.exp(-Math.pow((p - 0.63) / 0.022, 2)) * 0.92; // Cassini division
      a *= 1 - Math.exp(-Math.pow((p - 0.93) / 0.008, 2)) * 0.7; // Encke gap
      a *= 1 - Math.exp(-Math.pow((p - 0.47) / 0.03, 2)) * 0.35;
    }
    // granularity of the ring plane
    a *= 0.72 + 0.28 * Math.sin(p * 940 + Math.sin(p * 71) * 3) ** 2;
    col(clamp(0.2 + a * 0.8), c);
    const alpha = clamp(a) * (kind === 'uranus' ? 0.5 : 1);
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = alpha * 255;
    }
  }
  return data;
}

/* ── generic small utilities ──────────────────────────────────────────── */

function canvasFromImageData(data, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d');
  cx.putImageData(new ImageData(data, w, h), 0, 0);
  return cv;
}

function texFromCanvas(cv, { srgb = false, wrapS = THREE.RepeatWrapping, wrapT = THREE.ClampToEdgeWrapping, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = wrapS;
  t.wrapT = wrapT;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** radial falloff sprite, reused for glows, sparks and flare ghosts */
export function bakeGlow(size = 256, inner = 'rgba(255,255,255,1)', mid = 'rgba(255,180,90,0.35)', power = 1) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const cx = cv.getContext('2d');
  const g = cx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.16, mid);
  g.addColorStop(0.42, 'rgba(255,140,50,0.09)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  if (power !== 1) cx.globalAlpha = power;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** soft round point sprite for the starfield */
export function bakeStarSprite(size = 64) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const cx = cv.getContext('2d');
  const g = cx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ── public bake API ──────────────────────────────────────────────────── */

/**
 * Produce the full material set for one world.
 * `progress` is called between allocations so the preloader can breathe.
 */
/** one flat colour + a touch of noise: what a world gets if its bake throws */
function paintFlat(ctx) {
  const { w, h, data, height, spec } = ctx;
  const c = toRGB(spec.color ?? '#8b8578');
  const r = rng((spec.seed ?? 3) * 7.7);
  for (let i = 0; i < w * h; i++) {
    const v = 0.86 + r() * 0.28;
    const o = i * 4;
    data[o] = c[0] * v;
    data[o + 1] = c[1] * v;
    data[o + 2] = c[2] * v;
    data[o + 3] = 255;
    height[i] = v * 0.06;
  }
}

export function bakeBody(spec, size) {
  const w = size.w;
  const h = size.h;
  const painter = spec.kind === 'flat' ? paintFlat : PAINTERS[spec.kind] ?? paintRocky;
  const height = new Float32Array(w * h);
  // opaque by default: a canvas is premultiplied internally, so leaving alpha
  // at 0 would throw the rgb away before the texture is ever uploaded
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const extra = {
    rough: new Uint8ClampedArray(w * h),
    night: new Float32Array(w * h),
    spec: new Uint8ClampedArray(w * h),
  };
  for (let i = 0; i < w * h; i++) extra.rough[i] = 200;
  const ctx = { w, h, height, data, spec, extra };
  painter(ctx, extra);

  const out = { size: [w, h] };
  out.map = texFromCanvas(canvasFromImageData(data, w, h), { srgb: true, aniso: size.aniso ?? 8 });
  const normal = heightToNormal(height, w, h, spec.normalStrength ?? 2.6);
  out.normalMap = texFromCanvas(canvasFromImageData(normal, w, h), { aniso: 4 });

  // roughness (and, for Earth, an ocean specular mask packed in .r)
  const rough = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const r = spec.ocean ? extra.rough[i] : (1 - (spec.rough ?? 0.8)) * 255;
    const o = i * 4;
    rough[o] = r;
    rough[o + 1] = r;
    rough[o + 2] = spec.ocean ? extra.spec[i] * 255 : 255;
    rough[o + 3] = 255;
  }
  out.roughnessMap = texFromCanvas(canvasFromImageData(rough, w, h), { aniso: 4 });

  if (spec.night) {
    const nightData = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = clamp(Math.pow(extra.night[i], 1.35) * 3.1);
      const o = i * 4;
      nightData[o] = v * 255;
      nightData[o + 1] = v * 214;
      nightData[o + 2] = v * 140;
      nightData[o + 3] = 255;
    }
    out.nightMap = texFromCanvas(canvasFromImageData(nightData, w, h), { srgb: true, aniso: 2 });
  }
  if (spec.clouds) {
    const cd = bakeCloud(w, h, spec.clouds.alpha, spec.seed);
    out.cloudMap = texFromCanvas(canvasFromImageData(cd, w, h), { aniso: 4 });
  }
  return out;
}

export function bakeRingTexture(kind, seed) {
  const d = bakeRing(kind, seed);
  const t = texFromCanvas(canvasFromImageData(d, RING_TEX.w, RING_TEX.h), { srgb: true, wrapS: THREE.ClampToEdgeWrapping });
  return t;
}

/** moon / asteroid colouring — tiny, cheap, still cratered */
export function bakeMoon(size = { w: 256, h: 128 }, spec = {}) {
  const w = size.w,
    h = size.h;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const height = new Float32Array(w * h);
  const base = makeFbm(w, spec.freq ?? 5, spec.freqV ?? 3.4, 6, 0.55, spec.seed ?? 1);
  const c = toRGB(spec.color ?? '#9a938a');
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = base(u, v);
      const t = 0.45 + (n - 0.5) * 1.15;
      const o = (y * w + x) * 4;
      const m = clamp(0.35 + t, 0.05, 1.6);
      data[o] = clamp(c[0] * m, 0, 255);
      data[o + 1] = clamp(c[1] * m, 0, 255);
      data[o + 2] = clamp(c[2] * m, 0, 255);
      height[y * w + x] = (n - 0.5) * 0.8;
    }
  }
  if (spec.craters !== false) stampCraters(height, w, h, spec.craters ?? 120, rng((spec.seed ?? 1) * 17 + 5), { minScale: 0.3, maxScale: 1.1 });
  const out = {
    map: texFromCanvas(canvasFromImageData(data, w, h), { srgb: true, aniso: 2 }),
  };
  out.normalMap = texFromCanvas(canvasFromImageData(heightToNormal(height, w, h, 3.4), w, h), { aniso: 2 });
  return out;
}
