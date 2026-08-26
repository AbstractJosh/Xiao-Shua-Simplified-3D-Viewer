# Xiao Shua's 3D Viewer

A 3D editor built around one gesture: **drop a 2D shape onto a solid, then push or pull it perpendicular to the surface.**

Existing 3D editors demand a lot of tool-specific knowledge before you can make a single change. This one starts you with an empty grid, a palette of ten primitives and a palette of 2D shapes. Drag a cube into the scene, drop a circle onto it, slide it around, set a depth, and it becomes a boss or a pocket. No modes, no sketch-plane ceremony.

---

## What it does

- **Drop** solids into the scene: cube, sphere, cylinder, cone, pyramid, prism, bean, tetrahedron, octahedron, dodecahedron. Pyramids and prisms take 3/4/5/6/8 sides.
- **Place** them by dragging: a ghost follows the ground plane and the object lands resting on the grid. Hold Shift while moving one to lift it instead.
- **Snap** corners, edges and faces to other objects while you drag, so two solids go flush rather than nearly flush.
- **Drop** a circle, rectangle, or polygon (3/4/5/6/8/10 sides) onto *any* object
- **Slide** it across the surface and resize it, before or after extruding
- **Extrude** to add material or **Intrude** to cut it away, perpendicular to the surface at that point
- **Lean** the created end face: tilt its plane on XYZ and slide it within that plane. The base of the extrusion stays welded to the host and the pillar follows.
- **Cut** with a plane you aim by XYZ position and XYZ tilt. Each half stays a live parametric object, base and features intact.
- **Stack** features - sketch on a face an earlier feature created
- **Export** the whole scene as `.glb` or `.obj`

## The document

The document is a **scene of parametric objects**:

```
Doc          = { objects: SceneObject[] }
SceneObject  = { base, transform, features[], cuts[] }
```

Every object is a base solid plus an ordered feature list plus a list of retained half-spaces, and the mesh is always *derived* by replaying CSG over that list. Change a radius after extruding and the solid re-evaluates.

Two decisions make the scene cheap:

**Everything is object-local.** Primitives are centred on the origin and stand along +Y; anchors, features and cuts are all stored in the object's own space. The transform enters exactly once, on export. Dragging an object across the scene therefore costs no boolean work at all - and its sketches, its pockets and its cut faces all travel with it, undo included.

**A cut destroys nothing.** Each half keeps the same base and the same features and differs only by one retained half-space, so the two halves reconstruct the original exactly and every feature on either half stays editable.

## Curved surfaces

Extrusion works on curved surfaces, not just flat faces. A square dropped on a sphere extrudes *radially* - its walls converge toward the centre and its top is a curved patch concentric with the sphere, not a flat cap.

This falls out of one representation rather than a special case:

> A surface feature is fully described by a closed ring of **(surface point, outward normal)** pairs.

On a flat face every normal is identical and sweeping that ring yields a straight prism. On a sphere each normal is its own radial direction and the very same sweep yields a converging frustum. On a cylinder wall they fan in one direction only. Curvature is not special-cased - it comes from each surface's `project()`, which also draws the on-surface outline and clamps dragging.

Depth is then measured *along the surface* by trimming the swept prism against an offset copy of the base solid:

```
extrude:  B U (P & B+d)
intrude:  B - (P - B-d)
```

Three things follow for free: no coplanar faces anywhere (the dominant cause of corrupted CSG output), through-holes when the depth exceeds the thickness, and the flat case reducing to the curved case.

The tilt/slide face is the one place that path is deliberately skipped. Once the end face has its own plane, that plane terminates the sweep exactly where the drag handle draws it; intersecting it with a constant-depth shell as well would shave off most of the tilt and leave the handle floating clear of the solid.

## Stack

React 19 - TypeScript - Vite - three.js - @react-three/fiber + drei - three-bvh-csg - zustand

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
| `npm run check` | Headless geometry, interaction, console and export suites - 572 assertions |
| `npx tsx scripts/sample-export.ts [dir]` | Write sample `.glb` / `.obj` files |
| `npx tsx scripts/palette-preview.ts [file]` | Standalone preview of the console palettes |

## Verification

The engine *and* the console are verified headlessly, without a browser: **572 assertions** across four suites - 63 geometry, 95 interaction, 380 console, 34 export - none of which settle for "something is truthy". A geometry assertion quotes the number it got beside the number it wanted; a console assertion quotes the markup it found.

The main instrument is **signed volume via the divergence theorem**: for a closed, consistently wound mesh it returns the true enclosed volume, so one number proves both that the boolean produced the right amount of material *and* that the result is watertight. A leaking or inside-out mesh cannot accidentally land on the analytic answer.

```
cube + circular boss    8.0846  vs analytic 8.0848
cube - circular pocket  7.9154  vs analytic 7.9152
cube - through hole     7.4361  vs analytic 7.4345
sphere boss top         every vertex at radius 1.2500, spread 2.47e-3
                        (the tessellation floor is 5.36e-3;
                         a flat cap would spread 4.90e-2)
GLB round-trip          export, reload, recompute: 8.0846
```

Every primitive is checked against its own analytic volume, which means checking it against the polygon it really is rather than against the smooth ideal - a 48-sided prism is not a cylinder, and a loose tolerance would bury a 0.3% modelling error:

```
hexagonal prism r0.9 h1.8   3.7880  exact
square pyramid  r1   h1.8   1.2000  exact
dodecahedron    R1.1        3.7071  exact hull, tolerance 1e-6
cylinder        r0.8 h2     4.0098  the 48-gon prism, under the true 4.0212
bean            r0.6 h1.2   2.2533  inscribed, 0.38% under the ideal
```

The newer surface area gets the same treatment. A 20 degree tilt lifts a boss's far edge to 1.6092 where an untilted one stops at 1.5000 - a rise of 0.1092, which is `r*tan(20 deg)` for the radius-0.3 outline that was tilted. A face slid 0.5 lands its centre exactly 0.5 off the axis and holds the same volume as the upright pillar, which is Cavalieri's principle and the proof that the walls followed the face rather than the cap detaching from them. A plane through a cube gives halves of 4.0000 and 4.0000; moved to x = 0.5 it gives 2.0000 and 6.0000; both pairs sum back to 8.0000.

`scripts/ui-check.ts` renders the console panels headlessly too, and at 380 assertions it is the
largest of the four suites. It starts where the app starts - an empty grid, 0 objects - and drives
the real stores the way a user drives them: drag four solids off the palette, drop a sketch, extrude,
tilt, slide, cut, undo the cut, redo it, rewind to the bare scene and replay forward. Every step
asserts on the markup that came back rather than merely that nothing threw. The run then ends by
rendering ObjectPanel against all ten solids and the Inspector against every anchor kind crossed with
all three sketch shapes, flat and extruded - which is where most of those 380 come from. That suite
is also the only thing that exercises the "something is selected" branches at all: zustand hands a
server render its *initial* state, so `ui-check` collapses the two snapshots before rendering.

`npm run check` also covers hit classification across a multi-object scene (the nearer object wins on *world* distance, since each object's ray is rebased into its own space first), anchors on a prism wall and a cylinder barrel, snapping two boxes flush from a 0.1 gap and leaving a 0.21 gap alone, `planeSeparates` refusing a plane that shaves a 0.0002 sliver, radial normals fanning 26.33 degrees across a footprint, sketch clamping, polygon icon geometry, vertex welding on export (a cube welds to 24 vertices, not 8 - hard edges survive), and the world-space bake that puts every object in the exported file at its own placement.

## Layout

```
src/geometry/    types - surfaces - solids - outline - prism - brush - cut - snap
                 volume - transform - evaluate - exporters
src/store/       docStore (scene + undo) - toolStore - evalStore
src/viewport/    Viewport - SceneObjects - SketchLayer - FaceHandle
                 CutPlaneGizmo - PlacingSolidPreview - picking - snapping
src/console/     SolidPalette - ShapePalette - ToolsPanel - ObjectPanel
                 Inspector - SceneTree - ExportPanel - Field
                 solidIcons - ngon
scripts/         headless check suites and preview generators
```

## Known limits

- Sketches on faces created by earlier features use a locally-flat approximation; anchoring parametrically to generated geometry is the persistent-naming problem and is out of scope here. Base-primitive surfaces get the exact treatment.
- Outlines must be convex - the prism caps use a triangle fan. Concave shapes would need earcut triangulation.
- Box offsets ignore corner rounding, which is exact across the faces where sketches live.
- Pocket depth on a sphere is capped short of the centre, where radial rays would converge and fold the tool through itself.
- Changing a prism's or pyramid's side count discards that object's sketches: a face index means something different on a hexagon than on an octagon. The panel asks first.
- A cut through a strongly non-convex solid can leave two closed halves that are not physically disjoint, and we still report a separation. Both halves remain valid solids that reconstruct the original, so the parametric result stays sound even where the physical reading is arguable.
