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
import { BufferGeometry, Euler, Ray, Vector3 } from 'three'

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
import { platonicFaces } from '../src/geometry/solids'
import {
  advanceTurn,
  axisParam,
  axisTarget,
  axisTravel,
  beginAxisDrag,
  nearestLocalAxis,
  nearestViewAxis,
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
import { objectMatrix, relativeTransform } from '../src/geometry/transform'
import { planeSeparates, splitPlanes } from '../src/geometry/cut'
import { signedVolume } from '../src/geometry/volume'
import { IDENTITY_TRANSFORM, defaultFeature } from '../src/geometry/types'
import type {
  BaseSolid,
  CutPlane,
  Doc,
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
  if (base.kind !== 'box') throw new Error('not a box')
  return base.size[axis === 'x' ? 0 : axis === 'y' ? 1 : 2]
}
function radiusOf(base: BaseSolid): number {
  if (base.kind === 'box') throw new Error('a box has no radius')
  return base.radius
}
function heightOf(base: BaseSolid): number {
  if (base.kind === 'box' || base.kind === 'sphere' || base.kind === 'platonic') {
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
  const big = scaleUniform(slab, 4)
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
console.log('\n16. A ring turn runs about one axis and unwraps past half a circle')

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
  // Resizing survives the arrows leaving the object's frame. A world arrow is
  // matched to the local dimension it most nearly runs along, so the side that
  // grows is the side being pulled.
  const x = new Vector3(1, 0, 0)
  const y = new Vector3(0, 1, 0)
  const z = new Vector3(0, 0, 1)

  const flat = nearestLocalAxis(WORLD_FRAME, x)
  check('an unturned object maps each arrow to itself', flat === 0, `local ${flat}`)
  const flatZ = nearestLocalAxis(WORLD_FRAME, z)
  check('and so on down the three', flatZ === 2, `local ${flatZ}`)

  // A quarter turn about Y sends local Z along world +X, so the world X arrow
  // now resizes the box's DEPTH -- which is the dimension that visibly faces
  // the arrow being dragged.
  const quarter: Vec3 = [0, Math.PI / 2, 0]
  const fromX = nearestLocalAxis(quarter, x)
  check('a quarter turn hands world X to local Z', fromX === 2, `local ${fromX}`)
  // Unsigned: local X points down world -Z after that turn, and pulling the +Z
  // arrow outward still widens it. A solid grows both ways about its centre, so
  // which end of the local axis faces the arrow makes no difference.
  const fromZ = nearestLocalAxis(quarter, z)
  check('and world Z to local X, sign and all', fromZ === 0, `local ${fromZ}`)
  const fromY = nearestLocalAxis(quarter, y)
  check('while Y, the axis turned about, is untouched', fromY === 1, `local ${fromY}`)

  // Between the right angles it is the nearest answer rather than an exact one,
  // and it must still be one of the three -- never a refusal.
  const askew = nearestLocalAxis([0.3, 0.4, 0.2], y)
  check('an askew object still names an axis', [0, 1, 2].includes(askew), `local ${askew}`)
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

console.log(
  failures === 0
    ? '\nAll engine checks passed.\n'
    : `\n${failures} engine check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
