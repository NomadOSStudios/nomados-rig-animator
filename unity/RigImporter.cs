// RigImporter.cs — imports a NomadOS Rig Animator export (<name>.unity.json + <name>.png)
// as a native Unity prefab: Transform bone hierarchy, SpriteRenderers, and
// AnimationClips in an AnimatorController; layers bent along bone chains
// become SkinnedMeshRenderers. No runtime dependency — after import
// everything is plain Unity objects. Needs the built-in 2D Sprite package
// (com.unity.2d.sprite, present in Unity's 2D templates) for atlas slicing.
//
// Install: drop this file into Assets/Editor/ in your Unity project.
// Use:     Tools ▸ NomadOS Rig Animator ▸ Import Rig…  and pick the .unity.json file
//          (the .png must sit next to it; both are copied into the project).
//
// Conversions from editor space (pixels, y-down, CW degrees):
//   position  (x, y)  ->  (x, -y) / PPU
//   rotation  θ       ->  -θ  (on the Z axis)
//   atlas rect        ->  y-flipped into Unity's bottom-left texture space

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.U2D.Sprites;
using UnityEngine;

public static class RigImporter
{
    // Method that baked event markers call on the rig root's components:
    // add a MonoBehaviour with `void OnRigEvent(string name)` to receive them.
    public static string EventFunction = "OnRigEvent";
    // Shader for skinned (bent) parts; anything with _MainTex and _Color works.
    public static string MeshShader = "Sprites/Default";

    [Serializable] public class RigBone
    { public string name; public int parent; public float x, y, rot, sx, sy; }

    // A layer the animator skinned to a bone chain: a vertex grid over the
    // slot's rect, each vertex weighted to one or two bones. weights is
    // Spine-style flat data, [n, bone, x, y, w, ...] per vertex, with x/y in
    // that bone's editor space (pixels, y-down) - converted like bone
    // transforms are. uvs are top-left origin over the slot rect.
    [Serializable] public class RigMesh
    { public float[] uvs; public int[] tris; public float[] weights; }

    [Serializable] public class RigSlot
    { public string name; public int bone;
      public bool hidden; public float[] tint;
      public float lx, ly, lrot, lsx, lsy;
      public int rx, ry, rw, rh;
      public RigMesh mesh; }

    [Serializable] public class RigKey
    { public float t; public string curve; public float[] v; }

    [Serializable] public class RigTrack
    { public int bone; public string channel; public List<RigKey> keys; }

    [Serializable] public class RigEventKey { public float t; public string name; }
    [Serializable] public class RigShowKey { public float t; public bool on; }
    [Serializable] public class RigShow { public int slot; public List<RigShowKey> keys; }
    [Serializable] public class RigTintKey { public float t; public string curve; public float[] c; }
    [Serializable] public class RigTint { public int slot; public List<RigTintKey> keys; }

    [Serializable] public class RigAnim
    { public string name; public float duration; public List<RigTrack> tracks;
      public List<RigEventKey> events; public List<RigShow> shows; public List<RigTint> tints; }

    [Serializable] public class RigDoc
    { public float ppu; public string png; public int texW, texH;
      public List<RigBone> bones; public List<RigSlot> slots; public List<RigAnim> anims; }

    [MenuItem("Tools/NomadOS Rig Animator/Import Rig…")]
    public static void ImportMenu()
    {
        string path = EditorUtility.OpenFilePanel("Pick .unity.json export", "", "json");
        if (!string.IsNullOrEmpty(path)) Import(path);
    }

    public static void Import(string jsonPath)
    {
        var doc = JsonUtility.FromJson<RigDoc>(File.ReadAllText(jsonPath));
        string baseName = Path.GetFileName(jsonPath).Replace(".unity.json", "");
        string srcPng = Path.Combine(Path.GetDirectoryName(jsonPath), doc.png);
        if (!File.Exists(srcPng))
        { Debug.LogError("Rig Import: missing texture " + srcPng); return; }

        // --- copy assets into the project -----------------------------------
        string dir = "Assets/Rigs/" + baseName;
        Directory.CreateDirectory(dir);
        string pngAsset = dir + "/" + doc.png;
        File.Copy(srcPng, pngAsset, true);
        AssetDatabase.ImportAsset(pngAsset);

        // --- slice the atlas into sprites -----------------------------------
        // The deprecated importer.spritesheet setter silently stops applying
        // once a texture has sprite data, so a re-export that adds slots would
        // never get its new sprites sliced. The 2D
        // Sprite package's data provider is the supported path; sprite ids are
        // kept stable per name so re-imports never churn references.
        var importer = (TextureImporter)AssetImporter.GetAtPath(pngAsset);
        importer.textureType = TextureImporterType.Sprite;
        importer.spriteImportMode = SpriteImportMode.Multiple;
        importer.spritePixelsPerUnit = doc.ppu;
        // Rig art renders far below its authored resolution; without mips the
        // minified pixels crawl as sprites move. Trilinear blends mip steps.
        importer.filterMode = FilterMode.Trilinear;
        importer.mipmapEnabled = true;
        var factories = new SpriteDataProviderFactories();
        factories.Init();
        var provider = factories.GetSpriteEditorDataProviderFromObject(importer);
        provider.InitSpriteEditorDataProvider();
        var fileIds = provider.GetDataProvider<ISpriteNameFileIdDataProvider>();
        var knownIds = fileIds.GetNameFileIdPairs().ToDictionary(p => p.name, p => p.GetFileGUID());
        var spriteRects = doc.slots.Select(s => new SpriteRect
        {
            name = s.name,
            // atlas rects are y-down from top-left; Unity wants bottom-left
            rect = new Rect(s.rx, doc.texH - s.ry - s.rh, s.rw, s.rh),
            pivot = new Vector2(0.5f, 0.5f),
            alignment = SpriteAlignment.Center,
            spriteID = knownIds.TryGetValue(s.name, out var known) ? known : GUID.Generate(),
        }).ToArray();
        provider.SetSpriteRects(spriteRects);
        fileIds.SetNameFileIdPairs(spriteRects.Select(r =>
            new SpriteNameFileIdPair(r.name, r.spriteID)));
        provider.Apply();
        importer.SaveAndReimport();
        var sprites = AssetDatabase.LoadAllAssetsAtPath(pngAsset)
            .OfType<Sprite>().ToDictionary(sp => sp.name, sp => sp);
        var missing = doc.slots.Where(s => !sprites.ContainsKey(s.name)).Select(s => s.name).ToList();
        if (missing.Count > 0)
        { Debug.LogError(baseName + ": atlas slicing produced no sprite for: " + string.Join(", ", missing)); return; }

        // --- build the bone hierarchy ---------------------------------------
        var rootGo = new GameObject(baseName);
        var boneTf = new Transform[doc.bones.Count];
        for (int i = 0; i < doc.bones.Count; i++)
        {
            var b = doc.bones[i];
            var go = i == 0 ? rootGo : new GameObject(b.name);
            var tf = go.transform;
            if (i > 0) tf.SetParent(boneTf[b.parent], false);
            if (i > 0)   // root stays at origin; editor-root world offset is dropped
            {
                tf.localPosition = new Vector3(b.x / doc.ppu, -b.y / doc.ppu, 0);
                tf.localRotation = Quaternion.Euler(0, 0, -b.rot);
                tf.localScale = new Vector3(b.sx, b.sy, 1);
            }
            boneTf[i] = tf;
        }

        // --- sprites under their bones --------------------------------------
        int order = 0;
        var atlasTex = AssetDatabase.LoadAssetAtPath<Texture2D>(pngAsset);
        Material meshMat = null;
        foreach (var s in doc.slots)
        {
            if (IsMeshed(s))
            {
                // bent layers become SkinnedMeshRenderers under the root,
                // driven by the same bone Transforms the clips animate
                meshMat ??= MeshMaterial(dir, baseName, atlasTex);
                BuildSkinnedSlot(doc, s, rootGo.transform, boneTf, meshMat, dir, order++);
                continue;
            }
            var go = new GameObject(s.name);
            go.transform.SetParent(boneTf[s.bone], false);
            go.transform.localPosition = new Vector3(s.lx / doc.ppu, -s.ly / doc.ppu, 0);
            go.transform.localRotation = Quaternion.Euler(0, 0, -s.lrot);
            go.transform.localScale = new Vector3(s.lsx, s.lsy, 1);
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = sprites[s.name];
            sr.sortingOrder = order++;
            if (s.tint != null && s.tint.Length == 4)
                sr.color = new Color(s.tint[0], s.tint[1], s.tint[2], s.tint[3]);
            // hidden-until-keyed slots (death poses etc.) rest disabled
            if (s.hidden) sr.enabled = false;
        }

        // --- animation clips -------------------------------------------------
        // A re-export may rename or drop
        // animations, so stale generated clips are removed first - otherwise
        // the controller keeps playing a dead default state. The controller
        // itself is never deleted: deleting it churns its guid, and any prefab
        // that nests this rig then bakes the dangling Animator reference into
        // a null override that silently disables playback.
        foreach (var stale in Directory.GetFiles(dir))
            if (stale.EndsWith(".anim"))
                AssetDatabase.DeleteAsset(stale.Replace('\\', '/'));
        // Slots any clip shows/tints, and bone channels any clip animates:
        // every clip must pin these (below), or one clip's changes leak into
        // states that never mention them (a death clip's tilted hat would
        // survive into walk, which never writes hat rotation).
        var shownSlots = new HashSet<int>();
        var tintedSlots = new HashSet<int>();
        var animatedChannels = new HashSet<(int bone, string channel)>();
        foreach (var a in doc.anims)
        {
            if (a.shows != null) foreach (var s in a.shows) shownSlots.Add(s.slot);
            if (a.tints != null) foreach (var t in a.tints) tintedSlots.Add(t.slot);
            if (a.tracks != null) foreach (var t in a.tracks) animatedChannels.Add((t.bone, t.channel));
        }
        var clips = new List<AnimationClip>();
        foreach (var a in doc.anims)
        {
            var clip = new AnimationClip { frameRate = 30 };
            var so = new SerializedObject(clip);
            // "death" is a reserved name: it plays once and holds its last pose
            so.FindProperty("m_AnimationClipSettings.m_LoopTime").boolValue = a.name != "death";
            so.ApplyModifiedProperties();

            // Own keys where the clip has them, setup-pose pins where it
            // doesn't: a single key at the setup value (converted below), held
            // for the clip's length by the same duration padding as real keys.
            var pinnedTracks = new List<RigTrack>(a.tracks ?? new List<RigTrack>());
            foreach (var (bone, channel) in animatedChannels)
                if (!pinnedTracks.Any(t => t.bone == bone && t.channel == channel))
                    pinnedTracks.Add(new RigTrack { bone = bone, channel = channel, keys = new List<RigKey> {
                        new RigKey { t = 0f, curve = "ease",
                            v = channel == "rotate" ? new[] { 0f } : channel == "scale" ? new[] { 1f, 1f } : new[] { 0f, 0f } } } });

            foreach (var tr in pinnedTracks)
            {
                string path = BonePath(doc, tr.bone);
                var setup = doc.bones[tr.bone];
                if (tr.channel == "rotate")
                {
                    SetCurve(clip, path, "localEulerAnglesRaw.z",
                        Curve(a, tr, 0, v => -(setup.rot + v)));
                }
                else if (tr.channel == "translate")
                {
                    SetCurve(clip, path, "m_LocalPosition.x",
                        Curve(a, tr, 0, v => (setup.x + v) / doc.ppu));
                    SetCurve(clip, path, "m_LocalPosition.y",
                        Curve(a, tr, 1, v => -(setup.y + v) / doc.ppu));
                }
                else if (tr.channel == "scale")
                {
                    SetCurve(clip, path, "m_LocalScale.x", Curve(a, tr, 0, v => setup.sx * v));
                    SetCurve(clip, path, "m_LocalScale.y", Curve(a, tr, 1, v => setup.sy * v));
                }
            }

            // Setup-pose semantics, matching the animator's preview: every clip
            // writes visibility and color for every slot that ANY clip keys -
            // from its own keys when it has them, pinned to the setup pose
            // otherwise. Stepped for visibility: a slot is either shown or
            // not, never half-faded by accident.
            foreach (var slotIndex in shownSlots)
            {
                var slot = doc.slots[slotIndex];
                var own = a.shows?.FirstOrDefault(sh => sh.slot == slotIndex);
                var curve = own != null
                    ? Curve(a, new RigTrack { keys = own.keys.Select(k =>
                          new RigKey { t = k.t, curve = "stepped", v = new[] { k.on ? 1f : 0f } }).ToList() }, 0, v => v)
                    : AnimationCurve.Constant(0f, a.duration, slot.hidden ? 0f : 1f);
                clip.SetCurve(SlotPath(doc, slot), RendererType(slot), "m_Enabled", curve);
            }
            foreach (var slotIndex in tintedSlots)
            {
                var slot = doc.slots[slotIndex];
                var slotPath = SlotPath(doc, slot);
                // a skinned part has no vertex-colour channel the Animator can
                // drive, so its clip tint animates the renderer's material
                // _Color instead
                var components = IsMeshed(slot)
                    ? new[] { "material._Color.r", "material._Color.g", "material._Color.b", "material._Color.a" }
                    : new[] { "m_Color.r", "m_Color.g", "m_Color.b", "m_Color.a" };
                var own = a.tints?.FirstOrDefault(tn => tn.slot == slotIndex);
                if (own != null)
                {
                    var track = new RigTrack { keys = own.keys.Select(k =>
                        new RigKey { t = k.t, curve = k.curve, v = k.c }).ToList() };
                    for (int c = 0; c < 4; c++)
                        clip.SetCurve(slotPath, RendererType(slot), components[c], Curve(a, track, c, v => v));
                }
                else
                {
                    var rest = slot.tint != null && slot.tint.Length == 4 ? slot.tint : new[] { 1f, 1f, 1f, 1f };
                    for (int c = 0; c < 4; c++)
                        clip.SetCurve(slotPath, RendererType(slot), components[c],
                            AnimationCurve.Constant(0f, a.duration, rest[c]));
                }
            }

            // event markers bake to AnimationEvents calling EventFunction
            // (default OnRigEvent) with the marker name (step, hit, fire...)
            if (a.events != null && a.events.Count > 0)
                UnityEditor.AnimationUtility.SetAnimationEvents(clip, a.events
                    .OrderBy(e => e.t)
                    .Select(e => new AnimationEvent { time = e.t, functionName = EventFunction, stringParameter = e.name })
                    .ToArray());

            AssetDatabase.CreateAsset(clip, dir + "/" + a.name + ".anim");
            clips.Add(clip);
        }

        // --- animator + prefab -----------------------------------------------
        if (clips.Count > 0)
        {
            string ctrlPath = dir + "/" + baseName + ".controller";
            var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>(ctrlPath);
            if (ctrl)
            {
                // Rebuild in place so the asset's guid survives re-exports.
                var machine = ctrl.layers[0].stateMachine;
                foreach (var child in machine.states)
                    machine.RemoveState(child.state);
                AnimatorState first = null;
                foreach (var clip in clips)
                {
                    var state = ctrl.AddMotion(clip);
                    if (first == null) first = state;
                }
                machine.defaultState = first;
                EditorUtility.SetDirty(ctrl);
            }
            else
            {
                ctrl = AnimatorController.CreateAnimatorControllerAtPathWithClip(ctrlPath, clips[0]);
                for (int i = 1; i < clips.Count; i++)
                    ctrl.AddMotion(clips[i]);
            }
            // WriteDefaults off: a state then writes only what it animates.
            // With it on, walk keeps re-writing the animator's captured
            // "defaults" for properties only death animates - and on a pooled
            // object those captured defaults can be the dead pose, so a reused
            // character respawns invisible. Restore the resting look from code
            // when recycling instead.
            foreach (var child in ctrl.layers[0].stateMachine.states)
                child.state.writeDefaultValues = false;
            EditorUtility.SetDirty(ctrl);
            rootGo.AddComponent<Animator>().runtimeAnimatorController = ctrl;
        }
        PrefabUtility.SaveAsPrefabAsset(rootGo, dir + "/" + baseName + ".prefab");
        UnityEngine.Object.DestroyImmediate(rootGo);
        AssetDatabase.SaveAssets();
        // A log, not a dialog, so batch/automated imports never block.
        Debug.Log($"RIG_IMPORTED {baseName}: {doc.slots.Count} sprites, {doc.anims.Count} clips -> {dir}");
    }

    static bool IsMeshed(RigSlot s) => s.mesh != null && s.mesh.tris != null && s.mesh.tris.Length > 0;

    // the component a slot's visibility/tint curves target
    static Type RendererType(RigSlot s) => IsMeshed(s) ? typeof(SkinnedMeshRenderer) : typeof(SpriteRenderer);

    // Skinned parts can't ride the sprite material path (their texture isn't
    // per-renderer data), so they share one material on MeshShader with
    // the atlas assigned. Reused across re-imports to keep its guid stable.
    static Material MeshMaterial(string dir, string baseName, Texture2D atlas)
    {
        string path = dir + "/" + baseName + "_mesh.mat";
        var shader = Shader.Find(MeshShader) ?? Shader.Find("Sprites/Default");
        var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (!mat) { mat = new Material(shader); AssetDatabase.CreateAsset(mat, path); }
        else mat.shader = shader;
        mat.mainTexture = atlas;
        EditorUtility.SetDirty(mat);
        return mat;
    }

    // A meshed slot becomes a SkinnedMeshRenderer parented to the rig root:
    // vertices in root space at the bind pose, bindposes taken from the bone
    // Transforms as just built, so the bone clips deform it natively - no
    // runtime script, no package.
    static void BuildSkinnedSlot(RigDoc doc, RigSlot s, Transform root, Transform[] boneTf,
                                 Material mat, string dir, int order)
    {
        var m = s.mesh;
        int n = m.uvs.Length / 2;
        var verts = new Vector3[n];
        var uvs = new Vector2[n];
        var bw = new BoneWeight[n];
        int p = 0;
        var inf = new List<(int bone, float w)>();
        for (int v = 0; v < n; v++)
        {
            int count = (int)m.weights[p++];
            var pos = Vector3.zero;
            inf.Clear();
            for (int k = 0; k < count; k++, p += 4)
            {
                int bone = (int)m.weights[p];
                var local = new Vector3(m.weights[p + 1] / doc.ppu, -m.weights[p + 2] / doc.ppu, 0);
                float w = m.weights[p + 3];
                pos += boneTf[bone].TransformPoint(local) * w;   // root sits at origin: world == root space
                inf.Add((bone, w));
            }
            verts[v] = pos;
            inf.Sort((a, b) => b.w.CompareTo(a.w));
            float total = 0f;
            for (int k = 0; k < inf.Count && k < 4; k++) total += inf[k].w;
            if (total <= 0f) total = 1f;
            bw[v].boneIndex0 = inf.Count > 0 ? inf[0].bone : s.bone; bw[v].weight0 = inf.Count > 0 ? inf[0].w / total : 1f;
            bw[v].boneIndex1 = inf.Count > 1 ? inf[1].bone : 0; bw[v].weight1 = inf.Count > 1 ? inf[1].w / total : 0f;
            bw[v].boneIndex2 = inf.Count > 2 ? inf[2].bone : 0; bw[v].weight2 = inf.Count > 2 ? inf[2].w / total : 0f;
            bw[v].boneIndex3 = inf.Count > 3 ? inf[3].bone : 0; bw[v].weight3 = inf.Count > 3 ? inf[3].w / total : 0f;
            // atlas uv: the app's uvs are top-left origin over the slot rect,
            // Unity's texture space is bottom-left
            uvs[v] = new Vector2((s.rx + m.uvs[v * 2] * s.rw) / doc.texW,
                                 1f - (s.ry + m.uvs[v * 2 + 1] * s.rh) / doc.texH);
        }
        var mesh = new Mesh { name = s.name };
        mesh.vertices = verts;
        mesh.uv = uvs;
        mesh.triangles = m.tris;   // winding is irrelevant: the flash shader culls nothing
        mesh.boneWeights = bw;
        var bind = new Matrix4x4[boneTf.Length];
        for (int i = 0; i < boneTf.Length; i++) bind[i] = boneTf[i].worldToLocalMatrix * root.localToWorldMatrix;
        mesh.bindposes = bind;
        if (s.tint != null && s.tint.Length == 4)
            mesh.colors = Enumerable.Repeat(new Color(s.tint[0], s.tint[1], s.tint[2], s.tint[3]), n).ToArray();
        mesh.RecalculateBounds();
        string meshPath = dir + "/" + s.name + ".mesh.asset";
        AssetDatabase.DeleteAsset(meshPath);
        AssetDatabase.CreateAsset(mesh, meshPath);

        var go = new GameObject(s.name);
        go.transform.SetParent(root, false);
        var smr = go.AddComponent<SkinnedMeshRenderer>();
        smr.sharedMesh = mesh;
        smr.bones = boneTf;
        smr.rootBone = root;
        smr.sharedMaterial = mat;
        smr.sortingOrder = order;
        smr.updateWhenOffscreen = true;   // bounds follow the deformation
        if (s.hidden) smr.enabled = false;
    }

    static string BonePath(RigDoc doc, int bone)
    {
        var parts = new List<string>();
        for (int i = bone; i > 0; i = doc.bones[i].parent)
            parts.Insert(0, doc.bones[i].name);
        return string.Join("/", parts);
    }

    static string SlotPath(RigDoc doc, RigSlot slot)
    {
        if (IsMeshed(slot)) return slot.name;   // skinned parts hang off the root
        var bonePath = BonePath(doc, slot.bone);
        return bonePath.Length == 0 ? slot.name : bonePath + "/" + slot.name;
    }

    static AnimationCurve Curve(RigAnim a, RigTrack tr, int comp, Func<float, float> convert)
    {
        var keys = new List<Keyframe>();
        for (int i = 0; i < tr.keys.Count; i++)
        {
            var k = tr.keys[i];
            float val = convert(k.v[comp]);
            var kf = new Keyframe(k.t, val);
            // tangents: ease = flat, linear = slope, stepped = jump
            var prev = i > 0 ? tr.keys[i - 1] : null;
            var next = i < tr.keys.Count - 1 ? tr.keys[i + 1] : null;
            kf.outTangent = OutTangent(k, next, val, convert, comp);
            kf.inTangent = prev == null ? 0 : InTangent(prev, k, val, convert, comp);
            keys.Add(kf);
        }
        // hold to full duration so all clips share loop length
        if (keys.Count > 0 && keys[^1].time < a.duration - 1e-4f)
            keys.Add(new Keyframe(a.duration, keys[^1].value, 0, 0));
        return new AnimationCurve(keys.ToArray());
    }

    static float OutTangent(RigKey k, RigKey next, float val, Func<float, float> convert, int comp)
    {
        if (next == null) return 0;
        if (k.curve == "stepped") return float.PositiveInfinity;
        if (k.curve == "linear")
            return (convert(next.v[comp]) - val) / Mathf.Max(next.t - k.t, 1e-5f);
        return 0;   // ease
    }

    static float InTangent(RigKey prev, RigKey k, float val, Func<float, float> convert, int comp)
    {
        if (prev.curve == "stepped") return float.PositiveInfinity;
        if (prev.curve == "linear")
            return (val - convert(prev.v[comp])) / Mathf.Max(k.t - prev.t, 1e-5f);
        return 0;   // ease
    }

    static void SetCurve(AnimationClip clip, string path, string prop, AnimationCurve curve)
    {
        clip.SetCurve(path, typeof(Transform), prop, curve);
    }
}
