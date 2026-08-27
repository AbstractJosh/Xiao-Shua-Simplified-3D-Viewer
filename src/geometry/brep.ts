import type { BufferGeometry } from 'three'
import { MIN_DIMENSION } from './dimensions'
import type { Vec3 } from './types'

/**
 * Triangle soup, read as B-rep TOPOLOGY: welded vertices, shared edges, closed
 * shells, and flat faces with the loops that bound them.
 *
 * This exists for STEP, and only for STEP. GLB, OBJ and STL are mesh formats:
 * they want triangles and are content with whatever triangles they are handed.
 * STEP describes a SOLID -- faces bounded by edges bounded by vertices -- and
 * every one of those has to be shared by the two faces that meet along it, or
 * the file describes a heap of loose facets rather than a body that can be cut,
 * filleted or measured in a CAD package.
 *
 * Nothing here knows about the file format; it is all geometry, which is why it
 * sits beside the evaluator rather than inside the exporter.
 *
 * Tolerances are ABSOLUTE, in scene units, and can be: `dimensions.ts` bounds
 * every primitive between `MIN_DIMENSION` and 8 units, so a model is always
 * within a couple of orders of magnitude of unit size, and the positions
 * arriving here have been through a Float32Array -- about seven digits.
 */

/** Two vertices closer than this are the same vertex. Comfortably above float32
 *  noise on a model this size, and far below any real feature. */
export const WELD_TOLERANCE = 1e-5

/**
 * How far off a plane a vertex may sit and still count as on it.
 *
 * Looser than the weld, deliberately: a face normal computed from float32
 * corners carries an error around 1e-6, and across a solid several units wide
 * that error alone lifts the far corner of a flat face by tens of microns.
 */
export const COPLANAR_TOLERANCE = 1e-4

/** Normals within this of parallel belong to the same plane. About 0.26
 *  degrees -- two orders finer than the facet step on the roundest solid the
 *  app can build, so a sphere never collapses into one flat face. */
export const PARALLEL_DOT = 1 - 1e-5

/** A welded triangle mesh: `points` as xyz triples, `tris` as index triples. */
export type BrepMesh = { points: number[]; tris: number[] }

/** A flat face of a solid: an outer loop, and a loop per hole through it. */
export type BrepFace = {
  normal: Vec3
  /**
   * A VERTEX INDEX, not a position: the plane anchors on one of the face's own
   * corners, so the exporter can point its plane and its edges at the very same
   * `CARTESIAN_POINT` instead of writing a second one that merely agrees.
   */
  origin: number
  /** Vertex indices, outer boundary first. The outer loop runs counter-clockwise
   *  seen from outside the solid; every hole runs the other way. */
  loops: number[][]
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])

function normalize(a: Vec3): Vec3 {
  const l = len(a)
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * An undirected edge as ONE number, so the maps below key on a primitive
 * instead of a string built per lookup.
 *
 * The shift bounds the vertex count at 16 million, which the exporter checks
 * before it gets here -- a model that large would have defeated the boolean
 * evaluator long before it reached a file.
 */
const EDGE_SHIFT = 2 ** 24
export const MAX_BREP_VERTICES = EDGE_SHIFT

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a
}

function vertexAt(mesh: BrepMesh, i: number): Vec3 {
  return [mesh.points[i * 3], mesh.points[i * 3 + 1], mesh.points[i * 3 + 2]]
}

function corners(mesh: BrepMesh, tri: number): [number, number, number] {
  return [mesh.tris[tri * 3], mesh.tris[tri * 3 + 1], mesh.tris[tri * 3 + 2]]
}

// --- welding ---------------------------------------------------------------

/**
 * Index a triangle soup by POSITION alone.
 *
 * Not `mergeVertices`, which the mesh exporters use: that welds on every
 * attribute at once, so a cube corner stays three separate vertices because its
 * three faces disagree about the normal there. That is exactly right for
 * shading and exactly wrong for topology -- a corner where three faces meet is
 * ONE vertex, and a B-rep that says otherwise has three cracks running out of
 * it.
 *
 * The grid is snapped at the tolerance and every lookup sweeps the 27 cells
 * around the query, because two points a hair apart can still land either side
 * of a cell boundary -- which is the one bug a naive quantised hash always has.
 */
export function indexByPosition(
  geometry: BufferGeometry,
  tolerance = WELD_TOLERANCE
): BrepMesh {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : position.count

  const points: number[] = []
  const tris: number[] = []
  const grid = new Map<string, number[]>()

  const vertexFor = (x: number, y: number, z: number): number => {
    const cx = Math.round(x / tolerance)
    const cy = Math.round(y / tolerance)
    const cz = Math.round(z / tolerance)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!bucket) continue
          for (const i of bucket) {
            const dist = Math.hypot(
              points[i * 3] - x,
              points[i * 3 + 1] - y,
              points[i * 3 + 2] - z
            )
            if (dist <= tolerance) return i
          }
        }
      }
    }
    const id = points.length / 3
    points.push(x, y, z)
    const key = `${cx},${cy},${cz}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(id)
    else grid.set(key, [id])
    return id
  }

  for (let i = 0; i < count; i += 3) {
    const abc: number[] = []
    for (let k = 0; k < 3; k++) {
      const at = index ? index.getX(i + k) : i + k
      abc.push(vertexFor(position.getX(at), position.getY(at), position.getZ(at)))
    }
    // A triangle that welded two of its own corners together has no area and no
    // opinion about anything; keeping it would only add a loose edge.
    if (abc[0] !== abc[1] && abc[1] !== abc[2] && abc[2] !== abc[0]) tris.push(...abc)
  }

  return { points, tris }
}

// --- shared edges ----------------------------------------------------------

/** Every undirected edge, with the triangles using it. */
function edgeUse(mesh: BrepMesh): Map<number, number[]> {
  const use = new Map<number, number[]>()
  for (let tri = 0; tri < mesh.tris.length / 3; tri++) {
    const [a, b, c] = corners(mesh, tri)
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = edgeKey(u, v)
      const at = use.get(key)
      if (at) at.push(tri)
      else use.set(key, [tri])
    }
  }
  return use
}

/**
 * Whether every edge is shared by exactly two triangles -- the condition for
 * the mesh to describe a closed solid rather than a sheet with cracks in it,
 * and so for STEP to be able to call it a solid at all.
 */
export function isManifold(mesh: BrepMesh): boolean {
  for (const users of edgeUse(mesh).values()) if (users.length !== 2) return false
  return true
}

// --- T-junction healing ----------------------------------------------------

/**
 * Split edges that have another vertex sitting on them.
 *
 * A boolean retriangulates only the faces its tool actually touches. Drop a
 * boss on top of a cube and the top face comes back as a hundred triangles
 * around the circle while the four sides are left as the two big triangles they
 * always were -- so along each of the four top edges, one side is one long edge
 * and the other is a chain of short ones. Every one of those chains is a crack:
 * the long edge is used by one triangle and matched by none.
 *
 * It is invisible in a mesh format, which draws what it is given. It is fatal
 * to a B-rep, which has to hand each edge to exactly two faces.
 *
 * The repair rebuilds an offending triangle as a fan around its own CENTROID
 * rather than from one of its corners. A corner fan is the obvious choice and
 * it is wrong: the extra points sit ON the triangle's edges, so a fan from a
 * corner makes zero-area slivers wherever two consecutive points are collinear
 * with it, and dropping those slivers reopens the very cracks this is closing.
 * A centroid is strictly inside, so every triangle of the fan has area and
 * every boundary edge survives exactly once.
 */
export function healTJunctions(
  mesh: BrepMesh,
  tolerance = WELD_TOLERANCE
): { mesh: BrepMesh; split: number } {
  const use = edgeUse(mesh)
  const open: number[] = []
  for (const [key, users] of use) if (users.length !== 2) open.push(key)
  if (open.length === 0) return { mesh, split: 0 }

  // Only an unmatched edge can be a crack -- two triangles already agreeing on
  // an edge have nothing between them -- so only those are measured.
  const size = Math.max(tolerance * 4, MIN_DIMENSION / 8)
  const cellOf = (x: number, y: number, z: number) =>
    `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`

  const grid = new Map<string, number[]>()
  for (let i = 0; i < mesh.points.length / 3; i++) {
    const key = cellOf(mesh.points[i * 3], mesh.points[i * 3 + 1], mesh.points[i * 3 + 2])
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  }

  /** Vertices strictly inside the segment, in order along it. */
  const onSegment = (a: number, b: number): number[] => {
    const A = vertexAt(mesh, a)
    const B = vertexAt(mesh, b)
    const AB = sub(B, A)
    const span = dot(AB, AB)
    if (span === 0) return []
    const length = Math.sqrt(span)

    const found: { v: number; t: number }[] = []
    const seen = new Set<number>()
    const lo = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.min(A[2], B[2])]
    const hi = [Math.max(A[0], B[0]), Math.max(A[1], B[1]), Math.max(A[2], B[2])]
    for (let x = Math.floor(lo[0] / size) - 1; x <= Math.floor(hi[0] / size) + 1; x++) {
      for (let y = Math.floor(lo[1] / size) - 1; y <= Math.floor(hi[1] / size) + 1; y++) {
        for (let z = Math.floor(lo[2] / size) - 1; z <= Math.floor(hi[2] / size) + 1; z++) {
          for (const v of grid.get(`${x},${y},${z}`) ?? []) {
            if (v === a || v === b || seen.has(v)) continue
            seen.add(v)
            const AP = sub(vertexAt(mesh, v), A)
            const t = dot(AP, AB) / span
            // Strictly between the ends by more than a weld: a point at either
            // end IS that end, and welding has already said so.
            const margin = tolerance / length
            if (t <= margin || t >= 1 - margin) continue
            const perp: Vec3 = [AP[0] - AB[0] * t, AP[1] - AB[1] * t, AP[2] - AB[2] * t]
            if (len(perp) > tolerance) continue
            found.push({ v, t })
          }
        }
      }
    }
    found.sort((p, q) => p.t - q.t)
    return found.map((f) => f.v)
  }

  // What each offending triangle's three edges need, in that triangle's own
  // direction of travel. Cached per edge, so a crack found from one side is
  // never measured again from the other.
  const perEdge = new Map<number, number[]>()
  const inserts = new Map<number, number[][]>()
  let split = 0

  for (const key of open) {
    let points = perEdge.get(key)
    if (!points) {
      points = []
      const users = use.get(key) ?? []
      if (users.length > 0) {
        const [a, b, c] = corners(mesh, users[0])
        for (const [u, v] of [
          [a, b],
          [b, c],
          [c, a],
        ]) {
          if (edgeKey(u, v) === key) points = onSegment(Math.min(u, v), Math.max(u, v))
        }
      }
      perEdge.set(key, points)
    }
    if (points.length === 0) continue

    for (const tri of use.get(key) ?? []) {
      let slots = inserts.get(tri)
      if (!slots) {
        slots = [[], [], []]
        inserts.set(tri, slots)
      }
      const abc = corners(mesh, tri)
      for (let e = 0; e < 3; e++) {
        const u = abc[e]
        const v = abc[(e + 1) % 3]
        if (edgeKey(u, v) !== key) continue
        // `points` runs from the lower vertex index to the higher; this edge
        // may be walking the other way round its own triangle.
        slots[e] = u < v ? [...points] : [...points].reverse()
        split += points.length
      }
    }
  }

  if (split === 0) return { mesh, split: 0 }

  const points = [...mesh.points]
  const tris: number[] = []
  for (let tri = 0; tri < mesh.tris.length / 3; tri++) {
    const abc = corners(mesh, tri)
    const slots = inserts.get(tri)
    if (!slots || slots.every((s) => s.length === 0)) {
      tris.push(...abc)
      continue
    }

    const ring: number[] = []
    for (let e = 0; e < 3; e++) ring.push(abc[e], ...slots[e])

    const centroid = points.length / 3
    for (let axis = 0; axis < 3; axis++) {
      points.push(
        (points[abc[0] * 3 + axis] + points[abc[1] * 3 + axis] + points[abc[2] * 3 + axis]) / 3
      )
    }
    for (let i = 0; i < ring.length; i++) {
      tris.push(centroid, ring[i], ring[(i + 1) % ring.length])
    }
  }

  return { mesh: { points, tris }, split }
}

// --- shells ----------------------------------------------------------------

/**
 * The mesh split into connected pieces, each a list of triangle indices.
 *
 * One export can hold several solids -- two objects side by side, or one merged
 * object whose parts never touched -- and STEP wants each as its own body. A
 * single closed shell wrapped around two disjoint lumps is not a solid, and the
 * stricter importers say so.
 */
export function shells(mesh: BrepMesh): number[][] {
  const count = mesh.tris.length / 3
  const parent = new Int32Array(count)
  for (let i = 0; i < count; i++) parent[i] = i
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    while (parent[i] !== root) {
      const next = parent[i]
      parent[i] = root
      i = next
    }
    return root
  }
  for (const users of edgeUse(mesh).values()) {
    for (let i = 1; i < users.length; i++) {
      const a = find(users[0])
      const b = find(users[i])
      if (a !== b) parent[a] = b
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < count; i++) {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(i)
    else groups.set(root, [i])
  }
  return [...groups.values()]
}

// --- flat faces ------------------------------------------------------------

function triNormal(mesh: BrepMesh, tri: number): Vec3 {
  const [a, b, c] = corners(mesh, tri)
  return normalize(
    cross(sub(vertexAt(mesh, b), vertexAt(mesh, a)), sub(vertexAt(mesh, c), vertexAt(mesh, a)))
  )
}

/**
 * Walk a region's boundary into closed loops.
 *
 * A directed edge is INTERIOR to the region when the region also holds its
 * reverse -- the neighbouring triangle travelling the other way. Everything
 * else is boundary, and because the mesh is consistently wound, the boundary
 * edges chain end to end into loops with no choices to make along the way.
 *
 * `null` where there IS a choice: a vertex with two boundary edges leaving it
 * is a region pinched to a point, and any loop through it would be a guess.
 */
function boundaryLoops(mesh: BrepMesh, region: number[]): number[][] | null {
  const directed = new Set<number>()
  const pair = (a: number, b: number) => a * EDGE_SHIFT + b
  for (const tri of region) {
    const [a, b, c] = corners(mesh, tri)
    directed.add(pair(a, b))
    directed.add(pair(b, c))
    directed.add(pair(c, a))
  }

  const next = new Map<number, number>()
  for (const key of directed) {
    const a = Math.floor(key / EDGE_SHIFT)
    const b = key % EDGE_SHIFT
    if (directed.has(pair(b, a))) continue
    if (next.has(a)) return null
    next.set(a, b)
  }
  if (next.size === 0) return null

  const loops: number[][] = []
  const walked = new Set<number>()
  for (const start of next.keys()) {
    if (walked.has(start)) continue
    const loop: number[] = []
    let at = start
    while (!walked.has(at)) {
      walked.add(at)
      loop.push(at)
      const step = next.get(at)
      if (step === undefined) return null
      at = step
    }
    // A walk that rejoined the chain anywhere but where it began is not a loop,
    // and nothing downstream could make sense of it.
    if (at !== start || loop.length < 3) return null
    loops.push(loop)
  }
  return loops
}

/** Twice the area of a loop projected onto the plane, signed by the normal. */
function loopArea(mesh: BrepMesh, loop: number[], normal: Vec3): number {
  let sum: Vec3 = [0, 0, 0]
  for (let i = 0; i < loop.length; i++) {
    const p = vertexAt(mesh, loop[i])
    const q = vertexAt(mesh, loop[(i + 1) % loop.length])
    const c = cross(p, q)
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]]
  }
  return dot(sum, normal)
}

/**
 * A shell's triangles gathered into the flat faces they actually form.
 *
 * A cube comes out of the evaluator as twelve triangles and is six faces. Left
 * as triangles it is still a valid solid in STEP and a miserable one to open:
 * every flat face arrives pre-shattered, so a fillet has a dozen edges to catch
 * on and a face click selects a sixth of what the eye sees.
 *
 * Regions grow by FLOOD FILL from a seed triangle, and every candidate is
 * measured against the SEED's plane rather than against its neighbour's. Chain
 * the comparison neighbour to neighbour instead and the plane drifts a little
 * at each step, so a gently curved surface -- and a sphere is nothing but
 * gentle steps -- eventually swallows itself into one enormous flat face.
 *
 * Whatever cannot be read as a clean outer loop and its holes is emitted as its
 * own triangles instead. A face this could not read is not a face worth
 * guessing at: one bad loop makes the whole solid unopenable, where a handful
 * of extra triangles only makes it plainer.
 */
export function flatFaces(mesh: BrepMesh, region: number[]): BrepFace[] {
  const use = edgeUse(mesh)
  const neighbours = (tri: number): number[] => {
    const [a, b, c] = corners(mesh, tri)
    const out: number[] = []
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      for (const other of use.get(edgeKey(u, v)) ?? []) if (other !== tri) out.push(other)
    }
    return out
  }

  const inRegion = new Set(region)
  const taken = new Set<number>()
  const faces: BrepFace[] = []

  const asTriangles = (group: number[]) => {
    for (const tri of group) {
      faces.push({
        normal: triNormal(mesh, tri),
        origin: mesh.tris[tri * 3],
        loops: [[...corners(mesh, tri)]],
      })
    }
  }

  for (const seed of region) {
    if (taken.has(seed)) continue
    const normal = triNormal(mesh, seed)
    const origin = mesh.tris[seed * 3]
    const anchor = vertexAt(mesh, origin)

    const coplanar = (tri: number): boolean => {
      if (dot(triNormal(mesh, tri), normal) < PARALLEL_DOT) return false
      for (const v of corners(mesh, tri)) {
        if (Math.abs(dot(sub(vertexAt(mesh, v), anchor), normal)) > COPLANAR_TOLERANCE) {
          return false
        }
      }
      return true
    }

    const group: number[] = [seed]
    taken.add(seed)
    for (let i = 0; i < group.length; i++) {
      for (const other of neighbours(group[i])) {
        if (taken.has(other) || !inRegion.has(other) || !coplanar(other)) continue
        taken.add(other)
        group.push(other)
      }
    }

    if (group.length === 1) {
      asTriangles(group)
      continue
    }

    const loops = boundaryLoops(mesh, group)
    if (!loops) {
      asTriangles(group)
      continue
    }
    const outer = loops.filter((loop) => loopArea(mesh, loop, normal) > 0)
    // Exactly one loop should run with the face and the rest against it. Two
    // would mean the region is really two patches the flood fill joined through
    // a single shared vertex, and a hole could then belong to either.
    if (outer.length !== 1) {
      asTriangles(group)
      continue
    }
    faces.push({
      normal,
      origin,
      loops: [outer[0], ...loops.filter((loop) => loop !== outer[0])],
    })
  }

  return faces
}
