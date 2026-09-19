import { clamp, damp } from '../lib/math.js';

/** Boot sequence: real percentages from real work (bakes + shader compile). */
export class Preloader {
  constructor() {
    this.el = document.getElementById('loader');
    this.pct = document.getElementById('load-pct');
    this.bar = document.getElementById('load-bar');
    this.status = document.getElementById('load-status');
    this.ring = document.getElementById('load-ring');
    this.target = 0;
    this.shown = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);
    this._tick();
  }

  set(p, label) {
    this.target = clamp(p);
    if (label) this.status.textContent = label;
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick);
    this.shown += (this.target - this.shown) * 0.18;
    const p = clamp(this.shown);
    this.pct.textContent = String(Math.round(p * 100)).padStart(2, '0');
    this.bar.style.width = `${(p * 100).toFixed(1)}%`;
    if (this.ring) this.ring.style.strokeDashoffset = (326.7 * (1 - p)).toFixed(1);
  }

  async done() {
    this.set(1, 'READY');
    await new Promise((r) => setTimeout(r, 420));
    cancelAnimationFrame(this._raf);
    document.body.classList.add('ready');
    this.el.classList.add('loader--done');
    setTimeout(() => this.el.remove(), 900);
  }
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
