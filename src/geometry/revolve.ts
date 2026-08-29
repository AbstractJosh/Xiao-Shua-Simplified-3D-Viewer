import { BufferAttribute, BufferGeometry } from 'three'
import { CLAY_RINGS, ringHeight } from './clay'
import type { Clay } from './clay'

/**
 * The lathe's one way OUT: the wall of radii, turned into triangles.
 *
 * Everything on the Lathe screen is a section -- a row of radii and an `<svg>`
 * that draws it -- and that is enough right up until somebody wants the piece
 * in the scene next door. This is the join. It sweeps the profile a full turn
 * about the Y axis and caps both ends, which is what the screen has been
 * DRAWING all along: the silhouette is one meridian of this surface, and the
 * two walls in the drawing are this mesh cut down the middle.
 *
 * ITS OWN MODULE because of the import at the top. `clay.ts` is deliberately
 * free of three.js -- it is arithmetic the check suite runs without a renderer,
 * and the whole screen is built on it staying that way. Producing a
 * `BufferGeometry` is the one thing about the clay that genuinely needs three,
 * so it happens here, in the file that can be left out of any build that never
 * exports a piece.
 *
 * The mesh comes out CENTRED ON NOTHING and standing on y = 0, the way the
 * clay itself is measured; `registerMesh` centres and normalises it on the way
 * into the library, so nothing downstream depends on where it starts.
 */

/**
 * How many facets go round.
 *
 * Sixty-four is where a turned piece stops looking faceted at the size these
 * are made at: on a 10 cm bowl each facet is under 5 mm of arc, which is finer
 * than the outline the modelling screen draws over it. It is also a power of
 * two, so a piece can be decimated in half later without leaving a seam in an
 * odd place.
 *
 * The cost is triangles, and the sum is worth writing down: 96 rings by 64
 * facets is 12,160 triangles for the wall and 128 more for the caps. That is a
 * couple of imported models' worth for a shape with no detail in it -- and it
 * is deliberate, because the alternative is a piece whose profile is coarser in
 * the scene than it was on the lathe. Anybody who wants it lighter can say so
 * with a number.
 */
export const TURN_FACETS = 64

/**
 * Sweep the wall a full turn and cap both ends.
 *
 * INDEXED, with the seam column duplicated. The first and last facet share a
 * position, and sharing one VERTEX between them would be the tidier mesh -- but
 * it is also the mesh whose seam welds two ends of a UV strip together, and
 * every consumer downstream (the outliner, the exporters, the B-rep welder)
 * would then meet one edge that behaves unlike its 63 neighbours. Duplicating
 * the column costs 96 vertices and keeps every quad identical.
 *
 * NORMALS ARE ANALYTIC rather than averaged from the triangles, and that is
 * what makes a turned piece look turned. `computeVertexNormals` averages face
 * normals, which is fine in the middle of the wall and wrong at the seam --
 * the two duplicated columns each see only the faces on their own side, so a
 * smooth surface gets a visible crease down one meridian. The profile's own
 * tangent gives the exact normal at every ring, and both copies of the seam get
 * the same one.
 */
export function revolveClay(clay: Clay, facets: number = TURN_FACETS): BufferGeometry {
  const segments = Math.max(3, Math.floor(facets))
  const columns = segments + 1

  // The wall, plus a centre vertex at each end for the caps to fan from, plus
  // one ring per cap of its own -- the cap's vertices point along the axis and
  // the wall's point outward, and a vertex has one normal.
  const wallCount = CLAY_RINGS * columns
  const capCount = 2 * (columns + 1)
  const positions = new Float32Array((wallCount + capCount) * 3)
  const normals = new Float32Array((wallCount + capCount) * 3)

  const cos: number[] = []
  const sin: number[] = []
  for (let j = 0; j < columns; j += 1) {
    // The last column is the first one again, to the bit: written from the same
    // angle rather than from `2 * Math.PI`, so the seam closes exactly instead
    // of within a float of exactly.
    const theta = ((j % segments) / segments) * Math.PI * 2
    cos.push(Math.cos(theta))
    sin.push(Math.sin(theta))
  }

  // The wall.
  for (let i = 0; i < CLAY_RINGS; i += 1) {
    const r = clay.wall[i]
    const y = ringHeight(clay, i)

    // The profile's slope at this ring, one-sided at the ends. The outward
    // normal in the (radial, y) plane is the tangent turned a quarter: a
    // straight wall has dr = 0 and points straight out, and a wall that leans
    // out as it rises tips its normal down, which is what catches the light on
    // the underside of a flare.
    const below = clay.wall[Math.max(0, i - 1)]
    const above = clay.wall[Math.min(CLAY_RINGS - 1, i + 1)]
    const rise =
      ringHeight(clay, Math.min(CLAY_RINGS - 1, i + 1)) - ringHeight(clay, Math.max(0, i - 1))
    const dr = above - below
    const length = Math.hypot(rise, dr) || 1
    const nr = rise / length
    const ny = -dr / length

    for (let j = 0; j < columns; j += 1) {
      const v = (i * columns + j) * 3
      positions[v] = r * cos[j]
      positions[v + 1] = y
      positions[v + 2] = r * sin[j]
      normals[v] = nr * cos[j]
      normals[v + 1] = ny
      normals[v + 2] = nr * sin[j]
    }
  }

  // The caps: a centre, then a ring of its own copies of the rim.
  const capBase = wallCount
  const ends = [
    { ring: 0, y: 0, dir: -1 },
    { ring: CLAY_RINGS - 1, y: clay.height, dir: 1 },
  ]
  ends.forEach((end, e) => {
    const start = capBase + e * (columns + 1)
    const centre = start * 3
    positions[centre] = 0
    positions[centre + 1] = end.y
    positions[centre + 2] = 0
    normals[centre] = 0
    normals[centre + 1] = end.dir
    normals[centre + 2] = 0

    const r = clay.wall[end.ring]
    for (let j = 0; j < columns; j += 1) {
      const v = (start + 1 + j) * 3
      positions[v] = r * cos[j]
      positions[v + 1] = end.y
      positions[v + 2] = r * sin[j]
      normals[v] = 0
      normals[v + 1] = end.dir
      normals[v + 2] = 0
    }
  })

  const index: number[] = []
  // Wound so the front faces point OUT. With +X at theta 0 and +Z a quarter
  // turn on, going round is clockwise seen from above -- so the quad's two
  // triangles are laid out the way they are below, and `engine-check` proves it
  // by measuring the signed volume: an inside-out sweep comes out negative.
  for (let i = 0; i < CLAY_RINGS - 1; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = i * columns + j
      const b = a + 1
      const c = a + columns
      const d = c + 1
      index.push(a, c, b, b, c, d)
    }
  }
  ends.forEach((end, e) => {
    const start = capBase + e * (columns + 1)
    for (let j = 0; j < segments; j += 1) {
      const rim = start + 1 + j
      // The bottom cap faces down and the top one up, so their fans run
      // opposite ways round the same centre.
      if (end.dir < 0) index.push(start, rim, rim + 1)
      else index.push(start, rim + 1, rim)
    }
  })

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(index)
  return geometry
}
