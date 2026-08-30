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
 * THE ONE THING THAT IS NOT A RADIUS is `sides`, and it changes none of the
 * above. A piece may be turned round or on a triangle through a decagon, and
 * every one of those has the same PROFILE -- a hexagonal prism and a cylinder
 * are the same rectangle from the side, which is why the drawing, the tools and
 * every function here carry on unaware of it. It is settled in one place, where
 * the wall is swept into triangles: see `revolveClay`.
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
 *
 * `sides` is the SECTION -- what the lump would look like sawn through, which
 * is the one fact about it this screen cannot draw. See below.
 */
export type Clay = {
  /** How tall the lump stands on the lathe. */
  height: number
  /** How far the wall stood from the axis before anyone touched it. */
  radius: number
  /**
   * How many flats go round the piece, or null for a round one.
   *
   * NOTHING ELSE IN THIS FILE READS IT, and that is the point rather than an
   * oversight. A prism and a cylinder of the same profile have the SAME
   * SILHOUETTE -- turn a hexagonal piece to a waist and the waist is in the
   * same place -- so every function here goes on working one row of radii and
   * the whole screen goes on drawing one filled path. The section is settled
   * once, when the wall is swept into triangles on its way to the clipboard:
   * see `revolveClay`.
   *
   * THE WALL IS THE CORNERS. A radius is the distance from the axis to a
   * corner of the section, so the polygon is INSCRIBED in the profile the
   * screen draws and the flats sit `flatFactor` closer in. That is not a new
   * convention invented here -- the sweep has always been an inscribed 64-gon,
   * and every prism in the palette measures its radius the same way (see
   * `prismFaces`). Picking a hexagon is picking a coarser sweep, not a
   * different kind of solid.
   */
  sides: number | null
  /**
   * The wall: one radius per ring, bottom first, always `CLAY_RINGS` long.
   *
   * Never empty and never partial. Every function here takes a whole wall and
   * hands back a whole wall, so no consumer has to ask whether a ring exists.
   */
  wall: number[]
  /**
   * The bore: how thick a wall to leave and which ends are open, or null for a
   * piece that is solid all through.
   *
   * NOT A SECOND WALL. The obvious way to hollow a piece is to remember an
   * inner profile beside the outer one and let the tools shape both, and it is
   * the wrong way for this screen: it doubles what every stroke has to decide
   * (which wall am I on?), it lets the two cross, and it asks somebody to turn
   * the inside of a vessel they cannot see. What people mean by "hollow it" is
   * a WALL THICKNESS -- take the middle out and leave me half a centimetre --
   * which is one number, cannot self-intersect, and follows every stroke made
   * afterwards for nothing.
   *
   * So the inside is DERIVED rather than stored: see `bore`, which offsets this
   * wall inward and works out how far the cavity can actually reach. Shape the
   * outside and the inside follows, which is what happens when you thin a pot
   * on a real wheel.
   */
  hollow: Hollow | null
}

/**
 * How a piece is hollowed: one thickness, and a decision at each end.
 *
 * THE TWO ENDS ARE INDEPENDENT, and that is what makes this one control instead
 * of four shapes. Capped at the bottom and open at the top is a cup; open at
 * both is a pipe; capped at both is a sealed void, which is what "hollow it for
 * printing" means and shows from outside only when something cuts it; open at
 * the bottom with a lid on is the same cup upside down, which is a bell.
 */
export type Hollow = {
  /** How much material to leave, in scene units. The floor and the lid are the
   *  same thickness -- one number is the whole control. */
  thickness: number
  /** Closed by material at the rim / at the faceplate. */
  capTop: boolean
  capBottom: boolean
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
 * And what the section may be: a triangle through a decagon, or round.
 *
 * THREE at the bottom because two flats do not enclose anything -- a piece with
 * fewer than three sides is not a thinner piece, it is no piece at all.
 *
 * TEN at the top because that is where the family stops being read as a shape
 * and starts being read as a bad circle. A decagonal piece next to a round one
 * is plainly a decagon; a fourteen-sided one is a cylinder somebody has drawn
 * badly, and offering it would be offering the user a way to make the sweep
 * look broken. Anyone who wants the smooth thing already has it one button
 * away, at the 64 facets `TURN_FACETS` sweeps a round piece with.
 */
export const CLAY_SIDES_MIN = 3
export const CLAY_SIDES_MAX = 10

/**
 * How thin a wall may be left, and how thick.
 *
 * The floor is `MIN_DIMENSION`, a millimetre, which is the smallest thing this
 * app draws at all -- and, not by coincidence, about the thinnest wall anything
 * printed from one of these would survive.
 *
 * The ceiling is a quarter of the largest radius the app allows. Past that the
 * hollow stops being a hollow on any piece anybody is turning, and the dial
 * would spend most of its travel doing nothing. A wall thicker than the piece
 * is wide is not refused -- it simply leaves nothing to bore. See `bore`.
 */
export const CLAY_WALL_MIN = MIN_DIMENSION
export const CLAY_WALL_MAX = MAX_RADIUS / 4

/**
 * The wall a piece is left with when hollowing is first switched on: 6 mm.
 *
 * Around a seventh of the default lump's radius, which reads as a made thing
 * rather than as a shell -- plainly hollow in section, and thick enough that
 * the next stroke does not open a hole in it.
 */
export const DEFAULT_CLAY_WALL = 0.06

/**
 * How narrow the cavity may get before it counts as pinched shut.
 *
 * A millimetre of bore is not a bore. Below this the piece is simply solid
 * there -- which is what stops a vase's neck being drilled to a hair, and what
 * gives the cavity its ends when the caps do not.
 */
const BORE_MIN = MIN_DIMENSION

/** Every side count the selector offers, in the order it reads them out. */
export const CLAY_SIDES: number[] = Array.from(
  { length: CLAY_SIDES_MAX - CLAY_SIDES_MIN + 1 },
  (_, i) => CLAY_SIDES_MIN + i
)

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

/**
 * A section this screen can actually turn: whole, and in range.
 *
 * Null stays null and never becomes a number. Round is not a polygon with a
 * side count nobody supplied -- it is the other option -- and a clamp that
 * quietly answered `CLAY_SIDES_MIN` would turn every unset piece into a
 * triangle.
 */
export function clampSides(sides: number | null): number | null {
  if (sides === null || !Number.isFinite(sides)) return null
  return clamp(Math.round(sides), CLAY_SIDES_MIN, CLAY_SIDES_MAX)
}

/**
 * How far a FLAT stands from the axis, per unit of wall.
 *
 * The wall is the corners -- see `Clay.sides` -- and the flat between two of
 * them cuts the corner off, so it lies at the apothem: `cos(pi / n)` of the
 * radius. A hexagon keeps 87% of it, a triangle half, and a round piece all of
 * it, which is why this is 1 for null rather than a special case anywhere else.
 *
 * What it is FOR: the viewport draws it as a second, fainter profile inside the
 * silhouette, so the one thing the side view cannot show -- that this piece has
 * corners and where its narrowest side sits -- is on screen while it is being
 * shaped rather than a surprise on the clipboard.
 */
export function flatFactor(sides: number | null): number {
  return sides === null ? 1 : Math.cos(Math.PI / sides)
}

/** A fresh lump: the stock, unworked, every ring at the same radius. */
export function freshClay(
  height: number = DEFAULT_CLAY_HEIGHT,
  radius: number = DEFAULT_CLAY_RADIUS,
  sides: number | null = null
): Clay {
  const h = clamp(height, CLAY_HEIGHT_MIN, CLAY_HEIGHT_MAX)
  const r = clamp(radius, CLAY_RADIUS_MIN, CLAY_RADIUS_MAX)
  return {
    height: h,
    radius: r,
    sides: clampSides(sides),
    // Solid. Hollowing is a thing you do to a piece rather than a thing a lump
    // arrives as, and `centreFresh` puts back a solid lump for the same reason
    // it puts back an unworked one.
    hollow: null,
    wall: new Array<number>(CLAY_RINGS).fill(r),
  }
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
  /** Which of the three it is. */
  tool: ClayTool
}

/**
 * The three things a hand can do to a turning wall.
 *
 * `push` takes material away and `pull` adds it: one behaviour with a direction
 * on it, which is why they are one function below.
 *
 * `smooth` is the odd one, and it is the odd one in an interesting way -- it is
 * the SECOND HALF of the other two with the first half taken off. Every dab
 * already relaxes the wall it has just moved, because a tool that only
 * displaced would leave a crease under its middle; smooth is that relax on its
 * own, aimed where you hold it and displacing nothing. So the third tool costs
 * a branch rather than a pipeline. See `mold`.
 *
 * Named here rather than imported from the tool store, which knows about React
 * and about which button is lit. This is the geometry's own word for it, and
 * the store's `LatheTool` is this plus `null` for empty hands.
 */
export type ClayTool = 'push' | 'pull' | 'smooth'

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

/**
 * And how much the smoothing TOOL gives up, when relaxing is the whole of what
 * it is doing.
 *
 * Half again as much as a dab's own tidy-up, because the two are asking for
 * different things: `RELAX` runs after every push and must never take the shape
 * the user just cut, while this IS the shape the user asked for.
 *
 * Under one, and that is not a taste: a ring set to the average of its
 * neighbours in one step is Jacobi iteration, which oscillates on the
 * highest-frequency wobble there is -- alternate rings swapping places forever
 * rather than settling. Six tenths converges on every frequency, and since a
 * held tool relaxes sixty times a second, converging is all it needs to do.
 */
const SMOOTH = 0.6

/** Smoothstep: flat at both ends, so a dab meets the untouched wall without a
 *  corner. The same falloff the modelling brushes use, in one dimension. */
const falloff = (t: number) => t * t * (3 - 2 * t)

/**
 * Work the wall with a tool held at one spot, and hand back the lump that
 * leaves.
 *
 * THREE TOOLS, ONE FUNCTION -- the arrangement `erode.ts` arrived at for the
 * torch and the sculpt tool, for the same reason: push and pull are not two
 * behaviours, they are one behaviour with a direction on it, and written twice
 * they would drift the first time either was tuned. `Dab.tool` chooses
 * `Math.min` over `Math.max`, and nothing else in here changes.
 *
 * AND SMOOTH IS THE THIRD BY SUBTRACTION. Every dab ends with a relax pass over
 * the window it touched -- see `RELAX` -- so the smoothing tool is this same
 * function with the displacement skipped and that pass turned up. It reaches
 * the same rings, falls off the same way, obeys the same bounds. What it does
 * NOT do is aim: where the pointer sits across the wall is ignored, because
 * there is nothing to aim AT. Only the height matters, which is why the ghost
 * circle is all the user needs to see.
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
  const smoothing = dab.tool === 'smooth'
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
    if (!smoothing) {
      const limit = from[i] + (dab.radius - from[i]) * shape
      // And the tool only ever works its own way, whatever the limit says.
      const aim = dab.tool === 'push' ? Math.min(limit, r) : Math.max(limit, r)

      worked[i] = clamp(r + (aim - r) * shape * strength, min, max)
      if (worked[i] !== r) moved = true
    }

    if (lo < 0) lo = i
    hi = i
  }

  // Nothing in reach: the tool is off the piece, or off the end of it.
  if (lo < 0) return clay
  // Nothing moved: no strength behind it, or a tool aimed the way it does not
  // work. Not even the relax below runs -- a push held wide of the wall must be
  // as inert as a push held off the piece entirely. Smoothing displaces nothing
  // by definition, so it is not asked this question; whether IT moved anything
  // is a question only the relax can answer, and it is asked below.
  if (!moved && !smoothing) return clay

  // Then the relax, over the same window and weighted by the same falloff, so
  // it fades out where the dab does and the wall beyond the brush stays
  // untouched. Read from `worked`, written to `wall`: a pass that read its own
  // output would smear the first ring's correction along the whole window.
  //
  // For the smoothing tool this pass IS the tool, and it is turned up to match.
  const give = smoothing ? SMOOTH : RELAX
  const wall = worked.slice()
  for (let i = lo; i <= hi; i += 1) {
    // Mirrored at the ends rather than clamped to zero: the base ring and the
    // rim ring have one neighbour each, and pretending the missing one sits on
    // the axis would draw both ends of every piece inward.
    const before = worked[i === 0 ? 0 : i - 1]
    const after = worked[i === CLAY_RINGS - 1 ? CLAY_RINGS - 1 : i + 1]
    const gap = Math.abs(ringHeight(clay, i) - dab.y)
    const shape = falloff(Math.max(0, 1 - gap / reach)) * strength * give
    wall[i] = clamp(worked[i] + ((before + after) / 2 - worked[i]) * shape, min, max)
  }

  // A smoothing tool held against a wall that is already smooth -- a fresh
  // cylinder, or a curve it has already finished -- has done nothing, and must
  // hand back the very lump it was given rather than an equal one. The other
  // two tools answered this above; this is the same promise, asked after the
  // fact because for them the answer is known before the relax and for this one
  // it is not.
  if (smoothing && wall.every((r, i) => r === clay.wall[i])) return clay

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
  // Spread rather than listed out, so the section rides along: a piece resized
  // is the same piece at another size, and it does not turn round on the way.
  return { ...clay, height, radius, wall }
}

/** A wall thickness this screen can actually leave: in range, and a number. */
export function clampWall(thickness: number): number {
  if (!Number.isFinite(thickness)) return DEFAULT_CLAY_WALL
  return clamp(thickness, CLAY_WALL_MIN, CLAY_WALL_MAX)
}

/**
 * The outer wall's radius at any height, not just at a ring.
 *
 * The bore is sampled on a grid of its OWN -- it starts and stops at exact
 * heights the outer rings know nothing about, because a floor is `thickness`
 * off the faceplate and that lands between rings. So it has to be able to ask
 * the wall a question at any height, and this is that question. Straight
 * between rings, which is exactly what the drawing and the sweep both do with
 * them. See `silhouette`.
 */
export function wallAt(clay: Clay, height: number): number {
  const t = clamp(height / (clay.height || 1), 0, 1) * (CLAY_RINGS - 1)
  const i = Math.floor(t)
  if (i >= CLAY_RINGS - 1) return clay.wall[CLAY_RINGS - 1]
  return clay.wall[i] + (clay.wall[i + 1] - clay.wall[i]) * (t - i)
}

/**
 * How many samples the cavity's own profile is remembered at.
 *
 * The same count the outer wall uses, for the same reason and with none of the
 * same constraints: the bore is recomputed from scratch whenever anything
 * changes, so this is a drawing resolution rather than a memory. Matching the
 * wall means a hollow piece's inside is described as finely as its outside,
 * which is what stops a smooth outer curve reading as a faceted inner one.
 */
export const BORE_SAMPLES = CLAY_RINGS

/**
 * The cavity inside a hollowed piece: where it starts and stops, how wide it is
 * all the way up, and which ends it comes out of.
 *
 * ONE CAVITY, NOT SEVERAL. A wall offset inward can be interrupted -- pinch a
 * vase's neck below twice the wall thickness and the inside is two pockets with
 * solid clay between them -- and this returns the ONE that matters rather than
 * a list. Which one is decided the way a person with a drill would decide it:
 *
 *   - An open top means boring from the top, so the cavity is the run that
 *     reaches the rim, however far down it gets before the neck closes.
 *   - Failing that, an open bottom means boring from underneath.
 *   - With both ends capped there is no opening to bore from, so the cavity is
 *     simply the biggest pocket the wall leaves.
 *
 * That rule is worth stating because the alternatives are worse in a way that
 * shows up immediately: "the widest run" would hollow a goblet's FOOT and leave
 * the cup solid, since a foot is wider than a bowl on a stem.
 *
 * OPEN IS NOT THE SAME AS UNCAPPED. An end is open only if the user asked for
 * it AND the cavity actually reaches that end. Ask for a pipe and pinch the
 * middle shut and you get a blind hole, which is what would come off a real
 * lathe -- and `openTop` / `openBottom` say so, so the panel can tell you.
 *
 * Null when there is nothing to bore: no hollow asked for, a wall thicker than
 * the piece, or a lump too short to hold a floor and a lid.
 */
export type Bore = {
  /** The cavity's floor and ceiling, in scene units off the faceplate. */
  lo: number
  hi: number
  /** Whether material really is missing at each end of the piece. */
  openBottom: boolean
  openTop: boolean
  /** One radius per sample, evenly spread from `lo` to `hi`, ends included. */
  wall: number[]
}

export function bore(clay: Clay): Bore | null {
  const hollow = clay.hollow
  if (hollow === null) return null
  const thickness = clampWall(hollow.thickness)

  // The window the caps leave. A floor and a lid on a lump shorter than the two
  // of them together is a solid lump, and says so by handing back nothing.
  const lo = hollow.capBottom ? thickness : 0
  const hi = clay.height - (hollow.capTop ? thickness : 0)
  if (hi - lo < BORE_MIN) return null

  // The widest the cavity may be at each sample: the wall, less its thickness.
  // Anything under `BORE_MIN` is pinched shut, and marked so by a zero.
  const span = hi - lo
  const radii = new Array<number>(BORE_SAMPLES)
  for (let i = 0; i < BORE_SAMPLES; i += 1) {
    const y = lo + (i / (BORE_SAMPLES - 1)) * span
    const r = wallAt(clay, y) - thickness
    radii[i] = r >= BORE_MIN ? r : 0
  }

  // Every unbroken run of open samples, as index pairs.
  const runs: [number, number][] = []
  let start = -1
  for (let i = 0; i < BORE_SAMPLES; i += 1) {
    if (radii[i] > 0 && start < 0) start = i
    if (radii[i] <= 0 && start >= 0) {
      runs.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0) runs.push([start, BORE_SAMPLES - 1])
  if (runs.length === 0) return null

  const last = BORE_SAMPLES - 1
  const fromTop = !hollow.capTop ? runs.find((run) => run[1] === last) : undefined
  const fromBottom = !hollow.capBottom ? runs.find((run) => run[0] === 0) : undefined
  const widest = runs.reduce((best, run) => {
    const reach = (r: [number, number]) => Math.max(...radii.slice(r[0], r[1] + 1))
    return reach(run) > reach(best) ? run : best
  })
  const [from, to] = fromTop ?? fromBottom ?? widest

  // Resampled onto the chosen run's own span, so the cavity is described at the
  // same resolution however short it turns out to be. The ends are pulled in to
  // where the wall actually closes rather than left at the last open sample --
  // a floor half a millimetre thick between the last sample and the pinch is a
  // sliver no sweep should have to carry.
  const runLo = lo + (from / last) * span
  const runHi = lo + (to / last) * span
  const runSpan = runHi - runLo
  const wall = new Array<number>(BORE_SAMPLES)
  for (let i = 0; i < BORE_SAMPLES; i += 1) {
    const y = runLo + (i / (BORE_SAMPLES - 1)) * (runSpan || 0)
    wall[i] = Math.max(BORE_MIN, wallAt(clay, y) - thickness)
  }

  return {
    lo: runLo,
    hi: runHi,
    openBottom: !hollow.capBottom && from === 0,
    openTop: !hollow.capTop && to === last,
    wall,
  }
}

/**
 * A SHAPE THE LATHE CAN START FROM: a handful of control points up the piece.
 *
 * Why a table of profiles exists at all. Every piece on this screen begins as
 * the same cylinder, and the first two minutes of every sitting are spent
 * turning that cylinder into roughly the KIND of thing the person came to make
 * -- a bowl is wide and shallow, a vase has a belly and a neck, a goblet has a
 * stem. None of that is the interesting part of the work, and all of it is the
 * part that is hardest with two tools and no reference: getting a stem thin
 * enough without pinching it off is a minute of careful pushing before the
 * shaping proper starts.
 *
 * IN MULTIPLES OF THE STOCK RADIUS rather than in scene units, so a profile is
 * a shape rather than a size: loaded onto a thumbnail-sized lump it makes a
 * thumbnail-sized goblet, and the stock fields go on meaning what they meant.
 * Every value here lives inside `CLAY_PINCH`..`CLAY_FLARE`, which is what the
 * wall may be worked to -- a profile that could not have been reached with the
 * tools would be the app offering a shape it then refuses to let you edit.
 *
 * FEW POINTS, FAIRED ON THE WAY IN. Six or seven pairs describe any of these,
 * and the run between two of them is straight -- so `profileWall` relaxes the
 * sampled row before handing it over, which turns the corners into the curves
 * the numbers were meant to describe. Writing 96 radii per profile by hand
 * would be the same shape and nobody could tune it.
 */
export type ClayProfile = {
  id: string
  label: string
  /** `[height up the piece 0..1, radius as a multiple of the stock]`, bottom
   *  first. The first point must sit at 0 and the last at 1. */
  points: [number, number][]
}

export const CLAY_PROFILES: ClayProfile[] = [
  // The stock itself, and it earns its place: it is the way back to a straight
  // wall without throwing the stock away, and the tile that shows what all the
  // others are a departure FROM.
  { id: 'cylinder', label: 'Cylinder', points: [[0, 1], [1, 1]] },
  { id: 'bowl', label: 'Bowl', points: [[0, 0.55], [0.25, 1.1], [0.6, 1.5], [1, 1.65]] },
  {
    id: 'vase',
    label: 'Vase',
    points: [[0, 0.7], [0.15, 1.15], [0.38, 1.4], [0.7, 0.72], [0.88, 0.55], [1, 0.78]],
  },
  {
    id: 'goblet',
    label: 'Goblet',
    points: [[0, 1.2], [0.08, 1.1], [0.16, 0.28], [0.42, 0.24], [0.6, 0.85], [1, 1.25]],
  },
  { id: 'cone', label: 'Cone', points: [[0, 1.55], [1, 0.12]] },
  { id: 'barrel', label: 'Barrel', points: [[0, 0.85], [0.5, 1.35], [1, 0.85]] },
  { id: 'spool', label: 'Spool', points: [[0, 1.3], [0.2, 1.25], [0.5, 0.5], [0.8, 1.25], [1, 1.3]] },
  { id: 'dome', label: 'Dome', points: [[0, 1.25], [0.45, 1.15], [0.8, 0.8], [1, 0.18]] },
]

/**
 * How many fairing passes a loaded profile gets.
 *
 * Enough to take the corners out of six straight runs and not so many that a
 * goblet's stem is smoothed back into a cone. Each pass is the same Laplacian
 * step `mold` relaxes with, run over the whole wall rather than under a tool.
 */
const PROFILE_FAIRING = 24

/** The radius a profile asks for at height fraction `t`, before fairing. */
function sampleProfile(profile: ClayProfile, t: number): number {
  const points = profile.points
  for (let i = 1; i < points.length; i += 1) {
    const [t1, r1] = points[i]
    if (t > t1 && i < points.length - 1) continue
    const [t0, r0] = points[i - 1]
    const span = t1 - t0
    // Two points at the same height would be a step in the profile, which this
    // model cannot hold -- one radius per height. Take the upper one.
    const k = span <= 0 ? 1 : clamp((t - t0) / span, 0, 1)
    return r0 + (r1 - r0) * k
  }
  return points[0][1]
}

/**
 * A profile, as a wall for this lump: sampled at every ring, faired, and
 * bounded by what the stock allows.
 *
 * Pure and taking the clay rather than reading a store, so `engine-check` can
 * load a vase and measure it. The bounds are the same ones every tool obeys, so
 * a profile lands somewhere the tools can carry on from rather than somewhere
 * only the palette can reach.
 */
export function profileWall(clay: Clay, profile: ClayProfile): number[] {
  const { min, max } = wallBounds(clay.radius)
  const wall = new Array<number>(CLAY_RINGS)
  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const t = i / (CLAY_RINGS - 1)
    wall[i] = clamp(sampleProfile(profile, t) * clay.radius, min, max)
  }

  // The fairing. Ends held rather than mirrored: the base and the rim are where
  // the profile SAYS they are -- a foot is meant to be flat and a rim is meant
  // to be where it is -- and a mirrored end pass walks both of them inward a
  // little more with every pass.
  for (let pass = 0; pass < PROFILE_FAIRING; pass += 1) {
    const from = wall.slice()
    for (let i = 1; i < CLAY_RINGS - 1; i += 1) {
      wall[i] = clamp((from[i - 1] + from[i] * 2 + from[i + 1]) / 4, min, max)
    }
  }
  return wall
}

/**
 * Put a wall back on a lump: the same stock, the same base, another shape.
 *
 * WHAT UNDO IS MADE OF, and what a profile is loaded with. Both are the same
 * act from here -- a row of radii arriving from somewhere other than a tool --
 * and both have to survive the lump having changed since the row was written:
 * an undo entry taken before the stock was narrowed describes a wall past the
 * flare limit of the lump it is being put back on. So every ring is re-clamped
 * on the way in, exactly as `resize` re-clamps on the way through, and a short
 * or missing row falls back to the stock radius rather than to a hole.
 *
 * The lump is handed back unchanged when the wall it already has is the wall
 * being given to it, so a redo of a stroke that moved nothing cannot make React
 * redraw. Same promise as `mold`.
 */
export function withWall(clay: Clay, wall: number[]): Clay {
  const { min, max } = wallBounds(clay.radius)
  const next = new Array<number>(CLAY_RINGS)
  let same = true
  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const r = Number.isFinite(wall[i]) ? wall[i] : clay.radius
    next[i] = clamp(r, min, max)
    if (next[i] !== clay.wall[i]) same = false
  }
  return same ? clay : { ...clay, wall: next }
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
