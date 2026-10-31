/* NomadOS Rig Animator — stage 2: PSB import + bones, pivots, parenting, binding.
 * Layers render through their bound bone's transform; bones draw as an
 * overlay. Tools: V select/pose, B create bone, P move pivot.
 */
'use strict';

const $ = id => document.getElementById(id);

const doc = {
  name: null, width: 0, height: 0,
  layers: [],   // { name, canvas, x, y, visible, bone, lx, ly, lrot, lsx, lsy }
  selected: -1,         // selected layer
  selectedBone: -1,
};

const view = { zoom: 1, panX: 0, panY: 0 };
let tool = 'select';    // select | bone | pivot
let lastPsb = null;     // { buffer, name } for project saving
let drag = null;
const project = { name: null, mtime: 0, dirty: false };   // current project

// ---- unsaved-changes tracking -------------------------------------------
// Nearly every mutation goes through Rig.pushUndo, so hooking it catches
// edits wholesale; the few push-less mutations call markDirty directly.
function markDirty() {
  if (!project.dirty) {
    project.dirty = true;
    updateDirtyUI();
  }
}

function markClean() {
  project.dirty = false;
  updateDirtyUI();
}

function updateDirtyUI() {
  const b = $('projsave');
  b.textContent = project.dirty ? 'Save •' : 'Save';
  b.classList.toggle('dirty', project.dirty);
}

window.addEventListener('beforeunload', e => {
  if (project.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// animation state
const FPS = 30;
let PX_PER_SEC = Math.max(40, Math.min(800, +localStorage.getItem('tlZoom') || 200));
const TL_LABEL_W = 140;   // sticky label column inside the timeline scroller
const anim = {
  mode: 'setup',        // 'setup' | 'animate'
  name: null,
  time: 0,
  playing: false,
  selectedKey: null,    // { bone: name, time }
  selectedEvent: null,  // index into current anim's events
  multiSel: [],         // box/shift multi-selection: see Rig.nudgeKeys entries
  raf: 0, lastTick: 0,
};
let tintAllLayers = false;   // tint/alpha edits apply to every layer at once
const snapT = t => Math.max(0, Math.round(t * FPS) / FPS);

// every keyed time in the current animation — magnet targets for the
// playhead and for key drags, so exact landings don't depend on the
// 30fps scrub grid (keys can live at any time)
function animKeyTimes() {
  const out = new Set();
  if (!anim.name || !Rig.anims[anim.name]) return out;
  for (const b of Rig.bones) for (const t of Rig.keyTimes(anim.name, b.name)) out.add(t);
  for (const ev of Rig.events(anim.name)) out.add(ev.time);
  for (const l of doc.layers) {
    for (const k of Rig.showKeys(anim.name, l.src)) out.add(k.time);
    for (const k of Rig.tintKeys(anim.name, l.src)) out.add(k.time);
  }
  return out;
}

// magnet to the nearest key within 6px (zoom-aware), else the frame grid;
// `exclude` keeps a dragged key from sticking to its own current time
function magnetT(t, exclude) {
  t = Math.max(0, t);
  let best = null, bd = 6 / PX_PER_SEC;
  for (const kt of animKeyTimes()) {
    if (exclude !== undefined && Math.abs(kt - exclude) < 1e-6) continue;
    const d = Math.abs(kt - t);
    if (d < bd) { bd = d; best = kt; }
  }
  return best === null ? snapT(t) : best;
}

// ---- multi-selection (box-select / shift-click) ---------------------------

const selId = s => `${s.kind}|${s.bone ?? s.src ?? ''}|${s.channel ?? s.name ?? ''}|${(+s.time).toFixed(6)}`;
const inMultiSel = s => anim.multiSel.some(o => selId(o) === selId(s));

function toggleMultiSel(s, el) {
  const id = selId(s);
  const i = anim.multiSel.findIndex(o => selId(o) === id);
  if (i >= 0) { anim.multiSel.splice(i, 1); el.classList.remove('msel'); }
  else { anim.multiSel.push(s); el.classList.add('msel'); }
}

function clearMultiSel() {
  if (!anim.multiSel.length) return;
  anim.multiSel = [];
  for (const el of document.querySelectorAll('#tl-tracks .msel')) el.classList.remove('msel');
}

// descriptor for a rendered timeline element, read back from its datasets
function descOfEl(el) {
  const t = +el.dataset.time;
  if (el.classList.contains('evt')) return { kind: 'event', time: t, name: el.dataset.name };
  if (el.classList.contains('vkey')) return { kind: 'show', src: +el.dataset.src, time: t };
  if (el.classList.contains('tkey')) return { kind: 'tint', src: +el.dataset.src, time: t };
  if (el.classList.contains('subkey')) return { kind: 'chan', bone: el.dataset.bone, channel: el.dataset.channel, time: t };
  return { kind: 'bone', bone: el.dataset.bone, time: t };
}
const curAnim = () => Rig.anims[anim.name];
const expandedBones = new Set();   // bones unfolded to channel rows
const CHANNELS = [
  ['rotate', '↻ rotate'],
  ['translate', '↔ move'],
  ['scale', '⤢ scale'],
];

// ------------------------------------------------------------- import

function flattenLayers(children, prefix, out) {
  for (const l of children || []) {
    const name = (prefix ? prefix + '/' : '') + (l.name || 'layer');
    if (l.children) {
      flattenLayers(l.children, name, out);
    } else if (l.canvas) {
      const entry = { name, canvas: l.canvas, x: l.left || 0, y: l.top || 0, visible: !l.hidden };
      // Photoshop layer opacity -> setup alpha
      let op = l.opacity ?? 1;
      if (op > 1) op /= 255;
      if (op < 0.995) entry.tint = [1, 1, 1, op];
      out.push(entry);
    }
  }
  // src = stable identity (position in the PSB), survives reordering
  out.forEach((l, i) => { if (l.src === undefined) l.src = i; });
  return out;
}

function loadPsd(buffer, name, keepRig) {
  const psd = agPsd.readPsd(buffer, { skipThumbnail: true, skipCompositeImageData: true });
  lastPsb = { buffer, name };
  doc.name = name;
  doc.width = psd.width;
  doc.height = psd.height;
  doc.layers = flattenLayers(psd.children, '', []);
  doc.selected = -1;
  doc.selectedBone = -1;
  if (!keepRig) {
    Rig.init(doc.width, doc.height);
    for (const l of doc.layers) Rig.bindInitial(l, l);
    anim.name = null;
    anim.mode = 'setup';
    anim.time = 0;
    anim.multiSel = [];
    play(false);   // through play() so the ▶/❚❚ button stays truthful
  }
  fitView();
  refresh();
  $('empty').style.display = 'none';
  status(`${name} — ${doc.width}×${doc.height}, ${doc.layers.length} layers`);
}

function status(t) { $('status').textContent = t; }

// ---- crumble: shatter a layer into piece-layers in-app --------------------
// Pieces are DERIVED data: not in the PSB, but regenerated deterministically
// from (source layer, seed, count) on every load/refresh, so the PSB stays
// the source of truth and repainted art re-shatters automatically.

function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Voronoi-shard a canvas into n pieces; returns [{canvas, cx, cy}] where
// cx/cy is the piece center in source-bitmap coordinates.
function slicePieces(srcCanvas, n, seed) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const rand = mulberry32(seed);
  const pts = Array.from({ length: n }, () => [rand() * w, rand() * h]);
  const img = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const boxes = pts.map(() => ({ x0: w, y0: h, x1: -1, y1: -1 }));
  const owner = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (img.data[i * 4 + 3] === 0) { owner[i] = 255; continue; }
      let best = 0, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const dx = x - pts[k][0], dy = y - pts[k][1];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = k; }
      }
      owner[i] = best;
      const b = boxes[best];
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
    }
  }
  return boxes.map((b, k) => {
    if (b.x1 < 0) return null;   // empty cell
    const pw = b.x1 - b.x0 + 1, ph = b.y1 - b.y0 + 1;
    const c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    const out = c.getContext('2d').createImageData(pw, ph);
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (owner[y * w + x] !== k) continue;
        const s = (y * w + x) * 4, d = ((y - b.y0) * pw + (x - b.x0)) * 4;
        out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1];
        out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
      }
    }
    c.getContext('2d').putImageData(out, 0, 0);
    return { canvas: c, cx: b.x0 + pw / 2, cy: b.y0 + ph / 2 };
  }).filter(Boolean);
}

const pieceSrc = (sourceSrc, i) => 50000 + sourceSrc * 64 + i;

// Interactive generation: pieces + a bone per piece, hidden in setup.
function crumbleLayer(l, n) {
  if (l.gen) return status('that layer is already a piece');
  const seed = Math.floor(Math.random() * 1e9);
  Rig.clearPose();
  const m = Rig.layerWorld(l);
  const d = Rig.decompose(m);
  const shards = slicePieces(l.canvas, n, seed);
  shards.forEach((s, i) => {
    const [wx, wy] = Rig.apply(m, s.cx - l.canvas.width / 2, s.cy - l.canvas.height / 2);
    const bi = Rig.add(0, wx, wy, wx + 14, wy);
    Rig.renameBone(bi, `${l.name} p${i + 1}`);
    doc.layers.push({
      name: `${l.name} ⌗${i + 1}`, src: pieceSrc(l.src, i), canvas: s.canvas,
      x: 0, y: 0, visible: false, bone: bi,
      lx: 0, ly: 0, lrot: d.rotation, lsx: d.scaleX, lsy: d.scaleY,
      gen: { source: l.name, seed, n, i },
    });
  });
  Rig.clearUndo();   // layer-count changes aren't undo-safe
  markDirty();
  refresh();
  status(`${l.name} → ${shards.length} pieces (hidden; bones ${l.name} p1…) — undo history cleared`);
}

// Regeneration on load/refresh: canvases only; bindings/bones come from the
// saved project. Cache slices per (source, seed, n).
function regeneratePieces(savedLayers) {
  const cache = new Map();
  for (const pl of savedLayers) {
    if (!pl.gen) continue;
    const srcL = doc.layers.find(x => x.name === pl.gen.source && !x.gen);
    if (!srcL) continue;
    const key = `${pl.gen.source}|${pl.gen.seed}|${pl.gen.n}`;
    if (!cache.has(key)) cache.set(key, slicePieces(srcL.canvas, pl.gen.n, pl.gen.seed));
    const s = cache.get(key)[pl.gen.i];
    if (!s) continue;
    doc.layers.push({ name: pl.name, src: pl.src, canvas: s.canvas,
                      x: 0, y: 0, visible: pl.visible, gen: pl.gen });
  }
}

// ---- refresh from an edited PSB: merge, keep the rig ----------------------
// Layers match by name (nth duplicate matches nth duplicate). Photoshop wins
// on pixels, position, order, and visibility; the editor keeps bones,
// bindings, and animations.

function refreshPsb(buffer, fileName) {
  const psd = agPsd.readPsd(buffer, { skipThumbnail: true, skipCompositeImageData: true });
  const fresh = flattenLayers(psd.children, '', []);

  const key = (name, seen) => {
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return name + '␟' + n;
  };
  const seenOld = new Map(), oldByKey = new Map();
  for (const l of doc.layers) oldByKey.set(key(l.name, seenOld), l);

  Rig.clearPose();   // compute rebinds against the setup pose
  // crumble pieces aren't in the PSB; set them aside and re-slice after
  const pieceSpecs = doc.layers.filter(l => l.gen)
    .map(l => ({ name: l.name, src: l.src, visible: l.visible, gen: l.gen,
                 bone: l.bone, lx: l.lx, ly: l.ly, lrot: l.lrot, lsx: l.lsx, lsy: l.lsy, tint: l.tint }));
  doc.layers = doc.layers.filter(l => !l.gen);
  const seenNew = new Map();
  let updated = 0, added = 0;
  doc.layers = fresh.map(f => {
    const k = key(f.name, seenNew);
    const old = oldByKey.get(k);
    if (old) {
      updated++;
      oldByKey.delete(k);
      // keep old.src — it is the layer's IDENTITY (anims reference it);
      // adopting the fresh positional index scrambles show/tint keys when
      // layers are added/removed in Photoshop
      const l = { ...old, canvas: f.canvas, x: f.x, y: f.y,
                  visible: f.visible };
      // Photoshop wins on opacity too; editor-chosen RGB tint is kept
      const op = f.tint ? f.tint[3] : 1;
      if (op < 0.995 || old.tint) {
        l.tint = [...(old.tint || [1, 1, 1, 1]).slice(0, 3), op];
      }
      // re-anchor to the (possibly moved/resized) art, relative to its bone
      const cx = f.x + f.canvas.width / 2, cy = f.y + f.canvas.height / 2;
      const local = Rig.decompose(Rig.mul(Rig.invert(Rig.world(l.bone)),
                                          { a: 1, b: 0, c: 0, d: 1, x: cx, y: cy }));
      l.lx = local.x; l.ly = local.y; l.lrot = local.rotation;
      l.lsx = local.scaleX; l.lsy = local.scaleY;
      return l;
    }
    added++;
    const l = { ...f };
    l.src = undefined;   // real identity assigned below, never the positional one
    Rig.bindInitial(l, l);
    return l;
  });
  // added layers get fresh non-colliding srcs. Kept layers OWN their srcs
  // unconditionally — the old collision pass renumbered whichever owner came
  // later in the stack, so a layer added at the bottom (a Shadow) could steal
  // a kept layer's identity and drag its show/tint keys along.
  {
    const used = doc.layers.filter(x => x.src !== undefined).map(x => x.src);
    let next = Math.max(0, ...used.filter(s => s < 50000)) + 1;
    for (const l of doc.layers) if (l.src === undefined) l.src = next++;
  }
  // meshes are tied to the art's pixel grid: re-skin from their spec so a
  // repainted or resized layer bends the same way over the new pixels
  for (const l of doc.layers)
    if (l.mesh?.spec && l.mesh.spec.chain.every(b => Rig.bones[b]))
      Rig.meshAlongChain(l, l.mesh.spec.chain, l.mesh.spec.segments);

  const removed = [...oldByKey.values()].map(l => l.name);

  // re-shatter pieces from the (possibly repainted) source art, keeping
  // their bindings and animation keys
  regeneratePieces(pieceSpecs);
  for (const spec of pieceSpecs) {
    const p = doc.layers.find(l => l.src === spec.src && l.gen);
    if (p) Object.assign(p, { bone: spec.bone, lx: spec.lx, ly: spec.ly,
                              lrot: spec.lrot, lsx: spec.lsx, lsy: spec.lsy, tint: spec.tint });
  }

  doc.width = psd.width;
  doc.height = psd.height;
  doc.selected = -1;
  lastPsb = { buffer, name: lastPsb ? lastPsb.name : fileName };
  Rig.clearUndo();   // snapshots reference pre-refresh pixels; drop them
  markDirty();
  updatePose();
  refresh();
  status(`refreshed from ${fileName}: ${updated} updated, ${added} added` +
         (removed.length ? `, removed ${removed.join(', ')}` : '') +
         ' (undo history cleared)');
}

// ------------------------------------------------------------- panels

function refresh() {
  renderLayerList();
  renderBoneList();
  renderProps();
  renderTimeline();
  render();
}

function updatePose() {
  if (anim.mode === 'animate' && anim.name) Rig.computePose(anim.name, anim.time);
  else Rig.clearPose();
}

// visibility as the current animation sees it at the playhead
function layerVisibleNow(l) {
  if (anim.mode !== 'animate' || !anim.name) return l.visible;
  return Rig.showAt(anim.name, l.src, anim.time, l.visible);
}

function layerTintNow(l) {
  const setup = l.tint || [1, 1, 1, 1];
  if (anim.mode !== 'animate' || !anim.name) return setup;
  return Rig.tintAt(anim.name, l.src, anim.time, setup);
}

// RGB-multiplied copy of the layer bitmap, cached per quantized color
function tintedCanvas(l, r, g, b) {
  if (r > 0.99 && g > 0.99 && b > 0.99) return l.canvas;
  const key = `${(r * 31) | 0},${(g * 31) | 0},${(b * 31) | 0}`;
  l._tints = l._tints || new Map();
  let c = l._tints.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = l.canvas.width;
    c.height = l.canvas.height;
    const x = c.getContext('2d');
    x.drawImage(l.canvas, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(l.canvas, 0, 0);
    if (l._tints.size > 64) l._tints.clear();
    l._tints.set(key, c);
  }
  return c;
}

function renderLayerList() {
  const list = $('layerlist');
  list.innerHTML = '';
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    const shown = layerVisibleNow(l);
    const keyed = anim.mode === 'animate' && anim.name &&
                  Rig.showKeys(anim.name, l.src).length > 0;
    const el = document.createElement('div');
    el.className = 'layer' + (i === doc.selected ? ' selected' : '') + (shown ? '' : ' hidden-layer');
    const eye = document.createElement('span');
    eye.className = 'eye' + (keyed ? ' keyed' : '');
    eye.textContent = shown ? '👁' : '–';
    eye.title = anim.mode === 'animate'
      ? 'Toggle visibility — keys it at the playhead in this animation'
      : 'Toggle setup visibility';
    eye.onclick = e => {
      e.stopPropagation();
      if (anim.mode === 'animate' && anim.name) {
        // auto-key visibility, like posing auto-keys transforms
        Rig.pushUndo(doc.layers);
        Rig.keyShow(anim.name, l.src, anim.time, !shown);
        renderTimeline();
      } else {
        l.visible = !l.visible;
        markDirty();
      }
      renderLayerList();
      render();
    };
    const label = document.createElement('span');
    label.className = 'lname';
    label.textContent = l.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = Rig.bones[l.bone]?.name || '?';
    const up = document.createElement('span');
    up.className = 'ord';
    up.textContent = '▲';
    up.title = 'Bring forward (⌘])';
    up.onclick = e => { e.stopPropagation(); moveLayer(i, +1); };
    const down = document.createElement('span');
    down.className = 'ord';
    down.textContent = '▼';
    down.title = 'Send backward (⌘[)';
    down.onclick = e => { e.stopPropagation(); moveLayer(i, -1); };
    el.append(eye, label, tag, up, down);
    el.onclick = () => { doc.selected = i; doc.selectedBone = -1; refresh(); };
    list.appendChild(el);
  }
}

// dir +1 = draw later (in front / up in the panel), -1 = behind
function moveLayer(i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.layers.length) return;
  Rig.pushUndo(doc.layers);
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  if (doc.selected === i) doc.selected = j;
  else if (doc.selected === j) doc.selected = i;
  refresh();
}

function renderBoneList() {
  const list = $('bonelist');
  list.innerHTML = '';
  const depth = i => { let d = 0, b = Rig.bones[i]; while (b.parent >= 0) { d++; b = Rig.bones[b.parent]; } return d; };
  Rig.bones.forEach((b, i) => {
    const el = document.createElement('div');
    el.className = 'bone' + (i === doc.selectedBone ? ' selected' : '');
    el.style.paddingLeft = 8 + depth(i) * 14 + 'px';
    el.textContent = b.name;
    el.onclick = () => { doc.selectedBone = i; doc.selected = -1; refresh(); };
    el.ondblclick = () => {
      const name = prompt('Bone name:', b.name);
      if (name) { Rig.pushUndo(doc.layers); Rig.renameBone(i, name); refresh(); }
    };
    list.appendChild(el);
  });
}

function renderProps() {
  const box = $('props');
  box.innerHTML = '';
  const bone = Rig.bones[doc.selectedBone];
  const layer = doc.layers[doc.selected];

  const row = (label, node) => {
    const r = document.createElement('div');
    r.className = 'prop';
    const s = document.createElement('span');
    s.textContent = label;
    r.append(s, node);
    box.appendChild(r);
  };
  const boneSelect = (current, exclude, onpick) => {
    const sel = document.createElement('select');
    Rig.bones.forEach((b, i) => {
      if (exclude && exclude.includes(i)) return;
      const o = document.createElement('option');
      o.value = i; o.textContent = b.name;
      if (i === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => onpick(+sel.value);
    return sel;
  };

  if (bone && doc.selectedBone > 0) {
    box.insertAdjacentHTML('beforeend', `<h2>bone: ${bone.name}</h2>`);
    row('parent', boneSelect(bone.parent, [doc.selectedBone, ...Rig.descendantsOf(doc.selectedBone)], v => {
      Rig.pushUndo(doc.layers);
      Rig.reparent(doc.selectedBone, v, doc.layers);
      refresh();
    }));
    const del = document.createElement('button');
    del.textContent = 'delete bone';
    del.onclick = () => {
      Rig.pushUndo(doc.layers);
      Rig.remove(doc.selectedBone, doc.layers);
      doc.selectedBone = -1;
      refresh();
    };
    box.appendChild(del);
    const cur = Rig.current(doc.selectedBone);
    const info = document.createElement('div');
    info.className = 'dim';
    info.textContent = `x ${cur.x.toFixed(1)}  y ${cur.y.toFixed(1)}  rot ${cur.rotation.toFixed(1)}°  ` +
                       `len ${bone.length.toFixed(0)}  scale ${cur.scaleX.toFixed(2)}×${cur.scaleY.toFixed(2)}`;
    box.appendChild(info);
  } else if (bone) {
    box.insertAdjacentHTML('beforeend', `<h2>bone: root</h2>`);
  }

  if (layer) {
    box.insertAdjacentHTML('beforeend', `<h2>layer: ${layer.name}</h2>`);
    row('bone', boneSelect(layer.bone, null, v => {
      Rig.pushUndo(doc.layers);
      Rig.bind(layer, v);
      refresh();
    }));

    // tint + alpha — edits setup in setup mode, auto-keys in animate mode
    const cur = layerTintNow(layer);
    const hex = c => '#' + c.slice(0, 3).map(v =>
      Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const color = document.createElement('input');
    color.type = 'color';
    color.value = hex(cur);
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.min = 0; alpha.max = 100;
    alpha.value = Math.round(cur[3] * 100);
    alpha.style.flex = '1';
    const applyTint = () => {
      if (!drag?.tintUndo) {   // one undo entry per adjustment burst
        Rig.pushUndo(doc.layers);
        drag = { ...(drag || {}), tintUndo: true, kind: drag?.kind };
      }
      const v = parseInt(color.value.slice(1), 16);
      const c = [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, alpha.value / 100];
      const targets = tintAllLayers ? doc.layers : [layer];
      for (const t of targets) {
        if (anim.mode === 'animate' && anim.name) Rig.keyTint(anim.name, t.src, anim.time, c);
        else t.tint = c;
      }
      if (anim.mode === 'animate' && anim.name) renderTimeline();
      render();
      renderLayerList();
    };
    color.oninput = applyTint;
    alpha.oninput = applyTint;
    color.onchange = alpha.onchange = () => { if (drag?.tintUndo) drag = null; };
    row('tint', color);
    row('alpha', alpha);
    // whole-character fades/tints without visiting all layers one by one
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.checked = tintAllLayers;
    all.onchange = () => { tintAllLayers = all.checked; renderProps(); };
    row('all layers', all);

    // mesh deformation: skin the layer to the bone chain that starts at its
    // bone, so rotating the chain bends the art instead of hinging it
    if (anim.mode === 'setup' && !layer.gen) {
      if (layer.mesh) {
        const info = document.createElement('div');
        info.className = 'dim';
        const names = layer.mesh.spec.chain.map(b => Rig.bones[b]?.name ?? '?').join(' › ');
        info.textContent = `mesh: ${layer.mesh.spec.segments} segments along ${names}`;
        box.appendChild(info);
        const rm = document.createElement('button');
        rm.textContent = 'remove mesh';
        rm.onclick = () => { Rig.pushUndo(doc.layers); delete layer.mesh; refresh(); };
        box.appendChild(rm);
      } else {
        const descendants = Rig.descendantsOf(layer.bone);
        const end = document.createElement('select');
        for (const bi of descendants) {
          const o = document.createElement('option');
          o.value = bi;
          o.textContent = Rig.bones[bi].name;
          end.appendChild(o);
        }
        const automatic = Rig.chainFrom(layer.bone);
        if (automatic.length > 1) end.value = automatic[automatic.length - 1];

        const segments = document.createElement('input');
        segments.type = 'number';
        segments.min = 2; segments.max = 40; segments.step = 1;
        segments.style.width = '60px';
        const chainTo = endBone => {
          const chain = [];
          for (let b = endBone; b >= 0; b = Rig.bones[b].parent) {
            chain.unshift(b);
            if (b === layer.bone) return chain;
          }
          return [];
        };
        const suggestSegments = () => {
          segments.value = String(Math.max(2, chainTo(+end.value).length * 3));
        };
        end.onchange = suggestSegments;
        suggestSegments();
        if (descendants.length) {
          row('bend to', end);
          row('segments', segments);
        }

        const bend = document.createElement('button');
        bend.textContent = '〰 bend along bones';
        bend.title = 'Skin this layer from its bound bone through the selected descendant, so the chain bends the art';
        bend.disabled = !descendants.length;
        bend.onclick = () => {
          const chain = chainTo(+end.value);
          if (chain.length < 2) return status('bind the layer to the first bone of the bend, then choose its end bone');
          const names = chain.map(b => Rig.bones[b].name).join(' › ');
          const n = Math.max(2, Math.min(40, parseInt(segments.value, 10) || chain.length * 3));
          Rig.pushUndo(doc.layers);
          Rig.meshAlongChain(layer, chain, n);
          refresh();
          status(`${layer.name}: meshed along ${chain.length} bones — pose the chain to bend it`);
        };
        box.appendChild(bend);
      }
    }

    // shatter the layer into crumble pieces, right here in the app
    if (anim.mode === 'setup' && !layer.gen) {
      const cr = document.createElement('button');
      cr.textContent = '💥 crumble';
      cr.title = 'Slice this layer into hidden death pieces, each with its own bone';
      cr.onclick = () => {
        const raw = prompt(`Shatter "${layer.name}" into how many pieces?`, '4');
        const n = Math.max(2, Math.min(12, parseInt(raw, 10) || 0));
        if (raw && n) crumbleLayer(layer, n);
      };
      box.appendChild(cr);
    }

    // layer size relative to its bone (setup only; aspect preserved)
    if (anim.mode === 'setup') {
      const size = document.createElement('input');
      size.type = 'number';
      size.min = 1; size.max = 1000; size.step = 1;
      size.value = Math.round((layer.lsx ?? 1) * 100);
      size.style.width = '60px';
      size.onchange = () => {
        const v = Math.max(0.01, (+size.value || 100) / 100);
        Rig.pushUndo(doc.layers);
        const factor = v / (layer.lsx || 1);
        layer.lsx = v;
        layer.lsy = (layer.lsy ?? 1) * factor;
        render();
      };
      row('size %', size);
    }
    if (anim.mode === 'animate') {
      const note = document.createElement('div');
      note.className = 'dim';
      note.textContent = tintAllLayers
        ? 'changing tint/alpha keys EVERY layer at the playhead'
        : 'changing tint/alpha keys it at the playhead';
      box.appendChild(note);
    }
  }

  if (!bone && !layer) {
    box.insertAdjacentHTML('beforeend',
      '<div class="dim">V select/pose · B draw bones · P move pivots · S scale<br>' +
      'New bones parent to the selected bone.<br>' +
      'Draw a bone with a layer selected → the layer binds to it.<br>' +
      'drag bone origin = move · drag tip = rotate<br>' +
      'alt-drag canvas = pan · wheel = zoom</div>');
  }
}

// ------------------------------------------------------------- canvas

function fitView() {
  const c = $('stage');
  view.zoom = Math.min(c.clientWidth / doc.width, c.clientHeight / doc.height) * 0.85;
  view.panX = (c.clientWidth - doc.width * view.zoom) / 2;
  view.panY = (c.clientHeight - doc.height * view.zoom) / 2;
}

// Draw a meshed layer: every triangle maps image pixels onto its skinned
// world-space position (same technique as mini-spine's mesh renderer).
function drawMesh(ctx, l, tex) {
  const v = Rig.meshWorldVerts(l), p = l.mesh.verts, t = l.mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i], b = t[i + 1], c = t[i + 2];
    drawTexTriangle(ctx, tex,
      p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1], p[c * 2], p[c * 2 + 1],
      v[a * 2], v[a * 2 + 1], v[b * 2], v[b * 2 + 1], v[c * 2], v[c * 2 + 1]);
  }
}

// Map a texture-space triangle onto a world-space triangle with the affine
// transform through their three corners, clipped to the destination (grown
// a hair around its centroid so adjacent triangles don't show seams).
function drawTexTriangle(ctx, tex, sx1, sy1, sx2, sy2, sx3, sy3, dx1, dy1, dx2, dy2, dx3, dy3) {
  const den = sx1 * (sy2 - sy3) + sx2 * (sy3 - sy1) + sx3 * (sy1 - sy2);
  if (Math.abs(den) < 1e-9) return;
  const cx = (dx1 + dx2 + dx3) / 3, cy = (dy1 + dy2 + dy3) / 3;
  const grow = (x, y) => {
    const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1, e = 0.35 / view.zoom;
    return [x + dx / len * e, y + dy / len * e];
  };
  const [ex1, ey1] = grow(dx1, dy1), [ex2, ey2] = grow(dx2, dy2), [ex3, ey3] = grow(dx3, dy3);
  const a = (dx1 * (sy2 - sy3) + dx2 * (sy3 - sy1) + dx3 * (sy1 - sy2)) / den;
  const b = (dy1 * (sy2 - sy3) + dy2 * (sy3 - sy1) + dy3 * (sy1 - sy2)) / den;
  const c = (dx1 * (sx3 - sx2) + dx2 * (sx1 - sx3) + dx3 * (sx2 - sx1)) / den;
  const d = (dy1 * (sx3 - sx2) + dy2 * (sx1 - sx3) + dy3 * (sx2 - sx1)) / den;
  const e = (dx1 * (sx2 * sy3 - sx3 * sy2) + dx2 * (sx3 * sy1 - sx1 * sy3) + dx3 * (sx1 * sy2 - sx2 * sy1)) / den;
  const f = (dy1 * (sx2 * sy3 - sx3 * sy2) + dy2 * (sx3 * sy1 - sx1 * sy3) + dy3 * (sx1 * sy2 - sx2 * sy1)) / den;
  ctx.save();
  const path = new Path2D();
  path.moveTo(ex1, ey1); path.lineTo(ex2, ey2); path.lineTo(ex3, ey3); path.closePath();
  ctx.clip(path);
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(tex, 0, 0);
  ctx.restore();
}

function render() {
  const c = $('stage');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== c.clientWidth * dpr || c.height !== c.clientHeight * dpr) {
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!doc.layers.length) return;

  const base = [view.zoom * dpr, 0, 0, view.zoom * dpr, view.panX * dpr, view.panY * dpr];
  ctx.setTransform(...base);
  ctx.imageSmoothingQuality = 'high';

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1 / view.zoom;
  ctx.strokeRect(0, 0, doc.width, doc.height);

  for (const l of doc.layers) {
    if (!layerVisibleNow(l)) continue;
    const [tr, tg, tb, ta] = layerTintNow(l);
    if (ta <= 0.003) continue;
    const tex = tintedCanvas(l, tr, tg, tb);
    ctx.save();
    ctx.globalAlpha = ta;
    if (l.mesh) {
      drawMesh(ctx, l, tex);   // skinned: each triangle follows its bones
    } else {
      const m = Rig.layerWorld(l);
      ctx.transform(m.a, m.c, m.b, m.d, m.x, m.y);
      ctx.drawImage(tex, -l.canvas.width / 2, -l.canvas.height / 2);
    }
    ctx.restore();
  }

  const sel = doc.layers[doc.selected];
  if (sel && sel.mesh) {
    // selected meshed layer: show the deforming wireframe instead of a rect
    const v = Rig.meshWorldVerts(sel), t = sel.mesh.tris;
    ctx.save();
    ctx.strokeStyle = 'rgba(158,206,106,0.85)';
    ctx.lineWidth = 1 / view.zoom;
    ctx.beginPath();
    for (let i = 0; i < t.length; i += 3) {
      ctx.moveTo(v[t[i] * 2], v[t[i] * 2 + 1]);
      ctx.lineTo(v[t[i + 1] * 2], v[t[i + 1] * 2 + 1]);
      ctx.lineTo(v[t[i + 2] * 2], v[t[i + 2] * 2 + 1]);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  } else if (sel) {
    const m = Rig.layerWorld(sel);
    ctx.save();
    ctx.transform(m.a, m.c, m.b, m.d, m.x, m.y);
    ctx.strokeStyle = '#9ece6a';
    ctx.lineWidth = 1.5 / (view.zoom * Math.max(0.01, Math.hypot(m.a, m.c)));
    ctx.strokeRect(-sel.canvas.width / 2, -sel.canvas.height / 2, sel.canvas.width, sel.canvas.height);
    ctx.restore();
  }

  drawBones(ctx);
}

// a bone shows only while some layer bound to it is visible; bare bones
// (no layers) are structural and always show, as does the selection
function boneVisible(i) {
  if (i === doc.selectedBone) return true;
  let hasLayers = false;
  for (const l of doc.layers) {
    if (l.bone === i) {
      hasLayers = true;
      if (layerVisibleNow(l)) return true;
    }
  }
  return !hasLayers;
}

function drawBones(ctx) {
  const z = view.zoom;
  Rig.bones.forEach((b, i) => {
    if (!boneVisible(i)) return;
    if (i === 0 && tool !== 'pivot') {
      // root: subtle cross
      const m = Rig.world(0);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      ctx.moveTo(m.x - 8 / z, m.y); ctx.lineTo(m.x + 8 / z, m.y);
      ctx.moveTo(m.x, m.y - 8 / z); ctx.lineTo(m.x, m.y + 8 / z);
      ctx.stroke();
      return;
    }
    const m = Rig.world(i);
    const len = Math.max(b.length, 4);
    const [tx, ty] = Rig.apply(m, len, 0);
    const selB = i === doc.selectedBone;
    const col = selB ? '#9ece6a' : (tool === 'pivot' ? '#f7768e' : '#e0af68');

    // link to parent
    if (b.parent > 0) {
      const pm = Rig.world(b.parent);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      ctx.moveTo(pm.x, pm.y); ctx.lineTo(m.x, m.y);
      ctx.stroke();
    }

    // bone triangle
    if (i > 0) {
      const w = Math.min(5 / z, len * 0.2);
      const ang = Math.atan2(ty - m.y, tx - m.x);
      const px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
      ctx.fillStyle = col + (selB ? 'cc' : '88');
      ctx.beginPath();
      ctx.moveTo(m.x + px * w, m.y + py * w);
      ctx.lineTo(tx, ty);
      ctx.lineTo(m.x - px * w, m.y - py * w);
      ctx.closePath();
      ctx.fill();
    }

    // origin (pivot) circle
    ctx.strokeStyle = col;
    ctx.fillStyle = '#16181d';
    ctx.lineWidth = 1.5 / z;
    ctx.beginPath();
    ctx.arc(m.x, m.y, (i === 0 ? 6 : 4.5) / z, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

function canvasToDoc(e) {
  const r = $('stage').getBoundingClientRect();
  return [(e.clientX - r.left - view.panX) / view.zoom,
          (e.clientY - r.top - view.panY) / view.zoom];
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1e-9)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// hit-test bones: returns { bone, part: 'origin'|'tip'|'shaft' } or null.
// Three passes so a long bone's shaft never shadows another bone's origin.
function hitBone(dx, dy) {
  const r = 8 / view.zoom;
  const tip = i => {
    const m = Rig.world(i);
    return Rig.apply(m, Math.max(Rig.bones[i].length, 4), 0);
  };
  for (let i = Rig.bones.length - 1; i >= 0; i--) {
    if (!boneVisible(i)) continue;
    const m = Rig.world(i);
    if (Math.hypot(dx - m.x, dy - m.y) < r) return { bone: i, part: 'origin' };
  }
  for (let i = Rig.bones.length - 1; i > 0; i--) {
    if (!boneVisible(i)) continue;
    const [tx, ty] = tip(i);
    if (Math.hypot(dx - tx, dy - ty) < r) return { bone: i, part: 'tip' };
  }
  for (let i = Rig.bones.length - 1; i > 0; i--) {
    if (!boneVisible(i)) continue;
    const m = Rig.world(i);
    const [tx, ty] = tip(i);
    if (distToSegment(dx, dy, m.x, m.y, tx, ty) < 9 / view.zoom) return { bone: i, part: 'shaft' };
  }
  return null;
}

function hitLayer(dx, dy) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!layerVisibleNow(l)) continue;
    const inv = Rig.invert(Rig.layerWorld(l));
    const [lx, ly] = Rig.apply(inv, dx, dy);
    const px = Math.floor(lx + l.canvas.width / 2);
    const py = Math.floor(ly + l.canvas.height / 2);
    if (px < 0 || py < 0 || px >= l.canvas.width || py >= l.canvas.height) continue;
    if (l.canvas.getContext('2d').getImageData(px, py, 1, 1).data[3] > 10) return i;
  }
  return -1;
}

// ------------------------------------------------------------- tools

function setTool(t) {
  tool = t;
  if ((t === 'bone' || t === 'pivot') && anim.mode === 'animate') setMode('setup');
  for (const b of document.querySelectorAll('#toolbar button[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === t);
  }
  $('stage').style.cursor =
    t === 'bone' ? 'crosshair' : t === 'scale' ? 'nwse-resize' : 'default';
  render();
}

$('stage').addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    drag = { kind: 'pan', x: e.clientX, y: e.clientY };
    e.preventDefault();
    return;
  }
  if (e.button !== 0 || !doc.layers.length) return;
  const [dx, dy] = canvasToDoc(e);

  if (tool === 'bone') {
    const parent = doc.selectedBone >= 0 ? doc.selectedBone : 0;
    // drawing a bone with a layer selected binds that layer to the new bone
    const bindLayer = doc.layers[doc.selected] || null;
    Rig.pushUndo(doc.layers);
    const i = Rig.add(parent, dx, dy, dx, dy);
    drag = { kind: 'newbone', bone: i, ox: dx, oy: dy, bindLayer };
    doc.selectedBone = i;
    doc.selected = -1;
    refresh();
    return;
  }

  const hb = hitBone(dx, dy);
  if (hb) {
    doc.selectedBone = hb.bone;
    doc.selected = -1;
    Rig.pushUndo(doc.layers);
    if (tool === 'scale') {
      const m = Rig.world(hb.bone);
      const cur = Rig.current(hb.bone);
      drag = { kind: 'scale', bone: hb.bone, ox: m.x, oy: m.y,
               d0: Math.max(4, Math.hypot(dx - m.x, dy - m.y)),
               s0x: cur.scaleX, s0y: cur.scaleY };
      refresh();
      return;
    }
    if (tool === 'pivot') {
      drag = { kind: 'pivot', bone: hb.bone, x0doc: dx, y0doc: dy };
    } else if (hb.part === 'origin') {
      drag = { kind: 'move', bone: hb.bone, x0doc: dx, y0doc: dy };
    } else {
      // tip or shaft: rotate; shift additionally re-lengths to the cursor
      drag = { kind: 'rotate', bone: hb.bone, shift: e.shiftKey && hb.part === 'tip' };
    }
    refresh();
    return;
  }

  const hl = hitLayer(dx, dy);
  doc.selected = hl;
  if (hl >= 0) doc.selectedBone = -1;
  refresh();
});

$('stage').addEventListener('mousemove', e => {
  if (drag || !doc.layers.length || tool === 'bone') return;
  const [dx, dy] = canvasToDoc(e);
  const hb = hitBone(dx, dy);
  $('stage').style.cursor =
    !hb ? 'default' : hb.part === 'origin' ? 'move' : 'grab';
});

window.addEventListener('mousemove', e => {
  if (!drag) return;
  if (drag.kind === 'pan') {
    view.panX += e.clientX - drag.x;
    view.panY += e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    render();
    return;
  }
  let [dx, dy] = canvasToDoc(e);
  // shift constrains move/pivot drags to 45° axes, Photoshop-style
  if (e.shiftKey && (drag.kind === 'move' || drag.kind === 'pivot') && drag.x0doc !== undefined) {
    const vx = dx - drag.x0doc, vy = dy - drag.y0doc;
    const snap = Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = vx * Math.cos(snap) + vy * Math.sin(snap);
    dx = drag.x0doc + Math.cos(snap) * len;
    dy = drag.y0doc + Math.sin(snap) * len;
  }
  const b = Rig.bones[drag.bone];
  const cur = Rig.current(drag.bone);       // posed values in animate mode
  const wrap180 = d => { d %= 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  const animating = anim.mode === 'animate';

  if (drag.kind === 'newbone' || (drag.kind === 'rotate' && drag.shift)) {
    const m = Rig.world(b.parent >= 0 ? b.parent : -1);
    const [lx, ly] = Rig.apply(Rig.invert(m), dx, dy);
    b.rotation = Math.atan2(ly - b.y, lx - b.x) / (Math.PI / 180);
    b.length = Math.hypot(lx - b.x, ly - b.y);
  } else if (drag.kind === 'rotate') {
    const m = Rig.world(b.parent >= 0 ? b.parent : -1);
    const [lx, ly] = Rig.apply(Rig.invert(m), dx, dy);
    const desired = Math.atan2(ly - cur.y, lx - cur.x) / (Math.PI / 180);
    if (animating) {
      Rig.keyAt(anim.name, b.name, 'rotate', anim.time,
                { value: wrap180(desired - b.rotation) });
      keyedDuringDrag();
    } else {
      b.rotation = desired;
    }
  } else if (drag.kind === 'move') {
    const m = Rig.world(b.parent);
    const [lx, ly] = Rig.apply(Rig.invert(m), dx, dy);
    if (animating) {
      Rig.keyAt(anim.name, b.name, 'translate', anim.time,
                { x: lx - b.x, y: ly - b.y });
      keyedDuringDrag();
    } else {
      b.x = lx; b.y = ly;
    }
  } else if (drag.kind === 'scale') {
    const f = Math.max(0.05, Math.min(20,
      Math.hypot(dx - drag.ox, dy - drag.oy) / drag.d0));
    if (animating) {
      Rig.keyAt(anim.name, b.name, 'scale', anim.time,
                { x: drag.s0x * f / (b.scaleX || 1), y: drag.s0y * f / (b.scaleY || 1) });
      keyedDuringDrag();
    } else {
      b.scaleX = drag.s0x * f;
      b.scaleY = drag.s0y * f;
    }
  } else if (drag.kind === 'pivot') {
    const m = Rig.world(b.parent >= 0 ? b.parent : -1);
    const [lx, ly] = Rig.apply(Rig.invert(m), dx, dy);
    Rig.editCompensated(drag.bone, bone => { bone.x = lx; bone.y = ly; }, doc.layers);
  }
  updatePose();
  renderProps();
  render();
});

function keyedDuringDrag() {
  if (drag && !drag.keyed) {
    drag.keyed = true;
    anim.selectedKey = { bone: Rig.bones[drag.bone].name, time: anim.time };
    anim.selectedEvent = null;   // or Delete removes a stale event instead
    renderTimeline();
  }
}

window.addEventListener('mouseup', () => {
  if (drag && drag.kind === 'newbone') {
    const b = Rig.bones[drag.bone];
    if (b.length < 3) {   // click without drag: give it a default direction
      b.length = 30;
    }
    // bind only now — during the drag the bone was still being aimed
    if (drag.bindLayer) {
      Rig.bind(drag.bindLayer, drag.bone);
      status(`${b.name} created — ${drag.bindLayer.name} bound to it`);
    }
    refresh();
  }
  if (drag && drag.keyed) renderTimeline();
  // drag is NOT cleared here: the timeline's own mouseup handler (registered
  // later, so it runs after this one) still needs it to finalize key/resize
  // drags — it clears drag when done
});

$('stage').addEventListener('wheel', e => {
  e.preventDefault();
  const [dx, dy] = canvasToDoc(e);
  view.zoom *= Math.exp(-e.deltaY * 0.0015);
  const r = $('stage').getBoundingClientRect();
  view.panX = e.clientX - r.left - dx * view.zoom;
  view.panY = e.clientY - r.top - dy * view.zoom;
  render();
}, { passive: false });

window.addEventListener('resize', render);

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === 'z' && !e.shiftKey) {
    if (Rig.undo(doc.layers)) { updatePose(); refresh(); }
    e.preventDefault();
  } else if (meta && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
    if (Rig.redo(doc.layers)) { updatePose(); refresh(); }
    e.preventDefault();
  } else if (meta && e.key === ']') {
    if (doc.selected >= 0) { moveLayer(doc.selected, +1); e.preventDefault(); }
  } else if (meta && e.key === '[') {
    if (doc.selected >= 0) { moveLayer(doc.selected, -1); e.preventDefault(); }
  } else if (meta && (e.key === 'c' || e.key === 'C')) {
    if (anim.mode === 'animate' && anim.selectedKey) { copyKey(); e.preventDefault(); }
  } else if (meta && (e.key === 'v' || e.key === 'V')) {
    if (anim.mode === 'animate' && anim.clipboard) { pasteKey(); e.preventDefault(); }
  } else if (e.key === 'k' || e.key === 'K') {
    insertKey();
  } else if (e.key === ' ') {
    if (anim.mode === 'animate') { play(); e.preventDefault(); }
  } else if (e.key === 'Tab') {
    setMode(anim.mode === 'animate' ? 'setup' : 'animate');
    e.preventDefault();
  } else if (e.key === 'Escape') {
    anim.selectedKey = null;
    anim.selectedEvent = null;
    renderTimeline();
  } else if (e.key === 'v' || e.key === 'V') setTool('select');
  else if (e.key === 'b' || e.key === 'B') setTool('bone');
  else if (e.key === 'p' || e.key === 'P') setTool('pivot');
  else if (e.key === 's' || e.key === 'S') setTool('scale');
  else if (e.key === 'Backspace' || e.key === 'Delete') {
    if (anim.mode === 'animate') {
      if (anim.multiSel.length) {
        Rig.pushUndo(doc.layers);
        const sel = anim.multiSel;
        const boneCovers = s => sel.some(o => o.kind === 'bone' && o.bone === s.bone && Math.abs(o.time - s.time) < 1e-6);
        for (const s of sel) {
          if (s.kind === 'bone') Rig.deleteKeys(anim.name, s.bone, s.time);
          else if (s.kind === 'chan' && !boneCovers(s)) Rig.deleteChannelKey(anim.name, s.bone, s.channel, s.time);
          else if (s.kind === 'show') Rig.deleteShowKey(anim.name, s.src, s.time);
          else if (s.kind === 'tint') Rig.deleteTintKey(anim.name, s.src, s.time);
        }
        // events by identity, so index shifts from earlier deletes can't misfire
        for (const s of sel.filter(s => s.kind === 'event')) {
          const i = Rig.events(anim.name).findIndex(ev => Math.abs(ev.time - s.time) < 1e-6 && ev.name === s.name);
          if (i >= 0) Rig.deleteEvent(anim.name, i);
        }
        anim.multiSel = [];
        anim.selectedKey = null;
        anim.selectedEvent = null;
        updatePose();
        refresh();
      } else if (anim.selectedEvent !== null) {
        Rig.pushUndo(doc.layers);
        Rig.deleteEvent(anim.name, anim.selectedEvent);
        anim.selectedEvent = null;
        renderTimeline();
      } else if (anim.selectedKey && anim.selectedKey.show !== undefined) {
        Rig.pushUndo(doc.layers);
        Rig.deleteShowKey(anim.name, anim.selectedKey.show, anim.selectedKey.time);
        anim.selectedKey = null;
        refresh();
      } else if (anim.selectedKey && anim.selectedKey.tint !== undefined) {
        Rig.pushUndo(doc.layers);
        Rig.deleteTintKey(anim.name, anim.selectedKey.tint, anim.selectedKey.time);
        anim.selectedKey = null;
        refresh();
      } else if (anim.selectedKey) {
        Rig.pushUndo(doc.layers);
        if (anim.selectedKey.channel) {
          Rig.deleteChannelKey(anim.name, anim.selectedKey.bone,
                               anim.selectedKey.channel, anim.selectedKey.time);
        } else {
          Rig.deleteKeys(anim.name, anim.selectedKey.bone, anim.selectedKey.time);
        }
        anim.selectedKey = null;
        updatePose();
        refresh();
      }
    } else if (doc.selectedBone > 0) {
      Rig.pushUndo(doc.layers);
      Rig.remove(doc.selectedBone, doc.layers);
      doc.selectedBone = -1;
      refresh();
    }
    e.preventDefault();
  }
});

for (const b of document.querySelectorAll('#toolbar button[data-tool]')) {
  b.onclick = () => setTool(b.dataset.tool);
}

// ------------------------------------------------------------- timeline

function setMode(m) {
  if (m === anim.mode) return;
  if (m === 'animate') {
    if (!doc.layers.length) return;
    if (!anim.name) {
      // first animation: ask for its name up front (game reserves "walk")
      const raw = prompt('Name the first animation:', 'walk');
      if (!raw) return;
      anim.name = raw.trim() || 'walk';
    }
    Rig.ensureAnim(anim.name);
    if (tool !== 'select') setTool('select');
  } else {
    play(false);   // through play() so the ▶/❚❚ button stays truthful
  }
  anim.mode = m;
  anim.selectedKey = null;
  anim.selectedEvent = null;
  anim.multiSel = [];
  updatePose();
  refresh();
}

function setTime(t) {
  const d = curAnim()?.duration || 2;
  anim.time = Math.max(0, Math.min(t, d));
  updatePose();
  updatePlayhead();
  render();
  renderProps();
  renderLayerList();   // eyes reflect visibility at the playhead
}

function updatePlayhead() {
  $('tl-playhead').style.left = TL_LABEL_W + anim.time * PX_PER_SEC + 'px';
  const f = Math.round(anim.time * FPS);
  $('timelabel').textContent = `${anim.time.toFixed(2)}s · f${f}`;
}

function keyCurve(boneName, time) {
  const ch = curAnim()?.bones[boneName];
  if (!ch) return 'ease';
  for (const keys of Object.values(ch)) {
    const k = keys?.find(k => Math.abs(k.time - time) < 1e-6);
    if (k) return k.curve || 'ease';
  }
  return 'ease';
}

function renderTimeline() {
  const animating = anim.mode === 'animate';
  $('modebtn').classList.toggle('animating', animating);
  $('modebtn').textContent = animating ? '● Animating' : '○ Animate';
  $('tl-body').classList.toggle('open', animating);
  $('tl-hint').innerHTML = animating
    ? 'auto-key on pose · K keys bone · ⌘C/⌘V copy/paste · ⌫ delete · drag blank = box-select · ⇧click adds · ' +
      '<span style="color:#e0af68">◆ ease</span> ' +
      '<span style="color:#c0caf5">◇ linear</span> ' +
      '<span style="color:#7aa2f7">■ stepped</span>' : '';

  const sel = $('animsel');
  sel.innerHTML = '';
  for (const name of Object.keys(Rig.anims)) {
    const o = document.createElement('option');
    o.value = o.textContent = name;
    if (name === anim.name) o.selected = true;
    sel.appendChild(o);
  }
  if (!animating) return;

  const a = curAnim();
  $('durinput').value = a.duration.toFixed(1);

  // rows: bones with keys, plus the selected bone
  const rows = [];
  Rig.bones.forEach((b, i) => {
    const times = Rig.keyTimes(anim.name, b.name);
    if (times.length || i === doc.selectedBone) rows.push({ b, times });
  });

  const width = Math.max((a.duration + 0.5) * PX_PER_SEC,
                         $('tl-scroll').clientWidth - TL_LABEL_W);
  $('tl-inner').style.width = TL_LABEL_W + width + 'px';

  const tracks = $('tl-tracks');
  tracks.innerHTML = '';

  // events track — always first, always visible
  {
    const row = document.createElement('div');
    row.className = 'tl-row tl-evrow';
    const lr = document.createElement('div');
    lr.className = 'tl-rowlabel';
    lr.textContent = '⚑ events';
    lr.title = 'Named frame markers the game syncs to (dbl-click track to add)';
    row.appendChild(lr);
    const tr = document.createElement('div');
    tr.className = 'tl-track';
    tr.ondblclick = e => {
      if (e.target !== tr) return;
      addEventMarker(magnetT(e.offsetX / PX_PER_SEC));
    };
    Rig.events(anim.name).forEach((ev, idx) => {
      const el = document.createElement('div');
      el.className = 'evt' + (idx === anim.selectedEvent ? ' selected' : '')
        + (inMultiSel({ kind: 'event', time: ev.time, name: ev.name }) ? ' msel' : '');
      el.style.left = ev.time * PX_PER_SEC + 'px';
      el.dataset.time = ev.time;
      el.dataset.name = ev.name;
      el.textContent = ev.name;
      el.title = `${ev.name} @ ${ev.time.toFixed(2)}s (drag · dbl-click renames · ⌫ deletes)`;
      el.onmousedown = e => {
        e.stopPropagation();
        e.preventDefault();
        const desc = { kind: 'event', time: ev.time, name: ev.name };
        if (e.shiftKey) return toggleMultiSel(desc, el);
        if (inMultiSel(desc)) {
          setTime(ev.time);
          drag = { kind: 'multikey', from: ev.time, cur: ev.time, x0: e.clientX };
          return;
        }
        clearMultiSel();
        setTime(ev.time);   // clicking a marker parks the playhead on it
        anim.selectedEvent = idx;
        anim.selectedKey = null;
        for (const o of document.querySelectorAll('.evt.selected, #tl-tracks .key.selected, #tl-tracks .vkey.selected')) o.classList.remove('selected');
        el.classList.add('selected');
        updateCurvebar();
        drag = { kind: 'event', el, idx, from: ev.time, cur: ev.time, x0: e.clientX };
      };
      el.ondblclick = e => {
        e.stopPropagation();
        const name = prompt('Event name:', ev.name);
        if (name) { Rig.pushUndo(doc.layers); Rig.renameEvent(anim.name, idx, name.trim()); renderTimeline(); }
      };
      tr.appendChild(el);
    });
    row.appendChild(tr);
    tracks.appendChild(row);
  }

  for (const { b, times } of rows) {
    const row = document.createElement('div');
    row.className = 'tl-row' + (expandedBones.has(b.name) ? ' expanded' : '');

    const lr = document.createElement('div');
    lr.className = 'tl-rowlabel' + (Rig.bones.indexOf(b) === doc.selectedBone ? ' selected' : '');
    if (times.length) {
      const arrow = document.createElement('span');
      arrow.className = 'tl-arrow';
      arrow.textContent = expandedBones.has(b.name) ? '▾' : '▸';
      arrow.title = 'Expand per-channel rows';
      arrow.onclick = e => {
        e.stopPropagation();
        expandedBones.has(b.name) ? expandedBones.delete(b.name) : expandedBones.add(b.name);
        renderTimeline();
      };
      lr.appendChild(arrow);
    }
    lr.appendChild(document.createTextNode(b.name));
    lr.onclick = () => { doc.selectedBone = Rig.bones.indexOf(b); doc.selected = -1; refresh(); };
    row.appendChild(lr);

    const tr = document.createElement('div');
    tr.className = 'tl-track';
    for (const t of times) {
      const k = document.createElement('div');
      const curve = keyCurve(b.name, t);
      k.className = 'key ' + curve +
        (anim.selectedKey && anim.selectedKey.bone === b.name &&
         Math.abs(anim.selectedKey.time - t) < 1e-6 ? ' selected' : '') +
        (inMultiSel({ kind: 'bone', bone: b.name, time: t }) ? ' msel' : '');
      k.style.left = t * PX_PER_SEC + 'px';
      const chs = CHANNELS.filter(([c]) =>
        Rig.channelKeys(anim.name, b.name, c).some(x => Math.abs(x.time - t) < 1e-6))
        .map(([c]) => c).join('+');
      k.title = `${b.name} @ ${t.toFixed(2)}s · ${chs} · ${curve} — drag/delete acts on all channels here`;
      k.dataset.bone = b.name;
      k.dataset.time = t;
      k.onmousedown = e => {
        e.stopPropagation();
        e.preventDefault();
        const desc = { kind: 'bone', bone: b.name, time: t };
        if (e.shiftKey) return toggleMultiSel(desc, k);
        if (inMultiSel(desc)) {   // grabbing a selected key drags the whole set
          setTime(t);
          drag = { kind: 'multikey', from: t, cur: t, x0: e.clientX };
          return;
        }
        clearMultiSel();
        setTime(t);   // clicking a key parks the playhead exactly on it
        anim.selectedKey = { bone: b.name, time: t };
        anim.selectedEvent = null;   // or Delete removes a stale event instead
        // select in place — rebuilding the DOM here would orphan the element
        // mid-drag and the diamond would stop following the cursor
        for (const el of document.querySelectorAll('#tl-tracks .key.selected, #tl-tracks .vkey.selected, .evt.selected')) el.classList.remove('selected');
        k.classList.add('selected');
        updateCurvebar();
        drag = { kind: 'key', el: k, bone: b.name, from: t, cur: t, x0: e.clientX };
      };
      tr.appendChild(k);
    }
    row.appendChild(tr);
    tracks.appendChild(row);

    // per-channel sub-rows when the bone is expanded
    if (!expandedBones.has(b.name)) continue;
    for (const [channel, label] of CHANNELS) {
      const ckeys = Rig.channelKeys(anim.name, b.name, channel);
      if (!ckeys.length) continue;
      const crow = document.createElement('div');
      crow.className = 'tl-row expanded';
      const clr = document.createElement('div');
      clr.className = 'tl-rowlabel tl-sublabel';
      clr.textContent = label;
      crow.appendChild(clr);
      const ctr = document.createElement('div');
      ctr.className = 'tl-track';
      for (const ck of ckeys) {
        const el = document.createElement('div');
        const sel = anim.selectedKey && anim.selectedKey.bone === b.name &&
                    anim.selectedKey.channel === channel &&
                    Math.abs(anim.selectedKey.time - ck.time) < 1e-6;
        el.className = 'key subkey ' + (ck.curve || 'ease') + (sel ? ' selected' : '') +
          (inMultiSel({ kind: 'chan', bone: b.name, channel, time: ck.time }) ? ' msel' : '');
        el.style.left = ck.time * PX_PER_SEC + 'px';
        el.title = `${b.name}.${channel} @ ${ck.time.toFixed(2)}s · ${ck.curve || 'ease'}`;
        el.dataset.bone = b.name;
        el.dataset.channel = channel;
        el.dataset.time = ck.time;
        el.onmousedown = e => {
          e.stopPropagation();
          e.preventDefault();
          const desc = { kind: 'chan', bone: b.name, channel, time: ck.time };
          if (e.shiftKey) return toggleMultiSel(desc, el);
          if (inMultiSel(desc)) {
            setTime(ck.time);
            drag = { kind: 'multikey', from: ck.time, cur: ck.time, x0: e.clientX };
            return;
          }
          clearMultiSel();
          setTime(ck.time);   // clicking a key parks the playhead exactly on it
          anim.selectedKey = { bone: b.name, channel, time: ck.time };
          anim.selectedEvent = null;
          for (const o of document.querySelectorAll('#tl-tracks .key.selected, #tl-tracks .vkey.selected, #tl-tracks .tkey.selected, .evt.selected')) o.classList.remove('selected');
          el.classList.add('selected');
          updateCurvebar();
          drag = { kind: 'chkey', el, bone: b.name, channel, from: ck.time, cur: ck.time, x0: e.clientX };
        };
        ctr.appendChild(el);
      }
      crow.appendChild(ctr);
      tracks.appendChild(crow);
    }
  }

  // visibility rows: layers with show/hide keys in this animation
  for (const l of doc.layers) {
    const vkeys = Rig.showKeys(anim.name, l.src);
    if (!vkeys.length) continue;
    const row = document.createElement('div');
    row.className = 'tl-row';
    const lr = document.createElement('div');
    lr.className = 'tl-rowlabel vlabel';
    lr.textContent = '👁 ' + l.name;
    row.appendChild(lr);
    const tr = document.createElement('div');
    tr.className = 'tl-track';
    for (const k of vkeys) {
      const el = document.createElement('div');
      const sel = anim.selectedKey && anim.selectedKey.show === l.src &&
                  Math.abs(anim.selectedKey.time - k.time) < 1e-6;
      el.className = 'vkey' + (k.on ? ' on' : '') + (sel ? ' selected' : '') +
        (inMultiSel({ kind: 'show', src: l.src, time: k.time }) ? ' msel' : '');
      el.style.left = k.time * PX_PER_SEC + 'px';
      el.dataset.src = l.src;
      el.dataset.time = k.time;
      el.title = `${l.name}: ${k.on ? 'show' : 'hide'} @ ${k.time.toFixed(2)}s`;
      el.onmousedown = e => {
        e.stopPropagation();
        e.preventDefault();
        const desc = { kind: 'show', src: l.src, time: k.time };
        if (e.shiftKey) return toggleMultiSel(desc, el);
        if (inMultiSel(desc)) {
          setTime(k.time);
          drag = { kind: 'multikey', from: k.time, cur: k.time, x0: e.clientX };
          return;
        }
        clearMultiSel();
        setTime(k.time);   // clicking a key parks the playhead exactly on it
        anim.selectedKey = { show: l.src, time: k.time };
        anim.selectedEvent = null;
        for (const o of document.querySelectorAll('#tl-tracks .key.selected, #tl-tracks .vkey.selected, .evt.selected')) o.classList.remove('selected');
        el.classList.add('selected');
        updateCurvebar();
        drag = { kind: 'showkey', el, src: l.src, from: k.time, cur: k.time, x0: e.clientX };
      };
      tr.appendChild(el);
    }
    row.appendChild(tr);
    tracks.appendChild(row);
  }

  // tint rows: layers with tint keys in this animation
  for (const l of doc.layers) {
    const tkeys = Rig.tintKeys(anim.name, l.src);
    if (!tkeys.length) continue;
    const row = document.createElement('div');
    row.className = 'tl-row';
    const lr = document.createElement('div');
    lr.className = 'tl-rowlabel vlabel';
    lr.textContent = '🎨 ' + l.name;
    row.appendChild(lr);
    const tr = document.createElement('div');
    tr.className = 'tl-track';
    for (const k of tkeys) {
      const el = document.createElement('div');
      const sel = anim.selectedKey && anim.selectedKey.tint === l.src &&
                  Math.abs(anim.selectedKey.time - k.time) < 1e-6;
      el.className = 'tkey' + (sel ? ' selected' : '') +
        (inMultiSel({ kind: 'tint', src: l.src, time: k.time }) ? ' msel' : '');
      el.style.left = k.time * PX_PER_SEC + 'px';
      el.dataset.src = l.src;
      el.dataset.time = k.time;
      el.style.background = `rgba(${k.c[0] * 255 | 0},${k.c[1] * 255 | 0},${k.c[2] * 255 | 0},${Math.max(k.c[3], 0.25)})`;
      el.title = `${l.name} tint @ ${k.time.toFixed(2)}s · α ${Math.round(k.c[3] * 100)}% · ${k.curve}`;
      el.onmousedown = e => {
        e.stopPropagation();
        e.preventDefault();
        const desc = { kind: 'tint', src: l.src, time: k.time };
        if (e.shiftKey) return toggleMultiSel(desc, el);
        if (inMultiSel(desc)) {
          setTime(k.time);
          drag = { kind: 'multikey', from: k.time, cur: k.time, x0: e.clientX };
          return;
        }
        clearMultiSel();
        setTime(k.time);   // clicking a key parks the playhead exactly on it
        anim.selectedKey = { tint: l.src, time: k.time };
        anim.selectedEvent = null;
        for (const o of document.querySelectorAll('#tl-tracks .key.selected, #tl-tracks .vkey.selected, #tl-tracks .tkey.selected, .evt.selected')) o.classList.remove('selected');
        el.classList.add('selected');
        updateCurvebar();
        drag = { kind: 'tintkey', el, src: l.src, from: k.time, cur: k.time, x0: e.clientX };
      };
      tr.appendChild(el);
    }
    row.appendChild(tr);
    tracks.appendChild(row);
  }

  // ruler ticks: density adapts to zoom (minor ticks never closer than ~12px)
  const ruler = $('tl-ruler');
  ruler.innerHTML = '';
  const minor = [0.05, 0.1, 0.25, 0.5, 1, 2].find(s => s * PX_PER_SEC >= 12) || 5;
  const major = minor * 5;
  for (let i = 0; i * minor <= width / PX_PER_SEC + 0.001; i++) {
    const t = i * minor;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const tick = document.createElement('div');
    tick.className = 'tick' + (isMajor ? '' : ' minor');
    tick.style.left = TL_LABEL_W + t * PX_PER_SEC + 'px';
    if (isMajor) tick.textContent = major >= 1 ? t.toFixed(0) : t.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    ruler.appendChild(tick);
  }
  const corner = document.createElement('div');
  corner.className = 'tl-corner';
  ruler.appendChild(corner);

  // dim everything past the animation's end
  let over = $('tl-overrun');
  if (!over) {
    over = document.createElement('div');
    over.id = 'tl-overrun';
    over.style.cssText = 'position:absolute;top:0;bottom:0;right:0;' +
      'background:rgba(0,0,0,0.3);pointer-events:none;z-index:2';
    $('tl-inner').appendChild(over);
  }
  over.style.left = TL_LABEL_W + a.duration * PX_PER_SEC + 'px';

  updateCurvebar();
  updatePlayhead();
}

function updateCurvebar() {
  let c = null;
  const k = anim.selectedKey;
  if (k && k.bone !== undefined && k.channel) {
    c = Rig.channelKeys(anim.name, k.bone, k.channel)
          .find(x => Math.abs(x.time - k.time) < 1e-6)?.curve || 'ease';
  } else if (k && k.bone !== undefined) c = keyCurve(k.bone, k.time);
  else if (k && k.tint !== undefined) {
    c = Rig.tintKeys(anim.name, k.tint)
          .find(x => Math.abs(x.time - k.time) < 1e-6)?.curve || 'ease';
  }
  for (const b of document.querySelectorAll('#curvebar button')) {
    b.classList.toggle('active', b.dataset.curve === c);
  }
}

// ---- key clipboard & explicit keying ----

function copyKey() {
  if (!anim.selectedKey) return status('select a key first');
  const ch = curAnim()?.bones[anim.selectedKey.bone];
  if (!ch) return;
  const channels = {};
  for (const [cname, keys] of Object.entries(ch)) {
    const k = keys?.find(k => Math.abs(k.time - anim.selectedKey.time) < 1e-6);
    if (k) channels[cname] = { ...k };
  }
  if (!Object.keys(channels).length) return;
  anim.clipboard = { bone: anim.selectedKey.bone, channels };
  status(`copied key — ${anim.selectedKey.bone} @ ${anim.selectedKey.time.toFixed(2)}s`);
}

function pasteKey() {
  if (!anim.clipboard) return status('nothing copied');
  const t = anim.time;
  Rig.pushUndo(doc.layers);
  for (const [cname, k] of Object.entries(anim.clipboard.channels)) {
    const { time, curve, ...values } = k;
    const nk = Rig.keyAt(anim.name, anim.clipboard.bone, cname, t, values);
    nk.curve = curve || 'ease';
  }
  anim.selectedKey = { bone: anim.clipboard.bone, time: t };
  updatePose();
  render();
  renderTimeline();
  status(`pasted key @ ${t.toFixed(2)}s`);
}

// Key the selected bone's current pose at the playhead (no nudge needed).
function insertKey() {
  if (anim.mode !== 'animate') return;
  const i = doc.selectedBone;
  if (i < 0) return status('select a bone to key');
  const b = Rig.bones[i];
  const cur = Rig.current(i);
  const t = anim.time;
  Rig.pushUndo(doc.layers);
  const wrap = d => { d %= 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  Rig.keyAt(anim.name, b.name, 'rotate', t, { value: wrap(cur.rotation - b.rotation) });
  Rig.keyAt(anim.name, b.name, 'translate', t, { x: cur.x - b.x, y: cur.y - b.y });
  Rig.keyAt(anim.name, b.name, 'scale', t,
            { x: cur.scaleX / (b.scaleX || 1), y: cur.scaleY / (b.scaleY || 1) });
  anim.selectedKey = { bone: b.name, time: t };
  updatePose();
  render();
  renderTimeline();
  status(`keyed ${b.name} @ ${t.toFixed(2)}s`);
}

// ⌘/ctrl + wheel (or trackpad pinch) zooms the timeline around the cursor
$('tl-scroll').addEventListener('wheel', e => {
  if (!(e.metaKey || e.ctrlKey)) return;   // plain wheel keeps native scrolling
  e.preventDefault();
  const scroll = $('tl-scroll');
  const cursorX = e.clientX - scroll.getBoundingClientRect().left;
  const t = (scroll.scrollLeft + cursorX - TL_LABEL_W) / PX_PER_SEC;
  PX_PER_SEC = Math.max(40, Math.min(800, PX_PER_SEC * Math.exp(-e.deltaY * 0.002)));
  localStorage.setItem('tlZoom', PX_PER_SEC);
  renderTimeline();
  scroll.scrollLeft = Math.max(0, t * PX_PER_SEC + TL_LABEL_W - cursorX);
}, { passive: false });

// scrub on ruler
function scrubX(e) {
  const scrollLeft = $('tl-scroll').scrollLeft;
  return e.clientX - $('tl-scroll').getBoundingClientRect().left + scrollLeft - TL_LABEL_W;
}
$('tl-ruler').addEventListener('mousedown', e => {
  setTime(magnetT(Math.max(0, scrubX(e)) / PX_PER_SEC));
  drag = { kind: 'scrub' };
});

// box-select: drag on empty track space; shift adds to the selection
$('tl-tracks').addEventListener('mousedown', e => {
  if (anim.mode !== 'animate' || !e.target.classList.contains('tl-track')) return;
  if (!e.shiftKey) clearMultiSel();
  const box = document.createElement('div');
  box.id = 'tl-marquee';
  $('tl-inner').appendChild(box);
  // remember what was already selected so shift-marquee only ever adds
  const keep = new Set(anim.multiSel.map(selId));
  drag = { kind: 'marquee', el: box, x0: e.clientX, y0: e.clientY, keep };
  e.preventDefault();
});

// timeline height resize
$('tl-resize').addEventListener('mousedown', e => {
  drag = { kind: 'tlresize', y0: e.clientY, h0: $('tl-body').offsetHeight };
  $('tl-resize').classList.add('dragging');
  e.preventDefault();
});

// undo is captured on the first actual move, not on mousedown — merely
// selecting a key must not dirty the project or grow the undo stack
function dragUndo() {
  if (drag && !drag.undone) { Rig.pushUndo(doc.layers); drag.undone = true; }
}

window.addEventListener('mousemove', e => {
  if (!drag) return;
  if (drag.kind === 'scrub') {
    setTime(magnetT(Math.max(0, scrubX(e)) / PX_PER_SEC));
  } else if (drag.kind === 'marquee') {
    const x1 = Math.min(drag.x0, e.clientX), x2 = Math.max(drag.x0, e.clientX);
    const y1 = Math.min(drag.y0, e.clientY), y2 = Math.max(drag.y0, e.clientY);
    const ir = $('tl-inner').getBoundingClientRect();
    Object.assign(drag.el.style, { left: x1 - ir.left + 'px', top: y1 - ir.top + 'px',
                                   width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
    for (const el of document.querySelectorAll('#tl-tracks .key, #tl-tracks .vkey, #tl-tracks .tkey, #tl-tracks .evt')) {
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const hit = cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
      el.classList.toggle('msel', hit || drag.keep.has(selId(descOfEl(el))));
    }
  } else if (drag.kind === 'multikey') {
    const nt = magnetT(drag.from + (e.clientX - drag.x0) / PX_PER_SEC, drag.cur);
    const dt = nt - drag.cur;
    // all-or-nothing: a blocked step just holds the set where it is
    if (dt && Rig.nudgeKeys(anim.name, anim.multiSel, dt, dragUndo)) {
      drag.cur = nt;
      for (const s of anim.multiSel) s.time = Math.max(0, s.time + dt);
      anim.selectedKey = null;
      anim.selectedEvent = null;
      updatePose();
      render();
      renderTimeline();   // safe mid-drag: this drag holds no element refs
    }
  } else if (drag.kind === 'tlresize') {
    const h = Math.max(60, Math.min(window.innerHeight * 0.6, drag.h0 + drag.y0 - e.clientY));
    $('tl-body').style.height = h + 'px';
    localStorage.setItem('tlHeight', h);
    render();   // stage canvas reflows as the timeline grows/shrinks
  } else if (drag.kind === 'event') {
    const nt = magnetT(drag.from + (e.clientX - drag.x0) / PX_PER_SEC, drag.cur);
    if (nt !== drag.cur) {
      dragUndo();
      drag.idx = Rig.moveEvent(anim.name, drag.idx, nt);
      drag.cur = nt;
      drag.el.style.left = nt * PX_PER_SEC + 'px';
      anim.selectedEvent = drag.idx;
    }
  } else if (drag.kind === 'chkey') {
    const nt = magnetT(drag.from + (e.clientX - drag.x0) / PX_PER_SEC, drag.cur);
    if (nt !== drag.cur) {
      const occupied = Rig.channelKeys(anim.name, drag.bone, drag.channel)
        .some(k => Math.abs(k.time - nt) < 1e-6 && Math.abs(k.time - drag.cur) > 1e-6);
      if (!occupied) {
        dragUndo();
        const old = drag.cur;
        Rig.moveChannelKey(anim.name, drag.bone, drag.channel, old, nt);
        // if this channel was the only one keyed there, the bone's summary
        // diamond follows live instead of lagging behind until mouseup
        if (!Rig.keyTimes(anim.name, drag.bone).some(t2 => Math.abs(t2 - old) < 1e-6))
          for (const h of document.querySelectorAll('#tl-tracks .key:not(.subkey)'))
            if (h.dataset.bone === drag.bone && Math.abs(+h.dataset.time - old) < 1e-6) {
              h.style.left = nt * PX_PER_SEC + 'px';
              h.dataset.time = nt;
            }
        drag.cur = nt;
        drag.el.style.left = nt * PX_PER_SEC + 'px';
        anim.selectedKey = { bone: drag.bone, channel: drag.channel, time: nt };
        updatePose();
        render();
      }
    }
  } else if (drag.kind === 'tintkey') {
    const nt = magnetT(drag.from + (e.clientX - drag.x0) / PX_PER_SEC, drag.cur);
    if (nt !== drag.cur) {
      const occupied = Rig.tintKeys(anim.name, drag.src)
        .some(k => Math.abs(k.time - nt) < 1e-6 && Math.abs(k.time - drag.cur) > 1e-6);
      if (!occupied) {
        dragUndo();
        Rig.moveTintKey(anim.name, drag.src, drag.cur, nt);
        drag.cur = nt;
        drag.el.style.left = nt * PX_PER_SEC + 'px';
        anim.selectedKey = { tint: drag.src, time: nt };
        render();
      }
    }
  } else if (drag.kind === 'showkey') {
    const nt = magnetT(drag.from + (e.clientX - drag.x0) / PX_PER_SEC, drag.cur);
    if (nt !== drag.cur) {
      const occupied = Rig.showKeys(anim.name, drag.src)
        .some(k => Math.abs(k.time - nt) < 1e-6 && Math.abs(k.time - drag.cur) > 1e-6);
      if (!occupied) {
        dragUndo();
        Rig.moveShowKey(anim.name, drag.src, drag.cur, nt);
        drag.cur = nt;
        drag.el.style.left = nt * PX_PER_SEC + 'px';
        anim.selectedKey = { show: drag.src, time: nt };
        render();
        renderLayerList();
      }
    }
  } else if (drag.kind === 'key') {
    const dt = (e.clientX - drag.x0) / PX_PER_SEC;
    const nt = magnetT(drag.from + dt, drag.cur);
    if (nt !== drag.cur) {
      // never slide onto (and clobber) another key — park next to it instead
      const occupied = Rig.keyTimes(anim.name, drag.bone)
        .some(t2 => Math.abs(t2 - nt) < 1e-6 && Math.abs(t2 - drag.cur) > 1e-6);
      if (!occupied) {
        dragUndo();
        const old = drag.cur;
        Rig.moveKeys(anim.name, drag.bone, old, nt);
        // expanded channel rows follow live instead of lagging until mouseup
        for (const s of document.querySelectorAll('#tl-tracks .subkey'))
          if (s.dataset.bone === drag.bone && Math.abs(+s.dataset.time - old) < 1e-6) {
            s.style.left = nt * PX_PER_SEC + 'px';
            s.dataset.time = nt;
          }
        drag.cur = nt;
        drag.el.style.left = nt * PX_PER_SEC + 'px';
        drag.el.dataset.time = nt;
        drag.el.title = `${drag.bone} @ ${nt.toFixed(2)}s`;
        anim.selectedKey = { bone: drag.bone, time: nt };
        updatePose();
        render();
      }
    }
  }
});

window.addEventListener('mouseup', () => {
  if (drag && ['key', 'chkey', 'event', 'showkey', 'tintkey', 'multikey'].includes(drag.kind)) renderTimeline();
  if (drag && drag.kind === 'marquee') {
    // selection = every highlighted element, read back from the DOM
    anim.multiSel = [...document.querySelectorAll('#tl-tracks .msel')].map(descOfEl);
    if (anim.multiSel.length) {
      anim.selectedKey = null;
      anim.selectedEvent = null;
      status(`${anim.multiSel.length} keys selected — drag any to move together, ⌫ deletes`);
    }
    drag.el.remove();
  }
  if (drag && drag.kind === 'tlresize') $('tl-resize').classList.remove('dragging');
  drag = null;
});

function addEventMarker(time) {
  if (anim.mode !== 'animate') return;
  const name = prompt('Event name (e.g. fire, stomp, step):');
  if (!name) return;
  Rig.pushUndo(doc.layers);
  anim.selectedEvent = Rig.addEvent(anim.name, time, name.trim());
  anim.selectedKey = null;
  renderTimeline();
  status(`event "${name.trim()}" @ ${time.toFixed(2)}s`);
}
$('evtbtn').onclick = () => addEventMarker(anim.time);

// restore persisted timeline height
{
  const h = +localStorage.getItem('tlHeight');
  if (h >= 60) $('tl-body').style.height = h + 'px';
}

// playback
function play(on) {
  anim.playing = on ?? !anim.playing;
  $('playbtn').textContent = anim.playing ? '❚❚' : '▶';
  if (anim.playing) {
    anim.lastTick = performance.now();
    cancelAnimationFrame(anim.raf);
    const tick = now => {
      if (!anim.playing) return;
      const dt = (now - anim.lastTick) / 1000;
      anim.lastTick = now;
      const d = curAnim()?.duration || 2;
      anim.time = (anim.time + dt) % d;
      updatePose();
      updatePlayhead();
      render();
      anim.raf = requestAnimationFrame(tick);
    };
    anim.raf = requestAnimationFrame(tick);
  }
}

$('modebtn').onclick = () => setMode(anim.mode === 'animate' ? 'setup' : 'animate');
$('playbtn').onclick = () => anim.mode === 'animate' && play();
$('keybtn').onclick = insertKey;
$('animsel').onchange = e => {
  anim.name = e.target.value;
  anim.time = 0;
  anim.selectedKey = null;
  anim.selectedEvent = null;
  anim.multiSel = [];
  updatePose();
  refresh();
};
$('animnew').onclick = () => {
  const name = prompt('Animation name:', 'anim' + (Object.keys(Rig.anims).length + 1));
  if (!name) return;
  Rig.pushUndo(doc.layers);
  Rig.ensureAnim(name);
  anim.name = name;
  anim.time = 0;
  if (anim.mode !== 'animate') anim.mode = 'animate';
  updatePose();
  refresh();
};
$('animrename').onclick = () => {
  if (!anim.name || anim.mode !== 'animate') return status('enter animate mode first');
  const raw = prompt('Rename animation:', anim.name);
  if (!raw) return;
  const name = raw.trim();
  if (!name || name === anim.name) return;
  if (Rig.anims[name]) return status(`animation "${name}" already exists`);
  Rig.pushUndo(doc.layers);
  Rig.renameAnim(anim.name, name);
  anim.name = name;
  refresh();
  status(`renamed to "${name}"`);
};

$('animdelete').onclick = () => {
  if (!anim.name || anim.mode !== 'animate') return status('enter animate mode first');
  if (Object.keys(Rig.anims).length <= 1) {
    return status('cannot delete the only animation — rename it instead (✎)');
  }
  if (!confirm(`Delete animation "${anim.name}"? (undoable with ⌘Z)`)) return;
  Rig.pushUndo(doc.layers);
  Rig.deleteAnim(anim.name);
  anim.name = Object.keys(Rig.anims)[0];
  anim.time = 0;
  anim.selectedKey = null;
  anim.selectedEvent = null;
  updatePose();
  refresh();
  status(`deleted — now editing "${anim.name}"`);
};

$('durinput').onchange = e => {
  const a = curAnim();
  if (!a) return;
  let last = 0;
  // every key kind holds the duration open — bones, events, tints, visibility
  for (const t of animKeyTimes()) last = Math.max(last, t);
  a.duration = Math.max(+e.target.value || 2, last, 0.1);
  markDirty();
  renderTimeline();
};
for (const b of document.querySelectorAll('#curvebar button')) {
  b.onclick = () => {
    if (anim.multiSel.length) {   // apply to the whole multi-selection
      Rig.pushUndo(doc.layers);
      for (const s of anim.multiSel) {
        if (s.kind === 'bone') Rig.setKeyCurve(anim.name, s.bone, s.time, b.dataset.curve);
        else if (s.kind === 'chan') Rig.setChannelCurve(anim.name, s.bone, s.channel, s.time, b.dataset.curve);
        else if (s.kind === 'tint') Rig.setTintCurve(anim.name, s.src, s.time, b.dataset.curve);
      }
      updatePose();
      render();
      renderTimeline();
      return;
    }
    const k = anim.selectedKey;
    if (!k) return status('select a key first');
    Rig.pushUndo(doc.layers);
    if (k.tint !== undefined) Rig.setTintCurve(anim.name, k.tint, k.time, b.dataset.curve);
    else if (k.show !== undefined) return status('visibility keys are always stepped');
    else if (k.channel) Rig.setChannelCurve(anim.name, k.bone, k.channel, k.time, b.dataset.curve);
    else Rig.setKeyCurve(anim.name, k.bone, k.time, b.dataset.curve);
    updatePose();
    render();
    renderTimeline();
  };
}

// ------------------------------------------------------------- projects

function sanitizeProjectName(s) {
  return s.toLowerCase().replace(/\.(psd|psb)$/, '')
          .replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
          .slice(0, 64) || 'untitled';
}

function updateProjectUI() {
  $('projlabel').textContent = project.name ? '· ' + project.name : '';
  document.title = project.name ? `${project.name} — NomadOS Rig Animator` : 'NomadOS Rig Animator';
  const sel = $('projsel');
  if ([...sel.options].some(o => o.value === project.name)) sel.value = project.name;
  else sel.value = '';
  if (project.name) {
    const url = new URL(location);
    url.searchParams.set('project', project.name);
    history.replaceState(null, '', url);
    localStorage.setItem('lastProject', project.name);
  }
}

async function refreshProjectList() {
  const list = await (await fetch('/api/projects')).json();
  const sel = $('projsel');
  sel.innerHTML = '<option value="">— projects —</option>';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = o.textContent = p.name;
    sel.appendChild(o);
  }
  if (project.name) sel.value = project.name;
  return list;
}

async function saveProject(force) {
  if (!project.name) return status('no project — create one first');
  if (!lastPsb) return status('nothing to save — open a PSB first');
  const base = '/api/save/' + project.name + '/';
  await fetch(base + lastPsb.name, { method: 'POST', body: lastPsb.buffer });
  const data = {
    name: project.name,
    psb: lastPsb.name,
    doc: { name: doc.name, width: doc.width, height: doc.height },
    layers: doc.layers.map(l => ({ name: l.name, src: l.src, visible: l.visible, bone: l.bone,
                                   lx: l.lx, ly: l.ly, lrot: l.lrot, lsx: l.lsx, lsy: l.lsy,
                                   tint: l.tint || null, gen: l.gen || null,
                                   mesh: l.mesh || null })),
    rig: { bones: Rig.bones },
    anims: Rig.anims,
  };
  const headers = { 'X-Base-Mtime': String(project.mtime || 0) };
  if (force) headers['X-Force'] = '1';
  const res = await fetch(base + 'project.json', {
    method: 'POST', headers, body: JSON.stringify(data, null, 1),
  });
  const info = await res.json();
  if (res.status === 409) {
    // someone (another tab?) saved this project after we loaded it
    if (confirm(`"${project.name}" was saved by another tab after this one loaded it.\n\n` +
                `OK = overwrite with THIS tab's version\n` +
                `Cancel = keep the other save (then reload via the project menu to see it)`)) {
      return saveProject(true);
    }
    status('⚠ not saved — another tab\'s version kept. Re-open the project to load it.');
    return;
  }
  project.mtime = info.mtime || Math.floor(Date.now() / 1000);
  markClean();
  await refreshProjectList();
  updateProjectUI();
  status(`saved ${project.name} (${info.saved})`);
}

async function openProject(name) {
  const res = await fetch(`/projects/${name}/project.json?` + Date.now());
  if (!res.ok) return status(`project ${name} not found`);
  const data = await res.json();
  const psb = await fetch(`/projects/${name}/${data.psb}?` + Date.now());
  if (!psb.ok) return status(`${name}: missing ${data.psb}`);
  loadPsd(await psb.arrayBuffer(), data.psb, true);
  // Pair saved layer state with PSB layers BY NAME (nth duplicate matches
  // nth duplicate), never by position: loadPsd hands out positional srcs, so
  // a layer reorder in Photoshop between save and open would otherwise shift
  // every binding, tint and visibility onto the wrong layer. Same rule as
  // Refresh — this is its load-time half.
  {
    const key = (name, seen) => {
      const n = seen.get(name) || 0;
      seen.set(name, n + 1);
      return name + '␟' + n;
    };
    const seenSaved = new Map(), savedByKey = new Map();
    for (const pl of data.layers) if (!pl.gen) savedByKey.set(key(pl.name, seenSaved), pl);
    const seenFresh = new Map();
    let next = Math.max(0, ...data.layers.map(pl => pl.src).filter(s => s < 50000)) + 1;
    for (const l of doc.layers) {
      const pl = savedByKey.get(key(l.name, seenFresh));
      if (pl) {
        l.src = pl.src;
        l.visible = pl.visible;
        if (pl.tint) l.tint = pl.tint;
      } else {
        l.src = next++;   // layer added in Photoshop since the last save
      }
    }
  }
  regeneratePieces(data.layers);   // re-slice crumble pieces from the art
  // bindings for layers that no longer exist in the PSB are dropped, or
  // restore's positional fallback would smear them across the survivors
  const liveSrcs = new Set(doc.layers.map(l => l.src));
  Rig.restore(JSON.stringify({ bones: data.rig.bones, anims: data.anims || {},
    bindings: data.layers.filter(l => liveSrcs.has(l.src))
      .map(l => ({ src: l.src, bone: l.bone, lx: l.lx, ly: l.ly, lrot: l.lrot, lsx: l.lsx, lsy: l.lsy,
                   mesh: l.mesh || null })),
    nextId: data.rig.bones.length + 1 }), doc.layers);
  // layers added in Photoshop since the save have no binding yet — root them
  // at their painted position (bones are restored, so root is current)
  for (const l of doc.layers) if (l.bone === undefined) Rig.bindInitial(l, l);
  project.name = name;
  anim.name = Object.keys(Rig.anims)[0] || null;
  anim.mode = 'setup';
  anim.time = 0;
  Rig.clearUndo();
  // record what we loaded so a stale save gets caught, and start clean
  const list = await (await fetch('/api/projects')).json();
  project.mtime = list.find(p => p.name === name)?.modified || 0;
  markClean();
  updatePose();
  refresh();
  updateProjectUI();
  status(`opened ${name}`);
}

function newProject() {
  const raw = prompt('Project name (use the game enemy id, e.g. "runner"):');
  if (!raw) return;
  const name = sanitizeProjectName(raw);
  if ([...$('projsel').options].some(o => o.value === name)) {
    return status(`project "${name}" already exists — pick it from the list`);
  }
  project.name = name;
  project.mtime = 0;
  doc.layers = [];
  doc.name = null;
  doc.selected = -1;
  doc.selectedBone = -1;
  lastPsb = null;
  Rig.init(1, 1);
  Rig.clearUndo();
  markClean();
  anim.name = null;
  anim.mode = 'setup';
  $('empty').style.display = 'flex';
  updatePose();
  refresh();
  updateProjectUI();
  status(`new project "${name}" — open a .psd/.psb to begin, then Save`);
}

$('projsave').onclick = saveProject;
$('projnew').onclick = newProject;
$('projsel').onchange = async e => {
  const name = e.target.value;
  if (!name || name === project.name) return;
  if (doc.layers.length && !confirm(`Open "${name}"? Unsaved changes to "${project.name || 'current work'}" are lost.`)) {
    e.target.value = project.name || '';
    return;
  }
  await openProject(name);
};

async function init() {
  const list = await refreshProjectList();
  const want = new URLSearchParams(location.search).get('project') ||
               localStorage.getItem('lastProject');
  if (want && list.some(p => p.name === want)) await openProject(want);
  else if (list.length === 1) await openProject(list[0].name);
  else status(list.length ? 'pick a project or create one' : 'create a project to begin');
}
init();

$('exportbtn').onclick = async () => {
  if (!doc.layers.length) return status('nothing to export');
  if (!project.name) return status('save as a project first');
  try {
    status('exporting…');
    const r = await Exporter.exportAll(doc, doc.layers, project.name);
    status(`exported ${r.slots} slots, ${r.anims} anims, atlas ${r.tex} · validating…`);
    const anims = await Exporter.validate(project.name);
    status(`export ok — validated (${anims.length} animation${anims.length === 1 ? '' : 's'}) → projects/${project.name}/export/`);
  } catch (e) {
    status('export failed: ' + e.message);
    console.error(e);
  }
};

// ------------------------------------------------------------- file open

$('file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!project.name) {   // opening art without a project starts one
    project.name = sanitizeProjectName(f.name);
  }
  loadPsd(await f.arrayBuffer(), f.name);
  markDirty();
  updateProjectUI();
  status(`${f.name} loaded into project "${project.name}" — Save to persist`);
});
$('refreshfile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!doc.layers.length) return status('open a file or project first — refresh merges into it');
  refreshPsb(await f.arrayBuffer(), f.name);
  e.target.value = '';
});
const wrap = $('stagewrap');
wrap.addEventListener('dragover', e => { e.preventDefault(); $('drop').style.display = 'flex'; });
wrap.addEventListener('dragleave', () => $('drop').style.display = 'none');
wrap.addEventListener('drop', async e => {
  e.preventDefault();
  $('drop').style.display = 'none';
  const f = e.dataTransfer.files[0];
  if (f && /\.(psd|psb)$/i.test(f.name)) loadPsd(await f.arrayBuffer(), f.name);
});

// every undoable mutation marks the project dirty
{
  const wrap = fn => (...a) => { markDirty(); return fn(...a); };
  Rig.pushUndo = wrap(Rig.pushUndo);
  Rig.undo = wrap(Rig.undo);
  Rig.redo = wrap(Rig.redo);
}

setTool('select');
