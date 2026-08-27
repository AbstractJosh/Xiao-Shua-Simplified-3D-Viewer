import type { BufferGeometry } from 'three'
import {
  COPLANAR_TOLERANCE,
  MAX_BREP_VERTICES,
  flatFaces,
  healTJunctions,
  indexByPosition,
  isManifold,
  shells,
} from './brep'
import type { BrepFace, BrepMesh } from './brep'
import type { Vec3 } from './types'

/**
 * STEP AP214, written by hand.
 *
 * three.js has no STEP exporter and could not sensibly have one: GLB, OBJ and
 * STL all describe a surface made of triangles, and STEP describes a SOLID --
 * faces on surfaces, bounded by edges on curves, bounded by vertices on points,
 * each shared by exactly the neighbours that meet along it. `brep.ts` recovers
 * that topology from the evaluator's triangle soup; this file is the part that
 * knows ISO 10303-21 syntax and nothing else.
 *
 * THE FACES ARE PLANAR. Every face this writes is a plane bounded by straight
 * edges, because that is what the geometry genuinely is by the time it gets
 * here: the evaluator's booleans consume analytic surfaces and hand back
 * triangles, so a cylinder has already become forty-eight flat strips and no
 * amount of care at this end can turn them back into a cylinder. What the file
 * does carry is real topology -- a cube is six faces and not twelve, a drilled
 * face is one face with a hole in it -- so it opens as a body you can select,
 * measure, cut and boolean, rather than as a bag of loose facets.
 *
 * Units are MILLIMETRES, one scene unit to one millimetre. The app's own units
 * are abstract, so any mapping is a convention; millimetres is the one every
 * mechanical CAD package opens in without asking.
 */

/** What a written file turned out to be, for the receipt in the export bar. */
export type StepResult = {
  text: string
  /** Closed shells, written as solid bodies. */
  solids: number
  /** Shells that would not close, written as surface bodies instead. */
  surfaces: number
  faces: number
  /** Cracks the T-junction repair could not close. Zero on almost everything. */
  openEdges: number
}

/** The accuracy the file claims, in scene units. It is the flatness tolerance
 *  `brep.ts` merges faces within, since that is the largest distance by which
 *  anything here departs from what the evaluator produced. */
const UNCERTAINTY = COPLANAR_TOLERANCE

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l === 0 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * A real, as ISO 10303-21 spells one: it must carry a decimal point, so `1`
 * has to be written `1.` and JavaScript's `1e-7` has to become `1.E-7`.
 *
 * Rounded to nine decimals first. The coordinates arriving here have been
 * through a Float32Array and carry about seven significant digits, so the tail
 * beyond that is float noise -- and writing it out would triple the size of a
 * file that is already the largest of the four formats.
 */
export function real(n: number): string {
  const value = Math.abs(n) < 1e-11 ? 0 : n
  const text = String(Number(value.toFixed(9)))
  if (text.includes('e') || text.includes('E')) {
    const [mantissa, exponent] = text.split(/[eE]/)
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.`}E${exponent}`
  }
  return text.includes('.') ? text : `${text}.`
}

/** A STEP string literal. Quotes double up, and anything outside plain ASCII is
 *  dropped rather than escaped -- these are names we choose, not user text. */
function text(value: string): string {
  return `'${value.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '')}'`
}

/**
 * The entity table, built as it is written.
 *
 * Every `add` returns the reference to put in the entities that point at it,
 * and the deduplicating helpers beside it are not an optimisation but the whole
 * mechanism: two faces meeting along an edge have to name the SAME
 * `EDGE_CURVE`, or the file says they merely happen to touch.
 */
class Entities {
  readonly lines: string[] = []
  private readonly cache = new Map<string, string>()

  add(body: string): string {
    const id = `#${this.lines.length + 1}`
    this.lines.push(`${id}=${body};`)
    return id
  }

  /** Add once per distinct key, and hand back the same reference after that. */
  shared(key: string, build: () => string): string {
    const hit = this.cache.get(key)
    if (hit) return hit
    const id = this.add(build())
    this.cache.set(key, id)
    return id
  }

  direction(d: Vec3): string {
    const v = unit(d)
    return this.shared(`d:${real(v[0])},${real(v[1])},${real(v[2])}`, () =>
      `DIRECTION('',(${real(v[0])},${real(v[1])},${real(v[2])}))`
    )
  }
}

/** Any unit vector square to this one. Built from whichever axis it leans on
 *  least, so the cross product is never taken between near-parallel vectors. */
function perpendicular(n: Vec3): Vec3 {
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  return unit(cross(n, axis))
}

/** Everything about one shell that the writer needs to reference by vertex. */
type VertexRefs = {
  point: (v: number) => string
  vertex: (v: number) => string
}

function vertexRefs(entities: Entities, mesh: BrepMesh): VertexRefs {
  const points = new Map<number, string>()
  const vertices = new Map<number, string>()
  const point = (v: number): string => {
    const hit = points.get(v)
    if (hit) return hit
    const id = entities.add(
      `CARTESIAN_POINT('',(${real(mesh.points[v * 3])},${real(mesh.points[v * 3 + 1])},${real(
        mesh.points[v * 3 + 2]
      )}))`
    )
    points.set(v, id)
    return id
  }
  return {
    point,
    // Through `point`, never through the cache directly: a vertex is often
    // reached before anything has asked for its point, and a VERTEX_POINT with
    // an empty reference is a file no reader will open.
    vertex: (v) => {
      const hit = vertices.get(v)
      if (hit) return hit
      const id = entities.add(`VERTEX_POINT('',${point(v)})`)
      vertices.set(v, id)
      return id
    },
  }
}

/**
 * Write one shell's faces, returning the reference of its CLOSED or OPEN shell.
 *
 * `EDGE_CURVE`s are keyed on the pair of vertices, LOWEST FIRST, so the two
 * faces that meet along an edge find the same entity however each of them
 * happens to be walking round its own boundary. Which way round a given face
 * travels it is then said once, by the `ORIENTED_EDGE` -- and that is the
 * difference between a solid and two faces that merely share a line.
 */
function writeShell(
  entities: Entities,
  mesh: BrepMesh,
  faces: BrepFace[],
  closed: boolean
): string {
  const refs = vertexRefs(entities, mesh)
  const edges = new Map<number, string>()

  const edgeCurve = (a: number, b: number): string => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = lo * MAX_BREP_VERTICES + hi
    const hit = edges.get(key)
    if (hit) return hit

    const from: Vec3 = [mesh.points[lo * 3], mesh.points[lo * 3 + 1], mesh.points[lo * 3 + 2]]
    const to: Vec3 = [mesh.points[hi * 3], mesh.points[hi * 3 + 1], mesh.points[hi * 3 + 2]]
    const span: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
    const length = Math.hypot(span[0], span[1], span[2])

    // The line is anchored on the low vertex's OWN point, so the curve and the
    // vertex cannot disagree about where the edge begins. The vector is shared
    // across every edge of the same direction and length, of which a boxy model
    // has a great many.
    const direction = entities.direction(span)
    const vector = entities.shared(`v:${direction}:${real(length)}`, () =>
      `VECTOR('',${direction},${real(length)})`
    )
    const line = entities.add(`LINE('',${refs.point(lo)},${vector})`)
    const id = entities.add(
      `EDGE_CURVE('',${refs.vertex(lo)},${refs.vertex(hi)},${line},.T.)`
    )
    edges.set(key, id)
    return id
  }

  const faceRefs: string[] = []
  for (const face of faces) {
    const normal = unit(face.normal)
    const bounds: string[] = []
    face.loops.forEach((loop, at) => {
      const oriented: string[] = []
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]
        const b = loop[(i + 1) % loop.length]
        const curve = edgeCurve(a, b)
        oriented.push(`ORIENTED_EDGE('',*,*,${curve},${a < b ? '.T.' : '.F.'})`)
      }
      const ids = oriented.map((body) => entities.add(body))
      const edgeLoop = entities.add(`EDGE_LOOP('',(${ids.join(',')}))`)
      // The first loop is the one running with the face; the rest are holes,
      // and `flatFaces` has already checked they run the other way.
      bounds.push(
        entities.add(
          at === 0
            ? `FACE_OUTER_BOUND('',${edgeLoop},.T.)`
            : `FACE_BOUND('',${edgeLoop},.T.)`
        )
      )
    })

    // The plane stands on a corner the face already owns -- see `BrepFace` --
    // so this is the same CARTESIAN_POINT its edges are built from.
    const placement = entities.add(
      `AXIS2_PLACEMENT_3D('',${refs.point(face.origin)},${entities.direction(
        normal
      )},${entities.direction(perpendicular(normal))})`
    )
    const plane = entities.add(`PLANE('',${placement})`)
    faceRefs.push(entities.add(`ADVANCED_FACE('',(${bounds.join(',')}),${plane},.T.)`))
  }

  return entities.add(
    `${closed ? 'CLOSED_SHELL' : 'OPEN_SHELL'}('',(${faceRefs.join(',')}))`
  )
}

/** Undirected edges used by anything other than exactly two triangles. */
function openEdgeCount(mesh: BrepMesh): number {
  const use = new Map<number, number>()
  for (let tri = 0; tri < mesh.tris.length / 3; tri++) {
    const abc = [mesh.tris[tri * 3], mesh.tris[tri * 3 + 1], mesh.tris[tri * 3 + 2]]
    for (let e = 0; e < 3; e++) {
      const a = abc[e]
      const b = abc[(e + 1) % 3]
      const key = Math.min(a, b) * MAX_BREP_VERTICES + Math.max(a, b)
      use.set(key, (use.get(key) ?? 0) + 1)
    }
  }
  let open = 0
  for (const count of use.values()) if (count !== 2) open++
  return open
}

/**
 * Serialise a world-space geometry as a STEP part file.
 *
 * `timestamp` is passed in rather than read from the clock so the same solid
 * always writes the same bytes, which is what lets the check suite compare one
 * file against another.
 *
 * Every shell is written the same way, and whether that is a SOLID or a SURFACE
 * body is decided by the whole export rather than shell by shell: a
 * representation may not hold both kinds, and a file that quietly mixed them
 * would open as neither in the stricter readers. In practice the demotion is
 * rare -- primitives, features, cuts and most merges all close cleanly -- and
 * it is reported rather than hidden, because "this came in as a surface" is the
 * first thing a user needs to know when a boolean in their CAD package refuses.
 */
export function buildStep(
  geometry: BufferGeometry,
  options: { name: string; timestamp: string }
): StepResult {
  const welded = indexByPosition(geometry)
  if (welded.points.length / 3 >= MAX_BREP_VERTICES) {
    throw new Error('Too much geometry for a STEP file: reduce the scene and try again.')
  }
  // Once, deliberately. A second pass finds vertices lying on the slivers the
  // first one made and tears the mesh apart faster than it mends it -- measured,
  // and the reason `healTJunctions` does not simply loop until it converges.
  const { mesh } = healTJunctions(welded)
  const closed = isManifold(mesh)

  const entities = new Entities()
  const bodies: string[] = []
  let faceCount = 0

  for (const shell of shells(mesh)) {
    const faces = flatFaces(mesh, shell)
    faceCount += faces.length
    const ref = writeShell(entities, mesh, faces, closed)
    bodies.push(
      closed
        ? entities.add(`MANIFOLD_SOLID_BREP('',${ref})`)
        : entities.add(`SHELL_BASED_SURFACE_MODEL('',(${ref}))`)
    )
  }

  if (bodies.length === 0) {
    throw new Error('Nothing to export: the solid is empty.')
  }

  const name = text(options.name)
  const origin = entities.add(`CARTESIAN_POINT('',(0.,0.,0.))`)
  const placement = entities.add(
    `AXIS2_PLACEMENT_3D('',${origin},${entities.direction([0, 0, 1])},${entities.direction([
      1, 0, 0,
    ])})`
  )

  // The unit and accuracy block, and the product chain that gives the shape
  // something to belong to. A reader that cannot find its way from a
  // PRODUCT_DEFINITION down to the representation will open the file and show
  // an empty tree, which is worse than failing.
  const millimetre = entities.add(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`)
  const radian = entities.add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`)
  const steradian = entities.add(`( NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.) )`)
  const uncertainty = entities.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(
      UNCERTAINTY
    )}),${millimetre},'distance_accuracy_value','confusion accuracy')`
  )
  const context = entities.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) ` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${millimetre},${radian},${steradian})) REPRESENTATION_CONTEXT('','3D') )`
  )

  const representation = entities.add(
    `${closed ? 'ADVANCED_BREP_SHAPE_REPRESENTATION' : 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION'}` +
      `(${name},(${[placement, ...bodies].join(',')}),${context})`
  )

  const application = entities.add(`APPLICATION_CONTEXT('automotive design')`)
  entities.add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${application})`
  )
  const productContext = entities.add(`PRODUCT_CONTEXT('',${application},'mechanical')`)
  const product = entities.add(`PRODUCT(${name},${name},'',(${productContext}))`)
  const formation = entities.add(
    `PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',${product},.NOT_KNOWN.)`
  )
  const definitionContext = entities.add(
    `PRODUCT_DEFINITION_CONTEXT('part definition',${application},'design')`
  )
  const definition = entities.add(
    `PRODUCT_DEFINITION('design','',${formation},${definitionContext})`
  )
  const shape = entities.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)
  entities.add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`)

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('${closed ? 'Faceted B-rep solid' : 'Faceted surface model'}'),'2;1');`,
    `FILE_NAME(${name},'${options.timestamp}',(''),(''),` +
      `${text(options.name)},${text(options.name)},'');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
  ]

  return {
    text: [...header, ...entities.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n'),
    solids: closed ? bodies.length : 0,
    surfaces: closed ? 0 : bodies.length,
    faces: faceCount,
    openEdges: closed ? 0 : openEdgeCount(mesh),
  }
}
