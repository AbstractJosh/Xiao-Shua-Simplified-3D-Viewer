# Xiao Shua's 3D Viewer

A 3D editor built around one gesture: **drop a 2D shape onto a solid, then push or pull it perpendicular to the surface.**

Existing 3D editors demand a lot of tool-specific knowledge before you can make a single change. This one starts you with an empty grid, a palette of ten primitives and a palette of 2D shapes. Drag a cube into the scene, drop a circle onto it, slide it around, set a depth, and it becomes a boss or a pocket. No modes, no sketch-plane ceremony.

---

## What it does

- **Drop** solids into the scene: cube, sphere, cylinder, cone, pyramid, prism, bean, tetrahedron, octahedron, dodecahedron. Pyramids and prisms take 3/4/5/6/8 sides.
- **Place** them by dragging: a ghost follows the ground plane and the object lands resting on the grid. Hold Shift while moving one to lift it instead.
- **Snap** corners, edges and faces to other objects while you drag, so two solids go flush rather than nearly flush.
- **Aim** with a gizmo: three coloured arrows and a ring on the selected object. Left-drag an arrow to slide along that axis, right-drag the same arrow to resize along it, drag the ring to scale the whole solid.
- **Drop** a circle, rectangle, or polygon (3/4/5/6/8/10 sides) onto *any* object
- **Slide** it across the surface and resize it, before or after extruding
- **Extrude** perpendicular to the surface at that point: one signed depth, positive out and negative in, so a boss and a pocket are the two ends of one slider
- **Push or pull** it in the viewport instead, from the sketch gizmo's third arrow -- the one facing away from the face
- **Lean** the created end face: tilt its plane on XYZ and slide it within that plane. The base of the extrusion stays welded to the host and the pillar follows.
- **Cut** with a plane you place with that same gizmo and tilt by XYZ. Each half stays a live parametric object, base and features intact.
- **Stack** features - sketch on a face an earlier feature created
- **Select** several at once with a box: left-drag from empty space and everything whose gizmo falls inside is picked up as the box grows. Hold Shift to add its catch to what is already selected.
- **Merge** any number of objects into one. Shift-click or box-select to gather them, then Merge in the Scene section: they become a single object with a single gizmo.
- **Copy** an object with Ctrl+C and **paste** it with Ctrl+V, or right-click it for the same two, plus **Save as custom object**.
- **Keep** what you build: saved objects land in the Clipboard panel as `Custom 1`, `Custom 2`... Rename them there, and drag a tile back into the scene to place a full copy -- sketches, cuts, merged parts and the rotation it was saved at.
- **Inspect** a saved object on its tile: each one is a live turntable seen from 30 degrees above, turning about the same point its gizmo sits on. Sweep the pointer across it to spin it a full revolution per tile width; vertical movement is ignored.
- **Export** the whole scene as `.glb` or `.obj`

## The document

The document is a **scene of parametric objects**:

```
Doc          = { objects: SceneObject[] }
SceneObject  = { base, transform, features[], cuts[], parts[] }
```

Every object is a base solid plus any merged-in parts, plus an ordered feature list plus a list of retained half-spaces, and the mesh is always *derived* by replaying CSG over that list. Change a radius after extruding and the solid re-evaluates.

Two decisions make the scene cheap:

**Everything is object-local.** Primitives are centred on the origin and stand along +Y; anchors, features and cuts are all stored in the object's own space. The transform enters exactly once, on export. Dragging an object across the scene therefore costs no boolean work at all - and its sketches, its pockets and its cut faces all travel with it, undo included.

**A merge destroys nothing either.** Merged solids become `parts` inside their host -- each one a whole `SceneObject` in the host's local space, keeping its own base, features, cuts and even its own parts. Only its transform is rewritten, from world space into the host's, so it does not move a millimetre. The union is slot zero of the evaluator's prefix cache, so a merged object rebuilds its weld only when the merge changes, not when a feature on top of it is dragged. Recursion falls out of the shape: merging something that was itself merged nests rather than flattening.

**A cut destroys nothing.** Each half keeps the same base and the same features and differs only by one retained half-space, so the two halves reconstruct the original exactly and every feature on either half stays editable.

## The gizmo

The selected object carries three arrows in fully saturated axis colours - X red, Y green, Z blue - and a ring around their origin. Exactly one gizmo is on screen at a time: the selected object's, which stands down while the cut tool is armed so the plane's own arrows are unambiguous.

The arrows are small and drawn over solids in the same warm grey as everything else, so they win on colour rather than on size, and the proportions thicken as the whole shrinks rather than scaling with it - a shaft that reads at 170 pixels is a hairline at 70. Those colours are also the console's `--axis-x/y/z`, tinting the X/Y/Z letters of every Vec3 row: a material cannot read a CSS custom property, so the values are duplicated, and `ui-check` reads the stylesheet and fails if the two ever drift apart.

| Gesture | Does |
| --- | --- |
| Left-drag an arrow | Slides along that axis, snapping as it goes |
| Right-drag the same arrow | Resizes along that axis |
| Drag the ring | Scales every dimension at once |
| Right-drag the ring | Turns about the axis nearest the camera |
| Drag a sketch's arrow | Slides it along that surface tangent |
| Drag a sketch's ring | Scales the outline about its own centre |

Three decisions are load-bearing.

**The arrows sit in the object's own frame, not the world's.** A box's width is measured along its own X, so an arrow that resized along world X would stretch the wrong dimension the moment the object was rotated. It pays off on the cut plane too, where the local +Y arrow is the plane's normal - the one direction a blade actually wants to be nudged along.

**A drag asks for surface travel, not for a number.** `resizeAlongAxis` takes how far the solid's *skin* should move, and converts. A box side is a full extent about a centred origin so it changes by twice the travel; a radius already is the half-extent and changes one for one. Ask for the number directly instead and the same gesture slips at half speed on a cylinder and double on a box.

**A turn runs about one of the target's own axes, chosen once.** The ring is drawn in the camera's plane, so a right-drag round it reads as a twist of the screen; the axis that actually produces that twist is whichever of the target's three best faces the viewer, signed toward them. Picking it once at the grab rather than each frame matters -- re-picked, it would swap mid-turn as the object rotated past 45 degrees and the target would visibly jump onto a different axis part-way through one gesture. The pointer's angle is the one quantity in the gizmo that *is* accumulated, because an angle wraps at +/-pi and a turn must carry on past half a circle; that is safe where the axis drags' accumulation was not, since what accumulates is the pointer's own angle and the target's rotation is still derived from the grab every frame. While a turn runs the arrows step aside -- they point along the axes a turn is moving -- and a wedge shows the swept angle, with the figure in degrees pinned beside it. That figure is a DOM node rather than text in the scene: it wants to stay upright, legible and one size however the camera is turned, which is exactly what 3D text is bad at, so the dial projects its own centre to screen pixels each frame and the readout only has to move.

Every rotation field in the panels carries a reset -- one per axis and one for all three -- because zero is the value people want most often and the hardest to hit by dragging, and because a rotation built by the ring lands on Euler triples like `(pi, 0, pi)` that are a chore to undo a row at a time. Each button stands down when its axis is already at rest: a live control that costs an undo entry and changes nothing is worse than no control.

**The axis snap is its own solve, not the general one filtered.** `snapTranslation` finds the nearest target in any direction and returns a three-axis correction. An arrow may only slide along its own axis, so taking that correction and discarding the components it is not allowed to use would leave the solid *not touching* what the indicator claims it caught. `snapAlongAxis` puts the constraint inside the search: every candidate is an offset along the axis, and it counts only if the corner genuinely arrives.

**An arrow drag has exactly one origin**, pinned where the gesture started, serving as both the origin of the axis line the pointer is measured against and the position the travel is added to. Keeping two - reading the parameter against the target's *live* centre while adding travel to where it started - is a feedback loop that looks correct for one frame and then makes the origin chase the object it is moving: a perfectly still pointer flips the solid between two positions every other frame. `gizmoDrag.ts` exists to make that one value structural rather than a rule to remember.

The ring clamps its factor once, against the tightest bound any single dimension imposes. Clamping each dimension separately is what would let a long box hit the length ceiling and keep fattening - a uniform scale that quietly changes the shape's proportions.

A selected **sketch** gets a gizmo of its own: three arrows, in amber, magenta and cyan rather than any of the X/Y/Z three, because it does something genuinely different. A sketch lives in its host surface's parameter space -- that is what lets it survive the solid being resized -- so the two moves *across* the surface are the two the amber and magenta arrows make. On a box face they lie in the face; on a sphere they lie in the tangent plane at the sketch and swing round as it is dragged. `slideAnchor` is what makes that work on a curved host: the pointer is read against a straight world-space line, and the travel is handed to the surface, which re-seats it on itself -- so a slide across a sphere follows the curvature instead of flying off along the tangent. Run off the edge of the patch and it refuses rather than wrapping onto the next face, because the gesture promised a slide *along* this one.

Those two arrows lie along the **outline's own axes**, not the surface's raw U and V: the frame is spun by the sketch's own rotation, the same rotation `sampleOutline` turns the shape by. That is what makes their right-drag honest -- it stretches the dimension the arrow is pointing down, so on a rectangle spun thirty degrees the width axis is spun with it -- and it pays off on the left button too, where the arrows lie along the edges of the shape being dragged rather than crossing them diagonally. A slide is stored in the surface's (u, v), so the travel comes back through `outlineAxis` to be written down; that function lives beside `sampleOutline` because it *is* that rotation applied to the unit axes, and the two disagreeing would show up as a sketch sliding sideways when dragged along its own edge. On a circle or a polygon, which have one radius between them, both arrows drive it -- there is no way to write a wider-than-tall circle into a `Shape2D`, and an arrow that moved something the panel could not show would be worse than one that shares.

The cyan arrow is the odd one, and deliberately so. It faces **away from the surface**, which is the one direction a sketch cannot move along and the only one it can sweep along -- so it has no slide, and both buttons on it drag the feature's depth. That is also the only handle on the gizmo whose drag changes what the *solid* is rather than where the sketch sits on it. Pull it away from the face and the projection rises into a boss; push it back through and the same number goes negative and sinks into a pocket, passing through the flat projection it started as on the way.

**Extrude and intrude are one operation.** They were two modes and a positive magnitude, which meant "extrude at depth -0.3" and "intrude at depth 0.3" named the same solid and every consumer had to consult both fields to know which. A feature now carries one signed depth: positive adds material, negative cuts it away, zero is inert. What survives as a direction is `FeatureOp`, derived from the sign wherever the geometry genuinely branches on it -- and it branches asymmetrically, which is the one thing the collapse could not simplify away: a boss may stand a couple of thicknesses proud of a face where a pocket that reached as far would be a hole out the other side. So `depthLimits` answers one direction at a time, the slider is not symmetric about zero, and `clampDepth` keeps the sign it was given rather than clamping a magnitude and handing back a pocket turned into a boss.

Its ring scales the outline in place - a circle's radius, a rectangle's width and height together - clamped against the same bound the Inspector's own Radius and Width fields offer. The ring sits well inside the arrowheads and carries a thin hit band, because a broad belt two thirds of the way out ran straight through the fattest part of the arrows' grab volumes and stole presses meant for them. Where the two still cross - unavoidable, since a billboarded circle crosses all three axes whatever the camera angle - the raycast bias hands the tie to the arrow.

Exactly one gizmo is ever on screen, and the finer selection wins it: an armed cut plane outranks a selected object, and a selected sketch outranks the object hosting it -- the same precedence the Delete key already uses. A **selection box** in flight outranks all three and leaves the screen clear: it is re-deciding the selection several times a second, and a gizmo hopping between solids as the box grows would read as three objects being dragged at once.

The console keeps every field. The gizmo is for aiming against the scene, where the answer is visible; the panel is for typing an exact number. The one place they do not overlap is the cut plane, which lost its Position sliders entirely - a plane is placed against the solids it is about to sever, and that is the one thing a slider cannot show you. Tilt stayed, because an angle is far easier to type than to drag.

## Where a control lives

The app is split by what a control is *about*, and nothing appears in both halves.

**The bar across the top** holds the tools: Snap, Cut, and Export. None of them describe the scene -- they are modes and actions that apply to whatever is selected. Engaging one is a single click on its button; its parameters sit behind the caret beside it, in a panel that opens under the tool. Arming the cut plane opens its panel with it, because a plane you cannot position is not a tool.

**The console on the right** holds the document, in two tabs. **View** is everything that is true of the scene whatever is selected -- Clipboard, Solids, Shapes, Scene -- and every one of those is usable with nothing selected at all, which is the state the app opens in. **Edit** is the three panels that only mean anything once something *is* selected: where it sits, how big it is, and what its sketches do. Seven panels in one column was more than a screen of them, so the Inspector and the scene tree lived below the fold and the panels that were open were rarely the ones in use. The tab strip is sticky rather than scrolling away with the panels, because a switch you have to scroll back up to find is a switch that gets used once. Selecting an object fills the Edit tab and changes nothing on View, so the Edit tab carries a dot to say so -- a dot rather than an automatic switch, since a user placing five solids in a row would otherwise have the palette pulled out from under them four times.

Within View, the Clipboard sits above the fixed catalogue of primitives: what you saved is yours and specific to this scene, so it should not be ten rows of scrolling away. The Solids list below it is open but four rows tall -- all ten at once pushed the scene tree off the bottom.

**The console does not scroll sideways, and the width is what guarantees it.** `overflow-y: auto` alone makes the other axis compute to `auto` as well, so the console used to be a horizontally scrolling element too -- and every hover tip is a 240px absolutely positioned bubble that is `visibility: hidden` rather than `display: none`, which keeps its box and therefore keeps its overflow. A dot beside a long heading put a quarter of that bubble past the right edge, permanently, and the console grew a scrollbar for something nobody could see. The width now leaves room for the widest bubble beside the longest heading in the console, and `overflow-x: clip` makes it structural: `clip` is not a scrolling value, so unlike `hidden` it does not turn the box into a scroll container on that axis and does not disturb the vertical scroll.

**The clipboard shows three models, not all of them.** Each live thumbnail is a WebGL context, and a browser hands out somewhere between eight and sixteen before it starts evicting the oldest -- which on this page would mean the main viewport going black because a shelf scrolled. So the row scrolls sideways, three tiles wide, and the three *most visible* tiles get models; the rest show a circular loading bar until they arrive. It is a scrolling row rather than a wrapping grid for the same reason: a wrapped fourth tile would sit below the first, permanently in view and permanently unable to have a model. Meshes are cached behind the cap, bounded and disposed on eviction, so sweeping back and forth over a shelf does not re-replay every object it passes.

**The left button draws a selection box, so orbit moved off it.** A drag from empty space is now a 2D rubber band, and everything whose **gizmo** falls inside it is selected -- live, as the box is drawn, through the same lit-from-within material a click gives, so there is no second highlight to keep in step with the first. The gizmo is the test rather than the silhouette because it is the one dot already on screen standing for the whole object -- dead centre of a merged assembly as much as of a bare solid -- so "did the box catch it" is a question that can be answered by looking. A box drawn over the *body* of a solid whose centre is outside it takes nothing, which is the price of a rule you can see. Shift makes the box additive, the way Shift already gathers objects one at a time; Escape mid-drag puts back the selection it started from. Orbit takes the **middle** button, or the left one with **Alt** held for a mouse or trackpad with no wheel to press; pan is unchanged on the right, and the wheel still zooms.

Which button orbits is written onto OrbitControls before *every* press rather than once at startup: the controls read that map at pointer-down and never again during a drag, so Alt has to be answered per press, and the ref is empty when the effect that would set it first runs. The box's own press is claimed with a rule in `claimsPress` that lists, one clause each, every gesture the left button already meant -- and it decides whether the press landed on something in the scene by reading the hit list R3F fills in *before* it dispatches to any of the scene's own handlers. That is what keeps the marquee out of all six of those press handlers; announced by each instead, the one handler somebody forgets to tell would start a box in the middle of a gizmo drag.

**The right-click menu is on objects only.** The right button already means two things in the viewport -- pan the camera, and resize or turn from the gizmo -- so the menu opens on a right *click*, judged against a few pixels of slop, and only where that click landed on a solid. Paste is dimmed rather than hidden when the clipboard is empty, so the menu keeps its height between openings and still says that pasting is something it does.

**The clipboard is not the document.** Neither the copied object nor the saved shelf lives in `Doc`, because neither is part of the scene: copying something and then pressing undo has to rewind the last edit, not the copy. Ids are reminted on the way OUT rather than on the way in, so what is stored stays a faithful record of what was taken and two drops of one tile are two objects.

**Position & Rotation is one panel, not one per target.** Both things that carry a placement -- a solid, and the cut plane -- are placed the same way, with the same gizmo, against the same scene. Giving each its own copy of two XYZ fields would have meant two sets of rows that behave identically and drift apart the first time one gained a control. An armed cut plane takes the panel, exactly as it takes the gizmo, and the rotation is named "Tilt" while it does.

The cut tool has no panel anywhere. Its numbers are a placement like any other, so they are in Position & Rotation; its two ACTIONS -- Apply cut and Reset plane -- sit in the bar beside the switch that armed them, a short travel from the gizmo that just aimed the plane rather than at the end of a scroll through panels describing the document. They appear only while it is armed, so the bar is no wider for anyone not cutting. The guide square is sized by the gizmo's ring alone; that slider was the last reason the tool had a settings panel at all.

Explanations are on hover. The console used to carry its prose inline -- every tool and every field with a caveat spent four or five permanent lines on it, which reads well once and then never again while pushing the controls below the fold. The text is still there, behind the dot beside the thing it describes, and still in the markup so `ui-check` can assert on it.

## Curved surfaces

Extrusion works on curved surfaces, not just flat faces. A square dropped on a sphere extrudes *radially* - its walls converge toward the centre and its top is a curved patch concentric with the sphere, not a flat cap.

This falls out of one representation rather than a special case:

> A surface feature is fully described by a closed ring of **(surface point, outward normal)** pairs.

On a flat face every normal is identical and sweeping that ring yields a straight prism. On a sphere each normal is its own radial direction and the very same sweep yields a converging frustum. On a cylinder wall they fan in one direction only. Curvature is not special-cased - it comes from each surface's `project()`, which also draws the on-surface outline and clamps dragging.

Depth is then measured *along the surface* by trimming the swept prism against an offset copy of the base solid:

```
depth > 0:  B U (P & B+d)
depth < 0:  B - (P - B-d)
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
| `npm run typecheck` | Types only, `src` **and** the check suites |
| `npm run check` | Headless geometry, interaction, console and export suites - 813 assertions |
| `npx tsx scripts/sample-export.ts [dir]` | Write sample `.glb` / `.obj` files |
| `npx tsx scripts/palette-preview.ts [file]` | Standalone preview of the console palettes |

## Verification

The engine *and* the console are verified headlessly, without a browser: **813 assertions** across four suites - 177 geometry, 95 interaction, 507 console, 34 export - none of which settle for "something is truthy". A geometry assertion quotes the number it got beside the number it wanted; a console assertion quotes the markup it found.

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

`scripts/ui-check.ts` renders the bar and the console panels headlessly too, and at 507 assertions it is the
largest of the four suites. It starts where the app starts - an empty grid, 0 objects - and drives
the real stores the way a user drives them: drag four solids off the palette, drop a sketch, extrude,
tilt, slide, cut, undo the cut, redo it, rewind to the bare scene and replay forward. Every step
asserts on the markup that came back rather than merely that nothing threw. The run then ends by
rendering ObjectPanel against all ten solids and the Inspector against every anchor kind crossed with
all three sketch shapes, flat and extruded - which is where most of those 507 come from. That suite
is also the only thing that exercises the "something is selected" branches at all: zustand hands a
server render its *initial* state, so `ui-check` collapses the two snapshots before rendering.

`npm run check` also covers hit classification across a multi-object scene (the nearer object wins on *world* distance, since each object's ray is rebased into its own space first), anchors on a prism wall and a cylinder barrel, snapping two boxes flush from a 0.1 gap and leaving a 0.21 gap alone, `planeSeparates` refusing a plane that shaves a 0.0002 sliver, radial normals fanning 26.33 degrees across a footprint, sketch clamping, polygon icon geometry, vertex welding on export (a cube welds to 24 vertices, not 8 - hard edges survive), and the world-space bake that puts every object in the exported file at its own placement.

## Layout

```
src/geometry/    types - dimensions - surfaces - solids - outline - prism
                 brush - cut - snap - volume - transform - evaluate - exporters
src/store/       docStore (scene + undo) - toolStore - evalStore - libraryStore
src/viewport/    Viewport - SceneObjects - SketchLayer - FaceHandle
                 TransformGizmo - SketchGizmo - RotationDial - gizmoDrag
                 rotationIndicator - axisColors - CutPlaneGizmo - ObjectMenu
                 PlacingSolidPreview - dropCache - picking - snapping
                 SelectionMarquee - marquee
src/console/     NavBar - NavTool - NavTools - ExportTools - Tip
                 Console (the View / Edit tabs)
                 ClipboardPanel - ObjectThumbnail - thumbnailGeometry
                 SolidPalette - ShapePalette - PlacementPanel - ObjectPanel
                 Inspector - SceneTree - Field - solidIcons - navIcons - ngon
scripts/         headless check suites and preview generators
```

## Known limits

- Sketches on faces created by earlier features use a locally-flat approximation; anchoring parametrically to generated geometry is the persistent-naming problem and is out of scope here. Base-primitive surfaces get the exact treatment.
- Outlines must be convex - the prism caps use a triangle fan. Concave shapes would need earcut triangulation.
- Box offsets ignore corner rounding, which is exact across the faces where sketches live.
- Pocket depth on a sphere is capped short of the centre, where radial rays would converge and fold the tool through itself.
- Changing a prism's or pyramid's side count discards that object's sketches: a face index means something different on a hexagon than on an octagon. The panel asks first.
- A clipboard thumbnail is framed on the object's GIZMO point, not on the middle of its bounding box, so it turns about the same point it turns about in the scene. An object hanging well off to one side of its gizmo -- a small bead merged onto the end of a long arm -- therefore sits off-centre in its tile, which is the honest picture of where its pivot is.
- A clipboard thumbnail's loading bar is indeterminate. Building one is a single synchronous replay of the object's features and cuts, so there is no fraction to report -- it has either not started or finished, and a bar that pretended otherwise would be inventing progress.
- The Clipboard is session-scoped: saved objects survive every edit, undo and reset, but not a reload. Persisting them would mean deciding what happens to a shelf saved by an older version of the document format, which is a separate question from having a shelf at all.
- A merged object sizes as one uniform Size rather than per axis. Its parts sit at their own angles and a `BaseSolid` carries no scale, so "this assembly, but wider" cannot be written down -- and once merged, an individual part's own width is no longer reachable, since there is no unmerge yet.
- A cut through a strongly non-convex solid can leave two closed halves that are not physically disjoint, and we still report a separation. Both halves remain valid solids that reconstruct the original, so the parametric result stays sound even where the physical reading is arguable.
