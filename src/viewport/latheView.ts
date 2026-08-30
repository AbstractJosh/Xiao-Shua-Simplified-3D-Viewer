import { CLAY_RINGS, bore, flatFactor, ringHeight } from '../geometry/clay'
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
 * THE FRAME IS A RULED SQUARE, AND NOTHING ABOUT THE CLAY REACHES IT.
 *
 * This is the one decision the rest of the file hangs off, and `clayFrame` not
 * taking a `Clay` at all is the whole of how it is enforced: a frame that has
 * never been shown the lump cannot resize itself when the lump changes.
 *
 * It replaced two earlier answers, and they failed in the same place for
 * different reasons.
 *
 * FIRST, THE FRAME WAS CUT TO THE LUMP -- as tall as the piece plus a margin,
 * as wide as its flare limit plus a margin -- which sounds like exactly what a
 * viewport should do. But a frame cut to the stock is a frame whose ASPECT
 * changes with the stock, and `preserveAspectRatio="xMidYMid meet"` then
 * re-fits the entire drawing on every keystroke. Ask for a taller lump and the
 * frame grows taller, `meet` begins fitting by height rather than by width, and
 * everything in the picture -- the piece, the faceplate under it, the rings
 * across it -- is drawn NARROWER on screen. The lump never appeared to grow,
 * the plate under it shrank, and making a piece taller read as making it
 * thinner: the frame was cancelling out the very change it was being asked to
 * show.
 *
 * SECOND, THE FRAME WAS QUANTISED -- square, always `FRAME_RULES` rules on a
 * side, with only the length of a rule taken off the stock and rounded onto a
 * ladder, so the view held still over a whole band of sizes and stepped between
 * bands. That fixed the aspect, and it fixed the plate, and inside a band it
 * was right. It was the stepping that was wrong. A view that rescales itself
 * unasked is jarring however rarely it does it, and it does it at the worst
 * moment there is: mid-drag, while the hand is on the Height field and the eye
 * is on the piece.
 *
 * SO THE FRAME IS SIMPLY FIXED, and how far it is zoomed is the user's to say.
 * A lump too big for it runs off the top or the sides and is CLIPPED, which is
 * an honest thing for a viewport to do and a legible one -- a piece leaving the
 * frame says "too big for this zoom" far more plainly than a picture that
 * silently shrinks. Nothing on this screen re-frames on its own any more; see
 * `fitZoom` for the one that re-frames on being asked.
 *
 * What survives all three attempts is the reason for the square. Growth is only
 * legible against something that does not grow, so the plate, the rules and the
 * frame's edges hold still and the clay moves against them.
 */

/**
 * The frame at rest, in scene units, before any zoom.
 *
 * Two point four, which is twelve rules of two centimetres, and it is chosen so
 * the lump the screen opens on -- 15 cm tall, 8 cm across -- stands at a little
 * under two thirds of the frame's height. Not filling it, and that is the
 * point: the room above the piece is where growing INTO is done, so a lump
 * taken from 10 cm to 20 cm does the whole of that journey inside one still
 * frame. Fitted tight to the opening lump instead, the first thing the Height
 * field ever did would be to push the piece out of the top.
 */
const BASE_SPAN = 2.4

/**
 * How far the view may be zoomed, as a factor on `BASE_SPAN`.
 *
 * The range is set by the stock rather than by taste: a lump may be a
 * millimetre or five metres (see `CLAY_HEIGHT_MAX`), and a viewport that cannot
 * reach either end is a viewport with sizes of piece you cannot look at. Out to
 * a sixty-fourth shows a frame over 150 units across, which swallows the widest
 * stock this app will make; in to sixty-four brings the frame down to under
 * four millimetres, which is finer than the smallest lump.
 */
export const ZOOM_MIN = 1 / 64
export const ZOOM_MAX = 64

/**
 * The ladder a rule's length is picked off, per decade of scene units.
 *
 * Round lengths, because a rule IS a length: one scene unit is ten centimetres,
 * so these are 1, 2, 3, 5 and 7 centimetres, and every decade of that above and
 * below. The rings across the piece are that far apart IN THE WORLD, which is
 * what makes them worth drawing at all -- a mark every two centimetres up a pot
 * is a measure, and a mark at every tenth of the pot is just a mark.
 *
 * IT IS THE FRAME THAT IS ROUNDED ONTO IT, NOT THE STOCK, which is the whole
 * difference between this and the ladder that came before. The rungs are walked
 * only when the user zooms, so the piece can be made any size at all without
 * one being crossed -- and when one is crossed it is because a hand asked for
 * it, which is the difference between a scale re-spacing itself under a zoom
 * (what every map and every chart does) and a picture jumping on its own.
 *
 * THE CLASSIC 1-2-5 WITH A 3 PUT IN. The gaps decide how many rules land in a
 * frame, because the ideal spacing is rounded UP onto a rung: a gap of two
 * halves the count in the worst case, and 1-2-5's two-to-five gap would cut it
 * by two and a half -- five rules across a frame that was drawn with twelve a
 * moment earlier. With a 3 in the gap the frame always carries between six and
 * twelve of them, at every zoom there is.
 */
const RULE_LADDER = [1, 2, 3, 5, 7]

/**
 * How many rules the frame spans, and what the rules at the ends are spent on.
 *
 * Twelve across and twelve up, the bottom one holding the faceplate and the top
 * one left clear above the rim -- so a lump has ten rules to stand in and six
 * either side of the axis to spread into. Those two numbers are the frame's
 * proportions, and they are where they are because the lump the screen opens on
 * -- 15 cm tall, 8 cm across, at its flare limit -- comes out square in them:
 * ten rules of height and six of half-width ask for the same rule to within
 * half a percent. A frame shaped for tall pieces would waste its width on every
 * piece, and one shaped for wide pieces would push the tall ones off the top
 * sooner. Matched to the stock the screen opens on, neither axis is the one
 * that always runs out first.
 *
 * The bottom rule is a whole rule rather than a thin strip because the
 * faceplate is drawn in it and has to read as something the piece is standing
 * ON. The top one is there so a piece pulled to its full flare at the rim is
 * not drawn against the edge of the window, and so the tool's ghost circle has
 * somewhere to be while you aim at the top ring.
 *
 * None of this is a LIMIT on the clay. A lump taller than ten rules is drawn
 * taller than ten rules and clipped by the edge of the frame; these are the
 * proportions the view is laid out in, not a box the piece has to fit.
 */
const FRAME_RULES = 12
const PLATE_RULES = 1
const HEAD_RULES = 1
/** The rules a lump stands in when it is fitted to the frame. */
const BODY_RULES = FRAME_RULES - PLATE_RULES - HEAD_RULES

/**
 * How much air `fitZoom` leaves either side of the piece, as a fraction of its
 * width.
 *
 * Only fitting uses it. Nothing else on this screen has an opinion about how
 * wide the piece is any more -- that was the old frame's job, and it is what
 * made the drawing rescale itself when the wall was pulled out.
 */
const SIDE_MARGIN = 1.18

/** Ladder comparisons are made on numbers that came out of a division, and a
 *  zoom of exactly one lands on a rung, so the boundary cases have to survive
 *  the last bit of the mantissa falling the wrong way. */
const LADDER_SLACK = 1 - 1e-9

/**
 * The shortest rule on the ladder that is still at least `need` long.
 *
 * Walked by decade rather than tabulated, because the zoom range is four
 * thousand to one and the stock range wider still -- and a table would be the
 * ladder written out eight times over, with the reader left to check that every
 * copy agrees with every other.
 */
function ruleFor(need: number): number {
  // Not reachable through a clamped zoom, but a log of zero would take the whole
  // frame to NaN rather than fail where the mistake is.
  if (!(need > 0) || !Number.isFinite(need)) return RULE_LADDER[0]

  const decade = Math.pow(10, Math.floor(Math.log10(need)))
  for (const step of RULE_LADDER) {
    if (step * decade >= need * LADDER_SLACK) return step * decade
  }
  // Past the last rung is the first rung of the next decade.
  return RULE_LADDER[0] * decade * 10
}

/** Every zoom that reaches the frame goes through here, so no caller can hand it
 *  a NaN, a zero or a number off either end of the range. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom))
}

/**
 * The frame the lump is drawn in: an SVG viewBox in scene units, plus where the
 * faceplate sits inside it and how long a rule is.
 *
 * `base` is carried along rather than recomputed by each caller because it is
 * the origin everything on this screen is measured from -- the silhouette, the
 * ghost of the stock, the rings, the pointer -- and two callers disagreeing
 * about where the lathe is would draw a piece floating off its own lathe.
 *
 * `rule` is carried for that reason turned inside out: it is the only length on
 * this screen that HOLDS STILL, so everything drawn as furniture rather than as
 * clay -- the plate, the rings, the axis's overshoot -- is measured in it.
 * Anything measured in the clay's own height instead is back to resizing itself
 * every time the Height field is touched, which is the whole fault this frame
 * exists to fix.
 */
export type ClayFrame = {
  x: number
  y: number
  width: number
  height: number
  /** The y of the faceplate's surface, which is the clay's zero. */
  base: number
  /** How far apart the frame's rules are, in scene units. */
  rule: number
}

/**
 * The frame at a given zoom -- AND IT IS HANDED NO CLAY, which is the guarantee
 * rather than a convenience.
 *
 * Everything this screen has got wrong about its own view, it got wrong by
 * letting the lump into this function. A signature with no `Clay` in it is a
 * promise the type checker keeps: shaping the piece, retyping its height and
 * doubling its width all leave every number below exactly as it was, because
 * none of them is reachable from here.
 *
 * The plate sits at a fixed FRACTION of the frame rather than a fixed distance
 * up it, so zooming leaves it where it is on screen and opens room above it.
 * Which is the right anchor for a lathe: the piece stands on the plate, so the
 * plate is the thing that should not move when you go looking for the rim.
 */
export function clayFrame(zoom: number): ClayFrame {
  const side = BASE_SPAN / clampZoom(zoom)
  return {
    x: -side / 2,
    y: 0,
    width: side,
    height: side,
    base: (side * (FRAME_RULES - PLATE_RULES)) / FRAME_RULES,
    // Rounded onto the ladder so the rings stay a round measure at every zoom,
    // which costs the frame up to half its rules and is the reason the ladder
    // has a 3 in it. See `RULE_LADDER`.
    rule: ruleFor(side / FRAME_RULES),
  }
}

/**
 * The zoom that brings a piece into the frame: the one and only re-framing on
 * this screen, and it happens when somebody presses for it.
 *
 * Against the wall AS IT STANDS rather than against the flare limit the stock
 * allows, because this answers a question the user asked about the piece in
 * front of them -- a stem-thin piece fitted to the width it MIGHT be pulled out
 * to would be fitted to mostly empty frame. The cost is that a piece pulled out
 * after fitting can leave the frame again, which is a press away from being put
 * right and is the honest behaviour: fit is a verb, not a mode.
 */
export function fitZoom(clay: Clay): number {
  const widest = clay.wall.reduce((a, b) => Math.max(a, b), 0)
  const span = Math.max(
    // The piece standing in its body rules, plate and headroom left clear.
    (clay.height * FRAME_RULES) / BODY_RULES,
    // And across: the frame is the full span, so it is the piece's full width
    // that has to sit in it.
    widest * 2 * SIDE_MARGIN
  )
  if (!(span > 0) || !Number.isFinite(span)) return 1
  return clampZoom(BASE_SPAN / span)
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
 *
 * `factor` scales every radius on the way out, and it exists for exactly one
 * caller: `flatsProfile`. One function rather than two, because the flats line
 * has to be the SAME CURVE as the wall -- drawn from the same rings, closed the
 * same way, rounded the same -- or the two would part company the first time
 * either was touched, and a reference line that disagrees with the thing it
 * refers to is worse than no line.
 */
export function silhouette(clay: Clay, frame: ClayFrame, factor = 1): string {
  const right: string[] = []
  const left: string[] = []

  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const y = round(clayY(frame, ringHeight(clay, i)))
    const r = round(clay.wall[i] * factor)
    right.push(`${r} ${y}`)
    // Built back to front as we go, so the return leg needs no second pass.
    left.unshift(`${-r} ${y}`)
  }

  return `M ${right.join(' L ')} L ${left.join(' L ')} Z`
}

/**
 * Where the FLATS of a polygonal piece run, or null on a round one.
 *
 * THE ONE THING THIS VIEW CANNOT OTHERWISE SAY. A hexagonal piece and a round
 * one have the same profile -- that is the whole reason the base shape costs
 * this screen nothing -- so a selector that changed the drawing not at all
 * would be a control the user has to take on trust until the piece reaches the
 * clipboard. The wall the tools work is the line the CORNERS follow; the flats
 * between them are cut in by `flatFactor`, and drawing that second line puts
 * the section on screen: two lines close together is a decagon, two lines far
 * apart is a triangle, one line is a circle.
 *
 * Null rather than a line lying on the silhouette when the piece is round --
 * the same rule the stock ghost follows in `isFresh`. A reference drawn exactly
 * on top of the edge it refers to reads as a rendering fault.
 */
export function flatsProfile(clay: Clay, frame: ClayFrame): string | null {
  if (clay.sides === null) return null
  return silhouette(clay, frame, flatFactor(clay.sides))
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
 * The turning rings: faint lines across the body at the frame's own rules, each
 * as wide as the wall it crosses.
 *
 * The one piece of decoration on this screen, and it earns its place three
 * times over. It is what a turned piece LOOKS like -- the spiral a hand leaves
 * as the lathe turns under it -- so it says "clay" where a flat grey shape would
 * say "rectangle". It is the only thing in the drawing that reports the wall's
 * shape from the INSIDE: a silhouette outlines a piece, and a stack of rings
 * that narrow and widen shows you the curve you are actually making.
 *
 * And -- the reason they sit where they sit -- THEY ARE THE SCALE. One every
 * rule, at absolute heights up the piece, so how many there are is a fact about
 * how tall the lump IS rather than about how tall it is being drawn. Spread
 * evenly over the piece instead, which is how they started, they were eleven
 * marks on every lump ever turned: a lump twice as tall got eleven rings twice
 * as far apart and looked identical to the one before it. Between that and a
 * frame that rescaled itself to match, the screen had no way left to say that
 * anything had changed. Pinned to the rule, growing the lump reveals more of
 * them, and that is the whole of how this screen shows a piece getting bigger.
 *
 * Taken from the wall itself rather than drawn at a fixed width, so they follow
 * every push and pull without being told about it, and inset a little at each
 * end so they read as marks on a surface rather than as the surface's edge.
 */
export function turningRings(clay: Clay, frame: ClayFrame): { y: number; r: number }[] {
  const rings: { y: number; r: number }[] = []
  // TWO CEILINGS, and the piece may now be stopped by either. The lump runs out
  // of rings at its own rim; the FRAME runs out of them at its top edge, because
  // a lump taller than the view is clipped there and rings drawn past it are
  // rings drawn on nothing. `FRAME_RULES` bounds the loop whichever bites first,
  // and it is a belt as well: this is a loop over one length divided by another,
  // and it must not be the thing that hangs the frame the day either arrives
  // wrong.
  const ceiling = Math.min(clay.height, frame.base)
  for (let n = 1; n <= FRAME_RULES; n += 1) {
    const height = n * frame.rule
    // Never ON the rim, and never on the plate: a ring lying along either is a
    // line drawn on top of the piece's own edge.
    if (!(height < ceiling)) break
    const i = Math.min(
      CLAY_RINGS - 1,
      Math.round((height / clay.height) * (CLAY_RINGS - 1))
    )
    rings.push({ y: round(clayY(frame, height)), r: round(clay.wall[i] * 0.78) })
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

/**
 * THE PIECE AS A SECTION: the outline of the material, cavity and all.
 *
 * A hollow piece is the one thing on this screen where the drawing has to stop
 * being a silhouette and become a proper sectional view -- and that is not a
 * complication, it is what this screen already was. The whole viewport is a cut
 * through something round: the axis is a centre line, both walls are the same
 * wall mirrored, and every drawing convention here is a draughtsman's. A bore
 * is simply the first feature that the cut can show and the outline cannot.
 *
 * WHAT IS DRAWN IS THE BOUNDARY OF THE CLAY, every segment of it real. That
 * rules out the easy version -- fill the outline, then fill the cavity in the
 * background colour -- which paints a lie wherever the cavity meets air: the
 * mouth of a cup would be closed by a line across it. So the path is built from
 * whichever loops the material actually has, and there are three shapes it can
 * take:
 *
 *   BOTH ENDS CLOSED -- a sealed void. Two loops: the piece, and the cavity
 *   inside it as a hole. Every segment of both is clay against air.
 *
 *   ONE END OPEN -- a cup, or the same cup upside down. ONE loop, which walks
 *   up the outside, steps in across the rim, down the inside, across the floor,
 *   up the far inside, out across the far rim and down the far outside. The
 *   opening is where the loop steps between the two walls, and nothing is drawn
 *   across it because nothing is there.
 *
 *   BOTH ENDS OPEN -- a pipe. Two loops again, but side by side rather than one
 *   inside the other: a pipe cut down its axis is two bands of wall with a gap
 *   between them, which is exactly what the section of a pipe looks like.
 *
 * Filled EVEN-ODD, which is what makes the first case a hole rather than a
 * second solid. The other two have no nested loops, so the rule costs them
 * nothing and one rule serves all three.
 */
export function sectionPath(clay: Clay, frame: ClayFrame): string {
  const cavity = bore(clay)
  // No cavity, no section: the silhouette IS the boundary, and it stays the one
  // function that draws it.
  if (cavity === null) return silhouette(clay, frame)

  const at = (r: number, y: number) => `${round(r)} ${round(clayY(frame, y))}`
  const boreY = (i: number) =>
    cavity.lo + ((cavity.hi - cavity.lo) * i) / (cavity.wall.length - 1)

  // The four walls, each bottom-to-top: the piece's own, and the cavity's, on
  // each side of the axis. Built once and walked in whichever order the case
  // below needs.
  const outer: string[] = []
  const outerLeft: string[] = []
  for (let i = 0; i < CLAY_RINGS; i += 1) {
    outer.push(at(clay.wall[i], ringHeight(clay, i)))
    outerLeft.push(at(-clay.wall[i], ringHeight(clay, i)))
  }
  const inner: string[] = []
  const innerLeft: string[] = []
  for (let i = 0; i < cavity.wall.length; i += 1) {
    inner.push(at(cavity.wall[i], boreY(i)))
    innerLeft.push(at(-cavity.wall[i], boreY(i)))
  }

  const down = (points: string[]) => [...points].reverse()

  // A pipe: two bands, one either side, each closed across its own two ends.
  if (cavity.openTop && cavity.openBottom) {
    const right = `M ${outer.join(' L ')} L ${down(inner).join(' L ')} Z`
    const left = `M ${outerLeft.join(' L ')} L ${down(innerLeft).join(' L ')} Z`
    return `${right} ${left}`
  }

  // A cup: up the outside, in across the rim, down the inside, across the floor
  // and back up the other side. The step at the rim is the opening.
  if (cavity.openTop) {
    return (
      `M ${outer.join(' L ')} L ${down(inner).join(' L ')}` +
      ` L ${innerLeft.join(' L ')} L ${down(outerLeft).join(' L ')} Z`
    )
  }

  // The same, upside down: open underneath, closed at the rim. Up the outside,
  // over the lid, down the far outside, in across the far end, up the inside of
  // the cavity, over its ceiling and back down.
  if (cavity.openBottom) {
    return (
      `M ${outer.join(' L ')} L ${down(outerLeft).join(' L ')}` +
      ` L ${innerLeft.join(' L ')} L ${down(inner).join(' L ')} Z`
    )
  }

  // Sealed: the piece, and a hole in it.
  const body = `M ${outer.join(' L ')} L ${down(outerLeft).join(' L ')} Z`
  const hole = `M ${inner.join(' L ')} L ${down(innerLeft).join(' L ')} Z`
  return `${body} ${hole}`
}
