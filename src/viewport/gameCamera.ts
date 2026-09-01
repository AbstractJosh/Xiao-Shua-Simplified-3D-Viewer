import { Spherical, Vector3 } from 'three'
import type { Quaternion } from 'three'
import { POLAR_LIMIT } from './compassViews'

/**
 * GAME CONTROLS: the arithmetic of a camera you drive rather than one you
 * orbit, with none of the wiring that drives it.
 *
 * Split from `GameControls` for the reason `marquee.ts` is split from
 * `SelectionMarquee`: every decision in here is a function of numbers -- which
 * way is forward when the camera is looking at the floor, what a wheel notch is
 * worth, where the eye is pointing after a drag of so many pixels -- and
 * `ui-check` has to be able to put a camera through them and read the answer
 * back without a canvas to draw on. The component is then the small part that
 * is genuinely about listeners and frames.
 *
 * WHY A SECOND CAMERA AT ALL. The orbit rig this app has always used answers
 * "look at THIS from over there", which is the right question for a part on a
 * bench and the wrong one for a room: to see the far side of an assembly you
 * must first work out what to orbit around, and to get inside one you cannot.
 * Everybody who has played a game already knows the other answer -- stand
 * somewhere, look about, walk -- and that is the whole of what this offers. The
 * orbit rig is not replaced by it; the two share the same controls and the same
 * compass, and the switch in Settings decides which gestures are live.
 */

/** Which way a held key is asking to go. */
export type Move = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down'

/**
 * The keys, lower-cased, exactly as `KeyboardEvent.key` reports them.
 *
 * WASD AND NOT THE ARROWS, and W is `w` rather than `KeyW`: this is a layout
 * the user's fingers know by the letters printed on them, and reading the
 * physical key would put a French keyboard's `z` where an English one's `w` is.
 * The cost is that a Dvorak user gets the letters rather than the shape, which
 * is the same bargain every application in this space strikes.
 *
 * SPACE UP, C DOWN, and C is the one that had to be argued for. Ctrl is what
 * this scheme wants and what was asked for -- it is where the hand already sits
 * and it is what every editor with a fly camera uses -- and it cannot be had in
 * a browser tab. Ctrl+W closes the tab, and it is one of the handful of chords
 * a page is not permitted to intercept: `preventDefault` does nothing to it. So
 * the single commonest thing anybody would do with this camera -- walk forward
 * while sinking -- would have thrown the unsaved document away. C is the
 * crouch key in the games this borrows from, it is a finger's reach from the
 * WASD cluster, and bare C means nothing else in this app. It also leaves Ctrl
 * whole, so undo, redo, copy and paste go on working while you fly; see the key
 * handler in `Viewport`.
 */
export const MOVE_KEYS: Record<string, Move> = {
  w: 'forward',
  s: 'back',
  a: 'left',
  d: 'right',
  ' ': 'up',
  c: 'down',
}

/** The direction a key press is asking for, or null when it asks for none. */
export function moveFor(key: string): Move | null {
  return MOVE_KEYS[key.toLowerCase()] ?? null
}

/**
 * How fast the camera travels, in scene units a second. One unit is 10 cm.
 *
 * The default is four -- 40 cm a second -- which crosses the 10 cm solid the
 * palette drops in a quarter of a second and the width of the opening shot in
 * about one. The range either side is deliberately enormous, because the scenes
 * are: this app draws parts a millimetre across and walls five metres long, and
 * a speed that suits one is unusable at the other. At the bottom the camera
 * creeps two centimetres a second, which is how you nose along a fillet; at the
 * top it covers four metres, which is how you get from one end of a building to
 * the other before losing interest.
 */
export const FLIGHT_SPEED_MIN = 0.2
export const FLIGHT_SPEED_MAX = 40
export const FLIGHT_SPEED_DEFAULT = 4

/**
 * What the wheel is worth, and why it is a MULTIPLIER rather than a step.
 *
 * The range above is two hundred to one, so a fixed step could only ever suit
 * one end of it: a step fine enough to aim at 0.2 would need a thousand notches
 * to reach 40. A constant ratio makes every notch the same PROPORTION instead,
 * which is how the control feels the same whether you are creeping along a
 * fillet or crossing a room -- about five notches to double or halve, and some
 * thirty-eight from end to end.
 *
 * `WHEEL_NOTCH` is what one detent of a mouse wheel reports, so a wheel gets
 * exactly one notch per click and a trackpad -- which sends a stream of much
 * smaller deltas -- gets a smooth fraction of one for each. Reading the sign
 * alone would have made a trackpad flick cross the whole range.
 */
export const SPEED_RATIO = 1.15
export const WHEEL_NOTCH = 100

/** Where a wheel event leaves the speed, clamped to the range above. */
export function speedAfterWheel(speed: number, deltaY: number): number {
  const wheeled = speed * SPEED_RATIO ** (-deltaY / WHEEL_NOTCH)
  return Math.min(FLIGHT_SPEED_MAX, Math.max(FLIGHT_SPEED_MIN, wheeled))
}

/**
 * How far the eye turns per pixel of drag, in radians.
 *
 * A full turn takes about 1,800 pixels, which is a little over two sweeps of a
 * 1080-tall window and lands where the mouse-look in most games sits. Slower
 * than that and you cannot spin round to see what is behind you; faster and the
 * last few pixels of a drag overshoot the face you were aiming at.
 */
export const LOOK_RATE = 0.0035

/** Reused across frames -- see `snapIndicator` in `snapping.ts` for why nothing
 *  in a frame loop allocates. */
const SPHERICAL = new Spherical()
const SPUN = new Vector3()
const FORWARD = new Vector3()
const SIDE = new Vector3()
const UP = new Vector3(0, 1, 0)

/**
 * Which way is FORWARD for a camera facing `facing`, flattened onto the ground.
 *
 * WASD stays in the XZ plane and height is Space and C alone, which is the one
 * decision in here that is not the game convention: a spectator camera flies
 * along its own view axis, so looking down and holding W buries you in the
 * floor. This is a modelling viewport, and the thing a user does most with the
 * camera pointed down is look at a part on the ground -- if W dived at it, the
 * only way to cross the scene would be to level the view first. Flattened, the
 * view direction chooses a heading and nothing else, so you can walk across a
 * layout while looking straight at it.
 *
 * STRAIGHT DOWN HAS NO HEADING, and that is what the fallback is for: a camera
 * looking at its own feet projects to nothing on the ground, and normalising a
 * zero vector gives a zero vector, so W would silently stop working at the one
 * angle you most want to fly across. The camera's own UP vector projects to
 * exactly the heading the screen is showing as "away" at that angle, so the
 * view carries on meaning what it looks like it means.
 */
export function headingOf(facing: Quaternion, out: Vector3): Vector3 {
  out.set(0, 0, -1).applyQuaternion(facing)
  out.y = 0
  if (out.lengthSq() < 1e-12) {
    out.set(0, 1, 0).applyQuaternion(facing)
    out.y = 0
    // Both degenerate at once is unreachable -- forward and up are
    // perpendicular, so they cannot both lie on the Y axis -- and answered
    // anyway rather than handing back a zero vector to normalise.
    if (out.lengthSq() < 1e-12) out.set(0, 0, -1)
  }
  return out.normalize()
}

/**
 * How far the camera travels this frame, given the keys held down.
 *
 * NORMALISED ACROSS ALL THREE AXES, so no direction is faster than another.
 * Held diagonally, two unit vectors add to one of length 1.41, and a camera
 * that crosses the room 41% faster on the diagonal is the oldest bug in this
 * genre. Vertical is folded into the same normalisation rather than added on
 * top of it, which means W and Space together climb at the same speed W alone
 * walks -- the alternative reads as a speed boost for pressing more keys.
 *
 * Opposed keys cancel, because they cancel: a hand resting on W and S is asking
 * to stand still, and the sum says so without a rule of its own.
 */
export function flightStep(
  held: ReadonlySet<Move>,
  facing: Quaternion,
  speed: number,
  dt: number,
  out: Vector3
): Vector3 {
  const ahead = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0)
  const across = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)
  const climb = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0)

  out.set(0, 0, 0)
  if (ahead === 0 && across === 0 && climb === 0) return out

  headingOf(facing, FORWARD)
  // Forward crossed with world up is the camera's right on the ground: with
  // the camera looking down -Z this is +X, which is the hand the D key means.
  SIDE.crossVectors(FORWARD, UP).normalize()

  out.addScaledVector(FORWARD, ahead)
  out.addScaledVector(SIDE, across)
  out.addScaledVector(UP, climb)
  return out.normalize().multiplyScalar(speed * dt)
}

/**
 * Where the camera should be LOOKING after a drag of (dx, dy) pixels.
 *
 * Free-look turns the eye in place, which the orbit rig has no gesture for: it
 * only ever knows how to swing the camera around a fixed point. So the turn is
 * expressed as the one thing the rig does understand -- a new target -- placed
 * along the new view direction at exactly the distance the old one sat at. The
 * camera does not move, the rig re-derives its angles from the offset on its
 * next update, and every other thing that reads the target keeps working: the
 * compass still flies about it, the orbit gesture still has a pivot.
 *
 * KEEPING THE DISTANCE is what makes that safe. The rig clamps how far the
 * camera may sit from its target, so a target dropped a fixed distance ahead
 * would be hauled back by the clamp on the next update and the camera with it
 * -- a turn that also crept forward. Reusing the distance cannot trip a clamp
 * it was already inside.
 *
 * The polar angle is clamped rather than wrapped, for the reason the compass
 * clamps its own: past the pole the world is upside down, and the rig orbits
 * about a `+Y` up vector that would then be fighting the drag that got it
 * there.
 */
export function lookTarget(
  eye: Vector3,
  target: Vector3,
  dx: number,
  dy: number,
  out: Vector3
): Vector3 {
  const gaze = SPUN.copy(target).sub(eye)
  const reach = gaze.length()
  // A target sitting exactly on the camera has no direction to turn. It cannot
  // arise from anything in this file -- the distance is preserved on every turn
  // -- but the rig's own minimum is 0.02, not 0, so it is answered rather than
  // left to hand back a NaN heading.
  if (reach < 1e-9) return out.copy(target)

  const spin = SPHERICAL.setFromVector3(gaze)
  // Dragging RIGHT turns the view right. Three measures azimuth from +Z toward
  // +X, and a camera looking down -Z that turns to face +X goes from pi to
  // pi/2 -- so the sign is a subtraction.
  spin.theta -= dx * LOOK_RATE
  // Dragging DOWN looks down. Polar is measured from +Y, so looking further
  // down is a larger angle and the sign is an addition.
  spin.phi = Math.max(POLAR_LIMIT, Math.min(Math.PI - POLAR_LIMIT, spin.phi + dy * LOOK_RATE))
  return out.copy(eye).add(SPUN.setFromSpherical(spin).setLength(reach))
}

/**
 * Which directions are being asked for right now.
 *
 * Module-level, and mutated rather than set, for the reason `modifiers` and
 * `snapIndicator` in this folder are: it is read from a frame loop on every
 * frame the camera moves, and a store round trip per key press would re-render
 * the whole scene sixty times a second while somebody walks across it.
 */
const held = new Set<Move>()

/** Take a key press. Answers whether it was one of ours, so the caller knows
 *  whether to swallow it -- Space scrolls a page and must not. */
export function pressMove(key: string): boolean {
  const move = moveFor(key)
  if (!move) return false
  held.add(move)
  return true
}

/** Let a key up. Unconditional, so a key released after the mode was switched
 *  off cannot leave a direction stuck on. */
export function releaseMove(key: string): void {
  const move = moveFor(key)
  if (move) held.delete(move)
}

/**
 * Forget every key, for the two moments a key-up will never arrive: the window
 * losing focus mid-stride, and the mode being switched off with a hand still on
 * W. Without it the camera would set off on its own the next time either came
 * back.
 */
export function clearMoves(): void {
  held.clear()
}

/** The live set, for the frame loop and for `ui-check`. */
export function movesHeld(): ReadonlySet<Move> {
  return held
}

/**
 * Whether the camera is under way, which is the question every press in the
 * scene has to ask before it starts a gesture.
 *
 * A drag begun mid-flight is measured against a viewport that is sliding out
 * from under it: the solid you grabbed is somewhere else by the time the second
 * frame lands, and a brush stroke started on the way past paints a smear across
 * whatever happened to pass under the pointer. So a press that arrives while
 * this is true is refused outright -- see the guard in `GameControls`. A gesture
 * already running is NOT interrupted by taking off, which is the other half of
 * the same rule: what is being protected is the start of a gesture, where the
 * grab offset is measured, and by the time you are moving that measurement has
 * already been made.
 */
export function moving(): boolean {
  return held.size > 0
}
