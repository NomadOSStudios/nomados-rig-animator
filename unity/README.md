# Unity import

**Export** writes, per project, into `projects/<name>/export/`:

| file | purpose |
|---|---|
| `<name>.json` + `.atlas` + `.png` | Spine 4.0 format (Spine runtimes, and the editor's own validator) |
| `<name>.unity.json` + `.png` | read by `RigImporter.cs` |

## Setup (once per project)

Copy `RigImporter.cs` into any `Editor` folder (e.g. `Assets/Editor/`). It
uses the **2D Sprite** package (`com.unity.2d.sprite`), which Unity's 2D
templates include by default, to slice the atlas.

## Import a rig

1. **Tools ▸ NomadOS Rig Animator ▸ Import Rig…**
2. Pick `<name>.unity.json` (its `.png` must sit next to it).
3. Everything lands in `Assets/Rigs/<name>/`:
   - `<name>.prefab` — a Transform per bone, a SpriteRenderer per layer
   - one `.anim` AnimationClip per animation (30 fps)
   - `<name>.controller` — an AnimatorController with a state per clip
   - the sliced atlas, plus meshes and a material if any layer is bent

Re-importing updates everything in place and keeps asset GUIDs stable, so
prefabs that nest the rig keep working. For automation call
`RigImporter.Import(path)` from your own editor code.

Scale: 100 editor pixels = 1 Unity unit.

## Event markers

Markers from the editor's ⚑ events track become AnimationEvents that call

```csharp
void OnRigEvent(string name)   // "fire", "hit", "step", ...
```

on components of the rig's root GameObject. Add one receiver script and
route by name. To use a different method name, set
`RigImporter.EventFunction` before importing.

## How clips behave

- Every clip loops, except one named **`death`**, which plays once and holds
  its last frame.
- Curves match the editor: `ease` keys get flat tangents (the editor's
  smoothstep), `linear` straight slopes, `stepped` jumps.
- Every clip writes every channel that *any* clip animates, falling back to
  the setup pose — so switching states never leaves a limb, a hidden part or
  a tint behind from the previous clip. States have *Write Defaults* off;
  if you pool and reuse characters, restore their resting look from code
  when you recycle them.
- Visibility keys drive `Renderer.enabled`; tint keys drive
  `SpriteRenderer.color`. Layers hidden in the setup pose start disabled.

## Mesh deformation (bend along bones)

In the editor: draw a chain of bones down a part, bind its layer to the first
bone, select the layer in setup mode and click **〰 bend along bones**. The
layer becomes a vertex grid weighted across the chain's joints, so posing the
chain bends the art.

On import such a layer becomes a **`SkinnedMeshRenderer`** (built into
Unity — no extra package, no runtime script), driven by the same bone
Transforms the clips animate. Its material uses `RigImporter.MeshShader`
(default `Sprites/Default`) with the atlas assigned. A skinned part has no
vertex color the Animator can drive, so its tint keys animate
`material._Color` instead of `SpriteRenderer.color`.

Performance: each bent part is one extra draw call per instance (it can't
batch with sprites). Use them freely on heroes and bosses; on crowds of
enemies, keep it to a part or two.
