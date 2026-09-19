import * as THREE from 'three';
import {
  SUN_FRAG,
  WORLD_VERT,
  CORONA_FRAG,
  PLANET_VERT,
  PLANET_FRAG,
  CLOUD_FRAG,
  ATMO_FRAG,
  RING_FRAG,
  RING_VERT,
  STARS_VERT,
  STARS_FRAG,
  SKY_FRAG,
  SKY_VERT,
  ORBIT_VERT,
  ORBIT_FRAG,
  RETICLE_FRAG,
  RETICLE_VERT,
  TRAIL_VERT,
  TRAIL_FRAG,
} from './shaders.js';
import { bakeBody, bakeMoon, bakeRingTexture, bakeGlow, bakeStarSprite } from '../lib/textures.js';
import { rng } from '../lib/math.js';

const UP = new THREE.Vector3(0, 1, 0);

/** normal-map authoring strength, then how hard the shader leans on it */
const BUMP = { rocky: 1.55, mars: 1.5, earth: 1.35, bands: 0.42, ice: 0.5, swirl: 0.3 };
const RELIEF = { rocky: 0.62, mars: 0.6, earth: 0.5, bands: 0.16, ice: 0.22, swirl: 0.1 };

/** uniforms every lit body reads from */
export function makeShared() {
  return {
    uTime: { value: 0 },
    uSunPos: { value: new THREE.Vector3(0, 0, 0) },
    uSunColor: { value: new THREE.Color('#fff0d4').multiplyScalar(1.0) },
    uSunIntensity: { value: 1.45 },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   SUN
   ══════════════════════════════════════════════════════════════════════ */
export function makeSun(radius, shared, q) {
  const group = new THREE.Group();
  group.name = 'sun';

  const geo = new THREE.IcosahedronGeometry(radius, q.segs[0] > 72 ? 6 : 5);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uIntensity: { value: 1.75 },
      uHot: { value: new THREE.Color('#fff6da') },
      uMid: { value: new THREE.Color('#ffb04d') },
      uCool: { value: new THREE.Color('#e8542a') },
      uSpot: { value: new THREE.Color('#6d2a14') },
    },
    vertexShader: WORLD_VERT,
    fragmentShader: SUN_FRAG,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sun';
  group.add(mesh);

  // chromosphere + outer corona shells
  const shells = [];
  [
    [1.045, 2.4, 0.5, '#ff8a2e'],
    [1.16, 1.5, 0.34, '#ff6a1e'],
    [1.5, 1.1, 0.16, '#ffb45e'],
  ].forEach(([s, power, strength, color], i) => {
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius, Math.max(3, q.segs[1] > 48 ? 4 : 3)),
      new THREE.ShaderMaterial({
        uniforms: { uTime: shared.uTime, uColor: { value: new THREE.Color(color) }, uPower: { value: power }, uStrength: { value: strength } },
        vertexShader: WORLD_VERT,
        fragmentShader: CORONA_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    m.scale.setScalar(s);
    m.renderOrder = 2 + i;
    group.add(m);
    shells.push(m);
  });

  // broad halo sprite, scaled with distance so it reads as lens glow
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: bakeGlow(256, 'rgba(255,255,255,0.95)', 'rgba(255,170,80,0.5)'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    })
  );
  glow.scale.setScalar(radius * 26);
  glow.renderOrder = 1;
  group.add(glow);

  const light = new THREE.PointLight(0xfff1dc, 2.35, 0, 0);
  group.add(light);
  const bounce = new THREE.HemisphereLight(0x24314f, 0x0a0a10, 0.35);
  group.add(bounce);

  return { group, mesh, glow, shells, light, radius };
}

/* ══════════════════════════════════════════════════════════════════════
   PLANETS
   ══════════════════════════════════════════════════════════════════════ */
export function makeBody(spec, shared, q, sunRadius) {
  const texSize = q.tex >= 1024 ? { w: 1024, h: 512 } : { w: Math.min(768, q.tex * 1.5) | 0, h: Math.min(384, q.tex * 0.75) | 0 };
  const baked = bakeBody(
    {
      ...spec.tex,
      craters: spec.craters,
      night: spec.night,
      ocean: spec.ocean,
      clouds: spec.clouds,
      rough: spec.rough,
      normalStrength: BUMP[spec.tex?.kind ?? spec.kind] ?? 1.6,
    },
    { ...texSize, aniso: q.aniso }
  );

  const radius = spec.radius;
  const pivot = new THREE.Group(); // orbital position
  pivot.name = `pivot:${spec.id}`;
  const tilt = new THREE.Group(); // obliquity, also the ring plane frame
  tilt.rotation.z = spec.tilt ?? 0;
  pivot.add(tilt);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: baked.map },
      uNormalMap: { value: baked.normalMap },
      uRoughMap: { value: baked.roughnessMap },
      uNightMap: { value: baked.nightMap ?? baked.map },
      uHasNight: { value: baked.nightMap ? 1 : 0 },
      uSunPos: shared.uSunPos,
      uSunColor: shared.uSunColor,
      uSunIntensity: shared.uSunIntensity,
      uTime: shared.uTime,
      uAtmoColor: { value: new THREE.Color(spec.atmo) },
      uAtmoStrength: { value: spec.atmoStrength ?? 0.25 },
      uBump: { value: RELIEF[spec.tex?.kind ?? spec.kind] ?? 0.5 },
      uHighlight: { value: 0 },
      uAmbient: { value: new THREE.Color(spec.atmo).multiplyScalar(0.035) },
      uRing: { value: spec.rings ? 1 : 0 },
      uRingCenter: { value: new THREE.Vector3() },
      uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
      uRingSpan: { value: new THREE.Vector2(0, 1) },
      uRingTex: { value: null },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
  });

  const segs = q.segs;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segs[0], segs[1]), mat);
  mesh.name = spec.id;
  tilt.add(mesh);

  let clouds = null;
  if (baked.cloudMap) {
    clouds = new THREE.Mesh(
      new THREE.SphereGeometry(radius * spec.clouds.size, Math.max(48, segs[0] * 0.75) | 0, Math.max(32, segs[1] * 0.75) | 0),
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: baked.cloudMap },
          uSunPos: shared.uSunPos,
          uSunColor: shared.uSunColor,
          uSunIntensity: shared.uSunIntensity,
          uColor: { value: new THREE.Color(spec.clouds.color) },
          uAtmoColor: { value: new THREE.Color(spec.atmo) },
          uTime: shared.uTime,
          uOpacity: { value: spec.clouds.alpha === 'venus' ? 0.82 : spec.clouds.alpha === 'neptune' ? 0.5 : 0.86 },
        },
        vertexShader: PLANET_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
      })
    );
    clouds.renderOrder = 2;
    tilt.add(clouds);
  }

  let atmo = null;
  if ((spec.atmoStrength ?? 0) > 0.12) {
    atmo = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.13, Math.max(36, segs[0] * 0.6) | 0, Math.max(24, segs[1] * 0.6) | 0),
      new THREE.ShaderMaterial({
        uniforms: {
          uSunPos: shared.uSunPos,
          uCenter: { value: new THREE.Vector3() },
          uColor: { value: new THREE.Color(spec.atmo) },
          uStrength: { value: spec.atmoStrength },
          uPower: { value: spec.kind === 'ice' || spec.kind === 'bands' ? 2.2 : 1.7 },
        },
        vertexShader: PLANET_VERT,
        fragmentShader: ATMO_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      })
    );
    atmo.renderOrder = 3;
    tilt.add(atmo);
  }

  let ring = null;
  if (spec.rings) {
    const inner = radius * spec.rings.inner;
    const outer = radius * spec.rings.outer;
    const geo = new THREE.RingGeometry(inner, outer, 190, 3);
    // remap uv.x to the radial position so a 1D ring texture maps correctly
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      uv.setXY(i, (r - inner) / (outer - inner), uv.getY(i));
    }
    uv.needsUpdate = true;
    const ringTex = bakeRingTexture(spec.rings.tex, 5 + Math.round(radius * 3));
    ring = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: ringTex },
          uSunPos: shared.uSunPos,
          uSunColor: shared.uSunColor,
          uSunIntensity: shared.uSunIntensity,
          uPlanetCenter: { value: new THREE.Vector3() },
          uPlanetRadius: { value: radius },
          uOpacity: { value: spec.rings.opacity ?? 1 },
          uTime: shared.uTime,
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 2;
    tilt.add(ring);
    mat.uniforms.uRingTex.value = ringTex;
    mat.uniforms.uRingSpan.value.set(inner, outer);
  }

  const moons = (spec.moons ?? []).map((m) => {
    const bakedMoon = bakeMoon({ w: 256, h: 128 }, { ...m, seed: m.seed, color: m.color, craters: m.craters ?? 90 });
    const moonMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: bakedMoon.map },
        uNormalMap: { value: bakedMoon.normalMap },
        uRoughMap: { value: bakedMoon.map },
        uNightMap: { value: bakedMoon.map },
        uHasNight: { value: 0 },
        uSunPos: shared.uSunPos,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uTime: shared.uTime,
        uAtmoColor: { value: new THREE.Color(m.atmo ?? m.color) },
        uAtmoStrength: { value: m.atmo ? 0.3 : 0.05 },
        uBump: { value: 1.4 },
        uHighlight: { value: 0 },
        uAmbient: { value: new THREE.Color('#1a2338').multiplyScalar(0.5) },
        uRing: { value: 0 },
        uRingCenter: { value: new THREE.Vector3() },
        uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
        uRingSpan: { value: new THREE.Vector2(0, 1) },
        uRingTex: { value: null },
      },
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
    });
    const pivotM = new THREE.Group();
    const geo = new THREE.IcosahedronGeometry(m.radius, 4);
    if (m.lumpy) {
      const p = geo.attributes.position;
      const rr = rng(m.seed * 91 + 7);
      for (let i = 0; i < p.count; i++) {
        const f = 1 + (rr() - 0.5) * m.lumpy;
        p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
    }
    const moonMesh = new THREE.Mesh(geo, moonMat);
    moonMesh.name = `${spec.id}:${m.id}`;
    moonMesh.userData.body = { id: m.id, name: m.id, parent: spec.id, radius: m.radius };
    pivotM.add(moonMesh);
    tilt.add(pivotM);
    return { ...m, pivot: pivotM, mesh: moonMesh, angle: rng(m.seed * 3 + 1)() * Math.PI * 2 };
  });

  const orbitR = spec.orbitRadius;
  const body = {
    ...spec,
    orbitRadius: orbitR,
    radius,
    pivot,
    tilt,
    mesh,
    clouds,
    atmo,
    ring,
    moons,
    mat,
    baked,
    angle: spec.phase ?? 0,
    rayTargets: [mesh, ...moons.map((m) => m.mesh)],
    worldPos: new THREE.Vector3(),
    screenPos: new THREE.Vector3(),
    highlight: 0,
  };
  mesh.userData.body = body;
  return body;
}

/* ══════════════════════════════════════════════════════════════════════
   ORBIT TRACKS
   ══════════════════════════════════════════════════════════════════════ */
export function makeOrbit(radius, color, q) {
  const count = Math.max(160, q.segs[0] * 3);
  const pts = new Float32Array(count * 3);
  const angles = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts[i * 3] = Math.cos(a) * radius;
    pts[i * 3 + 1] = 0;
    pts[i * 3 + 2] = Math.sin(a) * radius;
    angles[i] = i / count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
  const line = new THREE.LineLoop(
    geo,
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uPhase: { value: 0 },
        uFadeNear: { value: 55 },
        uFadeFar: { value: 1500 },
      },
      vertexShader: ORBIT_VERT,
      fragmentShader: ORBIT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  line.frustumCulled = false;
  return line;
}

/* ══════════════════════════════════════════════════════════════════════
   ASTEROID / KUIPER BELTS
   ══════════════════════════════════════════════════════════════════════ */
export function makeBelt(cfg, q) {
  const count = Math.round(cfg.count * (q.name === 'perf' ? 0.4 : q.name === 'balanced' ? 0.7 : 1));
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cfg.color),
    roughness: 0.95,
    metalness: 0.02,
    flatShading: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const rand = rng(cfg.count);
  const tint = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const rr = cfg.from + rand() * (cfg.to - cfg.from);
    const y = (rand() - 0.5) * (cfg.to - cfg.from) * 0.18;
    const s = cfg.size * (0.25 + Math.pow(rand(), 2.4) * 2.4);
    dummy.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    dummy.rotation.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
    dummy.scale.set(s * (0.7 + rand() * 0.6), s * (0.6 + rand() * 0.8), s * (0.7 + rand() * 0.5));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    tint.setHSL(0.07 + rand() * 0.09, 0.14 + rand() * 0.2, 0.42 + rand() * 0.42);
    mesh.setColorAt(i, tint);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return { mesh, speed: cfg.speed, group: new THREE.Group() };
}

/* ══════════════════════════════════════════════════════════════════════
   STARFIELD (instanced quads → warp streaks)
   ══════════════════════════════════════════════════════════════════════ */
export function makeStars(count, q) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  geo.instanceCount = count;

  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 2);
  const temp = new Float32Array(count);
  const rand = rng(9137);
  const R = 1500;
  for (let i = 0; i < count; i++) {
    // even distribution on a shell, mildly clustered to the galactic band
    let u = rand();
    const v = rand();
    u = u * 0.82 + 0.18 * (1 - Math.abs(2 * v - 1));
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const r = R * (0.68 + rand() * 0.42);
    pos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    pos[i * 3 + 1] = Math.cos(phi) * r * 0.72;
    pos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    const mag = Math.pow(rand(), 3.1);
    seed[i * 2] = 0.45 + mag * 4.4;
    seed[i * 2 + 1] = rand();
    temp[i] = rand() * 0.85 + mag * 0.15;
  }
  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 2));
  geo.setAttribute('aTemp', new THREE.InstancedBufferAttribute(temp, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWarp: { value: 0 },
      uPixelRatio: { value: 1 },
      uSizeScale: { value: 1 },
      uExposure: { value: 1.35 },
    },
    vertexShader: STARS_VERT,
    fragmentShader: STARS_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, mat, group: new THREE.Group() };
}

/* ══════════════════════════════════════════════════════════════════════
   DEEP SKY
   ══════════════════════════════════════════════════════════════════════ */
export function makeSky() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(3200, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uA: { value: new THREE.Color('#050913') },
        uB: { value: new THREE.Color('#2b3f78') },
        uC: { value: new THREE.Color('#6a5a86') },
        uExposure: { value: 1 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    })
  );
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

/* ══════════════════════════════════════════════════════════════════════
   FLAGSHIP CRAFT — a hand-built probe: bus, dish, panels, boom, exhaust
   ══════════════════════════════════════════════════════════════════════ */
export function makeCraft() {
  const root = new THREE.Group();
  const foil = new THREE.MeshStandardMaterial({ color: 0xd9a24f, metalness: 0.92, roughness: 0.34 });
  const shell = new THREE.MeshStandardMaterial({ color: 0xe6ebf2, metalness: 0.35, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1f28, metalness: 0.5, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x16324f,
    metalness: 0.2,
    roughness: 0.12,
    emissive: new THREE.Color('#0a2a44'),
    emissiveIntensity: 0.8,
  });

  // hexagonal bus
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.5, 6, 1), foil);
  root.add(bus);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.07, 6, 1), shell);
  deck.position.y = 0.29;
  root.add(deck);
  const keel = deck.clone();
  keel.position.y = -0.29;
  root.add(keel);

  // high-gain antenna: lathe-turned dish + feed horn
  const prof = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    prof.push(new THREE.Vector2(0.02 + t * 0.62, 0.1 - Math.pow(t, 2.1) * 0.3));
  }
  const dish = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), shell.clone());
  dish.material.side = THREE.DoubleSide;
  dish.position.set(0, 0.62, 0);
  dish.rotation.x = Math.PI;
  root.add(dish);
  const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 8), dark);
  feed.position.set(0, 0.74, 0);
  root.add(feed);
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 10), shell);
  horn.position.set(0, 0.9, 0);
  horn.rotation.x = Math.PI;
  root.add(horn);

  // rtg on a boom
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 8), dark);
  boom.rotation.z = Math.PI / 2;
  boom.position.set(-0.75, -0.1, 0);
  root.add(boom);
  const rtg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.46, 10), dark);
  rtg.position.set(-1.3, -0.1, 0);
  rtg.rotation.z = Math.PI / 2;
  root.add(rtg);
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.3, 0.3), foil);
    fin.position.set(-1.5, -0.1, 0);
    fin.rotation.x = (i / 3) * Math.PI * 2;
    fin.translateY(0.16);
    root.add(fin);
  }

  // magnetometer boom + instrument pod
  const mag = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.9, 6), shell);
  mag.rotation.z = Math.PI / 2;
  mag.position.set(1.15, 0.05, 0.2);
  root.add(mag);
  const pod = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), glass);
  pod.position.set(2.08, 0.05, 0.2);
  root.add(pod);

  // scan platform
  const plat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.3), shell);
  plat.position.set(0.28, -0.4, 0);
  root.add(plat);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 12), dark);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0.28, -0.4, 0.2);
  root.add(lens);

  // engine bell + exhaust glow
  const bell = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 12, 1, true), shell.clone());
  bell.material.side = THREE.DoubleSide;
  bell.rotation.x = Math.PI;
  bell.position.set(0, -0.5, 0);
  root.add(bell);

  const glowTex = bakeGlow(128, 'rgba(255,255,255,0.9)', 'rgba(140,200,255,0.45)');
  const exhaust = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 })
  );
  exhaust.position.set(0, -0.78, 0);
  exhaust.scale.setScalar(0.9);
  root.add(exhaust);

  const beacon = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: 0xff5a4a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
  );
  beacon.position.set(0, 0.66, 0);
  beacon.scale.setScalar(0.55);
  root.add(beacon);

  root.scale.setScalar(1.5);
  root.name = 'craft';
  return { root, exhaust, beacon, dish };
}

/** fading ribbon behind the craft */
export function makeTrail(n = 220, color = '#8fd0ff') {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = 1 - i / (n - 1);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  const line = new THREE.Line(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.85 } },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  line.frustumCulled = false;
  return { line, geo, n };
}

/* ══════════════════════════════════════════════════════════════════════
   HUD RETICLE (screen-space sized, world-anchored)
   ══════════════════════════════════════════════════════════════════════ */
export function makeReticle() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uTime: { value: 0 }, uOpen: { value: 0 } },
      vertexShader: RETICLE_VERT,
      fragmentShader: RETICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
  );
  mesh.renderOrder = 20;
  mesh.visible = false;
  return mesh;
}

/* ══════════════════════════════════════════════════════════════════════
   SELECTION HALO RING used when a world is clicked
   ══════════════════════════════════════════════════════════════════════ */
export function makeSelectionRing(color = '#ffffff') {
  const geo = new THREE.TorusGeometry(1, 0.008, 6, 220);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

export const factoryUtils = { UP };
