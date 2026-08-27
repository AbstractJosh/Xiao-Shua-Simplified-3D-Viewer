import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2, Vector3 } from 'three'
import { MM_PER_UNIT } from './step'

/**
 * Reading ISO 10303-21 back in: the mirror of `step.ts`, and deliberately a
 * separate file from it.
 *
 * The writer knows how to say a solid in STEP. This knows how to hear one, and
 * the two jobs share nothing but the grammar -- the writer builds topology it
 * already owns, where this has to rebuild geometry out of references that point
 * at each other in any order the exporter felt like emitting them.
 *
 * WHAT IT READS, and what it does not. A STEP face is a bounded patch of a
 * SURFACE, and the surface can be a plane, a cylinder, a cone, a torus or a
 * NURBS patch. This reads the PLANES -- bounded by straight edges and circular
 * arcs -- and skips the rest, counting them so the caller can say so out loud.
 *
 * That is not the compromise it sounds like for this app's own files. Everything
 * `step.ts` writes is planar, because by the time geometry reaches it the
 * booleans have already turned every curve into flat strips: a cylinder exports
 * as forty-eight of them and comes back as forty-eight of them. So a round trip
 * through STEP is lossless HERE, and a file from a real CAD package arrives with
 * its flat faces intact and its curved ones missing -- which is a partial
 * import, honestly reported, rather than a silent lie about a surface nobody
 * tessellated.
 */

export type StepImport = {
  /** Triangles, in SCENE UNITS, wound so their normals point out of the solid. */
  geometry: BufferGeometry
  /** Planar faces read back out of the file. */
  faces: number
  /** Faces skipped: a curved surface, or an edge this cannot follow. */
  skipped: number
}

// --- Grammar ----------------------------------------------------------------

/** One record: everything to the right of `#id=`, up to its semicolon. */
type Body = string

/**
 * Split a parameter list on the commas that are actually SEPARATORS.
 *
 * A STEP parameter list nests -- `(#1,(#2,#3),'a,b')` is three parameters, not
 * five -- so this tracks paren depth and string state rather than reaching for
 * `split(',')`. Quotes double up inside a string, and a doubled quote is
 * indistinguishable from a close followed by an open at this level: both simply
 * flip the flag twice and land back where they started.
 */
function splitArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === "'") quoted = false
      continue
    }
    if (c === "'") quoted = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last.length > 0 || out.length > 0) out.push(last)
  return out
}

/** The identifier at the head of a simple record: `PLANE('',#4)` -> `PLANE`. */
function typeOf(body: Body): string {
  const open = body.indexOf('(')
  return open < 0 ? body.trim() : body.slice(0, open).trim()
}

/** The parameters of `TYPE(...)`, or of the first `TYPE(...)` inside a complex
 *  record -- `( LENGTH_UNIT() SI_UNIT(.MILLI.,.METRE.) )` holds several. */
function argsOf(body: Body, type?: string): string[] | null {
  if (type === undefined) {
    const open = body.indexOf('(')
    if (open < 0 || !body.endsWith(')')) return null
    return splitArgs(body.slice(open + 1, -1))
  }
  // Word-boundary search, so ADVANCED_FACE is never found by looking for FACE.
  const pattern = new RegExp(`(^|[^A-Z0-9_])${type}\\s*\\(`)
  const found = pattern.exec(body)
  if (!found) return null
  const open = found.index + found[0].length - 1
  let depth = 0
  let quoted = false
  for (let i = open; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === "'") quoted = false
      continue
    }
    if (c === "'") quoted = true
    else if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return splitArgs(body.slice(open + 1, i))
    }
  }
  return null
}

const isRef = (arg: string): boolean => arg.startsWith('#')

/** A STEP boolean: `.T.` is true, and anything else -- `.F.`, `.U.` -- is not. */
const isTrue = (arg: string): boolean => arg === '.T.'

function num(arg: string): number {
  const value = Number.parseFloat(arg)
  return Number.isFinite(value) ? value : 0
}

/**
 * Every record in the file, keyed by reference.
 *
 * One pass, character by character, because none of the cheap shortcuts hold:
 * a record can span any number of lines, a comment can sit in the middle of
 * one, and a semicolon inside a string is not the end of anything.
 */
function scan(text: string): Map<string, Body> {
  const records = new Map<string, Body>()

  let current = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (quoted) {
      current += c
      if (c === "'") quoted = false
      continue
    }

    if (c === "'") {
      quoted = true
      current += c
      continue
    }

    // Comments are stripped rather than kept, and only outside a string: `/*`
    // inside a name is part of the name.
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }

    if (c === ';') {
      const record = current.trim()
      current = ''
      if (record.length === 0) continue
      // Only the numbered records. The HEADER section's are the file's
      // paperwork -- who wrote it, when, which schema -- and nothing here is
      // built out of any of it.
      const equals = record.indexOf('=')
      if (record.startsWith('#') && equals > 0) {
        records.set(record.slice(0, equals).trim(), record.slice(equals + 1).trim())
      }
      continue
    }

    // Whitespace collapses to nothing: STEP has no significant spacing outside
    // strings, and dropping it makes every later `indexOf` cheaper and simpler.
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue
    current += c
  }

  return records
}

// --- Units ------------------------------------------------------------------

const SI_PREFIX: Record<string, number> = {
  '$': 1,
  '.KILO.': 1e3,
  '.HECTO.': 1e2,
  '.DECA.': 1e1,
  '.DECI.': 1e-1,
  '.CENTI.': 1e-2,
  '.MILLI.': 1e-3,
  '.MICRO.': 1e-6,
  '.NANO.': 1e-9,
}

/** Metres per unit of a length-unit record, or null if it is not one. */
function metresOf(records: Map<string, Body>, ref: string, depth = 0): number | null {
  const body = records.get(ref)
  // Bounded because a malformed file can point a conversion unit back at itself.
  if (!body || depth > 4 || !body.includes('LENGTH_UNIT')) return null

  const conversion = argsOf(body, 'CONVERSION_BASED_UNIT')
  if (conversion && conversion.length >= 2 && isRef(conversion[1])) {
    // An inch is defined as a MEASURE IN some SI unit -- 25.4 of the
    // millimetres defined elsewhere in the same file -- so both the factor and
    // the unit it is counted in have to be followed to reach metres.
    const measure = records.get(conversion[1])
    const args = measure ? argsOf(measure) : null
    if (args && args.length >= 2 && isRef(args[1])) {
      const si = metresOf(records, args[1], depth + 1)
      // `LENGTH_MEASURE(25.4)` wraps the number; a bare `25.4` is also legal.
      const wrapped = argsOf(args[0])
      if (si !== null) return num(wrapped ? wrapped[0] : args[0]) * si
    }
  }

  const si = argsOf(body, 'SI_UNIT')
  if (si && si.length >= 2 && si[1] === '.METRE.') return SI_PREFIX[si[0]] ?? 1
  return null
}

/**
 * How many scene units one file unit is worth.
 *
 * The length unit is taken from the representation context, which is where the
 * file SAYS which of its units the coordinates are in -- a file that defines
 * both inches and the millimetres they are defined in holds two length units,
 * and only one of them is the answer. Falling back to whatever length unit
 * turns up, and then to millimetres, which is what `step.ts` writes and what
 * almost every mechanical CAD package exports.
 */
function unitScale(records: Map<string, Body>): number {
  let metres: number | null = null

  for (const [, body] of records) {
    if (!body.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT')) continue
    const units = argsOf(body, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')
    if (!units || units.length === 0) continue
    for (const ref of splitArgs(units[0].replace(/^\(|\)$/g, ''))) {
      if (!isRef(ref)) continue
      const found = metresOf(records, ref)
      if (found !== null) {
        metres = found
        break
      }
    }
    if (metres !== null) break
  }

  if (metres === null) {
    for (const ref of records.keys()) {
      const found = metresOf(records, ref)
      if (found !== null) {
        metres = found
        break
      }
    }
  }

  // A scene unit is ten centimetres, and `MM_PER_UNIT` is the writer's half of
  // exactly this conversion -- shared rather than restated so the two cannot
  // drift and leave a round trip a hundred times too big.
  const millimetres = (metres ?? 1e-3) * 1000
  return millimetres / MM_PER_UNIT
}

// --- Geometry ---------------------------------------------------------------

/** How many segments a full circle is cut into. Matches `LATHE_SEGMENTS`, so a
 *  circular hole comes back at the same fidelity the app draws one at. */
const ARC_SEGMENTS = 48

const EPS = 1e-9

type Placement = { origin: Vector3; axis: Vector3; ref: Vector3 }

/** Everything resolved out of the file, ready for the faces to be walked. */
class Model {
  private points = new Map<string, Vector3>()
  private directions = new Map<string, Vector3>()

  constructor(
    readonly records: Map<string, Body>,
    readonly scale: number
  ) {}

  private body(ref: string): Body | null {
    return this.records.get(ref) ?? null
  }

  /** A CARTESIAN_POINT, already in scene units. */
  point(ref: string): Vector3 | null {
    const cached = this.points.get(ref)
    if (cached) return cached
    const body = this.body(ref)
    const args = body ? argsOf(body, 'CARTESIAN_POINT') : null
    if (!args || args.length < 2) return null
    const coords = splitArgs(args[1].replace(/^\(|\)$/g, ''))
    if (coords.length < 3) return null
    const p = new Vector3(num(coords[0]), num(coords[1]), num(coords[2])).multiplyScalar(
      this.scale
    )
    this.points.set(ref, p)
    return p
  }

  /** A DIRECTION. Never scaled: a scaled unit vector is no longer a unit vector. */
  direction(ref: string): Vector3 | null {
    const cached = this.directions.get(ref)
    if (cached) return cached
    const body = this.body(ref)
    const args = body ? argsOf(body, 'DIRECTION') : null
    if (!args || args.length < 2) return null
    const coords = splitArgs(args[1].replace(/^\(|\)$/g, ''))
    if (coords.length < 3) return null
    const d = new Vector3(num(coords[0]), num(coords[1]), num(coords[2]))
    if (d.lengthSq() < EPS) return null
    d.normalize()
    this.directions.set(ref, d)
    return d
  }

  vertex(ref: string): Vector3 | null {
    const body = this.body(ref)
    if (!body) return null
    const args = argsOf(body, 'VERTEX_POINT')
    if (!args || args.length < 2 || !isRef(args[1])) return null
    return this.point(args[1])
  }

  placement(ref: string): Placement | null {
    const body = this.body(ref)
    const args = body ? argsOf(body, 'AXIS2_PLACEMENT_3D') : null
    if (!args || args.length < 2 || !isRef(args[1])) return null
    const origin = this.point(args[1])
    if (!origin) return null
    const axis =
      args.length >= 3 && isRef(args[2]) ? this.direction(args[2]) : null
    const ref2 = args.length >= 4 && isRef(args[3]) ? this.direction(args[3]) : null
    return {
      origin,
      axis: axis ?? new Vector3(0, 0, 1),
      ref: ref2 ?? new Vector3(1, 0, 0),
    }
  }
}

/** Any unit vector square to this one, built off the axis it leans on least. */
function perpendicular(n: Vector3): Vector3 {
  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  const axis =
    ax <= ay && ax <= az
      ? new Vector3(1, 0, 0)
      : ay <= az
        ? new Vector3(0, 1, 0)
        : new Vector3(0, 0, 1)
  return new Vector3().crossVectors(n, axis).normalize()
}

/**
 * The points along one edge, from `from` to `to`, EXCLUDING both ends.
 *
 * Only an arc has any: a straight edge is fully described by the vertices the
 * loop already carries. Returns null when the curve is one this cannot follow,
 * which fails the whole face rather than closing it with a chord that is not
 * where the edge actually ran.
 */
function edgeInterior(
  model: Model,
  curveRef: string,
  from: Vector3,
  to: Vector3
): Vector3[] | null {
  const body = model.records.get(curveRef)
  if (!body) return null
  const type = typeOf(body)

  if (type === 'LINE') return []

  if (type === 'CIRCLE') {
    const args = argsOf(body, 'CIRCLE')
    if (!args || args.length < 3 || !isRef(args[1])) return null
    const place = model.placement(args[1])
    if (!place) return null
    const radius = num(args[2]) * model.scale
    if (radius <= EPS) return null

    // The circle's own frame: u along the placement's reference direction with
    // any component along the axis taken out, v square to both.
    const n = place.axis.clone().normalize()
    const u = place.ref.clone().addScaledVector(n, -place.ref.dot(n))
    if (u.lengthSq() < EPS) u.copy(perpendicular(n))
    u.normalize()
    const v = new Vector3().crossVectors(n, u)

    const angle = (p: Vector3): number => {
      const rel = p.clone().sub(place.origin)
      return Math.atan2(rel.dot(v), rel.dot(u))
    }
    const a = angle(from)
    const b = angle(to)
    // A closed circle -- one vertex used twice -- sweeps the whole way round.
    // Anything else takes the increasing-parameter arc, which is the direction
    // an EDGE_CURVE runs in by definition once its sense has been applied.
    let sweep = b - a
    while (sweep <= EPS) sweep += Math.PI * 2
    if (from.distanceTo(to) < radius * 1e-6) sweep = Math.PI * 2

    const steps = Math.max(2, Math.ceil((ARC_SEGMENTS * sweep) / (Math.PI * 2)))
    const out: Vector3[] = []
    for (let i = 1; i < steps; i++) {
      const t = a + (sweep * i) / steps
      out.push(
        place.origin
          .clone()
          .addScaledVector(u, radius * Math.cos(t))
          .addScaledVector(v, radius * Math.sin(t))
      )
    }
    return out
  }

  return null
}

/** One EDGE_LOOP walked into a closed polygon, or null if any edge defeated it. */
function loopPoints(model: Model, loopRef: string): Vector3[] | null {
  const body = model.records.get(loopRef)
  const args = body ? argsOf(body, 'EDGE_LOOP') : null
  if (!args || args.length < 2) return null

  const out: Vector3[] = []
  for (const orientedRef of splitArgs(args[1].replace(/^\(|\)$/g, ''))) {
    if (!isRef(orientedRef)) return null
    const oriented = model.records.get(orientedRef)
    const oArgs = oriented ? argsOf(oriented, 'ORIENTED_EDGE') : null
    if (!oArgs || oArgs.length < 5 || !isRef(oArgs[3])) return null
    const forward = isTrue(oArgs[4])

    const edge = model.records.get(oArgs[3])
    const eArgs = edge ? argsOf(edge, 'EDGE_CURVE') : null
    if (!eArgs || eArgs.length < 5 || !isRef(eArgs[1]) || !isRef(eArgs[2])) return null

    const v1 = model.vertex(eArgs[1])
    const v2 = model.vertex(eArgs[2])
    if (!v1 || !v2) return null

    // The edge runs start -> end; `same_sense` says whether the underlying
    // curve agrees, and the oriented edge says whether this loop walks it
    // forwards. Both flips land on the same pair of ends.
    const sameSense = isTrue(eArgs[4])
    const start = forward ? v1 : v2
    const end = forward ? v2 : v1

    if (!isRef(eArgs[3])) return null
    const interior = edgeInterior(
      model,
      eArgs[3],
      sameSense === forward ? start : end,
      sameSense === forward ? end : start
    )
    if (!interior) return null

    out.push(start)
    for (const p of sameSense === forward ? interior : [...interior].reverse()) out.push(p)
  }

  return out.length >= 3 ? out : null
}

/** Newell's normal: independent of where the origin sits, so it stays exact for
 *  a face parked far from it. */
function newellNormal(loop: Vector3[]): Vector3 {
  const n = new Vector3()
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    n.x += (a.y - b.y) * (a.z + b.z)
    n.y += (a.z - b.z) * (a.x + b.x)
    n.z += (a.x - b.x) * (a.y + b.y)
  }
  return n.lengthSq() < EPS ? new Vector3(0, 1, 0) : n.normalize()
}

/**
 * Triangulate one planar face: an outer loop, any number of holes, and the
 * normal the file says it faces.
 *
 * Earcut does the work in 2D, so the loops are projected into a right-handed
 * frame on the plane. That projection is what fixes the winding: a contour
 * wound counter-clockwise in a (u, v) frame whose u x v is the normal is a
 * contour wound counter-clockwise ABOUT the normal, which is exactly the
 * outward winding the rest of the app expects.
 */
function triangulateFace(
  outer: Vector3[],
  holes: Vector3[][],
  normal: Vector3,
  out: number[]
): boolean {
  const u = perpendicular(normal)
  const v = new Vector3().crossVectors(normal, u)
  const origin = outer[0]
  const flatten = (loop: Vector3[]): Vector2[] =>
    loop.map((p) => {
      const rel = p.clone().sub(origin)
      return new Vector2(rel.dot(u), rel.dot(v))
    })

  const contour = flatten(outer)
  if (ShapeUtils.isClockWise(contour)) {
    contour.reverse()
    outer = [...outer].reverse()
  }
  const flatHoles: Vector2[][] = []
  const holeSources: Vector3[][] = []
  for (const hole of holes) {
    const flat = flatten(hole)
    // A hole runs the other way round from the face it is cut in.
    if (!ShapeUtils.isClockWise(flat)) {
      flat.reverse()
      holeSources.push([...hole].reverse())
    } else {
      holeSources.push(hole)
    }
    flatHoles.push(flat)
  }

  let faces: number[][]
  try {
    // Called BEFORE the sources are concatenated: it trims a repeated closing
    // point off each loop in place, and the indices it returns count the
    // trimmed lists.
    faces = ShapeUtils.triangulateShape(contour, flatHoles)
  } catch {
    return false
  }
  if (faces.length === 0) return false

  const all: Vector3[] = [...outer.slice(0, contour.length)]
  for (let i = 0; i < holeSources.length; i++) {
    all.push(...holeSources[i].slice(0, flatHoles[i].length))
  }

  for (const [a, b, c] of faces) {
    const pa = all[a]
    const pb = all[b]
    const pc = all[c]
    if (!pa || !pb || !pc) continue
    out.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z)
  }
  return true
}

/**
 * Read a STEP part file into triangles.
 *
 * Every ADVANCED_FACE in the file is taken, whichever shell or body it belongs
 * to: several bodies in one file arrive as one mesh, which is what an import is
 * -- a single object the user then sizes, moves and cuts like any other.
 */
export function parseStep(text: string): StepImport {
  const records = scan(text)
  if (records.size === 0) {
    throw new Error('Not a STEP file: no entities found.')
  }

  const model = new Model(records, unitScale(records))
  const positions: number[] = []
  let faces = 0
  let skipped = 0

  for (const [, body] of records) {
    const args = argsOf(body, 'ADVANCED_FACE') ?? argsOf(body, 'FACE_SURFACE')
    if (!args || args.length < 4) continue

    // Only planes. A cylindrical or NURBS patch would need its own
    // tessellation, and a plane through its boundary is not that surface.
    const surface = isRef(args[2]) ? records.get(args[2]) : null
    const planeArgs = surface ? argsOf(surface, 'PLANE') : null
    if (!planeArgs || planeArgs.length < 2 || !isRef(planeArgs[1])) {
      skipped++
      continue
    }
    const place = model.placement(planeArgs[1])
    if (!place) {
      skipped++
      continue
    }

    let outer: Vector3[] | null = null
    const holes: Vector3[][] = []
    let broke = false

    for (const boundRef of splitArgs(args[1].replace(/^\(|\)$/g, ''))) {
      if (!isRef(boundRef)) {
        broke = true
        break
      }
      const bound = records.get(boundRef)
      if (!bound) {
        broke = true
        break
      }
      const isOuter = typeOf(bound) === 'FACE_OUTER_BOUND'
      const bArgs = argsOf(bound) ?? []
      if (bArgs.length < 3 || !isRef(bArgs[1])) {
        broke = true
        break
      }
      const loop = loopPoints(model, bArgs[1])
      if (!loop) {
        broke = true
        break
      }
      // A bound may be stored reversed; the flag says so.
      const points = isTrue(bArgs[2]) ? loop : [...loop].reverse()
      // The first bound wins the outer slot when nothing is marked outer, which
      // is how some writers emit a face with no holes at all.
      if (isOuter || outer === null) {
        if (outer !== null) holes.push(outer)
        outer = points
      } else {
        holes.push(points)
      }
    }

    if (broke || !outer) {
      skipped++
      continue
    }

    // The face's own normal, from the plane it stands on, turned round when the
    // face says it faces the other way. Falling back to the outer loop's own
    // winding for a file that omitted the flag.
    const normal = place.axis.clone()
    if (args.length >= 4 && !isTrue(args[3])) normal.negate()
    if (normal.lengthSq() < EPS) normal.copy(newellNormal(outer))
    else normal.normalize()

    if (triangulateFace(outer, holes, normal, positions)) faces++
    else skipped++
  }

  if (positions.length === 0) {
    throw new Error(
      skipped > 0
        ? `No planar faces in this STEP file: all ${skipped} faces are curved surfaces, which cannot be read yet.`
        : 'No solid geometry found in this STEP file.'
    )
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  // Non-indexed, so this is a flat normal per triangle -- which is what a
  // faceted B-rep should shade like, and what `facesToGeometry` already does
  // for the primitives.
  geometry.computeVertexNormals()

  return { geometry, faces, skipped }
}
