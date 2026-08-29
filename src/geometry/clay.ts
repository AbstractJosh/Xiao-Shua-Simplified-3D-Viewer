import { MAX_RADIUS, MAX_SIZE, MIN_DIMENSION } from './dimensions'

/**
 * THE CLAY: a lump on a lathe, and what a tool held against it does.
 *
 * The Lathe screen shapes one thing, and it is the one thing a lathe can make:
 * a solid of revolution. That is the whole reason this module is a hundred
 * numbers rather than a mesh. A shape turned on a lathe is the same all the way
 * round by construction -- the turning is what makes it so -- so the only thing
 * there is to remember about it is HOW FAR THE WALL STANDS FROM THE AXIS at
 * each height. Store that, and every other fact about the piece is arithmetic:
 * its silhouette, its widest point, the section the viewport draws.
 *
 * WHY NOT `erode.ts`. The modelling screen already has a brush that pushes a
 * surface around, and it is a serious piece of work -- it re-tessellates under
 * the pointer, guards against the mesh folding through itself, and relaxes
 * vertices toward their neighbours in three dimensions. None of that is needed
 * here and most of it could not be used: there are no vertices to fold, no
 * triangles to subdivide, and no way for one ring to cross another. What
 * survives the move is the IDEA the torch is built on -- material sags toward
 * the tool, hardest under the middle of it, and the surface relaxes toward
 * itself afterwards so nothing sharpens to a point -- written out in one
 * dimension, where it is a loop over an array.
 *
 * Everything here is scene units, the same units `dimensions.ts` bounds and
 * `units.ts` fixes at ten centimetres to the unit. No display unit ever reaches
 * this file; the panel converts on the way in, as every other panel does.
 *
 * Pure, and free of React, three and the stores, so `engine-check` can mount a
 * lump and work it without a window in front of it.
 */

/**
 * How many rings the wall is remembered as, bottom to top.
 *
 * Ninety-six over a lump 15 cm tall is a ring every millimetre and a half,
 * which is finer than the eye reads a curve at and far finer than a brush two
 * centimetres wide can aim. It is also small enough that a whole stroke --
 * sixty dabs a second, each rewriting the array -- costs less than one frame of
 * the modelling screen's cheapest render.
 *
 * FIXED rather than scaled to the lump's height, so a piece worked tall and
 * then shortened is the same piece rather than a resampled approximation of
 * one. The rings sit at FRACTIONS of the height rather than at absolute
 * positions -- see `ringHeight` -- which is what lets the height change without
 * touching the wall at all.
 */
export const CLAY_RINGS = 96

/**
 * A lump of clay: the stock it was turned as, and the wall as it stands now.
 *
 * `height` and `radius` are the STOCK -- the plain cylinder the popup sets, and
 * the thing the ghost outline in the viewport draws. They are kept even after
 * the wall has been worked away from them, for two reasons: the wall's limits
 * are fractions of the stock radius (see `wallBounds`), and the view frames
 * itself against the stock so the piece does not swim about the screen as it
 * is shaped.
 */
export type Clay = {
  /** How tall the lump stands on the lathe. */
  height: number
  /** How far the wall stood from the axis before anyone touched it. */
  radius: number
  /**
   * The wall: one radius per ring, bottom first, always `CLAY_RINGS` long.
   *
   * Never empty and never partial. Every function here takes a whole wall and
   * hands back a whole wall, so no consumer has to ask whether a ring exists.
   */
  wall: number[]
}

/**
 * What the stock may be, which is exactly what a cylinder in the modelling
 * screen may be.
 *
 * Re-exported from `dimensions.ts` rather than decided again here, and that is
 * the point rather than an economy: a piece is a solid this app can make, so
 * the question "how big may it be" already has an answer, and a second set of
 * bounds would be this screen quietly disagreeing with the other one about what
 * the app is for.
 */
export const CLAY_HEIGHT_MIN = MIN_DIMENSION
export const CLAY_HEIGHT_MAX = MAX_SIZE
export const CLAY_RADIUS_MIN = MIN_DIMENSION
export const CLAY_RADIUS_MAX = MAX_RADIUS

/**
 * The lump the screen opens on: 15 cm tall and 8 cm across.
 *
 * Taller than it is wide, which is what a lump centred on a lathe looks like
 * before it is opened, and what makes the first push read as a waist rather
 * than as a dent. The palette's own default solid is a 10 cm cube -- see
 * `DEFAULT_SPAN` -- so this is the same order of thing the modelling screen
 * drops, in the proportion this one works in.
 */
export const DEFAULT_CLAY_HEIGHT = 1.5
export const DEFAULT_CLAY_RADIUS = 0.4

/**
 * How far in and out of the stock the wall may be worked, as fractions of the
 * stock radius.
 *
 * BOUNDED, and bounded in both directions, because an unbounded wall breaks the
 * one promise this screen makes about the view: that what you are shaping stays
 * on screen at the size you can see it. The viewport frames the stock times
 * `CLAY_FLARE` and never re-frames -- a view that zoomed out as you pulled
 * would move the piece out from under the tool that was pulling it.
 *
 * The floor is a twentieth rather than zero. A wall pinched to nothing is a
 * piece cut in two, and this model has no way to say that -- the shape is one
 * radius per height, so "no material here" would be a piece with an invisible
 * hinge in it. Left at a twentieth it is a neck you can see, which is what
 * somebody pinching that hard is usually after.
 */
export const CLAY_PINCH = 0.05
export const CLAY_FLARE = 1.9

/** Every bound here is applied with it, so no two callers can disagree. */
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * How far the wall may be worked, in scene units, for a given stock.
 *
 * Off the STOCK radius rather than off wherever the wall happens to be, so the
 * limits stand still while you work. A ceiling measured from the current wall
 * would creep outward with every pull -- each stroke raising the ceiling for
 * the next -- and the piece would eventually leave the frame it is drawn in.
 *
 * The floor never drops below a millimetre, which is the smallest feature this
 * app can draw at all: on a thumbnail-sized stock a twentieth of the radius is
 * finer than the screen.
 */
export function wallBounds(radius: number): { min: number; max: number } {
  return {
    min: Math.max(MIN_DIMENSION, radius * CLAY_PINCH),
    max: radius * CLAY_FLARE,
  }
}

/** A fresh lump: the stock, unworked, every ring at the same radius. */
export function freshClay(
  height: number = DEFAULT_CLAY_HEIGHT,
  radius: number = DEFAULT_CLAY_RADIUS
): Clay {
  const h = clamp(height, CLAY_HEIGHT_MIN, CLAY_HEIGHT_MAX)
  const r = clamp(radius, CLAY_RADIUS_MIN, CLAY_RADIUS_MAX)
  return { height: h, radius: r, wall: new Array<number>(CLAY_RINGS).fill(r) }
}

/**
 * Where ring `i` sits up the lump, in scene units off the faceplate.
 *
 * The rings are spread evenly from the base (0) to the rim (`height`), ends
 * included, which is why the divisor is one less than the count. It matters at
 * both ends: a tool held at the very top of the piece has to reach the ring
 * that draws the rim, and one held at the faceplate has to reach the base.
 */
export function ringHeight(clay: Clay, i: number): number {
  return (i / (CLAY_RINGS - 1)) * clay.height
}

/** The widest the wall stands: what the readout calls the piece's size. */
export function widestRadius(clay: Clay): number {
  return clay.wall.reduce((a, b) => Math.max(a, b), 0)
}

/**
 * A tool held against the turning wall for one instant.
 *
 * `radius` is where the tool IS -- how far the pointer sits from the axis --
 * rather than how much to move the wall by, and that is the whole of what makes
 * this screen easy to aim. A displacement brush moves the wall by an amount and
 * goes on moving it for as long as you hold, so you have to let go at the right
 * moment to get the shape you meant. This one moves the wall TOWARD the tool
 * and stops there: where you put the pointer is where the wall ends up, and
 * holding still for longer cannot overshoot it.
 */
export type Dab = {
  /** Where up the lump the tool is held, in scene units off the faceplate. */
  y: number
  /** How far from the axis it is held: what the wall is worked toward. */
  radius: number
  /** How much of the wall the tool covers, as a distance up and down from `y`. */
  reach: number
  /** How far toward the tool the middle of the brush travels this instant, 0..1. */
  bite: number
  /** Which way the tool works: in, taking material away, or out, adding it. */
  push: boolean
}

/**
 * How much of the way to the tool the wall travels in `ms` of contact.
 *
 * Here rather than in the viewport because it is the tuning, not the plumbing:
 * it decides what the strength dial FEELS like, and the check suite has to be
 * able to state it without a clock.
 *
 * The rate is per sixtieth of a second and scaled by however long the frame
 * actually took, so a stroke on a busy machine takes the same material as one
 * on an idle machine -- a brush measured in frames rather than in time bites
 * twice as hard at 120 Hz.
 *
 * A quarter at full strength puts the wall on the tool in about a fifth of a
 * second: fast enough that the clay feels attached to the pointer, slow enough
 * that the eye sees it arrive and the hand can lift off part way for a
 * shallower cut.
 */
const CLAY_RATE = 0.25
const FRAME_MS = 1000 / 60

export function bite(strength: number, ms: number): number {
  return clamp(strength * CLAY_RATE * (ms / FRAME_MS), 0, 1)
}

/**
 * How much of the difference with its neighbours a ring gives up after a dab.
 *
 * This is surface tension, and it is the half of the brush that stops the tool
 * being a cookie cutter. Without it a hard bite leaves the ring under the
 * middle of the brush plainly ahead of the ones beside it, and the wall gains a
 * crease -- creases that accumulate, because the next stroke starts from them.
 * With it, the wall the tool leaves behind is always smoother than the tool.
 */
const RELAX = 0.4

/** Smoothstep: flat at both ends, so a dab meets the untouched wall without a
 *  corner. The same falloff the modelling brushes use, in one dimension. */
const falloff = (t: number) => t * t * (3 - 2 * t)

/**
 * Work the wall with a tool held at one spot, and hand back the lump that
 * leaves.
 *
 * TWO TOOLS, ONE FUNCTION, ONE COMPARISON BETWEEN THEM -- the arrangement
 * `erode.ts` arrived at for the torch and the sculpt tool, for the same reason:
 * push and pull are not two behaviours, they are one behaviour with a direction
 * on it, and written twice they would drift the first time either was tuned.
 * `Dab.push` chooses `Math.min` over `Math.max`, and nothing else in here
 * changes.
 *
 * THE TOOL ONLY EVER WORKS ITS OWN WAY. Push may not push a ring outward, even
 * one that is already inside the pointer, and pull may not draw one in. That is
 * what the min and the max buy, and it is worth stating because it is what
 * makes the pair usable as a pair: a push aimed a little wide of a narrow neck
 * does nothing at all, rather than quietly filling the neck back in. Undoing an
 * overshoot is the other tool's job, and that is where the hand already is.
 *
 * A ring OUTSIDE the brush is left exactly as it was, to the bit -- the same
 * promise the modelling brushes make about vertices outside the sphere. A dab
 * that moves nothing -- one that reaches no ring, or one aimed the way its tool
 * does not work -- hands back the very lump it was given, unchanged and not
 * merely equal, so a stroke that misses cannot make React redraw and cannot
 * quietly smooth a wall it was not allowed to cut.
 *
 * `from` IS THE WALL AS THE STROKE FOUND IT, and it is what makes the tool a
 * brush rather than a punch. The dish a held tool sinks is measured from there,
 * so the middle of the brush ends at the pointer and the rim of it ends exactly
 * where the wall already was -- see `limit`. Left out, it is this lump's own
 * wall, which is what a single dab means: a stroke of one.
 */
export function mold(clay: Clay, dab: Dab, from: number[] = clay.wall): Clay {
  const { min, max } = wallBounds(clay.radius)
  const strength = clamp(dab.bite, 0, 1)
  // A reach of zero is a tool with no width: it would divide by nothing below,
  // and touch a single ring if it touched anything at all.
  const reach = Math.max(dab.reach, MIN_DIMENSION)

  const worked = clay.wall.slice()
  let lo = -1
  let hi = -1
  let moved = false

  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const gap = Math.abs(ringHeight(clay, i) - dab.y)
    if (gap >= reach) continue

    // How much of the tool is over this ring: 1 under the middle of it, 0 at
    // the rim. It shapes BOTH how far this ring may go and how fast it gets
    // there.
    const shape = falloff(1 - gap / reach)
    const r = clay.wall[i]

    /**
     * Where this ring ends up if the tool is held here for ever.
     *
     * THE DISH, and the whole reason `from` exists. An aim of "the pointer"
     * for every ring the tool covers looks right for one dab and is wrong the
     * moment anyone holds still: every ring inside the reach converges on the
     * pointer, the falloff washes out, and what is left is a flat-bottomed
     * trench with a cliff at the rim -- a cookie cutter, which is the one thing
     * this tool is not. Measured from where the stroke found the wall, the
     * limit is the pointer under the middle of the tool and the untouched wall
     * at its rim, with the falloff between: holding still finishes a dish and
     * then stops.
     */
    const limit = from[i] + (dab.radius - from[i]) * shape
    // And the tool only ever works its own way, whatever the limit says.
    const aim = dab.push ? Math.min(limit, r) : Math.max(limit, r)

    worked[i] = clamp(r + (aim - r) * shape * strength, min, max)
    if (worked[i] !== r) moved = true

    if (lo < 0) lo = i
    hi = i
  }

  // Nothing moved: no ring in reach, no strength behind it, or a tool aimed the
  // way it does not work. Not even the relax below runs -- a push held wide of
  // the wall must be as inert as a push held off the piece entirely.
  if (lo < 0 || !moved) return clay

  // Then the relax, over the same window and weighted by the same falloff, so
  // it fades out where the dab does and the wall beyond the brush stays
  // untouched. Read from `worked`, written to `wall`: a pass that read its own
  // output would smear the first ring's correction along the whole window.
  const wall = worked.slice()
  for (let i = lo; i <= hi; i += 1) {
    // Mirrored at the ends rather than clamped to zero: the base ring and the
    // rim ring have one neighbour each, and pretending the missing one sits on
    // the axis would draw both ends of every piece inward.
    const before = worked[i === 0 ? 0 : i - 1]
    const after = worked[i === CLAY_RINGS - 1 ? CLAY_RINGS - 1 : i + 1]
    const gap = Math.abs(ringHeight(clay, i) - dab.y)
    const shape = falloff(Math.max(0, 1 - gap / reach)) * strength * RELAX
    wall[i] = clamp(worked[i] + ((before + after) / 2 - worked[i]) * shape, min, max)
  }

  return { ...clay, wall }
}

/**
 * Change the stock the piece was turned from, carrying the shape with it.
 *
 * THE WALL IS SCALED, NOT THROWN AWAY. Somebody who has spent a minute shaping
 * a piece and then decides it should be a wider piece means "the same piece,
 * wider", and re-centring the lump on every keystroke would make the size
 * fields a control nobody dares touch. Scaling by the ratio of the radii is exactly
 * "what if I had started from that cylinder and made the same gestures": on an
 * unworked lump it is indistinguishable from a fresh lump, which is the case
 * the fields are usually used in anyway.
 *
 * HEIGHT COSTS NOTHING, because the wall is stored as rings at fractions of the
 * height rather than at absolute positions -- see `ringHeight`. A taller lump
 * is the same profile stretched, which is again what "the same piece, taller"
 * means.
 *
 * The wall is re-clamped to the new bounds on the way through: a wall pulled to
 * the flare limit of a wide stock is past the limit of a narrow one, and a
 * shape that could not have been made from the stock it now claims to be is not
 * a shape this screen can go on working.
 */
export function resize(clay: Clay, next: { height?: number; radius?: number }): Clay {
  const height = clamp(next.height ?? clay.height, CLAY_HEIGHT_MIN, CLAY_HEIGHT_MAX)
  const radius = clamp(next.radius ?? clay.radius, CLAY_RADIUS_MIN, CLAY_RADIUS_MAX)
  if (height === clay.height && radius === clay.radius) return clay

  const factor = radius / clay.radius
  const { min, max } = wallBounds(radius)
  const wall =
    factor === 1 ? clay.wall : clay.wall.map((r) => clamp(r * factor, min, max))
  return { height, radius, wall }
}

/**
 * Whether the wall still stands where the stock left it.
 *
 * What it is for: the viewport draws the stock as a dashed ghost, so you can
 * see how far the piece has come from it -- and on an untouched lump that ghost
 * lands exactly on the silhouette, which reads as a rendering fault rather than
 * as a reference. So the ghost waits until there is a difference to describe.
 *
 * A tolerance rather than equality, because a stroke that lands and is worked
 * back out leaves floating-point dust behind. A hundredth of a millimetre is
 * finer than the app can draw and coarser than the dust.
 */
export function isFresh(clay: Clay): boolean {
  return clay.wall.every((r) => Math.abs(r - clay.radius) < 0.0001)
}
