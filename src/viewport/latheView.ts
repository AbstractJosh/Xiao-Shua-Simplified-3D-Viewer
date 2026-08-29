import { CLAY_FLARE, CLAY_RINGS, ringHeight } from '../geometry/clay'
import type { Clay } from '../geometry/clay'

/**
 * How the lump is drawn, and how a pointer over the drawing is read back.
 *
 * ONE COORDINATE SPACE FOR THE WHOLE SCREEN, and it is scene units. The Lathe
 * viewport is an `<svg>` whose `viewBox` is measured in the same units the clay
 * is -- so a ring 4 cm from the axis is drawn at x = 0.4, a tool 2 cm wide is a
 * circle of r = 0.2, and not one line of the component converts anything into
 * pixels. That is what the viewBox is FOR, and it is the whole reason this
 * screen needs no camera, no projection matrix and no renderer: the browser
 * does the one transform there is, and it does it in layout rather than in
 * script.
 *
 * The one place the transform has to be written out is the way back -- a
 * pointer event speaks pixels, and the wall has to be told where the hand is.
 * That is `pointerToClay`, and it is the reason this module is pure and
 * separate: it is arithmetic the check suite can state without a DOM, in a
 * screen whose entire interaction rests on it being right.
 *
 * Y RUNS DOWN, because SVG's does, and everything here says so once so nothing
 * else has to. A height on the clay is measured up off the lathe; a y in this
 * space is measured down from the top of the frame. `clayY` is the join.
 */

/**
 * How much room the frame leaves above the rim and below the base, as fractions
 * of the lump's height.
 *
 * Above, so a piece pulled up to its full flare at the rim is not drawn against
 * the edge of the window, and so there is somewhere for the tool's ghost circle
 * to be while you aim at the top ring. Below, because the faceplate is drawn
 * there -- a piece standing on the bottom edge of its own frame reads as a piece
 * that has been cropped.
 */
const HEADROOM = 0.16
const WHEEL_GAP = 0.08

/**
 * And how much room to the sides, as a fraction of the widest the wall may ever
 * be worked.
 *
 * Against the FLARE LIMIT rather than against the piece's current width, which is
 * the whole trick that keeps this view still. The frame is decided by the stock
 * and by the bounds the stock implies, both of which only change when somebody
 * types in the Clay panel -- so the piece can be pulled out to its widest and
 * pushed back to a stem without the drawing rescaling once. A frame fitted to
 * the piece would zoom on every stroke, and the thing being aimed at would move
 * out from under the tool aiming at it.
 */
const SIDE_MARGIN = 1.18

/**
 * The frame the lump is drawn in: an SVG viewBox in scene units, plus where the
 * faceplate sits inside it.
 *
 * `base` is carried along rather than recomputed by each caller because it is
 * the origin everything on this screen is measured from -- the silhouette, the
 * ghost of the stock, the rings, the pointer -- and two callers disagreeing
 * about where the lathe is would draw a piece floating off its own lathe.
 */
export type ClayFrame = {
  x: number
  y: number
  width: number
  height: number
  /** The y of the faceplate's surface, which is the clay's zero. */
  base: number
}

export function clayFrame(clay: Clay): ClayFrame {
  const half = clay.radius * CLAY_FLARE * SIDE_MARGIN
  return {
    x: -half,
    y: 0,
    width: half * 2,
    height: clay.height * (1 + HEADROOM + WHEEL_GAP),
    base: clay.height * (1 + HEADROOM),
  }
}

/** The `viewBox` attribute, spelled out. */
export function viewBoxOf(frame: ClayFrame): string {
  return `${frame.x} ${frame.y} ${frame.width} ${frame.height}`
}

/** Where a height up the piece lands in the frame. The one place the flip lives. */
export function clayY(frame: ClayFrame, height: number): number {
  return frame.base - height
}

/** Three decimals is a hundredth of a millimetre: finer than the app draws, and
 *  it keeps a path rebuilt sixty times a second from carrying sixteen digits a
 *  ring. */
const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * The piece's silhouette: up the right-hand wall, down the left, closed at the
 * lathe.
 *
 * MIRRORED FROM ONE ARRAY, which is not a shortcut -- it is the shape of the
 * thing. What is drawn is a section through a solid of revolution, so the two
 * sides are the same wall seen from two sides, and drawing them from one row of
 * radii is what makes it impossible for them ever to disagree.
 *
 * Straight segments between rings rather than a spline through them. At
 * ninety-six rings over a lump this size the corners are a millimetre and a
 * half apart and land well inside a pixel or two on screen, and the wall is
 * relaxed after every dab so there is nothing sharp for a curve to soften. A
 * spline would only be a second opinion about a shape the clay already holds.
 */
export function silhouette(clay: Clay, frame: ClayFrame): string {
  const right: string[] = []
  const left: string[] = []

  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const y = round(clayY(frame, ringHeight(clay, i)))
    const r = round(clay.wall[i])
    right.push(`${r} ${y}`)
    // Built back to front as we go, so the return leg needs no second pass.
    left.unshift(`${-r} ${y}`)
  }

  return `M ${right.join(' L ')} L ${left.join(' L ')} Z`
}

/** The stock the piece was turned from, as a plain rectangle: the ghost the
 *  viewport draws behind the clay once the two have parted company. */
export function stockRect(
  clay: Clay,
  frame: ClayFrame
): { x: number; y: number; width: number; height: number } {
  return {
    x: -clay.radius,
    y: clayY(frame, clay.height),
    width: clay.radius * 2,
    height: clay.height,
  }
}

/**
 * The turning rings: faint lines across the body at even heights, each as wide
 * as the wall it crosses.
 *
 * The one piece of decoration on this screen, and it earns its place twice
 * over. It is what a turned piece LOOKS like -- the spiral a hand leaves as the
 * lathe turns under it -- so it says "clay" where a flat grey shape would say
 * "rectangle". And it is the only thing in the drawing that reports the wall's
 * shape from the INSIDE: a silhouette outlines a piece, and a stack of rings that
 * narrow and widen shows you the curve you are actually making.
 *
 * Taken from the wall itself rather than drawn at a fixed width, so they follow
 * every push and pull without being told about it, and inset a little at each
 * end so they read as marks on a surface rather than as the surface's edge.
 */
export function turningRings(
  clay: Clay,
  frame: ClayFrame,
  count: number
): { y: number; r: number }[] {
  const rings: { y: number; r: number }[] = []
  for (let n = 1; n <= count; n += 1) {
    // Evenly spread between the lathe and the rim, and never ON either: a ring
    // lying along the base is a line drawn on top of the piece's own edge.
    const t = n / (count + 1)
    const i = Math.round(t * (CLAY_RINGS - 1))
    const y = round(clayY(frame, ringHeight(clay, i)))
    rings.push({ y, r: round(clay.wall[i] * 0.78) })
  }
  return rings
}

/**
 * Where a pointer is, in the clay's own terms.
 *
 * The inverse of what `preserveAspectRatio="xMidYMid meet"` does on the way
 * out, written out by hand because there is no way to ask the browser for it
 * that works everywhere the check suite runs. `meet` fits the whole frame
 * inside the element and centres what is left over, so the scale is whichever
 * axis runs out first and the offsets are half the slack on each.
 *
 * `radius` is the DISTANCE FROM THE AXIS, unsigned, and that is what makes both
 * sides of the piece the same tool. The wall is one number per height -- a piece is
 * the same all the way round -- so a tool held against the left of the drawing
 * and one held against the right are the same tool at the same place, and
 * neither the user nor `mold` has any reason to care which side the hand is on.
 * `x` keeps its sign all the same, because the ghost circle has to be drawn
 * where the pointer actually is.
 */
export function pointerToClay(
  frame: ClayFrame,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
): { x: number; y: number; radius: number } {
  // A zero-sized element is not a thing anyone can point at, but it is a thing
  // a layout can produce for a frame or two, and it must not divide by nothing.
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0, y: 0, radius: 0 }

  const slackX = (rect.width - frame.width * scale) / 2
  const slackY = (rect.height - frame.height * scale) / 2
  const x = (clientX - rect.left - slackX) / scale + frame.x
  const viewY = (clientY - rect.top - slackY) / scale + frame.y

  return { x, y: frame.base - viewY, radius: Math.abs(x) }
}
