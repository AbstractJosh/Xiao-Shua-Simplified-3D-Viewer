/**
 * Core document model. Everything the editor draws is DERIVED from a `Doc`.
 *
 * This file is the plain-data layer: no three.js, no React, no store. Anything
 * that needs a matrix lives in transform.ts, so a `Doc` stays trivially
 * serialisable and cheap to diff for the evaluator's prefix cache.
 */

export type Vec3 = [number, number, number]
export type Vec2 = [number, number]

/** A closed, convex 2D outline drawn in a surface's tangent frame. */
export type Shape2D =
  | { type: 'circle'; r: number }
  | { type: 'rect'; w: number; h: number }
  | { type: 'ngon'; r: number; sides: number }

export type ShapeKind = Shape2D['type']

/**
 * Box faces, ordered to match THREE.BoxGeometry's group order.
 * 0:+X  1:-X  2:+Y  3:-Y  4:+Z  5:-Z
 */
export type BoxFace = 0 | 1 | 2 | 3 | 4 | 5

/**
 * Which way a feature's depth sweeps.
 *
 * NOT a document field. A feature carries one SIGNED depth, because outward and
 * inward are the two ends of one number rather than two modes -- the moment they
 * were a mode as well, "extrude at depth -0.3" and "intrude at depth 0.3" named
 * the same solid, and every consumer had to remember to consult both. What is
 * left is a direction, derived from the sign wherever the geometry needs to know
 * which way it is cutting.
 *
 * It stays a named type because the surface layer genuinely branches on it, and
 * asymmetrically: how far a feature may reach outward is not how far it may
 * reach in, so `maxDepth` has to be asked one direction at a time.
 */
export type FeatureOp = 'extrude' | 'intrude'

/** The direction a signed depth sweeps. Zero is inert, and reads as outward. */
export function sweepOp(depth: number): FeatureOp {
  return depth < 0 ? 'intrude' : 'extrude'
}

export type PlatonicKind = 'tetrahedron' | 'octahedron' | 'dodecahedron'

/**
 * Every primitive is CENTRED ON THE LOCAL ORIGIN and stands with its axis along
 * +Y. Holding that invariant means the object transform is the only thing that
 * ever places a solid, so anchors, features and cuts -- all stored in local
 * space -- survive being moved, rotated, undone and redone.
 */
export type BaseSolid =
  | { kind: 'box'; size: Vec3 }
  | { kind: 'sphere'; radius: number }
  | { kind: 'cylinder'; radius: number; height: number }
  | { kind: 'cone'; radius: number; height: number }
  /** "Bean": `height` is the cylindrical mid-section only, caps sit outside it. */
  | { kind: 'capsule'; radius: number; height: number }
  | { kind: 'pyramid'; radius: number; height: number; sides: number }
  | { kind: 'prism'; radius: number; height: number; sides: number }
  | { kind: 'platonic'; solid: PlatonicKind; radius: number }
  /**
   * A model read out of a file. `meshId` tickets the triangles, which live in
   * `meshLibrary` -- see the note there for why they are not in the document.
   *
   * `size` is the box the model fills, and it works exactly like a box's: the
   * stored triangles are normalised to a unit box, so this multiplies straight
   * through. An import is the one primitive whose three extents are genuinely
   * independent of each other, which is what a box already is -- so the gizmo
   * arrows, the Width/Height/Depth fields and the uniform-scale ring all treat
   * the two the same way, and none of them needed a case for this.
   *
   * `label` rides along rather than being looked up, so `solidLabel` stays a
   * pure function of the document and this file goes on importing nothing.
   */
  | { kind: 'mesh'; meshId: string; label: string; size: Vec3 }

export type SolidKind = BaseSolid['kind']

/**
 * The kinds the palette can build from nothing but a size.
 *
 * Everything except an import, which needs a file: `defaultBaseFor` can answer
 * for any of these and cannot answer for a mesh, and saying so in the type is
 * what keeps a row for it from ever appearing in the catalogue.
 */
export type PaletteKind = Exclude<SolidKind, 'mesh'>

/**
 * WHERE a sketch sits, stored in the surface's own parameter space rather than
 * object coordinates. Resizing the base then carries its sketches along instead
 * of leaving them floating in space.
 *
 * `derived` is the fallback for a hit on geometry produced by an earlier
 * feature, where no analytic parameterisation exists. It is treated as flat.
 */
export type SurfaceAnchor =
  | { on: 'box-face'; face: BoxFace; u: number; v: number } // u,v normalised to -1..1
  | { on: 'sphere'; theta: number; phi: number } // azimuth, polar
  /** Generic convex polyhedron face; u,v in OBJECT UNITS in that face's frame. */
  | { on: 'planar-face'; face: number; u: number; v: number }
  /** Lateral patch; y = height along local +Y. */
  | { on: 'cylinder'; theta: number; y: number }
  /** Lateral patch; t in 0..1, 0 = base rim, 1 = apex. */
  | { on: 'cone'; theta: number; t: number }
  /** Azimuth + polar, measured on the capsule's swept-sphere surface. */
  | { on: 'capsule'; theta: number; phi: number }
  | { on: 'derived'; point: Vec3; normal: Vec3 }

/**
 * A sketch is flat unless it sits on a genuinely curved patch. Curved patches
 * need the offset-shell trim in the evaluator; flat ones take the cheap exact
 * prism, so getting this wrong shows up as a feature that caps flat.
 */
export function isCurvedAnchor(anchor: SurfaceAnchor): boolean {
  return (
    anchor.on === 'sphere' ||
    anchor.on === 'cylinder' ||
    anchor.on === 'cone' ||
    anchor.on === 'capsule'
  )
}

export type Feature = {
  id: string
  anchor: SurfaceAnchor
  shape: Shape2D
  /** Spin of the outline within the tangent frame, in radians. */
  rotation: number
  /**
   * How far the feature sweeps, SIGNED along the surface normal: positive adds
   * material, negative cuts it away, and 0 is inert -- drawn as a surface
   * projection, contributing no solid.
   *
   * One number rather than a magnitude plus a mode. The two directions are the
   * two ends of a slider, which is the control they were always going to be,
   * and a sign cannot disagree with itself the way a mode and a magnitude can.
   * The limits are still asymmetric -- see `depthLimits` -- because a boss may
   * reach further out than a pocket may reach in.
   */
  depth: number
  enabled: boolean
  /**
   * Euler XYZ radians tilting the CREATED end face, applied in OBJECT space to
   * the surface normal. All three axes generally do something, which is what
   * makes an XYZ panel meaningful. [0,0,0] means the face stays perpendicular.
   */
  tilt: Vec3
  /**
   * Lateral slide of the created end face within its own plane, in object units
   * along the in-plane projections of the tangent frame's uDir / vDir. The base
   * of the extrusion stays put; the pillar leans to follow.
   */
  faceOffset: Vec2
  /**
   * Whether the sketch has been SIGNED OFF, and is no longer a live handle.
   *
   * A feature stays editable forever: the outline sits on the surface in orange,
   * draggable, resizable, its depth still on a slider. That is right while you
   * are shaping it and wrong the moment you are done -- the ring goes on being
   * drawn over a boss that is finished, and there was no way to say so short of
   * deleting the feature, which takes the geometry with it.
   *
   * Confirming keeps the solid and retires the handle. The feature still builds,
   * exactly as before -- `evaluate.ts` never reads this field, and it must not:
   * the geometry a document describes cannot depend on whether somebody has
   * ticked it off. What changes is only what is DRAWN: no outline in the
   * viewport, no row in the scene tree.
   *
   * ONE WAY, like the eraser it borrows its panel from, and undone the same way
   * -- by undo. See `confirmFeature`.
   *
   * OPTIONAL, and absent means unconfirmed. A required field would have to be
   * written into every feature literal in five check scripts to say the thing
   * that is true of a feature by default; `erased` on SceneObject is optional
   * for the same reason.
   */
  confirmed?: boolean
}

/** Rotation is Euler XYZ radians. No scale: a scaled anchor is a lying anchor. */
export type ObjectTransform = { position: Vec3; rotation: Vec3 }

export const IDENTITY_TRANSFORM: ObjectTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
}

/**
 * A half-space kept by an object after a cut, in OBJECT-LOCAL space.
 * side = +1 keeps { (p - origin) . normal >= 0 }, side = -1 keeps the other half.
 *
 * Storing the cut as a plane rather than baking it into the geometry is what
 * lets a severed half stay a live parametric object: its features keep editing.
 */
export type CutPlane = { id: string; origin: Vec3; normal: Vec3; side: 1 | -1 }

/**
 * One instant of a brush held against a surface: a sphere of influence in
 * OBJECT-LOCAL space.
 *
 * A stroke is a RUN of these, laid down along the drag, rather than one swept
 * shape -- which is what makes the tool a brush. Each is a complete description
 * of what it does, so the document says what the surface should look like
 * without anyone having to remember what the tool was set to at the time. Turn
 * the heat up and the dabs already laid down do not change; that is the same
 * bargain a feature's own stored depth strikes.
 *
 * No id. A dab is not a thing the user can select, rename, reorder or delete on
 * its own -- there is only the whole stroke, and undo is what takes one back --
 * so an id would be a field nothing ever reads.
 */
/**
 * HOW MUCH OF THE OBJECT EXISTED when a dab was laid: the length of each list
 * the build chain walks, at that instant.
 *
 * A melt is a fact about a PARTICULAR SURFACE, and the surface it was aimed at
 * is the one that was on screen at the time. Without this the dabs simply
 * replayed over whatever the object had become -- so merging a second solid in
 * melted the newcomer where the old strokes happened to reach, and a boss
 * extruded out of a torched face came out already torched. Neither was ever
 * asked for; both were the arithmetic of a stage that ran last no matter what
 * had been added after it.
 *
 * COUNTS RATHER THAN IDS, and one per list rather than a single number. The
 * chain is ordered -- parts, then features, then cuts, then erasers -- so a
 * position in it is exactly how far into each of the four you have got, and a
 * count is the one thing about a list that survives its members being edited.
 * Ids would have to be reconciled against a list that no longer holds them; an
 * index into a flattened chain would move the moment a feature was deleted.
 *
 * OPTIONAL, and absent means THE WHOLE OBJECT -- which is what every dab meant
 * before this existed, and what the check scripts still say when they write a
 * dab by hand. `erodeAt` stamps every real one.
 */
export type ErodeStamp = {
  parts: number
  features: number
  cuts: number
  erased: number
}

export type ErodeDab = {
  /** Centre of the brush, in the object's local space. */
  at: Vec3
  /** Sphere radius: how much of the surface this instant reaches. */
  radius: number
  /** How hard it bites, 0..1. */
  heat: number
  /** How much it flows rather than merely sinking, 0..1. */
  smooth: number
  /**
   * This dab RAISES the surface instead of sinking it: the sculpt tool.
   *
   * ONE FIELD RATHER THAN A SECOND LIST, because the two brushes share a
   * surface and the ORDER they were used in is the whole of what the result
   * means. Carve a groove and then draw a bead across it and you get a bead
   * lying over a groove; do it the other way and the groove cuts the bead. Two
   * arrays, each replayed in its own order, cannot say which happened -- so
   * they would have to be interleaved by a timestamp nobody stores, or the tool
   * would quietly reorder the user's own strokes.
   *
   * It is also the honest shape of the geometry: a raise is the torch's
   * arithmetic with one sign flipped -- see `erode.ts` -- so a dab that carries
   * its direction is a dab the whole pipeline can go on treating as one thing.
   *
   * Absent rather than false on a torch dab, so a document nobody has sculpted
   * is exactly the document it was before the tool existed -- which matters
   * here more than elsewhere, because the evaluator's cache key is this array
   * stringified, and a `false` written into every old dab would invalidate the
   * mesh of every torched object in the scene.
   */
  raise?: boolean
  /**
   * This dab ROUNDS the surface instead of moving it: the Smoother.
   *
   * The third brush, and the one that neither takes material away nor puts any
   * on. What it carries is a TARGET, as a fraction of `radius`: the tightest
   * radius a corner under the brush is allowed to keep. Anything sharper than
   * that is eased until it is that round, and anything already rounder -- a
   * flat face, a gentle curve, a corner this brush has already been over -- is
   * left exactly where it was. See `roundOff` in `erode.ts`.
   *
   * A NUMBER RATHER THAN A FLAG, because unlike `raise` it is not merely which
   * way the dab points -- it is where the dab STOPS, and a rounding dab with
   * nothing to stop at would sand the object flat. Present is what makes this a
   * rounding dab at all: `heat` and `smooth` are then both zero, honestly
   * rather than as placeholders, since this brush neither bites nor flows.
   *
   * THE THIRD MEMBER OF THE ONE LIST, for the reason `raise` is the second:
   * round a corner and then melt it and you have a melted round; melt it and
   * then round it and you have a rounded melt. Only the order says which, so
   * all three brushes lay their marks down the same array.
   *
   * Absent rather than zero on the other two brushes' dabs, so a document
   * nobody has rounded is exactly the document it was before this tool existed
   * -- which matters here for the reason it matters for `raise`: the
   * evaluator's cache key is this array stringified.
   */
  round?: number
  /**
   * Where in the build chain this dab goes -- see `ErodeStamp`.
   *
   * Carried by the DAB rather than by the stroke or by the object, for the same
   * reason `heat` is: a dab is a complete description of what it does, so the
   * document says what the surface should look like without anyone having to
   * remember what the object was shaped like at the time. Merge something in
   * afterwards, or grow a boss, and the strokes already laid down do not move.
   */
  stamp?: ErodeStamp
}

/**
 * The colour a solid wears until one is chosen for it: the warm grey the whole
 * scene used to share.
 *
 * Lives here rather than in the viewport because it is now the DEFAULT OF A
 * DOCUMENT FIELD -- "no colour" and "this colour" have to mean the same thing
 * to the renderer, the clipboard tiles and anything else that draws an object,
 * and a second copy of the literal is the way those quietly drift apart.
 */
export const DEFAULT_OBJECT_COLOR = '#9aa3b4'

export type SceneObject = {
  id: string
  name: string
  /**
   * The solid's own colour as `#rrggbb`, or absent for DEFAULT_OBJECT_COLOR.
   *
   * Optional rather than defaulted at creation so an untouched scene stays
   * exactly the document it was before colour existed: nothing to serialise,
   * nothing to diff, and one place -- the default above -- that decides what
   * grey means.
   *
   * EVERY SOLID CARRIES ITS OWN, parts included. A merged assembly evaluates to
   * a single mesh, but that mesh is grouped by the solid each triangle came
   * from -- see `ObjectEval.paints` -- so a part's colour is a surface the
   * viewport genuinely draws, and merging a red cube into a blue one leaves an
   * object that is still red and blue. Painting an assembly through
   * `setObjectColor` reaches all the way down, so "one colour" stays reachable;
   * it is simply no longer forced.
   */
  color?: string
  base: BaseSolid
  transform: ObjectTransform
  features: Feature[]
  cuts: CutPlane[]
  /**
   * Solids merged into this one, each a whole SceneObject in THIS object's
   * local space.
   *
   * A merged object is one object: one transform, one gizmo, one row in the
   * tree, and features and cuts that apply to the union. But nothing is thrown
   * away to get there -- a part keeps its own base, its own features and its
   * own cuts, exactly as it had them, and its transform is simply re-expressed
   * relative to its host. That is the same bargain a cut strikes, and it is
   * what would let an unmerge hand back what went in rather than a boolean
   * result nobody can take apart again.
   *
   * Recursive on purpose: merging something that was itself merged nests rather
   * than flattening, so the parts of the parts survive too.
   */
  parts: SceneObject[]
  /**
   * This object is an ERASER: a solid dragged in to take material away rather
   * than to add it.
   *
   * A whole SceneObject and not a mode on some tool, because the point of it is
   * that you aim it the way you aim anything else -- the same gizmo, the same
   * Position panel, the same Size field, the same snapping. A tool with its own
   * cut-down set of controls would be a second, worse way to place a solid.
   *
   * It draws as a translucent red ghost and takes nothing away until it is
   * confirmed. A live preview would mean re-running the boolean on every
   * overlapped object on every frame of every drag, which is the one thing the
   * evaluator's whole design is arranged to avoid.
   *
   * Absent rather than false on an ordinary solid: an untouched scene stays
   * exactly the document it was before erasers existed.
   */
  erase?: boolean
  /**
   * Solids that have been erased OUT of this one, each a whole SceneObject in
   * this object's local space -- the negative of `parts`.
   *
   * Applied LAST, after the features and the cuts, which is what makes it an
   * eraser rather than one more step in the middle: a boss grown into the hole
   * afterwards does not fill it back in.
   *
   * The user cannot see or edit these. Confirming a subtraction is a one-way
   * act -- the eraser is consumed and there is no row to reopen. They are still
   * stored rather than baked into a mesh because every mesh in this app is
   * DERIVED from the document: freezing the result would mean a base solid that
   * is a bag of triangles, and the object would lose its Size field, its
   * sketches and its cuts along with its editability.
   */
  erased?: SceneObject[]
  /**
   * Where the brushes have been: every dab of the blowtorch and the sculpt
   * tool, in the order it was laid down, in this object's local space.
   *
   * ONE LIST FOR BOTH, in stroke order, because which came first is what the
   * surface means -- see `ErodeDab.raise`.
   *
   * APPLIED WHERE IT WAS LAID rather than at a fixed point in the chain: each
   * dab carries the shape of the object at the instant it was made -- see
   * `ErodeDab.stamp` -- and the evaluator interleaves the melting with the
   * building so the two happen in the order the user did them. Melt a face,
   * grow a boss out of it, melt that: the first melt sees the face and not the
   * boss, and the second sees both.
   *
   * An unstamped dab still runs LAST, after the features, the cuts and the
   * erasers, which is where every dab used to run and what a hand-written one
   * still means.
   *
   * Stored as strokes rather than as the melted mesh, which is the same bargain
   * `erased` strikes one line above: freezing the result would leave a base
   * solid that is a bag of triangles, and the object would lose its Size field,
   * its sketches and its cuts along with its editability. What this costs is
   * that the mesh is REPLAYED from the dabs on every evaluation; what it buys is
   * that a torched object is still a document.
   *
   * Absent rather than empty on an untouched solid, so a scene nobody has
   * torched is exactly the document it was before the tool existed -- and the
   * evaluator can skip the whole stage on an identity test.
   */
  erosion?: ErodeDab[]
}

export type Doc = { objects: SceneObject[] }

export function shapeRadius(shape: Shape2D): number {
  switch (shape.type) {
    case 'circle':
      return shape.r
    case 'ngon':
      return shape.r
    case 'rect':
      return Math.hypot(shape.w, shape.h) / 2
  }
}

// Separate counters per kind, so ids stay readable in a debugger and an object
// id can never collide with a feature id in a map keyed by either.
let featureCounter = 0
let objectCounter = 0
let cutCounter = 0

export function nextFeatureId(): string {
  featureCounter += 1
  return `f${featureCounter}`
}

export function nextObjectId(): string {
  objectCounter += 1
  return `o${objectCounter}`
}

export function nextCutId(): string {
  cutCounter += 1
  return `c${cutCounter}`
}

/**
 * Pushes the three counters past every id in a document that came from
 * somewhere else.
 *
 * WHY A RESTORED DOCUMENT NEEDS THIS AND A PASTED SOLID DOES NOT. Everything
 * that copies an object into the live scene re-ids it on the way in -- see
 * `cloneObject`, which mints a fresh id for the object and for every feature
 * under it -- so the counters have always been ahead of anything they could
 * meet. A project opened off the disk is the first thing in this app that puts
 * back the very ids it was saved with: a scene of twelve solids comes back as
 * `o1`..`o12` against counters that a fresh page has at zero, and the next
 * solid dropped from the palette would be handed `o1` a second time. Two
 * objects with one id is not a cosmetic problem -- `mapObject` edits BOTH of
 * them, the scene tree draws one row for two solids, and deleting either takes
 * the pair.
 *
 * WALKED RATHER THAN TOLD. The caller hands in the objects and this finds the
 * ids, parts and holes and features and cuts included, because the alternative
 * -- a restore that lists the ids it thinks it has -- is a list that goes stale
 * the day an id starts living somewhere new.
 *
 * A counter only ever moves FORWARD. Opening a small project after a large one
 * must not wind the numbers back to where the small one ends, or the next solid
 * collides with something still sitting in the other project's undo history.
 */
export function seedIds(objects: SceneObject[]): void {
  // The numeric tail of an id this module minted, or 0 for anything it did not
  // -- an id from an older format, or one a user's hand-edited file invented.
  // Zero moves no counter, which is the right answer for an id whose shape says
  // nothing about how many have been handed out.
  const tail = (id: string, prefix: string): number => {
    if (!id.startsWith(prefix)) return 0
    const n = Number(id.slice(prefix.length))
    return Number.isInteger(n) && n > 0 ? n : 0
  }

  const walk = (object: SceneObject): void => {
    objectCounter = Math.max(objectCounter, tail(object.id, 'o'))
    for (const feature of object.features) {
      featureCounter = Math.max(featureCounter, tail(feature.id, 'f'))
    }
    for (const cut of object.cuts) cutCounter = Math.max(cutCounter, tail(cut.id, 'c'))
    for (const part of object.parts) walk(part)
    for (const hole of object.erased ?? []) walk(hole)
  }

  for (const object of objects) walk(object)
}

/**
 * How wide a fresh primitive lands: ONE SCENE UNIT, which `units.ts` fixes at
 * ten centimetres. A cube off the palette is 10 x 10 x 10 cm.
 *
 * A plain number rather than `fromDisplay(10, 'cm')`, because geometry never
 * sees a display unit -- the rule at the top of `units.ts` -- so the conversion
 * is stated here in words and the source stays in scene units.
 *
 * Every default below is written against it. That is what keeps the palette one
 * SET rather than ten numbers: change this and the whole family moves together,
 * a sketch included, instead of a cube drifting away from the sphere it is
 * meant to drop beside.
 *
 * Exported, because the palette is no longer the only thing that has to know
 * how big a thing is around here: the laser cutter's block starts at one span
 * too. See `DEFAULT_BLOCK`. A screen that picked its own number would be a
 * screen that disagreed with the rest of the app about the size of a
 * ten-centimetre cube.
 */
export const DEFAULT_SPAN = 1

/**
 * A fresh sketch lands well inside the face it is dropped on -- under a third
 * of a span across -- so there is room to see it, move it and grow it before it
 * meets an edge. One that arrived filling its face would have to be shrunk
 * before it could be aimed.
 */
export function defaultShape(kind: ShapeKind, sides?: number): Shape2D {
  switch (kind) {
    case 'circle':
      return { type: 'circle', r: DEFAULT_SPAN * 0.15 }
    case 'rect':
      return { type: 'rect', w: DEFAULT_SPAN * 0.3, h: DEFAULT_SPAN * 0.3 }
    case 'ngon':
      return { type: 'ngon', r: DEFAULT_SPAN * 0.175, sides: sides ?? 6 }
  }
}

/**
 * A fresh sketch lands as a pure projection: depth 0, no tilt, no face offset.
 * Depth arrives when the user drags the normal arrow or moves the Extrude
 * slider off zero, in either direction -- which is what makes a boss and a
 * pocket the same object rather than two different creation paths.
 */
export function defaultFeature(anchor: SurfaceAnchor, shape: Shape2D): Feature {
  return {
    id: nextFeatureId(),
    anchor,
    shape,
    rotation: 0,
    depth: 0,
    enabled: true,
    tilt: [0, 0, 0],
    faceOffset: [0, 0],
  }
}

/**
 * A deep copy of an object with fresh ids throughout, ready to stand beside the
 * original.
 *
 * Every id is reminted, down through parts and their parts: two objects sharing
 * a feature id would collide in the evaluator's per-object cache and in every
 * map keyed by one, and the copy would edit the original's sketches. The rest is
 * cloned rather than shared because a `SceneObject` is a tree of plain arrays --
 * a shared `size` or `origin` would alias between the copy and its source the
 * first time anything reached past a spread.
 */
export function cloneObject(obj: SceneObject): SceneObject {
  const remint = (o: SceneObject): SceneObject => ({
    ...o,
    id: nextObjectId(),
    features: o.features.map((f) => ({ ...f, id: nextFeatureId() })),
    cuts: o.cuts.map((c) => ({ ...c, id: nextCutId() })),
    parts: o.parts.map(remint),
    // Holes travel with the copy, and their ids are reminted like everything
    // else: an erased solid is a whole SceneObject, and two of them sharing an
    // id would collide in every map keyed by one.
    ...(o.erased ? { erased: o.erased.map(remint) } : {}),
  })
  return remint(structuredClone(obj))
}

export function makeObject(base: BaseSolid, position: Vec3): SceneObject {
  return {
    id: nextObjectId(),
    name: solidLabel(base),
    base,
    transform: { ...IDENTITY_TRANSFORM, position },
    features: [],
    cuts: [],
    parts: [],
  }
}

/**
 * Palette entry ordering + labels are UI concerns, but the default dimensions
 * are geometry: every primitive lands roughly one span across -- ten
 * centimetres, see `DEFAULT_SPAN` -- so one drops next to another at a sane
 * relative size, and at a size a person can name without doing arithmetic.
 *
 * Solids standing on the SAME cross-section share that section's default, so a
 * family reads as one set: everything round starts at half a span, and a
 * pyramid and a prism of the same side count start on the same polygon. A cone
 * landing a hair narrower than the sphere beside it was a mismatch nobody could
 * name but everybody could see.
 */
export function defaultBaseFor(
  kind: PaletteKind,
  sides?: number,
  platonic?: PlatonicKind
): BaseSolid {
  switch (kind) {
    case 'box':
      return { kind: 'box', size: [DEFAULT_SPAN, DEFAULT_SPAN, DEFAULT_SPAN] }
    case 'sphere':
      return { kind: 'sphere', radius: DEFAULT_SPAN / 2 }
    case 'cylinder':
      return { kind: 'cylinder', radius: DEFAULT_SPAN / 2, height: DEFAULT_SPAN }
    case 'cone':
      return { kind: 'cone', radius: DEFAULT_SPAN / 2, height: DEFAULT_SPAN }
    case 'capsule':
      return { kind: 'capsule', radius: DEFAULT_SPAN / 2, height: DEFAULT_SPAN * 0.6 }
    case 'pyramid':
      return {
        kind: 'pyramid',
        radius: DEFAULT_SPAN / 2,
        height: DEFAULT_SPAN * 0.9,
        sides: sides ?? 4,
      }
    case 'prism':
      return {
        kind: 'prism',
        radius: DEFAULT_SPAN / 2,
        height: DEFAULT_SPAN * 0.9,
        sides: sides ?? 6,
      }
    case 'platonic':
      return { kind: 'platonic', radius: DEFAULT_SPAN * 0.55, solid: platonic ?? 'tetrahedron' }
  }
}

const POLYGON_PREFIX: Record<number, string> = {
  3: 'Triangular',
  4: 'Square',
  5: 'Pentagonal',
  6: 'Hexagonal',
  7: 'Heptagonal',
  8: 'Octagonal',
  9: 'Nonagonal',
  10: 'Decagonal',
  12: 'Dodecagonal',
}

/**
 * The adjective a solid standing on `sides` wears in its name.
 *
 * Exported for the lathe, whose pieces are meshes and so have no `BaseSolid`
 * kind to be named from -- but a piece turned on a hexagon and a hexagonal
 * prism from the palette are the same shape of thing, and they had better not
 * be called two different words for it. See `pieceName`.
 */
export function polygonPrefix(sides: number): string {
  return POLYGON_PREFIX[sides] ?? `${sides}-sided`
}

const PLATONIC_LABEL: Record<PlatonicKind, string> = {
  tetrahedron: 'Tetrahedron',
  octahedron: 'Octahedron',
  dodecahedron: 'Dodecahedron',
}

/** Human name for a solid, used to seed an object's name when it is created. */
export function solidLabel(base: BaseSolid): string {
  switch (base.kind) {
    case 'box': {
      const [x, y, z] = base.size
      return x === y && y === z ? 'Cube' : 'Box'
    }
    case 'sphere':
      return 'Sphere'
    case 'cylinder':
      return 'Cylinder'
    case 'cone':
      return 'Cone'
    case 'capsule':
      return 'Bean'
    case 'pyramid':
      return `${polygonPrefix(base.sides)} pyramid`
    case 'prism':
      return `${polygonPrefix(base.sides)} prism`
    case 'platonic':
      return PLATONIC_LABEL[base.solid]
    // Whatever the file called itself. An imported model has no shape name --
    // it is not a member of a family -- so the only honest label is its own.
    case 'mesh':
      return base.label
  }
}
