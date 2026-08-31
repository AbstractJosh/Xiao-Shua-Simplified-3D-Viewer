import { BufferAttribute, BufferGeometry } from 'three'
import { bore, pieceSpan, ringHeight } from './clay'
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
 * AND IT IS WHERE THE BASE SHAPE LIVES. `Clay.sides` says whether the piece is
 * round or stands on a triangle through a decagon, and this is the only file
 * that has to know it: a sweep of 64 facets shaded smooth is a cylinder, the
 * same sweep of six shaded flat is a hexagonal prism, and nothing else about
 * the two pieces differs. The clay, the tools, the drawing and the pointer
 * arithmetic are one row of radii either way -- see `Clay.sides` for why that
 * is the honest arrangement rather than a corner cut.
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
 * How many facets go round a ROUND piece.
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
 *
 * A POLYGONAL piece ignores it and sweeps its own side count instead, which is
 * worth seeing plainly: a round piece was never a curve here either. It has
 * always been an inscribed 64-gon, so picking a hexagon does not switch on a
 * second kind of geometry. It turns the same dial down to six and stops
 * pretending the facets are not there.
 */
export const TURN_FACETS = 64

/**
 * One column of vertices up the piece: where it stands, and which way the wall
 * faces there.
 *
 * The two are SEPARATE, and that separation is the whole of flat shading. On a
 * round piece every column faces the way it stands, so the normals turn
 * smoothly round the piece and the eye reads a curve. On a polygonal one a
 * facet is a plane, and both of its columns have to face the way that PLANE
 * faces -- along the middle of the facet -- or the corners get averaged away
 * and a hexagonal prism arrives looking like a badly tessellated cylinder. So
 * each facet is given a column of its own at each of its edges: two columns
 * sharing a position and disagreeing about the normal, which is exactly what a
 * hard edge is.
 */
type Column = {
  /** Unit direction from the axis to where this column stands. */
  x: number
  z: number
  /** Unit direction the wall faces there, in the same plane. */
  nx: number
  nz: number
}

/**
 * The columns to sweep, and which pairs of them bound a facet.
 *
 * ROUND: one column per angle plus a repeat of the first at the seam, and every
 * neighbouring pair is a facet.
 *
 * POLYGONAL: two columns per facet, so nothing is shared and every corner stays
 * a corner. It costs twice the columns of a smooth sweep at the same count, and
 * the sum is still nothing: a decagonal piece carries 1,920 wall vertices
 * against a round one's 6,240. The faceted pieces are the cheap ones by a wide
 * margin.
 *
 * `segments` is passed in rather than read off the clay because a round piece
 * may be swept at any count the caller names -- see `revolveClay` -- while a
 * polygonal one's count IS its side count and has already been settled.
 */
function sweepColumns(
  sides: number | null,
  segments: number
): { columns: Column[]; facets: [number, number][] } {
  // The last column of a round sweep is the first one again, to the bit:
  // written from the same angle rather than from `2 * Math.PI`, so the seam
  // closes exactly instead of within a float of exactly.
  const at = (k: number) => ((k % segments) / segments) * Math.PI * 2
  const columns: Column[] = []
  const facets: [number, number][] = []

  if (sides === null) {
    for (let j = 0; j <= segments; j += 1) {
      const x = Math.cos(at(j))
      const z = Math.sin(at(j))
      columns.push({ x, z, nx: x, nz: z })
    }
    for (let j = 0; j < segments; j += 1) facets.push([j, j + 1])
    return { columns, facets }
  }

  for (let k = 0; k < segments; k += 1) {
    // The facet runs from corner k to corner k + 1 and faces the way the point
    // half way between them does: the apothem's direction, which is the one
    // direction square to the flat.
    const mid = at(k) + Math.PI / segments
    const nx = Math.cos(mid)
    const nz = Math.sin(mid)
    columns.push({ x: Math.cos(at(k)), z: Math.sin(at(k)), nx, nz })
    columns.push({ x: Math.cos(at(k + 1)), z: Math.sin(at(k + 1)), nx, nz })
    facets.push([k * 2, k * 2 + 1])
  }
  return { columns, facets }
}

/**
 * Sweep the wall a full turn and cap both ends.
 *
 * INDEXED, WITH NO VERTEX SHARED BETWEEN TWO FACETS. On a round piece the first
 * and last column share a position, and sharing one VERTEX between them would
 * be the tidier mesh -- but it is also the mesh whose seam welds two ends of a
 * UV strip together, and every consumer downstream (the outliner, the
 * exporters, the B-rep welder) would then meet one edge that behaves unlike its
 * 63 neighbours. Duplicating the column costs 96 vertices and keeps every quad
 * identical. On a polygonal piece every corner is duplicated for the same price
 * and a better reason: the two copies face different ways.
 *
 * NORMALS ARE ANALYTIC rather than averaged from the triangles, and that is
 * what makes a turned piece look turned. `computeVertexNormals` averages face
 * normals, which is fine in the middle of the wall and wrong at the seam --
 * the two duplicated columns each see only the faces on their own side, so a
 * smooth surface gets a visible crease down one meridian. The profile's own
 * tangent gives the exact normal at every ring, and both copies of the seam get
 * the same one. It is also what lets one loop produce both shadings: what a
 * column faces is decided once, in `sweepColumns`, and the sweep below never
 * has to ask which kind of piece it is building.
 *
 * `facets` sets what a ROUND piece is swept with. A polygonal one ignores it:
 * its facet count is its side count, and that is the user's to set.
 */
export function revolveClay(clay: Clay, facets: number = TURN_FACETS): BufferGeometry {
  // Three is the floor either way -- two facets enclose nothing -- and it is
  // applied here rather than trusted from the clay, which arrives from a store
  // a panel writes to.
  const segments =
    clay.sides === null
      ? Math.max(3, Math.floor(facets))
      : Math.max(3, Math.round(clay.sides))
  const { columns, facets: quads } = sweepColumns(clay.sides, segments)
  const mesh = builder()
  const cavity = bore(clay)

  // THE OUTER WALL FIRST, whatever else is built after it, so the buffer opens
  // with one vertex per column per ring, laid out ring by ring. That is a
  // layout `engine-check` reads by index to prove the seam closes, and it is
  // the one thing about this buffer that anything outside it knows.
  //
  // AND ONLY THE RINGS THAT ARE CLAY, which is the same trim the drawing makes
  // -- see `pieceSpan`, and `silhouette`, which is one meridian of this
  // surface and has to stay one. A piece with a rounded top has no material
  // over the last stretch of its stock, and swept to the rim regardless it
  // carries a column of degenerate bands up the axis: no volume, but a bounding
  // box as tall as the stock, which is the box the modelling screen sizes and
  // stands the pasted piece by. The piece would arrive shorter than it looks
  // and hovering over the grid.
  const span = pieceSpan(clay)
  // Turned away altogether. An empty mesh rather than a degenerate one: there
  // is no piece, and a buffer of nothing is the honest way to say so.
  if (span === null) return new BufferGeometry()

  const heights: number[] = []
  const profile: number[] = []
  for (let i = span.lo; i <= span.hi; i += 1) {
    heights.push(ringHeight(clay, i))
    profile.push(clay.wall[i])
  }
  sweepBand(mesh, columns, quads, profile, heights, true)

  // Then the cavity, if the piece has one: the same sweep, turned inside out.
  if (cavity) {
    const steps = cavity.wall.length - 1
    const boreHeights: number[] = []
    for (let i = 0; i <= steps; i += 1) {
      boreHeights.push(cavity.lo + ((cavity.hi - cavity.lo) * i) / steps)
    }
    sweepBand(mesh, columns, quads, cavity.wall, boreHeights, false)
  }

  /**
   * THE ENDS, and a hollow piece has up to four of them rather than two.
   *
   * A solid piece is closed by a disc at the faceplate and another at the rim.
   * Hollow it and each of those becomes one of two things: an ANNULUS where the
   * cavity comes out -- the rim of a cup is a ring of clay, not a disc -- or
   * the same disc as before where it does not. And a cavity that stops short of
   * an end needs a face of its own to close it: the floor of a bowl, seen from
   * inside.
   *
   * `dir` is which way a face looks, and it is always away from the material.
   * That one rule settles all four: the piece's base looks down, its rim looks
   * up, the cavity's floor looks UP because the clay is beneath it, and the
   * cavity's ceiling looks down.
   */
  const ring = (r: number) => ringPoints(segments, r)
  const bottomOpen = cavity !== null && cavity.openBottom
  const topOpen = cavity !== null && cavity.openTop
  const last = cavity ? cavity.wall.length - 1 : 0
  // The ends of the PIECE, which on an untouched lump are the faceplate and the
  // rim and on a domed one are wherever the clay ran out. A cap at a ring that
  // closed is a fan of no area -- the surface has already come to a point there
  // -- and it costs a handful of vertices to keep one rule for both cases.
  const foot = heights[0]
  const crown = heights[heights.length - 1]
  const base = profile[0]
  const rim = profile[profile.length - 1]

  if (cavity && bottomOpen) capAnnulus(mesh, foot, ring(cavity.wall[0]), ring(base), -1)
  else capDisc(mesh, foot, ring(base), -1)

  if (cavity && topOpen) capAnnulus(mesh, crown, ring(cavity.wall[last]), ring(rim), 1)
  else capDisc(mesh, crown, ring(rim), 1)

  if (cavity && !bottomOpen) capDisc(mesh, cavity.lo, ring(cavity.wall[0]), 1)
  if (cavity && !topOpen) capDisc(mesh, cavity.hi, ring(cavity.wall[last]), -1)

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(mesh.normals), 3))
  geometry.setIndex(mesh.index)
  return geometry
}

/**
 * Somewhere to push vertices and triangles, since the counts are no longer
 * known before the fact.
 *
 * They used to be -- a wall and two caps is arithmetic -- and then a piece
 * gained a cavity that may or may not exist, may or may not reach either end,
 * and closes itself with nought to two faces of its own. Sizing a Float32Array
 * up front for that is a sum nobody can read and nobody can change safely. The
 * arrays are copied into typed ones once at the end, and that copy costs less
 * than the first frame the mesh is drawn in.
 */
function builder() {
  return { positions: [] as number[], normals: [] as number[], index: [] as number[] }
}

type Builder = ReturnType<typeof builder>

/** One vertex, and the index it landed at. */
function vertex(
  mesh: Builder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number
): number {
  mesh.positions.push(x, y, z)
  mesh.normals.push(nx, ny, nz)
  return mesh.positions.length / 3 - 1
}

/**
 * A profile swept a full turn: the wall of a piece, or the wall of the hole
 * inside it.
 *
 * `outward` is the whole difference between the two. An outer wall faces away
 * from the axis and is wound to be seen from outside; a cavity's wall faces the
 * axis and is wound the other way, because what stands outside a cavity is
 * material. Flipping both together is what keeps the solid closed and its
 * volume positive -- and the signed-volume check in `engine-check` is exactly
 * the instrument that catches getting one of the two right and the other wrong.
 */
function sweepBand(
  mesh: Builder,
  columns: Column[],
  quads: [number, number][],
  radii: number[],
  heights: number[],
  outward: boolean
): void {
  const width = columns.length
  const rings = radii.length
  const base = mesh.positions.length / 3
  const face = outward ? 1 : -1

  for (let i = 0; i < rings; i += 1) {
    const r = radii[i]
    const y = heights[i]

    // The profile's slope at this ring, one-sided at the ends. The outward
    // normal in the (radial, y) plane is the tangent turned a quarter: a
    // straight wall has dr = 0 and points straight out, and a wall that leans
    // out as it rises tips its normal down, which is what catches the light on
    // the underside of a flare.
    //
    // The same up the meridian whichever base the piece stands on. A faceted
    // piece is faceted going ROUND and smooth going UP -- its flats are curved
    // panels, because the profile they follow is a curve -- so the slope is
    // read off the profile here and combined with the facet's own direction.
    const below = radii[Math.max(0, i - 1)]
    const above = radii[Math.min(rings - 1, i + 1)]
    const rise = heights[Math.min(rings - 1, i + 1)] - heights[Math.max(0, i - 1)]
    const dr = above - below
    const length = Math.hypot(rise, dr) || 1
    const nr = (rise / length) * face
    const ny = (-dr / length) * face

    for (let j = 0; j < width; j += 1) {
      const column = columns[j]
      vertex(mesh, r * column.x, y, r * column.z, nr * column.nx, ny, nr * column.nz)
    }
  }

  // Wound so the front faces point the way the normals do. With +X at theta 0
  // and +Z a quarter turn on, going round is clockwise seen from above -- so an
  // outward wall's two triangles are laid out as below, and an inward one is
  // the same two with a corner swapped.
  for (let i = 0; i < rings - 1; i += 1) {
    for (const [left, right] of quads) {
      const a = base + i * width + left
      const b = base + i * width + right
      const c = a + width
      const d = b + width
      if (outward) mesh.index.push(a, c, b, b, c, d)
      else mesh.index.push(a, b, c, b, d, c)
    }
  }
}

/**
 * The corners of one ring, as flat (x, z) pairs.
 *
 * The ends ring the CORNERS whatever the wall did about facets, so a hexagonal
 * piece is capped by one hexagon rather than by six two-cornered slivers, and a
 * round piece's cap is the 64-gon it always was. Their own vertices either way:
 * an end points along the axis where the wall points sideways, and a vertex has
 * one normal.
 */
function ringPoints(segments: number, r: number): [number, number][] {
  const points: [number, number][] = []
  for (let j = 0; j <= segments; j += 1) {
    // The last is the first again, written from the same angle rather than from
    // `2 * Math.PI`, so it closes exactly rather than within a float of it.
    const theta = ((j % segments) / segments) * Math.PI * 2
    points.push([r * Math.cos(theta), r * Math.sin(theta)])
  }
  return points
}

/** A flat end filled to the axis: a fan from a centre vertex. */
function capDisc(mesh: Builder, y: number, rim: [number, number][], dir: number): void {
  const centre = vertex(mesh, 0, y, 0, 0, dir, 0)
  const first = mesh.positions.length / 3
  for (const [x, z] of rim) vertex(mesh, x, y, z, 0, dir, 0)
  for (let j = 0; j < rim.length - 1; j += 1) {
    const a = first + j
    // A face looking down and one looking up run opposite ways round the same
    // centre.
    if (dir < 0) mesh.index.push(centre, a, a + 1)
    else mesh.index.push(centre, a + 1, a)
  }
}

/**
 * A flat end with a hole in it: the rim of a cup, or the underside of a pipe.
 *
 * A band between two rings rather than a fan, because there is no centre to fan
 * from -- which is the whole point of the shape. Both rings carry the same
 * count, so the band is one quad per facet and the cavity's corners land under
 * the wall's.
 */
function capAnnulus(
  mesh: Builder,
  y: number,
  inner: [number, number][],
  outer: [number, number][],
  dir: number
): void {
  const first = mesh.positions.length / 3
  for (const [x, z] of inner) vertex(mesh, x, y, z, 0, dir, 0)
  const outerFirst = mesh.positions.length / 3
  for (const [x, z] of outer) vertex(mesh, x, y, z, 0, dir, 0)

  for (let j = 0; j < inner.length - 1; j += 1) {
    const a = first + j
    const b = a + 1
    const c = outerFirst + j
    const d = c + 1
    if (dir < 0) mesh.index.push(a, c, b, b, c, d)
    else mesh.index.push(a, b, c, b, d, c)
  }
}
