import { KERF } from './laserCut'
import type { FaceAxis, Pt } from './laserCut'

/**
 * THE MIRROR STANDING ON THE FACE: what it divides the face into, what it does
 * to a line drawn in one of those parts, and where a point lands on the other
 * side of it.
 *
 * Pure arithmetic in a file of its own, the bargain `pointSnap.ts` and
 * `latheRuler.ts` already strike on this screen and for the same reason: a
 * mirror that is a degree out still looks exactly like a mirror, and nobody
 * finds that out by looking at the screen -- they find it out when the two
 * halves of the finished piece do not meet. Numbers in, numbers out, and
 * `engine-check` can hold every one of them to account without a canvas.
 *
 * IN THE FACE'S OWN (u, v) throughout, which is the space the draft is already
 * kept in -- see `cutDraft` -- so nothing here knows which face is up, how big
 * the stock is or where the camera stands. The axis is anchored at the middle
 * of the face, which is the ORIGIN of that space, and that is why no anchor is
 * stored: a mirror that could be dragged off centre would be one where the two
 * halves of the block are no longer the two halves of the block.
 *
 * ONE LINE IN AND SEVERAL OUT is the shape of the whole file. What the user
 * draws is one line in one part; what gets burned is that line clipped to the
 * part they picked and then reflected into the others -- two lines for a mirror
 * and four for a cross, all fired in one act. See `mirrorLines`, which is the
 * function both the preview and Apply go through so that the two cannot
 * disagree about what is about to happen, exactly as `draftLine` is for the
 * drawing itself.
 */

/** A single mirror line, or two of them crossed at a right angle. */
export type MirrorMode = 'line' | 'cross'

/**
 * The mirror standing on one face.
 *
 * THE ANGLE IS IN DEGREES, which is the one place this file disagrees with
 * every other piece of geometry in the app. It is a number the user aims by
 * hand, reads off a panel and types back in, and the detents it holds at are
 * every 45 -- all three of those are degrees to the person doing them, and a
 * store holding radians would be one where the panel, the snap and the readout
 * each converted on their own. The conversion happens once, here, in
 * `axisFrame`.
 *
 * `part` is which of the regions the axis cuts the face into is being worked
 * in: 0 or 1 for a mirror, 0 to 3 for a cross. AN INDEX IN THE AXIS'S OWN
 * FRAME rather than a region of the face, which is what makes turning the
 * mirror carry the picked part around with it instead of leaving the lit
 * quadrant behind.
 */
export type MirrorAxis = {
  mode: MirrorMode
  angle: number
  part: number
}

/**
 * The angles the line holds at: every 45 degrees, so the eight stops are the
 * two squares, the two diagonals and their opposites.
 *
 * FIXED, with the panel's number saying how near you have to come rather than
 * where the stops are -- see `mirrorSnapAngle` in the tool store. Square and
 * diagonal are what symmetry is nearly always about, and a mirror that could be
 * detented every 7 degrees would be one where you could no longer feel which of
 * the stops you were on.
 */
export const DETENT = 45

/** How many parts an axis of each kind cuts the face into. */
export const partsIn = (mode: MirrorMode): number => (mode === 'line' ? 2 : 4)

/**
 * Which face a mirror belongs to, as something a table can be keyed by.
 *
 * The six faces are the whole of it, so a pair of numbers squashed into a
 * string is enough -- and it is written here, next to everything that reads a
 * mirror, rather than in each of the three files that need to look one up.
 */
export const faceKey = (face: FaceAxis): string =>
  `${face.axis}${face.sign > 0 ? '+' : '-'}`

/**
 * The mirror a face gets when one is first stood on it: a single line, upright,
 * and the part on the left of it.
 *
 * UPRIGHT BECAUSE LEFT AND RIGHT IS WHAT SYMMETRY USUALLY MEANS -- a bracket, a
 * handle, a face plate -- and it is the one orientation a person pictures when
 * they reach for a mirror without having thought about the angle yet. It is
 * also a detent, so the first swing of the line has somewhere obvious to come
 * back to.
 */
export const FRESH_MIRROR: MirrorAxis = { mode: 'line', angle: 90, part: 0 }

/**
 * How near the line may be asked to hold to a stop: none of the way, up to half
 * the gap between two of them.
 *
 * The top is 22.5 rather than a rounder number because that is where the eight
 * catchments meet: past it they would overlap, and an angle between two stops
 * would be one no hand could reach. See `snapAxisAngle`.
 */
export const MIRROR_SNAP_MIN = 0
export const MIRROR_SNAP_MAX = DETENT / 2
export const DEFAULT_MIRROR_SNAP = 8

/**
 * The axis's own two directions: along the line, and across it.
 *
 * Everything else in the file works in the frame these two span, because in it
 * the mirror is nothing but a sign flip -- reflecting across the line is
 * negating the across-component, and the four parts of a cross are the four
 * combinations of two signs. The alternative is a reflection matrix written out
 * per call, which is the same arithmetic with the meaning buried in it.
 */
export function axisFrame(angle: number): { along: Pt; across: Pt } {
  const r = (angle * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { along: [c, s], across: [-s, c] }
}

/** A face point, in the axis's own frame. */
export function toAxis(at: Pt, frame: { along: Pt; across: Pt }): Pt {
  return [
    at[0] * frame.along[0] + at[1] * frame.along[1],
    at[0] * frame.across[0] + at[1] * frame.across[1],
  ]
}

/** And back out of it. */
export function fromAxis(q: Pt, frame: { along: Pt; across: Pt }): Pt {
  return [
    q[0] * frame.along[0] + q[1] * frame.across[0],
    q[0] * frame.along[1] + q[1] * frame.across[1],
  ]
}

/**
 * Which way the picked part lies, as a sign on each of the axis's directions.
 *
 * The along-sign is 0 for a plain mirror, which is the whole difference between
 * the two modes said in one number: a mirror constrains one direction and
 * leaves the other alone, a cross constrains both. Every clip, every test and
 * every polygon below reads the part through this rather than branching on the
 * mode, so there is no route by which a quadrant and a half disagree about what
 * "inside" means.
 *
 * Parts run anticlockwise from the first quadrant, which is the order they are
 * stepped in and the order they read in on screen.
 */
export function partSigns(axis: MirrorAxis): { along: number; across: number } {
  if (axis.mode === 'line') return { along: 0, across: axis.part === 1 ? -1 : 1 }
  const quadrant = ((axis.part % 4) + 4) % 4
  return {
    along: quadrant === 1 || quadrant === 2 ? -1 : 1,
    across: quadrant === 2 || quadrant === 3 ? -1 : 1,
  }
}

/** Which part of the face a point falls in. What a click on the face means. */
export function partOf(at: Pt, axis: MirrorAxis): number {
  const q = toAxis(at, axisFrame(axis.angle))
  if (axis.mode === 'line') return q[1] >= 0 ? 0 : 1
  if (q[0] >= 0) return q[1] >= 0 ? 0 : 3
  return q[1] >= 0 ? 1 : 2
}

/**
 * How far inside its part a point is, in each of the axis's directions.
 *
 * Negative outside, and that is what every clip below tests. A direction the
 * part does not constrain -- the along of a plain mirror -- reports a point as
 * deeply inside rather than as anything to clip against.
 */
function depth(at: Pt, axis: MirrorAxis, frame: { along: Pt; across: Pt }): [number, number] {
  const q = toAxis(at, frame)
  const s = partSigns(axis)
  return [s.along === 0 ? 1 : q[0] * s.along, q[1] * s.across]
}

/**
 * Cut a drawn line down to the runs of it that lie inside the picked part.
 *
 * SEVERAL RUNS, NOT ONE, because a line is free to wander out of the part and
 * back in again -- a stroke that loops over the axis twice leaves two pieces
 * behind, and keeping only the first would be the tool quietly throwing away
 * something the user drew. Each survives as its own line and each is mirrored
 * on its own.
 *
 * THE CROSSING POINT IS KEPT, on both sides of the boundary, which is what
 * makes the mirror meet: a run ending exactly on the axis and its reflection
 * beginning exactly on the axis are one continuous cut across it, where a run
 * that stopped a hair short would leave a thread of material holding the two
 * halves together.
 */
export function clipToPart(line: Pt[], axis: MirrorAxis): Pt[][] {
  if (line.length < 2) return []
  const frame = axisFrame(axis.angle)
  let runs: Pt[][] = [line]
  for (const which of [0, 1] as const) {
    const out: Pt[][] = []
    for (const run of runs) {
      let cur: Pt[] = []
      for (let i = 0; i < run.length; i += 1) {
        const a = run[i]
        const da = depth(a, axis, frame)[which]
        if (da >= 0) cur.push(a)
        const b = run[i + 1]
        if (!b) continue
        const db = depth(b, axis, frame)[which]
        if (da >= 0 === db >= 0) continue
        // Where the segment crosses the boundary, by the ratio of the two
        // depths: they are signed distances along the same direction, so the
        // crossing is a straight interpolation between them.
        const t = da / (da - db)
        cur.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        if (da >= 0) {
          out.push(cur)
          cur = []
        }
      }
      if (cur.length >= 2) out.push(cur)
    }
    runs = out.filter((run) => run.length >= 2)
  }
  return runs
}

/**
 * How near an end has to come to the axis before it is taken to be ON it, and
 * how near two ends have to come before they are taken to be the same end.
 *
 * THE KERF, because that is the finest thing this screen can express: two marks
 * closer together than the slot the laser burns are one mark, and a hand that
 * draws to within a third of a millimetre of the mirror has drawn to the
 * mirror. Anything tighter would make closing a shape a matter of luck with a
 * freehand stroke, which is the gesture this is for.
 *
 * The join tolerance is far tighter, and can afford to be: by the time two ends
 * are compared they have both been pulled onto the axis exactly, so a reflected
 * end and its original are the same floats rather than nearly.
 */
const AT_AXIS = KERF
const SAME_END = 1e-9

/**
 * Pull a run's two ends onto the axis when they all but touch it.
 *
 * ENDS ONLY, never the middle: what is being answered is "did this line start
 * and finish AT the mirror", and a point halfway along that happens to graze
 * the axis is just a line crossing back over itself. A clipped run arrives with
 * its end exactly on the boundary already -- this is for the run that was never
 * clipped because the hand stopped a hair short.
 */
function endsAtAxis(run: Pt[], axis: MirrorAxis, frame: { along: Pt; across: Pt }): Pt[] {
  const signs = partSigns(axis)
  const pull = (p: Pt): Pt => {
    const q = toAxis(p, frame)
    const along = signs.along !== 0 && Math.abs(q[0]) < AT_AXIS ? 0 : q[0]
    const across = Math.abs(q[1]) < AT_AXIS ? 0 : q[1]
    return along === q[0] && across === q[1] ? p : fromAxis([along, across], frame)
  }
  const out = run.slice()
  out[0] = pull(out[0])
  out[out.length - 1] = pull(out[out.length - 1])
  return out
}

const sameEnd = (a: Pt, b: Pt): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= SAME_END

/**
 * Sew the copies back together wherever they meet, and close the ring when they
 * come all the way round.
 *
 * THIS IS WHAT MAKES DRAWING HALF A SHAPE WORK, and it was the one thing
 * missing from the first version of this tool. Draw a silhouette from the axis,
 * round, and back to the axis: the mirror completes it on screen, and the two
 * halves plainly meet. Handed to the laser as two separate open lines, though,
 * each of them was carried out to the border along its own tangent -- which is
 * what every open line on this screen has always had done to it, and rightly,
 * since an open line inside the block separates nothing. The result was two
 * rays fired across the stock and a cut nobody drew.
 *
 * The halves are not two lines. They are one closed line written in two pieces,
 * and the only place that can be noticed is here, where both pieces are in hand
 * at once. Sewn up, the ring goes down the same road an encircling loop already
 * travels: `carryToBorder` stands aside for a closed line and the sweep bends
 * the wall round into a tube, so the shape drops out as an island. See
 * `isClosedLine`.
 *
 * WHAT IS NOT JOINED IS LEFT ALONE. A line drawn clear of the axis has ends
 * that meet nothing, and comes out exactly as it went in: two copies, both
 * open, both carried to the border. That is the ordinary mirrored cut and it is
 * untouched by any of this.
 */
function sew(pieces: Pt[][]): Pt[][] {
  const pool = pieces.filter((run) => run.length >= 2)
  const out: Pt[][] = []

  while (pool.length > 0) {
    let run = pool.shift() as Pt[]
    // Round and round until nothing else will attach: a quarter drawn into the
    // corner of a cross takes three joins to come back to where it started.
    for (;;) {
      if (run.length >= 4 && sameEnd(run[0], run[run.length - 1])) break
      const at = pool.findIndex(
        (other) =>
          sameEnd(run[run.length - 1], other[0]) ||
          sameEnd(run[run.length - 1], other[other.length - 1]) ||
          sameEnd(run[0], other[0]) ||
          sameEnd(run[0], other[other.length - 1])
      )
      if (at < 0) break
      const other = pool.splice(at, 1)[0]
      // Whichever way round the neighbour was written, it is walked so that the
      // seam is a single shared point rather than a doubled one.
      if (sameEnd(run[run.length - 1], other[0])) run = run.concat(other.slice(1))
      else if (sameEnd(run[run.length - 1], other[other.length - 1]))
        run = run.concat(other.slice(0, -1).reverse())
      else if (sameEnd(run[0], other[other.length - 1])) run = other.slice(0, -1).concat(run)
      else run = other.slice(1).reverse().concat(run)
    }
    // A ring is CLOSED EXACTLY, by writing the first point again rather than by
    // trusting two reflections to have landed on the same float. That repeated
    // point is the only thing that tells the sweep it has a loop -- see
    // `isClosedLine` -- so it is worth being deliberate about.
    if (run.length >= 4 && sameEnd(run[0], run[run.length - 1])) run[run.length - 1] = run[0]
    out.push(run)
  }
  return out
}

/**
 * Every way the axis reflects a point: itself, and the images of it.
 *
 * The identity comes first, so `images(p)[0]` is the point as drawn and the
 * rest are what the mirror adds. A plain mirror has one image and a cross has
 * three -- the two reflections and the half turn that is both of them, which is
 * the copy diagonally opposite and the one that is easiest to forget.
 */
export function images(at: Pt, axis: MirrorAxis): Pt[] {
  const frame = axisFrame(axis.angle)
  const q = toAxis(at, frame)
  const flips: Pt[] =
    axis.mode === 'line'
      ? [q, [q[0], -q[1]]]
      : [q, [q[0], -q[1]], [-q[0], q[1]], [-q[0], -q[1]]]
  return flips.map((f) => fromAxis(f, frame))
}

/**
 * What actually gets burned for one drawn line: it, clipped to the part it was
 * drawn in, and its reflections.
 *
 * ONE FUNCTION FOR THE PREVIEW AND THE CUT BOTH, which is the whole reason it
 * is written here rather than at either call site. What the user is shown while
 * drawing and what Apply hands the laser have to be the same set of lines --
 * a tool that previewed one thing and burned another is worse than one that
 * previewed nothing -- and there is no reading of "they agree" that survives
 * two copies of this. The same bargain `draftLine` strikes one step earlier.
 *
 * AND THE COPIES ARE SEWN BACK UP, which is the half that took a broken cut to
 * find. Half a silhouette drawn from the axis, round, and back to the axis
 * looks closed on screen the moment the mirror completes it -- and it IS
 * closed; it is one ring written in two pieces. Handed over as two open lines
 * it was not treated as one: each end was carried out to the border along its
 * own tangent, as every open line here rightly is, and the block came back
 * slashed corner to corner by a cut nobody drew. See `sew`.
 *
 * Empty when the drawing lies wholly outside the picked part, which the caller
 * reads as nothing to cut: the preview draws nothing and Apply refuses, and
 * both of those are the truth about a line drawn in a dimmed part.
 */
export function mirrorLines(line: Pt[], axis: MirrorAxis): Pt[][] {
  const frame = axisFrame(axis.angle)
  const flips: ((q: Pt) => Pt)[] =
    axis.mode === 'line'
      ? [(q) => q, (q) => [q[0], -q[1]]]
      : [(q) => q, (q) => [q[0], -q[1]], (q) => [-q[0], q[1]], (q) => [-q[0], -q[1]]]

  const copies: Pt[][] = []
  for (const clipped of clipToPart(line, axis)) {
    // Onto the axis before it is reflected, never after: an end pulled into
    // place first has an image in exactly the same spot, where an end left a
    // hair short has an image a hair the other side and the two never meet.
    const run = endsAtAxis(clipped, axis, frame)
    for (const flip of flips) {
      copies.push(run.map((p) => fromAxis(flip(toAxis(p, frame)), frame)))
    }
  }
  // And then sewn back up wherever they meet, which is what turns half a
  // silhouette drawn against the mirror into one ring rather than two open
  // lines with their ends fired off across the block. See `sew`.
  return sew(copies)
}

/**
 * The face square, cut down to one part: the shape to dim, or the shape to
 * leave lit.
 *
 * Sutherland-Hodgman against one or two half planes, which is enough because
 * everything in sight is convex: the face is a square and a part is a half of
 * it or a quarter of it. Hands back the corners in order, ready to be fanned
 * into triangles by whoever draws it.
 */
export function partPolygon(axis: MirrorAxis, part: number, half: number): Pt[] {
  const one: MirrorAxis = { ...axis, part }
  const frame = axisFrame(one.angle)
  let poly: Pt[] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ]
  for (const which of [0, 1] as const) {
    const clipped: Pt[] = []
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const da = depth(a, one, frame)[which]
      const db = depth(b, one, frame)[which]
      if (da >= 0) clipped.push(a)
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db)
        clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    poly = clipped
    if (poly.length < 3) return []
  }
  return poly
}

/**
 * The angle the line should take, given the one the hand is asking for.
 *
 * PULLED IN TO THE NEAREST STOP WHEN IT IS CLOSE ENOUGH, and left exactly where
 * the hand put it otherwise, which is what makes 30 degrees reachable on a line
 * that still clicks onto square. `tolerance` is how near is near, in degrees,
 * and comes from the Snap panel in the bar; at zero the stops are off and the
 * line is free, which is what the bar's own Snap switch turns off by handing
 * this a zero.
 *
 * Wrapped into a half turn on the way out, because a mirror at 190 degrees IS
 * the mirror at 10: the line has no ends to tell apart. Keeping the two apart
 * would give the panel a readout that jumped by 180 for no visible reason.
 */
export function snapAxisAngle(angle: number, tolerance: number): number {
  const wrapped = ((angle % 180) + 180) % 180
  if (tolerance <= 0) return wrapped
  const stop = Math.round(wrapped / DETENT) * DETENT
  const near = Math.abs(wrapped - stop) <= tolerance
  return near ? ((stop % 180) + 180) % 180 : wrapped
}
