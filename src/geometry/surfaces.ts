import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Ray,
  Sphere as ThreeSphere,
  SphereGeometry,
  Vector3,
} from 'three'
import type { BaseSolid, BoxFace, Shape2D, SurfaceAnchor, Vec3 } from './types'
import { shapeRadius } from './types'

export const SURFACE_EPS = 1e-4

export type SurfaceFrame = {
  origin: Vector3
  normal: Vector3
  uDir: Vector3
  vDir: Vector3
}

export type ProjectedPoint = { position: Vector3; normal: Vector3 }

export type SurfaceHit = { point: Vector3; normal: Vector3 }

export type FeatureOp = 'extrude' | 'intrude'

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
  maxDepth(op: FeatureOp): number
}

/** Robust tangent basis: picks a reference axis that is never parallel to n. */
export function tangentBasis(n: Vector3): { uDir: Vector3; vDir: Vector3 } {
  const ref = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  const uDir = new Vector3().crossVectors(ref, n).normalize()
  const vDir = new Vector3().crossVectors(n, uDir).normalize()
  // uDir cross vDir === n, so a CCW outline in (u,v) faces outward.
  return { uDir, vDir }
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
    const f = this.frame(anchor)
    return {
      position: f.origin.clone().addScaledVector(f.uDir, u).addScaledVector(f.vDir, v),
      normal: f.normal.clone(),
    }
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
      u: Math.max(-limU, Math.min(limU, anchor.u)),
      v: Math.max(-limV, Math.min(limV, anchor.v)),
    }
  }

  raycast(ray: Ray): SurfaceHit | null {
    const h = this.half()
    const box = new Box3(h.clone().negate(), h.clone())
    const point = ray.intersectBox(box, new Vector3())
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
}

// --- Sphere ----------------------------------------------------------------

const SPHERE_SEGMENTS = 64
const SPHERE_RINGS = 40

/**
 * Radial rays converge at the centre, so a prism swept inward past it folds
 * through itself and silently corrupts the CSG result. Stay well short.
 */
const SPHERE_MAX_INWARD = 0.85

export class SphereSurface implements SurfaceDef {
  readonly kind = 'sphere'
  constructor(private radius: number) {}

  geometry(): BufferGeometry {
    return new SphereGeometry(this.radius, SPHERE_SEGMENTS, SPHERE_RINGS)
  }

  offsetGeometry(d: number): BufferGeometry | null {
    const r = this.radius + d
    if (r <= SURFACE_EPS) return null
    return new SphereGeometry(r, SPHERE_SEGMENTS, SPHERE_RINGS)
  }

  anchorFromHit(point: Vector3): SurfaceAnchor | null {
    const len = point.length()
    if (Math.abs(len - this.radius) > 1e-3 || len === 0) return null
    return {
      on: 'sphere',
      theta: Math.atan2(point.z, point.x),
      phi: Math.acos(Math.max(-1, Math.min(1, point.y / len))),
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
    const maxIn = this.radius * SPHERE_MAX_INWARD
    return op === 'extrude'
      ? { tIn: Math.min(this.radius * 0.5, maxIn), tOut: depth + margin }
      : { tIn: Math.min(depth + margin, maxIn), tOut: margin }
  }

  maxDepth(op: FeatureOp): number {
    return op === 'extrude' ? this.radius * 2 : this.radius * 0.8
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
    const f = this.frame(anchor)
    return {
      position: f.origin.clone().addScaledVector(f.uDir, u).addScaledVector(f.vDir, v),
      normal: f.normal.clone(),
    }
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
}

// --- Factories -------------------------------------------------------------

export function surfaceFor(base: BaseSolid): SurfaceDef {
  return base.kind === 'box' ? new BoxSurface(base.size) : new SphereSurface(base.radius)
}

export function baseSpan(base: BaseSolid): number {
  return base.kind === 'box' ? Math.hypot(...base.size) + 1 : base.radius * 2 + 1
}

/** The surface hosting a given anchor, which is not always the base solid. */
export function hostSurfaceFor(base: BaseSolid, anchor: SurfaceAnchor): SurfaceDef {
  if (anchor.on === 'derived') return new DerivedSurface(baseSpan(base))
  return surfaceFor(base)
}

/** True when the anchor sits on a genuinely curved patch. */
export function anchorIsCurved(anchor: SurfaceAnchor): boolean {
  return anchor.on === 'sphere'
}
