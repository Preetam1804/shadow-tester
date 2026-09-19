/**
 * Shader hygiene check over the live scene graph: for every ShaderMaterial we
 * build, verify that (a) every uniform/varying/attribute *used* is declared,
 * (b) varyings match between stages, (c) every declared uniform is actually
 * supplied from JS, and (d) custom attributes exist on the geometry.
 * Catches the class of bug that shows up as a black object + console error.
 */
import { installDomStub } from './dom-stub.mjs';
installDomStub();

const THREE = await import('three');
const { QUALITY } = await import('../src/three/Engine.js');
const { Universe } = await import('../src/three/Universe.js');
const { BODIES } = await import('../src/config/solar.js');

const q = { ...QUALITY.perf, name: 'perf', tex: 128, stars: 60 };
const universe = new Universe(q);
for (const b of BODIES) universe.addBody(b);
universe.finish();

const BUILTIN_UNIFORMS = new Set([
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix', 'cameraPosition', 'isOrthographic',
]);
const BUILTIN_ATTRS = new Set(['position', 'normal', 'uv', 'uv1', 'uv2', 'uv3', 'color', 'tangent', 'skinIndex', 'skinWeight', 'instanceMatrix', 'instanceColor']);

const declRe = (kind) => new RegExp(`^\\s*${kind}\\s+\\w+\\s+(\\w+)\\s*;`, 'gm');

function declared(src, kind) {
  const out = new Set();
  for (const m of src.matchAll(declRe(kind))) out.add(m[1]);
  return out;
}
function used(src, prefix) {
  const out = new Set();
  const re = new RegExp(`\\b(${prefix}[A-Z]\\w*)\\b`, 'g');
  // strip declarations so we only look at real usage
  const body = src.replace(/^\s*(uniform|attribute|varying)\s+\w+\s+\w+\s*;/gm, '');
  for (const m of body.matchAll(re)) out.add(m[1]);
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const problems = [];
const notes = [];
const seen = new Set();
const stats = [];
const objects = [];
universe.root.traverse((o) => objects.push(o));
for (const list of [universe.sun.shells, [universe.sun.mesh, universe.sun.glow, universe.reticle, universe.craft, universe.trail.line, universe.stars.mesh, universe.sky]]) {
  for (const o of list) if (o) objects.push(o);
}

for (const obj of objects) {
  const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
  for (const mat of mats) {
    if (!mat.isShaderMaterial && !mat.isMeshStandardMaterial) continue;
    if (mat.isMeshStandardMaterial) continue; // three-owned shaders, verified upstream
    const key = mat.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const vs = stripComments(mat.vertexShader ?? '');
    const fs = stripComments(mat.fragmentShader ?? '');
    const label = obj.name || obj.type;
    const name = `${label}/${mat.type}${obj.parent?.name ? `@${obj.parent.name}` : ''}`;

    const vDecl = { uniform: declared(vs, 'uniform'), attribute: declared(vs, 'attribute'), varying: declared(vs, 'varying') };
    const fDecl = { uniform: declared(fs, 'uniform'), varying: declared(fs, 'varying') };

    // (a) used-but-undeclared
    for (const [tag, src, decl] of [['vert', vs, vDecl], ['frag', fs, fDecl]]) {
      for (const u of used(src, 'u')) {
        if (!decl.uniform.has(u) && !BUILTIN_UNIFORMS.has(u)) problems.push(`${name}: ${tag} uses undeclared uniform ${u}`);
      }
      for (const v of used(src, 'v')) {
        if (!decl.varying.has(v)) problems.push(`${name}: ${tag} uses undeclared varying ${v}`);
      }
      if (tag === 'vert') {
        for (const a of used(src, 'a')) {
          if (!decl.attribute.has(a) && !BUILTIN_ATTRS.has(a)) problems.push(`${name}: vert uses undeclared attribute ${a}`);
        }
      }
    }
    // (b) varyings produced but never declared in frag, or vice-versa
    for (const v of vDecl.varying) if (!fDecl.varying.has(v)) notes.push(`${name}: varying ${v} written in vert, unused in frag (legal)`);
    for (const v of fDecl.varying) if (!vDecl.varying.has(v)) problems.push(`${name}: varying ${v} read in frag but never declared in vert`);
    // (c) declared uniforms supplied from JS?
    const jsUniforms = new Set(Object.keys(mat.uniforms ?? {}));
    const missing = [];
    for (const u of new Set([...vDecl.uniform, ...fDecl.uniform])) if (!jsUniforms.has(u)) missing.push(u);
    const unused = [...jsUniforms].filter((u) => !vDecl.uniform.has(u) && !fDecl.uniform.has(u));
    if (missing.length) problems.push(`${name}: GLSL declares ${missing.join(', ')} but JS uniforms object has no such key`);
    if (unused.length) problems.push(`${name}: JS sends ${unused.join(', ')} which the shader never declares`);

    // (d) geometry attributes for custom varyings
    const geo = obj.geometry;
    if (geo) {
      for (const a of vDecl.attribute) {
        if (BUILTIN_ATTRS.has(a)) continue;
        if (!geo.hasAttribute(a)) problems.push(`${name}: shader wants attribute ${a}, geometry (${geo.type}) does not provide it`);
      }
    }
    stats.push({ obj: name, uniforms: jsUniforms.size, missing: missing.length, unused: unused.length });
  }
}

// three requires float/array uniforms to be typed correctly — catch undefined/NaN defaults
for (const obj of objects) {
  const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
  for (const mat of mats) {
    for (const [k, u] of Object.entries(mat.uniforms ?? {})) {
      const v = u?.value;
      if (v === undefined) problems.push(`${obj.name || obj.type}: uniform ${k} is undefined`);
      else if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${obj.name || obj.type}: uniform ${k} is NaN`);
    }
  }
}

if (notes.length) {
  console.log('notes:');
  [...new Set(notes)].forEach((n) => console.log('  · ' + n));
}
console.log(`materials checked: ${stats.length}`);
console.table(stats);
if (problems.length) {
  console.log('\nPROBLEMS:');
  [...new Set(problems)].forEach((p) => console.log('  ✗ ' + p));
  process.exitCode = 1;
} else {
  console.log('\n✓ every shader declaration, varying, attribute and uniform lines up');
}
