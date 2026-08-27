/**
 * Cutting, expressed as retained half-spaces rather than baked geometry.
 *
 * A cut destroys nothing: each half of a severed object keeps the same base and
 * the same feature list, and differs only by one CutPlane. The two opposing
 * halves reconstruct the original exactly, and every feature on either half
 * stays live and editable afterwards -- which is the whole point of modelling
 * the cut parametrically instead of writing the boolean into a mesh.
 */

import { BoxGeometry, type BufferGeometry, Quaternion, Vector3 } from 'three'
import type { Brush } from 'three-bvh-csg'
import { INTERSECTION, csg, disposeBrush, makeBrush } from './brush'
import { signedVolume } from './volume'
import type { CutPlane, Vec3 } from './types'
import { nextCutId } from './types'

const UP = new Vector3(0, 1, 0)

/**
 * The paint on a brush nobody will ever look at.
 *
 * `planeSeparates` builds solids only to weigh them, so which solid their
 * triangles came from is a question with no consumer. One shared key keeps
 * those measurements out of the paint registry's way. The cut itself is a
 * different matter -- see `applyCuts`.
 */
const PROBE_PAINT = 'cut-probe'

/** A side thinner than this fraction of the whole is a graze, not a cut. */
const MIN_HALF_FRACTION = 1e-3

/** Below this a "solid" is numerical dust, and ratios against it are noise. */
const MIN_VOLUME = 1e-9

/**
 * The half-space an object keeps, as a box large enough to swallow it.
 *
 * `span` must comfortably cover the solid AS SEEN FROM `origin` -- use
 * `coveringSpan` -- because the CSG evaluator sees the box, not the plane: any
 * part of the solid poking out past the box would be cut away as well, turning
 * a plane cut into a silent boxing-in.
 *
 * The near face lies exactly on the plane through `origin` whose outward normal
 * is -side*normal, so the cut face IS that plane and the coincident-face
 * artefacts the evaluator is prone to stay confined to it.
 */
export function halfSpaceGeometry(
  origin: Vector3,
  normal: Vector3,
  side: 1 | -1,
  span: number
): BufferGeometry {
  const keep = new Vector3().copy(normal).multiplyScalar(side)
  // A zero-length normal would make the alignment quaternion NaN, and NaN
  // vertices poison the evaluator for every later operation, not just this one.
  if (keep.lengthSq() < MIN_VOLUME) keep.set(0, side, 0)
  keep.normalize()

  const geom = new BoxGeometry(span, span, span)
  // Built around the origin, then slid so the -Y face sits on y = 0: before
  // rotation the retained direction is +Y.
  geom.translate(0, span / 2, 0)
  geom.applyQuaternion(new Quaternion().setFromUnitVectors(UP, keep))
  geom.translate(origin.x, origin.y, origin.z)
  return geom
}

/** Extent needed to cover the solid from `origin`, whichever way the plane faces. */
function coveringSpan(geometry: BufferGeometry, origin: Vector3): number {
  geometry.computeBoundingSphere()
  const sphere = geometry.boundingSphere
  const reach = sphere ? sphere.center.distanceTo(origin) + sphere.radius : 1
  // Half the span is the box's lateral half-extent, so 4x leaves 2x of margin
  // around the solid in every direction.
  return Math.max(reach, MIN_HALF_FRACTION) * 4
}

/**
 * One intersection against a half-space, cleaning up the throwaway box brush.
 *
 * `paint` is what the CUT FACE ends up wearing. That face is the near side of
 * the box, so its triangles come from the box brush and carry the box's paint
 * -- which is why the caller has to name one rather than let a scratch key leak
 * onto a surface the user is about to look at.
 */
function intersectHalfSpace(
  solid: Brush,
  origin: Vector3,
  normal: Vector3,
  side: 1 | -1,
  span: number,
  paint: string
): Brush {
  const half = makeBrush(halfSpaceGeometry(origin, normal, side, span), paint)
  try {
    return csg(solid, half, INTERSECTION)
  } finally {
    disposeBrush(half)
  }
}

/**
 * Fold an object's cuts into its evaluated brush.
 *
 * `owned` reports whether the returned brush is a fresh allocation. The caller's
 * cache needs it: an uncut object returns the input brush untouched, and
 * disposing that would free geometry the cache still owns and the viewport is
 * still drawing. Intermediate results between cuts are ours, so we free those.
 *
 * `paint` is the object's OWN paint key, and the face the cut exposes is what
 * wears it. On a merged object that face runs across parts of several colours,
 * and one plane through an assembly is one surface -- so it takes the colour of
 * the object the cut belongs to rather than trying to be several things at
 * once. The parts either side of it keep theirs.
 */
export function applyCuts(
  brush: Brush,
  cuts: CutPlane[],
  paint: string
): { brush: Brush; owned: boolean } {
  let current = brush
  let owned = false

  try {
    for (const cut of cuts) {
      const origin = new Vector3(...cut.origin)
      // Sized per cut, from THAT cut's own origin, against the solid as it
      // stands after the previous cuts -- the same measurement planeSeparates
      // used to approve the cut. A span taken from the base solid and centred
      // on a plane parked several units away leaves the box short of the
      // object, and the intersection then eats material the plane never
      // crossed, up to erasing the object outright.
      const span = coveringSpan(current.geometry, origin)
      const next = intersectHalfSpace(
        current,
        origin,
        new Vector3(...cut.normal),
        cut.side,
        span,
        paint
      )
      if (owned) disposeBrush(current)
      current = next
      owned = true
    }
  } catch (err) {
    // The caller only learns it owns an intermediate through a normal return,
    // so a throw halfway down the fold would strand one brush per attempt --
    // once per frame while a cut plane is being dragged.
    if (owned) disposeBrush(current)
    throw err
  }

  return { brush: current, owned }
}

function halfVolume(
  solid: Brush,
  origin: Vector3,
  normal: Vector3,
  side: 1 | -1,
  span: number
): number {
  const part = intersectHalfSpace(solid, origin, normal, side, span, PROBE_PAINT)
  try {
    return Math.abs(signedVolume(part.geometry))
  } finally {
    disposeBrush(part)
  }
}

/**
 * Does this plane genuinely shear the solid all the way through?
 *
 * Answered by doing the work rather than by inspecting vertices: intersect with
 * both half-spaces and demand real volume on each side. A plane that misses,
 * or only grazes a corner into a sliver, leaves the object whole -- which is
 * what the user sees anyway, so a cheaper bounding-box test would have promised
 * a split the geometry does not deliver.
 *
 * Known limit: for a strongly non-convex solid -- a horseshoe, say -- one plane
 * can leave two closed halves that are not physically disjoint, and we report a
 * separation. Both halves are still valid solids that together reconstruct the
 * original, so the parametric result stays sound even where the physical
 * reading is arguable. We accept that.
 */
export function planeSeparates(
  geometry: BufferGeometry,
  origin: Vector3,
  normal: Vector3
): boolean {
  const total = Math.abs(signedVolume(geometry))
  if (total < MIN_VOLUME) return false

  // The caller's geometry belongs to the evaluator's cache: brushing it
  // directly would let disposal here free a buffer that is still on screen.
  const working = geometry.clone()
  const solid = makeBrush(working, PROBE_PAINT)
  const span = coveringSpan(working, origin)
  const floor = total * MIN_HALF_FRACTION

  try {
    return (
      halfVolume(solid, origin, normal, 1, span) > floor &&
      halfVolume(solid, origin, normal, -1, span) > floor
    )
  } finally {
    disposeBrush(solid)
  }
}

/**
 * The two opposing halves of one cut.
 *
 * Each gets its own id and its own copy of the plane data: sharing the tuples
 * would let an in-place edit of one half silently move the other, and a Doc is
 * plain data that is copied by shallow spread all over the store.
 */
export function splitPlanes(origin: Vec3, normal: Vec3): [CutPlane, CutPlane] {
  const o: Vec3 = [origin[0], origin[1], origin[2]]
  const n: Vec3 = [normal[0], normal[1], normal[2]]
  return [
    { id: nextCutId(), origin: o, normal: n, side: 1 },
    { id: nextCutId(), origin: [...o], normal: [...n], side: -1 },
  ]
}
