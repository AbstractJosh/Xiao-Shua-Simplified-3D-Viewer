import { Matrix3, Vector3 } from 'three'
import type {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
} from 'three'
import { objectMatrix } from './transform'
import type { ObjectTransform } from './types'

/**
 * Snapping: turn an evaluated mesh into the handful of places a drag should
 * want to land on, then find the translation that lands there.
 *
 * Three gestures share this engine, which is why it works on world-space points
 * rather than anything document-shaped:
 *   1. dragging a whole object  -- its corners seek other objects' corners/edges
 *   2. dragging a sketch        -- its outline seeks its OWN host's corners/edges
 *   3. dragging an end face     -- it seeks other objects' edges and faces
 *
 * The hard part is deciding what is NOT a target. A tessellated cylinder has
 * hundreds of edges running down its wall and none of them is a feature a user
 * is aiming at; keeping them would make snapping fire at every point on a
 * curved surface and feel broken. So an edge earns its place only where the two
 * triangles across it genuinely disagree about which way the surface faces.
 */

export type SnapTarget =
  | { kind: 'vertex'; objectId: string; point: Vector3 }
  | { kind: 'edge'; objectId: string; a: Vector3; b: Vector3 }
  | { kind: 'face'; objectId: string; origin: Vector3; normal: Vector3 }

export type SnapHit = {
  /** Translation to apply to the dragged thing so its source point lands. */
  delta: Vector3
  /** Where that source point ends up. */
  point: Vector3
  target: SnapTarget
  /** True distance to the target, never the priority-adjusted score. */
  distance: number
}

export type SnapEntry = {
  id: string
  geometry: BufferGeometry
  transform: ObjectTransform
}

export const DEFAULT_SNAP_DISTANCE = 0.18

/** Positions collapse onto this grid before they are compared. Boolean output
 *  arrives as triangle soup, so without welding no two triangles ever agree on
 *  a shared vertex and the whole mesh looks like disconnected boundary. */
const WELD_GRID = 1e-4

/** Below half a degree two triangles are the same flat face -- CSG leaves that
 *  much slop on a plane it has re-triangulated. Past fifteen degrees they are a
 *  real crease. In between the surface is merely curving, and the "edge" is an
 *  artefact of tessellation. */
const COS_COPLANAR = Math.cos((0.5 * Math.PI) / 180)
const COS_FEATURE = Math.cos((15 * Math.PI) / 180)

// A snap query runs on every pointer move of a drag, so the target count is
// bounded rather than the mesh. The caps are generous for a hand-modelled part
// and hard limits for a pathological one.
const MAX_VERTEX_TARGETS = 3000
const MAX_EDGE_TARGETS = 4000
const MAX_FACE_TARGETS = 400

/** An axis extreme outranks any corner, so a smooth solid still offers the six
 *  points a user actually aims with -- a sphere has no creases at all and would
 *  otherwise be unsnappable. */
const AXIS_EXTREME_SCORE = 100

/** Fraction of the tolerance by which each priority step handicaps a target, so
 *  a vertex beats an edge beats a face at comparable distance without a clearly
 *  nearer face losing to a distant vertex. */
const PRIORITY_MARGIN = 0.35

const PRIORITY: Record<SnapTarget['kind'], number> = { vertex: 0, edge: 1, face: 2 }

const MEMO_CAPACITY = 24

// --- Topology extraction ---------------------------------------------------

type LocalTargets = {
  vertices: Vector3[]
  edges: Array<readonly [Vector3, Vector3]>
  faces: Array<{ origin: Vector3; normal: Vector3 }>
}

const EMPTY_TARGETS: LocalTargets = { vertices: [], edges: [], faces: [] }

type EdgeRecord = { i: number; j: number; t0: number; t1: number; count: number }

/**
 * Split into local extraction plus a per-call transform on purpose. Dragging an
 * object changes its transform every frame but not its mesh, so the expensive
 * half -- welding, the edge graph, the coplanar grouping -- must not be keyed on
 * anything that moves.
 */
function buildLocalTargets(geometry: BufferGeometry): LocalTargets {
  const pos = geometry.getAttribute('position')
  if (!pos || pos.count < 3) return EMPTY_TARGETS

  const index = geometry.getIndex()
  const triCount = Math.floor((index ? index.count : pos.count) / 3)
  if (triCount === 0) return EMPTY_TARGETS

  const mesh = weldMesh(pos, index, triCount)
  const kept = mesh.a.length
  if (kept === 0) return EMPTY_TARGETS

  const { points } = mesh
  const stride = points.length
  const used = new Uint8Array(stride)
  const edges = new Map<number, EdgeRecord>()

  const addEdge = (i: number, j: number, t: number): void => {
    const lo = i < j ? i : j
    const hi = i < j ? j : i
    const key = lo * stride + hi
    const rec = edges.get(key)
    if (!rec) {
      edges.set(key, { i: lo, j: hi, t0: t, t1: -1, count: 1 })
      return
    }
    if (rec.count === 1) rec.t1 = t
    rec.count++
  }

  for (let t = 0; t < kept; t++) {
    used[mesh.a[t]] = 1
    used[mesh.b[t]] = 1
    used[mesh.c[t]] = 1
    addEdge(mesh.a[t], mesh.b[t], t)
    addEdge(mesh.b[t], mesh.c[t], t)
    addEdge(mesh.c[t], mesh.a[t], t)
  }

  // A triangle touching a merely-smooth edge is a scrap of curved surface, not
  // part of a face. That one flag disqualifies a cylinder wall's quads while
  // leaving its flat caps -- whose only non-coplanar edges are the 90-degree
  // rim -- intact.
  const onCurve = new Uint8Array(kept)
  const cornerScore = new Uint32Array(stride)
  const featureEdges: FeatureEdge[] = []
  const groups = new UnionFind(kept)

  for (const rec of edges.values()) {
    switch (classifyEdge(rec, mesh.normal)) {
      case 'feature':
        featureEdges.push({
          i: rec.i,
          j: rec.j,
          length: points[rec.i].distanceTo(points[rec.j]),
        })
        cornerScore[rec.i]++
        cornerScore[rec.j]++
        break
      case 'smooth':
        onCurve[rec.t0] = 1
        if (rec.t1 >= 0) onCurve[rec.t1] = 1
        break
      case 'coplanar':
        // Growing faces across coplanar edges rather than by bucketing plane
        // equations keeps two separate faces that happen to share a plane --
        // the two prongs of a fork, say -- from averaging into one target
        // hovering in the gap between them.
        groups.union(rec.t0, rec.t1)
        break
    }
  }

  return {
    vertices: pickVertices(points, used, cornerScore),
    edges: pickEdges(points, featureEdges),
    faces: pickFaces(mesh, onCurve, groups),
  }
}

/** The mesh once welded: unique positions, and the triangles that survived.
 *  Parallel arrays because a dense mesh has tens of thousands of triangles and
 *  one object each would be pure allocation. */
type WeldedMesh = {
  points: Vector3[]
  a: number[]
  b: number[]
  c: number[]
  normal: Vector3[]
  area: number[]
}

function weldMesh(
  pos: BufferAttribute | InterleavedBufferAttribute,
  index: ReturnType<BufferGeometry['getIndex']>,
  triCount: number
): WeldedMesh {
  const points: Vector3[] = []
  const welded = weldPositions(pos, points)
  const mesh: WeldedMesh = { points, a: [], b: [], c: [], normal: [], area: [] }

  const ab = new Vector3()
  const ac = new Vector3()
  const cross = new Vector3()

  for (let t = 0; t < triCount; t++) {
    const base = t * 3
    const i0 = welded[index ? index.getX(base) : base]
    const i1 = welded[index ? index.getX(base + 1) : base + 1]
    const i2 = welded[index ? index.getX(base + 2) : base + 2]
    // Welding can fuse two corners of a needle-thin triangle; what is left has
    // no normal to contribute and would poison the dihedral tests.
    if (i0 === i1 || i1 === i2 || i2 === i0) continue

    const origin = points[i0]
    ab.subVectors(points[i1], origin)
    ac.subVectors(points[i2], origin)
    cross.crossVectors(ab, ac)
    const len = cross.length()
    // Written as a positive test so a NaN position is rejected here too.
    if (!(len > 1e-12)) continue

    mesh.a.push(i0)
    mesh.b.push(i1)
    mesh.c.push(i2)
    mesh.normal.push(cross.clone().multiplyScalar(1 / len))
    mesh.area.push(len / 2)
  }
  return mesh
}

/**
 * Welding is per source vertex, not per triangle corner: an indexed mesh reuses
 * each position six times over, and hashing it six times was most of the cost
 * of building a target set for a dense mesh.
 */
function weldPositions(
  pos: BufferAttribute | InterleavedBufferAttribute,
  points: Vector3[]
): Int32Array {
  // Nested integer maps rather than one map of "x,y,z" strings: same buckets,
  // no string built per vertex.
  const byX = new Map<number, Map<number, Map<number, number>>>()
  const welded = new Int32Array(pos.count)

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const qx = Math.round(x / WELD_GRID)
    const qy = Math.round(y / WELD_GRID)
    const qz = Math.round(z / WELD_GRID)

    let byY = byX.get(qx)
    if (!byY) {
      byY = new Map()
      byX.set(qx, byY)
    }
    let byZ = byY.get(qy)
    if (!byZ) {
      byZ = new Map()
      byY.set(qy, byZ)
    }
    const found = byZ.get(qz)
    if (found !== undefined) {
      welded[i] = found
      continue
    }
    byZ.set(qz, points.length)
    welded[i] = points.length
    points.push(new Vector3(x, y, z))
  }
  return welded
}

type EdgeClass = 'coplanar' | 'smooth' | 'feature'

function classifyEdge(rec: EdgeRecord, normals: Vector3[]): EdgeClass {
  // A boundary edge has nothing to compare against and a non-manifold junction
  // is a seam by definition; both are real features of the silhouette.
  if (rec.count !== 2) return 'feature'
  const dot = normals[rec.t0].dot(normals[rec.t1])
  if (dot >= COS_COPLANAR) return 'coplanar'
  return dot >= COS_FEATURE ? 'smooth' : 'feature'
}

class UnionFind {
  private readonly parent: Int32Array

  constructor(size: number) {
    this.parent = new Int32Array(size)
    for (let i = 0; i < size; i++) this.parent[i] = i
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) {
      // Halve the path on the way up, so repeated lookups stay near-constant.
      this.parent[root] = this.parent[this.parent[root]]
      root = this.parent[root]
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

/**
 * Corners first, then anything at the far end of an axis. A vertex nobody's
 * crease passes through is interior tessellation and snapping to it would be
 * indistinguishable from snapping to a random point on the surface.
 */
function pickVertices(
  points: Vector3[],
  used: Uint8Array,
  cornerScore: Uint32Array
): Vector3[] {
  const stride = points.length
  let maxX = -1
  let minX = -1
  let maxY = -1
  let minY = -1
  let maxZ = -1
  let minZ = -1
  for (let i = 0; i < stride; i++) {
    if (!used[i]) continue
    const p = points[i]
    if (maxX < 0 || p.x > points[maxX].x) maxX = i
    if (minX < 0 || p.x < points[minX].x) minX = i
    if (maxY < 0 || p.y > points[maxY].y) maxY = i
    if (minY < 0 || p.y < points[minY].y) minY = i
    if (maxZ < 0 || p.z > points[maxZ].z) maxZ = i
    if (minZ < 0 || p.z < points[minZ].z) minZ = i
  }
  const extremes = new Set([maxX, minX, maxY, minY, maxZ, minZ])

  const scored: Array<{ index: number; score: number }> = []
  for (let i = 0; i < stride; i++) {
    if (!used[i]) continue
    const score = cornerScore[i] + (extremes.has(i) ? AXIS_EXTREME_SCORE : 0)
    if (score === 0) continue
    scored.push({ index: i, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_VERTEX_TARGETS).map((s) => points[s.index])
}

type FeatureEdge = { i: number; j: number; length: number }

/** Long edges are the ones a user is aiming at, so they survive the cap. */
function pickEdges(
  points: Vector3[],
  featureEdges: FeatureEdge[]
): Array<readonly [Vector3, Vector3]> {
  featureEdges.sort((a, b) => b.length - a.length)
  return featureEdges
    .slice(0, MAX_EDGE_TARGETS)
    .map((e) => [points[e.i], points[e.j]] as const)
}

/** One target per coplanar patch, at its area-weighted centroid. */
function pickFaces(
  mesh: WeldedMesh,
  onCurve: Uint8Array,
  groups: UnionFind
): Array<{ origin: Vector3; normal: Vector3 }> {
  const { points } = mesh
  const byRoot = new Map<number, number[]>()
  for (let t = 0; t < mesh.a.length; t++) {
    if (onCurve[t]) continue
    const root = groups.find(t)
    const list = byRoot.get(root)
    if (list) list.push(t)
    else byRoot.set(root, [t])
  }

  const candidates: Array<{ origin: Vector3; normal: Vector3; area: number }> = []
  for (const list of byRoot.values()) {
    const origin = new Vector3()
    const normal = new Vector3()
    let area = 0
    for (const t of list) {
      const w = mesh.area[t]
      area += w
      origin.addScaledVector(points[mesh.a[t]], w / 3)
      origin.addScaledVector(points[mesh.b[t]], w / 3)
      origin.addScaledVector(points[mesh.c[t]], w / 3)
      normal.addScaledVector(mesh.normal[t], w)
    }
    if (!(area > 0) || normal.lengthSq() === 0) continue
    candidates.push({
      origin: origin.multiplyScalar(1 / area),
      normal: normal.normalize(),
      area,
    })
  }

  candidates.sort((a, b) => b.area - a.area)
  return candidates
    .slice(0, MAX_FACE_TARGETS)
    .map((c) => ({ origin: c.origin, normal: c.normal }))
}

// --- Memo ------------------------------------------------------------------

// Keyed on the geometry alone: the evaluator hands out a fresh BufferGeometry
// whenever the solid actually changes, so its uuid is exactly the identity we
// want, and a drag reuses one entry for its whole duration.
const memo = new Map<string, LocalTargets>()

function localTargetsFor(geometry: BufferGeometry): LocalTargets {
  const hit = memo.get(geometry.uuid)
  if (hit) {
    // Re-insert to mark it as the most recently used.
    memo.delete(geometry.uuid)
    memo.set(geometry.uuid, hit)
    return hit
  }
  const built = buildLocalTargets(geometry)
  memo.set(geometry.uuid, built)
  if (memo.size > MEMO_CAPACITY) {
    for (const oldest of memo.keys()) {
      memo.delete(oldest)
      break
    }
  }
  return built
}

// --- Target collection -----------------------------------------------------

export function objectSnapTargets(
  objectId: string,
  geometry: BufferGeometry,
  transform: ObjectTransform
): SnapTarget[] {
  const local = localTargetsFor(geometry)
  const matrix = objectMatrix(transform)
  // The object transform is rigid and unit-scaled, so the upper 3x3 IS the
  // rotation: normals need no inverse-transpose and stay unit length.
  const rotation = new Matrix3().setFromMatrix4(matrix)

  const out: SnapTarget[] = []
  for (const point of local.vertices) {
    out.push({ kind: 'vertex', objectId, point: point.clone().applyMatrix4(matrix) })
  }
  for (const [a, b] of local.edges) {
    out.push({
      kind: 'edge',
      objectId,
      a: a.clone().applyMatrix4(matrix),
      b: b.clone().applyMatrix4(matrix),
    })
  }
  for (const face of local.faces) {
    out.push({
      kind: 'face',
      objectId,
      origin: face.origin.clone().applyMatrix4(matrix),
      normal: face.normal.clone().applyMatrix3(rotation),
    })
  }
  return out
}

export function collectSnapTargets(
  entries: SnapEntry[],
  excludeObjectId?: string
): SnapTarget[] {
  const out: SnapTarget[] = []
  for (const entry of entries) {
    // Nothing snaps to itself: every one of its own corners is already at zero
    // distance, so the drag would freeze the moment it started.
    if (entry.id === excludeObjectId) continue
    for (const target of objectSnapTargets(entry.id, entry.geometry, entry.transform)) {
      out.push(target)
    }
  }
  return out
}

// --- Queries ---------------------------------------------------------------

const candidatePoint = new Vector3()
const gapVector = new Vector3()

/**
 * The translation that puts one of `sources` onto its nearest target.
 *
 * Brute force over sources x targets, which the caps above are what keep
 * affordable -- with one prepass, because the dragged thing is usually small
 * next to the scene it is being dragged through. Discarding every target
 * outside the sources' own bounds costs one linear scan and typically leaves a
 * handful of the thousands to test per source.
 */
export function snapTranslation(
  sources: Vector3[],
  targets: SnapTarget[],
  tol: number
): SnapHit | null {
  if (sources.length === 0 || targets.length === 0 || !(tol > 0)) return null

  const margin = tol * PRIORITY_MARGIN
  const reach = sourceBounds(sources, tol)
  const nearby = targets.filter((t) => withinBounds(t, reach))
  let best: SnapHit | null = null
  let bestScore = Infinity

  for (const source of sources) {
    for (const target of nearby) {
      const distance = closestOnTarget(source, target, tol, candidatePoint)
      // A candidate the source already sits on has a zero delta, so winning
      // costs it nothing and gains the user nothing -- but it still beats a
      // real corner or edge that would have to pay the priority handicap. A
      // source resting on a face plane is the common case, and it silently cut
      // the usable radius to 70% of the Distance setting for vertices and 35%
      // for edges while the indicator claimed a catch that moved nothing. The
      // handicap should only ever be paid by candidates that actually do
      // something.
      if (distance > tol || distance < 1e-6) continue
      // Rank on the handicapped score, but report the honest distance: callers
      // draw the snap indicator from it.
      const score = distance + PRIORITY[target.kind] * margin
      if (score >= bestScore) continue
      bestScore = score
      best = {
        delta: candidatePoint.clone().sub(source),
        point: candidatePoint.clone(),
        target,
        distance,
      }
    }
  }
  return best
}

export function snapSinglePoint(
  p: Vector3,
  targets: SnapTarget[],
  tol: number
): SnapHit | null {
  return snapTranslation([p], targets, tol)
}

type Bounds = { min: Vector3; max: Vector3 }

/** The sources' axis-aligned extent, grown by the tolerance so nothing that
 *  could still be reached falls outside it. */
function sourceBounds(sources: Vector3[], tol: number): Bounds {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const s of sources) {
    min.min(s)
    max.max(s)
  }
  return {
    min: min.subScalar(tol),
    max: max.addScalar(tol),
  }
}

function withinBounds(target: SnapTarget, bounds: Bounds): boolean {
  const { min, max } = bounds
  switch (target.kind) {
    case 'vertex': {
      const p = target.point
      return (
        p.x >= min.x && p.x <= max.x &&
        p.y >= min.y && p.y <= max.y &&
        p.z >= min.z && p.z <= max.z
      )
    }
    case 'edge': {
      const { a, b } = target
      return (
        Math.max(a.x, b.x) >= min.x && Math.min(a.x, b.x) <= max.x &&
        Math.max(a.y, b.y) >= min.y && Math.min(a.y, b.y) <= max.y &&
        Math.max(a.z, b.z) >= min.z && Math.min(a.z, b.z) <= max.z
      )
    }
    case 'face':
      // A plane is unbounded on purpose, so there is nothing to reject against.
      return true
  }
}

/** Distance from `p` to `target`, writing the landing point into `out`.
 *  Returns Infinity for anything the cheap bounds test can already reject. */
function closestOnTarget(
  p: Vector3,
  target: SnapTarget,
  tol: number,
  out: Vector3
): number {
  switch (target.kind) {
    case 'vertex': {
      const q = target.point
      if (Math.abs(p.x - q.x) > tol) return Infinity
      if (Math.abs(p.y - q.y) > tol) return Infinity
      if (Math.abs(p.z - q.z) > tol) return Infinity
      out.copy(q)
      return p.distanceTo(q)
    }
    case 'edge': {
      const { a, b } = target
      if (p.x < Math.min(a.x, b.x) - tol || p.x > Math.max(a.x, b.x) + tol) return Infinity
      if (p.y < Math.min(a.y, b.y) - tol || p.y > Math.max(a.y, b.y) + tol) return Infinity
      if (p.z < Math.min(a.z, b.z) - tol || p.z > Math.max(a.z, b.z) + tol) return Infinity
      closestOnSegment(p, a, b, out)
      return p.distanceTo(out)
    }
    case 'face': {
      // A face target is its whole plane, with no lateral bound. That is the
      // point: it is what makes two faces go flush at any offset along them.
      const gap = gapVector.subVectors(p, target.origin).dot(target.normal)
      out.copy(p).addScaledVector(target.normal, -gap)
      return Math.abs(gap)
    }
  }
}

/** Clamped to the ends, so an edge target stops where the edge does rather than
 *  attracting things off the end of its infinite line. */
function closestOnSegment(p: Vector3, a: Vector3, b: Vector3, out: Vector3): void {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const lengthSq = abx * abx + aby * aby + abz * abz
  if (lengthSq <= 0) {
    out.copy(a)
    return
  }
  const raw = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lengthSq
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
  out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t)
}

// --- Axis-constrained snapping ----------------------------------------------

/**
 * How far along `axis` the dragged solid must slide for one of its corners to
 * meet something in the scene.
 *
 * A separate solve rather than `snapTranslation` filtered afterwards, because
 * the two ask genuinely different questions. `snapTranslation` finds the
 * nearest target in any direction and hands back a three-axis correction; an
 * arrow drag may only slide along its own axis, so taking that correction and
 * throwing away the components it is not allowed to use would leave the solid
 * NOT touching what the indicator claims it caught. Here the constraint is
 * inside the search: every candidate is an offset along the axis, and it only
 * counts if the corner genuinely lands on the target once it has slid there.
 *
 * `axis` must be a unit vector. `sources` are the corners as they sit now.
 */
export function snapAlongAxis(
  sources: Vector3[],
  targets: SnapTarget[],
  axis: Vector3,
  tol: number
): SnapHit | null {
  if (sources.length === 0 || targets.length === 0 || !(tol > 0)) return null

  const margin = tol * PRIORITY_MARGIN
  const reach = sourceBounds(sources, tol)
  // The sources sweep along the axis, so the cheap bounds prepass has to admit
  // anything within reach of the swept line, not just of where they sit now.
  reach.min.addScaledVector(axis, -tol)
  reach.max.addScaledVector(axis, tol)
  const box = {
    min: new Vector3(
      Math.min(reach.min.x, reach.max.x),
      Math.min(reach.min.y, reach.max.y),
      Math.min(reach.min.z, reach.max.z)
    ),
    max: new Vector3(
      Math.max(reach.min.x, reach.max.x),
      Math.max(reach.min.y, reach.max.y),
      Math.max(reach.min.z, reach.max.z)
    ),
  }
  const nearby = targets.filter((t) => withinBounds(t, box))

  let best: SnapHit | null = null
  let bestScore = Infinity

  for (const source of sources) {
    for (const target of nearby) {
      const offset = axialOffsetTo(source, target, axis)
      if (offset === null) continue
      const slid = source.clone().addScaledVector(axis, offset)
      // The corner has to actually ARRIVE. An offset exists for almost every
      // target -- it is the point of closest approach -- and without this the
      // arrow would catch on anything roughly in front of it.
      if (distanceToTarget(slid, target) > RESIDUE_TOL) continue
      const distance = Math.abs(offset)
      // Same reasoning as `snapTranslation`: a candidate the corner already
      // sits on wins for free and moves nothing.
      if (distance > tol || distance < 1e-6) continue
      const score = distance + PRIORITY[target.kind] * margin
      if (score >= bestScore) continue
      bestScore = score
      best = {
        delta: axis.clone().multiplyScalar(offset),
        point: slid,
        target,
        distance,
      }
    }
  }
  return best
}

/**
 * How close a slid corner has to land to count as having met its target.
 *
 * Not zero: the offsets below are exact for a plane and a point, but an edge is
 * solved as a clamped line-line approach, where a corner passing a hair to one
 * side of the segment end is still the catch the user meant.
 */
// Raised with the envelope: this is a WORLD distance, and out at the far
// corner of the scene float32 steps by about 7.6e-6, so a residue judged
// against 1e-6 was being asked to resolve below the noise floor.
const RESIDUE_TOL = 1e-4

/** Distance from an arrived point to the target it was aimed at. */
function distanceToTarget(p: Vector3, target: SnapTarget): number {
  switch (target.kind) {
    case 'vertex':
      return p.distanceTo(target.point)
    case 'edge': {
      const foot = new Vector3()
      closestOnSegment(p, target.a, target.b, foot)
      return p.distanceTo(foot)
    }
    case 'face':
      return Math.abs(p.clone().sub(target.origin).dot(target.normal))
  }
}

/**
 * The slide along `axis` that brings `source` closest to `target`, or null
 * where the geometry makes the question meaningless -- a plane the axis runs
 * parallel to has either no solution or every solution, and neither is a snap.
 */
function axialOffsetTo(source: Vector3, target: SnapTarget, axis: Vector3): number | null {
  switch (target.kind) {
    case 'vertex':
      // Closest approach of the swept line to a point is its projection.
      return target.point.clone().sub(source).dot(axis)

    case 'face': {
      const denom = axis.dot(target.normal)
      if (Math.abs(denom) < 1e-9) return null
      return target.origin.clone().sub(source).dot(target.normal) / denom
    }

    case 'edge': {
      // Closest approach between the swept line and the edge's line, with the
      // edge parameter clamped to the segment -- then the offset re-read off
      // that clamped point, so an approach that fell beyond the edge's end
      // resolves against the end itself rather than off in space.
      const ab = target.b.clone().sub(target.a)
      const lengthSq = ab.lengthSq()
      if (lengthSq < 1e-12) return target.a.clone().sub(source).dot(axis)

      const w0 = source.clone().sub(target.a)
      const b = axis.dot(ab)
      const d = axis.dot(w0)
      const e = ab.dot(w0)
      const denom = lengthSq - b * b
      // Parallel: every point of the swept line is equidistant, so the nearest
      // edge point is simply the foot of the source.
      const u =
        Math.abs(denom) < 1e-12
          ? Math.min(1, Math.max(0, -e / lengthSq))
          : Math.min(1, Math.max(0, (b * d - e) / -denom))
      const point = target.a.clone().addScaledVector(ab, u)
      return point.sub(source).dot(axis)
    }
  }
}
