/**
 * Offline planet preview: bakes every surface exactly as the browser does, then
 * shade-rasters each one onto a sphere (lambert + specular + night lights + rim)
 * and writes a contact sheet. Lets the look be reviewed without a GPU.
 *
 *   node tools/preview.mjs [size]
 */
import { installDomStub, writePng } from './dom-stub.mjs';
installDomStub();

const SIZE = Number(process.argv[2] ?? 300);
const { BODIES, SUN } = await import('../src/config/solar.js');
const { bakeBody, bakeMoon, bakeRingTexture } = await import('../src/lib/textures.js');
const { clamp, rng } = await import('../src/lib/math.js');
const fs = await import('node:fs');

const outDir = new URL('../.qa/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });

const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const l2s = (v) => 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
const aces = (x) => {
  const a = 2.51,
    b = 0.03,
    c = 2.43,
    d = 0.59,
    e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1);
};

function readTex(t) {
  if (!t) return null;
  const img = t.image;
  const data = img.getContext('2d').getImageData().data;
  return { data, w: img.width, h: img.height };
}
function sample(tex, u, v) {
  const x = Math.min(tex.w - 1, Math.max(0, Math.floor(u * tex.w)));
  const y = Math.min(tex.h - 1, Math.max(0, Math.floor(v * tex.h)));
  const i = (y * tex.w + x) * 4;
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2], tex.data[i + 3]];
}
function sampleLin(tex, u, v) {
  const c = sample(tex, u, v);
  return [s2l(c[0] / 255), s2l(c[1] / 255), s2l(c[2] / 255), c[3] / 255];
}

/** shade a unit sphere with the given maps; returns Uint8ClampedArray RGBA */
function renderPlanet(texes, opts) {
  const S = SIZE;
  const out = new Uint8ClampedArray(S * S * 4);
  const sun = opts.sunDir;
  const lsun = Math.hypot(...sun);
  const L = sun.map((v) => v / lsun);
  const { map, rough, night, normal } = texes;
  const atmo = opts.atmo.map(s2l);
  const tilt = opts.tilt ?? 0;
  const spin = opts.spin ?? 0.25;
  for (let y = 0; y < S; y++) {
    const py = -((y / (S - 1)) * 2 - 1);
    for (let x = 0; x < S; x++) {
      const px = (x / (S - 1)) * 2 - 1;
      const r2 = px * px + py * py;
      const i = (y * S + x) * 4;
      // halo outside the disc
      if (r2 > 1) {
        const d = Math.sqrt(r2) - 1;
        const glow = Math.exp(-d * 26) * (opts.halo ?? 0.5);
        const lit = clamp((L[2] + 1) * 0.5);
        out[i] = clamp(atmo[0] * glow * lit) * 255;
        out[i + 1] = clamp(atmo[1] * glow * lit) * 255;
        out[i + 2] = clamp(atmo[2] * glow * lit) * 255;
        out[i + 3] = 255;
        continue;
      }
      const pz = Math.sqrt(1 - r2);
      // rotate for spin + tilt around x, then into texture space
      let nx = px,
        ny = py,
        nz = pz;
      const cy2 = Math.cos(tilt),
        sy2 = Math.sin(tilt);
      const ny2 = ny * cy2 - nz * sy2;
      const nz2 = ny * sy2 + nz * cy2;
      ny = ny2;
      nz = nz2;
      const cs = Math.cos(spin),
        sn = Math.sin(spin);
      const nx3 = nx * cs + nz * sn;
      const nz3 = -nx * sn + nz * cs;
      nx = nx3;
      nz = nz3;
      const lat = Math.asin(clamp(ny, -1, 1));
      const lon = Math.atan2(nz, nx);
      const u = (lon / (Math.PI * 2) + 0.5) % 1;
      const v = 0.5 - lat / Math.PI;

      const alb = sampleLin(map, u, v);
      // relief: perturb the shading normal with the baked tangent-space map
      let pnx = nx, pny = ny, pnz = nz;
      if (normal) {
        const ns = sample(normal, u, v);
        const tx = (ns[0] / 255) * 2 - 1;
        const ty = (ns[1] / 255) * 2 - 1;
        const st = 1.15;
        // T = east (∂/∂lon), B = north (∂/∂lat)
        const ex = -Math.sin(lon), ez = Math.cos(lon);
        const bx = -Math.sin(lat) * Math.cos(lon), by = Math.cos(lat), bz = -Math.sin(lat) * Math.sin(lon);
        pnx = nx + (ex * -tx + bx * ty) * st;
        pny = ny + (by * ty) * st;
        pnz = nz + (ez * -tx + bz * ty) * st;
        const nl = Math.hypot(pnx, pny, pnz) || 1;
        pnx /= nl; pny /= nl; pnz /= nl;
      }
      const roughV = rough ? sample(rough, u, v)[0] / 255 : 0.7;
      const specMask = rough ? sample(rough, u, v)[2] / 255 : 0.2;

      const ndl = pnx * L[0] + pny * L[1] + pnz * L[2];
      const wrap = 0.14;
      const diff = Math.pow(clamp((ndl + wrap) / (1 + wrap)), 1.12);
      // specular: V is (0,0,1)
      const hx = L[0],
        hy = L[1],
        hz = L[2] + 1;
      const hl = Math.hypot(hx, hy, hz) || 1;
      const ndh = clamp((pnx * hx + pny * hy + pnz * hz) / hl);
      const gloss = 6 + (1 - roughV) * 90;
      const spec = Math.pow(ndh, gloss) * (0.02 + specMask * 0.95) * (1 - roughV * 0.6);

      const rim = Math.pow(1 - nz, 2.6);
      const litRim = clamp((ndl + 0.35) / 1.05);
      const nightV = night ? sampleLin(night, u, v) : [0, 0, 0];
      const nightK = 1 - clamp((ndl + 0.1) / 0.35);

      const sunC = [1.0, 0.94, 0.85];
      let r = alb[0] * diff * sunC[0] * 1.35;
      let g = alb[1] * diff * sunC[1] * 1.35;
      let b = alb[2] * diff * sunC[2] * 1.35;
      r += spec * sunC[0] * 0.9 + rim * litRim * atmo[0] * (opts.atmoStrength ?? 0.3) * 1.6;
      g += spec * sunC[1] * 0.9 + rim * litRim * atmo[1] * (opts.atmoStrength ?? 0.3) * 1.6;
      b += spec * sunC[2] * 0.9 + rim * litRim * atmo[2] * (opts.atmoStrength ?? 0.3) * 1.9;
      r += nightV[0] * nightK * 1.5;
      g += nightV[1] * nightK * 1.25;
      b += nightV[2] * nightK * 0.9;
      // ambient starlight floor
      r += alb[0] * 0.012;
      g += alb[1] * 0.014;
      b += alb[2] * 0.02;

      out[i] = l2s(aces(r)) * 255;
      out[i + 1] = l2s(aces(g)) * 255;
      out[i + 2] = l2s(aces(b)) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function montage(tiles, cols, pad = 8, bg = 12) {
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * (SIZE + pad) + pad;
  const H = rows * (SIZE + pad) + pad;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = bg;
    out[i * 4 + 1] = bg + 2;
    out[i * 4 + 2] = bg + 6;
    out[i * 4 + 3] = 255;
  }
  tiles.forEach((t, n) => {
    const ox = pad + (n % cols) * (SIZE + pad);
    const oy = pad + Math.floor(n / cols) * (SIZE + pad);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const si = (y * SIZE + x) * 4;
        const di = ((oy + y) * W + ox + x) * 4;
        out[di] = t[si];
        out[di + 1] = t[si + 1];
        out[di + 2] = t[si + 2];
        out[di + 3] = 255;
      }
    }
  });
  return { data: out, w: W, h: H };
}

/**
 * Ring plane raster for the same orthographic camera, sharing the planet's
 * tilt — validates ring texture, shadowing, occultation and backlight scatter.
 */
function renderRinged(base, ring, opts) {
  const S = SIZE;
  const out = new Uint8ClampedArray(base);
  const { inner, outer, tex, tilt, radius, sunDir, opacity } = ring;
  const nrm = [Math.sin(-tilt) * 0, Math.cos(tilt), Math.sin(tilt)]; // plane normal (tilt about x)
  const nl = Math.hypot(...nrm);
  const N = nrm.map((v) => v / nl);
  const L = (() => {
    const l = Math.hypot(...sunDir);
    return sunDir.map((v) => v / l);
  })();
  const D = 40; // camera distance along +z, ortho
  for (let y = 0; y < S; y++) {
    const py = -((y / (S - 1)) * 2 - 1);
    for (let x = 0; x < S; x++) {
      const px = (x / (S - 1)) * 2 - 1;
      const r2 = px * px + py * py;
      const i = (y * S + x) * 4;
      const Rx = radius * (2 / (S - 1)) * (S / 2); // world units per screen unit
      const ox = px * (2 / (S - 1)) * (S / 2) * (radius / (radius * 2 / (S - 1)) / (S / 2));
      // ray: P = (px*k, py*k, D) travelling -z, k chosen so the unit sphere fills the disc
      const k = radius; // world radius of the planet == 1 screen unit
      const P = [px * k, py * k, D];
      const dz = P[0] * N[0] + P[1] * N[1] + P[2] * N[2];
      if (Math.abs(N[2]) < 1e-4) continue;
      const t = dz / N[2];
      const hit = [P[0], P[1], P[2] - t];
      const rr = Math.hypot(hit[0], hit[1], hit[2]);
      const u = (rr - inner * k) / ((outer - inner) * k);
      const isFront = t > 0; // hit closer to camera than the planet centre
      const occluded = r2 <= 1;
      if (u < 0 || u > 1 || occluded) continue;
      const s = Math.min(tex.w - 1, Math.max(0, Math.floor(u * tex.w)));
      const px4 = s * 4;
      const a = (tex.data[px4 + 3] / 255) * opacity;
      if (a < 0.004) continue;
      const col = [s2l(tex.data[px4] / 255), s2l(tex.data[px4 + 1] / 255), s2l(tex.data[px4 + 2] / 255)];
      const facing = Math.abs(hit[0] * 0 + N[0] * L[0] + N[1] * L[1] + N[2] * L[2]);
      // planet shadow on the rings
      const oc = [-hit[0], -hit[1], -hit[2]];
      const proj = oc[0] * L[0] + oc[1] * L[1] + oc[2] * L[2];
      let shadow = 1;
      if (proj > 0) {
        const dperp = Math.hypot(oc[0], oc[1], oc[2]) ** 2 - proj * proj;
        shadow = smoothstepN((k * 0.82) ** 2, (k * 1.12) ** 2, Math.max(dperp, 0));
      }
      const V = [0, 0, 1];
      const fwd = Math.max(0, -(V[0] * L[0] + V[1] * L[1] + V[2] * L[2])) ** 3;
      const lit = 0.16 + facing * 0.95;
      let cr = col[0] * lit * 1.25 * (0.12 + 0.88 * shadow) + col[0] * fwd * 0.5;
      let cg = col[1] * lit * 1.2 * (0.12 + 0.88 * shadow) + col[1] * fwd * 0.45;
      let cb = col[2] * lit * 1.1 * (0.12 + 0.88 * shadow) + col[2] * fwd * 0.4;
      // depth cue: the far side of the ring is slightly dimmer
      if (!isFront) { cr *= 0.86; cg *= 0.86; cb *= 0.86; }
      const dst = Math.max(0, hit[2]);
      const src = a * (0.62 + fwd * 0.3);
      out[i] = (out[i] / 255) * (1 - src) + l2s(aces(cr)) * 255 * src;
      out[i + 1] = (out[i + 1] / 255) * (1 - src) + l2s(aces(cg)) * 255 * src;
      out[i + 2] = (out[i + 2] / 255) * (1 - src) + l2s(aces(cb)) * 255 * src;
      void dst; void ox; void Rx;
    }
  }
  return out;
}
const smoothstepN = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
};

/* ── bake + render ───────────────────────────────────────────────────── */
const tiles = [];
const flat = [];
const t0 = Date.now();
const stats = [];
for (const b of BODIES) {
  const size = { w: 1024, h: 512, aniso: 1 };
  const baked = bakeBody(
    {
      ...b.tex,
      craters: b.craters,
      night: b.night,
      ocean: b.ocean,
      clouds: b.clouds,
      rough: b.rough,
      normalStrength: { rocky: 1.55, mars: 1.5, earth: 1.35, bands: 0.42, ice: 0.5, swirl: 0.3 }[b.tex.kind] ?? 1.4,
    },
    size
  );
  const texes = {
    map: readTex(baked.map),
    rough: readTex(baked.roughnessMap),
    normal: readTex(baked.normalMap),
    night: baked.nightMap ? readTex(baked.nightMap) : null,
  };
  // sanity: mean albedo, contrast, dead bands, NaN bytes, opaque alpha
  let sum = 0,
    mx = 0,
    mn = 255;
  const d = texes.map.data;
  const W = texes.map.w,
    H = texes.map.h;
  for (let i = 0; i + 2 < d.length; i += 400) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += l;
    mx = Math.max(mx, l);
    mn = Math.min(mn, l);
  }
  const n = Math.floor(d.length / 400);
  const mean = sum / n;
  let deadRows = 0,
    alphaBad = 0,
    badBytes = 0;
  for (let y = 0; y < H; y++) {
    let rs = 0;
    for (let x = 0; x < W; x += 4) rs += d[(y * W + x) * 4];
    if (rs / (W / 4) < mean * 0.06) deadRows++;
  }
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) alphaBad++;
  for (let i = 0; i < d.length; i += 37) if (!Number.isFinite(d[i])) badBytes++;
  if (deadRows > 1 || alphaBad || badBytes)
    console.error(`  ✗ ${b.id}: deadRows=${deadRows} alphaBad=${alphaBad} nonFinite=${badBytes}`);
  stats.push({
    id: b.id,
    albedo: mean.toFixed(1),
    range: `${mn.toFixed(0)}–${mx.toFixed(0)}`,
    dead: deadRows,
    alpha: alphaBad ? `BAD(${alphaBad})` : 'ok',
  });

  let px = renderPlanet(texes, {
    sunDir: [0.55, 0.22, 0.9],
    atmo: hexToArr(b.atmo),
    atmoStrength: Math.min(0.5, b.atmoStrength * 0.8),
    tilt: b.tilt ?? 0,
    spin: 0.5,
    halo: Math.min(0.7, b.atmoStrength),
  });
  if (b.rings) {
    const rt = bakeRingTexture(b.rings.tex, 5 + Math.round(b.radius * 3));
    const rtex = readTex(rt);
    px = renderRinged(px, {
      inner: b.rings.inner,
      outer: b.rings.outer,
      tex: rtex,
      tilt: b.tilt ?? 0,
      radius: b.radius,
      sunDir: [0.55, 0.22, 0.9],
      opacity: b.rings.opacity ?? 1,
    }, {});
  }
  if (b.rings) writePng(`${outDir}ring-${b.id}.png`, readTex(bakeRingTexture(b.rings.tex, 5 + Math.round(b.radius * 3))).data, 1024, 4);
  tiles.push(px);
  flat.push(texes.map.data);
  writePng(`${outDir}map-${b.id}.png`, texes.map.data, texes.map.w, texes.map.h);
  if (texes.night) writePng(`${outDir}night-${b.id}.png`, expand(texes.night), texes.map.w, texes.map.h);
  if (baked.cloudMap) {
    const cm = readTex(baked.cloudMap);
    writePng(`${outDir}clouds-${b.id}.png`, expand(cm), cm.w, cm.h);
  }
}
const moon = bakeMoon({ w: 256, h: 128 }, { seed: 8, color: '#9c968c', craters: 130 });
tiles.push(renderPlanet({ map: readTex(moon.map), normal: readTex(moon.normalMap) }, { sunDir: [0.6, 0.3, 0.8], atmo: [0.3, 0.3, 0.32], atmoStrength: 0.02, halo: 0.05 }));
// hero check: Saturn big, with rings, at the framing the site actually uses
{
  const sat = BODIES.find((b) => b.id === 'saturn');
  const sb = bakeBody({ ...sat.tex, rough: sat.rough, clouds: sat.clouds, normalStrength: 0.42 }, { w: 1024, h: 512 });
  const stx = { map: readTex(sb.map), rough: readTex(sb.roughnessMap), normal: readTex(sb.normalMap) };
  const sun = [-0.62, -0.16, 0.78];
  let img = renderPlanet(stx, {
    sunDir: sun,
    atmo: hexToArr(sat.atmo),
    atmoStrength: 0.2,
    tilt: sat.tilt,
    spin: 1.1,
    halo: 0.35,
  });
  img = renderRinged(img, {
    inner: sat.rings.inner,
    outer: sat.rings.outer,
    tex: readTex(bakeRingTexture(sat.rings.tex, 5 + Math.round(sat.radius * 3))),
    tilt: sat.tilt,
    radius: sat.radius,
    sunDir: sun,
    opacity: sat.rings.opacity,
  });
  writePng(`${outDir}hero-saturn.png`, img, SIZE, SIZE);
  console.log('hero →', `${outDir}hero-saturn.png`);
}
const sheet = montage(tiles, 3);
writePng(`${outDir}planets.png`, sheet.data, sheet.w, sheet.h);
console.log('planets →', `${outDir}planets.png`, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.table(stats);

function hexToArr(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function expand(t) {
  const out = new Uint8ClampedArray(t.w * t.h * 4);
  for (let i = 0; i < t.w * t.h; i++) {
    const a = t.data[i * 4 + 3] || 255;
    out[i * 4] = a;
    out[i * 4 + 1] = a;
    out[i * 4 + 2] = a;
    out[i * 4 + 3] = 255;
  }
  return out;
}
