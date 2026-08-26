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

export type FeatureOp = 'extrude' | 'intrude'

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

export type SolidKind = BaseSolid['kind']

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
  op: FeatureOp
  /** 0 means inert: drawn as a surface projection, contributes no solid. */
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

export type SceneObject = {
  id: string
  name: string
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

export function defaultShape(kind: ShapeKind): Shape2D {
  switch (kind) {
    case 'circle':
      return { type: 'circle', r: 0.3 }
    case 'rect':
      return { type: 'rect', w: 0.6, h: 0.6 }
    case 'ngon':
      return { type: 'ngon', r: 0.35, sides: 6 }
  }
}

/**
 * A fresh sketch lands as a pure projection: depth 0, no tilt, no face offset.
 * Depth arrives when the user chooses extrude or intrude, which is what makes
 * those two the same object rather than two different creation paths.
 */
export function defaultFeature(anchor: SurfaceAnchor, shape: Shape2D): Feature {
  return {
    id: nextFeatureId(),
    anchor,
    shape,
    rotation: 0,
    op: 'extrude',
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
 * are geometry: every primitive lands roughly 2 units across so one drops next
 * to another at a sane relative size.
 */
export function defaultBaseFor(
  kind: SolidKind,
  sides?: number,
  platonic?: PlatonicKind
): BaseSolid {
  switch (kind) {
    case 'box':
      return { kind: 'box', size: [2, 2, 2] }
    case 'sphere':
      return { kind: 'sphere', radius: 1 }
    case 'cylinder':
      return { kind: 'cylinder', radius: 0.8, height: 2 }
    case 'cone':
      return { kind: 'cone', radius: 0.9, height: 2 }
    case 'capsule':
      return { kind: 'capsule', radius: 0.6, height: 1.2 }
    case 'pyramid':
      return { kind: 'pyramid', radius: 1, height: 1.8, sides: sides ?? 4 }
    case 'prism':
      return { kind: 'prism', radius: 0.9, height: 1.8, sides: sides ?? 6 }
    case 'platonic':
      return { kind: 'platonic', radius: 1.1, solid: platonic ?? 'tetrahedron' }
  }
}

const POLYGON_PREFIX: Record<number, string> = {
  3: 'Triangular',
  4: 'Square',
  5: 'Pentagonal',
  6: 'Hexagonal',
  7: 'Heptagonal',
  8: 'Octagonal',
  10: 'Decagonal',
  12: 'Dodecagonal',
}

function polygonPrefix(sides: number): string {
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
  }
}
