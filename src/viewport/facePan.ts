/**
 * How far the camera may be slid across the face it is looking at.
 *
 * Pure arithmetic in a file of its own, for the reason `orthoFrame.ts` is: a
 * limit that is slightly wrong is invisible. A pan that stops a little early
 * looks like a pan, and a pan that stops a little late looks like a pan too --
 * it is only when somebody zooms in on the far corner of a face and finds they
 * cannot reach it, or slides the block off the window entirely and has to hunt
 * for it, that the number turns out to have been guessed. Numbers in, numbers
 * out, and a headless check can hold every one of them to account.
 *
 * WHY THERE IS A PAN AT ALL. This camera cannot dolly -- it projects -- so the
 * only way to see a millimetre of a face closely is to zoom, and a zoom that
 * fills the window with the middle of the block puts its edges outside the
 * window with no way to reach them. A lens would have been walked closer and
 * aimed; a projection has to be SLID. So the pan is not a convenience here, it
 * is the other half of the wheel.
 *
 * WHY IT IS BOUNDED. The block is the only thing on this screen and the camera
 * is only ever square on to one of its faces: a view that has been slid off the
 * stock entirely is a screen with nothing on it and nothing to say which way to
 * drag back. Bounding it also keeps the compass honest -- the view is still the
 * view of a FACE, however far across it has been carried.
 */

import type { FaceAxis } from '../geometry/laserCut'

/**
 * How far the middle of the window may travel from the middle of the block,
 * one number per world axis, looking along `axis`.
 *
 * THE EDGES OF THE FACE, and measured to the middle of the window rather than
 * to its rim. So the far corner of a face can always be brought to the middle
 * of the screen, at any zoom, and the pan stops with the block filling half the
 * window rather than leaving it altogether. Measured any other way the limit
 * would have to know the zoom, and a limit that moves as you scroll is a limit
 * nobody can feel the shape of.
 *
 * NOTHING ALONG THE VIEW AXIS. Panning a camera moves it in the plane of the
 * screen, and square on to a face that plane IS the face -- so the third number
 * is always zero, and it is stated rather than left to arithmetic that happens
 * to come out that way. It is what keeps a view that has been slid across a
 * face from also drifting toward or away from it, which no gesture on this
 * screen asks for and which would quietly stop the view being square on.
 */
export function panLimits(axis: FaceAxis['axis'], dims: readonly [number, number, number]): [number, number, number] {
  return [
    axis === 0 ? 0 : dims[0] / 2,
    axis === 1 ? 0 : dims[1] / 2,
    axis === 2 ? 0 : dims[2] / 2,
  ]
}

/**
 * The nearest offset to `offset` that those limits allow.
 *
 * Per axis rather than by length, which is the difference between a face and a
 * disc: the corners of a face are further from its middle than its edges are,
 * and a round limit would refuse to reach them. Clamping each axis on its own
 * makes the reachable ground a rectangle the shape of the face -- which is what
 * "no further than the edges" means when the thing being bounded is a rectangle.
 */
export function clampPan(
  offset: readonly [number, number, number],
  limits: readonly [number, number, number]
): [number, number, number] {
  return [
    Math.min(limits[0], Math.max(-limits[0], offset[0])),
    Math.min(limits[1], Math.max(-limits[1], offset[1])),
    Math.min(limits[2], Math.max(-limits[2], offset[2])),
  ]
}

/** No travel in any direction: what a face change clamps against for one frame
 *  to put the view back on the middle of the block. */
export const NO_PAN: [number, number, number] = [0, 0, 0]

/**
 * What to add to BOTH the pivot and the camera to bring a pan that has gone too
 * far back inside its limits.
 *
 * A correction rather than a position, and that is the whole shape of the fix.
 * The camera and the point it orbits have to move by the same amount or the
 * view tips: three rebuilds the camera's position from the pivot and the orbit
 * every update, so what must survive a clamp is the DIFFERENCE between them.
 * Handing back a delta makes that impossible to get wrong at the call site --
 * there is one number, and it is added to two things.
 *
 * `pivot` is the point the camera orbits, in world space; `middle` is the
 * middle of the block, which is what the limits are measured from. Zero when
 * the pan is inside its limits, which is most frames of most sessions.
 */
export function panCorrection(
  pivot: readonly [number, number, number],
  middle: readonly [number, number, number],
  limits: readonly [number, number, number]
): [number, number, number] {
  const asked: [number, number, number] = [
    pivot[0] - middle[0],
    pivot[1] - middle[1],
    pivot[2] - middle[2],
  ]
  const held = clampPan(asked, limits)
  return [held[0] - asked[0], held[1] - asked[1], held[2] - asked[2]]
}
