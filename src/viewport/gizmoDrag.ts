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
  /** Signed total swept since the grab, unwrapped, in radians. */
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

/** A frame's three axes as world directions, in X, Y, Z order. */
function frameAxes(rotation: Vec3): [Vector3, Vector3, Vector3] {
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

/**
 * Which of the target's OWN axes lies nearest a world direction.
 *
 * The bridge between a gizmo drawn in the world frame and a solid whose
 * dimensions are its own. `size[0]` is a box's width measured along its local
 * X, whatever the box has since been turned to; there is no way to write down
 * "wider along world X" for a box standing at an angle. So the world arrow the
 * user grabbed is matched to the local axis it most nearly runs along, and that
 * is the dimension the drag resizes -- which keeps the gesture honest, because
 * the side that grows is still the side being pulled.
 *
 * Exact at every multiple of 90 degrees, which is where objects in this app
 * mostly sit, and the closest available answer in between. Unsigned: a solid is
 * centred on its own origin and a dimension grows both ways at once, so it
 * makes no difference whether the local axis points with the arrow or against
 * it -- pulling outward widens either way.
 */
export function nearestLocalAxis(rotation: Vec3, worldDir: Vector3): 0 | 1 | 2 {
  const axes = frameAxes(rotation)
  let best: 0 | 1 | 2 = 0
  let bestDot = -1

  for (const index of [0, 1, 2] as const) {
    const dot = Math.abs(axes[index].dot(worldDir))
    if (dot > bestDot) {
      bestDot = dot
      best = index
    }
  }
  return best
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
