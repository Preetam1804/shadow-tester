# SOL — an orbital field guide

A single-page scroll odyssey through the solar system. The camera flies an
analytic spline from the star out to the Kuiper belt while eleven chapters lock,
reveal and dissolve over it. Everything you see in 3D is generated at runtime —
no textures, no models, no network requests beyond the fonts.

```bash
npm install
npm run dev        # http://localhost:5173
npm run qa         # headless checks, ~10s, no browser needed
npm run build      # dist/
```

## What is where

| path | role |
| --- | --- |
| `src/config/solar.js` | the single source of truth: radii, orbits, palettes, texture recipes, **and the camera shot for every chapter** |
| `src/lib/noise.js` | hash noise, fBm, crater stamping (with a density mask so maria stay smooth) |
| `src/lib/textures.js` | the baker: albedo / height / normal / roughness / night-lights / clouds, painted into canvases |
| `src/three/shaders.js` | GLSL: planets, atmosphere shells, the star, corona, rings, debris, sky, grade pass |
| `src/three/Factory.js` | one world per call — geometry, shells, rings, moons |
| `src/three/Universe.js` | owns the scene graph, orbits, belts, highlight, the probe |
| `src/three/CameraRig.js` | spline path + look-at + framing solve + FOV/dutch roll (warp) |
| `src/three/Interaction.js` | hover picking, click-to-fly, drag-to-look, keyboard, cursor |
| `src/ui/Overlay.js` | all copy DOM, sticky reveals, rail, telemetry, dossier, flare |
| `src/ui/Preloader.js` | the boot sequence — percentage is *real* bake progress |
| `src/ui/SystemMap.js` | 2D plan-view map, bottom right |
| `tools/` | the headless QA harness (see below) |

## Design decisions worth knowing

**Orbital distance is `84 · AU^0.45`.** Real AU ratios make Neptune 30× further
than Earth and the whole piece unreadable; this compresses the system while
keeping Mercury outside the star and the ordering honest. Radii are *not* to
scale with orbits (they can't be) — each body carries an explicit `radius`
tuned for its shot.

**One body is baked per animation frame.** A 1024×512 fBm pass costs ~0.25 s,
so baking everything up front would freeze the tab. The loader reports actual
progress instead of faking it.

**Baked maps keep alpha at 255.** `CanvasTexture` is uploaded premultiplied; a
painter that leaves `a = 0` gives you black planets in the browser while every
Node-side check still looks perfect. `tools/preview.mjs` asserts on it.

**Framing is an integral solve, not a proportional one.** To put a world on the
third we track the NDC residual and offset the aim against it. Moving the aim
displaces the subject by exactly the offset, so a proportional controller leaves
half the requested bias unmet; the sign is inverted too (to shift the subject
right, aim left). `tools/scene-check.mjs` fails the build if `ndcX` drifts from
the chapter's configured `bias`.

**Craters follow geology, not coverage.** `stampCraters` accepts a density mask
built from the same large-scale field that drives albedo: highlands get battered,
maria stay sparse, plus one extra pass of large lonely basins.

## The headless QA harness

There is no browser in this environment, so the checks drive the real modules
with a canvas/WebGL stub (`tools/dom-stub.mjs`) and verify what can be verified
from the numbers:

- `npm run qa:textures` — bakes every body through the shipping code path and
  rasterises it onto a shaded sphere, including a ray-traced ring plane (planet
  shadow on rings, front/back occlusion). Writes `.qa/*.png` and validates
  albedo range, dead rows, premultiplied alpha.
- `npm run qa:scene` — 11 chapters × 40 frames through `Universe.update` +
  `CameraRig.update`: finiteness everywhere, subject inside the frame, correct
  NDC bias, never inside a body, never too close to the star, sensible px size.
- `npm run qa:shaders` — walks every `ShaderMaterial` in the live graph and
  matches uniforms/varyings/attributes against the GLSL and the geometry.
- `npm run qa:dom` — mounts `index.html` in jsdom, builds the overlay, clicks
  the rail/buttons, scrubs the scroll scalar, and fails if any toggled class has
  no CSS rule behind it.

Still needs a real GPU: final colour/bloom judgement, `EffectComposer` on
Retina, and touch behaviour.
