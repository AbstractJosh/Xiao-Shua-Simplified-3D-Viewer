/**
 * HOW MUCH OF THE WALL IS WORTH SWEEPING: the ninety-six rings a piece is
 * remembered as, thinned down to the ones that actually say something, with the
 * corners among them marked as corners.
 *
 * The lathe keeps a piece as a fixed row of radii -- `CLAY_RINGS` of them,
 * whatever shape has been turned -- and that is exactly right for the SCREEN.
 * A brush has to have somewhere to put a millimetre of clay, an undo entry has
 * to be a whole wall, and a fixed row is what lets the height change without
 * resampling anything. See `CLAY_RINGS`.
 *
 * It is exactly wrong for the MESH. A cone is two numbers and a cylinder is
 * one, and swept ring by ring both of them arrived in the scene as 12,288
 * triangles -- the same count as every other piece, because the count had
 * nothing to do with the shape. That is the whole of the complaint this module
 * answers: the sweep was paying for the RESOLUTION THE CLAY IS STORED AT rather
 * than for the shape stored in it.
 *
 * SO THE MERIDIAN IS FITTED TO THE PROFILE, not to the array. A run of rings
 * that lies on a straight line collapses to its two ends and loses nothing at
 * all; a curve keeps as many as it takes to stay within `PROFILE_TOLERANCE` of
 * where the wall really stands. Nothing here is an approximation the user can
 * see -- the tolerance is a tenth of a millimetre on a piece measured in
 * centimetres, finer than the sweep's own facets are -- and everything it drops
 * was a band of triangles describing a straight line with a straight line.
 *
 * AND THE CORNERS SURVIVE IT, which is the other half. Point Sculpt with `Fit
 * to line` off states the wall in straight segments, and a step or a chamfer
 * drawn that way used to arrive shaded round: the sweep read every ring's
 * normal from a central difference, so the ring AT the corner faced half way
 * between the wall below it and the shoulder above, and the corner the tool
 * exists to make was the one thing the mesh would not show. A ring that turns
 * more than `CREASE_TURN` is handed back TWICE here -- see `Meridian.seams` --
 * which is the standard way to spell a hard edge and costs two rings rather
 * than the thirty a rounded corner was being approximated by.
 *
 * THREE-FREE, like `clay.ts` and for the same reason: it is arithmetic on a
 * polyline, the check suite runs it without a renderer, and `revolve.ts` is the
 * one file on this screen that is allowed to import three.
 */

/**
 * How far the swept meridian may stand from the wall it was thinned out of, in
 * scene units.
 *
 * A tenth of a millimetre. The pieces this screen makes are 15 cm tall and 8
 * across, so this is a part in fifteen hundred of the piece and about half a
 * pixel of the lathe's own window -- under what the drawing it is copied from
 * can show. It is also the SAME tolerance the sweep is built to going round
 * (see `roundFacets`), which is the property worth having: a piece is no
 * coarser up the meridian than it is round the axis, so there is no direction
 * you can turn it in and find the cheap side.
 *
 * MEASURED PERPENDICULAR to the chord being tested rather than as a difference
 * in radius, which is what makes it mean the same thing on a flat top as on a
 * straight wall. A radius test would drop the whole of a horizontal shoulder --
 * every ring on it has the same radius as the chord's ends -- and leave the
 * piece with a hole where its top was.
 */
export const PROFILE_TOLERANCE = 0.001

/**
 * How sharply the profile has to turn at a ring before that ring is a CORNER
 * rather than a bend.
 *
 * Thirty degrees, and the gap either side of it is what makes the number safe.
 * What must crease: a square shoulder turns ninety, a chamfer meeting a
 * straight wall forty-five, the step Point Sculpt is for a right angle. What
 * must not: a curve thinned to `PROFILE_TOLERANCE` turns by a few degrees at
 * each ring it kept -- about six on a piece of this size -- because that is
 * what staying within the tolerance means. Even a hard little round-over, a
 * two-millimetre fillet, comes out at twenty-five and stays smooth.
 *
 * So there is a factor of four of clear air on the side that matters and a
 * factor of two on the other, and no ordinary shape sits near the line. A
 * threshold set to catch every corner exactly would be one that creased a
 * curve, which is the worse failure: a rounded step still reads as a step, and
 * a faceted dome reads as a bug.
 */
export const CREASE_TURN = Math.PI / 6

/**
 * How many facets go round a ROUND piece at most, and the count every piece was
 * swept with before there was arithmetic to pick one.
 *
 * Sixty-four is where a turned piece stops looking faceted at any size this
 * screen can make, so it is the ceiling rather than the answer: see
 * `roundFacets`, which spends it only on the pieces wide enough to need it.
 *
 * A POLYGONAL piece ignores it and sweeps its own side count instead, which is
 * worth seeing plainly: a round piece was never a curve here either. It has
 * always been an inscribed polygon, so picking a hexagon does not switch on a
 * second kind of geometry. It turns the same dial down to six and stops
 * pretending the facets are not there.
 */
export const TURN_FACETS = 64

/**
 * The fewest facets a round piece is ever swept with, and the step the count
 * moves in.
 *
 * MULTIPLES OF EIGHT, so every count keeps a column on each of the four
 * cardinal directions and every count is even -- which is what lets a piece be
 * decimated in half later without leaving a seam in an odd place. It also keeps
 * the whole dial to eight settings, so two pieces of nearly the same size are
 * swept the same way rather than one facet apart.
 *
 * The floor is where a cylinder still reads as round when it is brought right
 * up to the camera. In practice it almost never binds: a piece thin enough to
 * want fewer than sixteen facets is a couple of millimetres across, and the
 * tolerance has already asked for more than that.
 */
const FACET_STEP = 8
const FACET_MIN = 16

/**
 * The rings to sweep, and where the sweep must not join them up.
 *
 * `heights` and `radii` are the profile itself, and they are the same length.
 * `seams[i]` is true where NO band is built from ring `i` to ring `i + 1`,
 * which happens in exactly one case: the two are the same ring written twice,
 * standing back to back so each copy can take the slope of its own side. That
 * is a hard edge, and skipping the band between the copies is what keeps it
 * from also being a ring of triangles with no area in them.
 */
export type Meridian = {
  heights: number[]
  radii: number[]
  seams: boolean[]
}

/**
 * The rings the shape actually needs, corners marked.
 *
 * `heights` and `radii` come in the length the wall is stored at and go out at
 * whatever length the shape earns -- two for a cylinder or a cone, a couple of
 * dozen for a domed lid, and a pair at every corner.
 *
 * BOTH ENDS ARE ALWAYS KEPT, which the caller depends on: the foot and the
 * crown are where the caps go, and a sweep whose first ring had been thinned
 * away would cap the piece at the wrong height.
 */
export function meridian(
  heights: number[],
  radii: number[],
  tolerance: number = PROFILE_TOLERANCE
): Meridian {
  const out: Meridian = { heights: [], radii: [], seams: [] }
  const kept = thin(heights, radii, tolerance)

  for (let k = 0; k < kept.length; k += 1) {
    const i = kept[k]
    out.heights.push(heights[i])
    out.radii.push(radii[i])
    out.seams.push(false)

    // A corner: the same ring again, and no band between the two. The sweep
    // reads each ring's normal from the rings either side of it, so the first
    // copy sees only the segment below and the second only the segment above --
    // which is precisely the two one-sided normals a hard edge is made of, got
    // without the sweep having to know a corner is there.
    const before = kept[k - 1]
    const after = kept[k + 1]
    if (
      before !== undefined &&
      after !== undefined &&
      turn(heights, radii, before, i, after) > CREASE_TURN
    ) {
      out.seams[out.seams.length - 1] = true
      out.heights.push(heights[i])
      out.radii.push(radii[i])
      out.seams.push(false)
    }
  }

  return out
}

/**
 * How many facets to sweep a round piece of this size with.
 *
 * The same question the meridian answers, asked round the axis instead: how
 * coarse may the polygon be before it stands further than `tolerance` from the
 * circle it is inscribed in. An n-gon's deepest point is `r(1 - cos(pi/n))` in
 * from the circle, so the count falls straight out of it -- and asking one
 * question in two directions is what keeps a piece from being smooth one way
 * and blocky the other.
 *
 * IT SCALES WITH THE PIECE, which is the whole reason to compute it rather than
 * name it. A hundredth of a millimetre of error on a 4 cm bowl is the same
 * PICTURE as a hundredth on a 4 mm finial and a tenth of the triangles, so a
 * fixed count is always wrong somewhere: too coarse for the biggest piece the
 * stock allows, and several times too fine for a stem.
 */
export function roundFacets(radius: number, tolerance: number = PROFILE_TOLERANCE): number {
  // A piece with no width at all is a line, and every count sweeps it equally
  // badly. The floor is the honest answer rather than an infinity.
  if (!(radius > 0)) return FACET_MIN
  // Past a tolerance of twice the radius the polygon may pass through the axis
  // and the arithmetic below asks for the arc cosine of less than -1.
  const sag = Math.min(2, tolerance / radius)
  const needed = Math.PI / Math.acos(Math.max(-1, 1 - sag))
  const stepped = Math.ceil(needed / FACET_STEP) * FACET_STEP
  return Math.max(FACET_MIN, Math.min(TURN_FACETS, stepped))
}

/**
 * Which rings to keep: Douglas-Peucker over the profile, in the (height,
 * radius) plane the section is drawn in.
 *
 * The classic algorithm and the right one here, because it is the one that
 * spends rings where the shape is rather than evenly: it keeps whichever ring
 * stands furthest from the chord it is being described by, and stops asking as
 * soon as the whole run is within the tolerance. A straight wall of forty rings
 * costs two; a tight bead in the middle of that wall keeps every ring it needs
 * and no others.
 *
 * ITERATIVE rather than recursive -- a stack of spans instead of a call stack.
 * Ninety-six points would recurse safely, but the wall is not the only profile
 * that comes through here (a cavity does too, and a longer one may one day),
 * and a geometry routine that is fine until the input grows is a trap laid for
 * somebody else.
 */
function thin(heights: number[], radii: number[], tolerance: number): number[] {
  const count = heights.length
  if (count <= 2) return heights.map((_, i) => i)

  const keep = new Array<boolean>(count).fill(false)
  keep[0] = true
  keep[count - 1] = true

  const spans: [number, number][] = [[0, count - 1]]
  while (spans.length > 0) {
    const [lo, hi] = spans.pop() as [number, number]
    if (hi - lo < 2) continue

    const y0 = heights[lo]
    const r0 = radii[lo]
    const dy = heights[hi] - y0
    const dr = radii[hi] - r0
    const chord = Math.hypot(dy, dr)

    let worst = -1
    let at = -1
    for (let i = lo + 1; i < hi; i += 1) {
      const py = heights[i] - y0
      const pr = radii[i] - r0
      // Perpendicular distance to the chord -- or, where the chord has no
      // length because the run doubles back on itself, distance to the point
      // both ends sit at.
      const off = chord === 0 ? Math.hypot(py, pr) : Math.abs(py * dr - pr * dy) / chord
      if (off > worst) {
        worst = off
        at = i
      }
    }

    if (worst > tolerance) {
      keep[at] = true
      spans.push([lo, at], [at, hi])
    }
  }

  const kept: number[] = []
  for (let i = 0; i < count; i += 1) if (keep[i]) kept.push(i)
  return kept
}

/**
 * How far the profile turns at one ring: the angle between the segment arriving
 * at it and the segment leaving.
 *
 * Zero along a straight run, a right angle at a square shoulder. A segment of
 * no length has no direction to turn from, so it reads as straight rather than
 * as an answer made up out of two zeroes.
 */
function turn(heights: number[], radii: number[], a: number, b: number, c: number): number {
  const uy = heights[b] - heights[a]
  const ur = radii[b] - radii[a]
  const vy = heights[c] - heights[b]
  const vr = radii[c] - radii[b]
  const un = Math.hypot(uy, ur)
  const vn = Math.hypot(vy, vr)
  if (un === 0 || vn === 0) return 0
  const cos = (uy * vy + ur * vr) / (un * vn)
  return Math.acos(Math.min(1, Math.max(-1, cos)))
}
