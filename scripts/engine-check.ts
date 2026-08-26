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
import { BufferGeometry, Vector3 } from 'three'

// three-bvh-csg calls three-mesh-bvh with a deprecated option on every build.
// It is internal to the libraries and drowns the report, so filter just that.
const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}
import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { planeSeparates, splitPlanes } from '../src/geometry/cut'
import { signedVolume } from '../src/geometry/volume'
import { IDENTITY_TRANSFORM } from '../src/geometry/types'
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
  op: 'extrude',
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
  return { id, name: id, base, transform: IDENTITY_TRANSFORM, features, cuts }
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
    scene(object(CUBE, [feature({ anchor: TOP_FACE, op: 'extrude', depth: 0.3 })]))
  )
  near('cube + circular boss', signedVolume(g), 8 + discVolume, 0.002)
  check('no NaN positions', !hasNaN(g), '')
}
{
  resetEvaluator()
  const g = solidOf(
    scene(object(CUBE, [feature({ anchor: TOP_FACE, op: 'intrude', depth: 0.3 })]))
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
          op: 'intrude',
          depth: 0.3,
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
    scene(object(CUBE, [feature({ anchor: TOP_FACE, op: 'intrude', depth: 2.5 })]))
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
          op: 'extrude',
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
          op: 'intrude',
          depth: 0.25,
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
    { ...feature({ anchor: TOP_FACE }), id: 'a', op: 'extrude', depth: 0.3 },
    {
      ...feature({ anchor: { on: 'box-face', face: 4, u: 0.3, v: -0.2 } }),
      id: 'b',
      op: 'intrude',
      depth: 0.4,
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
  const edited = scene(object(CUBE, [features[0], { ...features[1], depth: 0.5 }]))
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

// --- 8. A tilted end face reaches further than a square one ----------------
console.log('\n8. Tilt leans the created face')
{
  const plain = feature({ anchor: TOP_FACE, op: 'extrude', depth: 0.5 })
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
  const plain = feature({ anchor: TOP_FACE, op: 'extrude', depth: 0.6 })
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
    const g = solidOf(scene(object(CUBE, [{ ...slid, op: 'intrude' }])))
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

console.log(
  failures === 0
    ? '\nAll engine checks passed.\n'
    : `\n${failures} engine check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
