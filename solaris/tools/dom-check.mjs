/**
 * Headless DOM pass: builds the real page from index.html, mounts the overlay,
 * scrubs the scroll scalar across the whole document and asserts that every
 * chapter renders, reveals, updates the chrome and cleans up.
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { pretendToBeVisual: false, runScripts: 'outside-only' });
global.window = dom.window;
global.document = dom.window.document;
global.ImageData = dom.window.ImageData;
global.matchMedia = dom.window.matchMedia ?? (() => ({ matches: false, addEventListener() {} }));
dom.window.matchMedia = global.matchMedia;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

const problems = [];
const CHAPTERS = (await import('../src/config/solar.js')).CHAPTERS;
const { Overlay } = await import('../src/ui/Overlay.js');
const { Preloader } = await import('../src/ui/Preloader.js');
const { clamp } = await import('../src/lib/math.js');

const calls = { fly: [], dossier: [], focus: [] };
const overlay = new Overlay(CHAPTERS, {
  onFly: (i) => calls.fly.push(i),
  onDossier: (i, open) => calls.dossier.push([i, open]),
  onFocusWorld: (i) => calls.focus.push(i),
  onQuality: (q) => overlay.toast('quality ' + q),
  onMotion: () => {},
});
const sections = overlay.build();
const pre = new Preloader();
pre.set(0.5, 'TESTING');

// structure
if (!sections || sections.length !== CHAPTERS.length) problems.push(`sections ${sections?.length} ≠ chapters ${CHAPTERS.length}`);
CHAPTERS.forEach((ch, i) => {
  const sec = sections[i];
  const grid = sec?.querySelector('.ch__grid');
  if (!grid) return problems.push(`chapter ${i} has no .ch__grid`);
  if (grid.dataset.side !== (ch.side ?? 'left')) problems.push(`chapter ${i} side ${grid.dataset.side} ≠ ${ch.side}`);
  const title = grid.querySelector('.title, .hero-title');
  if (!title) problems.push(`chapter ${i} has no title`);
  const chars = [...grid.querySelectorAll('.ch_i')];
  if (!chars.length) problems.push(`chapter ${i} title was not split for reveal`);
  const kicker = grid.querySelector('[data-scramble]');
  if (kicker && ch.index && !kicker.dataset.scramble.includes(ch.index)) problems.push(`chapter ${i} kicker missing index`);
  (ch.stats ?? []).forEach((s, n) => {
    const dd = grid.querySelectorAll('.stats dd')[n];
    if (!dd) problems.push(`chapter ${i} stat ${n} missing`);
    else if (dd.dataset.val !== s[1]) problems.push(`chapter ${i} stat ${n} value ${dd.dataset.val} ≠ ${s[1]}`);
  });
  if (!grid.querySelector('.lede, .hero-lead')) problems.push(`chapter ${i} has no lede`);
  if (i === 0 && !grid.querySelector('.hero-word')) problems.push('hero missing its background word');
});
if (!document.querySelector('.tail')) problems.push('no scroll tail spacer after the last chapter');

// chrome wiring
const need = ['rail', 'quality', 'motion', 'prog-fill', 'foot-name', 'foot-au', 'tl-chapter', 'tl-au', 'tl-vel', 'tl-fov', 'tl-fps', 'tl-warp', 'hint', 'flare', 'loader', 'load-pct', 'load-bar', 'load-status'];
for (const id of need) if (!document.getElementById(id)) problems.push(`missing #${id}`);
if (document.querySelectorAll('.rail__item').length !== CHAPTERS.length) problems.push('rail item count mismatch');

// interactions
document.querySelector('.rail__item[data-i="3"]').click();
if (!calls.fly.includes(3)) problems.push('rail click did not call onFly(3)');
sections[2].querySelector('[data-act="fly"]').click();
if (!calls.fly.includes(2)) problems.push('chapter fly button did not call onFly(2)');
const orbit = sections[3].querySelector('[data-act="orbit"]');
if (orbit) { orbit.click(); if (!calls.focus.includes(3)) problems.push('orbit button did not call onFocusWorld'); }
else problems.push('earth chapter has no orbit button');
const dos = sections[4].querySelector('[data-act="dossier"]');
dos?.click();
if (!calls.dossier.length) problems.push('dossier button inert');
if (!overlay.dossier) problems.push('dossier element not created');
overlay.openDossier(CHAPTERS[4]);
if (!overlay.dossier.classList.contains('is-open')) problems.push('dossier did not open');
if (!document.body.classList.contains('dossier-open')) problems.push('body flag not set for rail fade');
overlay.openDossier(CHAPTERS[1]);
if (!overlay.dossier.classList.contains('dossier--right')) problems.push('left-side chapter did not flip the dossier');
overlay.closeDossier();
if (overlay.dossier.classList.contains('is-open')) problems.push('dossier did not close');
document.querySelector('[data-top]').click();
if (!calls.fly.includes(-1)) problems.push('brand link did not request the top');

// scrub the scroll scalar and make sure fades track it
overlay.setChapter(0);
const H = 1800;
let maxFade = 0;
for (let y = 0; y <= H * CHAPTERS.length; y += H / 4) {
  const cf = y / H;
  const i = Math.min(CHAPTERS.length - 1, Math.max(0, Math.round(cf - 0.5)));
  overlay.setChapter(i);
  overlay.tick({
    cf,
    progress: clamp(y / (H * CHAPTERS.length)),
    warp: 0.3,
    velocity: 120,
    fov: 44,
    fps: 60,
    au: cf * 3.4,
    sunScreen: { x: 0.5, y: 0.4 },
    sunVis: 0.4,
  });
  const f = parseFloat(sections[i].style.getPropertyValue('--fade') || '0');
  if (!Number.isFinite(f)) problems.push(`--fade is NaN on chapter ${i} at cf ${cf.toFixed(2)}`);
  maxFade = Math.max(maxFade, f);
  if (/NaN|undefined/.test(sections[i].innerHTML)) problems.push(`chapter ${i} markup contains NaN/undefined`);
}
if (maxFade < 0.99) problems.push(`no chapter ever reached full opacity (max ${maxFade})`);
if (document.getElementById('load-pct').textContent === '0') problems.push('preloader percentage never moved');
for (const s of sections) if (/NaN/.test(s.getAttribute('style') ?? '')) problems.push('section style contains NaN');
if (document.documentElement.style.getPropertyValue('--accent') === '') problems.push('accent var never set');

console.log(`sections: ${sections.length} · reveal chars: ${document.querySelectorAll('.ch_i').length} · stat cells: ${document.querySelectorAll('.stats dd').length}`);
if (problems.length) {
  console.log('\nPROBLEMS:');
  [...new Set(problems)].forEach((p) => console.log('  ✗ ' + p));
  process.exitCode = 1;
} else console.log('\n✓ overlay, chrome, buttons and scroll-driven reveals all behave');

/* ── contract check: every class the JS toggles must actually be styled ── */
{
  const fs = await import('node:fs');
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${f.name}`;
      if (f.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  files.push(new URL('../index.html', import.meta.url).pathname);
  const css = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const used = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([\w-]+)'/g)) {
      if (!used.has(m[1])) used.set(m[1], f.split('/').pop());
    }
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c && !c.includes('$') && !used.has(c)) used.set(c, f.split('/').pop());
    }
  }
  const unstyled = [];
  for (const [cls, where] of used) {
    if (cls.startsWith('ch__') || cls.startsWith('hero') || cls.startsWith('fx-')) continue; // structural, styled via their own blocks
    if (!new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css)) unstyled.push(`${cls} (toggled in ${where})`);
  }
  const vars = ['--fade', '--vis', '--r', '--accent', '--x', '--y'];
  const unusedVars = vars.filter((v) => !css.includes(`var(${v}`));
  if (unstyled.length || unusedVars.length) {
    console.log('\nCLASS/VAR CONTRACT:');
    unstyled.forEach((u) => console.log('  ✗ no CSS rule for .' + u));
    unusedVars.forEach((v) => console.log(`  ✗ nothing reads ${v}`));
    process.exitCode = 1;
  } else {
    console.log(`\n✓ ${used.size} toggled classes all have CSS; state vars all consumed`);
  }
}
dom.window.close();
process.exit(process.exitCode ?? 0);
