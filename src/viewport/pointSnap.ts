/**
 * Lining a Point Cut's knots up with the ones already placed.
 *
 * Pure arithmetic in a file of its own, the same bargain `orthoFrame.ts` and
 * `facePan.ts` strike: a snap that catches half a millimetre early or late
 * still looks exactly like a snap. What it does not do is line the points up,
 * and nobody finds that out by looking at the screen -- they find it out when
 * the cut comes off crooked. Numbers in, numbers out, and a headless check can
 * hold every one of them to account.
 *
 * WHY A POINT NEEDS THIS AND A STROKE DOES NOT. A freehand line is a hand's
 * line and is meant to look like one. Placed points are the opposite: they are
 * for the cut you could not draw by hand -- a straight edge, a step, a slot
 * with a square corner -- and every one of those is two points sharing a
 * coordinate. Getting them to share it by eye at some arbitrary zoom is not a
 * thing a hand can do, which is exactly the case a snap is for.
 *
 * TWO AXES, SEPARATELY, and that is the whole design. It does NOT snap to the
 * other point -- that would put two knots on top of each other, which is the
 * one arrangement a cut has no use for. It snaps to its ROW and to its COLUMN,
 * each on its own, so a point can take its height from one neighbour and its
 * width from another and land on the corner the two of them imply. A point that
 * catches both at once is sitting where a right angle turns.
 *
 * IN FACE COORDINATES throughout -- fractions of the block, which is what the
 * drawing is stored in and what `CutLayer` reads the pointer as. The tolerance
 * arrives already converted, one number per axis, because a face's two
 * directions run along two different sides of the stock and on a sheet the same
 * screen distance is worth wildly different fractions of each. See
 * `faceTolerance`.
 */

import type { Pt } from '../geometry/laserCut'
import { pixelsToWorld } from './orthoFrame'

/**
 * How near a knot has to come to another one's row or column before it takes
 * it, in PIXELS on screen.
 *
 * PIXELS RATHER THAN A FRACTION OF THE BLOCK, which is the choice every other
 * measurement in `CutLayer` already makes -- the knots themselves, the grip
 * radius, the handles. A snap is a thing a hand does, so how close is close is
 * a fact about a hand and a screen: at twenty times the zoom the same fraction
 * of the block would be twenty times the reach, and a point could not be put
 * anywhere near another one without being swallowed by it.
 *
 * It is also why this is NOT the modelling screen's snap distance, which is a
 * length in the world and rightly so: there a snap catches the corner of a
 * solid, and the corner is somewhere in particular however near the camera
 * stands. Here there is nothing to catch but another mark on the same flat
 * face, and what makes two marks look aligned is pixels.
 *
 * Ten, which is between the knot's own radius and the reach that picks one up
 * -- close enough that it never fires while you are aiming somewhere else,
 * wide enough to catch without hunting.
 */
export const DEFAULT_LASER_SNAP = 10

/** The range the panel offers. Two pixels is barely a snap at all and is there
 *  for someone who wants it nearly off; forty is a third of an inch of screen,
 *  past which points stop being placeable near each other at all. */
export const LASER_SNAP_MIN = 2
export const LASER_SNAP_MAX = 40

/**
 * The length of the block's side that a face direction runs along.
 *
 * A face's u and v are AXIS-ALIGNED unit vectors -- see `faceBasis`, which
 * builds them out of the face normal and world up -- so this is a lookup
 * written as a dot product with the absolute value taken: the side is a length
 * and does not care which way the axis points.
 *
 * It exists because face coordinates are fractions of the stock rather than
 * lengths. On a cube the difference does not show; on a sheet two metres wide
 * and five millimetres thick, a hundredth of the block is twenty millimetres
 * one way and a twentieth of one the other, and a snap that used a single
 * tolerance for both would be unusable across the face and immovable up it.
 */
export function sideAlong(
  dir: { x: number; y: number; z: number },
  dims: readonly [number, number, number]
): number {
  return Math.abs(dir.x) * dims[0] + Math.abs(dir.y) * dims[1] + Math.abs(dir.z) * dims[2]
}

/**
 * What `pixels` of screen is worth in face coordinates, along u and along v.
 *
 * Two divisions, and neither can be skipped: the zoom says how much WORLD a
 * pixel covers -- see `pixelsToWorld`, and note that this only holds under a
 * projection, where a pixel is worth the same everywhere in the window -- and
 * the side of the stock that direction runs along says how much of the FACE
 * that world is. The same pair `markScale` undoes to draw a knot at a fixed
 * size, read here in the other direction.
 */
export function faceTolerance(
  pixels: number,
  zoom: number,
  sides: readonly [number, number]
): [number, number] {
  const world = pixelsToWorld(pixels, zoom)
  return [world / sides[0], world / sides[1]]
}

/** Where a knot landed, and which of its neighbours' lines it took on the way. */
export type Aligned = {
  at: Pt
  /** The u the point was pulled onto, or null if it kept its own. */
  onU: number | null
  /** And the v, likewise. Both at once is a corner. */
  onV: number | null
}

/**
 * Pull a point onto the row and the column of the nearest knot within reach of
 * each.
 *
 * NEAREST RATHER THAN FIRST, which matters the moment there are three points
 * and two of them are close: taking the first in the list would make the answer
 * depend on the order they happen to be stored in, so dragging past a knot
 * could leave you caught on one further away. The nearest is also the one the
 * eye has already picked.
 *
 * THE TWO AXES DO NOT HAVE TO AGREE. Each is decided on its own against the
 * whole set, so a point may take its height from one neighbour and its width
 * from another -- which is the case that puts a knot on the corner of a
 * rectangle whose sides were placed at different times.
 *
 * `peers` must not include the point being moved. A point is always exactly on
 * its own row, so leaving it in would pin it where it started and the knot
 * would refuse to move at all.
 *
 * A tolerance of zero, or a peerless point, gives the point back untouched --
 * which is what makes turning the snap off a matter of not calling this rather
 * than a mode inside it.
 */
export function snapToPeers(
  at: Pt,
  peers: readonly Pt[],
  tolerance: readonly [number, number]
): Aligned {
  const nearest = (axis: 0 | 1): number | null => {
    const reach = tolerance[axis]
    if (!(reach > 0)) return null
    let best: number | null = null
    let gap = reach
    for (const peer of peers) {
      const away = Math.abs(peer[axis] - at[axis])
      // Strictly nearer, so the earliest of two peers exactly the same distance
      // away wins -- an arbitrary tie broken the same way every time beats one
      // that flickers between them as the pointer trembles.
      if (away < gap) {
        gap = away
        best = peer[axis]
      }
    }
    return best
  }

  const onU = nearest(0)
  const onV = nearest(1)
  return { at: [onU ?? at[0], onV ?? at[1]], onU, onV }
}
