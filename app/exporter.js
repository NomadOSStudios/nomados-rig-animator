/* Export: Spine 4.0 JSON + packed atlas PNG, plus a Unity-friendly JSON
 * consumed by unity/RigImporter.cs.
 *
 * Editor space is y-down; Spine is y-up. The conversion is a reflection:
 * y -> -y, rotation -> -rotation, applied to every local transform and every
 * animation offset. Unity conversion happens in the C# importer instead, so
 * the .unity.json carries raw editor values.
 */
'use strict';

const Exporter = (() => {

function sanitize(s) {
  return s.replace(/[^\w\- ]+/g, '_').trim() || 'layer';
}

const hex2 = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const rgba8 = c => hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + hex2(c[3]);
const isWhite = c => !c || c.every(v => v > 0.999);

// unique export name per layer (PSBs happily contain duplicate layer names)
function exportNames(layers) {
  const used = new Map();
  return layers.map(l => {
    let n = sanitize(l.name);
    const count = used.get(n) || 0;
    used.set(n, count + 1);
    return count ? `${n}_${count + 1}` : n;
  });
}

// ---- atlas packing (shelf) ----------------------------------------------

function packAtlas(layers, names) {
  const pad = 2;
  const items = layers.map((l, i) => ({ l, name: names[i] }))
    .sort((a, b) => b.l.canvas.height - a.l.canvas.height);
  const area = items.reduce((s, it) => s + (it.l.canvas.width + pad) * (it.l.canvas.height + pad), 0);
  const targetW = Math.max(128, Math.ceil(Math.sqrt(area * 1.15)));

  let x = pad, y = pad, rowH = 0, maxW = 0;
  const rects = {};
  for (const it of items) {
    const w = it.l.canvas.width, h = it.l.canvas.height;
    if (x + w + pad > targetW && x > pad) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    rects[it.name] = { x, y, w, h };
    x += w + pad;
    rowH = Math.max(rowH, h);
    maxW = Math.max(maxW, x);
  }
  const W = maxW + pad, H = y + rowH + pad;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  for (const it of items) {
    const r = rects[it.name];
    ctx.drawImage(it.l.canvas, r.x, r.y);
  }
  return { canvas, rects };
}

function atlasText(pngName, canvas, rects) {
  let out = `${pngName}\nsize:${canvas.width},${canvas.height}\nfilter:Linear,Linear\npma:false\nscale:1\n`;
  for (const [name, r] of Object.entries(rects)) {
    out += `${name}\nbounds:${r.x},${r.y},${r.w},${r.h}\n`;
  }
  return out;
}

// ---- Spine JSON ----------------------------------------------------------

function spineCurve(k, next, vals, nextVals) {
  // returns the "curve" property for a key, or undefined for linear
  if (k.curve === 'stepped') return 'stepped';
  if (k.curve !== 'ease' || !next) return undefined;
  const dt = next.time - k.time;
  const out = [];
  for (let c = 0; c < vals.length; c++) {
    out.push(+(k.time + dt / 3).toFixed(4), +vals[c].toFixed(4),
             +(k.time + dt * 2 / 3).toFixed(4), +nextVals[c].toFixed(4));
  }
  return out;
}

function exportChannel(keys, fields, convert, spineFields) {
  const get = (k, f, ci) => convert[ci](k[f] ?? (f === 'x' || f === 'y' ? 0 : k.value ?? 0));
  return keys.map((k, i) => {
    const next = keys[i + 1];
    const vals = fields.map((f, ci) => get(k, f, ci));
    const entry = { time: +k.time.toFixed(4) };
    spineFields.forEach((f, ci) => entry[f] = +vals[ci].toFixed(4));
    const curve = spineCurve(k, next, vals, next ? fields.map((f, ci) => get(next, f, ci)) : null);
    if (curve) entry.curve = curve;
    return entry;
  });
}

function buildSpineJson(docObj, layers, names, rects) {
  const bones = Rig.bones.map((b, i) => {
    if (i === 0) return { name: b.name };
    const o = {
      name: b.name,
      parent: Rig.bones[b.parent].name,
      x: +b.x.toFixed(2), y: +(-b.y).toFixed(2),
      rotation: +(-b.rotation).toFixed(2),
      length: +b.length.toFixed(2),
    };
    if (b.scaleX !== 1) o.scaleX = +b.scaleX.toFixed(4);
    if (b.scaleY !== 1) o.scaleY = +b.scaleY.toFixed(4);
    return o;
  });

  const slots = [];
  const skinAtts = {};
  layers.forEach((l, i) => {
    if (!l.visible && !Rig.hasShowKeys(l.src)) return;
    const name = names[i];
    const slot = { name, bone: Rig.bones[l.bone].name };
    if (l.visible) slot.attachment = name;   // hidden-until-keyed slots start empty
    if (!isWhite(l.tint)) slot.color = rgba8(l.tint);
    slots.push(slot);
    if (l.mesh) {
      // weighted mesh attachment: vertices are [n, bone, x, y, w, ...] per
      // vertex in bone space; our y-down bone frames mirror to Spine's y-up
      // ones, so y flips. uvs are top-left origin over the region, as Spine's.
      const m = l.mesh, W = l.canvas.width, H = l.canvas.height;
      const vertices = [], uvs = [];
      for (const inf of m.w) {
        vertices.push(inf.length);
        for (const [b, lx, ly, wgt] of inf) vertices.push(b, +lx.toFixed(3), +(-ly).toFixed(3), +wgt.toFixed(4));
      }
      for (let i = 0; i < m.verts.length; i += 2)
        uvs.push(+(m.verts[i] / W).toFixed(5), +(m.verts[i + 1] / H).toFixed(5));
      skinAtts[name] = { [name]: { type: 'mesh', uvs, triangles: m.tris, vertices, hull: m.hull,
                                   width: W, height: H } };
      return;
    }
    skinAtts[name] = { [name]: {
      x: +(l.lx || 0).toFixed(2), y: +(-(l.ly || 0)).toFixed(2),
      rotation: +(-(l.lrot || 0)).toFixed(2),
      scaleX: +(l.lsx ?? 1).toFixed(4), scaleY: +(l.lsy ?? 1).toFixed(4),
      width: l.canvas.width, height: l.canvas.height,
    } };
  });

  const animations = {};
  const eventDefs = {};
  for (const [aname, a] of Object.entries(Rig.anims)) {
    const out = { bones: {} };
    if (a.events?.length) {
      out.events = a.events.map(e => ({ time: +e.time.toFixed(4), name: e.name }));
      for (const e of a.events) eventDefs[e.name] = {};
    }
    let padded = false;
    for (const [bname, ch] of Object.entries(a.bones)) {
      const bo = {};
      if (ch.rotate?.length) {
        bo.rotate = exportChannel(ch.rotate, ['value'], [v => -v], ['value']);
      }
      if (ch.translate?.length) {
        bo.translate = exportChannel(ch.translate, ['x', 'y'], [v => v, v => -v], ['x', 'y']);
      }
      if (ch.scale?.length) {
        bo.scale = exportChannel(ch.scale, ['x', 'y'], [v => v, v => v], ['x', 'y']);
      }
      if (Object.keys(bo).length) {
        // Spine shows the SETUP pose before a timeline's first frame, while
        // the editor (and Unity) hold the first key's value backwards — inject
        // a t=0 copy so runtimes match what the author previewed. Equal values
        // at both ends make the segment constant under any interpolation.
        for (const arr of Object.values(bo)) {
          if (arr[0].time > 1e-6) {
            const inj = { ...arr[0], time: 0 };
            delete inj.curve;
            arr.unshift(inj);
          }
        }
        out.bones[bname] = bo;
        // hold the animation open to its full duration once
        if (!padded) {
          const first = Object.values(bo)[0];
          const last = first[first.length - 1];
          if (last.time < a.duration - 1e-6) {
            first.push({ ...last, time: +a.duration.toFixed(4), curve: undefined });
            delete first[first.length - 1].curve;
          }
          padded = true;
        }
      }
    }
    // Spine derives duration from the latest timeline key, so an animation
    // with no bone channels (event-, tint- or visibility-only) would collapse
    // to its last key: hold root open to the authored duration instead
    if (!padded)
      out.bones.root = { rotate: [{ time: 0, value: 0 },
                                  { time: +a.duration.toFixed(4), value: 0 }] };
    // visibility keys -> Spine slot attachment timelines
    for (const [src, keys] of Object.entries(a.shows || {})) {
      const li = layers.findIndex(l => l.src === +src);
      if (li < 0 || !keys.length) continue;
      const slotName = names[li];
      out.slots = out.slots || {};
      out.slots[slotName] = { attachment: keys.map(k =>
        ({ time: +k.time.toFixed(4), name: k.on ? slotName : null })) };
    }
    // tint keys -> Spine rgba timelines (bezier = 4 numbers per component)
    for (let [src, keys] of Object.entries(a.tints || {})) {
      const li = layers.findIndex(l => l.src === +src);
      if (li < 0 || !keys.length) continue;
      const slotName = names[li];
      out.slots = out.slots || {};
      out.slots[slotName] = out.slots[slotName] || {};
      // same first-key-holds-backwards injection as bone timelines above
      // (Spine would otherwise show the slot's setup color until the first key)
      if (keys[0].time > 1e-6) keys = [{ time: 0, c: keys[0].c, curve: 'linear' }, ...keys];
      out.slots[slotName].rgba = keys.map((k, i) => {
        const next = keys[i + 1];
        const entry = { time: +k.time.toFixed(4), color: rgba8(k.c) };
        if (k.curve === 'stepped') entry.curve = 'stepped';
        else if (k.curve === 'ease' && next) {
          const dt = next.time - k.time;
          const curve = [];
          for (let c = 0; c < 4; c++) {
            curve.push(+(k.time + dt / 3).toFixed(4), +k.c[c].toFixed(4),
                       +(k.time + dt * 2 / 3).toFixed(4), +next.c[c].toFixed(4));
          }
          entry.curve = curve;
        }
        return entry;
      });
    }
    animations[aname] = out;
  }

  const out = {
    skeleton: { hash: 'mini-rig', spine: '4.0.63',
                width: docObj.width, height: docObj.height, images: '' },
    bones, slots,
    skins: [{ name: 'default', attachments: Object.fromEntries(
      slots.map(s => [s.name, skinAtts[s.name]])) }],
    animations,
  };
  if (Object.keys(eventDefs).length) out.events = eventDefs;
  return out;
}

// ---- Unity JSON (raw editor values; RigImporter.cs does conversions) -----

function buildUnityJson(pngName, layers, names, rects, texW, texH) {
  const slots = [];
  const slotIndexBySrc = {};
  layers.forEach((l, i) => {
    if (!l.visible && !Rig.hasShowKeys(l.src)) return;
    const r = rects[names[i]];
    slotIndexBySrc[l.src] = slots.length;
    const slot = { name: names[i], bone: l.bone, hidden: !l.visible,
                   tint: l.tint && !isWhite(l.tint) ? l.tint : null,
                   lx: l.lx || 0, ly: l.ly || 0, lrot: l.lrot || 0,
                   lsx: l.lsx ?? 1, lsy: l.lsy ?? 1,
                   rx: r.x, ry: r.y, rw: r.w, rh: r.h };
    if (l.mesh) {
      // skinned layer -> SkinnedMeshRenderer in the importer. uvs are
      // top-left origin over the slot rect; weights are Spine-style flat
      // [n, bone, x, y, w, ...] with x/y in the bone's EDITOR space (y-down,
      // pixels) - RigImporter.cs converts like it does bone transforms.
      const m = l.mesh, W = l.canvas.width, H = l.canvas.height;
      const uvs = [], weights = [];
      for (let k = 0; k < m.verts.length; k += 2) uvs.push(m.verts[k] / W, m.verts[k + 1] / H);
      for (const inf of m.w) { weights.push(inf.length); for (const e of inf) weights.push(...e); }
      slot.mesh = { uvs, tris: m.tris, weights };
    }
    slots.push(slot);
  });
  const anims = Object.entries(Rig.anims).map(([name, a]) => ({
    name, duration: a.duration,
    events: (a.events || []).map(e => ({ t: e.time, name: e.name })),
    // visibility tracks; a t=0 key is injected so Unity curves start from the
    // setup state (Unity evaluates a curve's first key backwards in time)
    shows: Object.entries(a.shows || {}).flatMap(([src, keys]) => {
      const slot = slotIndexBySrc[src];
      if (slot === undefined || !keys.length) return [];
      const layer = layers.find(l => l.src === +src);
      const out = keys.map(k => ({ t: k.time, on: k.on }));
      if (out[0].t > 1e-6) out.unshift({ t: 0, on: !!layer?.visible });
      return [{ slot, keys: out }];
    }),
    // t=0 tint injection uses the FIRST KEY's color, matching the editor
    // preview (tintAt holds the first key backwards in time), not the setup
    // tint — visibility above keeps setup because showAt does too
    tints: Object.entries(a.tints || {}).flatMap(([src, keys]) => {
      const slot = slotIndexBySrc[src];
      if (slot === undefined || !keys.length) return [];
      const out = keys.map(k => ({ t: k.time, c: k.c, curve: k.curve || 'ease' }));
      if (out[0].t > 1e-6) out.unshift({ t: 0, c: keys[0].c, curve: 'ease' });
      return [{ slot, keys: out }];
    }),
    tracks: (tracks => {
      // clip length in Unity comes from the last curve key: with no bone
      // channels (event/tint/show-only animations) hold root open instead
      if (!tracks.length)
        tracks.push({ bone: 0, channel: 'rotate',
                      keys: [{ t: 0, curve: 'linear', v: [0] },
                             { t: a.duration, curve: 'linear', v: [0] }] });
      return tracks;
    })(Object.entries(a.bones).flatMap(([bname, ch]) => {
      const bi = Rig.bones.findIndex(b => b.name === bname);
      if (bi < 0) return [];
      return ['rotate', 'translate', 'scale'].filter(c => ch[c]?.length).map(c => ({
        bone: bi, channel: c,
        keys: ch[c].map(k => ({
          t: k.time, curve: k.curve || 'ease',
          v: c === 'rotate' ? [k.value || 0] : [k.x ?? (c === 'scale' ? 1 : 0), k.y ?? (c === 'scale' ? 1 : 0)],
        })),
      }));
    })),
  }));
  return {
    ppu: 100, png: pngName, texW, texH,
    bones: Rig.bones.map(b => ({ name: b.name, parent: b.parent,
      x: b.x, y: b.y, rot: b.rotation, sx: b.scaleX, sy: b.scaleY })),
    slots, anims,
  };
}

// ---- main ---------------------------------------------------------------

async function exportAll(docObj, layers, baseName) {
  const name = sanitize(baseName).replace(/ /g, '_').toLowerCase();
  const names = exportNames(layers);
  // ship a layer if it's visible OR any animation keys its visibility
  const shipped = l => l.visible || Rig.hasShowKeys(l.src);
  const included = layers.filter(shipped);
  if (!included.length) throw new Error('no visible layers');

  const { canvas, rects } = packAtlas(included, names.filter((_, i) => shipped(layers[i])));
  // rebuild names/rects aligned to full layer list
  const nameByLayer = names;

  const spine = buildSpineJson(docObj, layers, nameByLayer, rects);
  const unity = buildUnityJson(`${name}.png`, layers, nameByLayer, rects,
                               canvas.width, canvas.height);
  const atlas = atlasText(`${name}.png`, canvas, rects);

  const png = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const save = (path, body) =>
    fetch(`/api/save/${name}/export/` + path, { method: 'POST', body });
  await save(`${name}.png`, png);
  await save(`${name}.atlas`, atlas);
  await save(`${name}.json`, JSON.stringify(spine, null, 1));
  await save(`${name}.unity.json`, JSON.stringify(unity, null, 1));

  return { name, files: [`${name}.json`, `${name}.atlas`, `${name}.png`, `${name}.unity.json`],
           slots: spine.slots.length, anims: Object.keys(spine.animations).length,
           tex: `${canvas.width}×${canvas.height}` };
}

// validate the export by loading it back through mini-spine
async function validate(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const p = await MiniSpine.load(c, `/projects/${name}/export/${name}.json`,
                                    `/projects/${name}/export/${name}.atlas`);
  for (const a of p.animations) {
    p.skeleton.apply(a, 0.123);
    for (const si of p.skeleton.drawOrder) {
      const s = p.skeleton.slots[si];
      if (p.skeleton.attachment(s)) p.skeleton.vertices(s);
    }
  }
  p.dispose();
  return p.animations;
}

return { exportAll, validate };
})();
