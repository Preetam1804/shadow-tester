/** Small math kit shared by the rig, the UI and the texture baker. */

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = lerp;
export const invLerp = (a, b, v) => (a === b ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp(invLerp(a, b, v)));
export const smoothstep = (e0, e1, x) => {
  const t = saturate(invLerp(e0, e1, x));
  return t * t * (3 - 2 * t);
};
export const mod = (a, n) => ((a % n) + n) % n;

/** frame-rate independent exponential damping */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** mix linear travel with eased travel: keeps velocity alive but slows into each pose */
export const travelEase = (t, amount = 0.5) => {
  const e = t * t * (3 - 2 * t);
  return lerp(t, e, amount);
};

/** bell curve peaking at 0, used for chapter focus weighting */
export const bell = (x, width = 0.5) => saturate(1 - Math.abs(x) / width);

/** uniform Catmull–Rom over an array of THREE.Vector3, allocation-free */
export function catmullRomAt(points, t, out) {
  const n = points.length;
  if (n === 0) return out.set(0, 0, 0);
  if (n === 1) return out.copy(points[0]);
  const scaled = clamp(t) * (n - 1);
  let i = Math.floor(scaled);
  if (i >= n - 1) i = n - 2;
  const p = scaled - i;
  const p0 = points[i === 0 ? 0 : i - 1];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(n - 1, i + 2)];
  const p2v = p * p;
  const p3v = p2v * p;
  const w = 0.5;
  out.x =
    w * (2 * p1.x + (-p0.x + p2.x) * p + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * p2v + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * p3v);
  out.y =
    w * (2 * p1.y + (-p0.y + p2.y) * p + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * p2v + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * p3v);
  out.z =
    w * (2 * p1.z + (-p0.z + p2.z) * p + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * p2v + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * p3v);
  return out;
}

/** deterministic PRNG so every reload bakes the same worlds */
export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return function () {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fmt = (v, d = 2) =>
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** same spline over a flat number array — used for fov / roll / framing bias */
export function catmullRomScalar(arr, t) {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const scaled = clamp(t) * (n - 1);
  let i = Math.floor(scaled);
  if (i >= n - 1) i = n - 2;
  const p = scaled - i;
  const p0 = arr[i === 0 ? 0 : i - 1];
  const p1 = arr[i];
  const p2 = arr[i + 1];
  const p3 = arr[Math.min(n - 1, i + 2)];
  const p2v = p * p;
  const p3v = p2v * p;
  return 0.5 * (2 * p1 + (-p0 + p2) * p + (2 * p0 - 5 * p1 + 4 * p2 - p3) * p2v + (-p0 + 3 * p1 - 3 * p2 + p3) * p3v);
}

/** linear sample of a per-chapter series at a chapter-float position */
export function sampleSeries(arr, x) {
  const n = arr.length;
  const v = clamp(x, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(v));
  return lerp(arr[i], arr[i + 1], v - i);
}
