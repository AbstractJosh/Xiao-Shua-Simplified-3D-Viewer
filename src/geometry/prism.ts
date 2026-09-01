import { BufferAttribute, BufferGeometry, Euler, Vector3 } from 'three'
import type { ProjectedPoint, Sweep, SurfaceDef } from './surfaces'
import { anchorIsCurved, tangentBasis } from './surfaces'
import { MAX_SIZE } from './dimensions'
import { sampleOutline } from './outline'
import { sweepOp } from './types'
import type { Feature, SurfaceAnchor } from './types'

/**
 * Lift a feature's 2D outline onto its host surface, giving a closed ring of
 * (point, outward normal) pairs.
 *
 * This is the FOOTPRINT: where the tool meets the host. On a flat face it is
 * the outline unchanged; on a curved one it is that outline wrapped onto the
 * surface, which is exactly what the viewport draws the sketch as -- so the
 * ring the user sees lying on the solid is the ring the solid is built from.
 *
 * The normals ride along for the decal's lift and for nothing else. Which way
 * the tool TRAVELS is one direction for the whole ring, and it comes from
 * `SweepAxis` rather than from here.
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
 * The single direction a feature's tool sweeps along, and the two planes it
 * runs between.
 *
 * ONE direction for the whole ring, and that is the point of the type. Sweeping
 * each ring point along its OWN surface normal let curvature spread the tool as
 * it travelled: a square drawn on a barrel came out half as wide again at the
 * top as at its base, and its cap arrived bent into a patch of the offset
 * shell. The feature followed the surface instead of the sketch. Along one axis
 * the walls stay parallel and the caps stay flat, so a curved host now differs
 * from a flat one in one thing only -- where the footprint sits.
 *
 * Both distances are measured from `origin`, the anchor's own point on the
 * surface, so `depth` still means "this far proud of the spot it was drawn on"
 * however far the rest of the ring has curved away from it.
 */
export type SweepAxis = {
  /** The anchor's point on the surface. Both end planes are measured from it. */
  origin: Vector3
  /** The anchor's surface normal: unit, and shared by every ring point. */
  dir: Vector3
  /** Where the inner end plane sits, as a distance BEHIND `origin`. */
  tIn: number
  /** Where the outer end plane sits, as a distance IN FRONT of `origin`. */
  tOut: number
  /** The end this operation creates. The other one stays buried in the host. */
  created: 'out' | 'in'
}

/**
 * The sweep axis for a feature on a surface: the frame's normal, and the two
 * distances the surface itself asked for.
 *
 * Built here rather than in the evaluator so the solid and the drag handle
 * cannot drift apart -- `endFaceRing` runs the same solve on the same axis.
 */
export function sweepAxisFor(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  depth: number,
  sweep: Sweep
): SweepAxis {
  const f = surface.frame(anchor)
  return {
    origin: f.origin,
    dir: f.normal,
    tIn: sweep.tIn,
    tOut: sweep.tOut,
    // The end that moves is the one the operation creates; the base of the
    // extrusion stays welded to the surface either way.
    created: sweepOp(depth) === 'extrude' ? 'out' : 'in',
  }
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
 * A tilt that lays the end plane down until it is nearly edge-on to the sweep
 * makes the plane solve explode, so the tool refuses outright rather than
 * handing the CSG a ring that has run off towards infinity.
 */
const MIN_END_COS = 0.15
/**
 * The prism's own height, measured between its two ends along the sweep axis.
 * At or below zero the caps have crossed and the walls fold through each other,
 * which reaches the CSG as a silently corrupt result rather than as an error.
 */
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
 * Null is not a failure: it means the created end already lands where the sweep
 * axis puts it -- square to the axis, `depth` from the anchor -- which the plain
 * path produces without a solve.
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

  return {
    origin: basis.origin,
    normal: basis.normal,
    end: sweepOp(feature.depth) === 'extrude' ? 'out' : 'in',
    slide,
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
 * The point a feature's gizmo stands on: the centre of the face it created, or
 * the sketch on the surface while it has created none.
 *
 * The TIP, in other words, rather than the footprint. A gizmo at the base of a
 * boss annotates the one part of it the gestures do not change -- the base
 * stays welded to the host through every one of them -- and on a pocket it sits
 * on the surface while the face it describes is buried underneath. At the tip it
 * stands on the very face the depth arrow is pushing.
 *
 * Both the gizmo and the drag that answers it come through here, because the
 * two must agree to the millimetre: every gesture is measured from the gizmo's
 * origin -- the ring reads the pointer's angle about it, the arrows their travel
 * from it -- so a drag reading one centre while the handles were drawn about
 * another would run at a different rate than the hand was moving.
 */
export function featureHandleOrigin(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: EndPlaneSpec
): Vector3 {
  return endFaceFrame(surface, anchor, feature)?.origin ?? surface.frame(anchor).origin
}

/** Signed height of a point above the plane through the axis origin. */
function heightOn(axis: SweepAxis, p: Vector3): number {
  return p.clone().sub(axis.origin).dot(axis.dir)
}

/**
 * Slide each ring point along the SWEEP AXIS until it meets the end plane.
 *
 * Along the axis rather than along each point's own normal, which is what stops
 * a tilted face on a curved host from splaying: every point travels the same
 * direction, so the plane leans the cap without also stretching it.
 *
 * One denominator for the whole ring, for the same reason -- the tilt either
 * lays the plane too far over for the sweep to reach it, or it does not.
 */
function endPlanePoints(
  ring: ProjectedPoint[],
  axis: SweepAxis,
  plane: EndPlane
): Vector3[] | null {
  const denom = axis.dir.dot(plane.normal)
  if (!(denom > MIN_END_COS)) return null
  return ring.map((p) => {
    const s = plane.origin.clone().sub(p.position).dot(plane.normal) / denom
    return p.position.clone().addScaledVector(axis.dir, s).add(plane.slide)
  })
}

/**
 * The two end rings of a feature's tool: where the sweep starts and where it
 * finishes, every point carried along the one axis.
 *
 * The solid and the drag handle both come through here, so the face the handle
 * offers to drag is the face the solid actually has -- including the refusal,
 * because a handle on a tool that was rejected invites a drag on nothing.
 */
function sweptEnds(
  ring: ProjectedPoint[],
  axis: SweepAxis,
  endPlane?: EndPlane | null
): { inner: Vector3[]; outer: Vector3[] } | null {
  const heights = ring.map((p) => heightOn(axis, p.position))

  // How far the footprint dips behind the anchor's own tangent plane. Zero on a
  // flat face; on a curved one it is what the buried end has to clear before
  // any of it is inside the host at all -- and it grows with the sketch, so it
  // cannot be a number the surface hands over in advance of one.
  const sag = Math.max(0, -Math.min(...heights))
  // Only the BURIED end is pushed out by the sag. The created end is the number
  // the user typed, and moving it would make the depth slider lie on every
  // curved host.
  const inDist = axis.tIn + (axis.created === 'out' ? sag : 0)

  // Both ends are PLANES square to the axis: a point that starts lower on the
  // surface travels further, instead of carrying the dip along with it. That is
  // the whole difference between a boss with a flat top and one moulded to the
  // barrel it stands on.
  const inner = ring.map((p, i) =>
    p.position.clone().addScaledVector(axis.dir, -inDist - heights[i])
  )
  const outer = ring.map((p, i) =>
    p.position.clone().addScaledVector(axis.dir, axis.tOut - heights[i])
  )

  if (endPlane) {
    const moved = endPlanePoints(ring, axis, endPlane)
    if (!moved) return null
    const target = endPlane.end === 'out' ? outer : inner
    for (let i = 0; i < moved.length; i++) target[i] = moved[i]
  }

  // Every wall has to run the same way round the ring. A tilt steep enough to
  // drive one side of the created end back through the buried one folds the
  // tool inside out, and the feature is refused rather than built wrong.
  for (let i = 0; i < ring.length; i++) {
    const height = outer[i].clone().sub(inner[i]).dot(axis.dir)
    if (!(height > MIN_END_T && height < MAX_END_T)) return null
  }
  return { inner, outer }
}

/**
 * Sweep a ring of footprint points into a closed solid, running from the inner
 * end plane to the outer one along the axis.
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
  axis: SweepAxis,
  endPlane?: EndPlane | null
): BufferGeometry | null {
  const n = ring.length
  if (n < 3) return null

  // A rejected feature is flagged as failed in the UI; a prism whose walls
  // cross each other corrupts the boolean with no warning at all.
  const ends = sweptEnds(ring, axis, endPlane)
  if (!ends) return null
  const { inner, outer } = ends

  // Rings in sweep order, buried end first. Walls are built band by band so a
  // slide can put a third ring between these two.
  const rings: Vector3[][] = [inner, outer]

  // Kink the wall at the host surface: straight from the buried end up to the
  // UN-SLID outline, leaning only from there on. Running a single band from the
  // buried ring to the slid one shears the pillar about a pivot below the
  // surface rather than about its own footprint, which leaves the section where
  // the solid meets the host displaced by the buried fraction of the slide -- a
  // seventh of it at the default margin. The base would creep sideways with the
  // face being dragged, when the whole point of the gesture is that it stays put.
  //
  // Only where the footprint really does lie between the two ends. It normally
  // does, but a pocket shallower than the dip of its own footprint has a floor
  // that surfaces through the ring, and threading a band through a ring on the
  // wrong side of it would fold the wall over.
  if (endPlane && endPlane.slide.lengthSq() > 0) {
    const between = ring.every((p, i) => {
      const h = heightOn(axis, p.position)
      return h > heightOn(axis, inner[i]) && h < heightOn(axis, outer[i])
    })
    if (between) rings.splice(1, 0, ring.map((p) => p.position.clone()))
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
 * points, so they come from the same solve the solid uses -- the same axis, the
 * same end planes, and the same refusal.
 */
export function endFaceRing(
  surface: SurfaceDef,
  anchor: SurfaceAnchor,
  feature: EndPlaneSpec & Pick<Feature, 'shape' | 'rotation'>
): Vector3[] {
  const ring = outlineOnSurface(surface, anchor, feature)
  if (ring.length < 3) return []

  const op = sweepOp(feature.depth)
  const axis = sweepAxisFor(
    surface,
    anchor,
    feature.depth,
    surface.sweep(anchor, Math.abs(feature.depth), op)
  )
  const ends = sweptEnds(ring, axis, endPlaneFor(surface, anchor, feature))
  if (!ends) return []
  return axis.created === 'out' ? ends.outer : ends.inner
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
