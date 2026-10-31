/* Rig data model: bones, layer bindings, transforms, undo, serialization.
 * Editor world space = document pixel space (y-down). The Spine y-up flip
 * happens at export time only.
 */
'use strict';

const Rig = (() => {

const DEG = Math.PI / 180;

let bones = [];      // { name, parent, x, y, rotation, scaleX, scaleY, length }
let nextId = 1;

// Animations: values are OFFSETS from the setup pose (Spine semantics), so
// editing the setup pose later never breaks existing keys.
// anims = { name: { duration, bones: { boneName: {
//   rotate:    [{ time, value, curve }],
//   translate: [{ time, x, y, curve }],
//   scale:     [{ time, x, y, curve }],
// }}}}
// curve: 'linear' | 'stepped' | 'ease'
let anims = {};
let pose = null;     // when set, world() poses from here instead of setup

// ---- transforms ----------------------------------------------------------

function localMatrix(b) {
  const r = b.rotation * DEG;
  const cos = Math.cos(r), sin = Math.sin(r);
  return {
    a: cos * b.scaleX, b: -sin * b.scaleY,
    c: sin * b.scaleX, d: cos * b.scaleY,
    x: b.x, y: b.y,
  };
}

function mul(p, l) {
  return {
    a: p.a * l.a + p.b * l.c, b: p.a * l.b + p.b * l.d,
    c: p.c * l.a + p.d * l.c, d: p.c * l.b + p.d * l.d,
    x: p.a * l.x + p.b * l.y + p.x,
    y: p.c * l.x + p.d * l.y + p.y,
  };
}

const IDENT = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

function world(i) {
  if (i < 0 || !bones[i]) return IDENT;
  const src = pose ? pose[i] : bones[i];
  const m = localMatrix(src);
  return bones[i].parent >= 0 ? mul(world(bones[i].parent), m) : m;
}

// current display values for bone i (posed if animating, else setup)
function current(i) { return pose ? pose[i] : bones[i]; }

function invert(m) {
  const det = m.a * m.d - m.b * m.c || 1e-9;
  return {
    a: m.d / det, b: -m.b / det,
    c: -m.c / det, d: m.a / det,
    x: (m.b * m.y - m.d * m.x) / det,
    y: (m.c * m.x - m.a * m.y) / det,
  };
}

function apply(m, x, y) {
  return [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];
}

// Decompose a matrix into x/y/rotation/scale (no shear — editor invariant).
function decompose(m) {
  return {
    x: m.x, y: m.y,
    rotation: Math.atan2(m.c, m.a) / DEG,
    scaleX: Math.hypot(m.a, m.c),
    scaleY: Math.hypot(m.b, m.d) * Math.sign(m.a * m.d - m.b * m.c),
  };
}

// ---- bone ops ------------------------------------------------------------

function init(docW, docH) {
  bones = [{ name: 'root', parent: -1, x: docW / 2, y: docH / 2,
             rotation: 0, scaleX: 1, scaleY: 1, length: 0 }];
  nextId = 1;
  anims = {};
  pose = null;
  return 0;
}

function add(parent, wx, wy, wx2, wy2) {
  // origin/tip given in world space; store local to parent
  const inv = invert(world(parent));
  const [lx, ly] = apply(inv, wx, wy);
  const [tx, ty] = apply(inv, wx2, wy2);
  const dx = tx - lx, dy = ty - ly;
  const b = {
    name: 'bone' + nextId++,
    parent,
    x: lx, y: ly,
    rotation: Math.atan2(dy, dx) / DEG,
    scaleX: 1, scaleY: 1,
    length: Math.hypot(dx, dy),
  };
  bones.push(b);
  return bones.length - 1;
}

// Children (direct) of bone i.
function childrenOf(i) {
  const out = [];
  bones.forEach((b, j) => { if (b.parent === i) out.push(j); });
  return out;
}

function descendantsOf(i) {
  const out = [];
  const walk = j => { for (const c of childrenOf(j)) { out.push(c); walk(c); } };
  walk(i);
  return out;
}

// Set bone i's local fields while keeping every child bone's and bound
// layer's WORLD transform unchanged (used for pivot moves & reparenting).
function editCompensated(i, edit, layers) {
  const savedBoneWorlds = childrenOf(i).map(c => ({ c, m: world(c) }));
  const savedLayers = layers
    .filter(l => l.bone === i)
    .map(l => ({ l, m: mul(world(i), layerLocalMatrix(l)) }));

  edit(bones[i]);

  for (const { c, m } of savedBoneWorlds) {
    const local = decompose(mul(invert(world(i)), m));
    Object.assign(bones[c], { x: local.x, y: local.y, rotation: local.rotation });
    // scale untouched: pivot moves are translation-only compensation
  }
  const invW = invert(world(i));
  for (const { l, m } of savedLayers) {
    const local = decompose(mul(invW, m));
    l.lx = local.x; l.ly = local.y; l.lrot = local.rotation;
    l.lsx = local.scaleX; l.lsy = local.scaleY;
  }
}

function reparent(i, newParent, layers) {
  if (i === 0 || newParent === i) return;
  if (descendantsOf(i).includes(newParent)) return;   // no cycles
  const m = world(i);
  bones[i].parent = newParent;
  const local = decompose(mul(invert(world(newParent)), m));
  Object.assign(bones[i], { x: local.x, y: local.y, rotation: local.rotation,
                            scaleX: local.scaleX, scaleY: local.scaleY });
}

function remove(i, layers) {
  if (i === 0) return;
  const name = bones[i].name;
  const parent = bones[i].parent;
  for (const c of childrenOf(i)) reparent(c, parent, layers);
  for (const l of layers) if (l.bone === i) bind(l, parent);
  bones.splice(i, 1);
  for (const b of bones) if (b.parent > i) b.parent--;
  for (const l of layers) if (l.bone > i) l.bone--;
  for (const anim of Object.values(anims)) delete anim.bones[name];
  // meshes reference bones by index: a mesh skinned to the removed bone is
  // dropped (its bind data is meaningless now), the rest shift down
  for (const l of layers) {
    if (!l.mesh) continue;
    if (l.mesh.spec.chain.includes(i)) { delete l.mesh; continue; }
    l.mesh.spec.chain = l.mesh.spec.chain.map(b => b > i ? b - 1 : b);
    for (const inf of l.mesh.w) for (const e of inf) if (e[0] > i) e[0]--;
  }
}

// ---- layer binding -------------------------------------------------------

function layerLocalMatrix(l) {
  const r = (l.lrot || 0) * DEG;
  const cos = Math.cos(r), sin = Math.sin(r);
  return {
    a: cos * (l.lsx ?? 1), b: -sin * (l.lsy ?? 1),
    c: sin * (l.lsx ?? 1), d: cos * (l.lsy ?? 1),
    x: l.lx || 0, y: l.ly || 0,
  };
}

function layerWorld(l) {
  return mul(world(l.bone ?? 0), layerLocalMatrix(l));
}

// ---- mesh deformation: a layer skinned to a bone chain --------------------
// A meshed layer is a grid of vertices over its image, each vertex weighted
// to one or two bones of a chain (linear blend skinning), so rotating the
// chain BENDS the art instead of hinging it. Vertex data lives on the layer:
//   l.mesh = { spec: { chain: [boneIdx...], segments },
//              verts: [x,y,...]   image-space px, top-left origin
//              tris:  [i,j,k,...]
//              hull:  n           the first n verts are the outline ring
//              w:     [[[bone, lx, ly, weight], ...], ...]  per vertex,
//                     lx/ly = bind position in that bone's local space }

// the chain that starts at bone i: follow single-child links downward
function chainFrom(i) {
  const out = [i];
  for (;;) {
    const kids = childrenOf(out[out.length - 1]);
    if (kids.length !== 1) break;
    out.push(kids[0]);
  }
  return out;
}

const smooth = u => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// Build l.mesh for a chain, in the SETUP pose (callers work in setup mode).
function meshAlongChain(l, chain, segments) {
  const savedPose = pose;
  pose = null;
  try {
    const w = l.canvas.width, h = l.canvas.height;
    const M = layerWorld(l);                       // image center -> world
    const toWorld = (px, py) => apply(M, px - w / 2, py - h / 2);

    // chain polyline in world space: bone origins, then the last bone's tip
    const pts = chain.map(b => apply(world(b), 0, 0));
    const last = bones[chain[chain.length - 1]];
    pts.push(apply(world(chain[chain.length - 1]), last.length || 1, 0));
    const segLen = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]) || 1e-6);
    const T = [0];
    for (const s of segLen) T.push(T[T.length - 1] + s);
    const hw = 0.3 * Math.min(...segLen);          // joint blend half-width

    // grid axis: subdivide along whichever image axis the chain runs down
    const a0 = apply(invert(M), pts[0][0], pts[0][1]);
    const a1 = apply(invert(M), pts[pts.length - 1][0], pts[pts.length - 1][1]);
    const alongX = Math.abs(a1[0] - a0[0]) >= Math.abs(a1[1] - a0[1]);
    const N = Math.max(2, segments | 0), R = 2;
    const cols = alongX ? N : R, rows = alongX ? R : N;

    // vertices, outline ring first (Spine's hull convention)
    const grid = [];                                // [ci][ri] -> vertex index
    const verts = [], order = [];
    const ring = [];
    for (let c = 0; c <= cols; c++) ring.push([c, 0]);
    for (let r = 1; r <= rows; r++) ring.push([cols, r]);
    for (let c = cols - 1; c >= 0; c--) ring.push([c, rows]);
    for (let r = rows - 1; r >= 1; r--) ring.push([0, r]);
    const seen = new Set();
    const push = (c, r) => {
      const key = c * 1000 + r;
      if (seen.has(key)) return;
      seen.add(key);
      (grid[c] = grid[c] || [])[r] = verts.length / 2;
      verts.push(c / cols * w, r / rows * h);
    };
    for (const [c, r] of ring) push(c, r);
    const hull = verts.length / 2;
    for (let c = 1; c < cols; c++) for (let r = 1; r < rows; r++) push(c, r);
    const tris = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const i00 = grid[c][r], i10 = grid[c + 1][r], i01 = grid[c][r + 1], i11 = grid[c + 1][r + 1];
      tris.push(i00, i10, i11, i00, i11, i01);
    }

    // weights: arc-length position along the chain, blended across joints
    const inv = chain.map(b => invert(world(b)));
    const wts = [];
    for (let v = 0; v < verts.length; v += 2) {
      const P = toWorld(verts[v], verts[v + 1]);
      let best = 0, bd = Infinity, t = 0;
      for (let k = 0; k < segLen.length; k++) {
        const ax = pts[k][0], ay = pts[k][1], bx = pts[k + 1][0], by = pts[k + 1][1];
        const dx = bx - ax, dy = by - ay;
        const u = Math.max(0, Math.min(1, ((P[0] - ax) * dx + (P[1] - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
        const qx = ax + dx * u, qy = ay + dy * u;
        const d = Math.hypot(P[0] - qx, P[1] - qy);
        if (d < bd) { bd = d; best = k; t = T[k] + segLen[k] * u; }
      }
      const inf = [[best, 1]];
      if (best > 0 && t < T[best] + hw) {                      // joint below
        const f = smooth((t - (T[best] - hw)) / (2 * hw));
        inf[0][1] = f; inf.push([best - 1, 1 - f]);
      } else if (best < segLen.length - 1 && t > T[best + 1] - hw) {   // joint above
        const f = smooth((t - (T[best + 1] - hw)) / (2 * hw));
        inf[0][1] = 1 - f; inf.push([best + 1, f]);
      }
      wts.push(inf.filter(([, wgt]) => wgt > 1e-4).map(([k, wgt]) => {
        const [lx, ly] = apply(inv[k], P[0], P[1]);
        return [chain[k], +lx.toFixed(3), +ly.toFixed(3), +wgt.toFixed(4)];
      }));
    }
    l.mesh = { spec: { chain: [...chain], segments: N }, verts, tris, hull, w: wts };
  } finally {
    pose = savedPose;
  }
  return l.mesh;
}

// posed world positions of a meshed layer's vertices (Float32Array x,y,...)
function meshWorldVerts(l) {
  const m = l.mesh;
  const out = new Float32Array(m.verts.length);
  const cache = new Map();
  const W = b => { let w = cache.get(b); if (!w) { w = world(b); cache.set(b, w); } return w; };
  for (let i = 0; i < m.w.length; i++) {
    let x = 0, y = 0;
    for (const [b, lx, ly, wgt] of m.w[i]) {
      const w = W(b);
      x += (w.a * lx + w.b * ly + w.x) * wgt;
      y += (w.c * lx + w.d * ly + w.y) * wgt;
    }
    out[i * 2] = x; out[i * 2 + 1] = y;
  }
  return out;
}

// Bind layer to bone, preserving its current world transform.
function bind(l, boneIdx) {
  const m = layerWorld(l);
  l.bone = boneIdx;
  const local = decompose(mul(invert(world(boneIdx)), m));
  l.lx = local.x; l.ly = local.y; l.lrot = local.rotation;
  l.lsx = local.scaleX; l.lsy = local.scaleY;
}

// Initial binding for a freshly imported layer: to root, at its doc position.
function bindInitial(l, docLayer) {
  l.bone = 0;
  const cx = docLayer.x + docLayer.canvas.width / 2;
  const cy = docLayer.y + docLayer.canvas.height / 2;
  const local = decompose(mul(invert(world(0)), { ...IDENT, x: cx, y: cy }));
  l.lx = local.x; l.ly = local.y; l.lrot = 0; l.lsx = 1; l.lsy = 1;
}

// ---- animation -----------------------------------------------------------

function curveU(u, curve) {
  if (curve === 'stepped') return 0;
  if (curve === 'ease') return u * u * (3 - 2 * u);   // smoothstep in/out
  return u;
}

// Interpolate an array of keys at time t; fields = ['value'] or ['x','y'].
function sampleChannel(keys, t, fields, defaults) {
  if (!keys || !keys.length) return defaults;
  if (t <= keys[0].time) return fields.map(f => keys[0][f] ?? 0);
  let i = keys.length - 1;
  for (let j = 1; j < keys.length; j++) {
    if (keys[j].time > t) { i = j - 1; break; }
  }
  const a = keys[i], b = keys[i + 1];
  if (!b) return fields.map(f => a[f] ?? 0);
  const u = curveU((t - a.time) / (b.time - a.time || 1e-9), a.curve);
  return fields.map(f => (a[f] ?? 0) + ((b[f] ?? 0) - (a[f] ?? 0)) * u);
}

function computePose(animName, t) {
  const anim = anims[animName];
  pose = bones.map(b => ({ x: b.x, y: b.y, rotation: b.rotation,
                           scaleX: b.scaleX, scaleY: b.scaleY }));
  if (!anim) return;
  for (const [name, ch] of Object.entries(anim.bones)) {
    const i = bones.findIndex(b => b.name === name);
    if (i < 0) continue;
    const p = pose[i], s = bones[i];
    const [dr] = sampleChannel(ch.rotate, t, ['value'], [0]);
    const [dx, dy] = sampleChannel(ch.translate, t, ['x', 'y'], [0, 0]);
    const [sx, sy] = sampleChannel(ch.scale, t, ['x', 'y'], [1, 1]);
    p.rotation = s.rotation + dr;
    p.x = s.x + dx;
    p.y = s.y + dy;
    p.scaleX = s.scaleX * sx;
    p.scaleY = s.scaleY * sy;
  }
}

function clearPose() { pose = null; }

function ensureAnim(name) {
  if (!anims[name]) anims[name] = { duration: 2, bones: {}, events: [] };
  return anims[name];
}

// ---- timeline event markers (named frames the game syncs gameplay to) ----

function events(animName) {
  const a = anims[animName];
  if (!a) return [];
  return a.events = a.events || [];
}

function addEvent(animName, time, name) {
  const evs = events(animName);
  const ev = { time, name };
  evs.push(ev);
  evs.sort((a, b) => a.time - b.time);
  if (time > anims[animName].duration) anims[animName].duration = time;
  return evs.indexOf(ev);
}

function moveEvent(animName, i, time) {
  const evs = events(animName);
  const ev = evs[i];
  if (!ev) return i;
  ev.time = time;
  evs.sort((a, b) => a.time - b.time);
  if (time > anims[animName].duration) anims[animName].duration = time;
  return evs.indexOf(ev);
}

function renameEvent(animName, i, name) {
  const ev = events(animName)[i];
  if (ev) ev.name = name;
}

function deleteEvent(animName, i) {
  events(animName).splice(i, 1);
}

function keyAt(animName, boneName, channel, time, values, curve) {
  const anim = ensureAnim(animName);
  const ch = anim.bones[boneName] = anim.bones[boneName] || {};
  const keys = ch[channel] = ch[channel] || [];
  let k = keys.find(k => Math.abs(k.time - time) < 1e-6);
  if (!k) {
    k = { time, curve: curve || 'ease' };
    keys.push(k);
    keys.sort((a, b) => a.time - b.time);
  }
  Object.assign(k, values);
  if (time > anim.duration) anim.duration = time;
  return k;
}

// unique key times for a bone across channels (dopesheet diamonds)
function keyTimes(animName, boneName) {
  const ch = anims[animName]?.bones[boneName];
  if (!ch) return [];
  const times = new Set();
  for (const keys of Object.values(ch)) for (const k of keys || []) times.add(+k.time.toFixed(6));
  return [...times].sort((a, b) => a - b);
}

// single-channel key operations (per-channel dopesheet rows)

function channelKeys(animName, boneName, channel) {
  return anims[animName]?.bones[boneName]?.[channel] || [];
}

function moveChannelKey(animName, boneName, channel, from, to) {
  const keys = anims[animName]?.bones[boneName]?.[channel];
  if (!keys) return;
  const k = keys.find(k => Math.abs(k.time - from) < 1e-6);
  if (!k) return;
  if (keys.some(x => x !== k && Math.abs(x.time - to) < 1e-6)) return;
  k.time = to;
  keys.sort((a, b) => a.time - b.time);
  if (to > anims[animName].duration) anims[animName].duration = to;
}

function deleteChannelKey(animName, boneName, channel, time) {
  const ch = anims[animName]?.bones[boneName];
  if (!ch?.[channel]) return;
  const i = ch[channel].findIndex(k => Math.abs(k.time - time) < 1e-6);
  if (i >= 0) ch[channel].splice(i, 1);
  if (!ch[channel].length) delete ch[channel];
}

function setChannelCurve(animName, boneName, channel, time, curve) {
  const k = anims[animName]?.bones[boneName]?.[channel]
    ?.find(k => Math.abs(k.time - time) < 1e-6);
  if (k) k.curve = curve;
}

function moveKeys(animName, boneName, from, to) {
  const ch = anims[animName]?.bones[boneName];
  if (!ch) return;
  for (const keys of Object.values(ch)) {
    if (!keys) continue;
    const idx = keys.findIndex(k => Math.abs(k.time - from) < 1e-6);
    if (idx < 0) continue;
    const clash = keys.findIndex(k => Math.abs(k.time - to) < 1e-6);
    if (clash >= 0 && clash !== idx) keys.splice(clash, 1);
    keys.find(k => Math.abs(k.time - from) < 1e-6).time = to;
    keys.sort((a, b) => a.time - b.time);
  }
  const anim = anims[animName];
  if (to > anim.duration) anim.duration = to;
}

// Bulk-move a mixed selection of keys by dt seconds. Selection entries:
//   {kind:'bone', bone, time}            — every channel key at that time
//   {kind:'chan', bone, channel, time}
//   {kind:'show', src, time} · {kind:'tint', src, time}
//   {kind:'event', time, name}
// All-or-nothing: returns false without mutating if the delta would push any
// key below 0 or onto a non-moving key in the same channel. onBeforeApply
// fires after validation passes and before mutation (undo snapshot hook).
function nudgeKeys(animName, sel, dt, onBeforeApply) {
  const a = anims[animName];
  if (!a || !sel.length || !dt) return false;
  const eps = 1e-6;
  const moves = [];
  const grab = (keys, time) => {
    const k = keys?.find(k => Math.abs(k.time - time) < eps);
    if (k) moves.push({ arr: keys, k });
  };
  for (const s of sel) {
    if (s.kind === 'bone')
      for (const keys of Object.values(a.bones[s.bone] || {})) grab(keys, s.time);
    else if (s.kind === 'chan') grab(a.bones[s.bone]?.[s.channel], s.time);
    else if (s.kind === 'show') grab(a.shows?.[s.src], s.time);
    else if (s.kind === 'tint') grab(a.tints?.[s.src], s.time);
    else if (s.kind === 'event') {
      const k = (a.events || []).find(e => Math.abs(e.time - s.time) < eps && e.name === s.name);
      if (k) moves.push({ arr: a.events, k });
    }
  }
  // a 'bone' entry and a 'chan' entry can resolve to the same key — move once
  const moving = new Set();
  const uniq = moves.filter(m => !moving.has(m.k) && moving.add(m.k));
  if (!uniq.length) return false;
  for (const { arr, k } of uniq) {
    const nt = k.time + dt;
    if (nt < -eps) return false;
    if (arr.some(o => !moving.has(o) && Math.abs(o.time - nt) < eps)) return false;
  }
  onBeforeApply?.();
  for (const { k } of uniq) {
    k.time = Math.max(0, k.time + dt);
    if (k.time > a.duration) a.duration = k.time;
  }
  const sorted = new Set();
  for (const { arr } of uniq)
    if (!sorted.has(arr) && sorted.add(arr)) arr.sort((x, y) => x.time - y.time);
  return true;
}

function deleteKeys(animName, boneName, time) {
  const ch = anims[animName]?.bones[boneName];
  if (!ch) return;
  for (const [name, keys] of Object.entries(ch)) {
    if (!keys) continue;
    const idx = keys.findIndex(k => Math.abs(k.time - time) < 1e-6);
    if (idx >= 0) keys.splice(idx, 1);
    if (!keys.length) delete ch[name];
  }
}

function setKeyCurve(animName, boneName, time, curve) {
  const ch = anims[animName]?.bones[boneName];
  if (!ch) return;
  for (const keys of Object.values(ch)) {
    const k = keys?.find(k => Math.abs(k.time - time) < 1e-6);
    if (k) k.curve = curve;
  }
}

// ---- visibility (show/hide) keys, per layer per animation ---------------
// Keyed by layer.src (stable identity). Stepped by nature. Before the first
// key, the setup-pose visibility applies.

function showKeys(animName, src) {
  return anims[animName]?.shows?.[src] || [];
}

function keyShow(animName, src, time, on) {
  const a = ensureAnim(animName);
  a.shows = a.shows || {};
  const keys = a.shows[src] = a.shows[src] || [];
  let k = keys.find(k => Math.abs(k.time - time) < 1e-6);
  if (!k) {
    k = { time };
    keys.push(k);
    keys.sort((x, y) => x.time - y.time);
  }
  k.on = on;
  if (time > a.duration) a.duration = time;
}

function moveShowKey(animName, src, from, to) {
  const keys = anims[animName]?.shows?.[src];
  if (!keys) return;
  const k = keys.find(k => Math.abs(k.time - from) < 1e-6);
  if (!k) return;
  const clash = keys.findIndex(x => Math.abs(x.time - to) < 1e-6 && x !== k);
  if (clash >= 0) return;   // never clobber a neighbour
  k.time = to;
  keys.sort((x, y) => x.time - y.time);
  if (to > anims[animName].duration) anims[animName].duration = to;
}

function deleteShowKey(animName, src, time) {
  const shows = anims[animName]?.shows;
  if (!shows?.[src]) return;
  const i = shows[src].findIndex(k => Math.abs(k.time - time) < 1e-6);
  if (i >= 0) shows[src].splice(i, 1);
  if (!shows[src].length) delete shows[src];
}

// ---- tint (RGBA color) keys, per layer per animation ---------------------
// color = [r,g,b,a] 0..1. Interpolates componentwise with the key's curve.

function tintKeys(animName, src) {
  return anims[animName]?.tints?.[src] || [];
}

function keyTint(animName, src, time, color) {
  const a = ensureAnim(animName);
  a.tints = a.tints || {};
  const keys = a.tints[src] = a.tints[src] || [];
  let k = keys.find(k => Math.abs(k.time - time) < 1e-6);
  if (!k) {
    k = { time, curve: 'ease' };
    keys.push(k);
    keys.sort((x, y) => x.time - y.time);
  }
  k.c = color.slice();
  if (time > a.duration) a.duration = time;
}

function moveTintKey(animName, src, from, to) {
  const keys = anims[animName]?.tints?.[src];
  if (!keys) return;
  const k = keys.find(k => Math.abs(k.time - from) < 1e-6);
  if (!k) return;
  if (keys.some(x => Math.abs(x.time - to) < 1e-6 && x !== k)) return;
  k.time = to;
  keys.sort((x, y) => x.time - y.time);
  if (to > anims[animName].duration) anims[animName].duration = to;
}

function deleteTintKey(animName, src, time) {
  const tints = anims[animName]?.tints;
  if (!tints?.[src]) return;
  const i = tints[src].findIndex(k => Math.abs(k.time - time) < 1e-6);
  if (i >= 0) tints[src].splice(i, 1);
  if (!tints[src].length) delete tints[src];
}

function setTintCurve(animName, src, time, curve) {
  const k = anims[animName]?.tints?.[src]?.find(k => Math.abs(k.time - time) < 1e-6);
  if (k) k.curve = curve;
}

function tintAt(animName, src, time, setupTint) {
  const keys = tintKeys(animName, src);
  const base = setupTint || [1, 1, 1, 1];
  if (!keys.length) return base;
  if (time <= keys[0].time) return keys[0].c;
  let i = keys.length - 1;
  for (let j = 1; j < keys.length; j++) {
    if (keys[j].time > time) { i = j - 1; break; }
  }
  const a = keys[i], b = keys[i + 1];
  if (!b || a.curve === 'stepped') return a.c;
  const u = curveU((time - a.time) / (b.time - a.time || 1e-9), a.curve);
  return a.c.map((v, ci) => v + (b.c[ci] - v) * u);
}

function hasTintKeys(src) {
  return Object.values(anims).some(a => a.tints?.[src]?.length);
}

// evaluated visibility for a layer at a time (setup until the first key)
function showAt(animName, src, time, setupVisible) {
  let v = setupVisible;
  for (const k of showKeys(animName, src)) {
    if (k.time <= time + 1e-9) v = k.on;
    else break;
  }
  return v;
}

// does any animation key this layer's visibility? (drives export inclusion)
function hasShowKeys(src) {
  return Object.values(anims).some(a => a.shows?.[src]?.length);
}

function renameAnim(oldName, newName) {
  if (!anims[oldName] || anims[newName]) return false;
  const out = {};
  for (const [k, v] of Object.entries(anims)) out[k === oldName ? newName : k] = v;
  anims = out;
  return true;
}

function deleteAnim(name) {
  delete anims[name];
}

function renameBone(i, newName) {
  const old = bones[i].name;
  bones[i].name = newName;
  for (const anim of Object.values(anims)) {
    if (anim.bones[old]) {
      anim.bones[newName] = anim.bones[old];
      delete anim.bones[old];
    }
  }
}

// ---- undo / serialization ------------------------------------------------

const undoStack = [], redoStack = [];

function snapshot(layers) {
  return JSON.stringify({
    bones,
    anims,
    bindings: layers.map(l => ({ src: l.src, bone: l.bone, lx: l.lx, ly: l.ly,
                                 lrot: l.lrot, lsx: l.lsx, lsy: l.lsy,
                                 tint: l.tint || null, mesh: l.mesh || null })),
    nextId,
  });
}

function pushUndo(layers) {
  undoStack.push(snapshot(layers));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

function restore(s, layers) {
  const d = JSON.parse(s);
  bones = d.bones;
  anims = d.anims || {};
  nextId = d.nextId;
  // bindings carry layer identity (src); restore draw order to match, and
  // assign BY SRC — a positional assign smears bindings across the wrong
  // layers whenever the counts differ (e.g. a layer added in Photoshop that
  // the saved project doesn't know yet)
  if (d.bindings.length && d.bindings[0].src !== undefined) {
    const bySrc = new Map(layers.map(l => [l.src, l]));
    const ordered = d.bindings.map(b => bySrc.get(b.src)).filter(Boolean);
    if (ordered.length === layers.length) layers.splice(0, layers.length, ...ordered);
    for (const b of d.bindings) { const l = bySrc.get(b.src); if (l) Object.assign(l, b); }
  } else {
    d.bindings.forEach((b, i) => layers[i] && Object.assign(layers[i], b));
  }
}

function clearUndo() {
  undoStack.length = 0;
  redoStack.length = 0;
}

function undo(layers) {
  if (!undoStack.length) return false;
  redoStack.push(snapshot(layers));
  restore(undoStack.pop(), layers);
  return true;
}

function redo(layers) {
  if (!redoStack.length) return false;
  undoStack.push(snapshot(layers));
  restore(redoStack.pop(), layers);
  return true;
}

return {
  init, add, remove, reparent, world, invert, apply, mul, decompose,
  childrenOf, descendantsOf, editCompensated,
  layerWorld, layerLocalMatrix, bind, bindInitial,
  chainFrom, meshAlongChain, meshWorldVerts,
  pushUndo, undo, redo, clearUndo, snapshot, restore,
  computePose, clearPose, current, ensureAnim, keyAt, keyTimes,
  moveKeys, nudgeKeys, deleteKeys, setKeyCurve, renameBone,
  channelKeys, moveChannelKey, deleteChannelKey, setChannelCurve,
  events, addEvent, moveEvent, renameEvent, deleteEvent,
  renameAnim, deleteAnim,
  showKeys, keyShow, moveShowKey, deleteShowKey, showAt, hasShowKeys,
  tintKeys, keyTint, moveTintKey, deleteTintKey, setTintCurve, tintAt, hasTintKeys,
  get bones() { return bones; },
  get anims() { return anims; },
  get posed() { return pose !== null; },
};
})();
