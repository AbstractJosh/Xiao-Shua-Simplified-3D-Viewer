# Verification

Part of [Xiao Shua's 3D Editor](../README.md).

How the engine and the console are checked without a browser.

## Verification

The engine *and* the console are verified headlessly, without a browser: **4,957 assertions** across six suites - 853 geometry, 691 interaction, 3,150 console, 85 export, 90 import, 88 persistence - none of which settle for "something is truthy". A geometry assertion quotes the number it got beside the number it wanted; a console assertion quotes the markup it found.

The main instrument is **signed volume via the divergence theorem**: for a closed, consistently wound mesh it returns the true enclosed volume, so one number proves both that the boolean produced the right amount of material *and* that the result is watertight. A leaking or inside-out mesh cannot accidentally land on the analytic answer.

```
cube + circular boss    8.0846  vs analytic 8.0848
cube - circular pocket  7.9154  vs analytic 7.9152
cube - through hole     7.4361  vs analytic 7.4345
sphere boss top         every vertex at radius 1.2500, spread 2.47e-3
                        (the tessellation floor is 5.36e-3;
                         a flat cap would spread 4.90e-2)
GLB round-trip          export, reload, recompute: 8.0846
STL round-trip          export, reload, recompute: 8.0846
STEP topology           cube + boss: 1 solid, 55 faces, and every
                        edge walked by exactly two of them, once
                        each way - which is the whole difference
                        between a solid and faces that touch
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

`scripts/ui-check.ts` renders the bar and the console panels headlessly too, and at 3,150 assertions it is the
largest of the five suites. It starts where the app starts - an empty grid, 0 objects - and drives
the real stores the way a user drives them: drag four solids off the palette, drop a sketch, extrude,
tilt, slide, cut, undo the cut, redo it, rewind to the bare scene and replay forward. Every step
asserts on the markup that came back rather than merely that nothing threw. The run then ends by
rendering ObjectPanel against all ten solids and the Inspector against every anchor kind crossed with
all three sketch shapes, flat and extruded - which is where most of those come from. That suite
is also the only thing that exercises the "something is selected" branches at all: zustand hands a
server render its *initial* state, so `ui-check` collapses the two snapshots before rendering.

The mirror is checked the hard way, against a reflection that shares no code with it: the object's evaluated mesh is carried to its own world centre, one coordinate is negated, the winding is put back, and the result is compared with what the document rewrite produced -- by **ray parity over sampled points** rather than by a boolean, since intersecting a solid with a copy of itself is every coplanar-face degeneracy at once and the CSG library reports anywhere from 50% to 100% overlap depending on the primitive. Every base is run through all three axes, and so is a turned box wearing a spun boss, a sphere wearing a spun pocket, a cone wearing a boss that is both tilted and slid, a cut solid, a drilled one, a torched one, a welded assembly and an imported wedge with no symmetry at all. Two more claims are pinned beside them: the point the gizmo sits on does not move, and mirroring twice returns the document to the same numbers rather than merely to the same picture.

`npm run check` also covers hit classification across a multi-object scene (the nearer object wins on *world* distance, since each object's ray is rebased into its own space first), anchors on a prism wall and a cylinder barrel, snapping two boxes flush from a 0.1 gap and leaving a 0.21 gap alone, `planeSeparates` refusing a plane that shaves a 0.0002 sliver, radial normals fanning 26.33 degrees across a footprint, sketch clamping, polygon icon geometry, vertex welding on export (a cube welds to 24 vertices, not 8 - hard edges survive), and the world-space bake that puts every object in the exported file at its own placement. The STEP suite reads the written file back as text: every entity id unique, every reference resolved, every `EDGE_CURVE` walked by exactly two `ORIENTED_EDGE`s in opposite directions, a drilled solid carrying its hole as an inner bound, and two objects arriving as two solid bodies rather than one shell wrapped round both.
