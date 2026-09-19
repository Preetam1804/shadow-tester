/**
 * CPU noise used to bake planetary surfaces.
 * Integer-hash value noise: fast, tileable in longitude, good enough for
 * 1k textures when layered as fBm / ridged / domain-warped fields.
 */

const QUINTIC = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function hash3(x, y, z) {
  let h = (x * 374761393) ^ (y * 668265263) ^ (z * 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function value3(x, y, z) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z);
  const xf = x - xi,
    yf = y - yi,
    zf = z - zi;
  const u = QUINTIC(xf),
    v = QUINTIC(yf),
    w = QUINTIC(zf);
  const c000 = hash3(xi, yi, zi),
    c100 = hash3(xi + 1, yi, zi),
    c010 = hash3(xi, yi + 1, zi),
    c110 = hash3(xi + 1, yi + 1, zi),
    c001 = hash3(xi, yi, zi + 1),
    c101 = hash3(xi + 1, yi, zi + 1),
    c011 = hash3(xi, yi + 1, zi + 1),
    c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/** octaved fBm on a sphere shell → seamless around the longitude axis */
export function fbmCyl(u, v, freq, octaves = 5, gain = 0.5, lacunarity = 2.03, seedOffset = 0) {
  let amp = 0.5,
    sum = 0,
    norm = 0,
    f = freq;
  for (let i = 0; i < octaves; i++) {
    const a = (u * Math.PI * 2) + seedOffset + i * 3.17;
    const cx = Math.cos(a) * f;
    const cz = Math.sin(a) * f;
    const cy = v * f * 2;
    sum += amp * value3(cx + 11.3, cy + seedOffset * 1.7, cz + 5.1);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export function ridgedCyl(u, v, freq, octaves = 5, seedOffset = 0) {
  let amp = 0.5,
    sum = 0,
    norm = 0,
    f = freq;
  for (let i = 0; i < octaves; i++) {
    const a = u * Math.PI * 2 + seedOffset + i * 2.71;
    const n = value3(Math.cos(a) * f + 3.7, v * f * 2 + seedOffset, Math.sin(a) * f + 8.2);
    const r = 1 - Math.abs(n * 2 - 1);
    sum += amp * r * r;
    norm += amp;
    amp *= 0.52;
    f *= 2.07;
  }
  return sum / norm;
}

/** value noise with arbitrary 3D point — used for the sun, moons, asteroids */
export function fbm3(x, y, z, octaves = 4, gain = 0.5) {
  let amp = 0.5,
    sum = 0,
    norm = 0,
    f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * value3(x * f, y * f, z * f);
    norm += amp;
    amp *= gain;
    f *= 2.05;
  }
  return sum / norm;
}

/**
 * Stamp impact craters straight into a float height field.
 * Rows near the poles are skipped so the stretched texels don't look smeared.
 */
/**
 * Stamp impact craters straight into a float height field.
 * `opts.density` is an optional w*h mask: values < 0.5 thin the population out
 * (smooth volcanic plains) and shrink the accepted craters, which is what makes
 * a rocky world read as *geology* instead of a uniform bubble wrap.
 */
export function stampCraters(height, w, h, count, rand, opts = {}) {
  const minScale = opts.minScale ?? 0.5;
  const maxScale = opts.maxScale ?? 1;
  const depth = opts.depth ?? -0.5;
  const rim = opts.rim ?? 0.34;
  const density = opts.density ?? null;
  let placed = 0;
  const budget = Math.round(count * (density ? 2.1 : 1));
  for (let i = 0; i < budget && placed < count; i++) {
    const lat = Math.asin(rand() * 1.72 - 0.86); // bias away from the poles
    const lon = rand() * Math.PI * 2;
    let dens = 1;
    if (density) {
      const du = Math.floor((((lon / (Math.PI * 2)) % 1) + 1) % 1 * w);
      const dv = Math.max(0, Math.min(h - 1, Math.round(((lat / Math.PI) + 0.5) * h)));
      dens = density[dv * w + du];
      if (rand() > 0.18 + dens * 0.95) continue;
    }
    placed++;
    const y = ((lat / Math.PI) + 0.5) * h;
    const x = (lon / (Math.PI * 2)) * w;
    const rTex = (minScale + rand() * (maxScale - minScale)) * (w / 110) * (density ? 0.55 + dens * 0.75 : 1);
    const squeeze = 1 / Math.max(0.28, Math.cos(lat));
    const ry = rTex * Math.min(2.4, squeeze);
    const bright = 0.55 + rand() * 0.75;
    for (let pass = 0; pass < 2; pass++) {
      const ox = x + (pass === 0 ? 0 : w); // wrap across the seam
      const x0 = Math.max(0, Math.floor(ox - rTex * 1.9));
      const x1 = Math.min(w - 1, Math.ceil(ox + rTex * 1.9));
      const y0 = Math.max(0, Math.floor(y - ry * 1.9));
      const y1 = Math.min(h - 1, Math.ceil(y + ry * 1.9));
      for (let yy = y0; yy <= y1; yy++) {
        const dy = (yy - y) / ry;
        for (let xx = x0; xx <= x1; xx++) {
          const dx = (xx - ox) / rTex;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > 1.9) continue;
          let delta = 0;
          if (d < 1) {
            const bowl = Math.cos(d * Math.PI * 0.5);
            delta = depth * bowl * (1 - d * 0.25);
            const rimBand = Math.exp(-Math.pow((d - 1.03) / 0.17, 2));
            delta += rim * rimBand * bright;
          } else {
            delta = rim * 0.35 * Math.exp(-Math.pow((d - 1.08) / 0.4, 2)) * bright;
          }
          height[yy * w + xx] += delta;
        }
      }
    }
  }
}

/** sobel a float height field into a tangent-space normal map (ImageData-ready Uint8) */
export function heightToNormal(height, w, h, strength = 2.2) {
  const data = new Uint8ClampedArray(w * h * 4);
  const at = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1),
        t = at(x, y - 1),
        tr = at(x + 1, y - 1);
      const l = at(x - 1, y),
        r = at(x + 1, y);
      const bl = at(x - 1, y + 1),
        b = at(x, y + 1),
        br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      data[i + 3] = 255;
    }
  }
  return data;
}

export function heightToBump(height, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < height.length; i++) {
    if (height[i] < min) min = height[i];
    if (height[i] > max) max = height[i];
  }
  const span = max - min || 1;
  for (let i = 0; i < height.length; i++) {
    const v = ((height[i] - min) / span) * 255;
    const j = i * 4;
    data[j] = data[j + 1] = data[j + 2] = v;
    data[j + 3] = 255;
  }
  return data;
}
