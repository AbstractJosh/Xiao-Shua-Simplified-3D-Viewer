# Xiao Shua's 3D Viewer

A 3D editor built around one gesture: **drop a 2D shape onto a solid, then push or pull it perpendicular to the surface.**

Existing 3D editors demand a lot of tool-specific knowledge before you can make a single change. This one starts you with a solid in a viewport and a console of 2D shapes. Drag a circle onto the cube, slide it around, set a depth, and it becomes a boss or a pocket. No modes, no sketch-plane ceremony.

---

## What it does

- **Drop** a circle, rectangle, or polygon (3/4/5/6/8/10 sides) from the console onto the object
- **Slide** it across the surface and resize it, before or after extruding
- **Extrude** to add material or **Intrude** to cut it away, perpendicular to the surface at that point
- **Stack** features — sketch on a face an earlier feature created
- **Export** the result as `.glb` or `.obj`

The document is a **parametric feature tree**: a base solid plus an ordered list of features. The mesh is always *derived* by replaying CSG over that list, so every feature stays editable. Change a radius after extruding and the solid re-evaluates.

## Curved surfaces

Extrusion works on curved surfaces, not just flat faces. A square dropped on a sphere extrudes *radially* — its walls converge toward the centre and its top is a curved patch concentric with the sphere, not a flat cap.

This falls out of one representation rather than a special case:

> A surface feature is fully described by a closed ring of **(surface point, outward normal)** pairs.

On a flat face every normal is identical and sweeping that ring yields a straight prism. On a sphere each normal is its own radial direction and the very same sweep yields a converging frustum. Curvature is not special-cased — it comes from each surface's `project()`, which also draws the on-surface outline and clamps dragging.

Depth is then measured *along the surface* by trimming the swept prism against an offset copy of the base solid:

```
extrude:  B ∪ (P ∩ B⁺ᵈ)
intrude:  B − (P − B⁻ᵈ)
```

Three things follow for free: no coplanar faces anywhere (the dominant cause of corrupted CSG output), through-holes when the depth exceeds the thickness, and the flat case reducing to the curved case.

## Stack

React 19 · TypeScript · Vite · three.js · @react-three/fiber + drei · three-bvh-csg · zustand

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck and production build |
| `npm run typecheck` | Types only |
| `npm run check` | Headless geometry, interaction, and export suites |

## Verification

The geometry engine is verified headlessly, without a browser. The main instrument is **signed volume via the divergence theorem**: for a closed, consistently wound mesh it returns the true enclosed volume, so one number proves both that the boolean produced the right amount of material *and* that the result is watertight. A leaking or inside-out mesh cannot accidentally land on the analytic answer.

```
cube + circular boss   8.0846  vs analytic 8.0848
cube - circular pocket 7.9154  vs analytic 7.9152
sphere boss top        every vertex at radius 1.2500, spread 2.5e-3
                       (a flat cap would spread 4.9e-2)
GLB round-trip         export, reload, recompute: 8.0846
```

`npm run check` also covers hit classification, radial normals fanning across a footprint, sketch clamping, polygon icon geometry, and vertex welding on export.

## Layout

```
src/geometry/    types · surfaces · outline · prism · brush · evaluate · exporters
src/store/       docStore (document + undo) · evalStore
src/viewport/    Viewport · SolidMesh · SketchLayer · picking
src/console/     ShapePalette · Inspector · FeatureList · ExportPanel
scripts/         headless check suites and preview generators
```

## Known limits

- Sketches on faces created by earlier features use a locally-flat approximation; anchoring parametrically to generated geometry is the persistent-naming problem and is out of scope here. Base-primitive surfaces get the exact treatment.
- Outlines must be convex — the prism caps use a triangle fan. Concave shapes would need earcut triangulation.
- Box offsets ignore corner rounding, which is exact across the faces where sketches live.
- Pocket depth on a sphere is capped short of the centre, where radial rays would converge and fold the tool through itself.
