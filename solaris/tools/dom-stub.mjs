/**
 * A minimal DOM/WebGL-free environment so the texture baker and the camera rig
 * can be exercised in Node. Only what the code actually touches is stubbed.
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

class FakeCtx2D {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.imageData = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    this.fillStyle = '#000';
    this.globalAlpha = 1;
  }
  putImageData(img) {
    this.imageData = img;
  }
  getImageData() {
    return this.imageData;
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  fillRect() {}
  drawImage() {}
  save() {}
  restore() {}
  beginPath() {}
  arc() {}
  fill() {}
  stroke() {}
  clip() {}
  clearRect() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  setTransform() {}
  rotate() {}
  translate() {}
}

export function installDomStub() {
  if (globalThis.__domStubbed) return;
  globalThis.__domStubbed = true;
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
        const c = { width: 1, height: 1, tagName: 'CANVAS', style: {} };
        c.getContext = () => new FakeCtx2D(c.width, c.height);
        Object.defineProperty(c, 'width', {
          get() {
            return this._w ?? 1;
          },
          set(v) {
            this._w = v;
            this._ctx = new FakeCtx2D(v, this._h ?? 1);
          },
        });
        Object.defineProperty(c, 'height', {
          get() {
            return this._h ?? 1;
          },
          set(v) {
            this._h = v;
            this._ctx = new FakeCtx2D(this._w ?? 1, v);
          },
        });
        c.getContext = () => c._ctx ?? (c._ctx = new FakeCtx2D(c.width, c.height));
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
  globalThis.ImageData = class ImageData {
    constructor(data, w, h) {
      this.data = data;
      this.width = w;
      this.height = h;
    }
  };
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
