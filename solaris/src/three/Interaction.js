import * as THREE from 'three';
import { clamp, damp } from '../lib/math.js';

/**
 * Pointer + keyboard layer: hover picking, click-to-fly, drag-to-look with
 * inertia, and the custom cursor. Nothing here touches the camera directly —
 * it feeds the rig, which owns smoothing.
 */
export class Interaction {
  constructor(canvas, universe, camera, { onPick, onHover, onKey } = {}) {
    this.canvas = canvas;
    this.universe = universe;
    this.camera = camera;
    this.onPick = onPick ?? (() => {});
    this.onHover = onHover ?? (() => {});
    this.onKey = onKey ?? (() => {});

    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2(-2, -2);
    this.pointer = { x: 0, y: 0 };
    this.pointerSm = { x: 0, y: 0 };
    this.drag = { x: 0, y: 0 };
    this.dragVel = { x: 0, y: 0 };
    this.dragTarget = { x: 0, y: 0 };
    this.dragging = false;
    this.moved = 0;
    this.down = null;
    this.hovered = null;
    this.enabled = true;
    this._throttle = 0;
    this.fine = matchMedia('(pointer: fine)').matches;

    this.cursor = document.getElementById('cursor');
    this.tag = document.getElementById('tag');
    this.tagName = document.getElementById('tag-name');
    if (this.fine && this.cursor) document.body.classList.add('hide-cursor');
    this.cursorPos = { x: innerWidth / 2, y: innerHeight / 2 };
    this.cursorDraw = { ...this.cursorPos };

    this._bind();
  }

  _bind() {
    const el = this.canvas;
    this._onMove = (e) => {
      const x = e.clientX;
      const y = e.clientY;
      this.cursorPos.x = x;
      this.cursorPos.y = y;
      this.pointer.x = (x / innerWidth) * 2 - 1;
      this.pointer.y = -((y / innerHeight) * 2 - 1);
      this.ndc.set(this.pointer.x, this.pointer.y);
      if (this.dragging) {
        const dx = x - this.down.x;
        const dy = y - this.down.y;
        this.moved += Math.abs(dx) + Math.abs(dy);
        const k = 0.00072;
        if (this.dragMode === 'touch') {
          this.dragTarget.x = clamp(this.dragStart.x - dx * k * 2.4, -0.3, 0.3);
        } else {
          this.dragTarget.x = clamp(this.dragStart.x - dx * k, -0.26, 0.26);
          this.dragTarget.y = clamp(this.dragStart.y - dy * k * 0.8, -0.15, 0.15);
        }
      }
    };
    this._onDown = (e) => {
      if (e.target !== this.canvas) return;
      this.dragging = true;
      this.dragMode = e.pointerType === 'touch' ? 'touch' : 'mouse';
      this.down = { x: e.clientX, y: e.clientY };
      this.dragStart = { x: this.dragTarget.x, y: this.dragTarget.y };
      this.moved = 0;
      this.cursor?.classList.add('is-press');
    };
    this._onUp = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.cursor?.classList.remove('is-press');
      const quick = this.moved < 6;
      if (quick && e.target === this.canvas) {
        // a click, not a drag → pick a world
        this._pick(true);
      }
      this.dragStart = { ...this.dragTarget };
    };
    this._onLeave = () => {
      this.dragging = false;
      this.pointer.x = 0;
      this.pointer.y = 0;
      this.ndc.set(-2, -2);
      this.cursor?.classList.remove('is-press');
    };
    this._onKey = (e) => {
      const k = e.key;
      if (k === 'Escape') this.onKey('escape');
      else if (k === 'ArrowDown' || k === 'PageDown') this.onKey('next');
      else if (k === 'ArrowUp' || k === 'PageUp') this.onKey('prev');
      else if (k === 'Home') this.onKey('home');
      else if (k === 'End') this.onKey('end');
      else if (k === ' ') {
        e.preventDefault();
        this.onKey('next');
      }
    };

    window.addEventListener('pointermove', this._onMove, { passive: true });
    window.addEventListener('pointerdown', this._onDown, { passive: true });
    window.addEventListener('pointerup', this._onUp, { passive: true });
    window.addEventListener('pointercancel', this._onLeave);
    document.addEventListener('pointerleave', this._onLeave);
    window.addEventListener('keydown', this._onKey);
  }

  _pick(isClick = false) {
    if (!this.enabled) return;
    this.ray.setFromCamera(this.ndc, this.camera);
    const hits = this.ray.intersectObjects(this.universe.pickables, false);
    if (!hits.length) {
      if (isClick) this.onPick(null);
      return null;
    }
    const hit = hits.find((h) => h.object.visible);
    if (!hit) return null;
    let info = hit.object.userData.body ?? null;
    this.label = null;
    if (info?.kind === 'moon') {
      this.label = info.name; // a moon picks its planet, but we keep the name for the label
      info = info.parent;
    }
    if (!info) return null;
    if (isClick) this.onPick(info, hit);
    return { info, dist: hit.distance, label: this.label };
  }

  update(dt, viewport) {
    // cursor lags the real pointer a touch — reads as weight, not latency
    this.cursorDraw.x = damp(this.cursorDraw.x, this.cursorPos.x, 26, dt);
    this.cursorDraw.y = damp(this.cursorDraw.y, this.cursorPos.y, 26, dt);
    if (this.cursor) this.cursor.style.transform = `translate3d(${this.cursorDraw.x}px,${this.cursorDraw.y}px,0)`;

    this.pointerSm.x = damp(this.pointerSm.x, this.pointer.x, 5, dt);
    this.pointerSm.y = damp(this.pointerSm.y, this.pointer.y, 5, dt);

    // drag: spring back toward zero with a little overshoot-damped inertia
    if (!this.dragging) {
      this.dragTarget.x *= Math.exp(-1.8 * dt);
      this.dragTarget.y *= Math.exp(-1.8 * dt);
    }
    this.drag.x = damp(this.drag.x, this.dragTarget.x, this.dragging ? 18 : 7, dt);
    this.drag.y = damp(this.drag.y, this.dragTarget.y, this.dragging ? 18 : 7, dt);

    // hover picking, throttled — a ray against ~30 spheres is cheap but not free
    this._throttle -= dt;
    if (this._throttle <= 0) {
      this._throttle = 1 / 40;
      const res = this.dragging ? null : this._pick(false);
      const info = res?.info ?? null;
      const changed = this.universe.setHover(info);
      this.hovered = info;
      if (this.cursor) this.cursor.classList.toggle('is-hot', !!info);
      if (this.tag) {
        if (info) {
          const name = info.name;
          this.tagName.textContent = this.label
            ? `${this.label} · moon of ${name}`
            : `${name} · ${info.isSun ? 'the star' : 'click to fly'}`;
          this.tag.classList.add('is-on');
        } else {
          this.tag.classList.remove('is-on');
        }
      }
      if (changed) this.onHover(info);
    }
    if (this.tag) {
      const x = clamp(this.cursorDraw.x + 26, 8, viewport.w - 190);
      const y = clamp(this.cursorDraw.y - 14, 8, viewport.h - 40);
      this.tag.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    return { pointer: this.pointerSm, drag: this.drag, hovering: !!this.hovered };
  }

  dispose() {
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onLeave);
    document.removeEventListener('pointerleave', this._onLeave);
    window.removeEventListener('keydown', this._onKey);
  }
}
