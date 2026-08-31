import {
  CLAY_CLOSED,
  CLAY_RINGS,
  bore,
  pieceSpan,
  ringHeight,
  wallAt,
  widestRadius,
} from '../geometry/clay'
import type { Bore, Clay } from '../geometry/clay'

/**
 * Measuring the piece on the lathe: where a ruler is laid down, and what its
 * ends catch on the way to being placed.
 *
 * Pure arithmetic in a file of its own, the bargain `pointSnap.ts` already
 * strikes for the laser cutter's knots and for the same reason: a snap that
 * fires half a millimetre early still looks exactly like a snap, and nobody
 * finds out it was wrong by looking at the screen -- they find out when the
 * number they wrote down was not the number the piece has. Numbers in, numbers
 * out, and `interaction-check` can hold every one of them to account without a
 * DOM, a canvas or a store.
 *
 * IN THE CLAY'S OWN TERMS throughout, which is the space `pointerToClay` hands
 * back and the only one this screen has: `x` is the SIGNED distance from the
 * axis, so the left of the drawing is negative, and `y` is the height off the
 * faceplate. Neither depends on the zoom, so a ruler laid down at one zoom is
 * the same ruler at another; `clayY` in `latheView.ts` is the only thing that
 * turns either into something to draw.
 *
 * WHY THE MODELLING SCREEN'S RULER COULD NOT SIMPLY BE MOUNTED HERE. That one
 * is two points in a room, dragged by a gizmo through a raycaster, and every
 * one of those three things is missing on this screen -- there is no camera, no
 * scene graph and nothing to cast a ray at. What ports is the IDEA: two ends, a
 * line, and the reading at the middle of it. What is written fresh is
 * everything below.
 */

/**
 * One end of a ruler: how far from the axis, and how high off the plate.
 *
 * A tuple rather than `{x, y}`, matching `Ruler.ends` on the modelling screen,
 * so the end being dragged is an index the gesture can carry and the store can
 * write back without a branch per end.
 */
export type LatheEnd = [number, number]

/**
 * A measurement laid across the section: two ends, and the distance between
 * them.
 *
 * Its own type and its own list rather than the modelling screen's `Ruler`,
 * because the two measure different things in different spaces -- three
 * coordinates in a room against two on a section -- and a shared list would be
 * a list every reader had to ask which screen it belonged to before trusting.
 */
export type LatheRuler = { id: string; ends: [LatheEnd, LatheEnd] }

/** Which end of a ruler. See `LatheRuler.ends`. */
export type LatheRulerEnd = 0 | 1

/**
 * How near an end has to come to something worth catching, in PIXELS on screen.
 *
 * PIXELS RATHER THAN A LENGTH IN THE WORLD, which is the same call
 * `pointSnap.ts` makes and for a sharper version of the same reason. This
 * screen zooms four thousand to one -- see `ZOOM_MIN` and `ZOOM_MAX` -- so a
 * tolerance of two millimetres is a third of the frame at one end of that range
 * and invisible at the other. A snap is a thing a HAND does, and how close a
 * hand can get is a fact about the screen it is working on.
 *
 * Ten, the laser cutter's number, and deliberately the same: they are the same
 * gesture measured the same way, and two different answers to "how near is
 * near, in pixels" would be two numbers to learn for no reason. They stay
 * separate FIELDS all the same -- see `latheSnapDistance` -- because a user who
 * wants a loose reach on one screen has said nothing about the other.
 */
export const DEFAULT_LATHE_SNAP = 10

/** The range the panel offers, the laser cutter's for the reason above: two
 *  pixels is a snap that is nearly off, and forty is a third of an inch of
 *  screen, past which an end cannot be put down anywhere near an edge without
 *  being swallowed by it. */
export const LATHE_SNAP_MIN = 2
export const LATHE_SNAP_MAX = 40

/**
 * Where consecutive rulers are laid down, as fractions of the piece's height.
 *
 * EACH ONE GOES IN THE BIGGEST GAP LEFT, which is what the halving order says:
 * the middle, then the quarters, then the eighths. Spawning them all at one
 * height would make the second look like it never appeared -- it would be
 * hidden, exactly, by the first -- and stepping them by a fixed distance would
 * walk the fourth one off a short piece entirely. Fractions of the piece keep
 * every lane on the clay whatever size the clay is.
 *
 * None of them is 0 or 1: those are the rim and the plate, where a ruler would
 * lie exactly along an edge and read as part of the drawing rather than as a
 * measurement of it. It is the same rule `flatsProfile` and the stock ghost
 * both follow.
 */
export const LATHE_RULER_LANES = [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875]

/**
 * Where a fresh ruler lands: straight across the piece, at the lane's height,
 * with an end on each wall.
 *
 * SO IT ARRIVES MEASURING SOMETHING. A ruler that spawned in mid-air would ask
 * the user to place both ends before it said anything at all; laid across the
 * section it reads the diameter there the instant it appears, which is the
 * commonest thing anyone wants a ruler on a lathe for and is also a
 * demonstration of the snap -- both ends are exactly on the wall, because that
 * is where this puts them.
 *
 * Pure, and taking the clay rather than reaching for it, so the tool store can
 * lay a ruler down without importing a second store and `interaction-check` can
 * state the rule rather than transcribe one result of it. It is the same split
 * `rulerSpawn` and `rulerFrame` make on the modelling screen: the arithmetic
 * here, the reading of what is on screen at the call site.
 */
export function latheRulerSpawn(lane: number, clay: Clay): [LatheEnd, LatheEnd] {
  const span = pieceSpan(clay)
  // A wall turned away to nothing has no piece to lay a ruler across, so the
  // stock is measured instead -- which is the only thing left on the screen.
  const lo = span === null ? 0 : ringHeight(clay, span.lo)
  const hi = span === null ? clay.height : ringHeight(clay, span.hi)

  const y = lo + (hi - lo) * LATHE_RULER_LANES[lane % LATHE_RULER_LANES.length]
  const wall = wallAt(clay, y)
  // A ruler of no length has no direction to be drawn along and no ends to take
  // hold of. Where the wall has closed -- through the waist of a pinched piece,
  // or anywhere on a lump turned away -- it falls back to the stock, which is
  // always wider than nothing.
  const half = wall > CLAY_CLOSED ? wall : clay.radius

  return [
    [-half, y],
    [half, y],
  ]
}

/** What a ruler reads: the straight-line distance between its two ends. */
export function latheRulerLength(ruler: LatheRuler): number {
  const [a, b] = ruler.ends
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/**
 * Where an end landed, and which lines it took on the way.
 *
 * `onX` and `onY` are the VALUES caught rather than booleans, because the
 * viewport draws a guide along each of them while the drag is live -- the same
 * thing `Aligned` carries for the laser cutter's knots, and for the same
 * reason: a snap that fires silently is a snap the user has to verify by
 * reading the number, which is the one thing they were hoping not to have to do.
 */
export type LatheSnap = { at: LatheEnd; onX: number | null; onY: number | null }

/** The cavity's radius at a height, straight between the samples it is
 *  remembered at -- the inner wall's answer to `wallAt`. Zero outside the
 *  cavity, and zero wherever the bore is pinched shut, which `bore` already
 *  marks with a zero of its own. */
function boreAt(cavity: Bore, y: number): number {
  if (y < cavity.lo || y > cavity.hi) return 0
  const span = cavity.hi - cavity.lo
  if (!(span > 0)) return 0
  const t = ((y - cavity.lo) / span) * (cavity.wall.length - 1)
  const i = Math.floor(t)
  if (i >= cavity.wall.length - 1) return cavity.wall[cavity.wall.length - 1]
  return cavity.wall[i] + (cavity.wall[i + 1] - cavity.wall[i]) * (t - i)
}

/** The nearest candidate within reach, or null. NEAREST RATHER THAN FIRST, or
 *  the answer would depend on the order the targets happen to be listed in and
 *  dragging past one edge could leave you caught on a further one. Ties go to
 *  the earlier, which is why the list below is written most-wanted first. */
function nearest(want: number, targets: number[], tol: number): number | null {
  let best: number | null = null
  let gap = Infinity
  for (const target of targets) {
    const d = Math.abs(target - want)
    if (d <= tol && d < gap) {
      gap = d
      best = target
    }
  }
  return best
}

/**
 * The heights on the piece worth catching, most-wanted first.
 *
 * Lifted out of the snap below because TWO gestures want this same list and
 * they must not drift apart: an end dragged on its own takes its height from
 * it, and so does a whole ruler slid up the piece. A ruler that clicked onto
 * the widest ring when it was dragged by an end and sailed straight past it
 * when it was pushed by the middle would be two tools sharing one set of knobs.
 *
 * Handed the span and the cavity rather than reading them off the clay, because
 * both callers have already asked for them and `bore` walks the wall three
 * times over to answer.
 */
function pieceHeights(
  clay: Clay,
  span: { lo: number; hi: number } | null,
  cavity: Bore | null
): number[] {
  // The faceplate, which is the clay's zero whether or not any material reaches
  // it -- it is what "off the base" is measured from.
  const heights = [0]
  if (span !== null) {
    heights.push(ringHeight(clay, span.lo), ringHeight(clay, span.hi))
    // Where the piece is widest, which is a height as well as a width.
    let peak = span.lo
    for (let i = span.lo; i <= span.hi; i += 1) {
      if (clay.wall[i] > clay.wall[peak]) peak = i
    }
    heights.push(ringHeight(clay, peak))
  }
  if (cavity !== null) heights.push(cavity.lo, cavity.hi)
  return heights
}

/**
 * Pull an end onto the edges of the piece, onto its centre line, and into line
 * with the end it is tied to.
 *
 * TWO AXES, DECIDED SEPARATELY, which is the design rather than an
 * implementation: it is what `pointSnap` does for the laser cutter's knots, and
 * it is what makes every measurement anyone actually wants off a lathe fall out
 * of one rule. An end can take its HEIGHT from the rim and its WIDTH from the
 * wall and land on the corner the two of them imply. A single nearest-POINT
 * snap could never give that.
 *
 * THE HEIGHT IS SETTLED FIRST, and the order is not interchangeable. The wall
 * is one radius per height -- that is the whole model of the piece -- so "on
 * the wall" is not a question that can be asked until the height has an answer.
 * Settled the other way round, an end dragged toward the rim would snap to the
 * wall as it stands a millimetre BELOW the rim, and then be lifted to the rim
 * off the edge it had just been put on.
 *
 * WHAT IT CATCHES, and why each is worth catching:
 *
 *   THE WALL, at whatever height the end has settled at, on the side it is
 *   already on. This is "the edge": the outline of the section really is
 *   `x = ±wallAt(y)`, so an end pulled here is exactly on the material rather
 *   than near it, and a ruler with both ends on it reads a true diameter.
 *
 *   THE CAVITY WALL, likewise, on a hollow piece -- which is the only way to
 *   measure how thick a wall has actually been left.
 *
 *   THE AXIS, at x = 0. This is "the centre": an end on it makes the ruler
 *   read a RADIUS rather than a diameter, and it is where every height
 *   measurement wants to be taken.
 *
 *   THE RIM AND THE PLATE, the two heights the piece ends at, plus the height
 *   of its widest ring and the two ends of the cavity. These are the numbers
 *   the corner readout already shows, so a ruler dropped across them agrees
 *   with it exactly instead of coming out a hair under.
 *
 *   THE WIDEST RADIUS, as a line of its own at either side, so a neck can be
 *   measured against the bulge it stands inside without hunting for the height
 *   the bulge happens to be at.
 *
 *   THE OTHER END'S OWN ROW AND COLUMN, which is what makes a ruler go
 *   perfectly level or perfectly upright. Only ONE of the two is ever offered
 *   -- whichever axis the pair is already more nearly aligned on -- because an
 *   end that took both would be sitting on top of the end it is measuring
 *   from, and a ruler of no length is the one arrangement this tool has no use
 *   for.
 *
 * `tol` is a length in the clay's own units. The caller converts it from the
 * pixels the user set, because only the caller knows how big the drawing
 * currently is on glass; see `LatheRulers`.
 */
export function snapLatheEnd(
  at: LatheEnd,
  other: LatheEnd,
  clay: Clay,
  tol: number
): LatheSnap {
  // Off is not a mode inside the arithmetic: no reach catches nothing, which is
  // what lets the switch in the bar simply hand this a zero.
  if (!(tol > 0)) return { at, onX: null, onY: null }

  const [wantX, wantY] = at
  const span = pieceSpan(clay)
  const cavity = bore(clay)
  const widest = widestRadius(clay)

  // Which way the pair is more nearly lined up already, and so which of the two
  // ortho locks is on offer. See the note above about a ruler of no length.
  const dx = Math.abs(wantX - other[0])
  const dy = Math.abs(wantY - other[1])

  // --- the height ---------------------------------------------------------
  const heights: number[] = []
  // Upright first, so a ruler that is already nearly level stays level through
  // a drag that passes near something else.
  if (dy < dx) heights.push(other[1])
  heights.push(...pieceHeights(clay, span, cavity))

  const onY = nearest(wantY, heights, tol)
  const y = onY ?? wantY

  // --- the width, at that height -----------------------------------------
  const widths: number[] = []
  if (dx <= dy) widths.push(other[0])
  // The centre line. Always on offer: it is where the piece turns, and it is
  // there to be measured from whether or not there is clay at this height.
  widths.push(0)
  // The wall, on the side the end is already on. Only where the piece actually
  // reaches: `wallAt` clamps to the end rings, so above the rim it would go on
  // reporting a phantom edge in the air above the piece.
  if (span !== null && y >= ringHeight(clay, span.lo) && y <= ringHeight(clay, span.hi)) {
    const wall = wallAt(clay, y)
    if (wall > CLAY_CLOSED) widths.push(Math.sign(wantX || 1) * wall)
  }
  if (cavity !== null) {
    const inner = boreAt(cavity, y)
    if (inner > 0) widths.push(Math.sign(wantX || 1) * inner)
  }
  if (widest > CLAY_CLOSED) widths.push(Math.sign(wantX || 1) * widest)

  const onX = nearest(wantX, widths, tol)

  return { at: [onX ?? wantX, y], onX, onY }
}

/**
 * SLIDING THE WHOLE RULER, which is the second thing a hand does with one.
 *
 * A ruler laid level across the piece with an end on each wall reads the
 * diameter THERE, and the question that follows it is always the same one: and
 * there? and there? Answering it by dragging one end and then the other is two
 * gestures for one measurement, and both of them have to come out exactly right
 * or the ruler leaves the level and stops reading a diameter at all. Taken by
 * the middle instead, it keeps its level for nothing and the ends walk the
 * curve on their own -- which is what a pair of calipers run up a turned piece
 * actually does.
 *
 * THE ENDS FOLLOW THE LINES THEY WERE ALREADY ON, and that is the whole rule.
 * On a solid lump both are on the outer wall, so the ruler reads the diameter
 * all the way up. On a hollow one an end put on the CAVITY wall stays on the
 * cavity wall: a ruler laid from the outside in goes on reading the thickness
 * that is left at every height it is pushed to, and one laid across the bore
 * goes on reading the bore. Nothing in the gesture says which -- it is read off
 * where the ends are standing at the moment the middle is taken hold of.
 *
 * ONLY WHILE IT IS LEVEL AND BOTH ENDS ARE ON SOMETHING. A ruler lying across a
 * diagonal has no one height to be moved to, and an end standing in mid-air has
 * no line to follow: there is no honest answer to where it should go, and
 * inventing one -- keep its width? drop it on the nearest edge? -- would move a
 * measurement the user placed by hand. Where the rule does not hold there is no
 * handle in the middle of the ruler at all, and a press there goes to the clay,
 * which is what a press anywhere else on this screen does.
 */

/**
 * Which line of the drawing an end is standing on, and so which one it rides.
 *
 * The three things `snapLatheEnd` can put an end ON, and deliberately no fourth
 * for "in mid-air": an end that is on nothing has nothing to follow.
 */
export type LatheHold = 'wall' | 'bore' | 'axis'

/**
 * What a slide needs to know about a ruler, worked out once as it is taken hold
 * of: which line each end rides, which side of the axis it rides it on, and how
 * far up and down the piece the pair of them may go.
 *
 * SETTLED AT THE PRESS AND CARRIED, rather than asked again every frame, and
 * the reason is the same one that makes the ends follow anything at all: what a
 * ruler is measuring is decided by where its ends were when the hand arrived.
 * Re-read mid-drag it would be decided by where they have got to, and a ruler
 * whose ends met the cavity on the way up would change from measuring a wall to
 * measuring a bore halfway through the gesture that was reading it.
 */
export type LatheRide = {
  /** What each end is standing on, in the ruler's own end order. */
  holds: [LatheHold, LatheHold]
  /** The sign each end keeps: -1 for the left of the drawing, +1 for the right.
   *  A section is symmetrical, so nothing but the sign says which wall of it an
   *  end belongs to, and an end that changed sides mid-slide would have jumped
   *  the whole width of the piece. */
  sides: [number, number]
  /** The heights the ruler may be slid between, ends included. */
  lo: number
  hi: number
}

/**
 * How far off a line an end may be and still count as standing on it.
 *
 * A LENGTH IN THE CLAY rather than the snap's reach in pixels, which is the one
 * place in this file that goes the other way from `DEFAULT_LATHE_SNAP`, and on
 * purpose. The reach answers "did the hand mean to put it here", a question
 * about a gesture in flight. This answers "is the ruler on the edge", a question
 * about a drawing standing still -- and it has to have the same answer at every
 * zoom, or the middle of a ruler would become a handle by leaning in and stop
 * being one by leaning back out.
 *
 * `CLAY_CLOSED` is the app's own smallest dimension: an end this near a line was
 * put there by the snap or by the spawn, and one further off than the thinnest
 * thing this app will make is somewhere else on purpose.
 */
const ON_LINE = CLAY_CLOSED

/**
 * How level is level: floating-point slack, not a tolerance.
 *
 * The ortho lock writes the other end's height across EXACTLY -- see
 * `snapLatheEnd` -- and so does a slide, so a ruler that is level is level to
 * the last bit. A ruler that merely looks level was placed by hand with the snap
 * down, and lifting it onto the level to hand it a slide would change the
 * reading it is showing without being asked to.
 */
const LEVEL = 1e-9

/**
 * How far a ruler riding the outer wall may be pushed from the height it is at:
 * the run of the section that has a wall to ride, and not a hair further.
 *
 * NOT SIMPLY THE PIECE'S SPAN, which reaches one ring PAST the material at each
 * end -- `pieceSpan` keeps a closed ring there deliberately, so the surface runs
 * out to the axis and a domed top ends in a point rather than on a disc. Slid
 * onto that ring, a ruler's two ends would meet on the centre line: a reading of
 * zero, true about the tip of the dome, useless as a measurement, and awkward to
 * get back from with both knobs in the same place.
 *
 * A PINCHED WAIST STOPS IT TOO, for that reason and a second one behind it. The
 * wall really does close there, so a ruler pushed through would cross a height
 * at which there is nothing to measure on its way to the far lobe.
 *
 * Between rings the wall is a straight line -- that is exactly what `wallAt`
 * says -- so where it crosses is arithmetic rather than a search.
 */
function wallRun(clay: Clay, y: number): { lo: number; hi: number } | null {
  if (!(wallAt(clay, y) > CLAY_CLOSED)) return null
  const step = clay.height / (CLAY_RINGS - 1)
  if (!(step > 0)) return null
  const here = Math.max(0, Math.min(CLAY_RINGS - 1, Math.floor(y / step)))

  // Up, to the first ring that has closed, and back down to where the wall
  // crossed between it and the open one below it.
  let hi = clay.height
  for (let i = here + 1; i < CLAY_RINGS; i += 1) {
    if (clay.wall[i] > CLAY_CLOSED) continue
    const open = clay.wall[i - 1]
    hi = (i - 1 + (open - CLAY_CLOSED) / (open - clay.wall[i])) * step
    break
  }

  // And down. `here` is the ring at or below the height, and the wall is open
  // there or the guard above would have turned this away.
  let lo = 0
  for (let i = here; i >= 0; i -= 1) {
    if (clay.wall[i] > CLAY_CLOSED) continue
    const open = clay.wall[i + 1]
    lo = (i + 1 - (open - CLAY_CLOSED) / (open - clay.wall[i])) * step
    break
  }

  return { lo, hi }
}

/** Which line an end is standing on, or null for one standing in the air.
 *  NEAREST WINS, ties to the earlier, which is the rule `nearest` follows a few
 *  lines up: a wall thin enough to have both its faces inside `ON_LINE` of one
 *  point is a wall that thin, and the end takes the face it is actually nearer. */
function holdOf(
  x: number,
  y: number,
  clay: Clay,
  span: { lo: number; hi: number } | null,
  cavity: Bore | null
): LatheHold | null {
  const r = Math.abs(x)
  let best: LatheHold | null = null
  let gap = Infinity

  // The outer wall, only where the piece actually reaches -- the same guard
  // `snapLatheEnd` puts on it, and for the same reason: above the rim `wallAt`
  // goes on reporting the rim's own radius into thin air.
  if (span !== null && y >= ringHeight(clay, span.lo) && y <= ringHeight(clay, span.hi)) {
    const wall = wallAt(clay, y)
    const d = Math.abs(r - wall)
    if (wall > CLAY_CLOSED && d <= ON_LINE && d < gap) {
      gap = d
      best = 'wall'
    }
  }

  // The cavity wall, on a hollow piece and inside the cavity's own span.
  if (cavity !== null && y >= cavity.lo && y <= cavity.hi) {
    const inner = boreAt(cavity, y)
    const d = Math.abs(r - inner)
    if (inner > 0 && d <= ON_LINE && d < gap) {
      gap = d
      best = 'bore'
    }
  }

  // The centre line, which is at every height there is: an end on the axis
  // stays on the axis wherever the ruler is pushed, and a ruler with one there
  // goes on reading a radius rather than a width.
  if (r <= ON_LINE && r < gap) {
    gap = r
    best = 'axis'
  }

  return best
}

/** Where a line stands at a height. A missing surface can only be asked for at
 *  the ends of the travel, which `latheRulerRide` has already ruled out; nothing
 *  is the honest answer if one ever gets through. */
function radiusOn(
  hold: LatheHold,
  clay: Clay,
  span: { lo: number; hi: number } | null,
  cavity: Bore | null,
  y: number
): number {
  if (hold === 'wall') return span === null ? 0 : wallAt(clay, y)
  if (hold === 'bore') return cavity === null ? 0 : boreAt(cavity, y)
  return 0
}

/**
 * What the ends of a ruler are standing on -- or null, meaning this is not a
 * ruler that can be slid.
 *
 * The whole of the precondition, in one place and pure, so the viewport can ask
 * one question twice for two purposes and get one answer: is there a handle in
 * the middle of this ruler to DRAW, and is there one to TAKE HOLD OF. Two rules
 * would be two chances for a band that catches presses to sit somewhere no band
 * was ever drawn.
 */
export function latheRulerRide(ruler: LatheRuler, clay: Clay): LatheRide | null {
  const [a, b] = ruler.ends
  // Level, or there is no one height for the pair to be moved to.
  if (Math.abs(a[1] - b[1]) > LEVEL) return null
  const y = a[1]

  const span = pieceSpan(clay)
  const cavity = bore(clay)

  const holds: LatheHold[] = []
  const sides: number[] = []
  // The stock's own extent, which every ride is inside. An end on the axis
  // constrains nothing -- the centre line runs the height of the drawing -- and
  // a ruler still may not be pushed off the top of the piece it is measuring.
  let lo = 0
  let hi = clay.height

  for (const end of [a, b]) {
    const hold = holdOf(end[0], y, clay, span, cavity)
    if (hold === null) return null
    holds.push(hold)
    // Zero counts as the right-hand side, arbitrarily and harmlessly: an end on
    // the axis is at nothing whichever way its sign points.
    sides.push(end[0] < 0 ? -1 : 1)

    if (hold === 'wall') {
      const run = wallRun(clay, y)
      if (run === null) return null
      lo = Math.max(lo, run.lo)
      hi = Math.min(hi, run.hi)
    }
    if (hold === 'bore') {
      if (cavity === null) return null
      lo = Math.max(lo, cavity.lo)
      hi = Math.min(hi, cavity.hi)
    }
  }

  // A ruler whose ends ride the same line on the same side is a ruler whose
  // ends are in the same place: it reads nothing now and would go on reading
  // nothing wherever it was pushed. Both on the axis is the case that turns up
  // -- the centre line is one line and it has no sides.
  if (holds[0] === holds[1] && (holds[0] === 'axis' || sides[0] === sides[1])) return null

  // No travel is no gesture, and a handle that cannot move is worse than none:
  // it takes the press that would otherwise have reached the clay.
  if (!(hi > lo)) return null

  return { holds: [holds[0], holds[1]], sides: [sides[0], sides[1]], lo, hi }
}

/**
 * Slide a ruler to a new height, both ends keeping the line they came in on.
 *
 * THE HEIGHT IS THE ONLY THING THE HAND DECIDES. The widths are the piece's to
 * say -- that is what following the curve means -- so this takes one number, and
 * the sideways half of the drag is dropped on the floor rather than allowed to
 * skew a level ruler by a pixel over the length of a gesture.
 *
 * IT CATCHES THE SAME HEIGHTS AN END DOES, out of `pieceHeights`, so the rim,
 * the plate, the widest ring and the ends of the cavity are as findable by
 * pushing the middle as by dragging an end -- and the widest ring is the one
 * this gesture is really for, being the answer to "how fat is the belly" and
 * otherwise a height nobody can point at. Only those inside the travel are
 * offered: one beyond it would be caught, then clamped away, and the guide would
 * draw a line the ruler is not on.
 *
 * `tol` is a length in the clay, converted from the user's pixels by the caller
 * exactly as `snapLatheEnd` takes it -- and as there, no reach means no catch.
 */
export function latheRulerSlide(
  ride: LatheRide,
  clay: Clay,
  want: number,
  tol: number
): { ends: [LatheEnd, LatheEnd]; onY: number | null } {
  const span = pieceSpan(clay)
  const cavity = bore(clay)

  const heights = pieceHeights(clay, span, cavity).filter((h) => h >= ride.lo && h <= ride.hi)
  const onY = tol > 0 ? nearest(want, heights, tol) : null
  const y = Math.min(ride.hi, Math.max(ride.lo, onY ?? want))

  const end = (i: 0 | 1): LatheEnd => [
    ride.sides[i] * radiusOn(ride.holds[i], clay, span, cavity, y),
    y,
  ]

  return { ends: [end(0), end(1)], onY }
}
