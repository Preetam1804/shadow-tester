/**
 * A minimal DOM/WebGL-free environment so the texture baker and the camera rig
 * can be exercised in Node. Only what the code actually touches is stubbed.
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

/**
 * A minimal DOM/WebGL-free environment so the texture baker and the camera rig
 * can be exercised in Node. Only what the code actually touches is stubbed —
 * but what *is* stubbed behaves like a browser about its error contract:
 * canvas methods throw exactly where Chrome/Firefox throw (bad colour strings,
 * negative radii, mismatched ImageData buffers), because those are the failure
 * modes that only ever appear on a real page. Silent no-ops here meant a whole
 * class of bug could not be caught headlessly.
 */
export const violations = [];
const note = (msg) => {
  violations.push(msg);
  if (violations.length <= 12) console.warn(`  [canvas] ${msg}`);
};

const NAMED = new Set([
  'transparent', 'currentcolor', 'white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'orange', 'purple', 'gray', 'grey', 'silver', 'gold', 'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'fuchsia',
]);

function numericComponent(raw) {
  const t = raw.trim();
  if (!t) return false;
  if (t.endsWith('%')) return Number.isFinite(parseFloat(t));
  return Number.isFinite(Number(t));
}

/** true when a string is a colour a browser would accept */
export function isCssColor(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  if (!s) return false;
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{4}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/.test(s)) return true;
  if (NAMED.has(s)) return true;
  const fn = s.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!fn) return false;
  const kind = fn[1];
  const body = fn[2].trim();
  if (!body) return false;
  const parts = body.includes(',') ? body.split(',') : body.replace('/', ' ').split(/\s+/);
  if (parts.length < 3) return false;
  if (body.includes(',')) {
    if (parts.length !== 3 && parts.length !== 4) return false;
  } else if (parts.length < 3 || parts.length > 4) return false;
  const nums = parts.filter((p) => p !== '/' && p.trim() !== '');
  if (nums.length !== parts.length) return false;
  for (let i = 0; i < 3; i++) if (!numericComponent(nums[i])) return false;
  if (nums.length > 3) {
    const a = nums[3].trim();
    if (!Number.isFinite(parseFloat(a)) && !/^\d*\.?\d+%$/.test(a)) return false;
  }
  if (kind.startsWith('rgb')) {
    for (let i = 0; i < 3; i++) {
      const n = Number(nums[i].trim());
      if (Number.isFinite(n) && (n < -1e9 || n > 1e9)) return false;
    }
  }
  return true;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

class StrictGradient {
  constructor(kind) {
    this.kind = kind;
    this.stops = [];
  }
  addColorStop(offset, color) {
    if (!finite(offset) || offset < 0 || offset > 1) {
      throw new DOMException(`Failed to execute 'addColorStop' on '${this.kind}': The offset provided is not a valid number (got ${offset}).`, 'IndexSizeError');
    }
    if (!isCssColor(color)) {
      throw new DOMException(
        `Failed to execute 'addColorStop' on '${this.kind}': The string provided is not a valid CSS color string (${JSON.stringify(color)}).`,
        'SyntaxError'
      );
    }
    this.stops.push([offset, color]);
  }
}

class FakeCtx2D {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.imageData = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    this._fillStyle = '#000';
    this._strokeStyle = '#000';
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.globalCompositeOperation = 'source-over';
    this.filter = 'none';
    this.font = '10px sans-serif';
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.shadowBlur = 0;
    this.shadowColor = 'rgba(0,0,0,0)';
    this.canvas = null;
  }
  _paint(v, prop) {
    if (v instanceof StrictGradient) return v;
    if (!isCssColor(v)) {
      note(`${prop} assigned an invalid colour (${JSON.stringify(v)}); a browser silently ignores this, so the paint never happens`);
      return this[`_${prop.toLowerCase()}`] ?? '#000';
    }
    return typeof v === 'string' ? v.trim() : v;
  }
  get fillStyle() {
    return this._fillStyle;
  }
  set fillStyle(v) {
    this._fillStyle = this._paint(v, 'fillStyle');
  }
  get strokeStyle() {
    return this._strokeStyle;
  }
  set strokeStyle(v) {
    this._strokeStyle = this._paint(v, 'strokeStyle');
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (![x0, y0, r0, x1, y1, r1].every(finite)) {
      throw new TypeError("Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The provided float value is non-finite.");
    }
    if (r0 < 0 || r1 < 0) {
      throw new DOMException('Failed to execute \'createRadialGradient\' on \'CanvasRenderingContext2D\': The r0/r1 provided is negative.', 'IndexSizeError');
    }
    return new StrictGradient('CanvasRenderingContext2D');
  }
  createLinearGradient(x0, y0, x1, y1) {
    if (![x0, y0, x1, y1].every(finite)) {
      throw new TypeError("Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': The provided float value is non-finite.");
    }
    return new StrictGradient('CanvasRenderingContext2D');
  }
  createImageData(sw, sh) {
    if (!finite(sw) || !finite(sh) || sw < 1 || sh < 1) {
      throw new DOMException(`Failed to construct 'ImageData': The source dimensions provided (${sw}x${sh}) are invalid.`, 'IndexSizeError');
    }
    return new FakeImageData(new Uint8ClampedArray(sw * sh * 4), sw, sh);
  }
  putImageData(img, dx, dy) {
    if (!(img && img.data && img.width >= 1 && img.height >= 1)) {
      throw new DOMException('Failed to execute \'putImageData\': the ImageData provided is empty or has zero dimensions.', 'InvalidStateError');
    }
    if (!finite(dx) || !finite(dy)) {
      note(`putImageData at non-finite offset (${dx},${dy}) — a browser would not draw this`);
      return;
    }
    this.imageData = img;
  }
  getImageData(sx, sy, sw, sh) {
    if (![sx, sy, sw, sh].every(finite) || sw < 1 || sh < 1) {
      throw new DOMException(`Failed to execute 'getImageData': The source ${sw}x${sh} provided is less than 1.`, 'IndexSizeError');
    }
    const out = new Uint8ClampedArray(sw * sh * 4);
    const src = this.imageData.data;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const si = ((sy + y) * this.w + (sx + x)) * 4;
        const di = (y * sw + x) * 4;
        for (let k = 0; k < 4; k++) out[di + k] = src[si + k] ?? 0;
      }
    }
    return new FakeImageData(out, sw, sh);
  }
  drawImage(img) {
    if (!img || !img.width || !img.height) {
      throw new DOMException("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The image argument is a canvas element with an unsupported size.", 'InvalidStateError');
    }
  }
  // geometry that a browser rejects (negative radius) rather than ignores
  arc(x, y, r, a0 = 0, a1 = Math.PI * 2) {
    if (!finite(r) || r < 0) {
      throw new DOMException(`Failed to execute 'arc' on 'CanvasRenderingContext2D': The radius provided (${r}) is negative.`, 'IndexSizeError');
    }
    this._nonFinite('arc', [x, y, a0, a1]);
  }
  ellipse(x, y, rx, ry) {
    if (!finite(rx) || !finite(ry) || rx < 0 || ry < 0) {
      throw new DOMException(`Failed to execute 'ellipse' on 'CanvasRenderingContext2D': The radius provided (${rx},${ry}) is negative.`, 'IndexSizeError');
    }
  }
  _nonFinite(fn, args) {
    if (!args.every(finite)) note(`${fn}() called with non-finite coordinates (${args.join(', ')}) — ignored by the browser`);
  }
  fillRect(x, y, w, h) {
    this._nonFinite('fillRect', [x, y, w, h]);
  }
  clearRect() {}
  strokeRect() {}
  beginPath() {}
  closePath() {}
  fill() {}
  stroke() {}
  clip() {}
  moveTo(x, y) {
    this._nonFinite('moveTo', [x, y]);
  }
  lineTo(x, y) {
    this._nonFinite('lineTo', [x, y]);
  }
  quadraticCurveTo() {}
  bezierCurveTo() {}
  save() {}
  restore() {}
  setTransform() {}
  transform() {}
  resetTransform() {}
  rotate(a) {
    this._nonFinite('rotate', [a]);
  }
  translate(x, y) {
    this._nonFinite('translate', [x, y]);
  }
  scale() {}
  setLineDash() {}
  fillText() {}
  measureText(t) {
    return { width: String(t).length * 6 };
  }
  createPattern() {
    return null;
  }
}

class DOMException extends Error {
  constructor(message, name = 'Error') {
    super(message);
    this.name = name;
  }
}

class FakeImageData {
  constructor(data, sw, sh) {
    // browsers: ImageData(data, sw[, sh]) throws unless data.length === sw*sh*4
    const width = Math.trunc(sw);
    const height = sh === undefined ? data.length / (width * 4) : Math.trunc(sh);
    if (!(width >= 1) || !(height >= 1) || Number.isNaN(height)) {
      throw new DOMException(`Failed to construct 'ImageData': The source dimensions provided (${sw}x${sh ?? 'auto'}) are invalid.`, 'IndexSizeError');
    }
    if (!data || data.length !== width * height * 4) {
      throw new DOMException(
        `Failed to construct 'ImageData': The provided array length (${data ? data.length : 'none'}) does not match ${width}x${height}x4 = ${width * height * 4}.`,
        'IndexSizeError'
      );
    }
    this.data = data;
    this.width = width;
    this.height = height;
    this.colorSpace = 'srgb';
  }
}
globalThis.DOMException = globalThis.DOMException ?? DOMException;
globalThis.__FakeImageData = FakeImageData;

export function installDomStub() {
  if (globalThis.__domStubbed) return;
  globalThis.__domStubbed = true;
  violations.length = 0;
  globalThis.self = globalThis;
  globalThis.window = globalThis.window ?? {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 2,
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        const c = { tagName: 'CANVAS', style: {}, _w: 1, _h: 1, _ctx: null };
        const fresh = () => {
          c._ctx = c._w >= 1 && c._h >= 1 ? new FakeCtx2D(c._w, c._h) : null;
          if (c._ctx) c._ctx.canvas = c;
        };
        Object.defineProperty(c, 'width', { get: () => c._w, set: (v) => ((c._w = Math.trunc(v)), fresh()) });
        Object.defineProperty(c, 'height', { get: () => c._h, set: (v) => ((c._h = Math.trunc(v)), fresh()) });
        c.getContext = (kind) => (kind === '2d' ? (c._ctx ?? (c._ctx = new FakeCtx2D(c._w, c._h))) : null);
        c.toDataURL = () => 'data:,';
        return c;
      }
      return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} };
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
  };
  globalThis.ImageData = FakeImageData;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

/* ── tiny PNG writer (rgba8, no filter) so baked maps can be eyeballed ── */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** write an RGBA Uint8ClampedArray as a PNG */
export function writePng(path, data, w, h) {
  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(w, 0);
  IHDR.writeUInt32BE(h, 4);
  IHDR[8] = 8; // bit depth
  IHDR[9] = 6; // colour type rgba
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = rowStart + 1 + x * 4;
      raw[o] = data[i];
      raw[o + 1] = data[i + 1];
      raw[o + 2] = data[i + 2];
      raw[o + 3] = data[i + 3] === undefined ? 255 : data[i + 3];
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', IHDR),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}
