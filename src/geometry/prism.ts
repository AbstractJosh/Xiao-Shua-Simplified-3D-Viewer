import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import type { ProjectedPoint, SurfaceDef } from './surfaces'
import { anchorIsCurved } from './surfaces'
import { sampleOutline } from './outline'
import type { Feature, SurfaceAnchor } from './types'

/**
 * Lift a feature's 2D outline onto its host surface, giving a closed ring of
 * (point, outward normal) pairs.
 *
 * This is the single representation the whole engine runs on. On a flat face
 * every normal is identical and the sweep below produces a straight prism; on
 * a sphere each normal is its own radial direction and the very same sweep
 * produces a frustum converging toward the centre. Curvature is not a special
 * case -- it falls out of the surface's `project`.
 */
export function outlineOnSurface(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: Pick<Feature, 'shape' | 'rotation'>
): ProjectedPoint[] {
  const curved = anchorIsCurved(anchor)
  return sampleOutline(feature.shape, feature.rotation, curved).map(([u, v]) =>
    surface.project(anchor, u, v)
  )
}

/**
 * Sweep a ring of (point, normal) pairs into a closed solid, from `tIn` behind
 * each point to `tOut` in front of it, each along its own normal.
 *
 * The result is watertight by construction, which is what three-bvh-csg
 * requires. Caps are triangle fans, valid because every v1 outline is convex.
 */
export function buildSweptPrism(
  ring: ProjectedPoint[],
  tIn: number,
  tOut: number
): BufferGeometry | null {
  const n = ring.length
  if (n < 3) return null

  const inner: Vector3[] = []
  const outer: Vector3[] = []
  for (const p of ring) {
    inner.push(p.position.clone().addScaledVector(p.normal, -tIn))
    outer.push(p.position.clone().addScaledVector(p.normal, tOut))
  }

  const verts: number[] = []
  const push = (v: Vector3) => {
    verts.push(v.x, v.y, v.z)
  }
  const tri = (a: Vector3, b: Vector3, c: Vector3) => {
    push(a)
    push(b)
    push(c)
  }

  // Side walls. Winding chosen so the face normal points away from the axis.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    tri(inner[i], inner[j], outer[j])
    tri(inner[i], outer[j], outer[i])
  }

  // Outer cap, facing along the surface normal.
  for (let i = 1; i < n - 1; i++) {
    tri(outer[0], outer[i], outer[i + 1])
  }
  // Inner cap, reversed so it faces the other way.
  for (let i = 1; i < n - 1; i++) {
    tri(inner[0], inner[i + 1], inner[i])
  }

  for (const value of verts) {
    if (!Number.isFinite(value)) return null
  }

  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
  // Non-indexed, so this yields flat normals -- correct for a prism's hard edges.
  geom.computeVertexNormals()
  return geom
}

/**
 * The sketch's footprint as a thin surface patch, lifted `offset` clear of the
 * solid so it reads as a projection rather than z-fighting with the face it
 * sits on. Same fan triangulation as the prism caps, same convexity assumption.
 */
export function buildCapGeometry(
  ring: ProjectedPoint[],
  offset: number
): BufferGeometry | null {
  const n = ring.length
  if (n < 3) return null

  const pts = ring.map((p) => p.position.clone().addScaledVector(p.normal, offset))
  const verts: number[] = []
  for (let i = 1; i < n - 1; i++) {
    for (const v of [pts[0], pts[i], pts[i + 1]]) verts.push(v.x, v.y, v.z)
  }

  for (const value of verts) {
    if (!Number.isFinite(value)) return null
  }

  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
  geom.computeVertexNormals()
  return geom
}

/** Closed polyline of the sketch outline, lifted clear of the surface. */
export function outlinePolyline(ring: ProjectedPoint[], offset: number): Vector3[] {
  if (ring.length === 0) return []
  const pts = ring.map((p) => p.position.clone().addScaledVector(p.normal, offset))
  return [...pts, pts[0].clone()]
}
