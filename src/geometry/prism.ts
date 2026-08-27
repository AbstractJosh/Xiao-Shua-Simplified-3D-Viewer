import { BufferAttribute, BufferGeometry, Euler, Vector3 } from 'three'
import type { ProjectedPoint, SurfaceDef } from './surfaces'
import { anchorIsCurved, tangentBasis } from './surfaces'
import { MAX_SIZE } from './dimensions'
import { sampleOutline } from './outline'
import { sweepOp } from './types'
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
 * The plane the CREATED end of a feature lands on, in object-local space.
 * `end` says which end of the sweep the plane owns: an extrude moves the outer
 * end, an intrude moves the inner one -- the other end always stays buried in
 * the host so the boolean has material to bite into.
 */
export type EndPlane = {
  origin: Vector3
  normal: Vector3
  end: 'out' | 'in'
  /**
   * The lateral slide, as a vector lying IN the plane, applied to every point
   * after it has landed there.
   *
   * It has to travel separately from `origin`: a plane translated within itself
   * is the same plane, so folding the slide into the origin would leave the
   * solve returning exactly the unslid points and `faceOffset` would be inert.
   */
  slide: Vector3
  /**
   * Signed distance along each point's OWN normal at which the created end
   * lands, or null when it has to be solved onto the plane.
   *
   * An untilted end plane is parallel to the surface, but on a curved host the
   * two are not the same answer: the unslid sweep leaves the created face
   * following the curvature, while a flat plane cuts across it and pushes the
   * rim outward. Solving there would make the face pop the instant a drag put
   * the slightest slide on it. Travelling a constant distance is exactly what
   * the unslid path does, so the drag now starts from where the face already
   * is. A tilted face has no such path to match and keeps the plane solve.
   */
  alongNormal: number | null
}

/**
 * The created face's plane together with the two axes `faceOffset` is measured
 * along. `origin` is the face centre as it currently stands, slide included.
 */
export type EndFaceFrame = {
  origin: Vector3
  normal: Vector3
  inU: Vector3
  inV: Vector3
}

/** What `endPlaneFor` needs; a whole Feature satisfies it. */
type EndPlaneSpec = Pick<Feature, 'depth' | 'tilt' | 'faceOffset'>

/**
 * A ring normal grazing the end plane makes the ray/plane solve explode, and a
 * ring whose points land on wildly different sides of it produces walls that
 * cross. Both show up as a silently corrupt CSG result rather than an error, so
 * the sweep refuses outright once any point leaves this envelope.
 */
const MIN_END_COS = 0.15
const MIN_END_T = 1e-4
/** Eight times `MAX_SIZE`, which is what it has always been -- a sweep may run
 *  well past the solid it starts from, but not to infinity. DERIVED, because
 *  as a literal it was a silent ceiling: raise the envelope and deep features
 *  on large solids start refusing to build for no reason the user can see. */
const MAX_END_T = MAX_SIZE * 8

/** Below this squared length a projected axis carries no usable direction. */
const MIN_AXIS_LEN_SQ = 1e-8

/**
 * In-plane axes for the face offset, obtained by projecting the tangent frame
 * onto the tilted plane so a slider keeps meaning roughly what it meant before
 * the tilt. When a tilt swings uDir or vDir onto the plane normal that
 * projection collapses, and no amount of re-normalising recovers a direction --
 * so the whole pair falls back to a synthetic basis, which at least stays
 * orthonormal instead of leaving one axis correlated with the other.
 *
 * Projecting alone does not keep the pair orthogonal: a tilt about a single
 * axis leaves the right angle intact, but one about two axes shears it, and the
 * viewport turns a ray hit into a faceOffset with a dot product per axis --
 * which measures what it means to measure only on an orthonormal pair. With an
 * oblique one each axis reads back part of the other, and the dragged face
 * trails the pointer and rubber-bands. Hence the Gram-Schmidt step.
 */
function inPlaneAxes(
  uDir: Vector3,
  vDir: Vector3,
  normal: Vector3
): { inU: Vector3; inV: Vector3 } {
  const synthetic = () => {
    const fallback = tangentBasis(normal)
    return { inU: fallback.uDir, inV: fallback.vDir }
  }

  const inU = uDir.clone().addScaledVector(normal, -uDir.dot(normal))
  const inV = vDir.clone().addScaledVector(normal, -vDir.dot(normal))
  if (inU.lengthSq() < MIN_AXIS_LEN_SQ || inV.lengthSq() < MIN_AXIS_LEN_SQ) {
    return synthetic()
  }

  inU.normalize()
  // Valid only because inU is already unit; subtracting before normalising it
  // would take off the wrong amount and leave the pair oblique after all.
  inV.addScaledVector(inU, -inU.dot(inV))
  // vDir projecting onto inU itself leaves nothing behind, which is the same
  // unrecoverable case as a projection that collapsed outright.
  if (inV.lengthSq() < MIN_AXIS_LEN_SQ) return synthetic()
  return { inU, inV: inV.normalize() }
}

/**
 * The tilted plane and its in-plane axes, before any lateral slide.
 *
 * The solid's end plane and the viewport's drag handle both come from here, and
 * they have to: the handle turns a pointer position into a `faceOffset` by
 * projecting onto inU and inV, so an axis derived even slightly differently on
 * the two sides would make the face creep away from the pointer as it is
 * dragged. `origin` is the unslid face centre.
 */
function endFaceBasis(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: EndPlaneSpec
): EndFaceFrame | null {
  const [tx, ty, tz] = feature.tilt
  const f = surface.frame(anchor)
  const normal = f.normal.clone().applyEuler(new Euler(tx, ty, tz, 'XYZ')).normalize()
  if (normal.lengthSq() < 0.5) return null

  const origin = f.origin.clone().addScaledVector(f.normal, feature.depth)
  return { origin, normal, ...inPlaneAxes(f.uDir, f.vDir, normal) }
}

/**
 * Where a feature's created end face sits once tilt and lateral slide are
 * applied, or null when neither is in play.
 *
 * Null is not a failure: it means the plain constant-offset sweep applies. That
 * path is cheaper and already verified against every surface kind, so an
 * untilted feature must never be routed through the ray/plane solve below.
 */
export function endPlaneFor(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: EndPlaneSpec
): EndPlane | null {
  const [tx, ty, tz] = feature.tilt
  const [offU, offV] = feature.faceOffset
  if (tx === 0 && ty === 0 && tz === 0 && offU === 0 && offV === 0) return null

  const basis = endFaceBasis(surface, anchor, feature)
  if (!basis) return null

  // A zero slide is skipped rather than added as a zero-scaled vector, so a
  // tilt-only feature reaches the CSG through arithmetic identical to the one
  // this path was verified against.
  const slide = new Vector3()
  if (offU !== 0 || offV !== 0) {
    slide.addScaledVector(basis.inU, offU).addScaledVector(basis.inV, offV)
    basis.origin.add(slide)
  }

  // The end that moves is the one the operation creates; the base of the
  // extrusion stays welded to the surface either way.
  const end = sweepOp(feature.depth) === 'extrude' ? 'out' : 'in'
  // Untilted, the plane is parallel to the surface and the constant-depth
  // landing is the one the unslid sweep would have produced (see EndPlane).
  const untilted = tx === 0 && ty === 0 && tz === 0
  return {
    origin: basis.origin,
    normal: basis.normal,
    end,
    slide,
    alongNormal: untilted ? feature.depth : null,
  }
}

/**
 * The end face's plane and the axes a lateral slide runs along, or null when
 * the feature creates no face at all.
 *
 * Unlike `endPlaneFor` this answers for an untilted, unslid feature too. That
 * function returns null there on purpose, to keep the plain sweep on its
 * cheaper path -- but the drag handle still has to know where the face is and
 * which way a drag moves it, and starting a drag is exactly the moment tilt and
 * offset are still zero.
 */
export function endFaceFrame(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: EndPlaneSpec
): EndFaceFrame | null {
  // Depth 0 means the sketch is still a pure projection: there is no created
  // face to grab, and the plane would land back on the host surface. EXACTLY
  // zero: depth is signed, and a pocket's floor is as much a created face as a
  // boss's top -- it is simply on the other side of the surface.
  if (feature.depth === 0) return null

  const basis = endFaceBasis(surface, anchor, feature)
  if (!basis) return null

  const [offU, offV] = feature.faceOffset
  basis.origin.addScaledVector(basis.inU, offU).addScaledVector(basis.inV, offV)
  return basis
}

/**
 * Slide each ring point along its own normal until it meets the end plane.
 *
 * Shared by the solid and by the draggable face handle: if the handle computed
 * its polygon independently it would drift off the face the moment either side
 * changed a guard or a sign. Returns null when any point fails the envelope,
 * because a partially valid ring is exactly the corrupt-boolean case.
 */
function endPlanePoints(ring: ProjectedPoint[], plane: EndPlane): Vector3[] | null {
  const points: Vector3[] = []
  for (const p of ring) {
    const denom = p.normal.dot(plane.normal)
    // Checked on both branches: the envelope is what keeps the walls from
    // crossing, and the handle and the solid must agree on who is rejected.
    if (!(denom > MIN_END_COS)) return null
    // Distance along the point's own normal to the plane. Signed so that `t`
    // counts forward in the direction this end travels, whichever end it is.
    const s =
      plane.alongNormal ?? plane.origin.clone().sub(p.position).dot(plane.normal) / denom
    const t = plane.end === 'out' ? s : -s
    if (!(t > MIN_END_T && t < MAX_END_T)) return null
    // The slide is a rigid translation of the whole landed ring, so the cap
    // keeps its shape and only the walls lean. That is exactly the gesture --
    // the base stays welded to the host and the pillar follows the face.
    points.push(p.position.clone().addScaledVector(p.normal, s).add(plane.slide))
  }
  return points
}

/**
 * Sweep a ring of (point, normal) pairs into a closed solid, from `tIn` behind
 * each point to `tOut` in front of it, each along its own normal.
 *
 * The result is watertight by construction, which is what three-bvh-csg
 * requires. Caps are triangle fans, valid because every v1 outline is convex --
 * and still valid under `endPlane`, which translates and leans the created cap
 * but never reorders its outline.
 *
 * A slide adds a third ring at the host surface, so the wall runs straight up
 * to the surface and only leans beyond it. Both bands share that ring vertex
 * for vertex, so the solid stays watertight.
 */
export function buildSweptPrism(
  ring: ProjectedPoint[],
  tIn: number,
  tOut: number,
  endPlane?: EndPlane | null
): BufferGeometry | null {
  const n = ring.length
  if (n < 3) return null

  const inner: Vector3[] = []
  const outer: Vector3[] = []
  for (const p of ring) {
    inner.push(p.position.clone().addScaledVector(p.normal, -tIn))
    outer.push(p.position.clone().addScaledVector(p.normal, tOut))
  }

  // Rings in sweep order, buried end first. Walls are built band by band so a
  // slide can put a third ring between these two.
  const rings: Vector3[][] = [inner, outer]

  if (endPlane) {
    const moved = endPlanePoints(ring, endPlane)
    // A rejected feature is flagged as failed in the UI; a prism whose walls
    // cross each other corrupts the boolean with no warning at all.
    if (!moved) return null
    const target = endPlane.end === 'out' ? outer : inner
    for (let i = 0; i < n; i++) target[i] = moved[i]

    // Kink the wall at the host surface: straight from the buried end up to the
    // UN-SLID outline, leaning only from there on. Running a single band from
    // the buried ring to the slid one shears the pillar about a pivot below the
    // surface rather than about its own footprint, which leaves the section
    // where the solid meets the host displaced by the buried fraction of the
    // slide -- a seventh of it at the default margin. The base would creep
    // sideways with the face being dragged, when the whole point of the gesture
    // is that it stays put.
    //
    // The outline is where the sweep starts, so this ring always sits between
    // the buried end (tIn behind it) and the created one (MIN_END_T ahead at
    // the very least), and both bands share it vertex for vertex.
    if (endPlane.slide.lengthSq() > 0) {
      rings.splice(1, 0, ring.map((p) => p.position.clone()))
    }
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

  // Side walls, a quad strip per band. Winding chosen so the face normal points
  // away from the axis; it depends only on the rings' order along the sweep,
  // which `rings` preserves however many of them there are.
  for (let b = 0; b + 1 < rings.length; b++) {
    const lo = rings[b]
    const hi = rings[b + 1]
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      tri(lo[i], lo[j], hi[j])
      tri(lo[i], hi[j], hi[i])
    }
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
 * The polygon of the face this feature creates, in object-local space, or empty
 * when the feature cannot be built. The viewport draws its drag handle on these
 * points, so they come from the same solve the solid uses.
 *
 * The untilted case deliberately reads `depth` rather than the surface's `tOut`:
 * on a curved host the sweep overshoots on purpose and the evaluator trims it
 * back against the offset shell, so `depth` -- not the overshoot -- is where the
 * face the user sees actually lands.
 */
export function endFaceRing(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: EndPlaneSpec & Pick<Feature, 'shape' | 'rotation'>
): Vector3[] {
  const ring = outlineOnSurface(surface, anchor, feature)
  if (ring.length < 3) return []

  const plane = endPlaneFor(surface, anchor, feature)
  if (plane) return endPlanePoints(ring, plane) ?? []

  return ring.map((p) => p.position.clone().addScaledVector(p.normal, feature.depth))
}

/**
 * Centroid of a face ring, for anchoring the handle gizmo. The vertex mean, not
 * the area centroid: the outline sampler spaces points evenly, and the mean
 * cannot wander outside a convex polygon the way a bounding-box centre can.
 */
export function endFaceCentre(ring: Vector3[]): Vector3 {
  const centre = new Vector3()
  if (ring.length === 0) return centre
  for (const p of ring) centre.add(p)
  return centre.divideScalar(ring.length)
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
