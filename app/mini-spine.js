/*
 * mini-spine.js — a from-scratch, dependency-free renderer for Spine 4.0 JSON
 * skeletons on Canvas 2D. No Esoteric Software code; written from the public
 * JSON/atlas format documentation and first principles.
 *
 * Supported: bones (rotate/translate/scale/shear), region + mesh attachments,
 * weighted meshes, deform timelines, slot color/attachment/draw-order
 * timelines, bezier/stepped/linear curves, IK constraints (1 and 2 bone),
 * clipping polygons, additive/multiply/screen blends, premultiplied atlases,
 * atlas rotation/whitespace-stripping.
 *
 * Not supported (rare in this data set): transform/path constraints, linked
 * meshes, two-color tint, events, audio.
 */
'use strict';
const MiniSpine = (() => {

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- utilities

function wrap180(deg) {
  deg %= 360;
  if (deg > 180) deg -= 360;
  if (deg < -180) deg += 360;
  return deg;
}

function parseColor(hex) {
  const v = parseInt(hex, 16);
  return hex.length === 8
    ? [(v >>> 24) / 255, (v >>> 16 & 255) / 255, (v >>> 8 & 255) / 255, (v & 255) / 255]
    : [(v >>> 16) / 255, (v >>> 8 & 255) / 255, (v & 255) / 255, 1];
}

// Cubic bezier in (time, value) space; x is monotonic so bisect on it.
function bezier(time, t1, v1, cx1, cy1, cx2, cy2, t2, v2) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) {
    const s = (lo + hi) / 2, u = 1 - s;
    const x = u * u * u * t1 + 3 * u * u * s * cx1 + 3 * u * s * s * cx2 + s * s * s * t2;
    if (x < time) lo = s; else hi = s;
  }
  const s = (lo + hi) / 2, u = 1 - s;
  return u * u * u * v1 + 3 * u * u * s * cy1 + 3 * u * s * s * cy2 + s * s * s * v2;
}

// Sample one component of a keyframe timeline at `time`.
// `get(key)` extracts the component's value, `comp` picks the curve segment
// (multi-component keys store 4 bezier numbers per component).
function sample(keys, time, get, comp) {
  const first = keys[0];
  if (time <= (first.time || 0)) return get(first);
  let i = keys.length - 1;
  for (let j = 1; j < keys.length; j++) {
    if ((keys[j].time || 0) > time) { i = j - 1; break; }
  }
  const k = keys[i];
  if (i === keys.length - 1) return get(k);
  const k2 = keys[i + 1];
  const t1 = k.time || 0, t2 = k2.time || 0;
  const v1 = get(k), v2 = get(k2);
  if (k.curve === 'stepped') return v1;
  if (Array.isArray(k.curve)) {
    const o = comp * 4;
    return bezier(time, t1, v1, k.curve[o], k.curve[o + 1], k.curve[o + 2], k.curve[o + 3], t2, v2);
  }
  return v1 + (v2 - v1) * (time - t1) / (t2 - t1 || 1e-9);
}

// Last key at or before `time` (for stepped-by-nature timelines).
function lastKey(keys, time) {
  let k = null;
  for (const key of keys) {
    if ((key.time || 0) <= time) k = key; else break;
  }
  return k;
}

// ------------------------------------------------------------------- atlas

// Parses the libgdx/Spine .atlas text format and slices every region into its
// own straight (un-rotated, whitespace-restored) canvas so the renderer can
// treat uv (0,0)-(1,1) as the full original art rect.
async function loadAtlas(url) {
  const text = await (await fetch(url)).text();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const pages = [];
  let page = null, entry = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { page = null; continue; }
    const colon = line.indexOf(':');
    if (colon === -1) {
      if (!page) {
        page = { name: line, pma: false, regions: [] };
        pages.push(page);
        entry = page;
      } else {
        entry = { name: line, x: 0, y: 0, w: 0, h: 0, ox: 0, oy: 0, ow: 0, oh: 0, rotate: 0 };
        page.regions.push(entry);
      }
      continue;
    }
    const key = line.slice(0, colon).trim();
    const vals = line.slice(colon + 1).split(',').map(s => s.trim());
    if (key === 'bounds') [entry.x, entry.y, entry.w, entry.h] = vals.map(Number);
    else if (key === 'offsets') [entry.ox, entry.oy, entry.ow, entry.oh] = vals.map(Number);
    else if (key === 'rotate') entry.rotate = vals[0] === 'true' ? 90 : Number(vals[0]) || 0;
    else if (key === 'pma') entry.pma = vals[0] === 'true';
  }

  const regions = {};
  for (const p of pages) {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('texture load failed: ' + p.name));
      i.src = base + p.name;
    });

    // Un-premultiply once so Canvas 2D's straight-alpha blending is correct.
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = img.width;
    pageCanvas.height = img.height;
    const pctx = pageCanvas.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(img, 0, 0);
    if (p.pma) {
      const id = pctx.getImageData(0, 0, img.width, img.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a > 0 && a < 255) {
          d[i] = Math.min(255, d[i] * 255 / a);
          d[i + 1] = Math.min(255, d[i + 1] * 255 / a);
          d[i + 2] = Math.min(255, d[i + 2] * 255 / a);
        }
      }
      pctx.putImageData(id, 0, 0);
    }

    for (const r of p.regions) {
      const ow = r.ow || r.w, oh = r.oh || r.h;
      const c = document.createElement('canvas');
      c.width = Math.max(1, ow);
      c.height = Math.max(1, oh);
      const ctx = c.getContext('2d');
      // Atlas offsets are measured from the bottom-left of the original art.
      const dx = r.ox, dy = oh - r.oy - r.h;
      if (r.rotate === 90) {
        // Region pixels are stored rotated 90° CCW in the page (occupying h×w);
        // rotate them back clockwise.
        ctx.translate(dx, dy);
        ctx.translate(r.w, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(pageCanvas, r.x, r.y, r.h, r.w, 0, 0, r.h, r.w);
      } else {
        ctx.drawImage(pageCanvas, r.x, r.y, r.w, r.h, dx, dy, r.w, r.h);
      }
      regions[r.name] = c;
    }
  }
  return regions;
}

// ---------------------------------------------------------- skeleton data

function parseVertices(raw, uvCount) {
  if (raw.length === uvCount) return { weighted: false, verts: raw };
  // Weighted: [boneCount, (boneIndex, bindX, bindY, weight) * boneCount, ...]
  const influences = [];
  for (let i = 0; i < raw.length;) {
    const n = raw[i++];
    const inf = [];
    for (let j = 0; j < n; j++, i += 4) {
      inf.push({ bone: raw[i], x: raw[i + 1], y: raw[i + 2], w: raw[i + 3] });
    }
    influences.push(inf);
  }
  return { weighted: true, influences };
}

function parseSkeleton(json, regions) {
  const bones = json.bones.map((b, i) => ({
    index: i, name: b.name,
    parent: b.parent != null ? json.bones.findIndex(p => p.name === b.parent) : -1,
    length: b.length || 0, transform: b.transform || 'normal',
    x: b.x || 0, y: b.y || 0, rotation: b.rotation || 0,
    scaleX: b.scaleX ?? 1, scaleY: b.scaleY ?? 1,
    shearX: b.shearX || 0, shearY: b.shearY || 0,
  }));
  const boneIndex = Object.fromEntries(bones.map(b => [b.name, b.index]));

  const slots = (json.slots || []).map((s, i) => ({
    index: i, name: s.name, bone: boneIndex[s.bone],
    color: s.color ? parseColor(s.color) : [1, 1, 1, 1],
    blend: s.blend || 'normal', attachment: s.attachment || null,
  }));
  const slotIndex = Object.fromEntries(slots.map(s => [s.name, s.index]));

  // Merge every skin (default + named equipment skins) into one lookup.
  const attachments = {};   // slotIndex -> attName -> parsed attachment
  for (const skin of json.skins || []) {
    for (const [slotName, atts] of Object.entries(skin.attachments || {})) {
      const si = slotIndex[slotName];
      if (si == null) continue;
      attachments[si] = attachments[si] || {};
      for (const [attName, a] of Object.entries(atts)) {
        const type = a.type || 'region';
        const parsed = { type, name: attName, color: a.color ? parseColor(a.color) : null };
        if (type === 'region') {
          Object.assign(parsed, {
            x: a.x || 0, y: a.y || 0, rotation: a.rotation || 0,
            scaleX: a.scaleX ?? 1, scaleY: a.scaleY ?? 1,
            width: a.width || 0, height: a.height || 0,
            texture: regions[a.path || attName],
          });
        } else if (type === 'mesh') {
          Object.assign(parsed, {
            uvs: a.uvs, triangles: a.triangles,
            texture: regions[a.path || attName],
          }, parseVertices(a.vertices, a.uvs.length));
        } else if (type === 'clipping') {
          Object.assign(parsed, { endSlot: slotIndex[a.end], vertexCount: a.vertexCount },
            parseVertices(a.vertices, (a.vertexCount || 0) * 2));
        }
        attachments[si][attName] = parsed;
      }
    }
  }

  const iks = (json.ik || []).map(c => ({
    name: c.name, order: c.order || 0,
    bones: c.bones.map(n => boneIndex[n]), target: boneIndex[c.target],
    mix: c.mix ?? 1, bendPositive: c.bendPositive !== false,
  })).sort((a, b) => a.order - b.order);

  return { bones, slots, attachments, iks, animations: json.animations || {}, boneIndex, slotIndex };
}

// -------------------------------------------------------------- runtime

class Skeleton {
  constructor(data) {
    this.data = data;
    this.bones = data.bones.map(b => ({ data: b, children: [], a: 1, b: 0, c: 0, d: 1, wx: 0, wy: 0 }));
    for (const b of this.bones) {
      if (b.data.parent >= 0) this.bones[b.data.parent].children.push(b);
    }
    this.slots = data.slots.map(s => ({ data: s }));
    this.setToSetup();
  }

  setToSetup() {
    for (const b of this.bones) {
      const d = b.data;
      b.x = d.x; b.y = d.y; b.rotation = d.rotation;
      b.scaleX = d.scaleX; b.scaleY = d.scaleY;
      b.shearX = d.shearX; b.shearY = d.shearY;
    }
    for (const s of this.slots) {
      s.color = s.data.color.slice();
      s.attachment = s.data.attachment;
      s.deform = null;
    }
    this.ikMix = this.data.iks.map(c => ({ mix: c.mix, bendPositive: c.bendPositive }));
    this.drawOrder = this.slots.map((_, i) => i);
  }

  // Set the pose from an animation at `time` (loops are the caller's job).
  apply(animName, time) {
    this.setToSetup();
    const anim = this.data.animations[animName];
    if (!anim) return;

    for (const [name, tls] of Object.entries(anim.bones || {})) {
      const b = this.bones[this.data.boneIndex[name]];
      if (!b) continue;
      if (tls.rotate) b.rotation += sample(tls.rotate, time, k => k.value || 0, 0);
      if (tls.translate) {
        b.x += sample(tls.translate, time, k => k.x || 0, 0);
        b.y += sample(tls.translate, time, k => k.y || 0, 1);
      }
      if (tls.scale) {
        b.scaleX *= sample(tls.scale, time, k => k.x ?? 1, 0);
        b.scaleY *= sample(tls.scale, time, k => k.y ?? 1, 1);
      }
      if (tls.shear) {
        b.shearX += sample(tls.shear, time, k => k.x || 0, 0);
        b.shearY += sample(tls.shear, time, k => k.y || 0, 1);
      }
    }

    for (const [name, tls] of Object.entries(anim.slots || {})) {
      const s = this.slots[this.data.slotIndex[name]];
      if (!s) continue;
      if (tls.attachment) {
        const k = lastKey(tls.attachment, time);
        if (k) s.attachment = k.name || null;
      }
      if (tls.rgba) {
        for (let c = 0; c < 4; c++) {
          s.color[c] = sample(tls.rgba, time, k => parseColor(k.color)[c], c);
        }
      }
      if (tls.rgb) {
        for (let c = 0; c < 3; c++) {
          s.color[c] = sample(tls.rgb, time, k => parseColor(k.color)[c], c);
        }
      }
      if (tls.alpha) s.color[3] = sample(tls.alpha, time, k => k.value ?? 1, 0);
    }

    // Deform: vertex offsets, interpolated between keys.
    for (const skinDeforms of Object.values(anim.deform || {})) {
      for (const [slotName, atts] of Object.entries(skinDeforms)) {
        const s = this.slots[this.data.slotIndex[slotName]];
        if (!s) continue;
        for (const [attName, keys] of Object.entries(atts)) {
          if (s.attachment !== attName) continue;
          s.deform = this.sampleDeform(keys, time);
        }
      }
    }

    if (anim.ik) {
      for (const [name, keys] of Object.entries(anim.ik)) {
        const ci = this.data.iks.findIndex(c => c.name === name);
        if (ci < 0) continue;
        const k = lastKey(keys, time);
        if (k) {
          this.ikMix[ci].mix = sample(keys, time, kk => kk.mix ?? 1, 0);
          this.ikMix[ci].bendPositive = k.bendPositive !== false;
        }
      }
    }

    if (anim.drawOrder || anim.draworder) {
      const k = lastKey(anim.drawOrder || anim.draworder, time);
      const order = this.slots.map((_, i) => i);
      if (k && k.offsets) {
        const n = this.slots.length;
        const out = new Array(n).fill(-1);
        const unchanged = [];
        const moved = new Set(k.offsets.map(o => this.data.slotIndex[o.slot]));
        for (const o of k.offsets) {
          const si = this.data.slotIndex[o.slot];
          out[si + o.offset] = si;
        }
        for (let i = 0; i < n; i++) if (!moved.has(i)) unchanged.push(i);
        let u = 0;
        for (let i = 0; i < n; i++) if (out[i] === -1) out[i] = unchanged[u++];
        this.drawOrder = out;
      } else {
        this.drawOrder = order;
      }
    }

    this.updateWorldTransform();
  }

  sampleDeform(keys, time) {
    const k = lastKey(keys, time);
    if (!k) return null;
    const i = keys.indexOf(k);
    const k2 = keys[i + 1];
    const expand = key => {
      const v = key.vertices || [];
      const off = key.offset || 0;
      return { v, off };
    };
    const a = expand(k);
    if (!k2 || k.curve === 'stepped') return a;
    const t1 = k.time || 0, t2 = k2.time || 0;
    let f = (time - t1) / (t2 - t1 || 1e-9);
    if (Array.isArray(k.curve)) {
      f = bezier(time, t1, 0, k.curve[0], k.curve[1], k.curve[2], k.curve[3], t2, 1);
    }
    const b = expand(k2);
    const len = Math.max(a.off + a.v.length, b.off + b.v.length);
    const v = new Float32Array(len);
    for (let j = 0; j < len; j++) {
      const av = j >= a.off && j - a.off < a.v.length ? a.v[j - a.off] : 0;
      const bv = j >= b.off && j - b.off < b.v.length ? b.v[j - b.off] : 0;
      v[j] = av + (bv - av) * f;
    }
    return { v, off: 0 };
  }

  updateWorldTransform() {
    for (const b of this.bones) this.updateBone(b);
    for (let i = 0; i < this.data.iks.length; i++) {
      this.solveIK(this.data.iks[i], this.ikMix[i]);
    }
  }

  updateBone(b) {
    const d = b.data;
    const rx = (b.rotation + b.shearX) * DEG;
    const ry = (b.rotation + 90 + b.shearY) * DEG;
    let la = Math.cos(rx) * b.scaleX, lb = Math.cos(ry) * b.scaleY;
    let lc = Math.sin(rx) * b.scaleX, ld = Math.sin(ry) * b.scaleY;
    const p = d.parent >= 0 ? this.bones[d.parent] : null;
    if (!p) {
      b.a = la; b.b = lb; b.c = lc; b.d = ld;
      b.wx = b.x; b.wy = b.y;
      return;
    }
    b.wx = p.a * b.x + p.b * b.y + p.wx;
    b.wy = p.c * b.x + p.d * b.y + p.wy;
    if (d.transform === 'onlyTranslation') {
      b.a = la; b.b = lb; b.c = lc; b.d = ld;
    } else if (d.transform === 'noRotationOrReflection') {
      // keep parent scale magnitude, drop its rotation/reflection
      const psx = Math.hypot(p.a, p.c);
      const psy = Math.hypot(p.b, p.d);
      b.a = psx * la; b.b = psy * lb; b.c = psx * lc; b.d = psy * ld;
    } else {
      b.a = p.a * la + p.b * lc; b.b = p.a * lb + p.b * ld;
      b.c = p.c * la + p.d * lc; b.d = p.c * lb + p.d * ld;
    }
  }

  updateSubtree(b) {
    this.updateBone(b);
    for (const c of b.children) this.updateSubtree(c);
  }

  worldToLocal(b, wx, wy) {
    const det = b.a * b.d - b.b * b.c || 1e-9;
    const dx = wx - b.wx, dy = wy - b.wy;
    return [(dx * b.d - dy * b.b) / det, (dy * b.a - dx * b.c) / det];
  }

  // IK: rotate the chain's bones so the tip reaches the target.
  solveIK(c, state) {
    const mix = state.mix;
    if (mix <= 0) return;
    const target = this.bones[c.target];
    const tx = target.wx, ty = target.wy;

    if (c.bones.length === 1) {
      const b = this.bones[c.bones[0]];
      const p = b.data.parent >= 0 ? this.bones[b.data.parent] : null;
      const [lx, ly] = p ? this.worldToLocal(p, tx, ty) : [tx, ty];
      const desired = Math.atan2(ly - b.y, lx - b.x) / DEG;
      b.rotation += wrap180(desired - b.rotation) * mix;
      this.updateSubtree(b);
      return;
    }

    const P = this.bones[c.bones[0]];
    const C = this.bones[c.bones[1]];
    const pp = P.data.parent >= 0 ? this.bones[P.data.parent] : null;
    let [txl, tyl] = pp ? this.worldToLocal(pp, tx, ty) : [tx, ty];
    txl -= P.x; tyl -= P.y;

    const csx = Math.abs(P.scaleX) || 1;
    const alpha0 = Math.atan2(C.y, C.x);            // child offset angle in P's frame
    const l1 = Math.hypot(C.x, C.y) * 1;            // child origin distance (P-local units)
    const l2 = (C.data.length || l1 || 1) * (Math.abs(C.scaleX) || 1);
    // work in P-local units: convert target into P's scale
    const dist = Math.hypot(txl, tyl) / csx;
    const ta = Math.atan2(tyl, txl);

    let cos2 = (dist * dist - l1 * l1 - l2 * l2) / (2 * l1 * l2 || 1e-9);
    cos2 = Math.max(-1, Math.min(1, cos2));
    let t2 = Math.acos(cos2) * (state.bendPositive ? 1 : -1);
    const t1 = ta - Math.atan2(l2 * Math.sin(t2), l1 + l2 * Math.cos(t2));

    const pRot = (t1 - alpha0) / DEG;
    const cRot = (t2 + alpha0) / DEG;
    P.rotation += wrap180(pRot - P.rotation) * mix;
    C.rotation += wrap180(cRot - C.rotation) * mix;
    this.updateSubtree(P);
  }

  // World-space vertices for the slot's current attachment.
  vertices(slot) {
    const att = this.attachment(slot);
    if (!att) return null;
    if (att.type !== 'region' && att.type !== 'mesh' && att.type !== 'clipping') return null;
    const bone = this.bones[slot.data.bone];
    const dfm = slot.deform;

    if (att.type === 'region') {
      const rr = att.rotation * DEG;
      const cos = Math.cos(rr), sin = Math.sin(rr);
      const la = cos * att.scaleX, lb = -sin * att.scaleY;
      const lc = sin * att.scaleX, ld = cos * att.scaleY;
      const a = bone.a * la + bone.b * lc, b2 = bone.a * lb + bone.b * ld;
      const c = bone.c * la + bone.d * lc, d = bone.c * lb + bone.d * ld;
      const wx = bone.a * att.x + bone.b * att.y + bone.wx;
      const wy = bone.c * att.x + bone.d * att.y + bone.wy;
      const hw = att.width / 2, hh = att.height / 2;
      const out = new Float32Array(8);
      const corners = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
      for (let i = 0; i < 4; i++) {
        const x = corners[i * 2], y = corners[i * 2 + 1];
        out[i * 2] = a * x + b2 * y + wx;
        out[i * 2 + 1] = c * x + d * y + wy;
      }
      return out;
    }

    if (att.weighted) {
      const n = att.influences.length;
      const out = new Float32Array(n * 2);
      let di = 0;
      for (let i = 0; i < n; i++) {
        let x = 0, y = 0;
        for (const inf of att.influences[i]) {
          const ib = this.bones[inf.bone];
          let bx = inf.x, by = inf.y;
          if (dfm) {
            bx += (di >= dfm.off && di - dfm.off < dfm.v.length) ? dfm.v[di - dfm.off] : 0;
            by += (di + 1 >= dfm.off && di + 1 - dfm.off < dfm.v.length) ? dfm.v[di + 1 - dfm.off] : 0;
          }
          di += 2;
          x += (ib.a * bx + ib.b * by + ib.wx) * inf.w;
          y += (ib.c * bx + ib.d * by + ib.wy) * inf.w;
        }
        out[i * 2] = x; out[i * 2 + 1] = y;
      }
      return out;
    }

    const src = att.verts;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      let x = src[i], y = src[i + 1];
      if (dfm) {
        x += (i >= dfm.off && i - dfm.off < dfm.v.length) ? dfm.v[i - dfm.off] : 0;
        y += (i + 1 >= dfm.off && i + 1 - dfm.off < dfm.v.length) ? dfm.v[i + 1 - dfm.off] : 0;
      }
      out[i] = bone.a * x + bone.b * y + bone.wx;
      out[i + 1] = bone.c * x + bone.d * y + bone.wy;
    }
    return out;
  }

  attachment(slot) {
    if (!slot.attachment) return null;
    const atts = this.data.attachments[slot.data.index];
    return atts ? atts[slot.attachment] || null : null;
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const si of this.drawOrder) {
      const slot = this.slots[si];
      const att = this.attachment(slot);
      if (!att || att.type === 'clipping') continue;
      const v = this.vertices(slot);
      if (!v) continue;
      for (let i = 0; i < v.length; i += 2) {
        if (v[i] < x0) x0 = v[i];
        if (v[i] > x1) x1 = v[i];
        if (v[i + 1] < y0) y0 = v[i + 1];
        if (v[i + 1] > y1) y1 = v[i + 1];
      }
    }
    return x0 < x1 ? { x0, y0, x1, y1 } : { x0: -1, y0: -1, x1: 1, y1: 1 };
  }
}

// ------------------------------------------------------------- renderer

const BLEND = { normal: 'source-over', additive: 'lighter', multiply: 'multiply', screen: 'screen' };
const tintCache = new Map();

function tinted(texture, r, g, b) {
  if (r > 0.99 && g > 0.99 && b > 0.99) return texture;
  const key = texture._tintId || (texture._tintId = Math.random());
  const ck = key + '|' + ((r * 31) | 0) + ',' + ((g * 31) | 0) + ',' + ((b * 31) | 0);
  let c = tintCache.get(ck);
  if (!c) {
    c = document.createElement('canvas');
    c.width = texture.width; c.height = texture.height;
    const x = c.getContext('2d');
    x.drawImage(texture, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(texture, 0, 0);
    tintCache.set(ck, c);
  }
  return c;
}

function render(skeleton, ctx) {
  let clip = null;   // { path: Path2D, endSlot }
  for (const si of skeleton.drawOrder) {
    const slot = skeleton.slots[si];
    const att = skeleton.attachment(slot);
    if (!att) continue;

    if (att.type === 'clipping') {
      const v = skeleton.vertices(slot);
      const path = new Path2D();
      path.moveTo(v[0], v[1]);
      for (let i = 2; i < v.length; i += 2) path.lineTo(v[i], v[i + 1]);
      path.closePath();
      clip = { path, endSlot: att.endSlot };
      continue;
    }

    if (att.texture) {
      const color = slot.color;
      const ac = att.color || [1, 1, 1, 1];
      const alpha = color[3] * ac[3];
      if (alpha <= 0) continue;
      const tex = tinted(att.texture, color[0] * ac[0], color[1] * ac[1], color[2] * ac[2]);

      ctx.save();
      if (clip) ctx.clip(clip.path);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = BLEND[slot.data.blend] || 'source-over';

      const v = skeleton.vertices(slot);
      if (att.type === 'region') {
        // corners: 0=(-w/2,-h/2) 1=(w/2,-h/2) 3=(-w/2,h/2); texture rows go
        // top-down while spine y goes up, so the image's top-left lands on
        // corner 3.
        drawTriPair(ctx, tex, v);
      } else {
        const uvs = att.uvs, tw = tex.width, th = tex.height;
        const t = att.triangles;
        for (let i = 0; i < t.length; i += 3) {
          drawTexTriangle(ctx, tex,
            uvs[t[i] * 2] * tw, uvs[t[i] * 2 + 1] * th,
            uvs[t[i + 1] * 2] * tw, uvs[t[i + 1] * 2 + 1] * th,
            uvs[t[i + 2] * 2] * tw, uvs[t[i + 2] * 2 + 1] * th,
            v[t[i] * 2], v[t[i] * 2 + 1],
            v[t[i + 1] * 2], v[t[i + 1] * 2 + 1],
            v[t[i + 2] * 2], v[t[i + 2] * 2 + 1]);
        }
      }
      ctx.restore();
    }

    if (clip && si === clip.endSlot) clip = null;
  }
}

// Draw a region attachment as two textured triangles spanning the quad.
function drawTriPair(ctx, tex, v) {
  const w = tex.width, h = tex.height;
  // vertex order: BL, BR, TR, TL in spine space -> uv TL is vertex 3
  drawTexTriangle(ctx, tex, 0, h, w, h, w, 0, v[0], v[1], v[2], v[3], v[4], v[5]);
  drawTexTriangle(ctx, tex, w, 0, 0, 0, 0, h, v[4], v[5], v[6], v[7], v[0], v[1]);
}

// Map a texture-space triangle onto a world-space triangle with an affine
// transform, clipping to the (slightly expanded, to hide seams) destination.
function drawTexTriangle(ctx, tex, sx1, sy1, sx2, sy2, sx3, sy3, dx1, dy1, dx2, dy2, dx3, dy3) {
  const den = sx1 * (sy2 - sy3) + sx2 * (sy3 - sy1) + sx3 * (sy1 - sy2);
  if (Math.abs(den) < 1e-9) return;

  // expand destination triangle ~0.35px around its centroid to hide seams
  const cx = (dx1 + dx2 + dx3) / 3, cy = (dy1 + dy2 + dy3) / 3;
  const grow = (x, y) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const e = 0.35;
    return [x + dx / len * e, y + dy / len * e];
  };
  const [ex1, ey1] = grow(dx1, dy1);
  const [ex2, ey2] = grow(dx2, dy2);
  const [ex3, ey3] = grow(dx3, dy3);

  const a = (dx1 * (sy2 - sy3) + dx2 * (sy3 - sy1) + dx3 * (sy1 - sy2)) / den;
  const b = (dy1 * (sy2 - sy3) + dy2 * (sy3 - sy1) + dy3 * (sy1 - sy2)) / den;
  const c = (dx1 * (sx3 - sx2) + dx2 * (sx1 - sx3) + dx3 * (sx2 - sx1)) / den;
  const d = (dy1 * (sx3 - sx2) + dy2 * (sx1 - sx3) + dy3 * (sx2 - sx1)) / den;
  const e = (dx1 * (sx2 * sy3 - sx3 * sy2) + dx2 * (sx3 * sy1 - sx1 * sy3) + dx3 * (sx1 * sy2 - sx2 * sy1)) / den;
  const f = (dy1 * (sx2 * sy3 - sx3 * sy2) + dy2 * (sx3 * sy1 - sx1 * sy3) + dy3 * (sx1 * sy2 - sx2 * sy1)) / den;

  ctx.save();
  const p = new Path2D();
  p.moveTo(ex1, ey1); p.lineTo(ex2, ey2); p.lineTo(ex3, ey3); p.closePath();
  ctx.clip(p);
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(tex, 0, 0);
  ctx.restore();
}

// --------------------------------------------------------------- player

class Player {
  constructor(canvas, skeleton) {
    this.canvas = canvas;
    this.skeleton = skeleton;
    this.animations = Object.keys(skeleton.data.animations);
    this.anim = null;
    this.time = 0;
    this.speed = 1;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(t => this._tick(t));
  }

  duration(name) {
    let max = 0;
    const walk = o => {
      if (Array.isArray(o)) {
        for (const k of o) if (typeof k === 'object' && k && 'time' in k) max = Math.max(max, k.time || 0);
        for (const k of o) if (typeof k === 'object') walk(k);
      } else if (o && typeof o === 'object') {
        if ('time' in o) max = Math.max(max, o.time || 0);
        for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
      }
    };
    walk(this.skeleton.data.animations[name]);
    return max || 0.001;
  }

  play(name) {
    this.anim = name;
    this.time = 0;
    this._dur = this.duration(name);
    // fit camera: union of bounds sampled across the animation
    let bb = null;
    for (let i = 0; i <= 12; i++) {
      this.skeleton.apply(name, this._dur * i / 12);
      const b = this.skeleton.bounds();
      bb = bb ? { x0: Math.min(bb.x0, b.x0), y0: Math.min(bb.y0, b.y0),
                  x1: Math.max(bb.x1, b.x1), y1: Math.max(bb.y1, b.y1) } : b;
    }
    this._bb = bb;
  }

  _tick(now) {
    this._raf = requestAnimationFrame(t => this._tick(t));
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (!this.anim || !this.running) return;
    this.time = (this.time + dt * this.speed) % this._dur;

    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (c.width !== cw * dpr || c.height !== ch * dpr) {
      c.width = cw * dpr; c.height = ch * dpr;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);

    this.skeleton.apply(this.anim, this.time);

    const bb = this._bb;
    const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    const scale = Math.min(cw / bw, ch / bh) * 0.82 * dpr;
    const ox = c.width / 2 - (bb.x0 + bw / 2) * scale;
    const oy = c.height / 2 + (bb.y0 + bh / 2) * scale;
    ctx.setTransform(scale, 0, 0, -scale, ox, oy);   // spine is y-up
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    render(this.skeleton, ctx);
  }

  dispose() { cancelAnimationFrame(this._raf); }
}

async function load(canvas, skelUrl, atlasUrl) {
  const [regions, json] = await Promise.all([
    loadAtlas(atlasUrl),
    fetch(skelUrl).then(r => r.json()),
  ]);
  return new Player(canvas, new Skeleton(parseSkeleton(json, regions)));
}

return { load, render };
})();
