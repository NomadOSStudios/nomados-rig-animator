# NomadOS Rig Animator

A local, browser-based **2D cutout animation tool**. Paint your character in
Photoshop with one part per layer, rig it with bones, animate it on a
dopesheet, and export it as **native Unity prefabs and AnimationClips** — no
runtime library, no packages to license, nothing between your game and plain
Unity objects. It also exports **Spine 4.0 JSON + atlas**.

It was built for (and is used to animate every enemy and boss in) an indie
survivors-like, by one developer working with Claude.

> Sample included: **El Farro**, a boss character, fully rigged with
> walk / attack / hurt / death and a mesh-bent tail. Open it to see what a
> finished rig looks like.

## Quick start

Requirements: Python 3 and a modern browser. No build step, no npm.

```bash
git clone https://github.com/emadgaidi/nomados-rig-animator.git
cd nomados-rig-animator
python3 server.py
```

Then open <http://127.0.0.1:8231/app/> and pick **el_farro** from the
project list.

To start your own character: **New** → name it → **Open .psd / .psb** and
choose a layered Photoshop file (one layer per body part).

## Features

- **Photoshop in, no export step.** Reads layered `.psd`/`.psb` directly.
  Repaint a layer, add one, reorder them, then hit **Refresh**: pixels,
  positions and order update while your bones, bindings and animations survive
  (layers are matched by name, never by position).
- **Rigging.** Draw bones (`B`), move pivots (`P`), reparent, bind layers.
  Drawing a bone with a layer selected binds that layer to it.
- **Mesh deformation.** Bend a layer along a chain of bones (tails, stalks,
  ears, capes) with automatic linear-blend weights — the art bends instead of
  hinging. Exports as Spine weighted meshes and Unity `SkinnedMeshRenderer`s.
- **Dopesheet.** Per-channel rows (rotate / move / scale), ease / linear /
  stepped curves, copy-paste keys, box-select and drag groups of keys, a
  playhead that snaps to keys, and timeline zoom (`⌘`/`Ctrl` + wheel).
- **Beyond bones.** Visibility keys (swap a hand, a face, a muzzle flash),
  tint/alpha keys (with an *all layers* toggle for whole-body fades), and
  named **event markers** your game code syncs to (`fire`, `hit`, `step`…).
- **Crumble tool.** Shatter a layer into seeded Voronoi pieces for
  break-apart deaths; pieces regenerate from the art on every load.
- **Validated export.** Every export is replayed through a small built-in
  Spine renderer (`app/mini-spine.js`) to catch mistakes before your game does.

Keys: `V` select/pose · `B` bone · `P` pivot · `S` scale · `Tab` setup/animate ·
`K` key the selected bone · `⌘C`/`⌘V` copy/paste keys · `⌫` delete ·
`⌘Z` undo.

## Unity

Copy `unity/RigImporter.cs` into an `Editor` folder in your project, then use
**Tools ▸ NomadOS Rig Animator ▸ Import Rig…** on an exported
`<name>.unity.json`. You get a prefab (Transform bones + SpriteRenderers),
one AnimationClip per animation and an AnimatorController. Details, event
markers and conventions: [`unity/README.md`](unity/README.md).

Tip: start the server with a second argument and every export is also copied
into your game project:

```bash
python3 server.py 8231 ~/MyGame/ArtSrc/rigs
```

## Project layout

```
app/                the editor (static HTML/JS, no build)
server.py           static server + project save API + optional export mirror
unity/              RigImporter.cs and its docs
projects/<name>/    one folder per character: the PSD/PSB + project.json
                    (exports land in projects/<name>/export/)
```

Everything stays on your machine: the server only listens on `127.0.0.1`.

## Limitations

Deliberately small. There is no IK, no weight painting (mesh weights are
automatic along bone chains), no free-form vertex animation, no skins and no
audio. It does what a cutout-animated 2D game needs, and keeps the output
plain.

## License

Code: [MIT](LICENSE). The bundled PSD parser is
[ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT) — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The El Farro sample art is **not** covered by the MIT license — see
[`projects/el_farro/ART_LICENSE.md`](projects/el_farro/ART_LICENSE.md).

Spine is a trademark of Esoteric Software. This project is not affiliated
with or endorsed by Esoteric Software; it writes the openly documented Spine
JSON format.
