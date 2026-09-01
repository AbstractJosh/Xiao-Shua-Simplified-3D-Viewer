import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Ray,
  Sphere as ThreeSphere,
  SphereGeometry,
  Vector3,
} from 'three'
import { MIN_SHAPE } from './dimensions'
import { meshGeometry } from './meshLibrary'
import type { Point2 } from './outline'
import type { FacePatch } from './solids'
import {
  discFace,
  facePoint,
  faceVertices,
  facesToGeometry,
  platonicFaces,
  prismFaces,
  pyramidFaces,
} from './solids'
import type {
  BaseSolid,
  BoxFace,
  Feature,
  FeatureOp,
  Shape2D,
  SurfaceAnchor,
  Vec3,
} from './types'
import { isCurvedAnchor, shapeRadius } from './types'

export type { FacePatch } from './solids'
export type { FeatureOp } from './types'

export const SURFACE_EPS = 1e-4

export type SurfaceFrame = {
  origin: Vector3
  normal: Vector3
  uDir: Vector3
  vDir: Vector3
}

export type ProjectedPoint = { position: Vector3; normal: Vector3 }

export type SurfaceHit = { point: Vector3; normal: Vector3 }

/** How far a feature's cutting prism must reach inward / outward. */
export type Sweep = { tIn: number; tOut: number }

/**
 * A base solid, expressed as everything the feature engine needs to know about
 * its surface. `project` is the keystone: it drives the cutting prism, the
 * on-surface outline overlay, and drag clamping alike.
 */
export interface SurfaceDef {
  kind: string
  geometry(): BufferGeometry
  /** The solid offset by `d` (signed). null when the offset collapses to nothing. */
  offsetGeometry(d: number): BufferGeometry | null
  /** Classify a raycast hit against this primitive. null means derived geometry. */
  anchorFromHit(point: Vector3): SurfaceAnchor | null
  frame(anchor: SurfaceAnchor): SurfaceFrame
  /** Map a point in the sketch tangent frame (world units) onto the surface. */
  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint
  /** Keep a sketch of this size fully on the surface. */
  clampAnchor(anchor: SurfaceAnchor, shape: Shape2D): SurfaceAnchor
  /** Analytic raycast, so dragging never snags on features already cut. */
  raycast(ray: Ray): SurfaceHit | null
  sweep(anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep
  /** Composite solids vary per patch, so the anchor decides where it is measured. */
  maxDepth(op: FeatureOp, anchor?: SurfaceAnchor): number
  /**
   * Widest sketch this patch will hold, measured from the patch's own centre.
   *
   * Per patch for the same reason `maxDepth` is: the question is about the face
   * being drawn on, not about the solid it belongs to. A cylinder's cap and its
   * wall run out of room in completely different directions, and a slab's broad
   * top is not bounded by how thin the slab is.
   *
   * Omitting the anchor asks the conservative question -- the tightest any of
   * this solid's patches would answer -- which is the honest reply when nobody
   * has said which face they mean.
   */
  maxShapeRadius(anchor?: SurfaceAnchor): number
  /** Local-space extents, which is what drops a new solid onto the ground. */
  bounds(): Box3
}

/** Robust tangent basis: picks a reference axis that is never parallel to n. */
export function tangentBasis(n: Vector3): { uDir: Vector3; vDir: Vector3 } {
  const ref = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  const uDir = new Vector3().crossVectors(ref, n).normalize()
  const vDir = new Vector3().crossVectors(n, uDir).normalize()
  // uDir cross vDir === n, so a CCW outline in (u,v) faces outward.
  return { uDir, vDir }
}

/**
 * Radial rays converge on the axis (or the centre), so a prism swept inward
 * past it folds through itself and silently corrupts the CSG result. Every
 * curved surface stays this fraction short of the convergence point.
 */
const CURVED_MAX_INWARD = 0.85

/**
 * The widest cap one sketch may cover on a CLOSED smooth surface, as the
 * tangent of the half-angle it subtends at the centre.
 *
 * A sphere and a bean have no rim to reach, so their bound cannot be an edge --
 * it has to be the point where the projection stops being usable. Gnomonic
 * projection pushes a tangent-plane point out along the line through the
 * centre, so the tangent radius runs away to infinity as the half-angle
 * approaches ninety degrees and the outline flattens against the equator.
 * Sixty degrees is a cap a third of the way down the sphere, at a tangent of
 * 1.73 radii -- far more reach than the flat 0.9 this replaces, and still well
 * short of where the map blows up.
 */
const CURVED_MAX_TANGENT = Math.tan((60 * Math.PI) / 180)

/**
 * Segment count shared by every RULED lathe primitive -- the cylinder and the
 * cone -- and its offset shell, and the ceiling on the adaptive counts below.
 *
 * Fixed for those two because it is not only a tessellation: their caps are
 * real `FacePatch` polygons (see `discFace`), so the number is the corner count
 * of a face a sketch gets clamped inside and an exporter writes out. It is also
 * cheap to hold -- a whole cylinder is 192 triangles at this count, against the
 * thousands a sphere was spending.
 */
const LATHE_SEGMENTS = 48

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * How far a rendered point may sit from the analytic surface and still count as
 * on it. A tessellated barrel sags below the true radius by the chord sagitta,
 * so a flat 1e-3 would misclassify the middle of every facet as derived
 * geometry -- and a boss dropped there would cap flat instead of curving.
 */
function latheTolerance(radius: number, segments: number): number {
  return 1e-3 + radius * (1 - Math.cos(Math.PI / segments))
}

/**
 * The same, for a surface that curves BOTH WAYS.
 *
 * A cylinder's facet is dead straight up the axis and only bends around it, so
 * one sagitta is the whole story. A sphere's bends along its rings AND along
 * its meridians, and the middle of a facet -- the deepest point, and the one a
 * ray aimed off the seams lands on -- is short by both at once. With the two
 * angular steps equal (see `sphereGeometry` and `capsuleGeometry`) that is
 * `1 - cos^2` of the half step rather than `1 - cos`: very nearly twice as
 * deep.
 *
 * The 64x40 pair this replaces cleared a ONE-SIDED bound only by accident. Its
 * rings were finer than its segments, so the second sagitta was small enough to
 * hide inside the flat 1e-3 -- and a sphere cut evenly, as one cut for its own
 * size is, drops straight out the bottom of that bound and reads every hit off
 * a seam as derived geometry.
 */
function ballTolerance(radius: number, segments: number): number {
  const cos = Math.cos(Math.PI / segments)
  return 1e-3 + radius * (1 - cos * cos)
}

/**
 * How deep a facet may sag below the curve it stands in for, in scene units.
 *
 * A fifth of a millimetre, one scene unit being ten centimetres -- finer than
 * anything modelled here is printed or measured to. It is what decides how many
 * segments a curve gets, because the honest question is "how coarse may this be
 * before it stops looking round", and that is a question about the RADIUS.
 *
 * A fixed count is what this replaces, and it was wrong at both ends. Sixty-four
 * segments round a five-centimetre ball resolve a facet a fifth of a MICRON
 * deep: five thousand triangles buying nothing an eye or a printer could find.
 * The same count on a two-and-a-half-metre one (`MAX_RADIUS`) is the coarsest
 * surface in the app. Tying the count to the sagitta spends the triangles where
 * the curve actually bends away from them.
 */
const MAX_SAGITTA = 0.002

/**
 * The floor on a segment count, for when the sagitta rule asks for less.
 *
 * It binds under about a centimetre of radius, where the rule alone would hand
 * back a gem. Sixteen segments sag 1.9% of the radius, which still reads as
 * round with a bead filling the screen -- and costs 224 triangles either way,
 * so there is nothing to win by going below it.
 */
const MIN_ARC_SEGMENTS = 16

/**
 * How many segments a full turn at this radius is cut into.
 *
 * QUANTISED TO A MULTIPLE OF FOUR, which buys two separate things. A resize
 * drag walks the radius a pixel at a time, and a count that moved with every
 * step would re-tessellate the base -- and re-run the whole feature tree over
 * the new mesh -- on every frame of the drag; in fours it changes a handful of
 * times across the entire range, and the count is stable either side of each
 * step. And four divides evenly into both counts derived from it below: a
 * sphere's rings are half of it, a capsule's cap rows a quarter.
 */
export function arcSegments(radius: number): number {
  const sag = MAX_SAGITTA / Math.max(radius, SURFACE_EPS)
  const ideal = sag >= 1 ? MIN_ARC_SEGMENTS : Math.PI / Math.acos(1 - sag)
  return clamp(4 * Math.ceil(ideal / 4), MIN_ARC_SEGMENTS, LATHE_SEGMENTS)
}

/** Real roots of a t^2 + b t + c, nearest first. */
function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < SURFACE_EPS) {
    return Math.abs(b) < SURFACE_EPS ? [] : [-c / b]
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return []
  const sq = Math.sqrt(disc)
  const t0 = (-b - sq) / (2 * a)
  const t1 = (-b + sq) / (2 * a)
  return t0 <= t1 ? [t0, t1] : [t1, t0]
}

function flatFrame(point: Vector3, normal: Vector3): SurfaceFrame {
  const n = normal.clone().normalize()
  const { uDir, vDir } = tangentBasis(n)
  return { origin: point.clone(), normal: n, uDir, vDir }
}

function derivedFrame(anchor: SurfaceAnchor): SurfaceFrame {
  if (anchor.on !== 'derived') {
    return flatFrame(new Vector3(), new Vector3(0, 1, 0))
  }
  return flatFrame(new Vector3(...anchor.point), new Vector3(...anchor.normal))
}

/** Flat projection in a frame: what every planar patch does. */
function flatProject(f: SurfaceFrame, u: number, v: number): ProjectedPoint {
  return {
    position: f.origin.clone().addScaledVector(f.uDir, u).addScaledVector(f.vDir, v),
    normal: f.normal.clone(),
  }
}

// --- Convex polygon helpers (shared by every planar patch) ------------------

/** Smallest signed distance from (u,v) to an edge; negative means outside. */
function polygonClearance(poly: Point2[], u: number, v: number): number {
  let worst = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (len < SURFACE_EPS) continue
    // The interior is to the left of every edge of a CCW polygon.
    worst = Math.min(worst, ((u - a[0]) * -dy + (v - a[1]) * dx) / len)
  }
  return Number.isFinite(worst) ? worst : 0
}

function polygonContains(poly: Point2[], u: number, v: number, tol: number): boolean {
  return polygonClearance(poly, u, v) >= -tol
}

/** Corners need several passes: pushing off one edge can breach its neighbour. */
const INSET_PASSES = 8

/**
 * Slide (u,v) inward until a circle of radius r around it fits inside the face.
 *
 * Pushing back along each breached edge's inward normal converges on a convex
 * polygon; a corner just needs a few passes to settle. When the face is simply
 * too small for the sketch there is no valid seat, and the centroid is the
 * least wrong answer.
 */
function insetIntoPolygon(poly: Point2[], u0: number, v0: number, r: number): Point2 {
  let u = u0
  let v = v0
  for (let pass = 0; pass < INSET_PASSES; pass++) {
    let moved = false
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      if (len < SURFACE_EPS) continue
      const nx = -dy / len
      const ny = dx / len
      const s = (u - a[0]) * nx + (v - a[1]) * ny
      if (s >= r) continue
      u += nx * (r - s)
      v += ny * (r - s)
      moved = true
    }
    if (!moved) return [u, v]
  }
  return polygonClearance(poly, u, v) >= r - SURFACE_EPS ? [u, v] : [0, 0]
}

// --- Box -------------------------------------------------------------------

const BOX_FACE_NORMALS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]

// Chosen so that uDir cross vDir === faceNormal for every face (right-handed).
const BOX_FACE_U: Vec3[] = [
  [0, 0, -1],
  [0, 0, 1],
  [1, 0, 0],
  [1, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
]
const BOX_FACE_V: Vec3[] = [
  [0, 1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
  [0, 1, 0],
]

export class BoxSurface implements SurfaceDef {
  readonly kind = 'box'
  constructor(private size: Vec3) {}

  private half(): Vector3 {
    return new Vector3(this.size[0] / 2, this.size[1] / 2, this.size[2] / 2)
  }

  /** Half-extents of a face measured along its own uDir / vDir. */
  private faceExtents(face: BoxFace): { halfU: number; halfV: number } {
    const h = this.half()
    const along = (d: Vec3) =>
      Math.abs(d[0]) * h.x + Math.abs(d[1]) * h.y + Math.abs(d[2]) * h.z
    return { halfU: along(BOX_FACE_U[face]), halfV: along(BOX_FACE_V[face]) }
  }

  geometry(): BufferGeometry {
    return new BoxGeometry(this.size[0], this.size[1], this.size[2])
  }

  offsetGeometry(d: number): BufferGeometry | null {
    const sx = this.size[0] + 2 * d
    const sy = this.size[1] + 2 * d
    const sz = this.size[2] + 2 * d
    if (sx <= SURFACE_EPS || sy <= SURFACE_EPS || sz <= SURFACE_EPS) return null
    return new BoxGeometry(sx, sy, sz)
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const h = this.half()
    const tol = 1e-3
    const coords = [point.x, point.y, point.z]
    const halves = [h.x, h.y, h.z]
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        if (Math.abs(coords[axis] - sign * halves[axis]) > tol) continue
        // Reject points on the face plane but beyond the face boundary.
        let inside = true
        for (let a = 0; a < 3; a++) {
          if (a !== axis && Math.abs(coords[a]) > halves[a] + tol) inside = false
        }
        if (!inside) continue
        const face = (axis * 2 + (sign === 1 ? 0 : 1)) as BoxFace
        const { halfU, halfV } = this.faceExtents(face)
        const uDir = new Vector3(...BOX_FACE_U[face])
        const vDir = new Vector3(...BOX_FACE_V[face])
        const origin = new Vector3(...BOX_FACE_NORMALS[face]).multiply(h)
        const rel = point.clone().sub(origin)
        return {
          on: 'box-face',
          face,
          u: halfU > 0 ? rel.dot(uDir) / halfU : 0,
          v: halfV > 0 ? rel.dot(vDir) / halfV : 0,
        }
      }
    }
    return null
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    if (anchor.on !== 'box-face') return derivedFrame(anchor)
    const { face, u, v } = anchor
    const { halfU, halfV } = this.faceExtents(face)
    const normal = new Vector3(...BOX_FACE_NORMALS[face])
    const uDir = new Vector3(...BOX_FACE_U[face])
    const vDir = new Vector3(...BOX_FACE_V[face])
    const origin = normal
      .clone()
      .multiply(this.half())
      .addScaledVector(uDir, u * halfU)
      .addScaledVector(vDir, v * halfV)
    return { origin, normal, uDir, vDir }
  }

  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    return flatProject(this.frame(anchor), u, v)
  }

  clampAnchor(anchor: SurfaceAnchor, shape: Shape2D): SurfaceAnchor {
    if (anchor.on !== 'box-face') return anchor
    const { halfU, halfV } = this.faceExtents(anchor.face)
    const r = shapeRadius(shape)
    // Normalised slack remaining once the outline bounding circle must fit.
    const limU = halfU > r ? 1 - r / halfU : 0
    const limV = halfV > r ? 1 - r / halfV : 0
    return {
      on: 'box-face',
      face: anchor.face,
      u: clamp(anchor.u, -limU, limU),
      v: clamp(anchor.v, -limV, limV),
    }
  }

  raycast(ray: Ray): SurfaceHit | null {
    const point = ray.intersectBox(this.bounds(), new Vector3())
    if (!point) return null
    const anchor = this.anchorFromHit(point)
    if (!anchor || anchor.on !== 'box-face') return null
    return { point, normal: new Vector3(...BOX_FACE_NORMALS[anchor.face]) }
  }

  sweep(anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    // Thickness of material behind this face, so the tool never reaches the
    // far side. Overshooting there welds a spurious stub onto the back of the
    // solid on extrude, which is invisible from the front.
    const h = this.half()
    const axis = anchor.on === 'box-face' ? anchor.face >> 1 : 0
    const thickness = [h.x, h.y, h.z][axis] * 2
    const margin = Math.min(Math.max(0.05, depth * 0.1), thickness * 0.25)

    // A flat surface gets an exact prism: the ring defining the new face sits
    // at exactly `depth`, and the other end only buries itself far enough to
    // avoid a coplanar seam with the original face.
    return op === 'extrude'
      ? { tIn: margin, tOut: depth }
      : { tIn: depth, tOut: margin }
  }

  maxDepth(op: FeatureOp): number {
    const h = this.half()
    const minThickness = Math.min(h.x, h.y, h.z) * 2
    // Intruding past the far side is a legitimate through-cut, so allow it.
    return op === 'extrude' ? minThickness * 2 : minThickness * 1.5
  }

  /**
   * Half the shorter side of THE FACE, so a circle grows until it touches the
   * two edges nearest it.
   *
   * The bound this replaces was half the box's smallest side whichever face you
   * were on, so a twenty-by-two-by-twenty slab capped every sketch on its broad
   * top at a radius of one, with nine units of face going spare in each
   * direction.
   *
   * Without an anchor the smallest half-extent is the answer, because every
   * face pairs that one with something no smaller. That is the same number the
   * old whole-solid bound gave, so a caller with no face in mind loses nothing.
   */
  maxShapeRadius(anchor?: SurfaceAnchor): number {
    if (anchor?.on === 'box-face') {
      const { halfU, halfV } = this.faceExtents(anchor.face)
      return Math.min(halfU, halfV)
    }
    const h = this.half()
    return Math.min(h.x, h.y, h.z)
  }

  bounds(): Box3 {
    const h = this.half()
    return new Box3(h.clone().negate(), h.clone())
  }
}

// --- Sphere ----------------------------------------------------------------

/**
 * A UV sphere cut for its own size, with RINGS AT HALF THE SEGMENTS.
 *
 * That ratio is the one that makes a facet square: segments divide a full turn
 * and rings divide a half one, so the two angular steps are equal exactly when
 * rings are half the segments -- which is the assumption `ballTolerance` reads
 * a facet's depth off, one step covering both directions.
 *
 * The pair this replaces was 64 by 40 at every size from a bead to a boulder:
 * 4992 triangles, finer up the rings than round the equator, and no relation to
 * how big the thing being drawn actually was.
 */
function sphereGeometry(radius: number): BufferGeometry {
  const segments = arcSegments(radius)
  return new SphereGeometry(radius, segments, segments / 2)
}

export class SphereSurface implements SurfaceDef {
  readonly kind = 'sphere'
  constructor(private radius: number) {}

  geometry(): BufferGeometry {
    return sphereGeometry(this.radius)
  }

  offsetGeometry(d: number): BufferGeometry | null {
    const r = this.radius + d
    if (r <= SURFACE_EPS) return null
    return sphereGeometry(r)
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const len = point.length()
    // A facet sags both ways here, and by however much the radius earned it, so
    // the bound is derived rather than read off a constant. A tighter one lets
    // a hit in the middle of a facet fall through to derived geometry and lose
    // its exact radial normal.
    const tolerance = ballTolerance(this.radius, arcSegments(this.radius))
    if (Math.abs(len - this.radius) > tolerance || len === 0) {
      return null
    }
    return {
      on: 'sphere',
      theta: Math.atan2(point.z, point.x),
      phi: Math.acos(clamp(point.y / len, -1, 1)),
    }
  }

  private normalAt(theta: number, phi: number): Vector3 {
    return new Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta)
    ).normalize()
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    if (anchor.on !== 'sphere') return derivedFrame(anchor)
    const normal = this.normalAt(anchor.theta, anchor.phi)
    const { uDir, vDir } = tangentBasis(normal)
    return { origin: normal.clone().multiplyScalar(this.radius), normal, uDir, vDir }
  }

  /**
   * Gnomonic projection: a tangent-plane point is pushed onto the sphere along
   * the line through the centre. Straight tangent edges become great-circle
   * arcs, and every projected point carries its own radial normal -- which is
   * exactly "perpendicular to the surface, away from the centre".
   */
  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    const f = this.frame(anchor)
    const dir = f.origin
      .clone()
      .addScaledVector(f.uDir, u)
      .addScaledVector(f.vDir, v)
      .normalize()
    return { position: dir.clone().multiplyScalar(this.radius), normal: dir }
  }

  clampAnchor(anchor: SurfaceAnchor): SurfaceAnchor {
    // A sphere has no edge to fall off, so the anchor is always valid.
    return anchor
  }

  raycast(ray: Ray): SurfaceHit | null {
    const point = ray.intersectSphere(
      new ThreeSphere(new Vector3(0, 0, 0), this.radius),
      new Vector3()
    )
    if (!point) return null
    return { point, normal: point.clone().normalize() }
  }

  sweep(_anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    const margin = Math.max(0.05, depth * 0.1)
    const maxIn = this.radius * CURVED_MAX_INWARD
    return op === 'extrude'
      ? { tIn: Math.min(this.radius * 0.5, maxIn), tOut: depth + margin }
      : { tIn: Math.min(depth + margin, maxIn), tOut: margin }
  }

  maxDepth(op: FeatureOp): number {
    return op === 'extrude' ? this.radius * 2 : this.radius * 0.8
  }

  /** There is no rim on a sphere, so the bound is the projection's, not an
   *  edge's -- see `CURVED_MAX_TANGENT`. */
  maxShapeRadius(): number {
    return this.radius * CURVED_MAX_TANGENT
  }

  bounds(): Box3 {
    const r = new Vector3(this.radius, this.radius, this.radius)
    return new Box3(r.clone().negate(), r)
  }
}

// --- Faceted (prism, pyramid, platonic, and every planar cap) ---------------

/**
 * Any convex solid described by polygonal faces.
 *
 * This is BoxSurface generalised: the box's normalised -1..1 face coordinates
 * only work because every box face is a rectangle, so a general face stores its
 * anchor in OBJECT UNITS and clamps against the real outline instead.
 *
 * `points` is the solid's whole vertex cloud, which is not the same thing as
 * the faces' vertices when this surface hosts only part of a solid: a cone's
 * base cap is flat, and measuring thickness from its own ring alone would say
 * the material behind it is zero units deep.
 */
export class FacetedSurface implements SurfaceDef {
  readonly kind: string
  private readonly faces: FacePatch[]
  private readonly points: Vector3[]
  private thinnest: number | null = null

  constructor(kind: string, faces: FacePatch[], points?: Vector3[]) {
    this.kind = kind
    this.faces = faces
    this.points = points ?? faces.flatMap(faceVertices)
  }

  /** A base edit can shrink the face count under a saved anchor; never throw. */
  private faceIndex(index: number): number {
    return clamp(Math.round(index), 0, this.faces.length - 1)
  }

  private face(index: number): FacePatch {
    return this.faces[this.faceIndex(index)]
  }

  /** Extent of the solid along a direction: the material behind a face. */
  private thicknessAlong(n: Vector3): number {
    let lo = Infinity
    let hi = -Infinity
    for (const p of this.points) {
      const d = p.dot(n)
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    return Number.isFinite(lo) ? hi - lo : 0
  }

  private minThickness(): number {
    if (this.thinnest === null) {
      this.thinnest = Math.min(...this.faces.map((f) => this.thicknessAlong(f.normal)))
    }
    return this.thinnest
  }

  private thicknessFor(anchor?: SurfaceAnchor): number {
    return anchor && anchor.on === 'planar-face'
      ? this.thicknessAlong(this.face(anchor.face).normal)
      : this.minThickness()
  }

  geometry(): BufferGeometry {
    return facesToGeometry(this.faces)
  }

  offsetGeometry(): BufferGeometry | null {
    // Flat anchors take the exact-prism path in evaluate.ts -- the swept prism
    // already ends exactly `depth` from the face -- so no offset shell is ever
    // asked for here. Building one would only be a slower way to get the same
    // answer, and a wrong one at the solid's edges.
    return null
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const tol = 1e-3
    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i]
      const rel = point.clone().sub(f.origin)
      if (Math.abs(rel.dot(f.normal)) > tol) continue
      const u = rel.dot(f.uDir)
      const v = rel.dot(f.vDir)
      if (!polygonContains(f.polygon, u, v, tol)) continue
      return { on: 'planar-face', face: i, u, v }
    }
    return null
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    if (anchor.on !== 'planar-face') return derivedFrame(anchor)
    const f = this.face(anchor.face)
    return {
      origin: facePoint(f, anchor.u, anchor.v),
      normal: f.normal.clone(),
      uDir: f.uDir.clone(),
      vDir: f.vDir.clone(),
    }
  }

  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    return flatProject(this.frame(anchor), u, v)
  }

  clampAnchor(anchor: SurfaceAnchor, shape: Shape2D): SurfaceAnchor {
    if (anchor.on !== 'planar-face') return anchor
    const face = this.faceIndex(anchor.face)
    const [u, v] = insetIntoPolygon(
      this.faces[face].polygon,
      anchor.u,
      anchor.v,
      shapeRadius(shape)
    )
    return { on: 'planar-face', face, u, v }
  }

  raycast(ray: Ray): SurfaceHit | null {
    let bestT = Infinity
    let hit: SurfaceHit | null = null
    for (const f of this.faces) {
      const denom = ray.direction.dot(f.normal)
      if (Math.abs(denom) < SURFACE_EPS) continue
      const t = f.origin.clone().sub(ray.origin).dot(f.normal) / denom
      if (t < 0 || t >= bestT) continue
      const p = ray.at(t, new Vector3())
      const rel = p.clone().sub(f.origin)
      if (!polygonContains(f.polygon, rel.dot(f.uDir), rel.dot(f.vDir), SURFACE_EPS)) {
        continue
      }
      bestT = t
      hit = { point: p, normal: f.normal.clone() }
    }
    return hit
  }

  sweep(anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    // Same reasoning as BoxSurface: bury the far end just enough to avoid a
    // coplanar seam, never far enough to punch out the back of the solid.
    const thickness = this.thicknessFor(anchor)
    const margin = Math.min(Math.max(0.05, depth * 0.1), thickness * 0.25)
    return op === 'extrude'
      ? { tIn: margin, tOut: depth }
      : { tIn: depth, tOut: margin }
  }

  maxDepth(op: FeatureOp, anchor?: SurfaceAnchor): number {
    const thickness = this.thicknessFor(anchor)
    // Intruding past the far side is a legitimate through-cut, so allow it.
    return op === 'extrude' ? thickness * 2 : thickness * 1.5
  }

  /**
   * The face's inradius: how far its own centre sits from its nearest edge.
   *
   * `polygonClearance` at the origin is exactly that, because `facePatch` seats
   * every face's frame on its centroid -- so this is the largest circle that
   * fits on the face WHERE THE PANEL WOULD PUT IT. On a face whose centroid is
   * not its incentre a slightly larger circle would fit off to one side, and
   * `insetIntoPolygon` will happily seat one there; what this bounds is the
   * sketch the user can grow without the outline being shoved sideways to make
   * room, which is the honest thing for a slider to stop at.
   */
  maxShapeRadius(anchor?: SurfaceAnchor): number {
    if (anchor?.on === 'planar-face') {
      return polygonClearance(this.face(anchor.face).polygon, 0, 0)
    }
    return Math.min(...this.faces.map((f) => polygonClearance(f.polygon, 0, 0)))
  }

  bounds(): Box3 {
    return new Box3().setFromPoints(this.points)
  }
}

// --- Cylinder ---------------------------------------------------------------

/**
 * A curved lateral wall plus two planar caps, dispatched on the anchor.
 *
 * The wall is parameterised so that u is ARC LENGTH around the barrel: a
 * straight edge in the tangent frame wraps with the curvature instead of
 * chording across it, which is what makes a rectangular boss here hug the wall.
 */
export class CylinderSurface implements SurfaceDef {
  readonly kind = 'cylinder'
  private readonly radius: number
  private readonly height: number
  private readonly caps: FacetedSurface

  constructor(radius: number, height: number) {
    this.radius = radius
    this.height = height
    this.caps = new FacetedSurface('cylinder-caps', [
      discFace(radius, height / 2, LATHE_SEGMENTS, true),
      discFace(radius, -height / 2, LATHE_SEGMENTS, false),
    ])
  }

  private wallFrame(theta: number, y: number): SurfaceFrame {
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    return {
      origin: new Vector3(this.radius * cos, y, this.radius * sin),
      normal: new Vector3(cos, 0, sin),
      // uDir cross vDir must equal the normal, so with vDir held at +Y (up on
      // screen is up on the solid) u runs the other way round the barrel.
      uDir: new Vector3(sin, 0, -cos),
      vDir: new Vector3(0, 1, 0),
    }
  }

  geometry(): BufferGeometry {
    return new CylinderGeometry(this.radius, this.radius, this.height, LATHE_SEGMENTS)
  }

  offsetGeometry(d: number): BufferGeometry | null {
    const r = this.radius + d
    const h = this.height + 2 * d
    if (r <= SURFACE_EPS || h <= SURFACE_EPS) return null
    return new CylinderGeometry(r, r, h, LATHE_SEGMENTS)
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const hh = this.height / 2
    const rho = Math.hypot(point.x, point.z)
    // The wall is tested first, so a hit on the rim reads as wall rather than
    // as a cap point sitting exactly on the cap's boundary.
    if (
      Math.abs(rho - this.radius) <= latheTolerance(this.radius, LATHE_SEGMENTS) &&
      Math.abs(point.y) <= hh + 1e-3
    ) {
      return {
        on: 'cylinder',
        theta: Math.atan2(point.z, point.x),
        y: clamp(point.y, -hh, hh),
      }
    }
    return this.caps.anchorFromHit(point)
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    if (anchor.on === 'planar-face') return this.caps.frame(anchor)
    if (anchor.on !== 'cylinder') return derivedFrame(anchor)
    return this.wallFrame(anchor.theta, anchor.y)
  }

  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    if (anchor.on === 'planar-face') return this.caps.project(anchor, u, v)
    if (anchor.on !== 'cylinder' || this.radius <= SURFACE_EPS) {
      return flatProject(this.frame(anchor), u, v)
    }
    const theta = anchor.theta - u / this.radius
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    return {
      position: new Vector3(this.radius * cos, anchor.y + v, this.radius * sin),
      normal: new Vector3(cos, 0, sin),
    }
  }

  clampAnchor(anchor: SurfaceAnchor, shape: Shape2D): SurfaceAnchor {
    if (anchor.on === 'planar-face') return this.caps.clampAnchor(anchor, shape)
    if (anchor.on !== 'cylinder') return anchor
    // Only height can run off the wall; theta wraps forever.
    const lim = Math.max(0, this.height / 2 - shapeRadius(shape))
    return { on: 'cylinder', theta: anchor.theta, y: clamp(anchor.y, -lim, lim) }
  }

  raycast(ray: Ray): SurfaceHit | null {
    const hh = this.height / 2
    const o = ray.origin
    const d = ray.direction
    let bestT = Infinity
    let hit: SurfaceHit | null = null

    for (const t of quadraticRoots(
      d.x * d.x + d.z * d.z,
      2 * (o.x * d.x + o.z * d.z),
      o.x * o.x + o.z * o.z - this.radius * this.radius
    )) {
      if (t < 0 || t >= bestT) continue
      const p = ray.at(t, new Vector3())
      if (Math.abs(p.y) > hh) continue
      bestT = t
      hit = { point: p, normal: new Vector3(p.x, 0, p.z).normalize() }
    }

    if (Math.abs(d.y) > SURFACE_EPS) {
      for (const sign of [1, -1]) {
        const t = (sign * hh - o.y) / d.y
        if (t < 0 || t >= bestT) continue
        const p = ray.at(t, new Vector3())
        if (Math.hypot(p.x, p.z) > this.radius) continue
        bestT = t
        hit = { point: p, normal: new Vector3(0, sign, 0) }
      }
    }
    return hit
  }

  sweep(anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    if (anchor.on === 'planar-face') return this.caps.sweep(anchor, depth, op)
    const margin = Math.max(0.05, depth * 0.1)
    const maxIn = this.radius * CURVED_MAX_INWARD
    return op === 'extrude'
      ? { tIn: Math.min(this.radius * 0.5, maxIn), tOut: depth + margin }
      : { tIn: Math.min(depth + margin, maxIn), tOut: margin }
  }

  maxDepth(op: FeatureOp, anchor?: SurfaceAnchor): number {
    if (anchor && anchor.on === 'planar-face') return this.caps.maxDepth(op, anchor)
    return op === 'extrude' ? this.radius * 2 : this.radius * 0.8
  }

  /**
   * Half the wall's height, or a quarter of its circumference, whichever runs
   * out first.
   *
   * The height is the bound `clampAnchor` already enforces on this patch, so
   * without it here the two disagreed: the panel would grow a sketch the slide
   * then pinned to the middle of the barrel with its outline hanging off both
   * rims. The circumference is the other way it runs out -- u is arc length
   * round the barrel, so an outline of radius r spans 2r of it, and half the
   * way round is as far as one can reach before it starts lapping itself.
   */
  private wallShapeRadius(): number {
    return Math.min(this.height / 2, (Math.PI * this.radius) / 2)
  }

  maxShapeRadius(anchor?: SurfaceAnchor): number {
    if (anchor?.on === 'planar-face') return this.caps.maxShapeRadius(anchor)
    if (anchor?.on === 'cylinder') return this.wallShapeRadius()
    return Math.min(this.caps.maxShapeRadius(), this.wallShapeRadius())
  }

  bounds(): Box3 {
    const hh = this.height / 2
    return new Box3(
      new Vector3(-this.radius, -hh, -this.radius),
      new Vector3(this.radius, hh, this.radius)
    )
  }
}

// --- Cone -------------------------------------------------------------------

/** Never let a sketch climb into the apex, where the normals all converge. */
const CONE_MAX_T = 0.85

/**
 * A planar base cap plus a curved lateral wall, with the apex at +height/2.
 *
 * The wall's projection unrolls the cone into a plane. That map is an ISOMETRY
 * -- a cone is developable -- so a straight edge in the tangent frame becomes
 * an exact geodesic on the surface, the same role gnomonic projection plays for
 * the sphere.
 */
export class ConeSurface implements SurfaceDef {
  readonly kind = 'cone'
  private readonly radius: number
  private readonly height: number
  /** Apex-to-rim distance; the unrolled cone is a sector of this radius. */
  private readonly slant: number
  private readonly base: FacetedSurface

  constructor(radius: number, height: number) {
    this.radius = radius
    this.height = height
    this.slant = Math.hypot(radius, height)
    const cap = discFace(radius, -height / 2, LATHE_SEGMENTS, false)
    this.base = new FacetedSurface('cone-base', [cap], [
      ...faceVertices(cap),
      new Vector3(0, height / 2, 0),
    ])
  }

  /** Outward wall normal: perpendicular to the slant, tilted up by the taper. */
  private wallNormal(theta: number): Vector3 {
    return new Vector3(
      this.height * Math.cos(theta),
      this.radius,
      this.height * Math.sin(theta)
    ).normalize()
  }

  /** Wall point at azimuth `theta`, `ell` measured along the slant from the apex. */
  private wallPoint(theta: number, ell: number): Vector3 {
    const rho = (ell * this.radius) / this.slant
    return new Vector3(
      rho * Math.cos(theta),
      this.height / 2 - (ell * this.height) / this.slant,
      rho * Math.sin(theta)
    )
  }

  /** How far the tool can travel inward before the radial rays meet the axis. */
  private inwardReach(t: number): number {
    if (this.height <= SURFACE_EPS) return this.slant
    const rho = (1 - clamp(t, 0, 1)) * this.radius
    return Math.min((rho * this.slant) / this.height, this.slant)
  }

  geometry(): BufferGeometry {
    return new ConeGeometry(this.radius, this.height, LATHE_SEGMENTS)
  }

  /**
   * A cone offset by `d` is another cone with the SAME half-angle, so the wall
   * moves out by exactly `d` everywhere. Both ends have to move for that to
   * hold: the apex climbs by d*L/R while the base drops by d, which keeps the
   * wall's plane constant at (R*h)/(2L) + d.
   */
  offsetGeometry(d: number): BufferGeometry | null {
    if (this.radius <= SURFACE_EPS || this.height <= SURFACE_EPS) return null
    const apexY = this.height / 2 + (d * this.slant) / this.radius
    const baseY = -this.height / 2 - d
    const h = apexY - baseY
    if (h <= SURFACE_EPS) return null
    const r = (this.radius / this.height) * h
    if (r <= SURFACE_EPS) return null
    const geom = new ConeGeometry(r, h, LATHE_SEGMENTS)
    geom.translate(0, (apexY + baseY) / 2, 0)
    return geom
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const hh = this.height / 2
    if (this.radius > SURFACE_EPS && this.height > SURFACE_EPS) {
      const expected = (this.radius * (hh - point.y)) / this.height
      // Radial slack for a given perpendicular slack is stretched by L/h.
      const tol =
        (latheTolerance(this.radius, LATHE_SEGMENTS) * this.slant) / this.height
      if (
        point.y >= -hh - 1e-3 &&
        point.y <= hh + 1e-3 &&
        Math.abs(Math.hypot(point.x, point.z) - expected) <= tol
      ) {
        return {
          on: 'cone',
          theta: Math.atan2(point.z, point.x),
          t: clamp((point.y + hh) / this.height, 0, 1),
        }
      }
    }
    return this.base.anchorFromHit(point)
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    if (anchor.on === 'planar-face') return this.base.frame(anchor)
    if (anchor.on !== 'cone') return derivedFrame(anchor)
    const normal = this.wallNormal(anchor.theta)
    const uDir = new Vector3(Math.sin(anchor.theta), 0, -Math.cos(anchor.theta))
    return {
      origin: this.wallPoint(anchor.theta, this.slant * (1 - anchor.t)),
      normal,
      // vDir then points straight uphill, toward the apex.
      uDir,
      vDir: new Vector3().crossVectors(normal, uDir),
    }
  }

  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    if (anchor.on === 'planar-face') return this.base.project(anchor, u, v)
    if (anchor.on !== 'cone' || this.radius <= SURFACE_EPS || this.slant <= SURFACE_EPS) {
      return flatProject(this.frame(anchor), u, v)
    }

    // Unrolled, azimuth theta becomes polar angle k*theta at slant radius ell.
    const k = this.radius / this.slant
    const ell0 = this.slant * (1 - anchor.t)
    const psi = k * anchor.theta
    const cos = Math.cos(psi)
    const sin = Math.sin(psi)
    // Images of uDir and vDir in the unrolled plane. Unrolling flips handedness
    // (the sector is the surface seen from inside), and that flip is precisely
    // what rolls a CCW tangent-frame outline back as CCW seen from outside.
    const qx = ell0 * cos + u * sin - v * cos
    const qy = ell0 * sin - u * cos - v * sin

    const ell = Math.max(Math.hypot(qx, qy), this.slant * 1e-3)
    // Wrap the sector angle before dividing by k: atan2's jump at PI would
    // otherwise throw the point a whole turn around the cone.
    const dpsi =
      ((Math.atan2(qy, qx) - psi + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) -
      Math.PI
    const theta = anchor.theta + dpsi / k
    return { position: this.wallPoint(theta, ell), normal: this.wallNormal(theta) }
  }

  clampAnchor(anchor: SurfaceAnchor, shape: Shape2D): SurfaceAnchor {
    if (anchor.on === 'planar-face') return this.base.clampAnchor(anchor, shape)
    if (anchor.on !== 'cone') return anchor
    const r = this.slant > SURFACE_EPS ? shapeRadius(shape) / this.slant : 1
    const lo = Math.min(r, CONE_MAX_T)
    const hi = Math.min(CONE_MAX_T, 1 - r)
    if (hi <= lo) return { on: 'cone', theta: anchor.theta, t: CONE_MAX_T / 2 }
    return { on: 'cone', theta: anchor.theta, t: clamp(anchor.t, lo, hi) }
  }

  raycast(ray: Ray): SurfaceHit | null {
    const hh = this.height / 2
    if (this.radius <= SURFACE_EPS || this.height <= SURFACE_EPS) return null
    const m = this.radius / this.height
    const o = ray.origin
    const d = ray.direction
    const w = hh - o.y
    let bestT = Infinity
    let hit: SurfaceHit | null = null

    for (const t of quadraticRoots(
      d.x * d.x + d.z * d.z - m * m * d.y * d.y,
      2 * (o.x * d.x + o.z * d.z + m * m * w * d.y),
      o.x * o.x + o.z * o.z - m * m * w * w
    )) {
      if (t < 0 || t >= bestT) continue
      const p = ray.at(t, new Vector3())
      if (p.y < -hh || p.y > hh) continue
      bestT = t
      hit = { point: p, normal: this.wallNormal(Math.atan2(p.z, p.x)) }
    }

    if (Math.abs(d.y) > SURFACE_EPS) {
      const t = (-hh - o.y) / d.y
      if (t >= 0 && t < bestT) {
        const p = ray.at(t, new Vector3())
        if (Math.hypot(p.x, p.z) <= this.radius) {
          bestT = t
          hit = { point: p, normal: new Vector3(0, -1, 0) }
        }
      }
    }
    return hit
  }

  sweep(anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    if (anchor.on === 'planar-face') return this.base.sweep(anchor, depth, op)
    const margin = Math.max(0.05, depth * 0.1)
    const reach = this.inwardReach(anchor.on === 'cone' ? anchor.t : 0.5)
    const maxIn = reach * CURVED_MAX_INWARD
    return op === 'extrude'
      ? { tIn: Math.min(reach * 0.5, maxIn), tOut: depth + margin }
      : { tIn: Math.min(depth + margin, maxIn), tOut: margin }
  }

  maxDepth(op: FeatureOp, anchor?: SurfaceAnchor): number {
    if (anchor && anchor.on === 'planar-face') return this.base.maxDepth(op, anchor)
    if (op === 'extrude') return Math.max(this.radius, this.height) * 2
    return this.inwardReach(anchor && anchor.on === 'cone' ? anchor.t : 0.5) * 0.8
  }

  /**
   * Half the wall's usable band, measured along the slant.
   *
   * `clampAnchor` seats a sketch of radius r between t = r/slant and
   * t = CONE_MAX_T - r/slant, so the band it has to fit inside runs from the
   * rim to the point where the apex is fenced off, and a sketch centred in it
   * reaches half that band each way. Past this the two limits cross and the
   * sketch is dumped in the middle of the band whatever the user asked for.
   */
  private wallShapeRadius(): number {
    return (this.slant * CONE_MAX_T) / 2
  }

  maxShapeRadius(anchor?: SurfaceAnchor): number {
    if (anchor?.on === 'planar-face') return this.base.maxShapeRadius(anchor)
    if (anchor?.on === 'cone') return this.wallShapeRadius()
    return Math.min(this.base.maxShapeRadius(), this.wallShapeRadius())
  }

  bounds(): Box3 {
    const hh = this.height / 2
    return new Box3(
      new Vector3(-this.radius, -hh, -this.radius),
      new Vector3(this.radius, hh, this.radius)
    )
  }
}

// --- Capsule ("bean") -------------------------------------------------------

/**
 * A capsule cut for its own size, with CAP ROWS AT A QUARTER OF THE SEGMENTS.
 *
 * The sphere's reasoning one step on: a cap is a QUARTER turn, so a quarter of
 * the segments makes its rows as tall as the columns are wide. The pair this
 * replaces was 16 cap rows against 48 segments -- a third finer up the caps
 * than round them, at every size.
 */
function capsuleGeometry(radius: number, height: number): BufferGeometry {
  const segments = arcSegments(radius)
  return new CapsuleGeometry(radius, height, segments / 4, segments)
}

/**
 * The set of points exactly `radius` from the axis SEGMENT, i.e. a sphere swept
 * along a line. Modelling it that way pays for itself twice: the offset is just
 * a fatter capsule with the same mid-section (exact, not approximated), and the
 * projection is the sphere's own -- push out from the nearest axis point rather
 * than from the centre.
 *
 * A capsule of height 0 IS a sphere, and every formula here degenerates to
 * SphereSurface's when the segment collapses to a point.
 */
export class CapsuleSurface implements SurfaceDef {
  readonly kind = 'capsule'
  private readonly radius: number
  private readonly height: number

  constructor(radius: number, height: number) {
    this.radius = radius
    this.height = height
  }

  /** Length of a pole-to-pole meridian: two quarter arcs plus the straight run. */
  private meridian(): number {
    return Math.PI * this.radius + this.height
  }

  /**
   * phi walks that meridian at constant speed, so the poles are the centres of
   * the hemispherical ends and the middle band is the cylinder. Returns the
   * axis point the surface point hangs off, plus its outward direction.
   */
  private seat(theta: number, phi: number): { axis: Vector3; dir: Vector3 } {
    const hh = this.height / 2
    const r = this.radius
    const quarter = (Math.PI / 2) * r
    const ell = (clamp(phi, 0, Math.PI) / Math.PI) * this.meridian()
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)

    if (ell <= quarter) {
      const a = r > SURFACE_EPS ? ell / r : 0
      return {
        axis: new Vector3(0, hh, 0),
        dir: new Vector3(Math.sin(a) * cos, Math.cos(a), Math.sin(a) * sin),
      }
    }
    if (ell <= quarter + this.height) {
      return {
        axis: new Vector3(0, hh - (ell - quarter), 0),
        dir: new Vector3(cos, 0, sin),
      }
    }
    const a = r > SURFACE_EPS ? (ell - quarter - this.height) / r : 0
    return {
      axis: new Vector3(0, -hh, 0),
      dir: new Vector3(Math.cos(a) * cos, -Math.sin(a), Math.cos(a) * sin),
    }
  }

  /** Nearest point on the axis segment, which is what the surface hangs off. */
  private nearestAxisPoint(p: Vector3): Vector3 {
    const hh = this.height / 2
    return new Vector3(0, clamp(p.y, -hh, hh), 0)
  }

  geometry(): BufferGeometry {
    return capsuleGeometry(this.radius, this.height)
  }

  offsetGeometry(d: number): BufferGeometry | null {
    const r = this.radius + d
    if (r <= SURFACE_EPS) return null
    return capsuleGeometry(r, this.height)
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const hh = this.height / 2
    const r = this.radius
    const dist = point.distanceTo(this.nearestAxisPoint(point))
    // A bean's caps are a sphere's, so they sag both ways; its middle is a
    // barrel and sags one. The looser of the two bounds is the one that has to
    // hold, or a hit on a cap would read as derived geometry.
    if (Math.abs(dist - r) > ballTolerance(r, arcSegments(r)) || dist < SURFACE_EPS) {
      return null
    }
    const quarter = (Math.PI / 2) * r
    let ell: number
    if (point.y > hh) {
      ell = r * Math.acos(clamp((point.y - hh) / r, -1, 1))
    } else if (point.y < -hh) {
      ell = quarter + this.height + r * Math.asin(clamp((-hh - point.y) / r, -1, 1))
    } else {
      ell = quarter + (hh - point.y)
    }
    return {
      on: 'capsule',
      theta: Math.atan2(point.z, point.x),
      phi: clamp((Math.PI * ell) / this.meridian(), 0, Math.PI),
    }
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    if (anchor.on !== 'capsule') return derivedFrame(anchor)
    const { axis, dir } = this.seat(anchor.theta, anchor.phi)
    const { uDir, vDir } = tangentBasis(dir)
    return { origin: axis.addScaledVector(dir, this.radius), normal: dir, uDir, vDir }
  }

  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    if (anchor.on !== 'capsule') return flatProject(this.frame(anchor), u, v)
    const f = this.frame(anchor)
    const q = f.origin.clone().addScaledVector(f.uDir, u).addScaledVector(f.vDir, v)
    const axis = this.nearestAxisPoint(q)
    const dir = q.sub(axis)
    const len = dir.length()
    if (len < SURFACE_EPS) return { position: f.origin, normal: f.normal }
    dir.divideScalar(len)
    return { position: axis.addScaledVector(dir, this.radius), normal: dir }
  }

  clampAnchor(anchor: SurfaceAnchor): SurfaceAnchor {
    // Closed and smooth, exactly like a sphere: there is no edge to fall off.
    return anchor
  }

  raycast(ray: Ray): SurfaceHit | null {
    const hh = this.height / 2
    const r = this.radius
    const o = ray.origin
    const d = ray.direction
    let bestT = Infinity
    let hit: SurfaceHit | null = null

    for (const t of quadraticRoots(
      d.x * d.x + d.z * d.z,
      2 * (o.x * d.x + o.z * d.z),
      o.x * o.x + o.z * o.z - r * r
    )) {
      if (t < 0 || t >= bestT) continue
      const p = ray.at(t, new Vector3())
      if (Math.abs(p.y) > hh) continue
      bestT = t
      hit = { point: p, normal: new Vector3(p.x, 0, p.z).normalize() }
    }

    for (const sign of [1, -1]) {
      const centre = new Vector3(0, sign * hh, 0)
      const oc = o.clone().sub(centre)
      for (const t of quadraticRoots(d.dot(d), 2 * oc.dot(d), oc.dot(oc) - r * r)) {
        if (t < 0 || t >= bestT) continue
        const p = ray.at(t, new Vector3())
        if (sign > 0 ? p.y < hh : p.y > -hh) continue
        bestT = t
        hit = { point: p, normal: p.clone().sub(centre).normalize() }
      }
    }
    return hit
  }

  sweep(_anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    const margin = Math.max(0.05, depth * 0.1)
    const maxIn = this.radius * CURVED_MAX_INWARD
    return op === 'extrude'
      ? { tIn: Math.min(this.radius * 0.5, maxIn), tOut: depth + margin }
      : { tIn: Math.min(depth + margin, maxIn), tOut: margin }
  }

  maxDepth(op: FeatureOp): number {
    return op === 'extrude' ? this.radius * 2 : this.radius * 0.8
  }

  /** Closed and smooth, exactly like a sphere: no rim, so the projection sets
   *  the bound. The straight mid-section only ever gives a sketch MORE room
   *  than the hemispherical ends do, so the ends are the number. */
  maxShapeRadius(): number {
    return this.radius * CURVED_MAX_TANGENT
  }

  bounds(): Box3 {
    const hh = this.height / 2 + this.radius
    return new Box3(
      new Vector3(-this.radius, -hh, -this.radius),
      new Vector3(this.radius, hh, this.radius)
    )
  }
}

// --- Derived (geometry created by an earlier feature) -----------------------

/**
 * Hosts sketches placed on faces that earlier features produced. No analytic
 * parameterisation exists for those, so the patch is treated as locally flat.
 */
export class DerivedSurface implements SurfaceDef {
  readonly kind = 'derived'
  constructor(private span: number) {}

  geometry(): BufferGeometry {
    throw new Error('DerivedSurface hosts sketches only; it is never a base solid')
  }
  offsetGeometry(): BufferGeometry | null {
    return null
  }
  anchorFromHit(): SurfaceAnchor | null {
    return null
  }
  frame(anchor: SurfaceAnchor): SurfaceFrame {
    return derivedFrame(anchor)
  }
  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    return flatProject(this.frame(anchor), u, v)
  }
  clampAnchor(anchor: SurfaceAnchor): SurfaceAnchor {
    return anchor
  }
  raycast(): SurfaceHit | null {
    return null
  }
  sweep(_anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    // Same reasoning as BoxSurface: bury the tool just enough to avoid a
    // coplanar seam, never far enough to punch out the far side.
    const margin = Math.min(Math.max(0.05, depth * 0.1), this.span * 0.05)
    return op === 'extrude'
      ? { tIn: margin, tOut: depth }
      : { tIn: depth, tOut: margin }
  }
  maxDepth(): number {
    return this.span
  }
  /** Nothing here has an edge to fall off -- `clampAnchor` is the identity for
   *  the same reason -- so the only honest bound is the reach of the solid the
   *  patch was cut out of. */
  maxShapeRadius(): number {
    return this.span / 2
  }
  bounds(): Box3 {
    // Only ever consulted through baseSpan, which asks the BASE solid; this is
    // the honest answer for a patch whose extent nobody knows.
    const h = new Vector3(this.span / 2, this.span / 2, this.span / 2)
    return new Box3(h.clone().negate(), h)
  }
}

// --- Imported model --------------------------------------------------------

/**
 * A model read out of a file, standing in the place a primitive normally does.
 *
 * Almost everything here answers the way `DerivedSurface` answers, and for the
 * same reason: there is no analytic surface to consult. A cube's face can be
 * named, parameterised, offset and raycast in closed form; a hundred thousand
 * imported triangles cannot be, and pretending otherwise would mean guessing
 * which of them the user meant.
 *
 * The two questions it CAN answer are the two that matter for a base solid, and
 * they are the reason this is a class rather than a `DerivedSurface`:
 *
 *   geometry()  the triangles themselves, scaled to `size`
 *   bounds()    the box they fill, which is exactly `size` by construction
 *
 * Sketches still work on one. `anchorFromHit` returns null, so every hit on an
 * imported model classifies as a DERIVED anchor -- a point and a normal in
 * object space, treated as locally flat -- which is the same treatment a hit on
 * a boss the user grew ten edits ago already gets. Push and pull behave there,
 * so they behave here.
 *
 * `kind` carries the model's id, which is what makes swapping the model under
 * an object drop that object's sketches: they are anchored to points on a
 * surface that no longer exists. Resizing keeps the id, so they survive it --
 * the same bargain a box strikes.
 */
export class MeshSurface implements SurfaceDef {
  readonly kind: string
  constructor(
    private meshId: string,
    private size: Vec3
  ) {
    this.kind = `mesh-${meshId}`
  }

  /** Half the diagonal of the box, which is what a tool has to be able to reach. */
  private span(): number {
    return Math.hypot(...this.size)
  }

  geometry(): BufferGeometry {
    return meshGeometry(this.meshId, this.size)
  }

  offsetGeometry(): BufferGeometry | null {
    // No analytic offset exists, and none is ever asked for: an offset shell is
    // only consulted for a CURVED anchor, and every anchor on a mesh is derived.
    return null
  }

  anchorFromHit(): SurfaceAnchor | null {
    return null
  }

  frame(anchor: SurfaceAnchor): SurfaceFrame {
    return derivedFrame(anchor)
  }

  project(anchor: SurfaceAnchor, u: number, v: number): ProjectedPoint {
    return flatProject(this.frame(anchor), u, v)
  }

  clampAnchor(anchor: SurfaceAnchor): SurfaceAnchor {
    // Nothing to clamp against: the "face" is whatever triangle the pointer
    // landed on, and a sketch is free to run across as many of them as it likes.
    return anchor
  }

  raycast(): SurfaceHit | null {
    // The evaluated mesh IS the surface here, so `picking.ts` falls through to
    // raycasting it -- which is the accurate answer rather than the fallback.
    return null
  }

  sweep(_anchor: SurfaceAnchor, depth: number, op: FeatureOp): Sweep {
    // The same reasoning as BoxSurface and DerivedSurface: bury the tool just
    // enough to avoid a coplanar seam, never far enough to punch out the back.
    const margin = Math.min(Math.max(0.05, depth * 0.1), this.span() * 0.05)
    return op === 'extrude' ? { tIn: margin, tOut: depth } : { tIn: depth, tOut: margin }
  }

  maxDepth(): number {
    return this.span()
  }

  /** Every anchor on an import is derived, and a derived patch is whatever
   *  triangles the sketch happens to cover -- there is no face to be bounded
   *  by, so this answers the way `DerivedSurface` does. */
  maxShapeRadius(): number {
    return this.span() / 2
  }

  bounds(): Box3 {
    const h = new Vector3(this.size[0] / 2, this.size[1] / 2, this.size[2] / 2)
    return new Box3(h.clone().negate(), h)
  }
}

// --- Factories -------------------------------------------------------------

/**
 * Faceted solids carry their side count in `kind` because docStore drops a
 * feature list when the surface kind changes: a face index means something
 * different on a hexagon than on an octagon, so those anchors must not survive.
 */
export function surfaceFor(base: BaseSolid): SurfaceDef {
  switch (base.kind) {
    case 'box':
      return new BoxSurface(base.size)
    case 'sphere':
      return new SphereSurface(base.radius)
    case 'cylinder':
      return new CylinderSurface(base.radius, base.height)
    case 'cone':
      return new ConeSurface(base.radius, base.height)
    case 'capsule':
      return new CapsuleSurface(base.radius, base.height)
    case 'prism':
      return new FacetedSurface(
        `prism-${Math.max(3, Math.round(base.sides))}`,
        prismFaces(base.radius, base.height, base.sides)
      )
    case 'pyramid':
      return new FacetedSurface(
        `pyramid-${Math.max(3, Math.round(base.sides))}`,
        pyramidFaces(base.radius, base.height, base.sides)
      )
    case 'platonic':
      return new FacetedSurface(
        `platonic-${base.solid}`,
        platonicFaces(base.solid, base.radius)
      )
    case 'mesh':
      return new MeshSurface(base.meshId, base.size)
  }
}

/** Diagonal of the solid plus a unit of slack: big enough to bound any tool. */
export function baseSpan(base: BaseSolid): number {
  const box = surfaceFor(base).bounds()
  return box.min.distanceTo(box.max) + 1
}

/** The surface hosting a given anchor, which is not always the base solid. */
export function hostSurfaceFor(base: BaseSolid, anchor: SurfaceAnchor): SurfaceDef {
  if (anchor.on === 'derived') return new DerivedSurface(baseSpan(base))
  return surfaceFor(base)
}

/** True when the anchor sits on a genuinely curved patch. */
export function anchorIsCurved(anchor: SurfaceAnchor): boolean {
  return isCurvedAnchor(anchor)
}

/**
 * Any edit that resizes a sketch, or the solid under it, can push it off its
 * face; pull it back on.
 *
 * Here rather than in the store because three callers now need it and they must
 * not answer it differently: a panel edit, a gizmo resize, and the uniform
 * scale that walks a whole merged assembly.
 */
export function reseat(base: BaseSolid, f: Feature): Feature {
  return { ...f, anchor: hostSurfaceFor(base, f.anchor).clampAnchor(f.anchor, f.shape) }
}

/**
 * How far a feature on this patch may sweep each way, as a pair of POSITIVE
 * magnitudes.
 *
 * The two are not the same number and never were: a boss may stand a couple of
 * thicknesses proud of a face, where a pocket that reached as far would be a
 * hole out the other side of a solid the user never meant to pierce. That
 * asymmetry is why the depth slider does not simply run from -max to +max, and
 * why it is derived here rather than at each of the three places that ask --
 * the panel that draws the slider, the store that clamps what is typed into it,
 * and the arrow that drags it.
 */
export function depthLimits(
  host: SurfaceDef,
  anchor: SurfaceAnchor
): { in: number; out: number } {
  return { in: host.maxDepth('intrude', anchor), out: host.maxDepth('extrude', anchor) }
}

/**
 * Widest sketch the patch under `anchor` will hold, measured from its centre.
 *
 * Lives here rather than beside the solid dimensions because the answer is a
 * question about a SURFACE, and the version that lived there could not ask one:
 * it read a radius or a size off the base and shaved a flat tenth off it, so a
 * sketch stopped a tenth short of every rim whether or not there was anything
 * in the way, and a broad face on a thin solid was bounded by the thinness.
 *
 * Two places ask -- the Inspector's Radius and Width fields, and the sketch
 * gizmo's ring -- and a bound only one of them honoured would let a drag build
 * a sketch the panel then refused to show. `MIN_SHAPE` is the floor for the
 * same reason the fields take it as their minimum: a degenerate patch answering
 * zero would leave a slider whose maximum sat under its minimum.
 */
export function maxShapeSize(base: BaseSolid, anchor?: SurfaceAnchor): number {
  const host = anchor ? hostSurfaceFor(base, anchor) : surfaceFor(base)
  return Math.max(MIN_SHAPE, host.maxShapeRadius(anchor))
}

/** A signed depth held inside those limits, keeping the direction it names. */
export function clampDepth(host: SurfaceDef, anchor: SurfaceAnchor, depth: number): number {
  const limit = depthLimits(host, anchor)
  return Math.max(-limit.in, Math.min(limit.out, depth))
}

/** Reseating plus a depth clamp, for edits that shrink the solid underneath. */
export function conform(base: BaseSolid, f: Feature): Feature {
  const next = reseat(base, f)
  const host = hostSurfaceFor(base, next.anchor)
  return { ...next, depth: clampDepth(host, next.anchor, next.depth) }
}

/**
 * Whether two anchors name the same patch of the same surface.
 *
 * Only the multi-patch kinds carry a face index; for every other kind the patch
 * IS the surface, so matching `on` is the whole question.
 */
export function samePatch(a: SurfaceAnchor, b: SurfaceAnchor): boolean {
  if (a.on !== b.on) return false
  if (a.on === 'box-face' && b.on === 'box-face') return a.face === b.face
  if (a.on === 'planar-face' && b.on === 'planar-face') return a.face === b.face
  return true
}

/**
 * Slide a sketch across the surface it already sits on, by an offset measured
 * in that surface's own tangent frame.
 *
 * This is the parametric half of the sketch gizmo. `project` maps a tangent
 * offset back onto the surface -- straight along the tangent on a flat face,
 * radially re-seated on a sphere -- and `anchorFromHit` turns the point that
 * lands there back into an anchor, so a slide across a curved host follows the
 * curvature instead of leaving it.
 *
 * Null when the offset walks off the edge of the patch. Returning the
 * neighbouring face instead would be worse than doing nothing: the gesture
 * promised to move the sketch ALONG the face it is on, and a sketch that
 * suddenly wrapped around a corner is not that. The caller holds its last good
 * anchor, and `clampAnchor` has usually pinned the sketch at its limit well
 * before the raw point ever leaves the face.
 */
export function slideAnchor(
  host: SurfaceDef,
  anchor: SurfaceAnchor,
  u: number,
  v: number
): SurfaceAnchor | null {
  const { position } = host.project(anchor, u, v)

  // A derived patch has no parameterisation to classify against -- the anchor
  // IS a point and a normal -- so the slid point is the answer directly.
  if (anchor.on === 'derived') {
    return {
      on: 'derived',
      point: [position.x, position.y, position.z],
      normal: anchor.normal,
    }
  }

  const next = host.anchorFromHit(position)
  return next && samePatch(next, anchor) ? next : null
}
