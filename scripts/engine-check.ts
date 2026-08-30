/**
 * Headless verification of the geometry engine.
 *
 * The core tool here is signed volume via the divergence theorem. For a closed,
 * consistently wound mesh it returns the true enclosed volume -- so a single
 * number simultaneously checks that the boolean produced the right amount of
 * material AND that the result is watertight. A leaking or inside-out mesh
 * cannot accidentally land on the analytic answer.
 *
 * Every check builds a one-object scene unless it is specifically about more
 * than one, because the pipeline under test -- base, features, cuts -- runs per
 * object in that object's own local space. The scene transform is exercised by
 * the export suite, which is where it actually enters.
 *
 * Run: npx tsx scripts/engine-check.ts
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Ray,
  Raycaster,
  Vector3,
} from 'three'

// three-bvh-csg calls three-mesh-bvh with a deprecated option on every build.
// It is internal to the libraries and drowns the report, so filter just that.
const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}
import {
  MAX_RADIUS,
  MAX_SIZE,
  MIN_DIMENSION,
  MIN_SHAPE,
  axisDimension,
  maxShapeSize,
  resizeAlongAxis,
  scaleShape,
  scaleUniform,
} from '../src/geometry/dimensions'
import type { Axis } from '../src/geometry/dimensions'
import { assemblyCentre, scaleAssembly } from '../src/geometry/assembly'
import { mirrorAssembly } from '../src/geometry/mirror'
import {
  CLAY_RINGS,
  bite,
  freshClay,
  isFresh,
  mold,
  resize,
  ringHeight,
  wallBounds,
} from '../src/geometry/clay'
import type { Clay, Dab } from '../src/geometry/clay'
import { TURN_FACETS, revolveClay } from '../src/geometry/revolve'
import {
  CLAY_PROFILES,
  CLAY_SIDES,
  CLAY_SIDES_MAX,
  CLAY_SIDES_MIN,
  bore,
  clampSides,
  flatFactor,
  profileWall,
  withWall,
} from '../src/geometry/clay'
import type { Bore, ClayProfile } from '../src/geometry/clay'
import { mirrorMesh, registerMesh } from '../src/geometry/meshLibrary'
import { platonicFaces } from '../src/geometry/solids'
import {
  advanceTurn,
  axisParam,
  axisTarget,
  axisTravel,
  beginAxisDrag,
  frameAxes,
  nearestViewAxis,
  snapTurn,
  TURN_SNAP,
  TURN_SNAP_WINDOW,
  turnedPosition,
  turnedRotation,
  WORLD_FRAME,
} from '../src/viewport/gizmoDrag'
import type { TurnGrab } from '../src/viewport/gizmoDrag'
import { snapAlongAxis } from '../src/geometry/snap'
import type { SnapTarget } from '../src/geometry/snap'
import { hostSurfaceFor, samePatch, slideAnchor } from '../src/geometry/surfaces'
import { endFaceFrame } from '../src/geometry/prism'
import { evaluateDoc, evaluateObject, resetEvaluator } from '../src/geometry/evaluate'
import { DAB_SPACING } from '../src/store/toolStore'
import { objectMatrix, relativeTransform } from '../src/geometry/transform'
import { planeSeparates, splitPlanes } from '../src/geometry/cut'
import { signedVolume } from '../src/geometry/volume'
import { IDENTITY_TRANSFORM, defaultFeature } from '../src/geometry/types'
import type {
  BaseSolid,
  CutPlane,
  Doc,
  ErodeDab,
  Feature,
  SceneObject,
  SurfaceAnchor,
  Vec2,
  Vec3,
} from '../src/geometry/types'

let failures = 0

function check(label: string, ok: boolean, detail: string) {
  const tag = ok ? 'PASS' : 'FAIL'
  if (!ok) failures++
  console.log(`  [${tag}] ${label}${detail ? ` -- ${detail}` : ''}`)
}

function near(label: string, actual: number, expected: number, tol: number) {
  const ok = Math.abs(actual - expected) <= tol
  check(label, ok, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)} (+/-${tol})`)
}

function triangleCount(geom: BufferGeometry): number {
  const index = geom.getIndex()
  return index ? index.count / 3 : geom.getAttribute('position').count / 3
}

function hasNaN(geom: BufferGeometry): boolean {
  const arr = geom.getAttribute('position').array as ArrayLike<number>
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return true
  return false
}

/** Distances from origin of every vertex beyond `minR`. */
function outerShellRadii(geom: BufferGeometry, minR: number): number[] {
  const pos = geom.getAttribute('position')
  const v = new Vector3()
  const out: number[] = []
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const r = v.length()
    if (r > minR) out.push(r)
  }
  return out
}

const feature = (over: Partial<Feature> & { anchor: SurfaceAnchor }): Feature => ({
  id: 'f1',
  shape: { type: 'circle', r: 0.3 },
  rotation: 0,
  depth: 0.3,
  enabled: true,
  tilt: [0, 0, 0],
  faceOffset: [0, 0],
  ...over,
})

// Ids are fixed rather than drawn from the counters so a check can rebuild the
// same object twice and exercise the evaluator's per-object prefix cache.
function object(
  base: BaseSolid,
  features: Feature[] = [],
  cuts: CutPlane[] = [],
  id = 'obj'
): SceneObject {
  return { id, name: id, base, transform: IDENTITY_TRANSFORM, features, cuts, parts: [] }
}

const scene = (...objects: SceneObject[]): Doc => ({ objects })

/** The one geometry of a single-object scene. */
function solidOf(doc: Doc): BufferGeometry {
  const result = evaluateDoc(doc)
  if (result.objects.length !== 1) throw new Error('expected exactly one object')
  return result.objects[0].geometry
}

const CUBE: BaseSolid = { kind: 'box', size: [2, 2, 2] }
const SPHERE: BaseSolid = { kind: 'sphere', radius: 1 }
const TOP_FACE: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }

/** Area of a regular n-gon of circumradius r, times height. */
function hexPrism(r: number, sides: number, h: number): number {
  const area = 0.5 * sides * r * r * Math.sin((2 * Math.PI) / sides)
  return area * h
}


/** Dimension readers for the assertions below. A `BaseSolid` is a union, and
 *  narrowing it inline at every call would bury the claim being made. */
function dimOf(base: BaseSolid, axis: 'x' | 'y' | 'z'): number {
  if (base.kind !== 'box' && base.kind !== 'mesh') throw new Error('not a box')
  return base.size[axis === 'x' ? 0 : axis === 'y' ? 1 : 2]
}
function radiusOf(base: BaseSolid): number {
  // A box is three sides and an imported model is three extents; neither has a
  // radius, and both are measured with `dimOf` instead.
  if (base.kind === 'box' || base.kind === 'mesh') throw new Error('no radius')
  return base.radius
}
function heightOf(base: BaseSolid): number {
  if (
    base.kind === 'box' ||
    base.kind === 'mesh' ||
    base.kind === 'sphere' ||
    base.kind === 'platonic'
  ) {
    throw new Error('no height')
  }
  return base.height
}

// --- 1. Base solids --------------------------------------------------------
console.log('\n1. Base solids')
resetEvaluator()
{
  const g = solidOf(scene(object(CUBE)))
  near('bare cube volume', signedVolume(g), 8, 1e-3)
  check('cube has triangles', triangleCount(g) >= 12, `${triangleCount(g)} tris`)
  check('no NaN positions', !hasNaN(g), '')
}
{
  const g = solidOf(scene(object(SPHERE)))
  const ideal = (4 / 3) * Math.PI
  const vol = signedVolume(g)
  // A tessellated UV sphere is INSCRIBED in the true sphere, so it must hold
  // slightly less volume. Comparing to the ideal would be the wrong invariant;
  // the real one is "just under, never over, and never by much".
  check(
    'bare sphere volume (inscribed, just under ideal)',
    vol < ideal && vol > ideal * 0.99,
    `got ${vol.toFixed(4)}, ideal ${ideal.toFixed(4)}, deficit ${(100 * (1 - vol / ideal)).toFixed(2)}%`
  )
}

// --- 2. Flat extrude / intrude, against analytic volumes -------------------
console.log('\n2. Flat face: exact material added and removed')
const discVolume = Math.PI * 0.3 * 0.3 * 0.3
{
  resetEvaluator()
  const g = solidOf(
    scene(object(CUBE, [feature({ anchor: TOP_FACE, depth: 0.3 })]))
  )
  near('cube + circular boss', signedVolume(g), 8 + discVolume, 0.002)
  check('no NaN positions', !hasNaN(g), '')
}
{
  resetEvaluator()
  const g = solidOf(
    scene(object(CUBE, [feature({ anchor: TOP_FACE, depth: -0.3 })]))
  )
  near('cube - circular pocket', signedVolume(g), 8 - discVolume, 0.002)
}
{
  resetEvaluator()
  const g = solidOf(
    scene(
      object(CUBE, [
        feature({
          anchor: TOP_FACE,
          depth: -0.3,
          shape: { type: 'rect', w: 0.6, h: 0.4 },
        }),
      ])
    )
  )
  near('cube - rectangular pocket', signedVolume(g), 8 - 0.6 * 0.4 * 0.3, 0.002)
}

// --- 3. Through-cut --------------------------------------------------------
console.log('\n3. Through-cut (depth exceeds thickness)')
{
  resetEvaluator()
  const g = solidOf(
    scene(object(CUBE, [feature({ anchor: TOP_FACE, depth: -2.5 })]))
  )
  // A clean bore through a 2-thick cube removes a full-height cylinder.
  near('cube - through hole', signedVolume(g), 8 - Math.PI * 0.09 * 2, 0.01)
}

// --- 4. Curved surface: the offset-shell payoff ----------------------------
console.log('\n4. Sphere: boss follows the curvature')
{
  resetEvaluator()
  const depth = 0.25
  const g = solidOf(
    scene(
      object(SPHERE, [
        feature({
          anchor: { on: 'sphere', theta: 0, phi: Math.PI / 2 },
          depth,
          shape: { type: 'rect', w: 0.5, h: 0.5 },
        }),
      ])
    )
  )
  const vol = signedVolume(g)
  check('sphere gained material', vol > (4 / 3) * Math.PI, `volume ${vol.toFixed(4)}`)
  check('no NaN positions', !hasNaN(g), '')

  // The decisive check. Every vertex on the boss's outer face must sit at
  // exactly R+depth from the centre. A straight prism capped flat would put the
  // corners further out than the middle, so the spread would be large.
  const radii = outerShellRadii(g, 1 + depth * 0.5)
  const min = Math.min(...radii)
  const max = Math.max(...radii)
  const spread = max - min

  // The offset sphere is a 64x40 tessellation, so its facets sag below the true
  // radius by the chord sagitta. That is the floor on any honest measurement
  // here -- tolerate it, but nothing larger.
  const R = 1 + depth
  const sagitta = R * (1 - Math.cos(Math.PI / 64)) + R * (1 - Math.cos(Math.PI / 40))
  // What a straight prism capped flat would have produced, for contrast: the
  // outline corners would sit further from the centre than its middle.
  const halfDiagonal = Math.hypot(0.5, 0.5) / 2
  const flatCapSpread = Math.hypot(R, halfDiagonal) - R

  check('boss top exists', radii.length > 0, `${radii.length} outer vertices`)
  near('boss top radius', max, R, 1e-3)
  check(
    'boss top is CURVED, not a flat cap',
    spread <= sagitta * 1.2 && spread < flatCapSpread * 0.2,
    `spread ${spread.toExponential(2)} vs tessellation floor ${sagitta.toExponential(2)}, ` +
      `flat cap would be ${flatCapSpread.toExponential(2)}`
  )
}
{
  resetEvaluator()
  const g = solidOf(
    scene(
      object(SPHERE, [
        feature({
          anchor: { on: 'sphere', theta: Math.PI / 3, phi: Math.PI / 2.5 },
          depth: -0.25,
        }),
      ])
    )
  )
  const vol = signedVolume(g)
  check('sphere lost material', vol < (4 / 3) * Math.PI, `volume ${vol.toFixed(4)}`)
  check('sphere pocket did not leak', vol > 0, `volume ${vol.toFixed(4)}`)
}

// --- 5. Stacked features and cache reuse -----------------------------------
console.log('\n5. Stacked features and prefix cache')
{
  resetEvaluator()
  const features: Feature[] = [
    { ...feature({ anchor: TOP_FACE }), id: 'a', depth: 0.3 },
    {
      ...feature({ anchor: { on: 'box-face', face: 4, u: 0.3, v: -0.2 } }),
      id: 'b',
      depth: -0.4,
      shape: { type: 'ngon', r: 0.25, sides: 6 },
    },
  ]
  const doc = scene(object(CUBE, features))
  const first = evaluateDoc(doc)
  near(
    'two stacked features',
    signedVolume(first.objects[0].geometry),
    8 + discVolume - hexPrism(0.25, 6, 0.4),
    0.01
  )
  check('no features failed', first.failed.length === 0, first.failed.join(',') || 'none')

  const second = evaluateDoc(doc)
  check(
    'unchanged doc reuses cache',
    second.millis < first.millis + 1,
    `${first.millis.toFixed(1)}ms then ${second.millis.toFixed(1)}ms`
  )
  check(
    'cache returns same geometry object',
    second.objects[0].geometry === first.objects[0].geometry,
    ''
  )

  // Edit only the LAST feature: the first must be reused, not recomputed.
  // Still negative -- the sign is the direction now, so deepening a pocket
  // means a MORE negative depth, not a larger number.
  const edited = scene(object(CUBE, [features[0], { ...features[1], depth: -0.5 }]))
  const third = evaluateDoc(edited)
  check(
    'edited doc produces new geometry',
    third.objects[0].geometry !== first.objects[0].geometry,
    ''
  )
  near(
    're-evaluated volume',
    signedVolume(third.objects[0].geometry),
    8 + discVolume - hexPrism(0.25, 6, 0.5),
    0.01
  )
}

// --- 6. Inert features -----------------------------------------------------
console.log('\n6. Inert features contribute nothing')
{
  resetEvaluator()
  const g = solidOf(scene(object(CUBE, [feature({ anchor: TOP_FACE, depth: 0 })])))
  near('depth 0 leaves the solid alone', signedVolume(g), 8, 1e-3)
}
{
  resetEvaluator()
  const g = solidOf(
    scene(object(CUBE, [feature({ anchor: TOP_FACE, depth: 0.3, enabled: false })]))
  )
  near('disabled feature leaves the solid alone', signedVolume(g), 8, 1e-3)
}

// --- 7. Every primitive, against its analytic volume -----------------------
console.log('\n7. The ten primitives hold the volume they claim')

/** Radial tessellation of the lathe family; matches surfaces.ts. */
const LATHE_SEGMENTS = 48

/** Area of the inscribed regular n-gon of circumradius r. */
const ngonArea = (r: number, n: number) => 0.5 * n * r * r * Math.sin((2 * Math.PI) / n)

/**
 * Exactly-tessellated solids are compared to the polygon they really are, not
 * to the smooth ideal: a 48-sided prism is not a cylinder, and pretending
 * otherwise would bury a 0.3% modelling error under a loose tolerance.
 */
{
  resetEvaluator()
  const g = solidOf(scene(object({ kind: 'box', size: [2, 3, 1.5] })))
  near('box 2x3x1.5', signedVolume(g), 9, 1e-3)
}
{
  resetEvaluator()
  const g = solidOf(scene(object({ kind: 'cylinder', radius: 0.8, height: 2 })))
  near('cylinder r0.8 h2 (48-gon prism)', signedVolume(g), ngonArea(0.8, LATHE_SEGMENTS) * 2, 1e-3)
  check(
    'cylinder is inscribed in the true cylinder',
    signedVolume(g) < Math.PI * 0.64 * 2,
    `${signedVolume(g).toFixed(4)} < ${(Math.PI * 0.64 * 2).toFixed(4)}`
  )
}
{
  resetEvaluator()
  const g = solidOf(scene(object({ kind: 'cone', radius: 0.9, height: 2 })))
  near('cone r0.9 h2 (48-gon base)', signedVolume(g), (ngonArea(0.9, LATHE_SEGMENTS) * 2) / 3, 1e-3)
}
{
  resetEvaluator()
  const g = solidOf(scene(object({ kind: 'capsule', radius: 0.6, height: 1.2 })))
  // A capsule is latheed in both directions, so no single polygon describes it;
  // the honest invariant is the same one the sphere gets.
  const ideal = Math.PI * 0.36 * 1.2 + (4 / 3) * Math.PI * 0.216
  const vol = signedVolume(g)
  check(
    'bean r0.6 h1.2 (inscribed, just under ideal)',
    vol < ideal && vol > ideal * 0.98,
    `got ${vol.toFixed(4)}, ideal ${ideal.toFixed(4)}, deficit ${(100 * (1 - vol / ideal)).toFixed(2)}%`
  )
}
{
  resetEvaluator()
  const g = solidOf(scene(object({ kind: 'prism', radius: 0.9, height: 1.8, sides: 6 })))
  near('hexagonal prism r0.9 h1.8', signedVolume(g), ngonArea(0.9, 6) * 1.8, 1e-4)
}
{
  resetEvaluator()
  const g = solidOf(scene(object({ kind: 'pyramid', radius: 1, height: 1.8, sides: 4 })))
  // A square pyramid of circumradius 1 has a base of side sqrt(2), area 2.
  near('square pyramid r1 h1.8', signedVolume(g), (ngonArea(1, 4) * 1.8) / 3, 1e-4)
}
{
  // Circumradius-normalised volumes: V = k * R^3, with k derived from the
  // standard edge-length formulas so the constants below are checkable by hand.
  const R = 1.1
  const tetraEdge = R * Math.sqrt(8 / 3)
  const dodecaEdge = (4 * R) / (Math.sqrt(3) * (1 + Math.sqrt(5)))
  const expected: Record<string, number> = {
    // a^3 / (6 sqrt 2)
    tetrahedron: tetraEdge ** 3 / (6 * Math.SQRT2),
    // Two square pyramids back to back on a 2R diagonal.
    octahedron: (4 / 3) * R ** 3,
    // (15 + 7 sqrt 5) / 4 * a^3
    dodecahedron: ((15 + 7 * Math.sqrt(5)) / 4) * dodecaEdge ** 3,
  }
  for (const solid of ['tetrahedron', 'octahedron', 'dodecahedron'] as const) {
    resetEvaluator()
    const g = solidOf(scene(object({ kind: 'platonic', solid, radius: R })))
    // The hull is exact, not tessellated, so this is a tight equality.
    near(`${solid} R1.1`, signedVolume(g), expected[solid], 1e-6)
  }
}

{
  // HOW A PLATONIC SOLID STANDS IS NOT A FUNCTION OF ITS SIZE.
  //
  // It was. The resting turn was derived per call from the convex hull of
  // vertices already scaled by the radius, and the hull's first face was picked
  // by a sort whose primary key -- normal height -- TIES across whole bands of a
  // platonic solid's faces. Which face won that tie came down to the last bit of
  // a cross product, which moves with the radius, so dragging a dodecahedron's
  // size snapped it round its own axis by 36 degrees at unpredictable points and
  // tipped a tetrahedron onto a different face outright.
  //
  // Two things have to hold, and this checks both at once, because the face
  // ORDER is what a saved `planar-face` anchor names: same face list, same
  // normals, whatever the radius.
  for (const solid of ['tetrahedron', 'octahedron', 'dodecahedron'] as const) {
    const canonical = platonicFaces(solid, 1).map((f) => f.normal.clone())
    let worst = 0
    let worstAt = 0
    for (let i = 0; i <= 80; i++) {
      // The whole range the panel and the gizmo can reach, and deliberately not
      // round numbers: the tie fell differently at 0.55 than at 0.5.
      const radius = MIN_DIMENSION + i * 0.05
      const faces = platonicFaces(solid, radius)
      if (faces.length !== canonical.length) {
        worst = Infinity
        worstAt = radius
        break
      }
      for (let f = 0; f < faces.length; f++) {
        const drift = faces[f].normal.distanceTo(canonical[f])
        if (drift > worst) {
          worst = drift
          worstAt = radius
        }
      }
    }
    check(
      `a ${solid} stands the same way at every size`,
      worst < 1e-9,
      `worst drift ${worst.toExponential(2)} at r=${worstAt.toFixed(2)}`
    )
  }

  // And the two that rest on a face genuinely do, rather than merely doing so
  // consistently -- the turn could be stable and still be the wrong one.
  for (const solid of ['tetrahedron', 'dodecahedron'] as const) {
    const down = Math.min(...platonicFaces(solid, 1.3).map((f) => f.normal.y))
    near(`a ${solid} rests flat on a face`, down, -1, 1e-9)
  }
}

// --- 8. A tilted end face reaches further than a square one ----------------
console.log('\n8. Tilt leans the created face')
{
  const plain = feature({ anchor: TOP_FACE, depth: 0.5 })
  const tilted: Feature = { ...plain, tilt: [0, 0, Math.PI / 9] }

  function topOf(f: Feature): number {
    resetEvaluator()
    const g = solidOf(scene(object(CUBE, [f])))
    const pos = g.getAttribute('position')
    let maxY = -Infinity
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i))
    return maxY
  }

  const flatTop = topOf(plain)
  const leanTop = topOf(tilted)
  near('untilted boss tops out at depth', flatTop, 1.5, 1e-4)
  // Tilting pivots the face about its centre, so one side of the outline must
  // climb past the depth the untilted one stops at. If the tilt were silently
  // dropped the two numbers would be identical.
  check(
    'a 20 deg tilt reaches higher than an untilted boss',
    leanTop > flatTop + 0.05,
    `${leanTop.toFixed(4)} vs ${flatTop.toFixed(4)}`
  )
  // Circle of radius 0.3 pivoted 20 degrees: the far edge rises r*tan(20 deg).
  near('and by the amount the geometry demands', leanTop - flatTop, 0.3 * Math.tan(Math.PI / 9), 5e-3)
}

// --- 9. A face offset leans the pillar -------------------------------------
console.log('\n9. faceOffset slides the created face and leans the pillar')
{
  const slide: Vec2 = [0.5, 0]
  const plain = feature({ anchor: TOP_FACE, depth: 0.6 })
  const slid: Feature = { ...plain, faceOffset: slide }

  /**
   * Centre of the created end face, read as the middle of its extent rather
   * than the mean of its vertices: boolean output is triangle soup, so a vertex
   * mean is weighted by how many triangles happen to meet at each corner and
   * drifts off centre even for a perfectly symmetric disc.
   */
  function topCentre(f: Feature): Vector3 {
    resetEvaluator()
    const g = solidOf(scene(object(CUBE, [f])))
    const pos = g.getAttribute('position')
    const v = new Vector3()
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      if (v.y < 1.6 - 1e-4) continue
      min.min(v)
      max.max(v)
    }
    return min.add(max).multiplyScalar(0.5)
  }

  const before = topCentre(plain)
  const after = topCentre(slid)
  near('an unslid boss stands straight up', Math.hypot(before.x, before.z), 0, 1e-4)
  // The base of the extrusion never moves, so the whole slide shows up as lean.
  near('the face moved by the slide', Math.hypot(after.x, after.z), 0.5, 1e-3)
  near('and stayed on its own plane', after.y, 1.6, 1e-4)

  // Volume is conserved: a sheared prism has the same base area and height as
  // the upright one, which is Cavalieri's principle and a good check that the
  // walls followed the face instead of the cap detaching from them.
  resetEvaluator()
  const straight = signedVolume(solidOf(scene(object(CUBE, [plain]))))
  resetEvaluator()
  const leaning = signedVolume(solidOf(scene(object(CUBE, [slid]))))
  near('a leaning pillar holds the same volume', leaning, straight, 0.01)

  /**
   * The other half of the claim, and the one a volume check cannot see: the
   * footprint where the sweep LEAVES the host surface must not move. A wall
   * built as one straight band from the moved end back to the start drags the
   * base along with the face -- volume survives (the prism is merely sheared
   * the other way) while the boss visibly slides off the spot it was drawn on.
   *
   * Read by slicing the solid a hair off the face rather than by looking at
   * vertices: above the cube the extrusion is the only material left, so the
   * slice IS the footprint, and no vertex has to be attributed to a feature.
   */
  const STANDOFF = 5e-4
  function sectionAt(g: BufferGeometry, y: number): { cx: number; cz: number; halfW: number } {
    const pos = g.getAttribute('position')
    const index = g.getIndex()
    const count = index ? index.count : pos.count
    const corner = (i: number) => {
      const k = index ? index.getX(i) : i
      return new Vector3(pos.getX(k), pos.getY(k), pos.getZ(k))
    }
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (let t = 0; t + 2 < count; t += 3) {
      const tri = [corner(t), corner(t + 1), corner(t + 2)]
      for (let e = 0; e < 3; e++) {
        const a = tri[e]
        const b = tri[(e + 1) % 3]
        if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue
        const q = a.clone().lerp(b, (y - a.y) / (b.y - a.y))
        // For the intrude case the slice also crosses the cube's own outer
        // wall; the mouth of the pocket is what is under test, so drop
        // anything out at the block's rim.
        if (Math.abs(q.x) > 0.9 || Math.abs(q.z) > 0.9) continue
        min.min(q)
        max.max(q)
      }
    }
    return { cx: (min.x + max.x) / 2, cz: (min.z + max.z) / 2, halfW: (max.x - min.x) / 2 }
  }

  // The slice sits STANDOFF away from the face, so a correct sweep still shows
  // the shear over that gap -- slide * standoff / depth, here 4.17e-4. The
  // regression this guards against moved the footprint by 0.0458, a hundred
  // times further, so the tolerance can stay well inside the defect.
  const shear = 0.5 * (STANDOFF / 0.6)
  {
    resetEvaluator()
    const g = solidOf(scene(object(CUBE, [slid])))
    const s = sectionAt(g, 1 + STANDOFF)
    near('a slid boss still leaves the face where it was drawn', Math.hypot(s.cx - shear, s.cz), 0, 5e-5)
    near('and its footprint is translated, never scaled', s.halfW, 0.3, 1e-3)
  }
  {
    // Intrude sweeps the other way, and the ordered-ring wall has to keep the
    // base put on that path too or a slid pocket eats into the wrong spot.
    resetEvaluator()
    const g = solidOf(scene(object(CUBE, [{ ...slid, depth: -slid.depth }])))
    const s = sectionAt(g, 1 - STANDOFF)
    near('a slid pocket opens where it was drawn too', Math.hypot(s.cx - shear, s.cz), 0, 5e-5)
    near('with the mouth at full width', s.halfW, 0.3, 1e-3)
  }
}

// --- 10. Cutting: two halves reconstruct the whole -------------------------
console.log('\n10. A cut splits a cube into halves that sum back to the whole')
{
  resetEvaluator()
  const whole = signedVolume(solidOf(scene(object(CUBE))))

  const origin: Vec3 = [0, 0, 0]
  const normal: Vec3 = [1, 0, 0]
  resetEvaluator()
  check(
    'the plane genuinely separates the cube',
    planeSeparates(solidOf(scene(object(CUBE))), new Vector3(...origin), new Vector3(...normal)),
    ''
  )

  const [keepPlus, keepMinus] = splitPlanes(origin, normal)
  resetEvaluator()
  const result = evaluateDoc(
    scene(object(CUBE, [], [keepPlus], 'left'), object(CUBE, [], [keepMinus], 'right'))
  )
  check('both halves evaluated', result.objects.length === 2, `${result.objects.length}`)
  check('no cut failed', result.failed.length === 0, result.failed.join(',') || 'none')

  const left = signedVolume(result.objects[0].geometry)
  const right = signedVolume(result.objects[1].geometry)
  near('kept half is half a cube', left, 4, 0.01)
  near('discarded half is the other half', right, 4, 0.01)
  // The decisive one: a cut that leaked, double-counted the cut face, or boxed
  // the solid in would not add back up.
  near('the two halves reconstruct the whole', left + right, whole, 0.01)

  // An off-centre cut must still conserve the total, at a different split.
  // side +1 keeps (p - origin) . normal >= 0, so the FIRST plane keeps the
  // 0.5-thick sliver at x >= 0.5, not the larger remainder.
  const [a, b] = splitPlanes([0.5, 0, 0], [1, 0, 0])
  resetEvaluator()
  const skewed = evaluateDoc(
    scene(object(CUBE, [], [a], 'left'), object(CUBE, [], [b], 'right'))
  )
  const thin = signedVolume(skewed.objects[0].geometry)
  const thick = signedVolume(skewed.objects[1].geometry)
  near('off-centre cut: thin side', thin, 2, 0.01)
  near('off-centre cut: thick side', thick, 6, 0.01)
  near('off-centre cut still conserves the whole', thin + thick, whole, 0.01)

  // The gizmo's ORIGIN is wherever the user parked the handle; the plane it
  // aims is the same plane however far aside that is. So the half-space brush
  // has to be sized against the solid it is cutting, not against a fixed
  // multiple of the base. Sized the old way it stopped reaching the cube once
  // the origin passed its lateral half-extent and the cut silently ERASED the
  // object -- while `planeSeparates` went on approving it, so the two halves of
  // the tool disagreed about the same gesture.
  for (const away of [2, 12, 200]) {
    const far: Vec3 = [away, 0.4, away]
    resetEvaluator()
    check(
      `a plane aimed from ${away} units aside still separates`,
      planeSeparates(solidOf(scene(object(CUBE))), new Vector3(...far), new Vector3(0, 1, 0)),
      ''
    )
    const [above, below] = splitPlanes(far, [0, 1, 0])
    resetEvaluator()
    const halves = evaluateDoc(
      scene(object(CUBE, [], [above], 'above'), object(CUBE, [], [below], 'below'))
    )
    const top = signedVolume(halves.objects[0].geometry)
    const bottom = signedVolume(halves.objects[1].geometry)
    // Not just non-empty: the plane is y = 0.4 in every one of these, so the
    // split must land in the same place a nearby origin would have put it.
    near(`and cuts at y = 0.4 from ${away} away`, top, 2.4, 0.01)
    near(`and the halves still reconstruct the whole from ${away} away`, top + bottom, whole, 0.01)
  }
}


// --- 11. Gizmo dimensions: what one axis means on each primitive ------------
console.log('\n11. Resizing along an axis moves that surface, on every primitive')

{
  // The contract the arrows are built on: `travel` is how far the SOLID'S SKIN
  // moves along the axis, not how far the underlying field changes. A box side
  // is a full extent about a centred origin, so it takes twice the travel; a
  // radius already IS the half-extent. Get this backwards and a right-drag
  // slips at half or double speed depending on which primitive is selected.
  const box: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const grown = resizeAlongAxis(box, 0, 0.5)
  near('a box side takes twice the surface travel', dimOf(grown, 'x'), 3, 1e-9)
  check(
    'and the other two sides are untouched',
    dimOf(grown, 'y') === 2 && dimOf(grown, 'z') === 2,
    `${dimOf(grown, 'y')} and ${dimOf(grown, 'z')}`
  )

  const cyl: BaseSolid = { kind: 'cylinder', radius: 0.8, height: 2 }
  near('a radius takes the travel one for one', radiusOf(resizeAlongAxis(cyl, 0, 0.5)), 1.3, 1e-9)
  near('and Z drives the same radius', radiusOf(resizeAlongAxis(cyl, 2, 0.5)), 1.3, 1e-9)
  near('while Y is the height, at twice again', heightOf(resizeAlongAxis(cyl, 1, 0.5)), 3, 1e-9)

  // A sphere answers on all three arrows rather than leaving two of them inert:
  // every direction out of a sphere IS the radius.
  const ball: BaseSolid = { kind: 'sphere', radius: 1 }
  for (const axis of [0, 1, 2] as Axis[]) {
    near(`a sphere resizes on axis ${axis}`, radiusOf(resizeAlongAxis(ball, axis, 0.25)), 1.25, 1e-9)
  }

  // Every kind must answer on every axis, or an arrow silently does nothing.
  const all: BaseSolid[] = [
    box,
    ball,
    cyl,
    { kind: 'cone', radius: 0.9, height: 2 },
    { kind: 'capsule', radius: 0.6, height: 1.2 },
    { kind: 'pyramid', radius: 1, height: 2, sides: 4 },
    { kind: 'prism', radius: 1, height: 1.8, sides: 6 },
    { kind: 'platonic', solid: 'dodecahedron', radius: 1 },
  ]
  let answered = 0
  for (const base of all) {
    for (const axis of [0, 1, 2] as Axis[]) {
      if (axisDimension(base, axis) !== null) answered++
    }
  }
  check('all eight kinds answer on all three axes', answered === 24, `${answered}/24`)
}

{
  // Clamping. A drag runs past the limit constantly -- the pointer keeps going
  // after the solid stops -- so the limit has to hold rather than merely being
  // where the slider ends.
  const box: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  near('growth stops at the ceiling', dimOf(resizeAlongAxis(box, 0, 40), 'x'), MAX_SIZE, 1e-9)
  near('and shrinking stops at the floor', dimOf(resizeAlongAxis(box, 0, -40), 'x'), MIN_DIMENSION, 1e-9)
  const ball: BaseSolid = { kind: 'sphere', radius: 1 }
  near('a radius has its own, tighter ceiling', radiusOf(resizeAlongAxis(ball, 0, 40)), MAX_RADIUS, 1e-9)
}

{
  // The uniform ring must never change a shape's proportions. The trap is
  // clamping each dimension on its own: a box already near the length ceiling
  // would stop growing there and keep fattening on the other two, so scaling up
  // and back down would not return the shape you started with.
  const slab: BaseSolid = { kind: 'box', size: [6, 1, 1] }
  // The factor only has to overshoot: the longest side is 6, so anything past
  // MAX_SIZE / 6 drives it through the ceiling. DERIVED, not inlined -- this
  // was a literal 4, which stopped clamping the moment MAX_SIZE rose past 24,
  // and the check would have gone on passing while testing nothing at all.
  const big = scaleUniform(slab, (MAX_SIZE / 6) * 2)
  near('the ring stops at the tightest bound', dimOf(big, 'x'), MAX_SIZE, 1e-9)
  near('and the other sides stop with it', dimOf(big, 'y'), MAX_SIZE / 6, 1e-9)
  check(
    'so the proportions survive the clamp',
    Math.abs(dimOf(big, 'x') / dimOf(big, 'y') - 6) < 1e-9,
    `${(dimOf(big, 'x') / dimOf(big, 'y')).toFixed(4)} vs 6`
  )

  const cyl: BaseSolid = { kind: 'cylinder', radius: 0.8, height: 2 }
  const scaled = scaleUniform(cyl, 1.5)
  near('a cylinder scales its radius', radiusOf(scaled), 1.2, 1e-9)
  near('and its height together', heightOf(scaled), 3, 1e-9)

  // Round trip: scaling up then by the reciprocal returns the original, which
  // is only true because the factor is clamped once rather than per dimension.
  const back = scaleUniform(scaleUniform(cyl, 1.5), 1 / 1.5)
  near('scaling up then back is the identity', radiusOf(back), 0.8, 1e-9)
  near('on both dimensions', heightOf(back), 2, 1e-9)
}

// --- 12. Axis-constrained snapping ------------------------------------------
console.log('\n12. An arrow drag snaps ALONG its axis and nowhere else')

{
  // A lone corner to seek, and a mover whose corner is a quarter-unit short of
  // it along X and dead level in Y and Z.
  const target: SnapTarget[] = [
    { kind: 'vertex', objectId: 'other', point: new Vector3(1, 0, 0) },
  ]
  const axisX = new Vector3(1, 0, 0)

  const hit = snapAlongAxis([new Vector3(0.9, 0, 0)], target, axisX, 0.18)
  check('a corner in line with the axis is caught', hit !== null, hit ? 'caught' : 'missed')
  if (hit) {
    near('by exactly the gap', hit.delta.x, 0.1, 1e-9)
    // The whole point of the separate solve: the arrow promised that nothing
    // but this coordinate changes, and the delta has to keep that promise.
    check(
      'and the correction is purely axial',
      Math.abs(hit.delta.y) < 1e-12 && Math.abs(hit.delta.z) < 1e-12,
      `y ${hit.delta.y}, z ${hit.delta.z}`
    )
    {
      const vertex = target[0]
      if (vertex.kind !== 'vertex') throw new Error('target is not a vertex')
      near('landing the corner on the target', hit.point.distanceTo(vertex.point), 0, 1e-9)
    }
  }

  // Off-axis is the case a filtered three-axis snap would get wrong: it would
  // find this corner, hand back a delta with a Y in it, and the caller would
  // drop the Y and land the solid somewhere that touches nothing.
  const off = snapAlongAxis([new Vector3(0.9, 0.05, 0)], target, axisX, 0.18)
  check('a corner off the axis is NOT caught', off === null, off ? 'wrongly caught' : 'ignored')

  // Out of range along the axis, in line but too far to reach.
  const far = snapAlongAxis([new Vector3(0.5, 0, 0)], target, axisX, 0.18)
  check('and one beyond the tolerance is left alone', far === null, far ? 'wrongly caught' : 'ignored')
}

{
  // A face target is a whole unbounded plane, which is what lets two solids go
  // flush at any offset along it. Sliding along X toward a plane whose normal
  // is X must land the corner exactly on it however far off it sits laterally.
  const plane: SnapTarget[] = [
    {
      kind: 'face',
      objectId: 'other',
      origin: new Vector3(1, 0, 0),
      normal: new Vector3(1, 0, 0),
    },
  ]
  const hit = snapAlongAxis([new Vector3(0.88, 3, -4)], plane, new Vector3(1, 0, 0), 0.18)
  check('a face is caught from anywhere along it', hit !== null, hit ? 'caught' : 'missed')
  if (hit) near('at the plane exactly', hit.point.x, 1, 1e-9)

  // Running parallel to a plane, there is no offset that reaches it. An
  // implementation that divided anyway would return an infinity here.
  const parallel = snapAlongAxis([new Vector3(0.88, 0, 0)], plane, new Vector3(0, 1, 0), 0.18)
  check('a plane the axis runs along is not a target', parallel === null, `${parallel}`)
}

{
  // Snapping off leaves a drag alone -- checked here rather than only in the
  // panel, because this is the layer that would silently ignore the setting.
  const edge: SnapTarget[] = [
    {
      kind: 'edge',
      objectId: 'other',
      a: new Vector3(1, -1, 0),
      b: new Vector3(1, 1, 0),
    },
  ]
  const hit = snapAlongAxis([new Vector3(0.9, 0.3, 0)], edge, new Vector3(1, 0, 0), 0.18)
  check('an edge crossing the axis is caught', hit !== null, hit ? 'caught' : 'missed')
  if (hit) {
    near('at the edge', hit.point.x, 1, 1e-9)
    near('without sliding along the edge', hit.point.y, 0.3, 1e-9)
  }

  // Past the end of the segment: an edge attracts along its own length only,
  // or every edge in the scene would behave like an infinite line.
  const past = snapAlongAxis([new Vector3(0.9, 4, 0)], edge, new Vector3(1, 0, 0), 0.18)
  check('but not past its end', past === null, past ? 'wrongly caught' : 'ignored')
}


// --- 13. An arrow drag is pinned, so a still pointer holds still ------------
console.log('\n13. A held arrow drag does not walk the target back and forth')

{
  // The frame loop, reduced to its arithmetic. A camera looking down the -Z
  // axis from above and to one side, dragging the X arrow of a solid that
  // starts at the origin.
  const dirX = new Vector3(1, 0, 0)
  const rayAt = (x: number) => new Ray(new Vector3(x, 4, 6), new Vector3(0, -4, -6).normalize())

  // The parameter is a plain distance along the axis, so a ray aimed at x = 2
  // reads 2 whatever angle it arrives from.
  const straight = axisParam(rayAt(2), new Vector3(0, 0, 0), dirX)
  near('the axis parameter is a distance along the axis', straight ?? NaN, 2, 1e-9)

  const skew = axisParam(
    new Ray(new Vector3(2, 3, -5), new Vector3(0.2, -1, 0.4).normalize()),
    new Vector3(0, 0, 0),
    dirX
  )
  check('and a skew ray still answers', skew !== null, `${skew}`)

  // A ray running ALONG the axis has no nearest point, and must say so rather
  // than dividing by a denominator that has gone to zero.
  const along = axisParam(new Ray(new Vector3(-9, 0, 0), dirX), new Vector3(0, 0, 0), dirX)
  check('a ray down the axis has no answer', along === null, `${along}`)
}

{
  // The regression itself. Grab at x = 1, then move the pointer to x = 2 and
  // HOLD it there while the target follows -- which is what the frame loop does
  // sixty times a second.
  const dirX = new Vector3(1, 0, 0)
  const rayAt = (x: number) => new Ray(new Vector3(x, 4, 6), new Vector3(0, -4, -6).normalize())

  const grab = beginAxisDrag(rayAt(1), [0, 0, 0], dirX)
  check('the grab is taken', grab !== null, `${grab}`)
  if (!grab) throw new Error('no grab')

  near('and it starts with no travel', axisTravel(grab, rayAt(1), dirX) ?? NaN, 0, 1e-9)

  // Every frame from here uses the SAME pointer position. The target moves in
  // response, and the reading must not move with it: measuring against the
  // target's live centre is what made the solid flip between two positions
  // every other frame, which is what a user sees as the gizmo shaking.
  let position: Vec3 = [0, 0, 0]
  const visited: number[] = []
  for (let frame = 0; frame < 6; frame++) {
    const travel = axisTravel(grab, rayAt(2), dirX)
    if (travel === null) throw new Error('lost the axis')
    position = axisTarget(grab, dirX, travel)
    visited.push(position[0])
  }

  near('a held pointer lands the target where it asked', visited[0], 1, 1e-9)
  check(
    'and every later frame agrees with the first',
    visited.every((x) => Math.abs(x - visited[0]) < 1e-12),
    visited.map((x) => x.toFixed(3)).join(' ')
  )
  // The specific failure: two positions alternating. Naming it separately means
  // a regression reports the shape of the bug rather than just a mismatch.
  check(
    'so it never oscillates between two places',
    new Set(visited.map((x) => x.toFixed(9))).size === 1,
    `${new Set(visited.map((x) => x.toFixed(9))).size} distinct positions`
  )
  check(
    'and the drag stays on its own axis',
    position[1] === 0 && position[2] === 0,
    `${position[1]}, ${position[2]}`
  )
}

{
  // Travel is measured from the grab, so it tracks the pointer's own movement
  // rather than accumulating -- including backwards, past where it started.
  const dirY = new Vector3(0, 1, 0)
  const rayAt = (y: number) =>
    new Ray(new Vector3(7, y, 0), new Vector3(-1, 0, 0).normalize())

  const grab = beginAxisDrag(rayAt(2), [0, 2, 0], dirY)
  if (!grab) throw new Error('no grab')

  near('forward travel reads the pointer offset', axisTravel(grab, rayAt(3.5), dirY) ?? NaN, 1.5, 1e-9)
  near('and backward travel is negative', axisTravel(grab, rayAt(0.5), dirY) ?? NaN, -1.5, 1e-9)
  near('returning to the grab reads zero again', axisTravel(grab, rayAt(2), dirY) ?? NaN, 0, 1e-9)

  const back = axisTarget(grab, dirY, axisTravel(grab, rayAt(2), dirY) ?? NaN)
  near('so the target returns exactly where it began', back[1], 2, 1e-9)
}


// --- 14. Sliding a sketch along the surface it sits on ----------------------
console.log('\n14. slideAnchor moves a sketch across its own patch, and no further')

{
  // A flat face: the tangent offset is the answer directly, and the anchor's
  // own normalised u must move in step with it.
  const box: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const host = hostSurfaceFor(box, { on: 'box-face', face: 2, u: 0, v: 0 })
  const start: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }

  const slid = slideAnchor(host, start, 0.4, 0)
  check('a slide across a flat face lands', slid !== null, `${slid && slid.on}`)
  if (slid && slid.on === 'box-face') {
    check('and stays on the same face', slid.face === 2, `${slid.face}`)
    // The face is 2 units across, so u is normalised over a half-extent of 1:
    // 0.4 of an object unit is 0.4 of the way to the edge.
    near('with u following the offset', slid.u, 0.4, 1e-9)
    near('and v untouched', slid.v, 0, 1e-9)
  }

  // The point of the null: past the edge of the face, the classifier finds the
  // NEXT face round the corner, or nothing. Either way the sketch must not
  // follow it there -- the gesture promised a slide ALONG this face.
  check('a slide past the edge refuses', slideAnchor(host, start, 4, 0) === null, 'off the +U end')
  check('and so does one off the other side', slideAnchor(host, start, 0, -4) === null, 'off the -V end')

  // Both tangents work, independently.
  const sideways = slideAnchor(host, start, 0, 0.3)
  check('the V tangent moves the other way', sideways !== null && sideways.on === 'box-face', `${sideways && sideways.on}`)
  if (sideways && sideways.on === 'box-face') {
    near('with v following', sideways.v, 0.3, 1e-9)
    near('and u untouched', sideways.u, 0, 1e-9)
  }
}

{
  // A sphere is the case a straight tangent step would get wrong: offset along
  // the tangent and you leave the solid immediately. `project` re-seats the
  // point radially, so the slide follows the curvature.
  const ball: BaseSolid = { kind: 'sphere', radius: 1 }
  const start: SurfaceAnchor = { on: 'sphere', theta: 0, phi: Math.PI / 2 }
  const host = hostSurfaceFor(ball, start)

  const slid = slideAnchor(host, start, 0.5, 0)
  check('a slide across a sphere lands', slid !== null && slid.on === 'sphere', `${slid && slid.on}`)

  if (slid) {
    // The landing point must be ON the sphere, not out on the tangent plane
    // where a naive offset would have left it (that point sits at radius
    // sqrt(1 + 0.25) = 1.118).
    const point = host.frame(slid).origin
    near('and the sketch stays on the surface', point.length(), 1, 1e-9)
    // A tangent step of 0.5 subtends atan(0.5) at the centre, which is the
    // angle the re-seated point has actually travelled.
    const moved = point.angleTo(host.frame(start).origin)
    near('having travelled the angle the tangent subtends', moved, Math.atan(0.5), 1e-9)
  }

  // A sphere has no edge, so no offset can ever run off it.
  check('a sphere never refuses', slideAnchor(host, start, 40, 0) !== null, 'no edge to fall off')
}

{
  // A cylinder wall: sliding along its own +Y tangent is a straight move up the
  // barrel, and running past the rim leaves the patch.
  const cyl: BaseSolid = { kind: 'cylinder', radius: 0.8, height: 2 }
  const start: SurfaceAnchor = { on: 'cylinder', theta: 0, y: 0 }
  const host = hostSurfaceFor(cyl, start)

  const slid = slideAnchor(host, start, 0, 0.5) ?? slideAnchor(host, start, 0.5, 0)
  check('a slide along a barrel lands', slid !== null && slid.on === 'cylinder', `${slid && slid.on}`)
  if (slid) {
    near('and stays at the barrel radius', Math.hypot(host.frame(slid).origin.x, host.frame(slid).origin.z), 0.8, 1e-9)
  }
  check(
    'but running off the end refuses',
    slideAnchor(host, start, 0, 40) === null || slideAnchor(host, start, 40, 0) === null,
    'past the rim'
  )
}

{
  // A derived patch has no parameterisation at all -- its anchor IS a point and
  // a normal -- so it is the one kind that cannot go through `anchorFromHit`,
  // which always answers null there. Without its own branch every slide on a
  // face an earlier feature created would silently do nothing.
  const box: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const start: SurfaceAnchor = { on: 'derived', point: [0, 1, 0], normal: [0, 1, 0] }
  const host = hostSurfaceFor(box, start)

  const slid = slideAnchor(host, start, 0.35, 0)
  check('a derived patch slides too', slid !== null && slid.on === 'derived', `${slid && slid.on}`)
  if (slid && slid.on === 'derived') {
    near('by the offset it was given', Math.hypot(slid.point[0] - 0, slid.point[2] - 0), 0.35, 1e-9)
    near('staying in its own plane', slid.point[1], 1, 1e-9)
    check(
      'and keeping the normal it was created with',
      slid.normal[0] === 0 && slid.normal[1] === 1 && slid.normal[2] === 0,
      slid.normal.join(',')
    )
  }
}

{
  // Every anchor kind must slide, or the gizmo is dead on that host and nothing
  // says so. Built the way the app builds them: from each solid's own frame.
  const hosts: { label: string; base: BaseSolid; anchor: SurfaceAnchor }[] = [
    { label: 'box', base: { kind: 'box', size: [2, 2, 2] }, anchor: { on: 'box-face', face: 2, u: 0, v: 0 } },
    { label: 'sphere', base: { kind: 'sphere', radius: 1 }, anchor: { on: 'sphere', theta: 0, phi: Math.PI / 2 } },
    { label: 'cylinder', base: { kind: 'cylinder', radius: 0.8, height: 2 }, anchor: { on: 'cylinder', theta: 0, y: 0 } },
    { label: 'cone', base: { kind: 'cone', radius: 0.9, height: 2 }, anchor: { on: 'cone', theta: 0, t: 0.5 } },
    { label: 'capsule', base: { kind: 'capsule', radius: 0.6, height: 1.2 }, anchor: { on: 'capsule', theta: 0, phi: Math.PI / 2 } },
    { label: 'prism', base: { kind: 'prism', radius: 1, height: 1.8, sides: 6 }, anchor: { on: 'planar-face', face: 0, u: 0, v: 0 } },
    { label: 'derived', base: { kind: 'box', size: [2, 2, 2] }, anchor: { on: 'derived', point: [0, 1, 0], normal: [0, 1, 0] } },
  ]

  for (const { label, base, anchor } of hosts) {
    const host = hostSurfaceFor(base, anchor)
    const u = slideAnchor(host, anchor, 0.08, 0)
    const v = slideAnchor(host, anchor, 0, 0.08)
    check(`${label} slides on U`, u !== null && samePatch(u, anchor), `${u && u.on}`)
    check(`${label} slides on V`, v !== null && samePatch(v, anchor), `${v && v.on}`)
  }
}


// --- 15. Scaling a sketch outline with the ring -----------------------------
console.log('\n15. The sketch ring scales an outline without reshaping it')

{
  const box: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  // A 2-unit box: the shared bound puts a sketch radius at half the smallest
  // side, so 1.0, and a rectangle's full sides at twice that.
  const max = maxShapeSize(box)
  near('the shared bound is half the smallest side', max, 1, 1e-9)

  const circle = scaleShape({ type: 'circle', r: 0.3 }, 1.5, max)
  check('a circle scales its radius', circle.type === 'circle' && Math.abs(circle.r - 0.45) < 1e-9, JSON.stringify(circle))

  const ngon = scaleShape({ type: 'ngon', r: 0.3, sides: 6 }, 2, max)
  check('a polygon scales its radius', ngon.type === 'ngon' && Math.abs(ngon.r - 0.6) < 1e-9, JSON.stringify(ngon))
  check('and keeps its side count', ngon.type === 'ngon' && ngon.sides === 6, JSON.stringify(ngon))

  const rect = scaleShape({ type: 'rect', w: 0.6, h: 0.4 }, 1.5, max)
  check(
    'a rectangle scales both sides',
    rect.type === 'rect' && Math.abs(rect.w - 0.9) < 1e-9 && Math.abs(rect.h - 0.6) < 1e-9,
    JSON.stringify(rect)
  )
}

{
  // Same trap the solid ring has: clamping each side on its own would let a
  // long thin rectangle stop growing on one axis and keep fattening on the
  // other, quietly changing an aspect ratio nobody asked to change.
  const max = maxShapeSize({ kind: 'box', size: [2, 2, 2] })
  const slab = scaleShape({ type: 'rect', w: 1.8, h: 0.3 }, 10, max)
  check('a runaway rectangle stops at the ceiling', slab.type === 'rect' && Math.abs(slab.w - max * 2) < 1e-9, JSON.stringify(slab))
  if (slab.type === 'rect') {
    near('with the aspect ratio intact', slab.w / slab.h, 6, 1e-9)
  }

  const tiny = scaleShape({ type: 'circle', r: 0.3 }, 1e-6, max)
  check('and shrinking stops at the floor', tiny.type === 'circle' && Math.abs(tiny.r - MIN_SHAPE) < 1e-12, JSON.stringify(tiny))

  // Scaling up and back down returns the original, which is only true because
  // the factor is clamped once rather than per dimension.
  const there = scaleShape({ type: 'rect', w: 0.6, h: 0.4 }, 1.5, max)
  const back = scaleShape(there, 1 / 1.5, max)
  check(
    'scaling up then back is the identity',
    back.type === 'rect' && Math.abs(back.w - 0.6) < 1e-9 && Math.abs(back.h - 0.4) < 1e-9,
    JSON.stringify(back)
  )
}


// --- 16. Turning with the ring ----------------------------------------------
console.log('\n16. A ring turn runs about one axis, unwraps, and holds at 45 degrees')

{
  // The axis is whichever of the target's OWN three best faces the viewer, so
  // the turn reads as a twist of the screen. Looking straight down -Z picks Z.
  const down = new Vector3(0, 0, -1)
  const picked = nearestViewAxis([0, 0, 0], down)
  check('looking down Z turns about Z', picked.index === 2, `axis ${picked.index}`)
  // Signed toward the viewer, so a drag turns the target the way it went.
  near('with the axis facing the camera', picked.axis.z, 1, 1e-9)

  const side = nearestViewAxis([0, 0, 0], new Vector3(-1, 0, 0))
  check('looking down X turns about X', side.index === 0, `axis ${side.index}`)
  near('and that one faces the camera too', side.axis.x, 1, 1e-9)

  // The axes are whichever frame the caller names. Handed a target's own
  // rotation -- which is what the CUT PLANE does, its tilt being the thing the
  // ring drives -- a quarter turn about Y puts local X down world -Z, so a
  // camera looking down -Z picks that axis rather than world Z.
  const turned = nearestViewAxis([0, Math.PI / 2, 0], down)
  check('a frame of its own offers its OWN axes', turned.index === 0, `axis ${turned.index}`)

  // The OBJECT gizmo names the world frame instead, so the same rotated target
  // still turns about world Z. The three axes on offer never move, however far
  // the object has been turned -- which is the point: the arrows do not move
  // either, and a ring that wandered off them would not match what is drawn.
  const world = nearestViewAxis(WORLD_FRAME, down)
  check('but the world frame ignores the target', world.index === 2, `axis ${world.index}`)
  near('and still faces the camera', world.axis.z, 1, 1e-9)

  // Said the other way round, which is how the gesture actually reads: the turn
  // runs IN the world plane most square-on to the camera, since that plane's
  // normal is the axis left out of it. Down -Z, that plane is XY.
  const oblique = nearestViewAxis(WORLD_FRAME, new Vector3(0.2, -0.95, 0.24).normalize())
  check(
    'a camera looking down turns things in the XZ plane',
    oblique.index === 1,
    `axis ${oblique.index}`
  )
  near('about +Y, back toward the viewer', oblique.axis.y, 1, 1e-9)
}

{
  // WHAT "THE OBJECT'S OWN AXES" ARE, which is what a Scale arrow now points
  // along and what its drag is measured along -- see `local` on `GizmoParts`.
  // A world arrow used to be matched to whichever of these it most nearly ran
  // along; ridden to the object there is nothing left to match, so what is
  // worth pinning is the frame itself.
  const flat = frameAxes(WORLD_FRAME)
  near('an unturned object stands in the world', flat[0].x, 1, 1e-9)
  near('down all three', flat[1].y, 1, 1e-9)
  near('of them', flat[2].z, 1, 1e-9)

  // A quarter turn about Y lays local X down world -Z. That arrow still resizes
  // the box's WIDTH -- `size[0]` is measured along local X whatever the box has
  // since been turned to -- and now it points along the side it grows, which is
  // the whole of what changed.
  const quarter: Vec3 = [0, Math.PI / 2, 0]
  const turned = frameAxes(quarter)
  near('a quarter turn about Y lays local X down world -Z', turned[0].z, -1, 1e-9)
  near('with nothing left on X', turned[0].x, 0, 1e-9)
  near('and sends local Z along world +X', turned[2].x, 1, 1e-9)
  near('while Y, the axis turned about, is untouched', turned[1].y, 1, 1e-9)

  // Unit length at any angle at all, which is what lets `axisTravel` read a
  // pointer's travel along one of them as a distance in the world.
  for (const axis of frameAxes([0.3, 0.4, 0.2])) {
    near('an askew frame is still three unit axes', axis.length(), 1, 1e-9)
  }

  // And still a frame: three axes at right angles, so a drag along one reads
  // nothing of the other two.
  const askew = frameAxes([0.3, 0.4, 0.2])
  near('at right angles to each other', askew[0].dot(askew[1]), 0, 1e-9)
  near('all three ways', askew[1].dot(askew[2]), 0, 1e-9)
  near('round', askew[2].dot(askew[0]), 0, 1e-9)
}

{
  // Unwrapping. A pointer dragged steadily round must keep counting past the
  // +/-pi seam instead of flipping sign, or a turn would snap back at 180.
  const grab: TurnGrab = {
    axis: new Vector3(0, 0, 1),
    rotation: [0, 0, 0],
    position: [0, 0, 0],
    lastAngle: 0,
    total: 0,
  }

  const steps = 24
  let last = 0
  // One and a half full turns, in even steps, every one of which crosses the
  // seam eventually.
  for (let i = 1; i <= steps; i++) {
    const raw = (i * 3 * Math.PI) / steps
    // What atan2 would actually report: wrapped into (-pi, pi].
    const wrapped = Math.atan2(Math.sin(raw), Math.cos(raw))
    last = advanceTurn(grab, wrapped)
  }
  near('a turn and a half counts as a turn and a half', last, 3 * Math.PI, 1e-9)
  check('and the total never went backwards', grab.total > 0, `${grab.total.toFixed(4)}`)

  // And back the other way, to exactly where it started.
  for (let i = steps - 1; i >= 0; i--) {
    const raw = (i * 3 * Math.PI) / steps
    advanceTurn(grab, Math.atan2(Math.sin(raw), Math.cos(raw)))
  }
  near('reversing all the way returns to zero', grab.total, 0, 1e-9)
}

{
  // Detents every 45 degrees, with 3 degrees of pull either side.
  const deg = (d: number) => (d * Math.PI) / 180
  const inDeg = (r: number) => (r * 180) / Math.PI

  near('45 is a detent', TURN_SNAP, deg(45), 1e-12)
  near('and the pull reaches 3 degrees', TURN_SNAP_WINDOW, deg(3), 1e-12)

  // The stated case, from both sides and at the edges of the window.
  for (const d of [42, 43.5, 45, 46.2, 48]) {
    near(`${d} degrees lands on 45`, inDeg(snapTurn(deg(d))), 45, 1e-9)
  }

  // Just outside it the turn is the user's again, to the degree. This is what
  // separates a magnet from a ratchet: no grid in the middle.
  for (const d of [41.9, 48.1, 20, 63]) {
    near(`${d} degrees is left alone`, inDeg(snapTurn(deg(d))), d, 1e-9)
  }

  // Every detent, the whole way round and past it, from both sides -- a
  // rounding that only held near zero would strand the far half of a turn.
  // Rolled into one assertion rather than eighty, since the answer worth
  // reading is whether any of them missed.
  const missed: string[] = []
  for (let k = -10; k <= 10; k++) {
    const detent = k * 45
    for (const approach of [-2.5, 2.5]) {
      const landed = inDeg(snapTurn(deg(detent + approach)))
      if (Math.abs(landed - detent) > 1e-9) missed.push(`${detent} from ${approach}`)
    }
  }
  check(
    'every detent holds, from either side, past a full turn',
    missed.length === 0,
    missed.length ? missed.join('; ') : '21 detents, -450 to 450 degrees'
  )

  // Zero is a detent like the rest, so a press that was meant as a click does
  // not tip the target over by a degree and a half.
  near('a twitch at the start is nothing', snapTurn(deg(1.5)), 0, 1e-12)
  near('and the same the other way', snapTurn(deg(-1.5)), 0, 1e-12)

  // Idempotent, which is what lets the snapped value be handed to the document
  // and the dial alike without either one drifting from the other.
  const once = snapTurn(deg(44))
  near('snapping a snapped turn changes nothing', snapTurn(once), once, 1e-12)

  // The grab's own total stays raw: the detent is applied on the way out, so a
  // pointer that drifts through 45 and carries on to 60 arrives at 60 rather
  // than at 60 minus whatever the detent had quietly absorbed.
  const grab: TurnGrab = {
    axis: new Vector3(0, 1, 0),
    rotation: [0, 0, 0],
    position: [0, 0, 0],
    lastAngle: 0,
    total: 0,
  }
  for (const d of [10, 30, 44, 45, 46, 60]) snapTurn(advanceTurn(grab, deg(d)))
  near('the running total never absorbs a snap', inDeg(grab.total), 60, 1e-9)
  near('and the reading leaving it is free again', inDeg(snapTurn(grab.total)), 60, 1e-9)
}

{
  // The rotation written back is the grab's, turned -- never the live value,
  // which is what would let the result feed back into the measurement.
  const grab: TurnGrab = {
    axis: new Vector3(0, 1, 0),
    rotation: [0, 0, 0],
    position: [0, 0, 0],
    lastAngle: 0,
    total: 0,
  }
  const quarter = turnedRotation(grab, Math.PI / 2)
  near('a quarter turn about Y lands on Y', quarter[1], Math.PI / 2, 1e-9)
  check('leaving the other two alone', Math.abs(quarter[0]) < 1e-9 && Math.abs(quarter[2]) < 1e-9, quarter.join(','))

  // Same grab, same call, twice: the answer cannot drift, because nothing about
  // it depends on what the target currently carries.
  const again = turnedRotation(grab, Math.PI / 2)
  check('and asking twice gives the same answer', again.every((v, i) => v === quarter[i]), again.join(','))

  near('zero travel is the identity', turnedRotation(grab, 0)[1], 0, 1e-9)

  // A merged object's ring sits at the centre of the solids in it, not at the
  // host's origin, so the same turn has to carry that origin round the ring.
  // Turning about the origin instead would swing the whole assembly off to one
  // side of the gizmo the user is holding.
  const swung = turnedPosition({ ...grab, position: [2, 0, 0] }, Math.PI / 2, [0, 0, 0])
  near('a quarter turn about Y carries the origin round', swung[2], -2, 1e-9)
  near('leaving the axis it turned about alone', swung[1], 0, 1e-9)

  // The degenerate case every caller relies on: a bare solid's pivot IS its
  // origin, so this hands the position straight back and no caller has to ask
  // which kind of object it is holding.
  const still = turnedPosition({ ...grab, position: [3, 1, -2] }, Math.PI / 3, [3, 1, -2])
  check('turning about its own origin moves nothing', still.join() === '3,1,-2', still.join())

  // Turning about an axis the target already carries rotation on composes
  // rather than replacing: a quarter added to a quarter is a half.
  //
  // Asserted on where the rotation SENDS a vector, not on the Euler components,
  // because a half turn about Y is stored by XYZ decomposition as (pi, 0, pi) --
  // the same rotation, wearing a different triple. A component check here would
  // be testing three.js's choice of decomposition rather than this function.
  const already: TurnGrab = { ...grab, rotation: [0, Math.PI / 2, 0] }
  const half = turnedRotation(already, Math.PI / 2)
  const sent = new Vector3(1, 0, 0).applyEuler(new Euler(half[0], half[1], half[2], 'XYZ'))
  near('a turn composes with what was there', sent.x, -1, 1e-9)
  check('sending +X to -X, which is a half turn', Math.abs(sent.y) < 1e-9 && Math.abs(sent.z) < 1e-9, `${sent.x.toFixed(3)}, ${sent.y.toFixed(3)}, ${sent.z.toFixed(3)}`)
}


// --- 17. Merging ------------------------------------------------------------
console.log('\n17. A merged object is one solid, welded where the parts stood')

{
  // `relativeTransform` is the whole of a merge: an object that has been
  // sitting somewhere keeps sitting exactly there, and the only thing that
  // changes is which frame its numbers are written in.
  const host = { position: [2, 1, 0] as Vec3, rotation: [0, Math.PI / 2, 0] as Vec3 }
  const guest = { position: [5, 1, 0] as Vec3, rotation: [0, 0, 0] as Vec3 }

  const local = relativeTransform(host, guest)
  // Composing the host back on has to return the guest to where it was, or the
  // merge moved something.
  const back = new Vector3(0, 0, 0)
    .applyMatrix4(objectMatrix(local))
    .applyMatrix4(objectMatrix(host))
  near('a merged part keeps its world X', back.x, 5, 1e-9)
  near('and its world Y', back.y, 1, 1e-9)
  near('and its world Z', back.z, 0, 1e-9)

  // Into an unrotated host the local placement is just the difference.
  const plain = relativeTransform(
    { position: [1, 0, 0], rotation: [0, 0, 0] },
    { position: [4, 2, -1], rotation: [0, 0, 0] }
  )
  near('into an upright host it is a plain offset', plain.position[0], 3, 1e-9)
  near('on every axis', plain.position[1], 2, 1e-9)
  near('including the third', plain.position[2], -1, 1e-9)
}

{
  // Two cubes far enough apart to share no volume: the union is exactly the two
  // of them, so the merged object must measure the sum. Anything less would
  // mean the weld swallowed geometry; anything more, that it double-counted.
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const apart: SceneObject = {
    ...object(cube, [], [], 'host'),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    parts: [
      {
        ...object(cube, [], [], 'guest'),
        transform: { position: [4, 0, 0], rotation: [0, 0, 0] },
      },
    ],
  }

  resetEvaluator()
  const merged = evaluateObject(apart)
  near('two disjoint cubes merge to twice the volume', signedVolume(merged.geometry), 16, 0.01)
  check('and nothing failed to weld', merged.failed.length === 0, merged.failed.join(','))
  merged.geometry.dispose()
}

{
  // Overlapping is the case a naive concatenation would get wrong: the shared
  // volume must be counted ONCE. Two 2-cubes offset by 1 on X share a 1x2x2
  // slab, so the union is 8 + 8 - 4 = 12.
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const overlapping: SceneObject = {
    ...object(cube, [], [], 'host2'),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    parts: [
      {
        ...object(cube, [], [], 'guest2'),
        transform: { position: [1, 0, 0], rotation: [0, 0, 0] },
      },
    ],
  }

  resetEvaluator()
  const merged = evaluateObject(overlapping)
  near('an overlap is counted once, not twice', signedVolume(merged.geometry), 12, 0.02)
  merged.geometry.dispose()
}

{
  // A part is a whole SceneObject, so it brings its own features -- and they
  // have to survive the weld. A cube with a through-hole merged into another
  // cube must still have its hole.
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const pocket: Feature = {
    ...defaultFeature({ on: 'box-face', face: 2, u: 0, v: 0 }, { type: 'circle', r: 0.4 }),
    depth: -3,
  }

  resetEvaluator()
  const drilled = evaluateObject(object(cube, [pocket], [], 'drilled'))
  const drilledVolume = signedVolume(drilled.geometry)
  drilled.geometry.dispose()
  check('the guest alone has a hole in it', drilledVolume < 8 - 0.5, `${drilledVolume.toFixed(4)}`)

  const merged: SceneObject = {
    ...object(cube, [], [], 'host3'),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    parts: [
      {
        ...object(cube, [pocket], [], 'guest3'),
        transform: { position: [4, 0, 0], rotation: [0, 0, 0] },
      },
    ],
  }
  resetEvaluator()
  const welded = evaluateObject(merged)
  near(
    "a part's own features survive the merge",
    signedVolume(welded.geometry),
    8 + drilledVolume,
    0.02
  )
  welded.geometry.dispose()
}

{
  // Nesting. Merging something that was itself a merge must not flatten or
  // lose the inner parts -- three disjoint cubes, three cubes' worth.
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const at = (x: number, id: string): SceneObject => ({
    ...object(cube, [], [], id),
    transform: { position: [x, 0, 0], rotation: [0, 0, 0] },
  })

  const nested: SceneObject = {
    ...at(0, 'outer'),
    parts: [{ ...at(4, 'middle'), parts: [at(4, 'inner')] }],
  }

  resetEvaluator()
  const merged = evaluateObject(nested)
  // The inner part is 4 from the middle, which is itself 4 from the host: the
  // three land at 0, 4 and 8, so none of them touch.
  near('a merge of a merge keeps every solid', signedVolume(merged.geometry), 24, 0.02)
  merged.geometry.dispose()
}

// --- 18. A pocket has a created face too -----------------------------------
console.log('\n18. Tilt and slide reach a pocket, not just a boss')
{
  // The guard that says "this feature has a face to lean" used to read
  // `depth > 0`, which was the whole truth while depth was a magnitude. Under a
  // signed depth that quietly answers no for every pocket, and the symptom is a
  // handle and a panel group that stop appearing rather than anything that
  // throws -- so it is pinned here, against the geometry, rather than left to
  // the eye.
  const surface = hostSurfaceFor(CUBE, TOP_FACE)
  const face = (depth: number, tilt: Vec3 = [0, 0, 0]) =>
    endFaceFrame(surface, TOP_FACE, { depth, tilt, faceOffset: [0, 0] })

  check('a boss has a created face', face(0.4) !== null, '')
  check('and so does a pocket', face(-0.4) !== null, '')
  check('a flat projection has none', face(0) === null, '')

  // The cube's top face sits at y = 1, so the two straddle it by their depth.
  const boss = face(0.4)
  const pocket = face(-0.4)
  if (boss) near('the boss face stands proud of the surface', boss.origin.y, 1.4, 1e-9)
  if (pocket) near('and the pocket floor sits below it', pocket.origin.y, 0.6, 1e-9)

  // A tilt has to reach the pocket as well, or the End face panel would offer
  // controls that moved nothing.
  const leaned = face(-0.4, [0, 0, Math.PI / 12])
  check(
    'a tilted pocket floor is not level',
    leaned !== null && leaned.normal.y < 0.999,
    ''
  )
}

// --- 19. A merge keeps every colour ----------------------------------------
console.log('\n19. A merge keeps every colour')
{
  // The document always held a colour per solid, and a merge never threw one
  // away -- but the union that gets drawn is a single mesh, so until it could
  // say which triangles came from which solid, one colour was all it could
  // wear. `paints` is that answer: one entry per group, naming the solid whose
  // triangles are in it.
  //
  // Checked against the GEOMETRY rather than against the renderer, because the
  // claim is a geometric one. If group k really is the part's triangles and
  // nobody else's, then for two disjoint cubes group k is a closed cube of
  // volume 8 all by itself -- and a number cannot be approximately the right
  // solid.

  /** Signed volume of one group's triangles alone. */
  const groupVolume = (geometry: BufferGeometry, at: number): number => {
    const group = geometry.groups[at]
    const pos = geometry.getAttribute('position')
    const index = geometry.getIndex()
    const vertex = (i: number) =>
      new Vector3().fromBufferAttribute(pos, index ? index.getX(i) : i)

    let volume = 0
    const end = group.start + group.count
    for (let i = group.start; i + 2 < end; i += 3) {
      const a = vertex(i)
      const b = vertex(i + 1)
      const c = vertex(i + 2)
      volume += a.dot(new Vector3().crossVectors(b, c)) / 6
    }
    return volume
  }

  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const at = (x: number, id: string, color?: string): SceneObject => ({
    ...object(cube, [], [], id),
    color,
    transform: { position: [x, 0, 0], rotation: [0, 0, 0] },
  })

  {
    const merged: SceneObject = {
      ...at(0, 'red-host', '#cc2222'),
      parts: [at(4, 'blue-guest', '#2244cc')],
    }

    resetEvaluator()
    const { geometry, paints } = evaluateObject(merged)

    check(
      'a merge of two solids reports both of them',
      paints.length === 2 && paints.includes('red-host') && paints.includes('blue-guest'),
      paints.join(',')
    )
    check(
      'one group per solid, so every group has a colour to wear',
      geometry.groups.length === paints.length,
      `${geometry.groups.length} groups, ${paints.length} paints`
    )

    const host = paints.indexOf('red-host')
    const guest = paints.indexOf('blue-guest')
    if (host >= 0 && guest >= 0 && geometry.groups.length === 2) {
      near("the host's group is the host's cube, whole", groupVolume(geometry, host), 8, 0.02)
      near("and the part's is the part's", groupVolume(geometry, guest), 8, 0.02)
    }
    geometry.dispose()
  }

  {
    // Nesting, since a part may itself be a merge: its own parts have to arrive
    // still saying which triangles were whose, or a merge of a merge would
    // flatten to two colours instead of three.
    const nested: SceneObject = {
      ...at(0, 'outer-c'),
      parts: [{ ...at(4, 'middle-c'), parts: [at(8, 'inner-c')] }],
    }

    resetEvaluator()
    const { geometry, paints } = evaluateObject(nested)
    check(
      'a merge of a merge reports all three',
      paints.length === 3 &&
        ['outer-c', 'middle-c', 'inner-c'].every((id) => paints.includes(id)),
      paints.join(',')
    )
    geometry.dispose()
  }

  {
    // A part swallowed whole shows no face, so it must claim no colour: a paint
    // for a solid with nothing on screen would leave the viewport building a
    // material for a group that does not exist.
    const swallowed: SceneObject = {
      ...object({ kind: 'box', size: [4, 4, 4] }, [], [], 'big'),
      parts: [at(0, 'tiny')],
    }

    resetEvaluator()
    const { geometry, paints } = evaluateObject(swallowed)
    check(
      'a part buried inside its host claims no colour',
      paints.length === 1 && paints[0] === 'big',
      paints.join(',')
    )
    geometry.dispose()
  }

  {
    // The cache key must not mention colour. It reads the parts, and a part
    // carries its colour, so the obvious serialisation re-runs every boolean in
    // an assembly to repaint one solid of it -- for a result identical triangle
    // for triangle. Identity is the check: a cache hit hands back the very same
    // geometry.
    const painted: SceneObject = {
      ...at(0, 'keep-host', '#cc2222'),
      parts: [at(4, 'keep-guest', '#2244cc')],
    }

    resetEvaluator()
    const first = evaluateDoc(scene(painted))
    const before = first.objects[0].geometry
    const named = first.objects[0].paints.join(',')

    const repainted: SceneObject = {
      ...painted,
      color: '#22cc44',
      parts: [{ ...painted.parts[0], color: '#cccc22' }],
    }
    const second = evaluateDoc(scene(repainted))
    check(
      'recolouring a merged object re-runs no boolean',
      second.objects[0].geometry === before,
      second.objects[0].geometry === before ? 'same geometry' : 'rebuilt'
    )
    check(
      'and the paints still name the solids, not the colours',
      second.objects[0].paints.join(',') === named,
      second.objects[0].paints.join(',')
    )
  }

  {
    // The property a multi-material mesh actually rests on: the groups TILE the
    // index buffer. A gap is triangles nothing draws, an overlap is triangles
    // drawn twice in two colours, and neither throws -- both just look wrong,
    // which is the kind of wrong a headless check is for. Run against the worst
    // case there is: an assembly three levels deep, with a pocket through the
    // host and a plane cut across the lot.
    const drilled: Feature = {
      ...defaultFeature({ on: 'box-face', face: 2, u: 0, v: 0 }, { type: 'circle', r: 0.4 }),
      depth: -3,
    }
    const sliced: CutPlane = { id: 'paint-cut', origin: [0, 0, 0], normal: [0, 0, 1], side: 1 }
    const gnarly: SceneObject = {
      ...object(cube, [drilled], [sliced], 'g-host'),
      parts: [at(1.5, 'g-one'), { ...at(3.2, 'g-two'), parts: [at(1.4, 'g-three')] }],
    }

    resetEvaluator()
    const { geometry, paints, failed } = evaluateObject(gnarly)
    check('a pocket and a cut lose no solid', paints.length === 4, paints.join(','))
    check('and nothing failed on the way', failed.length === 0, failed.join(','))

    const index = geometry.getIndex()
    const total = index ? index.count : geometry.getAttribute('position').count
    const covered = new Array<number>(total).fill(0)
    let stray = 0
    for (const group of geometry.groups) {
      if ((group.materialIndex ?? -1) < 0 || (group.materialIndex ?? 0) >= paints.length) stray++
      for (let i = group.start; i < Math.min(group.start + group.count, total); i++) {
        covered[i] += 1
      }
    }
    check('every group points at a paint', stray === 0, `${stray} stray`)
    check(
      'and the groups tile the mesh -- no triangle undrawn',
      covered.every((n) => n === 1),
      `${covered.filter((n) => n === 0).length} bare, ${covered.filter((n) => n > 1).length} doubled`
    )
    geometry.dispose()
  }

  {
    // An unmerged solid is ONE paint, and that has to stay true rather than
    // merely equivalent: the viewport gives a single-paint object one plain
    // material, because a mesh with an ARRAY material draws group by group and
    // a base solid that never met a boolean has no groups to draw.
    resetEvaluator()
    const { geometry, paints } = evaluateObject(object(cube, [], [], 'lonely'))
    check(
      'a lone solid is one paint',
      paints.length === 1 && paints[0] === 'lonely',
      paints.join(',')
    )
    geometry.dispose()
  }
}

// --- 20. Erasing takes material away, and keeps it away ---------------------
console.log('\n20. Erasing takes material away, and keeps it away')
{
  // An eraser is a solid stored on the object it cut -- the negative of a
  // merged part -- and the whole of what makes it an ERASER rather than one
  // more step in the middle is WHERE it runs: last, after the features and the
  // cuts. Everything below is that claim, measured.
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const drill: BaseSolid = { kind: 'cylinder', radius: 0.4, height: 4 }

  const hole = (id: string, at: Vec3): SceneObject => ({
    ...object(drill, [], [], id),
    transform: { position: at, rotation: [0, 0, 0] },
  })

  {
    resetEvaluator()
    const plain = evaluateObject(object(cube, [], [], 'plain'))
    const whole = signedVolume(plain.geometry)
    plain.geometry.dispose()

    const drilled: SceneObject = {
      ...object(cube, [], [], 'drilled'),
      erased: [hole('bore', [0, 0, 0])],
    }
    resetEvaluator()
    const cut = evaluateObject(drilled)
    // A 0.4-radius bore clean through a 2-cube takes pi * 0.16 * 2 of it.
    near('a bore takes its own volume out', whole - signedVolume(cut.geometry), Math.PI * 0.16 * 2, 0.02)
    check('and nothing failed', cut.failed.length === 0, cut.failed.join(','))
    cut.geometry.dispose()
  }

  {
    // The ordering claim. A boss raised on the top face passes straight through
    // where the bore runs; erasing LAST means the bore wins. Applied before the
    // features instead, the boss would have filled the hole back in and the two
    // volumes below would be equal.
    const boss: Feature = {
      ...defaultFeature({ on: 'box-face', face: 2, u: 0, v: 0 }, { type: 'circle', r: 0.6 }),
      depth: 0.5,
    }
    resetEvaluator()
    const bossed = evaluateObject(object(cube, [boss], [], 'bossed'))
    const withBoss = signedVolume(bossed.geometry)
    bossed.geometry.dispose()

    resetEvaluator()
    const both = evaluateObject({
      ...object(cube, [boss], [], 'bossed-bore'),
      erased: [hole('bore2', [0, 0, 0])],
    })
    const drilledVolume = signedVolume(both.geometry)
    both.geometry.dispose()
    check(
      'a boss grown into the hole does not fill it back in',
      withBoss - drilledVolume > 1,
      `${(withBoss - drilledVolume).toFixed(4)} removed`
    )
  }

  {
    // A cut and an eraser on the same solid. Both take material away and they
    // must compose rather than cancel: half a cube, then a bore through what
    // is left.
    const keep: CutPlane = { id: 'erase-cut', origin: [0, 0, 0], normal: [0, 0, 1], side: 1 }
    resetEvaluator()
    const halved = evaluateObject(object(cube, [], [keep], 'halved'))
    const half = signedVolume(halved.geometry)
    halved.geometry.dispose()

    resetEvaluator()
    const both = evaluateObject({
      ...object(cube, [], [keep], 'halved-bore'),
      erased: [hole('bore3', [0, 0, 0])],
    })
    // The bore straddles the cut plane, so exactly half of it lands in the half
    // that was kept.
    near('a cut and an eraser compose', half - signedVolume(both.geometry), Math.PI * 0.16, 0.02)
    both.geometry.dispose()
  }

  {
    // A hole is a solid, and it scales with the object it is in. Left alone it
    // would stay the size it was while the object grew around it, which is the
    // one thing a user resizing a drilled block never means.
    const drilled: SceneObject = {
      ...object(cube, [], [], 'scaled'),
      erased: [hole('bore4', [0, 0, 0])],
    }
    resetEvaluator()
    const before = evaluateObject(drilled)
    const wasVolume = signedVolume(before.geometry)
    before.geometry.dispose()

    const bigger = scaleAssembly(drilled, 2)
    resetEvaluator()
    const after = evaluateObject(bigger)
    // Every length doubled, so every volume is eight times what it was -- the
    // hole included. A hole that stayed put would leave more material than that.
    near('doubling the object doubles the hole', signedVolume(after.geometry), wasVolume * 8, 0.05)
    after.geometry.dispose()
  }

  {
    // The walls the hole opens up wear the OBJECT's paint, the rule a pocket's
    // walls and a cut face already follow. An eraser is not in the scene by the
    // time this runs and has no colour of its own to lend.
    resetEvaluator()
    const { geometry, paints } = evaluateObject({
      ...object(cube, [], [], 'painted'),
      color: '#cc2222',
      erased: [hole('bore5', [0, 0, 0])],
    })
    check(
      'the hole wears the colour of the solid it is in',
      paints.length === 1 && paints[0] === 'painted',
      paints.join(',')
    )
    geometry.dispose()
  }

  {
    // An eraser parked clear of the solid must take nothing. The store refuses
    // to store one that would -- see `removesMaterial` -- but the evaluator has
    // to be harmless about it either way.
    resetEvaluator()
    const missed = evaluateObject({
      ...object(cube, [], [], 'missed'),
      erased: [hole('bore6', [0, 6, 0])],
    })
    near('an eraser that misses removes nothing', signedVolume(missed.geometry), 8, 1e-6)
    missed.geometry.dispose()
  }
}


/**
 * Triangles turned inside out, on a body of revolution about Y.
 *
 * The one measurement that catches a folded mesh, and folding is what the
 * failures on a cone and a cylinder actually WERE -- not a shading problem or
 * a hole, but patches of surface pushed through themselves into spikes. On a
 * solid of revolution an outward face has a normal with a positive radial
 * component, so a negative one is a fold and needs no reference mesh to spot.
 *
 * At module scope because BOTH brushes are measured with it and a second copy
 * written for the second tool is a second thing to get subtly wrong. The two
 * fold in different places -- the torch on a ruled flank, the sculpt tool on a
 * convex tip -- which is exactly why one detector has to answer for both.
 */
const folded = (geom: BufferGeometry): number => {
  const pos = geom.getAttribute('position')
  const index = geom.getIndex()
  const corners = index ? index.count : pos.count
  const at = (c: number) => {
    const i = index ? index.getX(c) : c
    return new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
  }
  let count = 0
  for (let t = 0; t < corners / 3; t++) {
    const a = at(t * 3)
    const b = at(t * 3 + 1)
    const c = at(t * 3 + 2)
    const normal = b.clone().sub(a).cross(c.clone().sub(a))
    const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3)
    const radial = new Vector3(mid.x, 0, mid.z)
    // CLEARLY inward, not merely negative. A flat cap's normal runs down the
    // axis and is exactly perpendicular to the radius, so its dot product is
    // zero and its SIGN is rounding noise -- every triangle on the underside
    // of a cone would otherwise report itself folded half the time.
    const scale = normal.length() * radial.length()
    if (scale > 1e-9 && normal.dot(radial) / scale < -0.1) count++
  }
  return count
}

// --- The torch --------------------------------------------------------------
console.log('\nThe erode brush melts the surface rather than biting it')
{
  resetEvaluator()
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  /** A dab on the middle of the +Y face, which stands at y = 1. */
  const onTop = (over: Partial<ErodeDab> = {}): ErodeDab => ({
    at: [0, 1, 0],
    radius: 0.5,
    heat: 1,
    smooth: 0.7,
    ...over,
  })
  const torched = (dabs: ErodeDab[], id = 'torch') =>
    evaluateObject({ ...object(cube, [], [], id), erosion: dabs })

  // AN OBJECT NOBODY HAS TOUCHED PAYS NOTHING. The stage is skipped on an
  // identity test, so a scene without the tool is the scene it was before the
  // tool existed -- not a re-welded, re-emitted copy of it.
  {
    const plain = evaluateObject(object(cube, [], [], 'plain'))
    const empty = evaluateObject({ ...object(cube, [], [], 'plain2'), erosion: [] })
    check(
      'no dabs leaves the geometry exactly as the booleans built it',
      triangleCount(plain.geometry) === triangleCount(empty.geometry),
      `${triangleCount(plain.geometry)} vs ${triangleCount(empty.geometry)}`
    )
    near('and the same volume', signedVolume(empty.geometry), 8, 1e-9)
  }

  // ONE DAB TAKES MATERIAL AWAY, and takes it from where it was pointed.
  {
    const melted = torched([onTop()])
    check('a dab does not produce a NaN', !hasNaN(melted.geometry), '')
    const volume = signedVolume(melted.geometry)
    check('one dab removes material', volume < 8, `${volume.toFixed(5)} from 8`)
    check('and not very much of it', volume > 7.9, `${volume.toFixed(5)}`)

    // The dish. Read down the middle of the face the brush was held against.
    const pos = melted.geometry.getAttribute('position')
    let lowest = Infinity
    let farthest = -Infinity
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      if (Math.abs(x) < 0.05 && Math.abs(z) < 0.05) lowest = Math.min(lowest, y)
      // The FAR face, which the brush never came near.
      if (y < -0.9) farthest = Math.max(farthest, y)
    }
    check('the surface sinks under the brush', lowest < 1, `y ${lowest.toFixed(4)} from 1`)
    // Everything the brush did not reach is untouched to the LAST BIT, not
    // merely to a tolerance. That is the whole bargain of moving vertices
    // instead of re-meshing: a torched cube is still exactly a cube everywhere
    // the flame was not.
    check(
      'and the far face is bit-for-bit where it was',
      farthest === -1,
      `${farthest}`
    )
  }

  // A DISH, NOT A BITE. A sphere subtraction would leave the rim a hard circle
  // at exactly the brush radius; melting tapers to nothing, so the surface
  // between the middle of the dab and its rim is a curve. Sampled as three
  // depths at three radii: each nearer ring must be strictly deeper.
  {
    const melted = torched([onTop({ radius: 0.6 })], 'dish')
    const pos = melted.geometry.getAttribute('position')
    // Bands wide enough that WHERE the refinement happens to put its vertices
    // cannot empty one. A narrow ring is a check that passes or fails on the
    // tessellation rather than on the shape, and it duly broke the first time
    // the refinement pattern moved.
    const deepestWithin = (lo: number, hi: number) => {
      let y = Infinity
      let found = 0
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getZ(i))
        if (r >= lo && r < hi) {
          y = Math.min(y, pos.getY(i))
          found++
        }
      }
      return { y, found }
    }
    const middle = deepestWithin(0, 0.18)
    const halfway = deepestWithin(0.2, 0.42)
    const rim = deepestWithin(0.5, 0.66)
    check(
      'the dish is sampled at three radii',
      middle.found > 0 && halfway.found > 0 && rim.found > 0,
      `${middle.found} / ${halfway.found} / ${rim.found} vertices`
    )
    check(
      'the dish is deepest in the middle',
      middle.y < halfway.y && halfway.y < rim.y,
      `${middle.y.toFixed(4)} < ${halfway.y.toFixed(4)} < ${rim.y.toFixed(4)}`
    )
    // PAST the rim, not near it: the falloff lands tangent, so the surface just
    // outside the brush is not merely almost unmoved but bit-for-bit the face
    // the evaluator built. Stated as equality, which is the actual promise --
    // "almost" would pass on a brush that had quietly dished the whole panel.
    const outside = deepestWithin(0.63, 0.95)
    check(
      'and past the rim the face is untouched to the last bit',
      outside.found > 0 && outside.y === 1,
      `${outside.found} vertices, deepest ${outside.y}`
    )
  }

  // GOING OVER IT AGAIN SINKS IT FURTHER, which is the whole of how depth is
  // controlled: one pass is a fixed bite and the user repeats it. A brush that
  // reached equilibrium after a few dabs would leave no way to dig at all.
  {
    const depth = (n: number) => {
      const dabs: ErodeDab[] = []
      for (let i = 0; i < n; i++) dabs.push(onTop())
      const pos = torched(dabs, `dig${n}`).geometry.getAttribute('position')
      let lowest = Infinity
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getX(i)) < 0.05 && Math.abs(pos.getZ(i)) < 0.05) {
          lowest = Math.min(lowest, pos.getY(i))
        }
      }
      return 1 - lowest
    }
    const one = depth(1)
    const five = depth(5)
    const twenty = depth(20)
    check(
      'a second pass goes deeper than the first',
      five > one * 1.5,
      `${one.toFixed(4)} -> ${five.toFixed(4)}`
    )
    check(
      'and a twentieth deeper still',
      twenty > five,
      `${five.toFixed(4)} -> ${twenty.toFixed(4)}`
    )
    // But it does converge, which is what keeps a stroke from turning the
    // surface inside out when someone leans on it.
    check(
      'while staying inside the solid',
      twenty < 2,
      `${twenty.toFixed(4)} deep in a 2-unit cube`
    )
  }

  // HEAT and SMOOTHING are two different knobs, and each has to do its own
  // thing. Heat is how far it sinks; smoothing is how much it flows -- so a
  // dab with no heat at all still rounds a corner over.
  {
    const cold = signedVolume(torched([onTop({ heat: 0 })], 'cold').geometry)
    const warm = signedVolume(torched([onTop({ heat: 0.5 })], 'warm').geometry)
    const hot = signedVolume(torched([onTop({ heat: 1 })], 'hot').geometry)
    check('more heat takes more material', hot < warm && warm < cold, `${hot.toFixed(5)} < ${warm.toFixed(5)} < ${cold.toFixed(5)}`)

    // Held against a CORNER with the heat off: nothing is being burned away, so
    // any material lost is the corner flowing off itself. That is the melt,
    // isolated from the erosion.
    const corner = (smooth: number) =>
      signedVolume(
        evaluateObject({
          ...object(cube, [], [], `corner${smooth}`),
          erosion: [{ at: [1, 1, 1], radius: 0.8, heat: 0, smooth }],
        }).geometry
      )
    const sharp = corner(0)
    const molten = corner(1)
    check(
      'smoothing rounds a corner off with no heat at all',
      molten < sharp,
      `${molten.toFixed(5)} vs ${sharp.toFixed(5)} unsmoothed`
    )
  }

  // THE SAME DOCUMENT MUST PRODUCE THE SAME MESH. Erosion is replayed from the
  // dabs on every evaluation, so anything order-dependent inside it would make
  // an object change shape when an unrelated edit forced a rebuild.
  {
    const dabs = [onTop({ at: [-0.3, 1, 0] }), onTop({ at: [0.3, 1, 0] }), onTop()]
    const a = torched(dabs, 'det-a').geometry.getAttribute('position').array
    const b = torched(dabs, 'det-b').geometry.getAttribute('position').array
    let same = a.length === b.length
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false
    check('replaying the same dabs gives the same mesh', same, `${a.length} floats`)
  }

  // ORDER MATTERS, because the dabs are a stroke rather than a set: the second
  // one melts the surface the first one left. Stated so the day someone sorts
  // or dedupes the list, this fails.
  {
    const forward = signedVolume(
      torched([onTop({ at: [-0.2, 1, 0], heat: 1 }), onTop({ at: [0.2, 1, 0], heat: 0.2 })], 'fwd')
        .geometry
    )
    const backward = signedVolume(
      torched([onTop({ at: [0.2, 1, 0], heat: 0.2 }), onTop({ at: [-0.2, 1, 0], heat: 1 })], 'bwd')
        .geometry
    )
    check('the dabs are a stroke, not a set', forward !== backward, `${forward.toFixed(7)} vs ${backward.toFixed(7)}`)
  }

  // THE TORCH RUNS LAST, after the cuts and the erasers. A melt is a fact about
  // the finished surface: run it earlier and a cut would slice through a face
  // that had already flowed, which is a different solid.
  {
    const half: CutPlane = { id: 'c1', origin: [0, 0, 0], normal: [0, 1, 0], side: -1 }
    const cut = evaluateObject({
      ...object(cube, [], [half], 'order'),
      // On the cut face, which only exists AFTER the cut has run. If erosion
      // came first there would be nothing here to melt.
      erosion: [{ at: [0, 0, 0], radius: 0.5, heat: 1, smooth: 0.7 }],
    })
    const volume = signedVolume(cut.geometry)
    check(
      'the torch melts the face a cut just made',
      volume < 4 && volume > 3.8,
      `${volume.toFixed(5)} from a 4-unit half`
    )
  }

  // A MERGED ASSEMBLY KEEPS ITS COLOURS. The mesh is grouped by the solid each
  // triangle came from, and a tool that dropped the groups would repaint a
  // two-colour merge in one colour the first time it was touched.
  {
    const host = object(cube, [], [], 'host')
    const part: SceneObject = {
      ...object({ kind: 'sphere', radius: 0.7 }, [], [], 'part'),
      transform: { position: [1, 0, 0], rotation: [0, 0, 0] },
    }
    const merged = evaluateObject({
      ...host,
      parts: [part],
      erosion: [{ at: [0, 1, 0], radius: 0.5, heat: 1, smooth: 0.7 }],
    })
    check(
      'a torched merge still wears both paints',
      merged.paints.length === 2,
      merged.paints.join(',')
    )
    check(
      'and its mesh still carries a group per paint',
      merged.geometry.groups.length >= 2,
      `${merged.geometry.groups.length} groups`
    )
  }

  // The stroke is stored, not baked: the object is still a parametric solid, so
  // resizing the base after torching it rebuilds and re-melts rather than
  // dragging a frozen mesh about.
  {
    const small = evaluateObject({
      ...object({ kind: 'box', size: [2, 2, 2] }, [], [], 'resize'),
      erosion: [onTop()],
    })
    const grown = evaluateObject({
      ...object({ kind: 'box', size: [4, 2, 2] }, [], [], 'resize2'),
      erosion: [onTop()],
    })
    check(
      'the base can still be resized under a stroke',
      signedVolume(grown.geometry) > signedVolume(small.geometry) * 1.9,
      `${signedVolume(small.geometry).toFixed(4)} -> ${signedVolume(grown.geometry).toFixed(4)}`
    )
  }
}


// --- The sculpt tool --------------------------------------------------------
console.log('\nThe sculpt brush is the torch with one sign flipped')
{
  resetEvaluator()
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const onTop = (over: Partial<ErodeDab> = {}): ErodeDab => ({
    at: [0, 1, 0],
    radius: 0.5,
    heat: 1,
    smooth: 0.7,
    ...over,
  })
  const brushed = (dabs: ErodeDab[], id: string) =>
    evaluateObject({ ...object(cube, [], [], id), erosion: dabs })
  const many = (n: number, d: ErodeDab): ErodeDab[] =>
    Array.from({ length: n }, () => ({ ...d }))
  /** How far the middle of the +Y face has moved, signed: up is positive. */
  const middle = (geom: BufferGeometry): number => {
    const pos = geom.getAttribute('position')
    let lowest = Infinity
    let highest = -Infinity
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) > 0.05 || Math.abs(pos.getZ(i)) > 0.05) continue
      if (pos.getY(i) < 0) continue
      lowest = Math.min(lowest, pos.getY(i))
      highest = Math.max(highest, pos.getY(i))
    }
    return highest - 1 > 1 - lowest ? highest - 1 : lowest - 1
  }

  // ONE DAB ADDS MATERIAL, and adds it where it was pointed -- the exact
  // opposite of the check the torch answers a hundred lines above.
  {
    const raised = brushed([onTop({ raise: true })], 'raise-one')
    check('a raised dab does not produce a NaN', !hasNaN(raised.geometry), '')
    const volume = signedVolume(raised.geometry)
    check('one dab adds material', volume > 8, `${volume.toFixed(5)} from 8`)
    check('and not very much of it', volume < 8.1, `${volume.toFixed(5)}`)
    check('the surface rises under the brush', middle(raised.geometry) > 0, `${middle(raised.geometry).toFixed(4)}`)

    // Everything the brush did not reach is untouched to the LAST BIT, which is
    // the same bargain the torch strikes and the reason either tool can be run
    // over a finished model at all.
    const pos = raised.geometry.getAttribute('position')
    let farthest = -Infinity
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < -0.9) farthest = Math.max(farthest, pos.getY(i))
    }
    check('and the far face is bit-for-bit where it was', farthest === -1, `${farthest}`)
  }

  // THE TWO ARE MIRROR IMAGES, and this is the check that says so in one line.
  // A bead raised at some setting stands as far proud of the surface as the
  // dish sunk at the same setting lies below it. That is not decoration: it is
  // what makes the sculpt tool learnable from the torch, and it is the thing
  // that breaks the moment the flow asymmetry stops being measured against the
  // dab's own direction. Hard-coding the torch's `into > 0` -- the obvious way
  // to write it -- flattens a bead as fast as it is drawn, and this comes back
  // 0.17 against 0.35 at full smoothing. See RELAX_FILL.
  for (const smooth of [0.15, 0.5, 1]) {
    const tag = `${smooth}`
    const dish = middle(brushed(many(20, onTop({ smooth })), `mirror-dish-${tag}`).geometry)
    const bead = middle(brushed(many(20, onTop({ smooth, raise: true })), `mirror-bead-${tag}`).geometry)
    check(`at smoothing ${tag} the torch sinks`, dish < 0, `${dish.toFixed(4)}`)
    near(`and the sculpt tool raises exactly as far`, bead, -dish, 1e-4)
  }

  // GOING OVER IT AGAIN BUILDS IT UP, the mirror of the torch's dig: the flow
  // that would flatten a bead is held back the way the flow that would fill a
  // dish is, so a stroke held in one place keeps working rather than reaching
  // equilibrium and stopping.
  {
    let last = 0
    for (const n of [1, 5, 20]) {
      const height = middle(brushed(many(n, onTop({ raise: true })), `build${n}`).geometry)
      check(`${n} dab(s) stand higher than ${n - 1}`, height > last, `${height.toFixed(4)}`)
      last = height
    }
  }

  // ORDER MATTERS ACROSS THE TWO BRUSHES, which is the whole reason they share
  // one list rather than having one each. A groove cut across a bead is not the
  // surface a bead drawn across a groove is, and nothing but the order says so.
  {
    const carve = onTop({ heat: 1 })
    const raise = onTop({ heat: 1, raise: true })
    const first = signedVolume(brushed([...many(6, carve), ...many(6, raise)], 'carve-then-raise').geometry)
    const second = signedVolume(brushed([...many(6, raise), ...many(6, carve)], 'raise-then-carve').geometry)
    check(
      'carving over a bead is not drawing a bead over a groove',
      Math.abs(first - second) > 1e-4,
      `${first.toFixed(6)} vs ${second.toFixed(6)}`
    )
  }

  // IT ADDS MATERIAL ON AN ORDINARY CURVED SURFACE, which is the claim the
  // apex block below deliberately does NOT make -- so it is made here first,
  // and at every smoothing, or the exception would read as the rule.
  {
    const cone: BaseSolid = { kind: 'cone', radius: 1, height: 2 }
    const bare = signedVolume(evaluateObject(object(cone, [], [], 'flank-bare')).geometry)
    for (const smooth of [0.15, 0.7, 1]) {
      const flank = evaluateObject({
        ...object(cone, [], [], `flank-${smooth}`),
        erosion: many(20, { at: [0.5, 0, 0], radius: 0.3, heat: 1, smooth, raise: true }),
      })
      check(
        `a bead on the cone's flank adds material at smoothing ${smooth}`,
        signedVolume(flank.geometry) > bare + 0.01,
        `${signedVolume(flank.geometry).toFixed(4)} from ${bare.toFixed(4)}`
      )
      flank.geometry.dispose()
    }
  }

  // A SHARP CONVEX POINT IS THE HARD CASE, and it is the mirror of the one the
  // torch's flow floor exists for. Raising a cone's tip drives the ring around
  // it outward faster than the tip climbs, and the fan between them stretches
  // into slivers that turn inside out -- the raised twin of the needle the
  // torch used to grow. What holds it is the edge-length limit working in BOTH
  // directions: nothing may lengthen faster than the flow can pull it back
  // either. Take the opening half away and this block reports sixteen folded
  // triangles at twelve dabs and twenty-six at forty. See DAB_CLOSE.
  //
  // WHAT IS NOT CLAIMED HERE is that the tip gets TALLER, and the reason is
  // worth writing down because the check that asserted it looked obviously
  // right and was not. NEITHER BRUSH SHARPENS. Flow rounds a sharp feature off
  // faster than the bite can push it either way, so the sculpt tool blunts a
  // cone's tip while it packs material around it -- and, measured, the shipped
  // torch aimed into the sharp point of a cone-shaped cavity FILLS IT IN rather
  // than deepening it, by +0.008 of volume at mid smoothing. That is one
  // property of the brush seen from two sides, not a fault in the newer tool,
  // and holding the sculpt tool to a bar the torch has never met would be
  // encoding a wish rather than a promise.
  //
  // What IS claimed is the part that does survive at a point: the brush that
  // adds material leaves more of the tip standing than the brush that takes it
  // away, at the same settings.
  {
    const cone: BaseSolid = { kind: 'cone', radius: 1, height: 2 }
    // The tip of a `cone` of height 2 stands at y = 1.
    const apex = (over: Partial<ErodeDab> = {}): ErodeDab => ({
      at: [0, 1, 0],
      radius: 0.5,
      heat: 1,
      smooth: 0.7,
      ...over,
    })
    /** The highest point near the axis: the tip, or a spur standing above it. */
    const tip = (geom: BufferGeometry): number => {
      const pos = geom.getAttribute('position')
      let highest = -Infinity
      for (let i = 0; i < pos.count; i++) {
        if (Math.hypot(pos.getX(i), pos.getZ(i)) > 0.3) continue
        highest = Math.max(highest, pos.getY(i))
      }
      return highest
    }
    for (const n of [12, 40]) {
      const point = evaluateObject({
        ...object(cone, [], [], `apex-raise-${n}`),
        erosion: many(n, apex({ raise: true })),
      })
      const burnt = evaluateObject({
        ...object(cone, [], [], `apex-torch-${n}`),
        erosion: many(n, apex()),
      })
      // Said first, so the fold count below cannot pass by the brush having
      // done nothing at all: a check that a mesh nobody touched is unfolded is
      // a check that can never fail.
      check(
        `${n} dabs on a cone's tip actually work it`,
        tip(point.geometry) < 0.95,
        `tip at ${tip(point.geometry).toFixed(4)} from 1`
      )
      check(
        `and the sculpt tool leaves more of the tip than the torch does`,
        tip(point.geometry) > tip(burnt.geometry) + 0.1,
        `${tip(point.geometry).toFixed(4)} against ${tip(burnt.geometry).toFixed(4)}`
      )
      check(
        `raising a cone's tip ${n} times folds nothing`,
        folded(point.geometry) === 0,
        `${folded(point.geometry)} folded triangles`
      )
      check('and leaves no NaN behind it', !hasNaN(point.geometry), '')
      point.geometry.dispose()
      burnt.geometry.dispose()
    }
  }
}

// --- The torch on curved and merged solids ----------------------------------
console.log('\nThe erode brush survives curved surfaces and merged assemblies')
{
  resetEvaluator()


  /**
   * The shortest edge anywhere in the mesh, ignoring the ones that were already
   * zero.
   *
   * `CapsuleGeometry` arrives with forty-eight degenerate triangles at its
   * poles -- an edge of 3e-18 -- and that is three.js's business, not the
   * torch's. What is being asserted is that erosion does not CLOSE a mesh up,
   * so the measurement has to start from the mesh as it was handed over.
   */
  const shortestEdge = (geom: BufferGeometry): number => {
    const pos = geom.getAttribute('position')
    const index = geom.getIndex()
    const corners = index ? index.count : pos.count
    const at = (c: number) => {
      const i = index ? index.getX(c) : c
      return new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
    }
    let shortest = Infinity
    for (let t = 0; t < corners / 3; t++) {
      const v = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)]
      for (let e = 0; e < 3; e++) {
        const length = v[e].distanceTo(v[(e + 1) % 3])
        if (length > 0) shortest = Math.min(shortest, length)
      }
    }
    return shortest
  }

  const stroke = (at: Vec3, radius: number, smooth: number, n: number): ErodeDab[] =>
    Array.from({ length: n }, () => ({ at, radius, heat: 0.8, smooth }))

  // A RULED SURFACE IS THE HARD CASE, and it is the one that broke. A cone's
  // flank and a cylinder's side arrive as triangles many times taller than they
  // are wide -- one segment up the axis, dozens around it -- and on a mesh that
  // lopsided the two bugs below both showed as spikes rather than dents.
  const curved: [string, BaseSolid, Vec3, number][] = [
    ["the cone's flank", { kind: 'cone', radius: 0.5, height: 1 }, [0.3, -0.1, 0], 0.28],
    ["the cylinder's side", { kind: 'cylinder', radius: 0.4, height: 0.9 }, [0.4, 0, 0], 0.25],
    ["the bean's straight middle", { kind: 'capsule', radius: 0.4, height: 0.7 }, [0.4, 0, 0], 0.25],
  ]

  for (const [label, base, at, radius] of curved) {
    const subject = object(base, [], [], `curve-${label.length}-${radius}`)
    // Both ends of the Smoothing range. Zero is asked for deliberately: the
    // control no longer offers it, but a dab can arrive from an older document
    // or a headless caller carrying anything at all, and the geometry is where
    // that has to be survivable -- see BRUSH_SMOOTH_MIN.
    for (const smooth of [0, 0.7]) {
      const melted = evaluateObject({ ...subject, erosion: stroke(at, radius, smooth, 8) })
      check(
        `${label} at smoothing ${smooth}: nothing is turned inside out`,
        folded(melted.geometry) === 0,
        `${folded(melted.geometry)} folded`
      )
      // A sink along the normals of a CONVEX surface converges the vertices on
      // it, the way offsetting a circle inward shortens its circumference. Left
      // to itself that closes the triangles up until they invert, so the mesh
      // not collapsing is the thing being asserted here, not merely the absence
      // of folds this time. Measured against the solid AS HANDED OVER, since
      // some primitives arrive with degenerate triangles of their own.
      const plain = evaluateObject(subject)
      const floor = shortestEdge(plain.geometry) / 50
      check(
        `${label} at smoothing ${smooth}: the mesh does not collapse under it`,
        shortestEdge(melted.geometry) > floor,
        `shortest edge ${shortestEdge(melted.geometry).toExponential(1)}, floor ${floor.toExponential(1)}`
      )
      plain.geometry.dispose()
      melted.geometry.dispose()
    }
  }

  // A POINT MELTS DOWN. Near a cone's apex the solid is thinner than any brush
  // -- it converges to nothing -- so the ring around the tip is pulled inward
  // faster than the tip descends. With too little flow to spread it again that
  // ring collapses onto the axis and crosses to the far side; the fan turns
  // inside out, the normal derived from it points inward, and sinking then
  // drives the tip back OUT. Twelve dabs used to leave a needle standing ABOVE
  // where the cone started, on a surface that had melted away beneath it.
  //
  // Stated as the thing a user would see rather than as a triangle count, and
  // asked at Smoothing ZERO, which is below what the control now offers and
  // therefore the case the geometry itself has to hold.
  {
    const tip = object({ kind: 'cone', radius: 0.5, height: 1 }, [], [], 'apex')
    const melted = evaluateObject({
      ...tip,
      erosion: stroke([0, 0.5, 0], 0.12, 0, 12),
    })
    const pos = melted.geometry.getAttribute('position')
    let summit = -Infinity
    let around = -Infinity
    for (let i = 0; i < pos.count; i++) {
      summit = Math.max(summit, pos.getY(i))
      const r = Math.hypot(pos.getX(i), pos.getZ(i))
      if (r > 0.04 && r < 0.09) around = Math.max(around, pos.getY(i))
    }
    check(
      'torching a point brings it down rather than up',
      summit < 0.5,
      `summit ${summit.toFixed(4)} from 0.5`
    )
    check(
      'and leaves it level with the surface around it',
      summit - around < 0.02,
      `summit ${summit.toFixed(4)}, surface ${around.toFixed(4)}`
    )
    check(
      'with no spike left standing in it',
      folded(melted.geometry) === 0,
      `${folded(melted.geometry)} folded`
    )
    melted.geometry.dispose()
  }

  // A BRIDGE BETWEEN TWO PITS, which is the shape that broke.
  //
  // Melt two dishes a brush-width apart and the tool leaves a ridge standing
  // between them; melt THAT and the ridge is squeezed from both sides at once,
  // because sinking runs along each vertex's own normal and the two flanks of a
  // ridge point away from each other. Faster than the flow could slide them
  // apart, the mesh bunched at the brush's own rim, stood the bunching up into
  // a cliff, and finally pushed one wall through the other -- a visible tear in
  // a surface the user was in the middle of smoothing.
  //
  // THE STROKE HAS TO FOLLOW THE SURFACE DOWN or none of it happens. A dab
  // stacked at a fixed point converges after a dozen presses and the artifact
  // never appears; it is the brush descending with the floor it is cutting,
  // exactly as `dragErode` lays dabs on the ray hit, that walks the sphere's
  // rim down the wall and stands the cliff up. So this replays the real
  // gesture: evaluate, find where the surface is now, put the next dab there.
  {
    /** Every crossing of the vertical line through (x, z), top first. */
    const column = (geom: BufferGeometry, x: number, z: number): number[] => {
      const pos = geom.getAttribute('position')
      const index = geom.getIndex()
      const corners = index ? index.count : pos.count
      const at = (c: number, out: Vector3) => {
        const i = index ? index.getX(c) : c
        return out.set(pos.getX(i), pos.getY(i), pos.getZ(i))
      }
      const a = new Vector3()
      const b = new Vector3()
      const c = new Vector3()
      const ys: number[] = []
      for (let t = 0; t < corners / 3; t++) {
        at(t * 3, a)
        at(t * 3 + 1, b)
        at(t * 3 + 2, c)
        // Barycentric, in the XZ shadow of the triangle.
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z)
        if (Math.abs(d) < 1e-14) continue
        const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d
        const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d
        const w = 1 - u - v
        if (u < 0 || v < 0 || w < 0) continue
        ys.push(u * a.y + v * b.y + w * c.y)
      }
      return ys.sort((p, q) => q - p)
    }

    /** Triangles on the melted side that face DOWNWARD: the surface has curled
     *  back over itself, which is the lip a tear grows out of. */
    const overhanging = (geom: BufferGeometry): number => {
      const pos = geom.getAttribute('position')
      let count = 0
      for (let t = 0; t < pos.count / 3; t++) {
        const a = new Vector3().fromBufferAttribute(pos, t * 3)
        const b = new Vector3().fromBufferAttribute(pos, t * 3 + 1)
        const c = new Vector3().fromBufferAttribute(pos, t * 3 + 2)
        // The top half only: the cube's own underside faces down by rights.
        if ((a.y + b.y + c.y) / 3 < 0) continue
        const normal = b.clone().sub(a).cross(c.clone().sub(a))
        if (normal.length() < 1e-14) continue
        if (normal.normalize().y < -0.05) count++
      }
      return count
    }

    const radius = 0.3
    const cube2: BaseSolid = { kind: 'box', size: [2, 2, 2] }
    let generation = 0
    const melt = (dabs: ErodeDab[]) => {
      resetEvaluator()
      return evaluateObject({
        ...object(cube2, [], [], `bridge${generation++}`),
        erosion: dabs,
      })
    }

    const dabs: ErodeDab[] = []
    /** One press, landing where the surface stands right now. */
    const press = (x: number) => {
      const surface = column(melt(dabs).geometry, x, 0)
      if (surface.length === 0) return
      dabs.push({ at: [x, surface[0], 0], radius, heat: 1, smooth: 0.4 })
    }
    for (const x of [-0.35, 0.35]) for (let i = 0; i < 14; i++) press(x)
    for (let i = 0; i < 32; i++) press(0)

    const melted = melt(dabs).geometry
    check(
      'melting the bridge between two pits leaves no overhang',
      overhanging(melted) === 0,
      `${overhanging(melted)} triangles face down`
    )
    // The stronger statement, and the one a user would recognise: the melted
    // face is still a SURFACE. Dropped anywhere over the trough, a line goes in
    // once and comes out once. Three crossings is a flap of mesh hanging in the
    // air over the dish, which is what the tear looked like.
    let worst = 2
    let worstAt = ''
    for (let i = -10; i <= 10; i++) {
      for (let j = -6; j <= 6; j++) {
        // Off the symmetry planes, where a line grazes shared edges and every
        // triangle along it reports a crossing of its own.
        const x = (i / 10) * 0.7 + 0.00137
        const z = (j / 6) * 0.24 + 0.00091
        const hits = column(melted, x, z).length
        if (hits > worst) {
          worst = hits
          worstAt = `${x.toFixed(2)}, ${z.toFixed(2)}`
        }
      }
    }
    check(
      'and the melted face is still a surface, not a fold',
      worst === 2,
      worst === 2 ? 'two crossings everywhere' : `${worst} crossings at ${worstAt}`
    )
    // And it did the job it was asked to do, rather than passing by refusing to
    // melt anything: the ridge has to be gone.
    const trough = column(melted, 0.00137, 0.00091)[0]
    const pit = column(melted, -0.35, 0.00091)[0]
    check(
      'while actually taking the bridge down to the pits',
      trough < pit + 0.1,
      `trough at ${trough.toFixed(3)}, pit floor at ${pit.toFixed(3)}`
    )
    melted.dispose()
  }

  // A MERGED ASSEMBLY'S GROUPS. A group is a pair of offsets into the vertex
  // buffer, and the torch rebuilds them -- so they have to come back in the
  // units the renderer reads them in. They did not: the second group of a
  // two-paint mesh pointed three times too far along the buffer and past the
  // end of it, which drew a cube merged with a sphere as garbage the moment it
  // was torched. One paint hid it, because the first group starts at zero
  // whatever the units.
  {
    const host = object({ kind: 'box', size: [1, 1, 1] }, [], [], 'merge-host')
    const part: SceneObject = {
      ...object({ kind: 'sphere', radius: 0.5 }, [], [], 'merge-part'),
      transform: { position: [0.7, 0, 0], rotation: [0, 0, 0] },
    }
    const merged = evaluateObject({
      ...host,
      parts: [part],
      erosion: stroke([0, 0.5, 0], 0.25, 0.7, 6),
    })
    const vertices = merged.geometry.getAttribute('position').count
    const groups = merged.geometry.groups

    check('a torched merge carries a group per paint', groups.length >= 2, `${groups.length}`)
    check(
      'every group lies inside the buffer it indexes',
      groups.every((g) => g.start >= 0 && g.start + g.count <= vertices),
      groups.map((g) => `${g.start}+${g.count}`).join(' ') + ` of ${vertices}`
    )
    check(
      'and together they cover it exactly once',
      groups.reduce((n, g) => n + g.count, 0) === vertices,
      `${groups.reduce((n, g) => n + g.count, 0)} vs ${vertices}`
    )
    // The runs must also be contiguous and in order, which is what makes them
    // one run per paint rather than a paint scattered through the buffer.
    let cursor = 0
    const contiguous = groups.every((g) => {
      const ok = g.start === cursor
      cursor += g.count
      return ok
    })
    check('as one unbroken run each', contiguous, groups.map((g) => g.start).join(','))
    merged.geometry.dispose()
  }

  // A COMPOSITE SOLID DOES NOT TEAR, which is the one thing a tool that only
  // ever moves vertices has to be able to promise.
  //
  // A boolean cuts the same seam into both solids and triangulates each side by
  // itself, so the two sides agree on where the seam runs and disagree on where
  // to put points along it: one face carries a single long edge, the face
  // against it carries two shorter ones meeting partway along. That draws
  // perfectly -- the stray point sits exactly ON the long edge -- and it stays
  // invisible right up until something moves. Torching a cube with a notch
  // subtracted out of it used to open holes clean through the surface, because
  // the moment the long edge's ends moved, the point they were covering stopped
  // being covered. See `stitch`.
  //
  // Measured as UNSHARED EDGES rather than as a picture: every edge of a closed
  // surface belongs to two triangles, and each edge that belongs to one is a
  // hole you can see through. Asked of the melted mesh, which is the one the
  // renderer gets -- the boolean's own output has plenty of them, and is
  // entitled to, since nothing has moved yet.
  {
    /** Edges used by exactly one triangle, after welding by position. */
    const unshared = (geom: BufferGeometry): number => {
      const pos = geom.getAttribute('position')
      const index = geom.getIndex()
      const corners = index ? index.count : pos.count
      geom.computeBoundingBox()
      const box = geom.boundingBox
      const extent = box
        ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
        : 1
      // Deliberately looser than the torch's own weld: a crack this misses is
      // one no renderer could show either.
      const grid = Math.max(extent, 1e-6) * 1e-5
      const id = new Map<string, number>()
      const vertex: number[] = []
      for (let c = 0; c < corners; c++) {
        const i = index ? index.getX(c) : c
        const key =
          `${Math.round(pos.getX(i) / grid)},` +
          `${Math.round(pos.getY(i) / grid)},` +
          `${Math.round(pos.getZ(i) / grid)}`
        let at = id.get(key)
        if (at === undefined) {
          at = id.size
          id.set(key, at)
        }
        vertex.push(at)
      }
      const uses = new Map<string, number>()
      for (let t = 0; t < corners / 3; t++) {
        for (let e = 0; e < 3; e++) {
          const a = vertex[t * 3 + e]
          const b = vertex[t * 3 + ((e + 1) % 3)]
          if (a === b) continue
          const key = a < b ? `${a}|${b}` : `${b}|${a}`
          uses.set(key, (uses.get(key) ?? 0) + 1)
        }
      }
      let open = 0
      for (const n of uses.values()) if (n === 1) open++
      return open
    }

    const notch: SceneObject = {
      ...object({ kind: 'box', size: [1, 1, 1] }, [], [], 'notch'),
      erased: [
        {
          ...object({ kind: 'box', size: [0.6, 0.6, 0.6] }, [], [], 'bite'),
          transform: { position: [0.35, 0.35, 0.35], rotation: [0, 0, 0] },
        },
      ],
    }

    const plain = evaluateObject(notch)
    check(
      'the notch itself leaves the seam unsewn, as booleans do',
      unshared(plain.geometry) > 0,
      `${unshared(plain.geometry)} unshared edges out of the boolean`
    )

    // Held against the top face, right over the seam the notch cut into it.
    const torched = evaluateObject({
      ...notch,
      id: 'notch-torched',
      erosion: stroke([0.05, 0.5, 0.05], 0.2, 0.7, 8),
    })
    check(
      'but melting a subtracted solid opens no holes in it',
      unshared(torched.geometry) === 0,
      `${unshared(torched.geometry)} unshared edges after the torch`
    )
    // And it passes by melting, not by declining to.
    check(
      'while still taking material off it',
      signedVolume(torched.geometry) < signedVolume(plain.geometry) - 1e-4,
      `${signedVolume(torched.geometry).toFixed(5)} from ${signedVolume(plain.geometry).toFixed(5)}`
    )

    // The other half of the report: a MERGED assembly, whose seam is a curve
    // rather than a straight edge.
    const welded: SceneObject = {
      ...object({ kind: 'box', size: [1, 1, 1] }, [], [], 'weldhost'),
      parts: [
        {
          ...object({ kind: 'sphere', radius: 0.35 }, [], [], 'weldball'),
          transform: { position: [0.5, 0, 0], rotation: [0, 0, 0] },
        },
      ],
    }
    const meltedMerge = evaluateObject({
      ...welded,
      id: 'weld-torched',
      erosion: stroke([0, 0.5, 0], 0.2, 0.7, 8),
    })
    // Not zero, and stated as a RATIO for that reason: a union of a tessellated
    // sphere with a flat face leaves a handful of places where the two
    // triangulations of the seam curve cannot be reconciled by splitting an
    // edge, and `stitch` leaves those alone rather than inventing geometry to
    // cover them. What has to be true is that the seam is essentially sewn --
    // hundreds of unshared edges down to single figures -- not that a boolean
    // this file does not control came out perfect.
    const before = unshared(evaluateObject(welded).geometry)
    const after = unshared(meltedMerge.geometry)
    check(
      'and melting a merged assembly sews up the seam it came with',
      before > 20 && after * 10 < before,
      `${after} unshared after the torch, from ${before} out of the boolean`
    )

    plain.geometry.dispose()
    torched.geometry.dispose()
    meltedMerge.geometry.dispose()
  }
}
// --- The torch through a thin wall ------------------------------------------
console.log('\nThe erode brush burns through a thin wall rather than pinching it')
{
  resetEvaluator()

  /**
   * Every crossing of the line along Z through (x, y): where it met the
   * surface, and whether that meeting was an entry or an exit.
   *
   * The panels below are thin in Z, so this reads straight through the wall the
   * torch is pointed at. Two facts come out of it, and both are needed: how
   * much material is left on that line, and whether the surface is still a
   * surface.
   */
  const throughZ = (geom: BufferGeometry, x: number, y: number): [number, number][] => {
    const pos = geom.getAttribute('position')
    const met: [number, number][] = []
    const a = new Vector3()
    const b = new Vector3()
    const c = new Vector3()
    for (let t = 0; t < pos.count / 3; t++) {
      a.fromBufferAttribute(pos, t * 3)
      b.fromBufferAttribute(pos, t * 3 + 1)
      c.fromBufferAttribute(pos, t * 3 + 2)
      // Barycentric, in the XY shadow of the triangle.
      const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
      if (Math.abs(d) < 1e-14) continue
      const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d
      const v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d
      const w = 1 - u - v
      if (u < 0 || v < 0 || w < 0) continue
      const normal = b.clone().sub(a).cross(c.clone().sub(a))
      met.push([u * a.z + v * b.z + w * c.z, Math.sign(normal.z)])
    }
    return met.sort((p, q) => p[0] - q[0])
  }

  /** Nothing left on the line: the torch went all the way through. */
  const holed = (geom: BufferGeometry, x: number, y: number): boolean =>
    throughZ(geom, x, y).length === 0

  /**
   * THE TEST THAT ANSWERS THE BUG THIS WAS WRITTEN FOR.
   *
   * A closed surface that does not pass through itself is entered and left in
   * strict alternation, entry first. A face pushed through its own far side --
   * which is what a thin panel used to do under the torch, the near face
   * bulging out of the back of it inside out -- gives two entries in a row, and
   * it does so no matter how the tear happens to be tessellated.
   */
  const sound = (geom: BufferGeometry, x: number, y: number): boolean => {
    // A line that grazes the rim of a hole passes through the edge two
    // triangles share, and both of them report the meeting -- at the same
    // point, one in and one out, in whichever order the sort happened to leave
    // them. That is a touch, not a crossing, and a pair of them at the same
    // depth is dropped rather than counted. Only the SIGNS carry the fold: two
    // entries in a row survive this untouched, however close together they are.
    const met: [number, number][] = []
    for (const cross of throughZ(geom, x, y)) {
      const last = met[met.length - 1]
      if (last && Math.abs(last[0] - cross[0]) < 1e-7 && last[1] !== cross[1]) met.pop()
      else met.push(cross)
    }
    for (let i = 0; i < met.length; i++) {
      if (met[i][1] !== (i % 2 === 0 ? -1 : 1)) return false
    }
    return met.length % 2 === 0
  }

  /** Samples over the panel where the surface is not a surface. Skewed off the
   *  round numbers, where a line grazes shared edges and every triangle along
   *  it reports a crossing of its own. */
  const pinches = (geom: BufferGeometry): number => {
    let count = 0
    for (let i = -7; i <= 7; i++) {
      for (let j = -7; j <= 7; j++) {
        if (!sound(geom, i * 0.13 + 0.00713, j * 0.13 + 0.00311)) count++
      }
    }
    return count
  }

  /** Half-edges with nobody on the other side. Zero on a closed mesh -- and
   *  exact position keys are enough, because everything the torch emits comes
   *  out of one welded vertex table. */
  const unsewn = (geom: BufferGeometry): number => {
    const pos = geom.getAttribute('position')
    const id = new Map<string, number>()
    const vertex: number[] = []
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i)}|${pos.getY(i)}|${pos.getZ(i)}`
      let at = id.get(key)
      if (at === undefined) {
        at = id.size
        id.set(key, at)
      }
      vertex.push(at)
    }
    const uses = new Map<number, number>()
    for (let t = 0; t < pos.count / 3; t++) {
      for (let e = 0; e < 3; e++) {
        const a = vertex[t * 3 + e]
        const b = vertex[t * 3 + ((e + 1) % 3)]
        if (a === b) continue
        uses.set(a * 1048576 + b, (uses.get(a * 1048576 + b) ?? 0) + 1)
      }
    }
    let open = 0
    for (const [key, n] of uses) {
      const a = Math.floor(key / 1048576)
      const b = key % 1048576
      if ((uses.get(b * 1048576 + a) ?? 0) !== n) open++
    }
    return open
  }

  /** The furthest anything strays out of a slab of this thickness. */
  const poked = (geom: BufferGeometry, thick: number): number => {
    const pos = geom.getAttribute('position')
    let worst = 0
    for (let i = 0; i < pos.count; i++) {
      worst = Math.max(worst, Math.abs(pos.getZ(i)) - thick / 2)
    }
    return worst
  }

  const RADIUS = 0.3
  /** A panel two units square, thin enough that a brush can eat right through
   *  it -- the shape the tool used to turn inside out. */
  const panel = (thick: number): BaseSolid => ({ kind: 'box', size: [2, 2, thick] })
  const press = (thick: number, n: number, over: Partial<ErodeDab> = {}): ErodeDab[] =>
    Array.from({ length: n }, () => ({
      at: [0, 0, thick / 2] as Vec3,
      radius: RADIUS,
      heat: 1,
      smooth: 0.7,
      ...over,
    }))
  const held = (thick: number, dabs: ErodeDab[], id: string) =>
    evaluateObject({ ...object(panel(thick), [], [], id), erosion: dabs })

  // ONE PRESS GOES THROUGH. A twelfth of a unit of wall under a brush that
  // bites more than that in one dab, on both faces at once: there is no wall
  // left, so there is a hole.
  {
    const thin = held(0.08, press(0.08, 1), 'burn-one')
    check('a press on a thin panel opens a hole', holed(thin.geometry, 0.00713, 0.00311), '')
    check(
      'and the panel is still closed around it',
      unsewn(thin.geometry) === 0,
      `${unsewn(thin.geometry)} unsewn edges`
    )
    // THE BUG, STATED AS THE USER SAW IT. The near face used to sink until it
    // came out of the back of the panel: a dome standing proud of the far side,
    // inside out, with the two faces creased through each other. Nothing may
    // leave the slab it was cut from.
    check(
      'and nothing is pushed out of the back of it',
      poked(thin.geometry, 0.08) < 1e-6,
      `${poked(thin.geometry, 0.08).toExponential(1)} beyond the face`
    )
    check(
      'and the surface is nowhere folded through itself',
      pinches(thin.geometry) === 0,
      `${pinches(thin.geometry)} lines cross it out of order`
    )
    thin.geometry.dispose()
  }

  // GOING OVER IT AGAIN WIDENS THE HOLE, and stops at the brush. A flame
  // widens the hole it has made by melting its rim back, so the bore grows and
  // levels off at about the size of the sphere doing the melting -- past that,
  // the user has to move the brush.
  {
    const bore = (n: number): number => {
      const geom = held(0.08, press(0.08, n), `burn-bore${n}`).geometry
      let out = 0
      for (let r = 0.02; r < RADIUS * 1.5; r += 0.02) {
        let clear = true
        for (let a = 0; a < 8; a++) {
          const angle = (a / 8) * Math.PI * 2
          if (!holed(geom, Math.cos(angle) * r + 0.00713, Math.sin(angle) * r + 0.00311)) {
            clear = false
          }
        }
        if (clear) out = r
      }
      geom.dispose()
      return out
    }
    const one = bore(1)
    const five = bore(5)
    const twenty = bore(20)
    check(
      'a second press widens the hole',
      five > one,
      `${one.toFixed(2)} after one, ${five.toFixed(2)} after five`
    )
    check(
      'and holding it there stops at about the brush',
      twenty >= five && twenty < RADIUS * 1.2,
      `${twenty.toFixed(2)} after twenty, brush ${RADIUS}`
    )
  }

  // A STROKE CUTS A SLOT, in one pass. The dabs are laid a third of a radius
  // apart and each of them opens a hole most of the brush across, so what the
  // user drew is open along its whole length rather than perforated.
  //
  // Sampled inside the ends of the stroke rather than out to them. A dab landing
  // on the rim of the hole the last one made spends itself widening that hole
  // instead of eating forward -- the material ahead of it is under the outside
  // of the brush, where the bite is small and the wall is still whole -- so the
  // slot stops about a dab short of where the flame did. That is the honest
  // shape of a small flame dragged along, and it is not what this is measuring.
  {
    const dabs: ErodeDab[] = []
    for (let x = -0.6; x <= 0.6; x += RADIUS * DAB_SPACING) {
      dabs.push({ at: [x, 0, 0.04], radius: RADIUS, heat: 1, smooth: 0.7 })
    }
    const slot = held(0.08, dabs, 'burn-slot')
    let along = 0
    let broken = ''
    for (let x = -0.45; x <= 0.45; x += 0.05) {
      if (holed(slot.geometry, x + 0.00713, 0.00311)) along++
      else broken += ` ${x.toFixed(2)}`
    }
    check('a stroke cuts a slot right through, in one pass', broken === '', `open at ${along} of 19 points${broken && `, closed at${broken}`}`)
    check(
      'and the slot leaves the panel closed and unfolded',
      unsewn(slot.geometry) === 0 && pinches(slot.geometry) === 0,
      `${unsewn(slot.geometry)} unsewn, ${pinches(slot.geometry)} folded lines`
    )
    // REPLAYED, like every other stroke: the dabs are the document and the mesh
    // is derived from them. Burning through takes triangles out and puts a
    // tunnel in, which is the one thing in this file that changes the topology,
    // so the claim is worth making again where it is hardest to keep.
    const again = held(0.08, dabs, 'burn-slot-again')
    const first = slot.geometry.getAttribute('position').array
    const second = again.geometry.getAttribute('position').array
    let same = first.length === second.length
    for (let i = 0; same && i < first.length; i++) same = first[i] === second[i]
    check('and replaying it gives the same mesh', same, `${first.length} floats`)
    slot.geometry.dispose()
    again.geometry.dispose()
  }

  // A WALL THICKER THAN THE BRUSH CAN REACH STILL DISHES. One dab position
  // cannot sink deeper than its own radius -- a vertex that has sagged out of
  // reach stops being melted -- so there is a thickness past which the torch
  // has no way to run out of material, and it must go on behaving exactly as
  // it did before any of this existed.
  {
    const thick = held(1, press(1, 20), 'burn-thick')
    check(
      'twenty presses on a thick slab open nothing',
      !holed(thick.geometry, 0.00713, 0.00311),
      ''
    )
    check(
      'and dish it without folding it',
      unsewn(thick.geometry) === 0 && pinches(thick.geometry) === 0,
      `${unsewn(thick.geometry)} unsewn, ${pinches(thick.geometry)} folded lines`
    )
    check(
      'while still taking material off',
      signedVolume(thick.geometry) < 4 - 1e-4,
      `${signedVolume(thick.geometry).toFixed(5)} from 4`
    )
    thick.geometry.dispose()
  }

  // THE SCULPT TOOL NEVER GETS HERE, and it is not a special case in the code
  // -- raising drives the two faces of a wall APART. Asked of the same panel
  // that the torch goes through in one press.
  {
    const raised = held(0.08, press(0.08, 20, { raise: true }), 'burn-raise')
    check(
      'the sculpt tool opens no hole in the panel the torch goes through',
      !holed(raised.geometry, 0.00713, 0.00311),
      ''
    )
    check(
      'and adds material rather than taking it',
      signedVolume(raised.geometry) > 0.32,
      `${signedVolume(raised.geometry).toFixed(5)} from 0.32`
    )
    raised.geometry.dispose()
  }
}


// --- The mirror -------------------------------------------------------------
console.log('\nA mirror reflects the whole object and leaves it where it stood')
{
  /**
   * Does one mesh enclose the same points as another?
   *
   * Sampled, by ray parity, rather than by a boolean: intersecting a solid with
   * a copy of itself is every coplanar-face degeneracy in one call, and the CSG
   * library reports anything from 50% to 100% overlap depending on which
   * primitive it is handed. Parity does not care how either mesh is
   * tessellated, which is exactly the indifference this needs -- a mirrored
   * solid is REBUILT through the whole pipeline, so its triangles are its own.
   */
  function sameSolid(a: BufferGeometry, b: BufferGeometry): number {
    const meshes = [a, b].map((g) => {
      const mesh = new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }))
      mesh.updateMatrixWorld(true)
      return mesh
    })
    const box = new Box3()
      .setFromBufferAttribute(a.getAttribute('position') as BufferAttribute)
      .union(new Box3().setFromBufferAttribute(b.getAttribute('position') as BufferAttribute))
      .expandByScalar(0.05)

    const probe = new Raycaster()
    // Skew, so the ray does not run along a face of anything axis-aligned --
    // which is most of what is tested here, and where a parity count is least
    // trustworthy.
    const along = new Vector3(0.37139068, 0.55708601, 0.74278135)
    const inside = (mesh: Mesh, p: Vector3) => {
      probe.set(p, along)
      return probe.intersectObject(mesh, false).length % 2 === 1
    }

    // Its own generator, so a run that fails fails again on the next run.
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const span = box.getSize(new Vector3())
    let agreed = 0
    const tried = 1200
    for (let i = 0; i < tried; i++) {
      const p = new Vector3(
        box.min.x + rnd() * span.x,
        box.min.y + rnd() * span.y,
        box.min.z + rnd() * span.z
      )
      if (inside(meshes[0], p) === inside(meshes[1], p)) agreed++
    }
    return agreed / tried
  }

  /** An object's geometry in WORLD space, which is where a mirror is judged. */
  function worldGeometry(o: SceneObject): BufferGeometry {
    resetEvaluator()
    const g = evaluateObject(o).geometry.clone()
    return g.applyMatrix4(objectMatrix(o.transform))
  }

  /**
   * The reflection the tool CLAIMS to have performed, done to the original by
   * brute force: carry the mesh to the object's own world centre, negate one
   * world coordinate along the object's own axis, and carry it back.
   *
   * This is the ground truth the document rewrite is measured against, and it
   * shares no code with it -- which is the whole point. `mirror.ts` reaches the
   * same solid by restating anchors, cut planes and part transforms; if the two
   * agree, the restatement is right.
   */
  function reflectedInPlace(o: SceneObject, axis: Axis): BufferGeometry {
    const m = objectMatrix(o.transform)
    const centre = new Vector3(...assemblyCentre(o)).applyMatrix4(m)
    const n = new Vector3().setComponent(axis, 1).transformDirection(m).normalize()
    // I - 2nn', with the shift to the centre either side of it.
    const flip = new Matrix4().set(
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
      -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
      -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0,
      0, 0, 0, 1
    )

    const source = worldGeometry(o)
    const out = source.getIndex() ? source.toNonIndexed() : source.clone()
    out
      .applyMatrix4(new Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z))
      .applyMatrix4(flip)
      .applyMatrix4(new Matrix4().makeTranslation(centre.x, centre.y, centre.z))

    // A reflection turns every triangle inside out, so the winding is put back
    // -- otherwise the volume comes out negative and the parity test is reading
    // a solid the mesh does not describe.
    const pos = out.getAttribute('position').array as Float32Array
    for (let i = 0; i + 8 < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const swap = pos[i + 3 + k]
        pos[i + 3 + k] = pos[i + 6 + k]
        pos[i + 6 + k] = swap
      }
    }
    out.deleteAttribute('normal')
    out.deleteAttribute('uv')
    out.computeVertexNormals()
    return out
  }

  function mirrors(label: string, o: SceneObject): void {
    for (const axis of [0, 1, 2] as Axis[]) {
      const expected = reflectedInPlace(o, axis)
      const actual = worldGeometry(mirrorAssembly(o, axis))
      const va = signedVolume(actual)
      const ve = signedVolume(expected)
      const same = sameSolid(actual, expected)
      check(
        `${label}, mirrored about ${'XYZ'[axis]}`,
        Math.abs(va - ve) <= 2e-3 * Math.max(1, Math.abs(ve)) && same > 0.995,
        `volume ${va.toFixed(5)} vs ${ve.toFixed(5)}, ${(same * 100).toFixed(2)}% of samples agree`
      )
      expected.dispose()
      actual.dispose()
    }
  }

  const solid = (base: BaseSolid, over: Partial<SceneObject> = {}): SceneObject => ({
    id: 'm',
    name: 'm',
    base,
    transform: IDENTITY_TRANSFORM,
    features: [],
    cuts: [],
    parts: [],
    ...over,
  })

  // The primitives, one at a time. A box, a sphere, a cylinder and a bean are
  // symmetric about all three of their own axis planes and are the easy case;
  // the rest are here because they are not.
  mirrors('a box', solid({ kind: 'box', size: [1, 2, 3] }))
  // Symmetric about every plane containing its axis and none across it, so a
  // mirror along Y has to reflect in X and turn the object to make up for it.
  mirrors('a cone', solid({ kind: 'cone', radius: 0.5, height: 1.4 }))
  // Odd side counts: the ring's own mirror planes fall on X but not on Z.
  mirrors('a pentagonal prism', solid({ kind: 'prism', radius: 0.5, height: 0.9, sides: 5 }))
  mirrors('a pentagonal pyramid', solid({ kind: 'pyramid', radius: 0.5, height: 0.9, sides: 5 }))
  // The tetrahedron survives NO axis plane once it is stood on a face, so this
  // is the case that proves the corner search finds a real mirror.
  mirrors('a tetrahedron', solid({ kind: 'platonic', solid: 'tetrahedron', radius: 0.55 }))
  mirrors('a dodecahedron', solid({ kind: 'platonic', solid: 'dodecahedron', radius: 0.55 }))

  // And everything a document hangs off a primitive.
  mirrors(
    'a turned box wearing a spun boss',
    solid(
      { kind: 'box', size: [1, 1, 1] },
      {
        features: [
          feature({
            anchor: { on: 'box-face', face: 2, u: 0.3, v: -0.2 },
            shape: { type: 'rect', w: 0.3, h: 0.16 },
            rotation: 0.4,
            depth: 0.25,
          }),
        ],
        transform: { position: [0.4, 0.2, -0.3], rotation: [0.3, -0.6, 0.2] },
      }
    )
  )
  mirrors(
    'a sphere wearing a spun pocket',
    solid(
      { kind: 'sphere', radius: 0.6 },
      {
        features: [
          feature({
            anchor: { on: 'sphere', theta: 0.9, phi: 1.1 },
            shape: { type: 'rect', w: 0.3, h: 0.15 },
            rotation: 0.7,
            depth: -0.18,
          }),
        ],
      }
    )
  )
  // Tilt and faceOffset together: the created face leans AND slides, and both
  // are written in a frame that has just changed handedness.
  mirrors(
    'a cone wearing a tilted, slid boss',
    solid(
      { kind: 'cone', radius: 0.6, height: 1.2 },
      {
        features: [
          feature({
            anchor: { on: 'cone', theta: 1.2, t: 0.4 },
            shape: { type: 'rect', w: 0.2, h: 0.12 },
            rotation: 0.5,
            depth: 0.22,
            tilt: [0.2, 0.1, -0.15],
            faceOffset: [0.06, -0.04],
          }),
        ],
      }
    )
  )
  mirrors(
    'a cut solid',
    solid(
      { kind: 'box', size: [1, 1, 1] },
      { cuts: [{ id: 'c1', origin: [0.1, 0.15, 0], normal: [0.6, 0.8, 0], side: 1 }] }
    )
  )
  // A part chooses its own mirror plane, and the mismatch with its host's lands
  // in its rotation: a cone welded into a box is still a cone.
  mirrors(
    'a box with a cone welded to it',
    solid(
      { kind: 'box', size: [1, 1, 1] },
      {
        parts: [
          solid(
            { kind: 'cone', radius: 0.3, height: 0.8 },
            { id: 'part', transform: { position: [0.4, 0.6, 0.2], rotation: [0.4, 0.2, -0.3] } }
          ),
        ],
      }
    )
  )
  mirrors(
    'a drilled box',
    solid(
      { kind: 'box', size: [1, 1, 1] },
      {
        erased: [
          solid(
            { kind: 'cylinder', radius: 0.15, height: 2 },
            { id: 'hole', transform: { position: [0.25, 0, 0.1], rotation: [0.2, 0, 0.3] } }
          ),
        ],
      }
    )
  )
  mirrors(
    'a torched box',
    solid(
      { kind: 'box', size: [1, 1, 1] },
      { erosion: [{ at: [0.3, 0.5, 0.1], radius: 0.3, heat: 0.7, smooth: 0.3 }] }
    )
  )

  {
    // An imported model is the one base with no symmetry to lean on, so its
    // triangles are genuinely reflected. A handed wedge -- no mirror plane at
    // all -- is what makes that testable.
    const wedge = new BufferGeometry()
    wedge.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([
          0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0,
          0, 1, 0, 0, 0, 1,
        ]),
        3
      )
    )
    wedge.computeVertexNormals()
    const entry = registerMesh(wedge, 'wedge')

    mirrors(
      'an imported model',
      solid(
        { kind: 'mesh', meshId: entry.id, label: 'wedge', size: [1, 1.4, 0.8] },
        { transform: { position: [0.3, 0, -0.2], rotation: [0.2, 0.5, -0.1] } }
      )
    )
    // And the shelf does not grow a copy per press: flipping back finds the
    // model that was already there.
    check(
      'a model mirrored twice is the model it started as',
      mirrorMesh(mirrorMesh(entry.id, 0), 0) === entry.id,
      `${mirrorMesh(mirrorMesh(entry.id, 0), 0)} vs ${entry.id}`
    )
  }

  {
    // The promise the tool makes about WHERE: a merged object is reflected
    // about its own centre, which is the point its gizmo sits on, so nothing
    // slides across the scene when it flips.
    const merged = solid(
      { kind: 'box', size: [1, 1, 1] },
      {
        parts: [
          solid(
            { kind: 'cone', radius: 0.3, height: 0.8 },
            { id: 'part', transform: { position: [0.6, 0.4, 0.2], rotation: [0, 0, 0] } }
          ),
        ],
        transform: { position: [0.5, 0.25, -0.4], rotation: [0.3, 0.9, -0.2] },
      }
    )
    const anchorOf = (o: SceneObject) =>
      new Vector3(...assemblyCentre(o)).applyMatrix4(objectMatrix(o.transform))

    for (const axis of [0, 1, 2] as Axis[]) {
      const moved = anchorOf(merged).distanceTo(anchorOf(mirrorAssembly(merged, axis)))
      check(
        `the gizmo point holds still under a mirror about ${'XYZ'[axis]}`,
        moved < 1e-9,
        `moved ${moved.toExponential(2)}`
      )
    }
  }

  {
    // Twice is nothing at all -- and not merely to the eye: the document has to
    // come back to the same numbers, or a user flipping a part to compare the
    // two ways round would leave drift behind in every anchor.
    const twice = solid(
      { kind: 'pyramid', radius: 0.5, height: 0.9, sides: 5 },
      {
        features: [
          feature({
            anchor: { on: 'planar-face', face: 0, u: 0.1, v: 0.05 },
            shape: { type: 'rect', w: 0.2, h: 0.1 },
            rotation: 0.3,
            depth: 0.2,
          }),
        ],
        transform: { position: [0.2, 0, 0.1], rotation: [0.1, 0.2, 0.3] },
      }
    )
    for (const axis of [0, 1, 2] as Axis[]) {
      const back = mirrorAssembly(mirrorAssembly(twice, axis), axis)
      const drift = Math.max(
        ...back.transform.position.map((v, i) => Math.abs(v - twice.transform.position[i])),
        ...back.transform.rotation.map((v, i) => Math.abs(v - twice.transform.rotation[i])),
        Math.abs(back.features[0].rotation - twice.features[0].rotation)
      )
      check(
        `mirroring twice about ${'XYZ'[axis]} is the identity`,
        drift < 1e-9,
        `worst drift ${drift.toExponential(2)}`
      )
    }
  }
}

// --- The lathe ---------------------------------------------------------------
//
// The other way this app makes a solid, and the only one with no mesh in it. A
// piece on the lathe is a row of radii -- see `clay.ts` -- so what is checked
// here is not watertightness or winding but the promises the two tools make to
// the hand: the wall goes to the pointer, it stops there, it goes nowhere the
// tool is not pointed, and it never comes out of a stroke sharper than it went
// in.
console.log('\nThe lathe shapes a wall of radii, and keeps its promises about it')
{
  /** The enclosed volume of a solid of revolution: pi times the integral of r
   *  squared up the axis. The lathe's answer to `signedVolume` -- one number
   *  that says whether a stroke added material or took it away. */
  const clayVolume = (c: Clay): number => {
    const step = c.height / (CLAY_RINGS - 1)
    let sum = 0
    for (let i = 0; i < CLAY_RINGS - 1; i += 1) {
      const a = c.wall[i]
      const b = c.wall[i + 1]
      // A frustum per gap, which is exact for a wall drawn as straight
      // segments -- and the wall IS drawn as straight segments. See
      // `silhouette`.
      sum += (Math.PI * step * (a * a + a * b + b * b)) / 3
    }
    return sum
  }

  /** The sharpest step between neighbouring rings: what a crease looks like as
   *  a number. */
  const roughest = (c: Clay): number => {
    let worst = 0
    for (let i = 1; i < CLAY_RINGS; i += 1) {
      worst = Math.max(worst, Math.abs(c.wall[i] - c.wall[i - 1]))
    }
    return worst
  }

  /**
   * Hold a tool at one spot for `times` frames, the way a press does.
   *
   * ANCHORED ONCE, which is the whole of what makes it a stroke: the wall the
   * dish is measured from is the wall this press found, not the one the last
   * frame left. The store does exactly this between `beginStroke` and
   * `endStroke`; re-anchoring every frame is what turns the tool into a punch,
   * and the crease check below is what would catch it.
   */
  const hold = (c: Clay, dab: Dab, times: number): Clay => {
    const from = c.wall
    let out = c
    for (let n = 0; n < times; n += 1) out = mold(out, dab, from)
    return out
  }

  const stock = freshClay(1.5, 0.4)

  // A FRESH LUMP IS A CYLINDER, which is the one shape the whole screen starts
  // from and the one the Clay panel claims to set.
  check(
    'a fresh lump is a cylinder of the stock radius',
    stock.wall.length === CLAY_RINGS && stock.wall.every((r) => r === 0.4),
    `${stock.wall.length} rings, ${new Set(stock.wall).size} distinct radius`
  )
  check('and it says it is untouched', isFresh(stock), `${isFresh(stock)}`)
  near('its rings run from the faceplate', ringHeight(stock, 0), 0, 0)
  near('to the rim, ends included', ringHeight(stock, CLAY_RINGS - 1), 1.5, 1e-12)
  near('and it holds the volume of that cylinder', clayVolume(stock), Math.PI * 0.16 * 1.5, 1e-6)

  const middle: Dab = { y: 0.75, radius: 0.25, reach: 0.3, bite: 0.25, tool: 'push' }

  // THE WALL GOES TO THE POINTER AND STOPS THERE. Everything about aiming this
  // screen rests on the second half: hold longer and the curve finishes, it
  // does not deepen.
  {
    const once = mold(stock, middle)
    const under = once.wall[48]
    check('one push moves the wall in', under < 0.4, `${under.toFixed(4)} from 0.400`)
    check('and not past the pointer', under > 0.25, `${under.toFixed(4)} against 0.250`)

    const held = hold(stock, middle, 400)
    near('holding takes the wall to the pointer', held.wall[48], 0.25, 0.002)
    check(
      'and holding for ever cannot take it further',
      held.wall.every((r) => r >= 0.25 - 1e-9),
      `deepest ${Math.min(...held.wall).toFixed(4)}`
    )
    check('the push took material away', clayVolume(held) < clayVolume(stock), '')
  }

  // NEITHER TOOL WORKS THE OTHER'S WAY, which is what makes a missed aim
  // harmless rather than destructive.
  {
    const wide = mold(stock, { ...middle, radius: 0.6 })
    check(
      'a push aimed outside the wall does nothing at all',
      wide === stock,
      wide === stock ? 'the same lump' : 'a new lump'
    )
    const pulled = hold(stock, { ...middle, radius: 0.6, tool: 'pull' }, 400)
    near('a pull takes the wall out to the pointer', pulled.wall[48], 0.6, 0.002)
    check('and no further', Math.max(...pulled.wall) <= 0.6 + 1e-9, '')
    check('the pull added material', clayVolume(pulled) > clayVolume(stock), '')
    const narrow = mold(stock, { ...middle, radius: 0.25, tool: 'pull' })
    check('a pull aimed inside the wall does nothing at all', narrow === stock, '')
  }

  // WHAT IS OUTSIDE THE TOOL IS UNTOUCHED, to the bit -- the promise the
  // modelling brushes make about vertices outside the sphere.
  {
    const once = mold(stock, middle)
    let moved = 0
    for (let i = 0; i < CLAY_RINGS; i += 1) {
      const far = Math.abs(ringHeight(stock, i) - middle.y) >= middle.reach
      if (far && once.wall[i] !== stock.wall[i]) moved += 1
    }
    check('no ring outside the tool moves', moved === 0, `${moved} moved`)
    const miss = mold(stock, { ...middle, y: 9 })
    check('and a tool held off the piece hands back the same lump', miss === stock, '')
  }

  // THE BOUNDS HOLD however hard the tool is leant on, which is what keeps the
  // piece inside the frame it is drawn in.
  {
    const { min, max } = wallBounds(0.4)
    const pinched = hold(stock, { y: 0.75, radius: 0, reach: 0.3, bite: 1, tool: 'push' }, 200)
    near(
      'a wall pinched as hard as possible stops at the floor',
      Math.min(...pinched.wall),
      min,
      1e-9
    )
    const flared = hold(stock, { y: 0.75, radius: 99, reach: 0.3, bite: 1, tool: 'pull' }, 200)
    near(
      'and a wall pulled as hard as possible stops at the ceiling',
      Math.max(...flared.wall),
      max,
      1e-9
    )
  }

  // NEITHER TOOL CAN SHARPEN THE WALL. The relax pass is what buys this, and it
  // is the half of the brush that is easiest to lose in a refactor.
  {
    const cut = hold(stock, { y: 0.75, radius: 0.1, reach: 0.3, bite: 1, tool: 'push' }, 60)
    const step = roughest(cut)
    // The deepest cut here is 0.3 of a unit spread over the rings inside a 0.3
    // reach -- about 38 of them -- so a wall that had gone step-shaped would
    // show a jump of that order. A tenth of it is a curve.
    check('the deepest cut leaves no crease', step < 0.03, `sharpest step ${step.toFixed(4)}`)
    // And what it leaves is a dish rather than a trench: monotone from the rim
    // of the tool down to the middle of it.
    let dents = 0
    for (let i = 30; i < 48; i += 1) if (cut.wall[i + 1] > cut.wall[i] + 1e-9) dents += 1
    check('and the cut falls away smoothly to its middle', dents === 0, `${dents} dents`)
  }

  // THE STRENGTH DIAL IS A SPEED, and it is measured in time rather than in
  // frames -- the same gesture has to take the same material off at 60 Hz and
  // at 144.
  {
    near('a frame of contact bites by the dial', bite(0.5, 1000 / 60), 0.125, 1e-9)
    near('twice the frame, twice the bite', bite(0.5, 1000 / 30), 0.25, 1e-9)
    check('and it can never pass all the way there', bite(1, 10000) === 1, `${bite(1, 10000)}`)
  }

  // THE SIZE FIELDS CARRY THE SHAPE. A piece made wider is the same piece,
  // wider -- which is what makes the Clay panel safe to touch after an hour's
  // work.
  {
    const shaped = hold(stock, middle, 40)
    const wider = resize(shaped, { radius: 0.8 })
    const drift = Math.max(...shaped.wall.map((r, i) => Math.abs(wider.wall[i] / r - 2)))
    check('doubling the radius doubles every ring', drift < 1e-9, `worst ${drift.toExponential(2)}`)

    const taller = resize(shaped, { height: 3 })
    check(
      'and changing the height leaves the wall alone',
      taller.wall.every((r, i) => r === shaped.wall[i]),
      'the rings are fractions of the height, not positions'
    )
    near('the rings stretch with it', ringHeight(taller, CLAY_RINGS - 1), 3, 1e-12)

    // A wall pulled to the flare limit of a wide stock is past the limit of a
    // narrow one, and a shape that could not have been made from the stock it
    // claims is not one this screen can go on working.
    const flared = hold(stock, { y: 0.75, radius: 99, reach: 0.3, bite: 1, tool: 'pull' }, 200)
    const shrunk = resize(flared, { radius: 0.1 })
    const bounds = wallBounds(0.1)
    const inside = shrunk.wall.every(
      (r) => r <= bounds.max + 1e-12 && r >= bounds.min - 1e-12
    )
    check(
      'shrinking the stock re-clamps the wall to what it now allows',
      inside,

      `${Math.min(...shrunk.wall).toFixed(4)}..${Math.max(...shrunk.wall).toFixed(4)}`
    )
  }

  // TURNED INTO TRIANGLES, which is the one thing the lathe does that leaves
  // this screen: the wall swept a full turn and capped, ready for the clipboard
  // and for everything the modelling screen can do to a solid.
  //
  // Signed volume is the whole test, and it is two tests in one: it only comes
  // out right if the mesh is closed AND wound outward, so a sweep that leaked
  // at the seam or turned itself inside out cannot land on the answer by
  // accident. It is the same instrument every boolean in this file is measured
  // with. See `signedVolume`.
  {
    const cylinder = freshClay(1.5, 0.4)
    const solid = revolveClay(cylinder)

    // A regular n-gon inscribed in a circle holds n*sin(2pi/n) / 2pi of its
    // area -- 0.99839 at 64 facets -- so a swept cylinder comes out a sixth of
    // a percent light, and that is the mesh being RIGHT rather than wrong. The
    // deficit is predicted rather than tolerated, so the check stays tight
    // enough that a missing cap or a dropped ring fails it outright.
    const exact = Math.PI * 0.4 * 0.4 * 1.5
    const facets = (TURN_FACETS * Math.sin((2 * Math.PI) / TURN_FACETS)) / (2 * Math.PI)
    near('a swept cylinder holds a cylinder of clay', signedVolume(solid), exact * facets, 1e-5)
    check(
      'and it is wound the right way out',
      signedVolume(solid) > 0,
      `${signedVolume(solid).toFixed(5)}`
    )

    // The same, on a piece that has actually been worked: the frustum sum the
    // section is measured by, times the same 64-gon deficit.
    const worked = hold(cylinder, { y: 0.9, radius: 0.15, reach: 0.35, bite: 1, tool: 'push' }, 60)
    near(
      'and a shaped piece holds what its profile says',
      signedVolume(revolveClay(worked)),
      clayVolume(worked) * facets,
      1e-4
    )

    // Standing on the faceplate and no taller than the lump, which is what
    // makes the piece land resting on the grid when it is pasted.
    const box = new Box3().setFromBufferAttribute(
      solid.getAttribute('position') as BufferAttribute
    )
    near('it stands on zero', box.min.y, 0, 1e-9)
    near('and reaches the rim and no further', box.max.y, 1.5, 1e-9)
    near('as wide as the wall, both ways', box.max.x, 0.4, 0.001)
    near('and as deep', box.max.z, 0.4, 0.001)

    // Normals are analytic rather than averaged -- see `revolveClay` -- so
    // every one of them is a unit vector, seam included. An averaged normal at
    // a duplicated seam vertex is the classic crease down one meridian, and it
    // is invisible in any test that only counts triangles.
    const normals = solid.getAttribute('normal')
    let worstNormal = 0
    for (let i = 0; i < normals.count; i += 1) {
      const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))
      worstNormal = Math.max(worstNormal, Math.abs(length - 1))
    }
    check('every normal is a unit vector', worstNormal < 1e-6, `worst ${worstNormal.toExponential(2)}`)

    // The seam closes on itself exactly rather than within a float: the last
    // column is written from the first column's own angle.
    const pos = solid.getAttribute('position')
    const columns = TURN_FACETS + 1
    let seam = 0
    for (let i = 0; i < CLAY_RINGS; i += 1) {
      const first = i * columns
      const last = first + TURN_FACETS
      if (pos.getX(first) !== pos.getX(last) || pos.getZ(first) !== pos.getZ(last)) seam += 1
    }
    check('and the seam meets itself to the bit', seam === 0, `${seam} rings apart`)
  }

  // THE BASE THE PIECE STANDS ON. A lump may be turned round or on a triangle
  // through a decagon, and the whole of that choice is spent here: the clay is
  // one row of radii either way, and the sweep is where it becomes a prism or a
  // cylinder. See `Clay.sides`.
  {
    // The bound is a bound, and it is the only thing between a panel and a
    // sweep of two facets -- which encloses nothing -- or of five hundred.
    check('a base of two is not a base', clampSides(2) === CLAY_SIDES_MIN, `${clampSides(2)}`)
    check('and nor is a hundred', clampSides(100) === CLAY_SIDES_MAX, `${clampSides(100)}`)
    check('a count between two lands on one of them', clampSides(6.4) === 6, `${clampSides(6.4)}`)
    // Round is the OTHER option rather than an absent number: a clamp that
    // answered a count here would turn every unset piece into a triangle.
    check('and round stays round', clampSides(null) === null, `${clampSides(null)}`)
    check(
      'the selector offers every polygon from a triangle to a decagon',
      CLAY_SIDES.length === 8 && CLAY_SIDES[0] === 3 && CLAY_SIDES[7] === 10,
      CLAY_SIDES.join(' ')
    )

    // THE SAME PIECE ON EVERY BASE. Turning a worked lump hexagonal must not
    // touch one radius of it -- that is what lets the base be picked at any
    // point in a sitting rather than only at the start.
    const worked = hold(freshClay(1.5, 0.4), { y: 0.9, radius: 0.15, reach: 0.35, bite: 1, tool: 'push' }, 60)
    const hexagonal = { ...worked, sides: 6 }
    check(
      'a base change moves no part of the wall',
      hexagonal.wall.every((r, i) => r === worked.wall[i]),
      ''
    )

    // Every base, swept, measured against what the profile says it should
    // hold. The n-gon deficit is the SAME formula the round sweep is checked
    // with -- see above -- which is the point worth making: a round piece is an
    // inscribed 64-gon, so a hexagonal one is not a different kind of solid,
    // only a coarser count of the same one.
    for (const sides of CLAY_SIDES) {
      const piece = { ...worked, sides }
      const mesh = revolveClay(piece)
      const deficit = (sides * Math.sin((2 * Math.PI) / sides)) / (2 * Math.PI)
      near(
        `a ${sides}-sided piece holds the ${sides}-gon of its profile`,
        signedVolume(mesh),
        clayVolume(piece) * deficit,
        1e-4
      )
      check(
        `and is wound the right way out on ${sides}`,
        signedVolume(mesh) > 0,
        `${signedVolume(mesh).toFixed(5)}`
      )
    }

    const hexMesh = revolveClay(hexagonal)

    // THE WALL IS THE CORNERS. Every vertex up the wall stands at the radius
    // the tools worked it to, and the flat between two of them is cut in by
    // `flatFactor` -- which is what the Base panel tells the user, and what
    // makes a hexagonal piece the same width across corners as the round one it
    // was copied from.
    const pos = hexMesh.getAttribute('position')
    const width = 12
    let worstCorner = 0
    let worstFlat = 0
    for (let i = 0; i < CLAY_RINGS; i += 1) {
      const r = hexagonal.wall[i]
      for (let j = 0; j < width; j += 1) {
        const v = i * width + j
        worstCorner = Math.max(worstCorner, Math.abs(Math.hypot(pos.getX(v), pos.getZ(v)) - r))
      }
      // The middle of a facet: half way between the two columns that bound it.
      const a = i * width
      const b = a + 1
      const midX = (pos.getX(a) + pos.getX(b)) / 2
      const midZ = (pos.getZ(a) + pos.getZ(b)) / 2
      worstFlat = Math.max(worstFlat, Math.abs(Math.hypot(midX, midZ) - r * flatFactor(6)))
    }
    check('every corner stands at the radius the wall was worked to', worstCorner < 1e-6, `worst ${worstCorner.toExponential(2)}`)
    check('and the flats between them at the apothem', worstFlat < 1e-6, `worst ${worstFlat.toExponential(2)}`)

    // FLAT SHADED, which is the difference between a hexagonal prism and a
    // hexagon-shaped cylinder. A facet's two columns must agree about the way
    // it faces -- that is the flat -- and the two columns meeting at a corner
    // must disagree, by the polygon's own exterior angle. Averaged normals get
    // both of those wrong at once and the piece arrives looking like a badly
    // tessellated cylinder, which no triangle count would ever show.
    const nrm = hexMesh.getAttribute('normal')
    const ring = 40 * width
    let flatFacet = 0
    let sharpest = Math.PI
    for (let k = 0; k < 6; k += 1) {
      const a = ring + k * 2
      const b = a + 1
      flatFacet = Math.max(
        flatFacet,
        Math.abs(nrm.getX(a) - nrm.getX(b)) + Math.abs(nrm.getZ(a) - nrm.getZ(b))
      )
      // The corner: this facet's second column against the next facet's first.
      // Compared on the HORIZONTAL part alone, and renormalised first: a wall
      // that leans tips every normal by the profile's slope, which shortens the
      // (x, z) part of all of them equally and would read as a gentler corner
      // than the one that is there.
      const c = ring + ((k * 2 + 2) % (6 * 2))
      const one = Math.hypot(nrm.getX(b), nrm.getZ(b))
      const two = Math.hypot(nrm.getX(c), nrm.getZ(c))
      const dot = (nrm.getX(b) * nrm.getX(c) + nrm.getZ(b) * nrm.getZ(c)) / (one * two)
      sharpest = Math.min(sharpest, Math.acos(Math.min(1, Math.max(-1, dot))))
    }
    check('both sides of a facet face the same way', flatFacet < 1e-6, `worst ${flatFacet.toExponential(2)}`)
    near(
      'and the two columns at a corner turn a sixth of the way round',
      sharpest,
      (2 * Math.PI) / 6,
      1e-6
    )

    // Unit normals on a faceted piece too. The wall's normals combine the
    // facet's direction with the profile's slope, and a combination that is not
    // renormalised is the classic way to light a curved flat wrongly.
    let worstNormal = 0
    for (let i = 0; i < nrm.count; i += 1) {
      const length = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
      worstNormal = Math.max(worstNormal, Math.abs(length - 1))
    }
    check('every normal on a faceted piece is a unit vector', worstNormal < 1e-6, `worst ${worstNormal.toExponential(2)}`)

    // And it is the CHEAP one, which is worth pinning because the opposite is
    // the natural assumption: flat shading duplicates every column, so somebody
    // may one day take it for the expensive path and try to share them back.
    const hexTris = (hexMesh.getIndex()?.count ?? 0) / 3
    const roundTris = (revolveClay(worked).getIndex()?.count ?? 0) / 3
    check(
      'a faceted piece is far cheaper than a round one',
      hexTris * 5 < roundTris,
      `${hexTris} triangles against ${roundTris}`
    )
  }
}

// --- The rib, the profiles and the bore -------------------------------------
//
// The three things the lathe grew after its two tools: a smoothing tool that is
// the second half of the other two, a table of shapes to start from, and a way
// to take the middle out. All three are arithmetic on the same row of radii,
// which is why they are checked here rather than in front of a window.
console.log('\nThe lathe fairs, starts from a shape, and bores itself out')
{
  const roughest = (c: Clay): number => {
    let worst = 0
    for (let i = 1; i < CLAY_RINGS; i += 1) worst = Math.max(worst, Math.abs(c.wall[i] - c.wall[i - 1]))
    return worst
  }
  const hold = (c: Clay, dab: Dab, times: number): Clay => {
    const from = c.wall
    let out = c
    for (let i = 0; i < times; i += 1) out = mold(out, dab, from)
    return out
  }

  // THE RIB. A wall worked hard with a narrow tool carries the marks of it, and
  // the smoothing tool is the only thing on this screen that takes them out
  // without taking the shape out with them.
  {
    // A deliberately lumpy wall: alternate rings pushed apart, which is the
    // worst case there is and the one a naive averaging pass oscillates on.
    const stock = freshClay(1.5, 0.4)
    const lumpy: Clay = {
      ...stock,
      wall: stock.wall.map((r, i) => r + (i % 2 === 0 ? 0.03 : -0.03)),
    }
    // MEASURED UNDER THE TOOL, not over the whole piece. A rib is a local
    // thing -- the ripple either side of where it was held is exactly what it
    // must leave alone -- so a check that measured the lot would report the
    // untouched ends and never see the tool work at all.
    const roughestNear = (c: Clay, y: number, span: number): number => {
      let worst = 0
      for (let i = 1; i < CLAY_RINGS; i += 1) {
        if (Math.abs(ringHeight(c, i) - y) > span) continue
        worst = Math.max(worst, Math.abs(c.wall[i] - c.wall[i - 1]))
      }
      return worst
    }
    const rib: Dab = { y: 0.75, radius: 0.4, reach: 0.5, bite: 1, tool: 'smooth' }
    const before = roughestNear(lumpy, 0.75, 0.25)
    const ribbed = hold(lumpy, rib, 30)
    const after = roughestNear(ribbed, 0.75, 0.25)
    check('the rib takes the ripple out of a wall', after < before / 4, `${before.toFixed(4)} to ${after.toFixed(4)}`)
    // CONVERGES rather than oscillating, which is the whole reason `SMOOTH` is
    // under one: at a factor of exactly one this alternating wall would swap
    // itself back and forth forever and this check would never settle.
    const longer = hold(lumpy, rib, 120)
    check(
      'and holding longer only fairs it further',
      roughestNear(longer, 0.75, 0.25) <= after + 1e-9,
      `${roughestNear(longer, 0.75, 0.25).toExponential(2)}`
    )
    // And the ripple the rib never reached is still there, to the bit.
    check(
      'while the wall beyond it keeps every bump it had',
      ribbed.wall.every((r, i) => Math.abs(ringHeight(lumpy, i) - 0.75) < 0.5 || r === lumpy.wall[i]),
      ''
    )

    // IT DOES NOT AIM. Where the pointer sits across the wall is nothing to
    // this tool -- only the height it is held at -- which is what the panel
    // says and what makes the tool usable without a target.
    const near = mold(lumpy, { y: 0.75, radius: 0.05, reach: 0.5, bite: 1, tool: 'smooth' })
    const far = mold(lumpy, { y: 0.75, radius: 9, reach: 0.5, bite: 1, tool: 'smooth' })
    check(
      'and it ignores how far from the axis it is held',
      near.wall.every((r, i) => Math.abs(r - far.wall[i]) < 1e-12),
      ''
    )

    // A wall with nothing to fair is handed back unchanged, not merely equal --
    // the same promise a push aimed the wrong way makes.
    const smoothAlready = mold(stock, { y: 0.75, radius: 0.4, reach: 0.5, bite: 1, tool: 'smooth' })
    check('a fair wall is left exactly alone', smoothAlready === stock, '')
    // And a rib held off the piece reaches nothing at all.
    const missed = mold(lumpy, { y: 9, radius: 0.4, reach: 0.2, bite: 1, tool: 'smooth' })
    check('so is one the rib never reaches', missed === lumpy, '')

    // Outside the tool it is untouched to the bit, which is what makes the size
    // dial mean something.
    const local = mold(lumpy, { y: 0.2, radius: 0.4, reach: 0.15, bite: 1, tool: 'smooth' })
    let moved = 0
    for (let i = 0; i < CLAY_RINGS; i += 1) {
      if (Math.abs(ringHeight(lumpy, i) - 0.2) >= 0.15 && local.wall[i] !== lumpy.wall[i]) moved += 1
    }
    check('no ring outside the rib moves', moved === 0, `${moved} moved`)
  }

  // THE PROFILES. Each one has to land somewhere the tools could have reached
  // on their own -- inside the bounds every stroke obeys -- and has to come out
  // fair, since a wall with corners in it is not something anybody turned.
  {
    const lump = freshClay(1.5, 0.4)
    const { min, max } = wallBounds(lump.radius)
    check('the palette offers eight shapes to start from', CLAY_PROFILES.length === 8, `${CLAY_PROFILES.length}`)
    for (const profile of CLAY_PROFILES) {
      const wall = profileWall(lump, profile)
      const inside = wall.every((r) => r >= min - 1e-9 && r <= max + 1e-9)
      check(
        `${profile.id} lands where the tools could have taken it`,
        wall.length === CLAY_RINGS && inside,
        `${Math.min(...wall).toFixed(3)}..${Math.max(...wall).toFixed(3)} in ${min.toFixed(3)}..${max.toFixed(3)}`
      )
      // Faired on the way in: six straight runs between control points would
      // leave corners, and a turned piece has none.
      const shaped: Clay = { ...lump, wall }
      // A SLOPE, NOT A STEP. Unfaired, a goblet steps from a 1.2 foot to a
      // 0.28 stem between two neighbouring rings -- a third of the stock radius
      // in a millimetre and a half of height. Faired, the steepest thing in the
      // whole palette is that same transition at a twelfth of it. The bar is
      // set where it separates the two by a wide margin rather than where any
      // particular profile happens to land.
      check(
        `and ${profile.id} arrives fair rather than in straight runs`,
        roughest(shaped) < 0.05,
        `sharpest step ${roughest(shaped).toFixed(4)}`
      )
    }
    // A SHAPE RATHER THAN A SIZE: the same profile on a bigger lump is the same
    // piece, bigger. Checked as a ratio, since that is what "the same shape"
    // means.
    const vase = CLAY_PROFILES.find((p) => p.id === 'vase') as ClayProfile
    const small = profileWall(freshClay(1.5, 0.2), vase)
    const large = profileWall(freshClay(1.5, 0.4), vase)
    check(
      'a profile is a shape rather than a size',
      large.every((r, i) => Math.abs(r / small[i] - 2) < 1e-9),
      ''
    )
  }

  // THE BORE. One number and two switches on the way in; where the cavity
  // actually reaches on the way out. See `bore`.
  {
    const cup = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.06, capTop: false, capBottom: true } }
    const b = bore(cup) as Bore
    check('a hollow piece has a cavity', b !== null, '')
    near('whose floor is one wall thick', b.lo, 0.06, 1e-9)
    near('and which reaches the rim', b.hi, 1.5, 1e-9)
    near('a wall thinner than the piece all the way up', b.wall[0], 0.34, 1e-9)
    check('open at the top, standing on a floor', b.openTop && !b.openBottom, `${b.openTop}/${b.openBottom}`)

    // A solid piece has none, and neither has one whose wall is thicker than it
    // is wide -- which is a piece, not an error.
    check('a solid piece has no cavity', bore(freshClay()) === null, '')
    const stout = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.5, capTop: false, capBottom: true } }
    check('nor has one bored thinner than its own wall', bore(stout) === null, '')

    // ASKING IS NOT GETTING. A neck narrower than two walls stops the cavity
    // before it reaches the end, and the bore says so rather than pretending.
    const vase = CLAY_PROFILES.find((p) => p.id === 'vase') as ClayProfile
    // Thick enough that the vase's own rim is narrower than two walls, so
    // there is nothing to bore through at the end that was asked for. The
    // cavity ends up in the belly, blind at both ends.
    const necked = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.31, capTop: false, capBottom: true } }
    const shaped = { ...necked, wall: profileWall(necked, vase) }
    const blind = bore(shaped) as Bore
    check('a neck too thin to bore through stops the cavity', blind !== null && !blind.openTop, `${blind?.openTop}`)
    check('and the end that was asked for is honestly not open', blind !== null && blind.hi < shaped.height, `${blind?.hi.toFixed(3)} of ${shaped.height}`)

    // BORED FROM THE OPEN END, which is what stops a goblet being hollowed
    // through its foot -- the widest part of it, and the wrong end entirely.
    const goblet = CLAY_PROFILES.find((p) => p.id === 'goblet') as ClayProfile
    // A wall thicker than the stem is wide, so the stem cannot be bored at all
    // -- which is what makes this a test of WHICH pocket gets chosen rather
    // than of whether one exists. At a thinner wall the bore runs right down
    // through the stem into the foot, and that is correct: there is room.
    const cupLump = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.095, capTop: false, capBottom: true } }
    const stem = { ...cupLump, wall: profileWall(cupLump, goblet) }
    const bowlBore = bore(stem) as Bore
    check(
      'a goblet is bored from the cup rather than through its foot',
      bowlBore !== null && bowlBore.hi > stem.height * 0.9 && bowlBore.lo > stem.height * 0.3,
      `${bowlBore?.lo.toFixed(2)}..${bowlBore?.hi.toFixed(2)} of ${stem.height}`
    )
  }

  // AND WHAT IT SWEEPS TO. Signed volume again, which only comes out right if
  // the cavity is closed, wound INWARD, and joined to the outside at exactly
  // the ends that are open. It is the same instrument that proved the outer
  // sweep, pointed at the harder shape.
  {
    const facets = (TURN_FACETS * Math.sin((2 * Math.PI) / TURN_FACETS)) / (2 * Math.PI)
    const solid = Math.PI * 0.4 * 0.4 * 1.5
    const cavityOf = (h: number) => Math.PI * 0.34 * 0.34 * h
    const cases: [string, { thickness: number; capTop: boolean; capBottom: boolean }, number][] = [
      ['a cup', { thickness: 0.06, capTop: false, capBottom: true }, solid - cavityOf(1.44)],
      ['a pipe', { thickness: 0.06, capTop: false, capBottom: false }, solid - cavityOf(1.5)],
      ['a sealed void', { thickness: 0.06, capTop: true, capBottom: true }, solid - cavityOf(1.38)],
      ['a bell', { thickness: 0.06, capTop: true, capBottom: false }, solid - cavityOf(1.44)],
    ]
    for (const [name, hollow, exact] of cases) {
      const piece = { ...freshClay(1.5, 0.4), hollow }
      const mesh = revolveClay(piece)
      near(`${name} holds the clay its section says`, signedVolume(mesh), exact * facets, 1e-5)
      check(`and ${name} is closed and wound the right way out`, signedVolume(mesh) > 0, `${signedVolume(mesh).toFixed(5)}`)
    }

    // A hollow piece still stands on the faceplate and still reaches its rim:
    // boring it out must not move the thing itself.
    const cup = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.06, capTop: false, capBottom: true } }
    const box = new Box3().setFromBufferAttribute(
      revolveClay(cup).getAttribute('position') as BufferAttribute
    )
    near('a bored piece still stands on zero', box.min.y, 0, 1e-9)
    near('and still reaches its own rim', box.max.y, 1.5, 1e-9)
    near('and is no wider than it was', box.max.x, 0.4, 0.001)

    // Every normal is a unit vector on the inside too -- the cavity's wall is
    // the same analytic normal with its sign turned over.
    const normals = revolveClay(cup).getAttribute('normal')
    let worst = 0
    for (let i = 0; i < normals.count; i += 1) {
      worst = Math.max(worst, Math.abs(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) - 1))
    }
    check('every normal on a hollow piece is a unit vector', worst < 1e-6, `worst ${worst.toExponential(2)}`)

    // AND IT WORKS ON A FACETED PIECE, where the cavity is a hexagon inside a
    // hexagon: both walls take the same facet count, so the corners line up and
    // the rim between them is one quad per flat.
    const hex = { ...cup, sides: 6 }
    const hexVol = signedVolume(revolveClay(hex))
    const hexFacets = (6 * Math.sin((2 * Math.PI) / 6)) / (2 * Math.PI)
    near('a hollow hexagonal piece holds its own section', hexVol, (solid - cavityOf(1.44)) * hexFacets, 1e-5)
  }

  // UNDO IS THE WALL. `withWall` is what puts one back, and it has to survive
  // the lump having changed since -- an entry taken before the stock was
  // narrowed describes a wall the lump can no longer hold.
  {
    const wide = freshClay(1.5, 0.8)
    const flared = hold(wide, { y: 0.75, radius: 1.4, reach: 0.4, bite: 1, tool: 'pull' }, 60)
    const narrowed = resize(flared, { radius: 0.2 })
    const put = withWall(narrowed, flared.wall)
    const { min, max } = wallBounds(narrowed.radius)
    check(
      'a wall put back on a narrower lump is clamped to what it now allows',
      put.wall.every((r) => r >= min - 1e-9 && r <= max + 1e-9),
      `${Math.min(...put.wall).toFixed(3)}..${Math.max(...put.wall).toFixed(3)}`
    )
    check('and the lump keeps its own stock', put.radius === 0.2 && put.height === 1.5, `${put.radius}`)
    // Handed back unchanged when it is the wall the lump already has, so a redo
    // of a stroke that moved nothing cannot make React redraw.
    check('putting back the wall it already has changes nothing', withWall(flared, flared.wall) === flared, '')
  }
}

console.log(
  failures === 0
    ? '\nAll engine checks passed.\n'
    : `\n${failures} engine check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
