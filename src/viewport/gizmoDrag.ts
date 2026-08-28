import { Euler, Quaternion, Vector3 } from 'three'
import type { Ray } from 'three'
import type { Vec3 } from '../geometry/types'

/**
 * The arithmetic behind an arrow drag, kept out of the frame loop so it can be
 * checked without a camera.
 *
 * The whole module exists to enforce one invariant: an arrow drag has exactly
 * ONE origin, pinned where the gesture started, and it is both the origin of the
 * axis line the pointer is measured against AND the position the travel is
 * added to.
 *
 * Keeping two -- reading the parameter against the target's live centre while
 * adding the travel to where it started -- is a feedback loop, and a vicious
 * one, because it looks correct for exactly one frame:
 *
 *   frame 1  centre = P0, parameter t0            -> travel 0, stays at P0
 *   frame 2  centre = P0, parameter t1            -> travel t1-t0, moves to P1
 *   frame 3  centre = P1, so the SAME pointer now
 *            reads t1 - (t1-t0) = t0              -> travel 0, snaps back to P0
 *   frame 4  centre = P0 again                    -> back to P1 ...
 *
 * The origin chases the object it is moving, so a perfectly still pointer makes
 * the solid flip between two positions every other frame. While the pointer is
 * moving it merely feels loose; hold still and it visibly shakes.
 */

/** Pinned at the gesture's start. One value, so nothing can drift from it. */
export type AxisGrab = {
  /** Where the target sat when the arrow was grabbed, in world space. */
  origin: Vector3
  /** The pointer's parameter along the axis at that moment. */
  t: number
}

/**
 * Where the pointer sits along an axis line, as a signed distance from
 * `origin`.
 *
 * Closest approach between the pointer ray and the line, which is the only
 * reading that stays meaningful when the two are skew -- and they always are,
 * since the axis is fixed in the scene and the ray is wherever the user happens
 * to be looking from. Null when the ray runs along the axis, where every point
 * on the line is equally close and the answer is noise.
 *
 * `dir` must be a unit vector.
 */
export function axisParam(ray: Ray, origin: Vector3, dir: Vector3): number | null {
  const rd = ray.direction
  const w0 = ray.origin.clone().sub(origin)
  const b = rd.dot(dir)
  const denom = 1 - b * b
  if (Math.abs(denom) < 1e-6) return null
  return (dir.dot(w0) - b * rd.dot(w0)) / denom
}

/** Begin a drag, or null where the axis cannot be read from here. */
export function beginAxisDrag(ray: Ray, position: Vec3, dir: Vector3): AxisGrab | null {
  const origin = new Vector3(position[0], position[1], position[2])
  const t = axisParam(ray, origin, dir)
  return t === null ? null : { origin, t }
}

/**
 * How far along the axis the pointer has travelled since the grab.
 *
 * Measured against the grab's own origin, never against where the target has
 * since moved to -- which is the invariant this module exists for.
 */
export function axisTravel(grab: AxisGrab, ray: Ray, dir: Vector3): number | null {
  const t = axisParam(ray, grab.origin, dir)
  return t === null ? null : t - grab.t
}

/** Where the target should sit, given that travel. */
export function axisTarget(grab: AxisGrab, dir: Vector3, travel: number): Vec3 {
  return [
    grab.origin.x + dir.x * travel,
    grab.origin.y + dir.y * travel,
    grab.origin.z + dir.z * travel,
  ]
}

// --- Sliding in a plane ------------------------------------------------------

/**
 * The plane version of `AxisGrab`, pinned at the gesture's start for exactly
 * the same reason and against exactly the same failure.
 *
 * TWO points, both frozen: where the target sat when the quad was grabbed, and
 * where the pointer met the plane at that moment. The travel is the difference
 * between the pointer's current meeting point and `at`, which is why `origin`
 * has to stay put -- it is the plane's own anchor, and a plane that chased the
 * thing it was moving would drift under the gesture the way the axis line
 * would. See the walkthrough at the top of this module; the arithmetic differs
 * but the loop is identical.
 */
export type PlaneGrab = {
  /** Where the target sat when the quad was grabbed, in world space. */
  origin: Vector3
  /** Where the pointer met the plane at that moment. */
  at: Vector3
}

/**
 * Begin a plane drag from the point the pointer met the plane.
 *
 * The meeting point is passed in rather than solved here, because finding it
 * needs a camera-shaped thing and this module deliberately has none -- the same
 * division `readTurn` already keeps, where the viewport meets the plane and the
 * arithmetic lives here.
 */
export function beginPlaneDrag(hit: Vector3, position: Vec3): PlaneGrab {
  return {
    origin: new Vector3(position[0], position[1], position[2]),
    at: hit.clone(),
  }
}

/**
 * How far the pointer has travelled across the plane since the grab.
 *
 * A vector rather than a scalar -- a plane has two directions to go in -- but
 * measured against the grab's own meeting point, never against where the target
 * has since moved to, which is the invariant this module exists for.
 */
export function planeTravel(grab: PlaneGrab, hit: Vector3): Vector3 {
  return hit.clone().sub(grab.at)
}

/** Where the target should sit, given that travel. */
export function planeTarget(grab: PlaneGrab, travel: Vector3): Vec3 {
  return [
    grab.origin.x + travel.x,
    grab.origin.y + travel.y,
    grab.origin.z + travel.z,
  ]
}

// --- Turning ----------------------------------------------------------------

/**
 * A turn is measured as a pointer ANGLE in the camera's own plane, and the
 * running total is accumulated rather than recomputed.
 *
 * That is the one place this module allows accumulation, and it is safe for the
 * reason the axis drags are not: what accumulates is the POINTER's angle, which
 * has nothing to do with where the target has since ended up. The target's
 * rotation is still derived from the grab every frame -- `turnedRotation` takes
 * the rotation the gesture started from -- so there is no path from the result
 * back into the measurement. Accumulation is needed at all only because an
 * angle wraps at +/-pi, and a user turning something a full circle and a half
 * must not have it snap back at 180 degrees.
 */
export type TurnGrab = {
  /** World-space axis the turn runs about. Unit. */
  axis: Vector3
  /** Euler XYZ the target carried when the ring was grabbed. */
  rotation: Vec3
  /** World position the target's ORIGIN sat at then, for a turn about a pivot
   *  that is not that origin. */
  position: Vec3
  /** Last frame's raw pointer angle, for unwrapping. */
  lastAngle: number
  /** Signed total swept since the grab, unwrapped, in radians. Raw: the
   *  detents `snapTurn` applies are never folded back in here. */
  total: number
}

/**
 * The frame that is no rotation at all: the world's own axes.
 *
 * Passed where a function wants a frame and the caller means X, Y and Z as the
 * scene has them, so the intent reads at the call site instead of an unexplained
 * triple of zeros.
 */
export const WORLD_FRAME: Vec3 = [0, 0, 0]

/**
 * A frame's three axes as world directions, in X, Y, Z order.
 *
 * Exported because it is what "the object's own axes" MEANS, and the Scale
 * gizmo now draws its arrows along them and measures its drags along them --
 * see `local` on `GizmoParts`. Stating that rule anywhere costs a camera and
 * three React trees; stating this one costs a rotation.
 */
export function frameAxes(rotation: Vec3): [Vector3, Vector3, Vector3] {
  const euler = new Euler(rotation[0], rotation[1], rotation[2], 'XYZ')
  return [0, 1, 2].map((i) =>
    new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
      .applyEuler(euler)
      .normalize()
  ) as [Vector3, Vector3, Vector3]
}

/**
 * The axis of `rotation`'s frame that best faces the viewer, signed to point AT
 * them.
 *
 * The ring is drawn in the camera's plane, so a turn dragged around it reads as
 * a twist of the screen. The axis nearest the view direction is the one that
 * actually produces that twist -- any other would send the target tumbling in a
 * direction the gesture never suggested. Snapping to one of the three, rather
 * than turning about the view direction itself, is what keeps a rotation
 * expressible as a rotation about a named axis.
 *
 * WHOSE three axes is the caller's to say. Pass `WORLD_FRAME` and the turn
 * snaps to world X, Y or Z -- equivalently, it runs in whichever of the three
 * world planes most faces the camera, since a plane's normal is the axis it
 * leaves out. Pass the target's own rotation and it snaps to the target's axes
 * instead. The object gizmo wants the first: its arrows stand in the world, and
 * a ring turn that ran about the object's drifting axes would not match them.
 */
export function nearestViewAxis(
  rotation: Vec3,
  viewDir: Vector3
): { axis: Vector3; index: 0 | 1 | 2 } {
  const axes = frameAxes(rotation)
  let best = axes[0]
  let bestIndex: 0 | 1 | 2 = 0
  let bestDot = -1

  for (const index of [0, 1, 2] as const) {
    const dot = Math.abs(axes[index].dot(viewDir))
    if (dot > bestDot) {
      bestDot = dot
      best = axes[index]
      bestIndex = index
    }
  }

  // Toward the viewer, so a clockwise drag turns the target clockwise on screen
  // whichever way the axis happened to be pointing.
  if (best.dot(viewDir) > 0) best.negate()
  return { axis: best, index: bestIndex }
}

/** The pointer's angle about `centre`, read in the plane spanned by right/up. */
export function pointerAngle(
  point: Vector3,
  centre: Vector3,
  right: Vector3,
  up: Vector3
): number {
  const rel = point.clone().sub(centre)
  return Math.atan2(rel.dot(up), rel.dot(right))
}

/** Shortest signed way round from `from` to `to`, in (-pi, pi]. */
function wrap(delta: number): number {
  let d = delta
  while (d > Math.PI) d -= 2 * Math.PI
  while (d <= -Math.PI) d += 2 * Math.PI
  return d
}

/**
 * Fold this frame's angle into the running total and return it.
 *
 * Unwrapped, so a turn carries on past half a circle instead of jumping to the
 * other sign -- which is the whole reason the total is kept rather than being
 * read fresh from the pointer each frame.
 */
export function advanceTurn(grab: TurnGrab, angle: number): number {
  grab.total += wrap(angle - grab.lastAngle)
  grab.lastAngle = angle
  return grab.total
}

/** The detents a turn lands on: every 45 degrees, the whole way round. Eight
 *  of them, which are the angles a thing built out of boxes wants to sit at. */
export const TURN_SNAP = Math.PI / 4

/** How near one has to come to be taken by it -- 3 degrees either side, so
 *  everything from 42 to 48 reads as 45, and the same at every other detent. */
export const TURN_SNAP_WINDOW = (3 * Math.PI) / 180

/**
 * Pull a sweep onto the nearest detent, if it is close enough to one.
 *
 * A magnet rather than a ratchet: between the detents the turn stays
 * continuous, so 20 degrees still means 20 degrees. Only the last few degrees
 * of the approach are taken over, which is the part a hand cannot do -- landing
 * a free drag on exactly 90 is a matter of luck at any zoom level, and being
 * one degree out is invisible until two faces refuse to sit flush.
 *
 * Zero is a detent like any other, so the first 3 degrees of every gesture hold
 * still and a press that was meant as a click leaves the target where it was.
 *
 * It snaps the SWEEP, not the angle the target ends up at: what lands on a
 * multiple of 45 is how far THIS gesture has turned, added to whatever the
 * target already carried. An object standing askew at 10 degrees turns to 55,
 * not to 45. The ring measures a turn rather than a heading, and its readout
 * says so; a snap that quietly corrected the object's own angle as well would
 * move it by an amount the user never dragged.
 *
 * Pure, and deliberately kept out of the running total: `advanceTurn` goes on
 * accumulating the raw pointer angle, so a drag that crosses a detent and
 * carries on comes out the far side exactly where the pointer is. Were the
 * snapped value written back instead, every crossing would shift the origin of
 * the measurement and the error would pile up over a long turn.
 */
export function snapTurn(total: number): number {
  const detent = Math.round(total / TURN_SNAP) * TURN_SNAP
  return Math.abs(total - detent) <= TURN_SNAP_WINDOW ? detent : total
}

/**
 * Where the target's ORIGIN lands, given that the turn runs about `pivot`
 * rather than about the origin itself.
 *
 * A merged object's gizmo sits at the centre of the solids welded into it,
 * which is not where the host's origin is. Turning about the origin would swing
 * the whole assembly around a point off to one side of the ring being dragged;
 * turning about the ring keeps it spinning under the pointer.
 *
 * Derived from the grab's own position every frame, never from where the target
 * has since ended up -- the same rule the axis drags follow, and for the same
 * reason: feeding a rotated position back in would walk the object round the
 * pivot one turn per frame.
 *
 * For a bare solid the pivot IS the origin and this hands the position straight
 * back, so callers need not ask which case they are in.
 */
export function turnedPosition(grab: TurnGrab, total: number, pivot: Vec3): Vec3 {
  const at = new Vector3(pivot[0], pivot[1], pivot[2])
  const moved = new Vector3(grab.position[0], grab.position[1], grab.position[2])
    .sub(at)
    .applyQuaternion(new Quaternion().setFromAxisAngle(grab.axis, total))
    .add(at)
  return [moved.x, moved.y, moved.z]
}

/**
 * The Euler the target should carry, having turned `total` about `axis` from
 * the rotation it started the gesture with.
 *
 * The axis is a WORLD direction, so the turn pre-multiplies: it is applied in
 * the space the user is looking at rather than in the target's own frame. That
 * holds however the axis was chosen -- from the world's three (the object
 * gizmo) or from the target's (the cut plane) -- because `nearestViewAxis`
 * hands back a world vector either way. Euler XYZ is only how it is stored.
 */
export function turnedRotation(grab: TurnGrab, total: number): Vec3 {
  const start = new Quaternion().setFromEuler(
    new Euler(grab.rotation[0], grab.rotation[1], grab.rotation[2], 'XYZ')
  )
  const turn = new Quaternion().setFromAxisAngle(grab.axis, total)
  const euler = new Euler().setFromQuaternion(turn.multiply(start), 'XYZ')
  return [euler.x, euler.y, euler.z]
}
