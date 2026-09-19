import { clamp, smoothstep, rng } from '../lib/math.js';

/* tiny presentational helpers ------------------------------------------------ */

const GLYPHS = '▚▞░▒█/\\<>{}[]#*+=-_·0123456789ABCDEFGHKLMNORSTUVXZ';
function scramble(el, finalText, duration = 780) {
  if (!el) return;
  const rand = rng(el.__seed ?? (el.__seed = Math.floor(Math.random() * 9999)));
  const chars = [...finalText];
  const start = performance.now();
  const step = () => {
    const p = clamp((performance.now() - start) / duration);
    const solid = Math.floor(p * chars.length * 1.25);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      if (i < solid || chars[i] === ' ') out += chars[i];
      else out += GLYPHS[Math.floor(rand() * GLYPHS.length)];
    }
    el.textContent = out;
    if (p < 1) el.__raf = requestAnimationFrame(step);
    else el.textContent = finalText;
  };
  cancelAnimationFrame(el.__raf);
  step();
}

function countUp(el, finalStr, duration = 900) {
  if (!el) return;
  const m = finalStr.match(/^(-?[\d,]*\.?\d*)/);
  if (!m) {
    el.textContent = finalStr;
    return;
  }
  const raw = m[1];
  const hasComma = raw.includes(',');
  const decimals = (raw.split('.')[1] ?? '').length;
  const value = parseFloat(raw.replace(/,/g, ''));
  const tail = finalStr.slice(raw.length);
  if (!isFinite(value)) {
    el.textContent = finalStr;
    return;
  }
  const start = performance.now();
  const fmt = (v) => {
    const s = v.toFixed(decimals);
    return hasComma ? Number(s).toLocaleString('en-US', { minimumFractionDigits: decimals }) : s;
  };
  const step = () => {
    const p = clamp((performance.now() - start) / duration);
    const e = 1 - Math.pow(1 - p, 4.2);
    el.textContent = fmt(value * e) + tail;
    if (p < 1) el.__raf = requestAnimationFrame(step);
    else el.textContent = finalStr;
  };
  cancelAnimationFrame(el.__raf);
  step();
}

const splitChars = (word, offset = 0) =>
  [...word]
    .map((c, i) => `<span class="msk"><span class="ch_i" style="--i:${i + offset}">${c}</span></span>`)
    .join('');

/* ── the overlay itself ─────────────────────────────────────────────────── */

export class Overlay {
  constructor(chapters, { onFly, onDossier, onFocusWorld, onQuality, onMotion } = {}) {
    this.chapters = chapters;
    this.onFly = onFly ?? (() => {});
    this.onDossier = onDossier ?? (() => {});
    this.onFocusWorld = onFocusWorld ?? (() => {});
    this.onQuality = onQuality ?? (() => {});
    this.onMotion = onMotion ?? (() => {});
    this.el = document.getElementById('scroll');
    this.sections = [];
    this.worldCount = 1 + chapters.filter((c) => c.kind === 'body').reduce((n, c) => n + 1 + (c.moons?.length ?? 0), 0);
    this.active = -1;
    this.accent = '#ff9d3c';
  }

  build() {
    const html = this.chapters.map((ch, i) => `<section class="ch ch--${ch.kind}" data-i="${i}">${this.inner(ch, i)}</section>`).join('');
    this.el.insertAdjacentHTML('beforeend', html + `<div class="tail" style="height:100svh"></div>`);
    this.sections = [...this.el.querySelectorAll('.ch')];

    // chapter rail
    const rail = document.getElementById('rail');
    rail.innerHTML = this.chapters
      .map(
        (ch, i) => `<button class="rail__item" data-i="${i}" title="${ch.name}">
            <span class="rail__label">${ch.index ?? '00'}</span><span class="rail__mark"></span>
          </button>`
      )
      .join('');
    rail.addEventListener('click', (e) => {
      const b = e.target.closest('.rail__item');
      if (b) this.onFly(+b.dataset.i);
    });
    this.railItems = [...rail.children];

    // header controls
    document.getElementById('quality').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      [...e.currentTarget.children].forEach((c) => c.classList.toggle('is-on', c === b));
      this.onQuality(b.dataset.q);
    });
    const motion = document.getElementById('motion');
    motion.addEventListener('click', () => {
      const on = motion.getAttribute('aria-pressed') === 'true';
      motion.setAttribute('aria-pressed', String(!on));
      motion.textContent = on ? 'Motion: auto' : 'Motion: calm';
      this.onMotion(!on);
    });
    document.querySelector('[data-top]')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.onFly(-1);
    });

    // chapter interactions (delegated)
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const i = +btn.closest('.ch').dataset.i;
      const act = btn.dataset.act;
      if (act === 'fly') this.onFly(i);
      if (act === 'dossier') this.onDossier(i, true);
      if (act === 'orbit') this.onFocusWorld(i);
      if (act === 'top') this.onFly(-1);
    });

    this.dossier = this.buildDossier();
    this.dom = {
      progFill: document.getElementById('prog-fill'),
      footName: document.getElementById('foot-name'),
      footAu: document.getElementById('foot-au'),
      tlChapter: document.getElementById('tl-chapter'),
      tlAu: document.getElementById('tl-au'),
      tlVel: document.getElementById('tl-vel'),
      tlFov: document.getElementById('tl-fov'),
      tlFps: document.getElementById('tl-fps'),
      tlWarp: document.getElementById('tl-warp'),
      hint: document.getElementById('hint'),
      hdr: document.querySelector('.hdr'),
      flare: document.getElementById('flare'),
    };
    return this.sections;
  }

  inner(ch, i) {
    const side = ch.side ?? 'left';
    if (ch.kind === 'hero') {
      return `<div class="ch__sticky"><div class="ch__grid" data-side="center">
        <span class="hero-word" aria-hidden="true">SOLAR</span>
        <p class="kicker"><i></i>An orbital field guide<b> / 01</b></p>
        <h1 class="hero-title">${splitChars('SOLAR')}<span class="hero-title__sub">System</span></h1>
        <p class="hero-lead">${ch.lede}</p>
        <div class="hero-meta">
          <span><b>1</b> star</span>
          <span><b>8</b> planets</span>
          <span><b>1</b> dwarf</span>
          <span><b>${this.worldCount}</b> charted</span>
        </div>
      </div></div>`;
    }
    const title = ch.serifWord
      ? `${splitChars(ch.title[0])}<em>${ch.serifWord}</em>`
      : splitChars(ch.title[0]);
    const stats = (ch.stats ?? [])
      .map(([label, value, unit]) => `<li><dt>${label}</dt><dd data-val="${value}">${value}${unit ? `<sup>${unit}</sup>` : ''}</dd></li>`)
      .join('');
    const chips = (ch.chips ?? []).map((c) => `<span class="chip"><s>◦</s>${c}</span>`).join('');
    return `<div class="ch__sticky"><div class="ch__grid" data-side="${side}">
      <p class="kicker"><i></i><span data-scramble="${ch.index} · ${ch.eyebrow}">${ch.index} · ${ch.eyebrow}</span>${
        ch.type ? `<b>/ ${ch.type}</b>` : ''
      }</p>
      <h2 class="title">${title}</h2>
      <p class="lede">${ch.lede}</p>
      ${stats ? `<ul class="stats">${stats}</ul>` : ''}
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <div class="acts">
        <button class="btn btn--accent" data-act="fly"><span>Fly to ${ch.name}</span>
          <svg viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg></button>
        ${ch.kind === 'body' ? `<button class="btn" data-act="orbit"><span>Hold orbit</span></button>` : ''}
        ${ch.kind === 'body' ? `<button class="btn" data-act="dossier"><span>Dossier</span></button>` : ''}
        ${ch.kind === 'outro' ? `<button class="btn" data-act="top"><span>Return to the star</span></button>` : ''}
      </div>
      ${ch.kind === 'outro' ? this.credits() : ''}
    </div></div>`;
  }

  credits() {
    return `<div class="credits">
      <span><b>scene</b> three.js r186 · custom glsl · no post-processing presets</span>
      <span><b>surfaces</b> baked on the cpu from value-noise + crater stamping</span>
      <span><b>camera</b> one catmull–rom spline, closed-loop framing, damped aim</span>
      <span><b>input</b> scroll · drag · hover · click · ↑ ↓ esc</span>
    </div>`;
  }

  buildDossier() {
    const el = document.createElement('aside');
    el.className = 'dossier';
    el.innerHTML = `<button class="dossier__close" aria-label="close">×</button>
      <h3 data-f="name"></h3><div class="dossier__type" data-f="type"></div>
      <p data-f="blurb"></p><dl data-f="rows"></dl>`;
    document.body.appendChild(el);
    el.querySelector('.dossier__close').addEventListener('click', () => this.closeDossier());
    el.addEventListener('click', (e) => {
      if (e.target === el) this.closeDossier();
    });
    return el;
  }

  openDossier(ch, extra = {}) {
    if (!ch) return;
    const d = this.dossier;
    const rows = (ch.stats ?? [])
      .map(([k, v, u]) => `<div><dt>${k}</dt><dd>${v}${u ? ' ' + u : ''}</dd></div>`)
      .join('');
    d.querySelector('[data-f="name"]').textContent = ch.name;
    d.querySelector('[data-f="type"]').textContent = ch.type ?? ch.eyebrow ?? '';
    d.querySelector('[data-f="blurb"]').textContent = (ch.lede ?? '').replace(/<[^>]+>/g, '');
    d.querySelector('[data-f="rows"]').innerHTML =
      rows +
      (extra.hit ? `<div><dt>range</dt><dd>${Math.round(extra.hit.distance)} u</dd></div>` : '') +
      (ch.au ? `<div><dt>from earth</dt><dd>${Math.abs(ch.au - 1).toFixed(2)} AU</dd></div>` : '');
    d.classList.toggle('dossier--right', ch.side === 'left');
    d.classList.add('is-open');
    document.body.classList.add('dossier-open');
    this.dossierCh = ch.id;
  }

  closeDossier() {
    this.dossier?.classList.remove('is-open', 'dossier--right');
    document.body.classList.remove('dossier-open');
    this.dossierCh = null;
  }

  /** small transient line in the footer — quality switches, focus state, etc. */
  toast(msg, ms = 1700) {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'toast';
      document.body.appendChild(this.toastEl);
    }
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('is-on');
    clearTimeout(this.__toastT);
    this.__toastT = setTimeout(() => this.toastEl.classList.remove('is-on'), ms);
  }

  setChapter(i) {
    if (i === this.active) return;
    const prev = this.sections[this.active];
    prev?.classList.remove('is-in');
    const ch = this.chapters[i];
    if (ch) {
      document.documentElement.style.setProperty('--accent', ch.accent);
      document.documentElement.style.setProperty('--accent-soft', hexA(ch.accent, 0.2));
      this.accent = ch.accent;
      this.railItems.forEach((r, n) => r.classList.toggle('is-on', n === i));
      this.dom.footName.textContent = (ch.name ?? '').toUpperCase();
      const sec = this.sections[i];
      sec?.classList.add('is-in');
      // decode-in the eyebrow and count the stats up on arrival
      const scr = sec?.querySelector('[data-scramble]');
      if (scr) scramble(scr, scr.dataset.scramble, 620);
      sec?.querySelectorAll('.stats dd[data-val]').forEach((dd, n) => setTimeout(() => countUp(dd, dd.dataset.val, 850), n * 70));
    }
    this.active = i;
  }

  /** per-frame: fades, parallax on the text blocks, chrome readouts */
  tick({ cf, progress, warp, velocity, fov, fps, au, sunScreen, sunVis }) {
    const n = this.chapters.length;
    for (let i = 0; i < n; i++) {
      const sec = this.sections[i];
      if (!sec) continue;
      const u = cf - i; // 0 → 1 while this section owns the viewport
      if (u < -1.2 || u > 2.2) {
        if (sec.__fade !== 0) {
          sec.style.setProperty('--fade', 0);
          sec.__fade = 0;
        }
        continue;
      }
      // the hero is already in place on load; every other chapter eases in and out
      const fade = (i === 0 ? 1 : smoothstep(-0.02, 0.26, u)) * (i === this.chapters.length - 1 ? 1 : smoothstep(1.18, 0.82, u));
      if (Math.abs(fade - (sec.__fade ?? -1)) > 0.004) {
        sec.style.setProperty('--fade', fade.toFixed(3));
        const sticky = sec.firstElementChild;
        if (sticky) {
          const shift = (0.5 - clamp(u, 0, 1)) * (i === 0 ? 18 : 34);
          sticky.style.setProperty('--vis', (0.25 + fade * 0.75).toFixed(3));
          sticky.style.translate = `0 ${shift.toFixed(1)}px`;
        }
        const grid = sec.querySelector('.ch__grid');
        if (grid) grid.style.setProperty('--r', smoothstep(0.05, 0.5, u).toFixed(3));
        sec.__fade = fade;
      }
    }

    const d = this.dom;
    d.progFill.style.width = `${(clamp(progress) * 100).toFixed(2)}%`;
    const bkm = au * 149.598;
    d.footAu.textContent = `${au.toFixed(2)} AU · ${bkm.toFixed(2)} BKM`;
    d.tlChapter.textContent = `${String(this.active + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    d.tlAu.textContent = `${au.toFixed(2)} AU`;
    d.tlVel.textContent = `${velocity.toFixed(0)} u/s`;
    d.tlFov.textContent = `${fov.toFixed(1)}°`;
    d.tlFps.textContent = String(Math.round(fps));
    d.tlWarp.style.width = `${clamp(warp / 1.1) * 100}%`;
    document.body.classList.toggle('warping', warp > 0.16);
    d.hint.classList.toggle('hint--gone', cf > 0.42);
    d.hdr.classList.toggle('hdr--hidden', cf > 1.15 && this.scrolledDown && !this.dragging);
    this.lastCf = cf;

    if (d.flare) {
      if (sunVis > 0.001) {
        d.flare.style.opacity = sunVis.toFixed(3);
        d.flare.style.setProperty('--x', `${(sunScreen.x * 100).toFixed(2)}%`);
        d.flare.style.setProperty('--y', `${((1 - sunScreen.y) * 100).toFixed(2)}%`);
        // the streak stretches and the core swells as the star nears the frame centre
        const near = 1 - Math.min(1, Math.hypot(sunScreen.x - 0.5, sunScreen.y - 0.5) * 2);
        d.flare.style.setProperty('--fx', (0.72 + sunVis * 0.5 + near * 0.34).toFixed(3));
      } else d.flare.style.opacity = '0';
    }
  }

  setScrollFlags({ scrolledDown, dragging }) {
    this.scrolledDown = scrolledDown;
    this.dragging = dragging;
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
