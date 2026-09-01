import type { Pt } from './curve'
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
 * How far OUT of the stock the wall may be worked, as a fraction of the stock
 * radius. There is no matching fraction for how far in, and that is the point:
 * the floor is the axis.
 *
 * BOUNDED ON THE WAY OUT, because an unbounded wall breaks the one promise this
 * screen makes about the view: that what you are shaping stays on screen at the
 * size you can see it. The viewport frames the stock times `CLAY_FLARE` and
 * never re-frames -- a view that zoomed out as you pulled would move the piece
 * out from under the tool that was pulling it. Nothing of the sort is at risk
 * on the way IN. A wall worked toward the axis only ever gets smaller, and the
 * frame it is drawn in already holds it.
 *
 * THE FLOOR WAS A TWENTIETH OF THE STOCK, and the argument for it was that a
 * wall pinched to nothing is a piece cut in two, which one radius per height
 * cannot say -- so a pinch was left as a neck you could see. What that argument
 * missed is the far commoner thing it also forbade: a piece that CLOSES. A dome,
 * a finial, a rounded top, a spinning top, a teardrop -- every one of them is a
 * wall that reaches the axis and stops, and every one of them was a stub the
 * width of a pencil instead, because the last twentieth would not go. Turning a
 * round top is the most ordinary thing anyone does on a lathe, and it was the
 * one shape this screen could not make.
 *
 * So the floor is zero, and the pinched-in-two case is simply allowed: what
 * comes off it is two lobes meeting at a point, which is a solid of revolution
 * like any other and is what the same gesture would give you in clay. Note that
 * a ring AT the axis sweeps to a degenerate band -- see `sweepBand`, which
 * takes its normals from the profile's slope rather than from the triangles and
 * so hands back an apex with a real normal on it rather than a NaN.
 */
export const CLAY_FLARE = 1.9

/**
 * The radius under which a ring is not clay any more.
 *
 * THE TOOL CONVERGES ON THE AXIS RATHER THAN ARRIVING AT IT, and without this
 * that is a defect you can see. A push aimed at the axis takes a ring to within
 * a twentieth of a millimetre of nothing and stops, because the relax pass that
 * keeps the tool from creasing the wall lifts the middle of its dish by a
 * fraction of the neighbours either side -- see `RELAX`. What is left is a
 * radius of five hundredths of a millimetre, which is not material by any
 * measure this app uses, and which the viewport nonetheless draws as a line one
 * and a half pixels wide: run a tool up the axis and the top of the piece comes
 * off as a NEEDLE standing on the shoulder you meant to round.
 *
 * So a ring worked under a millimetre is snapped to nothing, and the piece is
 * drawn and swept from the rings that still have material on them. A millimetre
 * is the app's own floor everywhere else -- `CLAY_RADIUS_MIN`, `CLAY_WALL_MIN`
 * and the bore's own `BORE_MIN` are all it -- and a radius under it is a piece
 * two millimetres across, finer than anything this app claims to draw. The
 * cavity has always done exactly this and said so: "anything under `BORE_MIN`
 * is pinched shut, and marked so by a zero".
 *
 * IT IS THE TOOL'S RULE AND NOT THE MODEL'S. `mold` snaps; `resize` and
 * `withWall` do not. Scaling a piece down to a tenth would otherwise cut every
 * stem in it, and undo would put back a wall the clamp had quietly closed --
 * both of them the app deciding something the hand did not ask for.
 */
export const CLAY_CLOSED = MIN_DIMENSION

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
 * The floor is zero on every stock -- see `CLAY_FLARE` -- so a wall may be
 * worked all the way to the axis and a piece may close. It is still a bound
 * rather than nothing, and it is the one that matters most: a radius may not go
 * NEGATIVE, which would turn the section inside out and wind the sweep the
 * wrong way round.
 */
export function wallBounds(radius: number): { min: number; max: number } {
  return {
    min: 0,
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
 * The rings the piece is actually made of: where the material starts and where
 * it stops. Null when the wall has been turned away altogether.
 *
 * WHAT THIS IS FOR is the shape a lathe is most often used to make. Round the
 * top of a piece and the last stretch of the stock's height has no clay on it
 * at all -- the wall reached the axis somewhere below the rim, and everything
 * above that is air. The wall is one radius per height and the height is the
 * STOCK's, so the model has no way to be shorter; what it has instead is a run
 * of rings at nothing, and this is the function that reads them as air rather
 * than as a needle of clay standing on the dome.
 *
 * ONE CLOSED RING IS KEPT AT EACH END, which is the whole reason this returns a
 * span rather than a count. The surface has to run OUT to the axis: drawn from
 * the last ring with material, a domed top ends on a flat disc the width of that
 * ring, and the dome the hand made comes out with its tip sawn off. Drawn one
 * ring further, the outline closes on the axis and the piece ends in a point.
 * That ring is at nothing, so it adds no clay -- it is where the clay ran out.
 *
 * THE MIDDLE IS NOT ITS BUSINESS. A piece pinched through the waist has zeros
 * between two lobes, and both lobes are still the piece: this reads the OUTER
 * extent, and the section closes through the pinch on its own, at a point on
 * the axis, which is what a piece pinched in two looks like.
 */
export function pieceSpan(clay: Clay): { lo: number; hi: number } | null {
  let first = -1
  let last = -1
  for (let i = 0; i < CLAY_RINGS; i += 1) {
    if (clay.wall[i] > 0) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) return null
  return { lo: Math.max(0, first - 1), hi: Math.min(CLAY_RINGS - 1, last + 1) }
}

/**
 * How tall the piece IS, which on a lump with a rounded top is not how tall its
 * stock is.
 *
 * The readout's number, and it belongs there for the reason the width beside it
 * does: both are what the piece has BECOME, where the Stock panel's two fields
 * are what it was cut from. A readout that went on saying 15 cm after the top
 * three centimetres had been turned off would be reporting the one number on
 * this screen the user cannot check by looking.
 */
export function pieceHeight(clay: Clay): number {
  const span = pieceSpan(clay)
  if (span === null) return 0
  return ringHeight(clay, span.hi) - ringHeight(clay, span.lo)
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
  // AND WHAT HAS CLOSED IS GONE. Last, after the relax rather than before it,
  // because the relax is the thing that would otherwise lift a closed ring back
  // off the axis -- and a ring the tool has taken under a millimetre is not a
  // thin place in the wall, it is a place the wall has run out. See
  // `CLAY_CLOSED`, and `pieceSpan` for what the drawing and the sweep then do
  // with it.
  //
  // Over the tool's own window and nowhere else, like every other pass in here:
  // a ring the tool never reached is not the tool's to close, however thin the
  // stock or an earlier stroke left it.
  for (let i = lo; i <= hi; i += 1) if (wall[i] < CLAY_CLOSED) wall[i] = 0

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
 * Put a wall back on a lump: the same stock, the same base, another shape.
 *
 * WHAT UNDO IS MADE OF: a row of radii arriving from somewhere other than a
 * tool, which has to survive the lump having changed since the row was
 * written -- an undo entry taken before the stock was narrowed describes a
 * wall past the flare limit of the lump it is being put back on. So every ring
 * is re-clamped on the way in, exactly as `resize` re-clamps on the way
 * through, and a short or missing row falls back to the stock radius rather
 * than to a hole.
 *
 * The lump is handed back unchanged when the wall it already has is the wall
 * being given to it, so a redo of a stroke that moved nothing cannot make React
 * redraw. Same promise as `mold`.
 */
/**
 * How far off a crossing may be and still be one, as a share of a segment.
 *
 * A ring sitting exactly on the first or last point of a line is the ordinary
 * case rather than the edge case -- the span is measured FROM those points, so
 * both ends land on one -- and the parameter along the segment comes out at a
 * hair either side of 0 or 1 depending on which way the subtraction rounded.
 * Refusing those would leave the two rings the user aimed most carefully at
 * untouched.
 */
const CROSSING_EPS = 1e-9

/**
 * How far from the axis the line stands at one height: the OUTERMOST place it
 * crosses, or null where it does not reach.
 *
 * Outermost rather than first or nearest, and that is the whole answer to a
 * curve that doubles back. A wall is one radius per ring -- see `Clay.wall` --
 * so a line that loops has to be read as something single-valued, and the
 * honest reading is the material a real tool would leave: everything inside the
 * outermost pass has been turned away by it. It also cannot fail, which the
 * alternatives can -- "the first crossing" depends on which way the line was
 * drawn, and "reject a curve that doubles back" is a tool that refuses a
 * perfectly ordinary flick of the wrist.
 */
function outermostAt(line: Pt[], height: number): number | null {
  let out: number | null = null
  // THE DISTANCE FROM THE AXIS, whichever side of it the line was drawn on. A
  // wall is a row of radii and a radius has no sign; the drawing has one only
  // because the screen is a section and there are two walls on it to point at.
  // See `toClay` in `SculptLayer`, which keeps the side so a knot lands under
  // the pointer rather than across the piece from it.
  //
  // Interpolated BEFORE the sign is dropped, so a segment drawn across the axis
  // reads as the wall pinching to nothing and opening again rather than as a
  // jump between two radii -- which is what a tool run through the centre would
  // actually leave.
  const keep = (signed: number) => {
    const r = Math.abs(signed)
    if (out === null || r > out) out = r
  }
  for (let i = 1; i < line.length; i += 1) {
    const [y0, r0] = line[i - 1]
    const [y1, r1] = line[i]
    // A segment lying flat at this height crosses it everywhere along its
    // length, and the outermost of those is one of its two ends.
    if (y0 === y1) {
      if (y0 === height) {
        keep(r0)
        keep(r1)
      }
      continue
    }
    const t = (height - y0) / (y1 - y0)
    if (t < -CROSSING_EPS || t > 1 + CROSSING_EPS) continue
    keep(r0 + (r1 - r0) * Math.min(1, Math.max(0, t)))
  }
  return out
}

/**
 * The wall re-cut to a drawn line: Point Sculpt.
 *
 * THE ONE TOOL ON THIS SCREEN THAT IS NOT A BRUSH. Push, Pull and Smooth all
 * work by holding something against the wall and letting the clay come to it --
 * see `mold`, and `Dab` for what one instant of that is. This one states the
 * wall outright: the line drawn through the placed points IS the profile, at
 * every ring it covers.
 *
 * WHICH MEANS IT CAN SHARPEN, and it is the only thing here that can. Every dab
 * relaxes the window it moved, so a brush cannot leave a corner however hard it
 * is held -- see `RELAX`. A shoulder, a step, a hard chamfer are shapes this
 * screen simply could not make until now, and the way to make them is to put
 * two points down and let the line between them be exactly what it says. So
 * nothing here relaxes, and that is the feature rather than an omission.
 *
 * ONLY THE SPAN THE LINE COVERS, from its lowest point to its highest. The rest
 * of the wall is not touched, which is what lets a neck be re-cut without
 * losing the belly under it -- and it is also the reading that makes the tool
 * usable more than once on a piece. Both ends of the span are butted straight
 * on to the wall that was already there rather than blended into it: a step
 * where the line meets the old profile is a shape the user asked for by
 * stopping the line there, and a tool that quietly faired it away would be
 * refusing the one thing this tool is for.
 *
 * Clamped through `withWall` like every other wholesale write, so a line drawn
 * past the flare limit or through the axis lands on the piece the stock allows
 * rather than turning the section inside out.
 */
export function sculpt(clay: Clay, line: Pt[]): Clay {
  if (line.length < 2) return clay

  const drawn = onRings(clay, line)

  let lo = Infinity
  let hi = -Infinity
  for (const [height] of drawn) {
    if (height < lo) lo = height
    if (height > hi) hi = height
  }

  const wall = [...clay.wall]
  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const y = ringHeight(clay, i)
    if (y < lo || y > hi) continue
    const r = outermostAt(drawn, y)
    if (r !== null) wall[i] = r
  }
  return withWall(clay, wall)
}

/**
 * THE LINE WITH EVERY CORNER STOOD ON A RING, which is the whole of how this
 * tool leaves a corner rather than a facet where one was asked for.
 *
 * The wall is a fixed row of radii -- one per ring, at fractions of the height
 * (see `CLAY_RINGS`) -- so the only heights it can say ANYTHING at are the ring
 * heights. Sampling the drawn line at each of them, which is what this used to
 * do and nothing else, is exact along a straight run and loses precisely one
 * thing: the corner between two runs. A knot that falls BETWEEN two rings is
 * never visited. Both rings either side of it land short, both by about the
 * same amount -- and two neighbouring rings at nearly the same radius is not a
 * point, it is a FLAT. So a drawn V came out as a little vertical facet a
 * millimetre and a half tall, blunted by up to half a ring's rise times the
 * slope, and a zigzag of six corners came out with six chamfers on it.
 *
 * IT IS THE HEIGHT THAT GIVES, NOT THE RADIUS, and that is the trade this makes
 * deliberately. A corner has a height and a radius and the grid can hold only
 * one of them exactly; the old arrangement kept the height and lost the radius
 * AND the sharpness, which is the worst of the three outcomes. Moving the knot
 * to its nearest ring costs it under half a ring -- 0.8 mm on a 15 cm piece,
 * finer than the wall is stored at anywhere -- and buys the corner back
 * exactly: the ring lands ON the knot, the rings either side lie on the two
 * straight runs, and what the section draws is a single vertex.
 *
 * ONLY THE KNOTS MOVE. Every ring between two of them is still read off the
 * line by `outermostAt` in the ordinary way, and since both ends of every
 * segment now sit on the grid, every ring along it lies exactly on the segment.
 * A straight run stays straight, which is the other thing `Fit to line` off is
 * for.
 *
 * A KNOT OFF THE PIECE KEEPS THE SAME GRID rather than being clamped to the
 * rim. A profile is often aimed past the stock -- the wall may be pulled wider,
 * or the line run out above the lump to hold an angle -- and dragging that knot
 * down to the last ring would tilt the segment that reaches it, changing the
 * shape everywhere the segment crosses clay. The grid simply carries on past
 * both ends, where it costs nothing and keeps the arithmetic one rule.
 */
function onRings(clay: Clay, line: Pt[]): Pt[] {
  const last = CLAY_RINGS - 1
  const step = clay.height / last
  // A lump of no height has no rings to stand on, and the caller is about to
  // find that out anyway. Hand the line back rather than divide by zero.
  if (!(step > 0)) return line
  return line.map(([height, radius]): Pt => {
    const i = Math.round(height / step)
    // `ringHeight` rather than `i * step` where there is a ring, so the knot and
    // the ring are the same number to the bit and the interpolation at that
    // height is the knot's own radius rather than a float away from it.
    return [i >= 0 && i <= last ? ringHeight(clay, i) : i * step, radius]
  })
}

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
