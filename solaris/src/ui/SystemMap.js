import { clamp } from '../lib/math.js';

/**
 * Top-down orbital plot, redrawn from live scene state. Not decoration — it is
 * a navigation aid: the wedge is where the camera actually is.
 */
export class SystemMap {
  constructor(universe, { maxR = 400 } = {}) {
    this.universe = universe;
    this.maxR = maxR;
    this.canvas = document.getElementById('map-canvas');
    this.wrap = document.getElementById('map');
    this.ctx = this.canvas?.getContext('2d');
    this._acc = 0;
    this.visible = true;
    if (this.canvas) {
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const size = 260;
      this.canvas.width = size * dpr;
      this.canvas.height = size * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.size = size;
    }
  }

  update(dt, state) {
    if (!this.ctx || !this.visible) return;
    this._acc -= dt;
    if (this._acc > 0) return;
    this._acc = 1 / 24;
    this.draw(state);
  }

  draw(state) {
    const c = this.ctx;
    const s = this.size;
    const cx = s / 2;
    const cy = s / 2;
    const scale = (s / 2 - 16) / this.maxR;
    c.clearRect(0, 0, s, s);

    // field
    c.save();
    c.beginPath();
    c.arc(cx, cy, s / 2 - 4, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(255,255,255,0.012)';
    c.fillRect(0, 0, s, s);

    // graticule
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 0.5;
    for (let r = 1; r <= 4; r++) {
      c.beginPath();
      c.arc(cx, cy, ((s / 2 - 16) / 4) * r, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(cx - s / 2, cy);
    c.lineTo(cx + s / 2, cy);
    c.moveTo(cx, cy - s / 2);
    c.lineTo(cx, cy + s / 2);
    c.stroke();

    const bodies = this.universe.mapState();

    // orbits + planets
    for (const b of bodies) {
      const r = b.r * scale;
      const active = state.activeId === b.id || state.aimId === b.id;
      c.strokeStyle = active ? hexA(state.accent, 0.55) : 'rgba(255,255,255,0.13)';
      c.lineWidth = active ? 1 : 0.6;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();

      const px = cx + Math.cos(b.angle) * r;
      const py = cy + Math.sin(b.angle) * r;
      b._px = px;
      b._py = py;
      c.fillStyle = active ? '#fff' : hexA(b.color, 0.85);
      c.beginPath();
      c.arc(px, py, active ? 2.9 : 1.7, 0, Math.PI * 2);
      c.fill();
      if (active) {
        c.strokeStyle = state.accent;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(px, py, 6.5, 0, Math.PI * 2);
        c.stroke();
      }
    }

    // sun
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, 13);
    g.addColorStop(0, 'rgba(255,236,190,0.95)');
    g.addColorStop(0.35, hexA(state.accent, 0.5));
    g.addColorStop(1, 'rgba(255,160,60,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, 13, 0, Math.PI * 2);
    c.fill();

    // camera wedge
    const cam = state.camPos;
    const look = state.lookAt;
    const dx = (look.x - cam.x) * scale;
    const dz = (look.z - cam.z) * scale;
    const ang = Math.atan2(dz, dx);
    const mx = clamp(cx + cam.x * scale, -40, s + 40);
    const my = clamp(cy + cam.z * scale, -40, s + 40);
    c.save();
    c.translate(mx, my);
    c.rotate(ang);
    const fovR = (state.fov * Math.PI) / 360;
    const wg = c.createLinearGradient(0, 0, 46, 0);
    wg.addColorStop(0, hexA(state.accent, 0.42));
    wg.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = wg;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 46, -fovR * 1.5, fovR * 1.5);
    c.closePath();
    c.fill();
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(0, 0, 2.2, 0, Math.PI * 2);
    c.fill();
    c.restore();

    // edge frame
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, s / 2 - 4, 0, Math.PI * 2);
    c.stroke();
  }
}

function hexA(hex, a = 1) {
  if (!hex) return `rgba(255,255,255,${a})`;
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
