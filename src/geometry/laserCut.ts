import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three'
import { SUBTRACTION, csg, disposeBrush, makeBrush } from './brush'
import type { Pt } from './curve'
import type { Vec3 } from './types'
import { signedVolume } from './volume'

/**
 * Cutting a block with a LINE DRAWN ON ONE OF ITS FACES, which is what a laser
 * does and what no plane can do.
 *
 * THE WHOLE DIFFERENCE FROM `cut.ts` IN ONE SENTENCE: that file cuts with an
 * infinite plane and keeps the answer parametrically, as two half-spaces the
 * evaluator folds in every time it rebuilds an object. This one cuts with an
 * arbitrary curve and BAKES the answer, because a curve is not a half-space --
 * there is no pair of opposing sides to store, and the shape that comes out is
 * not describable as "the original, kept on one side of something".
 *
 * THE CUT IS A KERF, not a mathematical surface, and that is the decision the
 * rest of the file follows from. A laser burns a slot of real width; so does
 * this. The drawn line is swept into a thin closed wall, that wall is
 * SUBTRACTED from the block, and the pieces are whatever the result falls into
 * -- see `splitComponents`. Three things fall out of it for free, and each of
 * them is a case the obvious approach gets wrong:
 *
 *   - A line that crosses itself, or wanders off the face and back on, cuts
 *     into THREE pieces rather than two, and the answer is simply correct. The
 *     alternative -- closing the line into a region and intersecting with it --
 *     has to decide which of several regions the user meant, and cannot.
 *   - Nothing has to be triangulated. The wall is a tube of quads built by
 *     hand, so there is no ear-clipping step to fail on a concave or
 *     self-touching outline.
 *   - The pieces end up a kerf apart, so the cut is VISIBLE as a hairline the
 *     moment it lands. Coincident faces would have z-fought instead, and a cut
 *     you cannot see reads as a button that did nothing.
 *
 * BLOCK SPACE, throughout: the block is the unit cube centred on the origin,
 * and the viewport scales it to whatever the Side field says. That is what
 * makes resizing free and lossless after a cut -- nothing is rescaled, a
 * number outside the geometry changes -- and it is why every constant here is
 * a fraction of ONE rather than a length in scene units.
 */

/**
 * A point on the face being drawn on, in that face's own (u, v).
 *
 * Re-exported rather than declared, since the Lathe screen draws points in a
 * plane of its own and the pair of numbers is the same pair -- see `curve.ts`,
 * which is also where the fitting and the Bézier chain went when this stopped
 * being their only caller. Everything that reads a `Pt` off this file goes on
 * doing so.
 */
export type { Pt }

/** Which face of the block is being drawn on: an axis, and which end of it. */
export type FaceAxis = { axis: 0 | 1 | 2; sign: 1 | -1 }

/** The block is the unit cube, so every face is one unit square and every
 *  face plane is half a unit out. See the note at the top of the file. */
export const BLOCK_HALF = 0.5

/**
 * How wide the slot the cut burns is, as a fraction of the block's side.
 *
 * Three thousandths: 0.3 mm on the default ten-centimetre block, which is what
 * a real cutter takes out, and about a pixel and a half on screen at the
 * opening zoom. Small enough that nobody is measuring what it cost them; big
 * enough that the two pieces are genuinely separate solids afterwards rather
 * than two shells sharing a surface, which is the thing the evaluator cannot be
 * asked to make sense of.
 */
export const KERF = 0.003

/**
 * How finely a drawn line is resampled before it is swept.
 *
 * A multiple of the kerf rather than a number of its own, because the ratio is
 * what matters: the wall is built by offsetting each station sideways by half a
 * kerf, and a corner sharper than that offset can fold the wall through itself.
 * At three kerfs to a step the fold needs a hairpin turned inside a third of a
 * millimetre, which no hand and no smoothed line produces.
 */
export const STEP = KERF * 3

/**
 * How far past the face an open line is carried before it is swept -- see
 * `carryToBorder`.
 *
 * Two units, on a block one unit across, so an end pointed along the diagonal
 * still leaves the block with room to spare. It costs nothing: the extension is
 * two more stations on a wall that is subtracted from a solid it mostly misses.
 */
export const CARRY = 2

/** How far past the block's own faces the wall runs, so a cut goes all the way
 *  through rather than leaving a skin at either end. */
const THROUGH = BLOCK_HALF + 0.25

/** Grid a vertex is rounded onto before two of them count as the same point.
 *  Well below the kerf, and well above the noise a boolean leaves behind. */
const WELD = 1e-5

/** A piece thinner than this fraction of the block is dust the boolean left,
 *  not a piece. Cubic, because it is a volume against the unit cube's own. */
const MIN_PIECE = 1e-7

const perp = (p: Pt): Pt => [-p[1], p[0]]
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]]
const scale = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k]
const len = (p: Pt): number => Math.hypot(p[0], p[1])

function unit(p: Pt): Pt {
  const l = len(p)
  return l > 0 ? [p[0] / l, p[1] / l] : [0, 0]
}

/**
 * The face's own frame: two axes across it and one out of it.
 *
 * `u` and `v` are chosen to be the camera's own right and up when the compass
 * has settled on this face, so a line drawn rightward across the screen is a
 * line with increasing u. That is not decoration -- it is what lets the pointer
 * arithmetic and the curve maths work in one set of coordinates rather than
 * two, and it is why `v` is `viewUp` rather than "whichever axis is left over".
 *
 * (u, v, n) is right-handed, which the wall builder relies on to decide which
 * way its faces point.
 */
export function faceBasis(face: FaceAxis): { u: Vector3; v: Vector3; n: Vector3 } {
  const n = new Vector3(
    face.axis === 0 ? face.sign : 0,
    face.axis === 1 ? face.sign : 0,
    face.axis === 2 ? face.sign : 0
  )
  // The same answer `viewUp` gives for this direction, written here so the
  // geometry does not have to import the compass. Straight up and straight down
  // are the two the general rule cannot answer: there world +Y is the direction
  // being looked along, and the roll a continuous orbit would have reached is
  // -Z over the top and +Z under the bottom.
  const v =
    face.axis === 1 ? new Vector3(0, 0, -face.sign) : new Vector3(0, 1, 0)
  // Screen right is forward cross up, and forward is -n: the camera stands at
  // +n and looks back at the block.
  const u = new Vector3().copy(n).multiplyScalar(-1).cross(v)
  return { u, v, n }
}

/** A face point, put back into block space. */
export function faceToBlock(
  basis: { u: Vector3; v: Vector3; n: Vector3 },
  p: Pt,
  depth: number
): Vector3 {
  return new Vector3()
    .addScaledVector(basis.u, p[0])
    .addScaledVector(basis.v, p[1])
    .addScaledVector(basis.n, depth)
}

/**
 * Even out a drawn line's spacing.
 *
 * A pointer path arrives with whatever spacing the hand and the frame rate
 * happened to produce -- a dozen points piled on top of each other where it
 * slowed, and a hand's width of gap where it hurried. The wall is built by
 * offsetting each station sideways, so unevenly spaced stations make an
 * unevenly thick wall; and the piled-up ones make degenerate quads whose
 * normals are meaningless.
 *
 * Walks the polyline at a fixed step and drops a station each time, keeping the
 * last point exactly so the line ends where the hand did.
 */
export function resample(points: Pt[], step = STEP): Pt[] {
  if (points.length < 2 || !(step > 0)) return points.slice()

  const out: Pt[] = [points[0]]
  let carried = 0

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]
    const to = points[i]
    const run = len(sub(to, from))
    if (run <= 0) continue
    const dir = scale(sub(to, from), 1 / run)

    let along = step - carried
    while (along <= run) {
      out.push(add(from, scale(dir, along)))
      along += step
    }
    carried = run - (along - step)
  }

  const last = points[points.length - 1]
  if (len(sub(out[out.length - 1], last)) > step * 0.5) out.push(last)
  return out
}

/**
 * The stations the wall is really built from: one at every corner the line has,
 * and no gap longer than `step` anywhere along it.
 *
 * WHY THIS IS NOT `resample`. That one walks the whole polyline at a fixed
 * stride and carries the leftover across each corner, which is exactly right
 * for the job it was written for -- a freehand stroke, where the vertices are
 * pointer samples and a corner in them is the frame rate rather than the hand.
 * It is exactly wrong for a line whose vertices ARE the drawing. A stride that
 * steps over a corner never puts a station on it: the two stations either side
 * are joined by a chord, and what gets burnt is a chamfer where a point was
 * asked for. On a 10 cm block that moved the cut up to a third of a millimetre
 * off the corner drawn -- further than the slot it burns, and four times the
 * budget `SIMPLIFY` is so careful to stay inside.
 *
 * So the walk RESTARTS at every vertex instead of striding through it. Each
 * segment is divided into whole parts of its own -- `round(run / step)` of them
 * -- which keeps every gap between half a step and one and a half, so nothing
 * is piled up and nothing is stretched. What it costs is nothing: the same
 * number of stations, in slightly different places, with the corners among
 * them.
 *
 * A VERTEX NEARER THAN A KERF TO THE LAST STATION IS NOT A CORNER. The cut
 * cannot express a detail finer than the slot it burns, so a jog that small is
 * dropped rather than given a station of its own -- which is also what keeps a
 * densely sampled curve (see `bezierChain`, sixteen to a span) from arriving as
 * a run of stations too close together to offset a wall from. The last point is
 * kept whatever, so the line still ends where the hand left it and
 * `carryToBorder` reads the direction it was really travelling.
 */
export function stations(line: Pt[], step = STEP): Pt[] {
  if (line.length < 2 || !(step > 0)) return line.slice()
  const floor = step / 3

  const out: Pt[] = [line[0]]
  for (let i = 1; i < line.length; i += 1) {
    const to = line[i]
    const from = out[out.length - 1]
    const run = len(sub(to, from))
    // The same point twice: no direction to carry the wall along.
    if (run <= WELD) continue
    if (run < floor && i < line.length - 1) continue
    const parts = Math.max(1, Math.round(run / step))
    for (let k = 1; k < parts; k += 1) {
      out.push([from[0] + ((to[0] - from[0]) * k) / parts, from[1] + ((to[1] - from[1]) * k) / parts])
    }
    // The vertex itself, written out rather than interpolated to, so a corner
    // is the very point that was drawn rather than a float away from it.
    out.push(to)
  }
  return out
}

/**
 * How far a station may be from the line drawn without it, before it has to be
 * kept.
 *
 * A QUARTER OF THE KERF, so simplifying can never move the cut by as much as
 * the slot it burns -- which is what makes it invisible rather than a
 * compromise.
 */
const SIMPLIFY = KERF / 4

/**
 * Drop the stations a line does not need.
 *
 * THE STEP THAT MAKES THE CUT CHEAP. `resample` puts a station every `STEP`
 * whether the line is turning or not, so a dead straight stroke carried to both
 * borders arrives with some five hundred of them -- and every one becomes four
 * quads of wall, which becomes a fan of triangles across the flat face the
 * boolean leaves behind. A straight cut was coming back as three hundred and
 * fifty triangles where twelve would do, and the whole of that is stations
 * nobody asked for.
 *
 * Douglas-Peucker: keep the two ends, find the station furthest from the chord
 * between them, and if it is further off than the tolerance keep it and recurse
 * either side. What survives is exactly the stations that carry the shape.
 *
 * It runs AFTER resampling rather than instead of it, and both are needed. The
 * resample is what makes the spacing even enough to offset a wall from; this is
 * what stops that evenness costing anything on the stretches where the line is
 * not doing anything.
 */
export function simplify(points: Pt[], tolerance = SIMPLIFY): Pt[] {
  if (points.length < 3) return points.slice()

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  // An explicit stack rather than recursion: a five-hundred-station line on a
  // pathological path could nest deeper than is comfortable, and the loop is no
  // harder to read.
  const runs: [number, number][] = [[0, points.length - 1]]
  while (runs.length > 0) {
    const [from, to] = runs.pop()!
    if (to <= from + 1) continue
    const a = points[from]
    const b = points[to]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const span = Math.hypot(dx, dy)

    let worst = -1
    let at = -1
    for (let i = from + 1; i < to; i += 1) {
      const p = points[i]
      // Distance to the chord, or to the shared end when the chord is a point
      // -- which happens on a line that comes back to where it started.
      const off =
        span > 0
          ? Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / span
          : Math.hypot(p[0] - a[0], p[1] - a[1])
      if (off > worst) {
        worst = off
        at = i
      }
    }

    if (worst > tolerance && at > from) {
      keep[at] = 1
      runs.push([from, at], [at, to])
    }
  }

  return points.filter((_, i) => keep[i] === 1)
}

/**
 * Carry an open line's two ends on until they are well clear of the face.
 *
 * A CUT HAS TO GO ALL THE WAY ACROSS, and a hand almost never draws one that
 * does: a stroke that stops in the middle of the face would burn a slot with a
 * dead end, which separates nothing. Each end is continued along the direction
 * it was already travelling -- the tangent of its own last segment -- so the
 * extension is the line the user was drawing rather than a line drawn for them.
 *
 * Straight rather than curved, deliberately. The alternative is extrapolating
 * the curvature, which on a stroke that ended on a wobble sends the cut
 * somewhere nobody asked for; a tangent is the one continuation that cannot
 * surprise.
 */
export function carryToBorder(points: Pt[], reach = CARRY): Pt[] {
  if (points.length < 2) return points.slice()

  const head = unit(sub(points[0], points[1]))
  const tail = unit(sub(points[points.length - 1], points[points.length - 2]))
  // Two coincident ends carry nowhere. Handing the line back unchanged lets the
  // caller's "does it separate anything" test say no, which is the truth.
  if (len(head) === 0 || len(tail) === 0) return points.slice()

  return [
    add(points[0], scale(head, reach)),
    ...points,
    add(points[points.length - 1], scale(tail, reach)),
  ]
}

/* THE FITTING AND THE BEZIER CHAIN MOVED to `curve.ts` when the Lathe screen
   gained a tool that places points too. Neither ever read a face, a kerf or a
   block -- see the note at the top of that file. */

/**
 * One step of the rope: where the tool ends up when the pointer has moved.
 *
 * THE STABILISER, and it is a rope rather than an average. An averaging filter
 * lags the pointer by a fixed amount everywhere, so a slow careful line is
 * damped exactly as hard as a fast one and the tool never quite arrives. A rope
 * of fixed length does nothing at all until the pointer is further away than the
 * slack, and then drags the tool along behind it -- so small wobbles inside the
 * slack are absorbed completely, a long pull is followed exactly, and the line
 * comes to rest where the hand is rather than short of it.
 *
 * It is also the filter that cannot overshoot: the tool only ever moves TOWARD
 * the pointer, and only as far as the slack allows. That is the same bargain
 * the lathe's tools strike with the wall, and it is why holding still is safe
 * on both screens.
 */
export function ropeFollow(anchor: Pt, pointer: Pt, slack: number): Pt {
  const away = sub(pointer, anchor)
  const d = len(away)
  if (!(d > slack)) return anchor
  return add(anchor, scale(away, (d - slack) / d))
}

/**
 * The drawn line, swept into the thin closed wall the cut burns.
 *
 * A TUBE OF QUADS, built by hand rather than extruded from an outline. The
 * cross-section is a rectangle -- a kerf wide across the face, and long enough
 * along the face's normal to pass clean through the block -- carried along the
 * line from station to station, and capped at both ends. Every quad is written
 * down here, so there is no triangulator to fail on a line that touches itself
 * and no outline that has to be simple.
 *
 * Each station is offset sideways along its own VERTEX normal, the average of
 * the two segments meeting there, so the wall keeps its width round a corner
 * instead of pinching. `resample` is what keeps that safe: a corner sharper
 * than the offset would fold the wall through itself, and even spacing at three
 * kerfs to a step puts that well out of reach.
 *
 * Wound outward, and checked rather than reasoned about: the mesh is built in
 * one consistent order and then flipped wholesale if its signed volume comes
 * out negative. A closed mesh has exactly two consistent windings and only one
 * of them encloses positive volume, so this is a proof rather than a guess --
 * and it is one line against a page of sign conventions that would have to be
 * re-derived for all six faces.
 */
export function buildKerfWall(
  line: Pt[],
  face: FaceAxis,
  kerf = KERF,
  through = THROUGH
): BufferGeometry | null {
  if (line.length < 2) return null
  const basis = faceBasis(face)

  // The sideways offset at each station, in face coordinates.
  const normals: Pt[] = line.map((_, i) => {
    const before = i > 0 ? unit(sub(line[i], line[i - 1])) : null
    const after = i < line.length - 1 ? unit(sub(line[i + 1], line[i])) : null
    const dir =
      before && after ? unit(add(before, after)) : (after ?? before ?? ([1, 0] as Pt))
    // A station where the line doubles straight back on itself averages to
    // nothing; its own incoming direction is the honest answer there.
    return perp(len(dir) > 0 ? dir : (before ?? after ?? ([1, 0] as Pt)))
  })

  const half = kerf / 2
  const positions: number[] = []

  /** The four corners of the cross-section at station `i`, in block space. */
  const ring = (i: number): Vector3[] => {
    const left = add(line[i], scale(normals[i], half))
    const right = sub(line[i], scale(normals[i], half))
    return [
      faceToBlock(basis, left, through),
      faceToBlock(basis, right, through),
      faceToBlock(basis, right, -through),
      faceToBlock(basis, left, -through),
    ]
  }

  const push = (p: Vector3) => positions.push(p.x, p.y, p.z)
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => {
    push(a)
    push(b)
    push(c)
    push(a)
    push(c)
    push(d)
  }

  let previous = ring(0)
  // The near cap, closing the tube at the end the line starts from.
  quad(previous[3], previous[2], previous[1], previous[0])

  for (let i = 1; i < line.length; i += 1) {
    const next = ring(i)
    for (let c = 0; c < 4; c += 1) {
      const d = (c + 1) % 4
      quad(previous[c], previous[d], next[d], next[c])
    }
    previous = next
  }

  // And the far cap.
  quad(previous[0], previous[1], previous[2], previous[3])

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  // Flipped wholesale if it came out inside-out -- see the note above.
  if (signedVolume(geometry) < 0) flipWinding(geometry)
  geometry.computeVertexNormals()
  return geometry
}

/** Reverse every triangle, turning a closed mesh inside out. */
function flipWinding(geometry: BufferGeometry): void {
  const position = geometry.getAttribute('position') as BufferAttribute
  const array = position.array as Float32Array
  for (let t = 0; t < array.length; t += 9) {
    for (let c = 0; c < 3; c += 1) {
      const b = array[t + 3 + c]
      array[t + 3 + c] = array[t + 6 + c]
      array[t + 6 + c] = b
    }
  }
  position.needsUpdate = true
}

/** The root of `i`'s set, flattening the path it walked to get there. */
function findRoot(parent: Int32Array, i: number): number {
  let root = i
  while (parent[root] !== root) root = parent[root]
  let walk = i
  while (parent[walk] !== root) {
    const up = parent[walk]
    parent[walk] = root
    walk = up
  }
  return root
}

/**
 * Break one geometry into the separate solids it actually contains.
 *
 * THE OTHER HALF OF CUTTING WITH A KERF. Subtracting the wall leaves a single
 * geometry holding two shells that share not one vertex, and every consumer
 * downstream -- the volume that decides which piece is the offcut, the
 * highlight, the Delete key -- needs them as separate things.
 *
 * Triangles are joined into a piece when they share a VERTEX rather than an
 * edge, which is the looser of the two tests and the right one here: a boolean
 * result meets itself at corners as well as along edges, and edge-joining would
 * report a solid that touches itself at a point as two solids.
 *
 * Positions are rounded onto a grid before they are compared. A boolean writes
 * the same corner out several times with the last bits disagreeing, and exact
 * comparison would shatter one piece into hundreds.
 */
export function splitComponents(geometry: BufferGeometry): BufferGeometry[] {
  const position = geometry.getAttribute('position')
  if (!position) return []
  const source = geometry.index ? geometry.toNonIndexed() : geometry
  const array = (source.getAttribute('position').array as ArrayLike<number>)
  const normals = source.getAttribute('normal')?.array as ArrayLike<number> | undefined
  const triangles = Math.floor(array.length / 9)
  if (triangles === 0) return []

  // One id per distinct position, and a union-find over those ids.
  const ids = new Map<string, number>()
  const vertex = new Int32Array(triangles * 3)
  for (let v = 0; v < triangles * 3; v += 1) {
    const key =
      Math.round(array[v * 3] / WELD) +
      ',' +
      Math.round(array[v * 3 + 1] / WELD) +
      ',' +
      Math.round(array[v * 3 + 2] / WELD)
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    vertex[v] = id
  }

  const parent = new Int32Array(ids.size)
  for (let i = 0; i < parent.length; i += 1) parent[i] = i
  const join = (a: number, b: number) => {
    const ra = findRoot(parent, a)
    const rb = findRoot(parent, b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let t = 0; t < triangles; t += 1) {
    join(vertex[t * 3], vertex[t * 3 + 1])
    join(vertex[t * 3], vertex[t * 3 + 2])
  }

  const groups = new Map<number, number[]>()
  for (let t = 0; t < triangles; t += 1) {
    const root = findRoot(parent, vertex[t * 3])
    const bag = groups.get(root)
    if (bag) bag.push(t)
    else groups.set(root, [t])
  }

  const pieces: BufferGeometry[] = []
  for (const bag of groups.values()) {
    const out = new Float32Array(bag.length * 9)
    const outNormals = normals ? new Float32Array(bag.length * 9) : null
    bag.forEach((t, i) => {
      for (let c = 0; c < 9; c += 1) {
        out[i * 9 + c] = array[t * 9 + c]
        if (outNormals && normals) outNormals[i * 9 + c] = normals[t * 9 + c]
      }
    })
    const piece = new BufferGeometry()
    piece.setAttribute('position', new BufferAttribute(out, 3))
    if (outNormals) piece.setAttribute('normal', new BufferAttribute(outNormals, 3))
    else piece.computeVertexNormals()
    pieces.push(piece)
  }

  // Biggest first, so "the offcut" is simply the last one and the order the
  // viewport draws in does not depend on which way a boolean happened to walk.
  return pieces.sort((a, b) => Math.abs(signedVolume(b)) - Math.abs(signedVolume(a)))
}

/** The paint every piece of the block wears. There is one block and no
 *  document, so nothing here has a colour to look up -- see `paintMaterial`. */
const BLOCK_PAINT = 'laser-block'

/**
 * Run one cut across every piece on the bed.
 *
 * EVERY PIECE, with nothing selected first, which is the same answer the
 * modelling screen's cut gives when nothing is selected: the line is aimed at
 * the bed rather than at one part of it, and a piece it does not cross comes
 * back untouched. It is also the only answer this screen can give, having no
 * selection to ask about.
 *
 * The wall is built once and cloned per piece, because `makeBrush` normalises
 * the geometry it is handed in place and the library forbids touching it
 * afterwards.
 *
 * `split` counts the pieces that actually came apart, so the caller can tell a
 * cut from a line that missed -- which looks exactly like a broken button
 * unless the tool says so out loud.
 *
 * `made` indexes every piece THIS CUT PRODUCED, in the order they come off --
 * biggest first within each piece that came apart. Which of them is thrown away
 * is the user's to say, so what this hands back is the whole list rather than a
 * pick from it: see `choices` in `laserStore`, and `pieceVolume` for the size
 * the store sorts them by.
 *
 * IT HAS TO BE THIS CUT'S OWN, and that is the reason the list exists at all
 * rather than the caller reading the bed. The bed after a cut is every piece
 * there has ever been, and a sliver left over from an earlier cut and
 * deliberately kept is not something this cut is offering to throw away.
 */
export function cutPieces(
  pieces: BufferGeometry[],
  line: Pt[],
  face: FaceAxis,
  kerf = KERF
): { pieces: BufferGeometry[]; split: number; made: number[] } {
  // Even the spacing WITHOUT stepping over a corner, then drop the stations the
  // shape does not need, then carry the ends out past the block. In that order:
  // the simplify is what keeps a straight cut from costing three hundred
  // triangles, and the carry is two more stations that must not be simplified
  // away.
  //
  // `stations` rather than `resample`, and the difference is the whole of
  // whether Point Cut can burn a corner: a stride that walks through a vertex
  // leaves a chamfer where the hand asked for a point. See `stations`. The
  // freehand stroke has already been through `resample` on its way here -- see
  // `draftLine` -- so it arrives evenly spaced and passes through this
  // unchanged.
  const wall = buildKerfWall(carryToBorder(simplify(stations(line))), face, kerf)
  if (!wall) return { pieces, split: 0, made: [] }

  const out: BufferGeometry[] = []
  let split = 0
  const made: number[] = []

  try {
    for (const piece of pieces) {
      // The caller's geometry is on screen: brushing it directly would let the
      // disposal below free a buffer the viewport is still drawing.
      const solid = makeBrush(piece.clone(), BLOCK_PAINT)
      const blade = makeBrush(wall.clone(), BLOCK_PAINT)
      let result
      try {
        result = csg(solid, blade, SUBTRACTION)
      } finally {
        disposeBrush(solid)
        disposeBrush(blade)
      }

      const parts = splitComponents(result.geometry).filter(
        (p) => Math.abs(signedVolume(p)) > MIN_PIECE
      )
      disposeBrush(result)

      // A wall that missed leaves the piece whole, and a piece the wall merely
      // grazed can come back as nothing at all -- keep the original in both
      // cases rather than handing back a hole in the bed.
      if (parts.length === 0) out.push(piece)
      else {
        if (parts.length > 1) {
          split += 1
          // Every one of them, not the smallest: which piece goes is a choice,
          // and a function that made it here would be one that could not be
          // asked for the other answer. `splitComponents` hands them back
          // biggest first, so the list is already in an order worth showing.
          for (let i = 0; i < parts.length; i += 1) made.push(out.length + i)
        }
        out.push(...parts)
      }
    }
  } finally {
    wall.dispose()
  }

  return { pieces: out, split, made }
}

/**
 * The edges worth drawing on a cut piece: its silhouette and its creases, and
 * none of the triangulation in between.
 *
 * WRITTEN OUT RATHER THAN LEFT TO `EdgesGeometry`, which is what this replaced
 * and which cannot do the job on a boolean's output. That class rebuilds
 * adjacency by hashing vertex positions to four decimal places, and a CSG
 * result writes the same corner out several times with the last bits
 * disagreeing -- so half the shared edges find no partner, come back as
 * boundaries, and every triangle in the fan across a flat cut face is drawn as
 * an outline. On screen that is a spray of lines radiating out of the cut,
 * which reads as a shattered pane rather than as a cut piece.
 *
 * Here the adjacency comes from the SAME weld `splitComponents` uses to decide
 * what a piece even is, and where that is not enough the question is settled
 * GEOMETRICALLY instead. It has to be: a boolean leaves T-JUNCTIONS, where one
 * triangle's edge is met by two shorter ones from its neighbour, so the long
 * edge finds no partner however exactly the corners are welded. Topology alone
 * calls every one of those a silhouette. So an unpartnered edge is settled by
 * asking what is actually lying against its middle -- a face pointing the same
 * way means the edge is interior to a flat stretch and is not drawn; one
 * pointing elsewhere, or nothing at all, means a real edge of the solid.
 *
 * The threshold is generous on purpose. A cut wall is a fan of facets a few
 * degrees apart -- `STEP` sets how many -- and a tight threshold would draw
 * every one of them as a crease down the curve.
 */
export function outlineOf(geometry: BufferGeometry, thresholdDeg = 25): BufferGeometry {
  const source = geometry.index ? geometry.toNonIndexed() : geometry
  const array = source.getAttribute('position').array as ArrayLike<number>
  const triangles = Math.floor(array.length / 9)

  const ids = new Map<string, number>()
  const vertex = new Int32Array(triangles * 3)
  for (let v = 0; v < triangles * 3; v += 1) {
    const key =
      Math.round(array[v * 3] / WELD) +
      ',' +
      Math.round(array[v * 3 + 1] / WELD) +
      ',' +
      Math.round(array[v * 3 + 2] / WELD)
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    vertex[v] = id
  }

  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const normals: Vector3[] = []
  for (let t = 0; t < triangles; t += 1) {
    a.fromArray(array as number[], t * 9)
    b.fromArray(array as number[], t * 9 + 3)
    c.fromArray(array as number[], t * 9 + 6)
    normals.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize())
  }

  // Every undirected edge, and the triangles that claim it.
  const edges = new Map<string, { i: number; j: number; faces: number[] }>()
  for (let t = 0; t < triangles; t += 1) {
    for (let e = 0; e < 3; e += 1) {
      const i = vertex[t * 3 + e]
      const j = vertex[t * 3 + ((e + 1) % 3)]
      if (i === j) continue
      const key = i < j ? i + ':' + j : j + ':' + i
      const held = edges.get(key)
      if (held) held.faces.push(t)
      else edges.set(key, { i, j, faces: [t] })
    }
  }

  // One position per welded id, taken from the first vertex that produced it.
  const at = new Map<number, [number, number, number]>()
  for (let v = 0; v < triangles * 3; v += 1) {
    if (!at.has(vertex[v])) {
      at.set(vertex[v], [array[v * 3], array[v * 3 + 1], array[v * 3 + 2]])
    }
  }

  const flat = Math.cos((thresholdDeg * Math.PI) / 180)
  const mid = new Vector3()
  const corner = [new Vector3(), new Vector3(), new Vector3()]

  /**
   * Whether some triangle other than `skip` lies against this point facing the
   * same way -- the test that tells a T-junction from a silhouette.
   *
   * Walks every triangle, which is quadratic in the piece and perfectly
   * affordable: it runs once, when the cut lands, on a piece of a few hundred
   * facets. The alternative is a spatial index for a loop that takes a
   * millisecond.
   */
  const coveredFlat = (skip: number): boolean => {
    for (let t = 0; t < triangles; t += 1) {
      if (t === skip) continue
      if (normals[t].dot(normals[skip]) < flat) continue
      for (let c = 0; c < 3; c += 1) corner[c].fromArray(array as number[], t * 9 + c * 3)
      // On the plane, and inside the triangle: the three sub-triangles the
      // point makes with each edge have to add up to the whole one.
      if (Math.abs(mid.clone().sub(corner[0]).dot(normals[t])) > WELD * 10) continue
      const whole = corner[1].clone().sub(corner[0]).cross(corner[2].clone().sub(corner[0])).length()
      if (!(whole > 0)) continue
      let parts = 0
      for (let c = 0; c < 3; c += 1) {
        const a2 = corner[c]
        const b2 = corner[(c + 1) % 3]
        parts += a2.clone().sub(mid).cross(b2.clone().sub(mid)).length()
      }
      if (parts <= whole * 1.0001) return true
    }
    return false
  }

  const out: number[] = []
  for (const edge of edges.values()) {
    const p = at.get(edge.i)
    const q = at.get(edge.j)
    if (!p || !q) continue

    let draw: boolean
    if (edge.faces.length === 2) {
      draw = normals[edge.faces[0]].dot(normals[edge.faces[1]]) < flat
    } else if (edge.faces.length === 1) {
      mid.set((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2)
      draw = !coveredFlat(edge.faces[0])
    } else {
      // More than two faces on one edge is geometry nobody meant; drawing it is
      // the honest answer and it is the shape you want to see if it happens.
      draw = true
    }
    if (!draw) continue
    out.push(p[0], p[1], p[2], q[0], q[1], q[2])
  }

  const lines = new BufferGeometry()
  lines.setAttribute('position', new BufferAttribute(new Float32Array(mergeCollinear(out)), 3))
  return lines
}

/**
 * Fold segments that lie along one line into the stretches they actually
 * cover.
 *
 * THE OTHER HALF OF THE T-JUNCTION PROBLEM. Where one triangle's edge is met by
 * two shorter ones from its neighbour, all three are real boundary edges and
 * all three get drawn -- so a single visible edge of the solid comes back as
 * one long segment with two short ones lying on top of it. Nothing looks wrong,
 * because a line drawn twice looks like a line. But it is half again as much
 * geometry as the outline needs, and it makes the outline impossible to check:
 * "a cut box has twelve edges" stops being a thing anyone can assert.
 *
 * So the segments are grouped by the infinite line they lie on -- named by a
 * direction with a settled sign and by the one point of that line nearest the
 * origin, both rounded -- and each group is reduced to the intervals it
 * genuinely covers. What comes out is one segment per visible run, which is
 * both the smallest correct answer and the one worth pinning.
 */
function mergeCollinear(flat: number[]): number[] {
  const groups = new Map<string, { from: Vector3; dir: Vector3; spans: [number, number][] }>()
  const a = new Vector3()
  const b = new Vector3()
  const dir = new Vector3()

  for (let i = 0; i < flat.length; i += 6) {
    a.set(flat[i], flat[i + 1], flat[i + 2])
    b.set(flat[i + 3], flat[i + 4], flat[i + 5])
    dir.copy(b).sub(a)
    const span = dir.length()
    if (!(span > 0)) continue
    dir.divideScalar(span)
    // One sign per line rather than two, or the same edge drawn each way round
    // would land in two groups and neither would swallow the other.
    if (dir.x < -1e-9 || (Math.abs(dir.x) <= 1e-9 && (dir.y < -1e-9 || (Math.abs(dir.y) <= 1e-9 && dir.z < 0)))) {
      dir.multiplyScalar(-1)
    }
    // The point of the line closest to the origin: unique per line, so it names
    // the line without depending on which segment of it we happen to hold.
    const foot = a.clone().addScaledVector(dir, -a.dot(dir))
    const key =
      [dir.x, dir.y, dir.z, foot.x, foot.y, foot.z]
        .map((n) => Math.round(n / WELD))
        .join(',')

    let group = groups.get(key)
    if (!group) {
      group = { from: foot.clone(), dir: dir.clone(), spans: [] }
      groups.set(key, group)
    }
    const s0 = a.clone().sub(group.from).dot(group.dir)
    const s1 = b.clone().sub(group.from).dot(group.dir)
    group.spans.push(s0 < s1 ? [s0, s1] : [s1, s0])
  }

  const out: number[] = []
  const at = new Vector3()
  for (const group of groups.values()) {
    group.spans.sort((x, y) => x[0] - y[0])
    let [lo, hi] = group.spans[0]
    const flush = () => {
      at.copy(group.from).addScaledVector(group.dir, lo)
      out.push(at.x, at.y, at.z)
      at.copy(group.from).addScaledVector(group.dir, hi)
      out.push(at.x, at.y, at.z)
    }
    for (let i = 1; i < group.spans.length; i += 1) {
      const [s0, s1] = group.spans[i]
      // Touching counts as overlapping: two edges meeting end to end along one
      // line are one edge of the solid, and drawing them apart would leave a
      // seam nobody put there.
      if (s0 <= hi + WELD) hi = Math.max(hi, s1)
      else {
        flush()
        lo = s0
        hi = s1
      }
    }
    flush()
  }
  return out
}

/** A fresh block: the unit cube, centred, ready to be scaled by the Side. */
export function freshBlock(): BufferGeometry {
  const geometry = new BufferGeometry()
  const h = BLOCK_HALF
  const corner = (x: number, y: number, z: number) => new Vector3(x * h, y * h, z * h)
  const positions: number[] = []
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => {
    for (const p of [a, b, c, a, c, d]) positions.push(p.x, p.y, p.z)
  }
  // Six faces, each wound counter-clockwise seen from outside.
  quad(corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1))
  quad(corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1))
  quad(corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1))
  quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1))
  quad(corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1))
  quad(corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1))
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return geometry
}

/** How big a piece is, for ordering the pieces a cut made and for opening the
 *  choice on the smallest of them. */
export function pieceVolume(geometry: BufferGeometry): number {
  return Math.abs(signedVolume(geometry))
}

/**
 * How much of the unit cube an UNCUT bed holds, which is all of it.
 *
 * Worth a name because it is the test for "nothing has happened here yet": the
 * cut is a kerf, so anything the laser has actually been through is missing at
 * least a slot's worth of material and can never measure this again. See
 * `bedIsUncut`.
 */
export const BLOCK_VOLUME = (BLOCK_HALF * 2) ** 3

/**
 * Everything on the bed as ONE geometry, in SCENE UNITS rather than block
 * space.
 *
 * The way off this screen, and the only place the block's three sides are ever
 * baked INTO a mesh rather than left outside it as a scale. Everywhere else
 * that separation is the point -- it is what makes resizing a cut block free --
 * but a solid handed to the clipboard has to carry its own size, because the
 * document it is going to has no Side field to read.
 *
 * ONE GEOMETRY FOR THE WHOLE BED. Two pieces left lying apart are two shells of
 * one mesh, which is exactly what the modelling screen already does with an
 * imported model that happens to be in several parts. Anything the user did not
 * want in it, they take off the bed first -- `Del` is the one verb this screen
 * has, and what is left on the bed is the answer to what gets copied.
 *
 * The scale goes on at the END, through `applyMatrix4`, so three transforms the
 * normals by the inverse transpose for us: the sides are independent, and
 * scaling a normal the way a position scales would tilt every face on a block
 * that is not a cube.
 */
export function bedGeometry(pieces: BufferGeometry[], dims: Vec3): BufferGeometry {
  let vertices = 0
  for (const piece of pieces) vertices += piece.getAttribute('position').count

  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  let offset = 0
  for (const piece of pieces) {
    const p = piece.getAttribute('position')
    const n = piece.getAttribute('normal')
    position.set(p.array as ArrayLike<number>, offset)
    // A piece straight out of the boolean always has normals; one built by hand
    // might not, and a merged geometry missing half of them shades worse than
    // one missing all of them.
    if (n) normal.set(n.array as ArrayLike<number>, offset)
    offset += p.count * 3
  }

  const merged = new BufferGeometry()
  merged.setAttribute('position', new BufferAttribute(position, 3))
  merged.setAttribute('normal', new BufferAttribute(normal, 3))
  merged.applyMatrix4(new Matrix4().makeScale(dims[0], dims[1], dims[2]))
  return merged
}
