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
  resizeAlongAxis,
  resizeFromFar,
  scaleShape,
  scaleUniform,
} from '../src/geometry/dimensions'
import type { Axis } from '../src/geometry/dimensions'
import {
  assemblyCentre,
  objectBounds,
  scaleAssembly,
  scaleAssemblyFromFar,
} from '../src/geometry/assembly'
import { mirrorAssembly, mirrorNormal } from '../src/geometry/mirror'
import {
  CLAY_RINGS,
  bite,
  freshClay,
  isFresh,
  mold,
  pieceHeight,
  pieceSpan,
  resize,
  ringHeight,
  sculpt,
  wallBounds,
  widestRadius,
} from '../src/geometry/clay'
import type { Clay, Dab } from '../src/geometry/clay'
import { TURN_FACETS, revolveClay } from '../src/geometry/revolve'
import {
  CREASE_TURN,
  PROFILE_TOLERANCE,
  meridian,
  roundFacets,
} from '../src/geometry/meridian'
import {
  CLAY_SIDES,
  CLAY_SIDES_MAX,
  CLAY_SIDES_MIN,
  bore,
  clampSides,
  flatFactor,
  withWall,
} from '../src/geometry/clay'
import type { Bore } from '../src/geometry/clay'
import type { Pt } from '../src/geometry/curve'
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
import type { SnapSource, SnapTarget } from '../src/geometry/snap'
import {
  depthLimits,
  hostSurfaceFor,
  maxShapeSize,
  samePatch,
  slideAnchor,
} from '../src/geometry/surfaces'
import { endFaceFrame } from '../src/geometry/prism'
import { evaluateDoc, evaluateObject, resetEvaluator } from '../src/geometry/evaluate'
import { DAB_SPACING, ROUND_MIN } from '../src/store/toolStore'
import { objectMatrix, relativeTransform } from '../src/geometry/transform'
import { bezierChain, fittedHandles } from '../src/geometry/curve'
import { planeSeparates, splitPlanes } from '../src/geometry/cut'
import { signedVolume } from '../src/geometry/volume'
import {
  KERF as LASER_KERF,
  STEP as LASER_STEP,
  buildKerfWall,
  carryToBorder,
  cutPieces,
  touchesFacePoint,
  faceBasis,
  freshBlock,
  isClosedLine,
  outlineOf,
  pieceVolume,
  resample,
  ropeFollow,
  simplify,
  stations,
} from '../src/geometry/laserCut'
import type { FaceAxis as LaserFace, Pt as LaserPt } from '../src/geometry/laserCut'
import {
  DETENT,
  FRESH_MIRROR,
  clipToPart,
  images,
  mirrorLines,
  partOf,
  partPolygon,
  snapAxisAngle,
} from '../src/geometry/faceMirror'
import type { MirrorAxis } from '../src/geometry/faceMirror'
import { IDENTITY_TRANSFORM, defaultFeature } from '../src/geometry/types'
import type {
  BaseSolid,
  CutPlane,
  Doc,
  ErodeDab,
  ErodeStamp,
  Feature,
  SceneObject,
  Shape2D,
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

/** Every vertex of a geometry, in its own local space. */
function vertices(geom: BufferGeometry): Vector3[] {
  const pos = geom.getAttribute('position')
  const out: Vector3[] = []
  for (let i = 0; i < pos.count; i++) out.push(new Vector3().fromBufferAttribute(pos, i))
  return out
}

/** Largest gap between any two of a set of numbers. */
function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values)
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

// --- 4. Curved surface: the SKETCH, not the surface -------------------------
console.log('\n4. Sphere: a feature keeps the shape it was drawn as')
{
  resetEvaluator()
  const depth = 0.25
  const half = 0.25
  const g = solidOf(
    scene(
      object(SPHERE, [
        feature({
          anchor: { on: 'sphere', theta: 0, phi: Math.PI / 2 },
          depth,
          shape: { type: 'rect', w: half * 2, h: half * 2 },
        }),
      ])
    )
  )
  const vol = signedVolume(g)
  check('sphere gained material', vol > (4 / 3) * Math.PI, `volume ${vol.toFixed(4)}`)
  check('no NaN positions', !hasNaN(g), '')

  // That anchor's normal is +X, so the boss stands along X and its created face
  // is whatever sits past the halfway mark up it: the walls put vertices at
  // their two ends only, and the sphere itself never reaches x = 1.125.
  const top = vertices(g).filter((p) => p.x > 1 + depth * 0.5)
  check('boss top exists', top.length > 0, `${top.length} vertices`)

  // THE DECISIVE CHECK, and it is the inverse of the one that stood here. The
  // created end used to be trimmed against the sphere offset by `depth`, so it
  // came back moulded to the host: the boss followed the surface instead of the
  // sketch. It is a plane now, square to the normal the sketch was drawn on.
  const xs = top.map((p) => p.x)
  near('boss top sits at depth', Math.max(...xs), 1 + depth, 1e-5)
  check(
    'boss top is FLAT, not a patch of the shell',
    spread(xs) < 1e-5,
    `spread ${spread(xs).toExponential(2)}`
  )

  // And the walls run parallel. The top face is the FOOTPRINT, not a copy of it
  // fanned out by however far the ring normals diverged on the way up. Gnomonic
  // projection lands a tangent offset of `half` at R*half/hypot(R, half), so
  // that -- not `half` itself -- is what the footprint spans, and the top has to
  // match it. Sweeping along the ring's own normals grew it by (R + depth)/R,
  // half as wide again on this sphere.
  const footprint = (2 * half) / Math.hypot(1, half)
  const fanned = footprint * (1 + depth)
  near('boss top spans its own footprint', spread(top.map((p) => p.z)), footprint, 1e-4)
  near('on the other axis too', spread(top.map((p) => p.y)), footprint, 1e-4)
  check(
    'the walls did not splay',
    spread(top.map((p) => p.z)) < fanned * 0.99,
    `spans ${spread(top.map((p) => p.z)).toFixed(4)}, a fanned sweep reached ${fanned.toFixed(4)}`
  )
}
{
  resetEvaluator()
  const depth = 0.25
  const anchor = { on: 'sphere', theta: Math.PI / 3, phi: Math.PI / 2.5 } as const
  const g = solidOf(scene(object(SPHERE, [feature({ anchor, depth: -depth })])))
  const vol = signedVolume(g)
  check('sphere lost material', vol < (4 / 3) * Math.PI, `volume ${vol.toFixed(4)}`)
  check('sphere pocket did not leak', vol > 0, `volume ${vol.toFixed(4)}`)

  // A pocket's floor is as much a created face as a boss's top, and it gets the
  // same answer: flat, at `depth` below the point the sketch was drawn on.
  // Isolating it needs both bounds -- the far side of the sphere is deeper along
  // this normal than the floor is, and only the lateral one tells them apart.
  const n = new Vector3(
    Math.sin(anchor.phi) * Math.cos(anchor.theta),
    Math.cos(anchor.phi),
    Math.sin(anchor.phi) * Math.sin(anchor.theta)
  )
  const floor = vertices(g).filter((p) => {
    const along = p.dot(n)
    return along > 0.5 && along < 0.9 && p.clone().addScaledVector(n, -along).length() < 0.4
  })
  check('pocket floor exists', floor.length > 0, `${floor.length} vertices`)
  const depths = floor.map((p) => p.dot(n))
  near('pocket floor sits at depth', Math.min(...depths), 1 - depth, 1e-5)
  check(
    'pocket floor is FLAT, not a dished shell',
    spread(depths) < 1e-5,
    `spread ${spread(depths).toExponential(2)}`
  )
}

console.log('\n4b. Cylinder wall: a boss is the sketch, at every depth')
{
  // A barrel curves one way and runs straight the other, which is what makes it
  // the sharpest test of the two: the same boss has to keep the sketch's height
  // EXACTLY, and its width to the arc the footprint wraps onto.
  const R = 0.6
  const half = 0.2
  const wall: BaseSolid = { kind: 'cylinder', radius: R, height: 2 }
  const anchor = { on: 'cylinder', theta: 0, y: 0 } as const

  // theta 0 puts the wall normal on +X, so the boss stands along X and the
  // barrel itself never reaches past R.
  const bossAt = (depth: number) => {
    resetEvaluator()
    const g = solidOf(
      scene(
        object(wall, [
          feature({ anchor, depth, shape: { type: 'rect', w: half * 2, h: half * 2 } }),
        ])
      )
    )
    return vertices(g).filter((p) => p.x > R + depth * 0.5)
  }

  const shallow = bossAt(0.3)
  const deep = bossAt(0.9)
  check('boss tops exist', shallow.length > 0 && deep.length > 0, `${shallow.length}, ${deep.length}`)
  near('a shallow boss tops out at its depth', Math.max(...shallow.map((p) => p.x)), R + 0.3, 1e-5)
  near('a deep one at its own', Math.max(...deep.map((p) => p.x)), R + 0.9, 1e-5)
  check(
    'both tops are FLAT',
    spread(shallow.map((p) => p.x)) < 1e-5 && spread(deep.map((p) => p.x)) < 1e-5,
    `${spread(shallow.map((p) => p.x)).toExponential(2)}, ${spread(deep.map((p) => p.x)).toExponential(2)}`
  )

  // Along the barrel there is no curvature to follow, so this one is exact.
  near('the sketch keeps its height along the axis', spread(shallow.map((p) => p.y)), half * 2, 1e-6)
  // Across it, the footprint is the outline wrapped on -- u is arc length round
  // the barrel -- so the chord it spans is what the boss stands on and keeps.
  const chord = 2 * R * Math.sin(half / R)
  near('and its width across the wrap', spread(shallow.map((p) => p.z)), chord, 1e-4)

  // THE POINT OF THE WHOLE FIX. Sweeping along the ring normals scaled the boss
  // by (R + depth)/R on the way up, so tripling the depth widened it by half
  // again. Along one axis, depth buys height and nothing else.
  near(
    'and three times the depth does not widen it',
    spread(deep.map((p) => p.z)),
    spread(shallow.map((p) => p.z)),
    1e-6
  )
  check(
    'where a fanned sweep would have',
    spread(deep.map((p) => p.z)) < (chord * (R + 0.9)) / R * 0.99,
    `${spread(deep.map((p) => p.z)).toFixed(4)} against ${((chord * (R + 0.9)) / R).toFixed(4)}`
  )
}

console.log('\n4c. A pocket can be driven clean through the solid')
{
  /**
   * Is a point inside this solid? By ray parity, along a skew direction, so an
   * axis-aligned face never decides it -- the same trick `sameSolid` uses, and
   * for the same reason: nothing here is allowed to depend on how either mesh
   * happened to be tessellated.
   */
  const encloses = (g: BufferGeometry) => {
    const mesh = new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }))
    mesh.updateMatrixWorld(true)
    const probe = new Raycaster()
    const along = new Vector3(0.37139068, 0.55708601, 0.74278135)
    return (p: Vector3) => {
      probe.set(p, along)
      return probe.intersectObject(mesh, false).length % 2 === 1
    }
  }

  /**
   * Run the depth slider to its inward end and check the solid is PIERCED:
   * every point that the uncut solid held on the line of the cut has to be gone.
   *
   * Taken from the far end of `depthLimits` rather than from a number written
   * here, because the claim is about the control the user actually has. A curved
   * host used to fence a pocket off at eight tenths of its radius, so no depth
   * the slider could reach came out the other side.
   */
  const piercesThrough = (label: string, base: BaseSolid, anchor: SurfaceAnchor, shape: Shape2D) => {
    const host = hostSurfaceFor(base, anchor)
    const { origin, normal } = host.frame(anchor)
    const depth = depthLimits(host, anchor).in

    resetEvaluator()
    const whole = solidOf(scene(object(base)))
    const held = encloses(whole)
    resetEvaluator()
    const bored = solidOf(scene(object(base, [feature({ anchor, shape, depth: -depth })])))
    const holds = encloses(bored)

    // Sampled down the middle of the cut, and kept only where there was
    // material to begin with -- past the back of the solid every host is
    // trivially empty, and counting that would prove nothing.
    const line: Vector3[] = []
    for (let i = 1; i < 80; i++) {
      line.push(origin.clone().addScaledVector(normal, (-i / 80) * depth))
    }
    const crossed = line.filter(held)
    const left = crossed.filter(holds)
    check(`${label}: the cut has a solid to cross`, crossed.length > 10, `${crossed.length} samples`)
    check(`${label}: and nothing of it is left on the line`, left.length === 0, `${left.length} still inside`)
    check(`${label}: the solid survives being bored`, signedVolume(bored) > 0, `volume ${signedVolume(bored).toFixed(4)}`)
    check(`${label}: and lost material doing it`, signedVolume(bored) < signedVolume(whole), `${signedVolume(bored).toFixed(4)} of ${signedVolume(whole).toFixed(4)}`)
  }

  piercesThrough(
    'a ball',
    { kind: 'sphere', radius: 1 },
    { on: 'sphere', theta: 0, phi: Math.PI / 2 },
    { type: 'circle', r: 0.25 }
  )
  piercesThrough(
    'a barrel',
    { kind: 'cylinder', radius: 0.6, height: 2 },
    { on: 'cylinder', theta: 0, y: 0 },
    { type: 'circle', r: 0.2 }
  )
  piercesThrough(
    'a bean',
    { kind: 'capsule', radius: 0.5, height: 1 },
    { on: 'capsule', theta: 0, phi: Math.PI / 2 },
    { type: 'circle', r: 0.2 }
  )
  piercesThrough(
    'a cone wall',
    { kind: 'cone', radius: 0.8, height: 1.6 },
    { on: 'cone', theta: 0, t: 0.4 },
    { type: 'circle', r: 0.2 }
  )
  // The flat case that was broken too, and differently: the bound was the box's
  // THINNEST side whichever face you drew on, so a pocket on the end of a slab
  // stopped nine tenths of a unit into the four it had to cross.
  piercesThrough(
    'a slab end to end',
    { kind: 'box', size: [4, 0.6, 4] },
    { on: 'box-face', face: 0, u: 0, v: 0 },
    { type: 'circle', r: 0.2 }
  )
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
  // The left-drag reading of the same arrow: the face under it moves by the
  // travel and the face opposite does not move at all. Written about a centred
  // origin, that is half the growth and a slide of the other half -- `shift`
  // is that slide, in the solid's own frame, and the two faces are where the
  // origin plus and minus the half-extent land.
  const box: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const pulled = resizeFromFar(box, 0, 0.5)
  near('a box side grows by the travel alone', dimOf(pulled.base, 'x'), 2.5, 1e-9)
  near('and the origin slides half of it', pulled.shift, 0.25, 1e-9)
  near('so the near face moved the whole travel', pulled.shift + dimOf(pulled.base, 'x') / 2, 1.5, 1e-9)
  near('and the far face not at all', pulled.shift - dimOf(pulled.base, 'x') / 2, -1, 1e-9)
  check(
    'with the other two sides untouched',
    dimOf(pulled.base, 'y') === 2 && dimOf(pulled.base, 'z') === 2,
    `${dimOf(pulled.base, 'y')} and ${dimOf(pulled.base, 'z')}`
  )

  // The same slide on every primitive, whatever the field: a radius is the
  // half-extent and grows by half the travel, a height is a full extent and
  // grows by all of it, and either way the origin moves a quarter.
  const cyl: BaseSolid = { kind: 'cylinder', radius: 0.8, height: 2 }
  const fatter = resizeFromFar(cyl, 0, 0.5)
  near('a radius grows by half the travel', radiusOf(fatter.base), 1.05, 1e-9)
  near('with the same slide', fatter.shift, 0.25, 1e-9)
  const taller = resizeFromFar(cyl, 1, 0.5)
  near('a height grows by the travel', heightOf(taller.base), 2.5, 1e-9)
  near('with the same slide again', taller.shift, 0.25, 1e-9)

  // Pushed back through, it shrinks from the same end.
  const pushed = resizeFromFar(box, 0, -0.5)
  near('pushed in, the near face comes back', dimOf(pushed.base, 'x'), 1.5, 1e-9)
  near('sliding the other way', pushed.shift, -0.25, 1e-9)
  near('and the far face still has not moved', pushed.shift - dimOf(pushed.base, 'x') / 2, -1, 1e-9)

  // Clamped, the slide follows the growth that actually happened rather than
  // the travel asked for, so a solid pinned at its ceiling stops moving too --
  // otherwise a resize would quietly turn into a move once it hit the limit.
  // Twice the pull the centred check uses, since only half of it is growth.
  const pinned = resizeFromFar(box, 0, 80)
  near('at the ceiling the size stops', dimOf(pinned.base, 'x'), MAX_SIZE, 1e-9)
  near('and so does the slide', pinned.shift, (MAX_SIZE - 2) / 2, 1e-9)
  near('holding the far face', pinned.shift - dimOf(pinned.base, 'x') / 2, -1, 1e-9)
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

/** One corner of the solid being dragged: the source kind that seeks the
 *  scene's corners, edges and faces, and never its centres. */
const corner = (x: number, y: number, z: number): SnapSource => ({
  point: new Vector3(x, y, z),
  kind: 'corner',
})

{
  // A lone corner to seek, and a mover whose corner is a quarter-unit short of
  // it along X and dead level in Y and Z.
  const target: SnapTarget[] = [
    { kind: 'vertex', objectId: 'other', point: new Vector3(1, 0, 0) },
  ]
  const axisX = new Vector3(1, 0, 0)

  const hit = snapAlongAxis([corner(0.9, 0, 0)], target, axisX, 0.18)
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
  const off = snapAlongAxis([corner(0.9, 0.05, 0)], target, axisX, 0.18)
  check('a corner off the axis is NOT caught', off === null, off ? 'wrongly caught' : 'ignored')

  // Out of range along the axis, in line but too far to reach.
  const far = snapAlongAxis([corner(0.5, 0, 0)], target, axisX, 0.18)
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
  const hit = snapAlongAxis([corner(0.88, 3, -4)], plane, new Vector3(1, 0, 0), 0.18)
  check('a face is caught from anywhere along it', hit !== null, hit ? 'caught' : 'missed')
  if (hit) near('at the plane exactly', hit.point.x, 1, 1e-9)

  // Running parallel to a plane, there is no offset that reaches it. An
  // implementation that divided anyway would return an infinity here.
  const parallel = snapAlongAxis([corner(0.88, 0, 0)], plane, new Vector3(0, 1, 0), 0.18)
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
  const hit = snapAlongAxis([corner(0.9, 0.3, 0)], edge, new Vector3(1, 0, 0), 0.18)
  check('an edge crossing the axis is caught', hit !== null, hit ? 'caught' : 'missed')
  if (hit) {
    near('at the edge', hit.point.x, 1, 1e-9)
    near('without sliding along the edge', hit.point.y, 0.3, 1e-9)
  }

  // Past the end of the segment: an edge attracts along its own length only,
  // or every edge in the scene would behave like an infinite line.
  const past = snapAlongAxis([corner(0.9, 4, 0)], edge, new Vector3(1, 0, 0), 0.18)
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

{
  // The bound is a question about the FACE, not about the solid. It used to be
  // asked of the base alone -- a radius times nine tenths, or half the smallest
  // side -- so a sketch stopped short of every rim whether or not anything was
  // in the way, and a broad face on a thin solid was bounded by the thinness.
  const slab: BaseSolid = { kind: 'box', size: [20, 2, 20] }
  const top = maxShapeSize(slab, { on: 'box-face', face: 2, u: 0, v: 0 })
  const side = maxShapeSize(slab, { on: 'box-face', face: 0, u: 0, v: 0 })
  near('a slab s broad top holds a sketch out to its own edge', top, 10, 1e-9)
  near('while its thin side is still bounded by the thinness', side, 1, 1e-9)
  check('and the old whole-solid answer was the thin one', side < top, `${side} vs ${top}`)
  near('which is what a caller with no face in mind still gets', maxShapeSize(slab), 1, 1e-9)

  // The cap is a 48-gon, so its inradius -- the largest circle centred on it --
  // is a fifth of a percent under the nominal radius rather than nine tenths
  // of it. That fifth of a percent is the tessellation, not a margin.
  const drum: BaseSolid = { kind: 'cylinder', radius: 5, height: 16.77 }
  const cap = maxShapeSize(drum, { on: 'planar-face', face: 0, u: 0, v: 0 })
  near('a cylinder cap reaches its rim', cap, 5 * Math.cos(Math.PI / 48), 1e-9)
  check('which is where the old bound of 4.5 could not reach', cap > 4.98, `${cap}`)

  // The wall runs out in the direction the CAP does not: up and down. The old
  // bound never looked at the height at all, so a sketch on the wall of a short
  // drum could be grown until it hung off both rims.
  const wall = maxShapeSize(drum, { on: 'cylinder', theta: 0, y: 0 })
  near('a tall wall is bounded by half its circumference', wall, (Math.PI * 5) / 2, 1e-9)
  const coin: BaseSolid = { kind: 'cylinder', radius: 5, height: 1 }
  near(
    'and a short one by its own height',
    maxShapeSize(coin, { on: 'cylinder', theta: 0, y: 0 }),
    0.5,
    1e-9
  )

  // A sphere has no rim to reach, so its bound is the projection's rather than
  // an edge's -- and still nearly twice what the flat nine tenths allowed.
  const ball: BaseSolid = { kind: 'sphere', radius: 5 }
  const cover = maxShapeSize(ball, { on: 'sphere', theta: 0, phi: Math.PI / 2 })
  near('a sphere is bounded by a sixty degree cap', cover, 5 * Math.tan(Math.PI / 3), 1e-9)
  check('which is more room than the old bound gave', cover > 5 * 0.9, `${cover}`)
}

{
  // The bound and the seat have to agree. `clampAnchor` is what keeps a sketch
  // on its face, and a panel free to grow one past what the seat will hold is
  // exactly how a sketch ends up shoved back to the middle of a face the moment
  // it is touched -- so a shape AT the bound must still seat where it is.
  const drum: BaseSolid = { kind: 'cylinder', radius: 5, height: 16.77 }
  const anchor: SurfaceAnchor = { on: 'planar-face', face: 0, u: 0, v: 0 }
  const at = maxShapeSize(drum, anchor)
  const seated = hostSurfaceFor(drum, anchor).clampAnchor(anchor, { type: 'circle', r: at })
  check(
    'a sketch grown to the bound still seats on the cap',
    seated.on === 'planar-face' && Math.hypot(seated.u, seated.v) < 1e-6,
    JSON.stringify(seated)
  )

  const slab: BaseSolid = { kind: 'box', size: [20, 2, 20] }
  const top: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }
  const wide = maxShapeSize(slab, top)
  const onTop = hostSurfaceFor(slab, top).clampAnchor(top, { type: 'circle', r: wide })
  check(
    'and one grown to the slab s top bound seats on the top',
    onTop.on === 'box-face' && Math.abs(onTop.u) < 1e-9 && Math.abs(onTop.v) < 1e-9,
    JSON.stringify(onTop)
  )
}

{
  // A bound is only worth raising if the solid at it still BUILDS. Reaching the
  // rim is where the boolean has least room -- the boss's wall lands within a
  // fifth of a percent of the drum's own -- so this is the case that would fall
  // over if the old tenth had been load-bearing rather than merely cautious.
  resetEvaluator()
  const drum: BaseSolid = { kind: 'cylinder', radius: 5, height: 4 }
  const cap: SurfaceAnchor = { on: 'planar-face', face: 0, u: 0, v: 0 }
  const flush = maxShapeSize(drum, cap)
  const doc = scene(
    object(drum, [feature({ anchor: cap, shape: { type: 'circle', r: flush }, depth: 1 })])
  )
  const result = evaluateDoc(doc)
  check('a boss grown flush to the rim builds', result.failed.length === 0, `${result.failed}`)
  const grown = signedVolume(result.objects[0].geometry)
  const bare = signedVolume(solidOf(scene(object(drum))))
  // A 48-gon of the cap's own inradius, one unit tall, sitting on the drum.
  const disc = 0.5 * 48 * flush * flush * Math.sin((2 * Math.PI) / 48)
  near('and adds the whole disc it drew', grown - bare, disc, 0.02)

  // The other end of the same worry: a rectangle grown until its wall is
  // EXACTLY coplanar with the box's, which is the input a boolean likes least.
  resetEvaluator()
  const bar: BaseSolid = { kind: 'box', size: [4, 1, 4] }
  const face: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }
  const half = maxShapeSize(bar, face)
  const flat = evaluateDoc(
    scene(
      object(bar, [
        feature({ anchor: face, shape: { type: 'rect', w: half * 2, h: half * 2 }, depth: 0.5 }),
      ])
    )
  )
  check('a boss with walls flush to the box builds too', flat.failed.length === 0, `${flat.failed}`)
  near(
    'and stands its full height on it',
    signedVolume(flat.objects[0].geometry),
    4 * 1 * 4 + half * 2 * half * 2 * 0.5,
    0.02
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
    // The one-sided arrow on an assembly: a scale about the centre, and then
    // the slide that puts the skin opposite the arrow back where it was. The
    // object is TURNED, so the slide has to run along its own axis and not the
    // world's: a quarter turn about Y sends local +X down world -Z, so the far
    // skin on local X is the world +Z face, and that is the one that holds.
    const turned: SceneObject = {
      ...object(cube, [], [], 'held'),
      transform: { position: [1, 2, 3], rotation: [0, Math.PI / 2, 0] },
    }
    const before = objectBounds(turned)
    const held = scaleAssemblyFromFar(turned, 2, 0)
    const after = objectBounds(held)
    near('the far skin has not moved', after.max.z, before.max.z, 1e-9)
    // Doubled, so the near skin moves by the whole extent it had.
    near('and the near one moved by the whole growth', after.min.z, before.min.z - 2, 1e-9)
    near('the other axes grew about the centre', after.min.y, before.min.y - 1, 1e-9)
    near('on both sides', after.max.y, before.max.y + 1, 1e-9)

    // And on a merge whose box is NOT centred on the assembly centre -- the
    // mean of the origins -- the far skin still holds, because the slide is
    // measured from that skin's own distance to the centre rather than from
    // the half-extent. Host 2 wide at the origin, a part 6 wide at x = 4: the
    // box runs -1 to 7, its middle at 3, the centre at 2.
    const lopsided: SceneObject = {
      ...object(cube, [], [], 'lopsided'),
      parts: [
        {
          ...object({ kind: 'box', size: [6, 2, 2] }, [], [], 'wing'),
          transform: { position: [4, 0, 0], rotation: [0, 0, 0] },
        },
      ],
    }
    const wasBox = objectBounds(lopsided)
    near('the lopsided merge starts where it should', wasBox.min.x, -1, 1e-9)
    near('and reaches where it should', wasBox.max.x, 7, 1e-9)
    const grown = objectBounds(scaleAssemblyFromFar(lopsided, 2, 0))
    near('its far skin holds under a one-sided scale', grown.min.x, -1, 1e-9)
    near('and its near skin moves by its whole reach', grown.max.x, 15, 1e-9)

    // Clamped, the slide stops with the scale: a factor past the ceiling
    // leaves the far skin exactly where a factor AT the ceiling would.
    const capped = objectBounds(scaleAssemblyFromFar(turned, 1e6, 0))
    near('pinned at the ceiling, the far skin still holds', capped.max.z, before.max.z, 1e-9)
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

  // AN UNSTAMPED DAB RUNS LAST, after the cuts and the erasers -- which is what
  // every dab meant before `ErodeStamp` existed, and what one written by hand
  // still means. A stamped dab runs where it was laid instead; that is the
  // section below.
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

// --- A finished melt is finished --------------------------------------------
/**
 * A stamped dab runs WHERE IT WAS LAID -- see `ErodeStamp` -- so nothing added
 * to the object afterwards is melted by strokes that predate it.
 *
 * The bug this fixes was one stage running at a fixed point in the chain: the
 * melting went last no matter what, so a solid merged in afterwards was melted
 * where the old dabs happened to reach, and a boss extruded out of a torched
 * face came out already torched -- flattened, in the worst case, right back to
 * the face it grew from.
 *
 * MEASURED BY HEIGHT where the thing under test stands proud of the melt (a
 * boss, a merged cap): those sit inside the dab sphere, so if the melt reaches
 * them the top comes down. Measured by VOLUME where it does not -- a crater in
 * a wide flat face leaves the corners untouched, and max-Y cannot see it.
 */
console.log('\nA melt is done when it is done')
{
  resetEvaluator()
  const cube: BaseSolid = { kind: 'box', size: [1, 1, 1] }
  const ZERO: ErodeStamp = { parts: 0, features: 0, cuts: 0, erased: 0 }
  const at = (over: Partial<ErodeStamp>): ErodeStamp => ({ ...ZERO, ...over })

  /** A stroke on the top face. `null` leaves it unstamped: the old behaviour. */
  const stroke = (stamp: ErodeStamp | null): ErodeDab[] =>
    Array.from({ length: 6 }, (): ErodeDab => ({
      at: [0, 0.5, 0],
      radius: 0.5,
      heat: 1,
      smooth: 0.5,
      ...(stamp ? { stamp } : {}),
    }))

  const melted = (over: Partial<SceneObject>, id: string): SceneObject => ({
    ...object(cube, [], [], id),
    ...over,
  })

  const topOf = (o: SceneObject): number => {
    const { geometry } = evaluateObject(o)
    const pos = geometry.getAttribute('position')
    let top = -Infinity
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i))
    geometry.dispose()
    return top
  }
  const volumeOf = (o: SceneObject): number => {
    const { geometry } = evaluateObject(o)
    const v = Math.abs(signedVolume(geometry))
    geometry.dispose()
    return v
  }

  /** A boss standing 0.3 proud of the top face. */
  const boss: Feature = {
    ...defaultFeature({ on: 'box-face', face: 2, u: 0, v: 0 }, { type: 'circle', r: 0.15 }),
    id: 'boss',
    depth: 0.3,
  }
  /** A cap standing on the top face, entirely inside the dab sphere. */
  const cap: SceneObject = {
    ...object({ kind: 'box', size: [0.3, 0.3, 0.3] }, [], [], 'cap'),
    transform: { position: [0, 0.6, 0], rotation: [0, 0, 0] },
  }

  // The stroke has to actually do something, or every claim below is vacuous.
  {
    const bitten = volumeOf(melted({ erosion: stroke(ZERO) }, 'bite'))
    check('the torch takes a bite out of a cube', bitten < 0.99, `${bitten.toFixed(4)} of 1`)
  }

  // Nothing added afterwards means nothing to reorder: one run, and the same
  // mesh the evaluator built before stamps existed. This is what keeps a stamp
  // from being a change to every torched object in the scene.
  {
    const vertsOf = (o: SceneObject): Float32Array => {
      const { geometry } = evaluateObject(o)
      const copy = Float32Array.from(geometry.getAttribute('position').array as Float32Array)
      geometry.dispose()
      return copy
    }
    const stamped = vertsOf(melted({ erosion: stroke(ZERO) }, 'same1'))
    const bare = vertsOf(melted({ erosion: stroke(null) }, 'same2'))
    check(
      'a stamp changes nothing when nothing came after it',
      stamped.length === bare.length && stamped.every((v, i) => v === bare[i]),
      `${stamped.length} floats`
    )
  }

  // MERGE. The cap stands 0.75 high and sits wholly inside the dab sphere.
  {
    near(
      'a solid merged in after the melt keeps its full height',
      topOf(melted({ erosion: stroke(ZERO), parts: [cap] }, 'merge1')),
      0.75,
      1e-6
    )
    near(
      'which is the height it has with no melt at all',
      topOf(melted({ parts: [cap] }, 'merge2')),
      0.75,
      1e-6
    )
    // The other order is still allowed: a stroke laid against the assembly is
    // entitled to reach across the seam.
    const after = topOf(melted({ parts: [cap], erosion: stroke(at({ parts: 1 })) }, 'merge3'))
    check('while a stroke laid AFTER the merge does melt the part', after < 0.74, after.toFixed(4))
    // And the old behaviour, on demand: this is the bug itself.
    const last = topOf(melted({ parts: [cap], erosion: stroke(null) }, 'merge4'))
    check('running last -- the old rule -- melted it', last < 0.74, last.toFixed(4))
  }

  // EXTRUDE. The boss reaches 0.8, and the dab sphere reaches 1.0.
  {
    near(
      'a boss grown after the melt reaches its full depth',
      topOf(melted({ features: [boss], erosion: stroke(ZERO) }, 'boss1')),
      0.8,
      1e-6
    )
    const before = topOf(melted({ features: [boss], erosion: stroke(at({ features: 1 })) }, 'boss2'))
    check(
      'while one already standing when the torch came out is melted',
      before < 0.79,
      before.toFixed(4)
    )
    const last = topOf(melted({ features: [boss], erosion: stroke(null) }, 'boss3'))
    check('running last flattened the boss back onto its face', last < 0.51, last.toFixed(4))
  }

  // ORDER. Melt, grow a boss, melt again: the second stroke sees the boss and
  // the first does not. Two runs of one list, replayed in different places.
  {
    const twice = topOf(
      melted(
        { features: [boss], erosion: [...stroke(ZERO), ...stroke(at({ features: 1 }))] },
        'twice'
      )
    )
    check('melt, extrude, melt again: the second stroke reaches the boss', twice < 0.79, twice.toFixed(4))
  }

  // CUTS AND ERASERS follow the same rule. The melt sits above y=0.25, so a cut
  // taken afterwards carries all of it away and leaves the plain half-cube.
  {
    const half: CutPlane = { id: 'c1', origin: [0, 0.25, 0], normal: [0, 1, 0], side: -1 }
    near(
      'a cut taken after the melt leaves a clean plane',
      topOf(melted({ cuts: [half], erosion: stroke(ZERO) }, 'cut1')),
      0.25,
      1e-6
    )
    near(
      'and takes the melt with it',
      volumeOf(melted({ cuts: [half], erosion: stroke(ZERO) }, 'cut2')),
      0.75,
      1e-4
    )
    const cutFirst = volumeOf(melted({ cuts: [half], erosion: stroke(at({ cuts: 1 })) }, 'cut3'))
    check(
      'while a cut face that was there first melts',
      cutFirst < 0.749,
      `${cutFirst.toFixed(4)} of 0.75`
    )

    const slab: SceneObject = {
      ...object({ kind: 'box', size: [2, 0.3, 2] }, [], [], 'slab'),
      transform: { position: [0, 0.5, 0], rotation: [0, 0, 0] },
    }
    const eraserOnly = volumeOf(melted({ erased: [slab] }, 'hole0'))
    const meltFirst = volumeOf(melted({ erased: [slab], erosion: stroke(ZERO) }, 'hole1'))
    const holeFirst = volumeOf(
      melted({ erased: [slab], erosion: stroke(at({ erased: 1 })) }, 'hole2')
    )
    check(
      'a melt that ran before the hole is erased away with it',
      eraserOnly - meltFirst < 0.02,
      `${meltFirst.toFixed(4)} of ${eraserOnly.toFixed(4)}`
    )
    check(
      'while one that ran after eats the floor the eraser left',
      holeFirst < meltFirst - 0.02,
      `${holeFirst.toFixed(4)} against ${meltFirst.toFixed(4)}`
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

// --- The Smoother -----------------------------------------------------------
console.log('\nThe Smoother rounds a corner to a radius and then stops')
{
  resetEvaluator()
  const cube: BaseSolid = { kind: 'box', size: [2, 2, 2] }
  const rounding = (over: Partial<ErodeDab> = {}): ErodeDab => ({
    at: [1, 1, 1],
    radius: 0.6,
    heat: 0,
    smooth: 0,
    round: 1,
    ...over,
  })
  const rounded = (dabs: ErodeDab[], id: string) =>
    evaluateObject({ ...object(cube, [], [], id), erosion: dabs })
  const passes = (n: number, d: ErodeDab): ErodeDab[] =>
    Array.from({ length: n }, () => ({ ...d }))

  /** How far the far corner still reaches along its own diagonal. */
  const cornerReach = (geom: BufferGeometry): number => {
    const pos = geom.getAttribute('position')
    const v = new Vector3()
    const diagonal = new Vector3(1, 1, 1).normalize()
    let far = -Infinity
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      if (v.x < 0.2 || v.y < 0.2 || v.z < 0.2) continue
      far = Math.max(far, v.dot(diagonal))
    }
    return far
  }
  const bare = cornerReach(rounded([], 'round-bare').geometry)
  /** How much of the corner one set of passes has taken off. */
  const taken = (dabs: ErodeDab[], id: string) =>
    bare - cornerReach(rounded(dabs, id).geometry)

  // ONE PASS TAKES THE CORNER OFF, and takes only the corner off.
  {
    const one = rounded([rounding()], 'round-one')
    check('a rounding dab does not produce a NaN', !hasNaN(one.geometry), '')
    check('one pass eases the corner back', taken([rounding()], 'round-one2') > 0, '')
    const volume = signedVolume(one.geometry)
    check('it takes material away, since the corner was convex', volume < 8, `${volume.toFixed(5)}`)
    check('and hardly any of it', volume > 7.99, `${volume.toFixed(5)}`)
  }

  // IT STOPS, which is the whole difference between this tool and Smoothing on
  // the other two. Every dab is the same dab, so an accumulating brush would go
  // on eating for as long as it was held -- the torch's own check a few hundred
  // lines above asserts exactly that of itself. This one asserts the opposite.
  {
    const at20 = taken(passes(20, rounding()), 'round-20')
    const at40 = taken(passes(40, rounding()), 'round-40')
    const at80 = taken(passes(80, rounding()), 'round-80')
    check('twenty passes have got somewhere', at20 > 0.2, `${at20.toFixed(4)}`)
    check('forty are no further along', Math.abs(at40 - at20) < 0.01, `${at20.toFixed(4)} then ${at40.toFixed(4)}`)
    near('and eighty land where forty did', at80, at40, 5e-3)
  }

  // A FLAT FACE IS UNTOUCHED, and not approximately: a vertex on a plane has
  // its neighbours in that plane, so the reading the tool acts on is zero to
  // the float and nothing moves at all. It is what lets a user drag sloppily
  // across a panel and change only the edge they were aiming at.
  {
    const flat = rounded(passes(40, rounding({ at: [0, 1, 0], radius: 0.5 })), 'round-flat')
    check('forty passes over the middle of a face move nothing', !hasNaN(flat.geometry), '')
    // To within float SUMMATION, not to the bit: the refinement has split the
    // triangles under the brush -- which is exactly shape-preserving, every
    // midpoint landing on the straight edge it came from -- so the same solid
    // is being added up in more pieces and in a different order. The positions
    // are the check that means anything, and they are exact.
    near('the solid is the same solid', signedVolume(flat.geometry), 8, 1e-9)
    const pos = flat.geometry.getAttribute('position')
    let highest = -Infinity
    let lowest = Infinity
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) > 0.4 || Math.abs(pos.getZ(i)) > 0.4) continue
      if (pos.getY(i) < 0) continue
      highest = Math.max(highest, pos.getY(i))
      lowest = Math.min(lowest, pos.getY(i))
    }
    check('and the face is still flat at exactly its own height', highest === 1 && lowest === 1, `${lowest} to ${highest}`)
  }

  // STRENGTH IS A DESTINATION AND IT IS A LENGTH, which is the claim the panel
  // makes and the one thing here worth measuring against arithmetic rather than
  // against the setting below it: what a stroke leaves is a fillet whose radius
  // is Strength times the brush.
  //
  // Measured on an EDGE rather than on the corner above, because an edge is
  // what a fillet is defined on -- a 90-degree edge filleted at radius T has
  // its apex cut back by T times root-two-minus-one, so the radius can be read
  // straight back out of the geometry. The three-face corner is the harder
  // shape and the one the checks above use for convergence; it is the wrong
  // shape to read a radius off, since three arcs meet there.
  //
  // The reading is not exact and cannot be: it comes from a discrete curvature
  // over a fan of triangles, and ROUND_GAIN is the constant that makes it come
  // out right. What is left over depends on the brush against the OBJECT rather
  // than on either alone -- the coarse mesh outside the patch has more say the
  // smaller the patch is -- and over everything this app offers that lands
  // between 0.89 and 1.36 of the radius asked for. See ROUND_GAIN. The band
  // here is wide enough for all of that and nowhere near wide enough to survive
  // the calibration going missing, which is the regression worth catching.
  {
    /** The fillet radius on the +X+Y edge, read back off the geometry. */
    const filletOn = (dabs: ErodeDab[], id: string): number => {
      const pos = rounded(dabs, id).geometry.getAttribute('position')
      const v = new Vector3()
      const across = new Vector3(1, 1, 0).normalize()
      let far = -Infinity
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i)
        if (Math.abs(v.z) > 0.05 || v.x < 0.2 || v.y < 0.2) continue
        far = Math.max(far, v.dot(across))
      }
      return (Math.SQRT2 - far) / (Math.SQRT2 - 1)
    }

    let last = 0
    for (const round of [ROUND_MIN, 0.5, 1]) {
      const radius = 0.3
      const got = filletOn(passes(80, rounding({ at: [1, 1, 0], radius, round })), `dial-${round}`)
      check(`strength ${round} leaves more than the setting below it`, got > last, `${got.toFixed(4)}`)
      // The top of the dial is the one place the promise gives way, and it
      // gives way to the BRUSH: a fillet of radius T needs about T of surface
      // either side of the corner to sit on, so a round approaching the size of
      // the sphere that is making it runs out of room. Checked only where there
      // is room, which is the whole of the dial below the top.
      if (round < 1) {
        near(`and it is about ${round} of the brush across`, got, round * radius, round * radius * 0.4)
      }
      last = got
    }
  }

  // NOTHING OUTSIDE THE BRUSH MOVES, which is the promise the whole file is
  // built on and the one a tool that spreads its own work could most easily
  // break: rounding a corner makes its neighbours the sharpest thing left, so
  // the round does creep -- as far as the rim of the sphere and no further.
  {
    const geom = rounded(passes(60, rounding()), 'round-far').geometry
    const pos = geom.getAttribute('position')
    let farthest = -Infinity
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < -0.9) farthest = Math.max(farthest, pos.getY(i))
    }
    check('the far face is bit-for-bit where it was', farthest === -1, `${farthest}`)
  }

  // A THIN PLATE'S RIM IS NOT ROUNDED THROUGH ITSELF. Round both sides of a rim
  // thinner than twice the target and the two rounds are aimed at the same
  // material; left alone they arrive in the same place and pass through each
  // other, and a bracket comes out inside out. See ROUND_WALL, which spends a
  // share of what is left rather than a threshold, so the gap closes
  // geometrically and never reaches nothing.
  {
    const plate: BaseSolid = { kind: 'box', size: [2, 0.06, 2] }
    const rim = (n: number, id: string) =>
      evaluateObject({
        ...object(plate, [], [], id),
        erosion: passes(n, rounding({ at: [1, 0, 0], radius: 0.5 })),
      }).geometry
    const bareVolume = signedVolume(evaluateObject(object(plate, [], [], 'plate-bare')).geometry)
    const many = rim(100, 'plate-100')
    check('a hundred passes along a thin rim produce no NaN', !hasNaN(many), '')
    const volume = signedVolume(many)
    check('the plate keeps its volume rather than turning itself inside out', volume > bareVolume * 0.99, `${volume.toFixed(6)} of ${bareVolume.toFixed(6)}`)
    near('and forty passes have already settled there', signedVolume(rim(40, 'plate-40')), volume, 1e-6)
  }

  // ORDER MATTERS ACROSS ALL THREE BRUSHES, which is why they share one list
  // rather than having one each. A groove melted across a rounded edge is not
  // the surface a rounded edge melted across a groove is, and the only thing
  // that says which happened is which dab was laid second.
  {
    const round = rounding({ at: [1, 1, 0], radius: 0.5 })
    const melt: ErodeDab = { at: [1, 1, 0], radius: 0.5, heat: 1, smooth: 0.7 }
    const roundThenMelt = signedVolume(rounded([...passes(6, round), ...passes(6, melt)], 'order-rm').geometry)
    const meltThenRound = signedVolume(rounded([...passes(6, melt), ...passes(6, round)], 'order-mr').geometry)
    check(
      'rounding then melting is not melting then rounding',
      Math.abs(roundThenMelt - meltThenRound) > 1e-4,
      `${roundThenMelt.toFixed(5)} against ${meltThenRound.toFixed(5)}`
    )
  }
}

console.log('\nThe erode brush survives curved surfaces and merged assemblies')
{
  resetEvaluator()


  /**
   * The shortest edge anywhere in the mesh, ignoring the ones that were already
   * zero.
   *
   * `CapsuleGeometry` arrives with one degenerate triangle per radial segment
   * at each of its poles -- an edge of 3e-18 -- and that is three.js's
   * business, not the torch's. What is being asserted is that erosion does not CLOSE a mesh up,
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

  // THIN OBJECTS, where the brush is wider than the thing it is held against.
  //
  // Every case above burns a hole through the MIDDLE of a wall, and that is
  // the one case a thin object hardly ever presents: a centimetre brush on a
  // three-centimetre panel reaches the panel's edge almost as soon as it is
  // put down, a chip smaller than the brush is all edge, and a rod is a wall
  // with no middle at all. What used to happen there, measured: a press at the
  // edge put seven percent of the panel's volume BACK in one dab, a drag along
  // it folded the surface through itself, a chip one and a half brushes wide
  // came out inside out with its volume reading negative, and a rod was cut in
  // two and then zipped back into a rod at fourteen times the triangle count.
  // See `breakThrough` for what went wrong in each.
  //
  // What is asserted is the same for all of them: the object stays closed, the
  // surface is nowhere folded through itself, nothing strays out of the solid
  // it started as, and THE TORCH NEVER PUTS MATERIAL BACK -- the volume after
  // every dab is no more than the volume before it. Each run is replayed
  // prefix by prefix for that last one, which is also how the live stroke
  // arrives at the mesh.
  {
    const BRUSH = 0.1
    const THIN: BaseSolid = { kind: 'box', size: [0.3, 0.3, 0.02] }
    const stroke = (n: number, p: Vec3): ErodeDab[] =>
      Array.from({ length: n }, () => ({ at: p, radius: BRUSH, heat: 1, smooth: 0.7 }))

    /** Where the line along axis `k` through (p, q) in the other two meets the
     *  surface, and whether each meeting is an entry or an exit -- `throughZ`
     *  for any axis. */
    const along = (geom: BufferGeometry, k: 0 | 1 | 2, p: number, q: number): [number, number][] => {
      const pos = geom.getAttribute('position')
      const i = (k + 1) % 3
      const j = (k + 2) % 3
      const met: [number, number][] = []
      const A = [0, 0, 0]
      const B = [0, 0, 0]
      const C = [0, 0, 0]
      for (let t = 0; t < pos.count / 3; t++) {
        for (let s = 0; s < 3; s++) {
          const arr = s === 0 ? A : s === 1 ? B : C
          arr[0] = pos.getX(t * 3 + s)
          arr[1] = pos.getY(t * 3 + s)
          arr[2] = pos.getZ(t * 3 + s)
        }
        const d = (B[j] - C[j]) * (A[i] - C[i]) + (C[i] - B[i]) * (A[j] - C[j])
        if (Math.abs(d) < 1e-14) continue
        const u = ((B[j] - C[j]) * (p - C[i]) + (C[i] - B[i]) * (q - C[j])) / d
        const w = ((C[j] - A[j]) * (p - C[i]) + (A[i] - C[i]) * (q - C[j])) / d
        const r = 1 - u - w
        if (u < 0 || w < 0 || r < 0) continue
        const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
        const ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]
        const n = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ]
        met.push([u * A[k] + w * B[k] + r * C[k], Math.sign(n[k])])
      }
      return met.sort((x, y) => x[0] - y[0])
    }

    /** Lines along axis `k`, on a skewed grid `half` across, that cross the
     *  surface out of order -- `pinches` for any axis and any size. */
    const foldedLines = (geom: BufferGeometry, k: 0 | 1 | 2, half: number): number => {
      let count = 0
      for (let i = -7; i <= 7; i++) {
        for (let j = -7; j <= 7; j++) {
          const met: [number, number][] = []
          for (const cross of along(geom, k, (i / 7) * half * 0.9 + 0.00713, (j / 7) * half * 0.9 + 0.00311)) {
            const last = met[met.length - 1]
            if (last && Math.abs(last[0] - cross[0]) < 1e-7 && last[1] !== cross[1]) met.pop()
            else met.push(cross)
          }
          let ok = met.length % 2 === 0
          for (let m = 0; ok && m < met.length; m++) ok = met[m][1] === (m % 2 === 0 ? -1 : 1)
          if (!ok) count++
        }
      }
      return count
    }

    /** The furthest any vertex lies outside the box the solid started in. */
    const strays = (geom: BufferGeometry, lo: Vec3, hi: Vec3): number => {
      const pos = geom.getAttribute('position')
      let worst = 0
      for (let i = 0; i < pos.count; i++) {
        const p = [pos.getX(i), pos.getY(i), pos.getZ(i)]
        for (let k = 0; k < 3; k++) worst = Math.max(worst, lo[k] - p[k], p[k] - hi[k])
      }
      return worst
    }

    const melt = (base: BaseSolid, run: ErodeDab[], id: string) =>
      evaluateObject({ ...object(base, [], [], id), erosion: run })

    /** The volume after every dab of the run. */
    const volumes = (base: BaseSolid, run: ErodeDab[], id: string): number[] =>
      run.map((_, i) => {
        const g = melt(base, run.slice(0, i + 1), `${id}-${i + 1}`).geometry
        const v = signedVolume(g)
        g.dispose()
        return v
      })

    /** The claims every thin case makes, stated once. */
    const holds = (
      label: string,
      base: BaseSolid,
      run: ErodeDab[],
      id: string,
      axis: 0 | 1 | 2,
      half: number,
      lo: Vec3,
      hi: Vec3
    ): { volumes: number[]; geometry: BufferGeometry } => {
      const vs = volumes(base, run, id)
      let rose = ''
      for (let i = 1; i < vs.length; i++) {
        if (vs[i] > vs[i - 1] + 1e-9) rose += ` ${i}->${i + 1}: ${vs[i - 1].toExponential(3)} -> ${vs[i].toExponential(3)}`
      }
      check(`${label}: the torch never puts material back`, rose === '', rose || 'monotone')
      const geometry = melt(base, run, `${id}-end`).geometry
      check(`${label}: and no dab produces a NaN`, !hasNaN(geometry), '')
      check(`${label}: and the object comes out closed`, unsewn(geometry) === 0, `${unsewn(geometry)} unsewn edges`)
      check(
        `${label}: and nowhere folded through itself`,
        foldedLines(geometry, axis, half) === 0,
        `${foldedLines(geometry, axis, half)} lines cross it out of order`
      )
      check(
        `${label}: and nothing strays out of the solid it was`,
        strays(geometry, lo, hi) < 1e-6,
        `${strays(geometry, lo, hi).toExponential(1)} beyond the face`
      )
      return { volumes: vs, geometry }
    }

    const panelBox: [Vec3, Vec3] = [
      [-0.15, -0.15, -0.01],
      [0.15, 0.15, 0.01],
    ]

    // A PRESS AT THE EDGE OF A PANEL. The wound runs off the side, so the two
    // rims of a tunnel arrive joined into one band, and the surgery has to sew
    // a strip across the thickness rather than a tunnel -- or, as it used to,
    // lay a lid over the notch on each face and hand the material back.
    for (const [where, x] of [
      ['on the edge', 0.15],
      ['half a brush in from the edge', 0.1],
    ] as const) {
      const run = stroke(10, [x, 0, 0.01])
      const { volumes: vs, geometry } = holds(
        `a press ${where} of a thin panel`,
        THIN,
        run,
        `thin-edge-${x}`,
        2,
        0.15,
        ...panelBox
      )
      check(
        `a press ${where} burns a notch out of it`,
        vs[vs.length - 1] < 0.85 * 1.8e-3,
        `${(vs[vs.length - 1] / 1.8e-3).toFixed(3)} of the panel left`
      )
      geometry.dispose()
    }

    // A DRAG ACROSS A PANEL, reaching its edge at both ends. Every dab widens
    // the last one's wound, so the tunnel is swallowed and sewn again each
    // time, and the band it becomes at the edges is sewn as a strip.
    {
      const run: ErodeDab[] = []
      for (let x = -0.1; x <= 0.1 + 1e-9; x += BRUSH * DAB_SPACING) {
        run.push({ at: [x, 0, 0.01], radius: BRUSH, heat: 1, smooth: 0.7 })
      }
      const { geometry } = holds('a drag across a thin panel', THIN, run, 'thin-drag', 2, 0.15, ...panelBox)
      let open = 0
      for (const x of [-0.05, 0, 0.05]) if (holed(geometry, x + 0.00713, 0.00311)) open++
      check('a drag across a thin panel cuts a slot right through', open === 3, `open at ${open} of 3 points`)
      geometry.dispose()
    }

    // A ROD TEN TIMES THINNER THAN THE BRUSH. The flame cuts it in two, and
    // the two rims it leaves are the ends of two stumps, not the two faces of
    // one wall: each has to be capped, and zipping them to each other -- which
    // they used to be, winding opposite ways and being nearest -- puts the rod
    // back together.
    {
      const rod: BaseSolid = { kind: 'cylinder', radius: 0.01, height: 0.3 }
      const run = stroke(8, [0.01, 0, 0])
      const { volumes: vs, geometry } = holds(
        'a rod under a brush ten times its width',
        rod,
        run,
        'thin-rod',
        0,
        0.15,
        [-0.01, -0.15, -0.01],
        [0.01, 0.15, 0.01]
      )
      check(
        'a rod under a brush ten times its width is cut in two',
        along(geometry, 0, 0.0031, 0.00713).length === 0 && vs[vs.length - 1] < 0.5 * vs[0],
        `${along(geometry, 0, 0.0031, 0.00713).length} crossings at the middle, ${(vs[vs.length - 1] / vs[0]).toFixed(3)} of the rod left`
      )
      const first = melt(rod, run.slice(0, 1), 'thin-rod-first').geometry
      check(
        'and the triangle count does not run away',
        triangleCount(geometry) < 1.5 * triangleCount(first),
        `${triangleCount(geometry)} after the cut, ${triangleCount(first)} after one dab`
      )
      first.dispose()
      geometry.dispose()
    }

    // A CHIP ONE AND A HALF BRUSHES WIDE, a tenth of a brush thick. The first
    // dab burns everything under the brush and leaves the four corners; the
    // next takes those. What must never happen is what did: the surgery
    // declined on every dab because the whole chip was the wound, and the two
    // faces went on sinking through each other.
    {
      const chip: BaseSolid = { kind: 'box', size: [0.15, 0.15, 0.01] }
      const run = stroke(6, [0, 0, 0.005])
      const { volumes: vs, geometry } = holds(
        'a chip smaller than two brushes',
        chip,
        run,
        'thin-chip',
        2,
        0.075,
        [-0.075, -0.075, -0.005],
        [0.075, 0.075, 0.005]
      )
      check(
        'a chip smaller than two brushes is never turned inside out',
        vs.every((v) => v >= -1e-12),
        `least volume ${Math.min(...vs).toExponential(2)}`
      )
      // What the flame reaches is gone; what it does not reach is not touched.
      // The corners of the chip stand just outside the brush, and they are
      // the honest remainder -- eating them would be the tool reaching past
      // its own ghost, which is the complaint this block was written for.
      const pos = geometry.getAttribute('position')
      let nearest = Infinity
      for (let i = 0; i < pos.count; i++) {
        nearest = Math.min(nearest, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i) - 0.005))
      }
      check(
        'and everything under the flame is gone',
        vs[vs.length - 1] < 0.05 * 0.15 * 0.15 * 0.01,
        `${(vs[vs.length - 1] / (0.15 * 0.15 * 0.01)).toFixed(3)} of the chip left`
      )
      check(
        'while what stands outside the brush is left alone',
        nearest >= 0.85 * BRUSH,
        `nearest remaining vertex ${(nearest / BRUSH).toFixed(2)} brush radii from the dab`
      )
      geometry.dispose()
    }

    // THE WOUND IS ROUND AND STOPS AT THE FLAME, which is the second half of
    // what the user sees. The rim of a hole is cut along a sphere about the
    // middle of the brush -- see the disc in `breakThrough` -- so every vertex
    // left on the panel stands at or beyond that sphere, and the ones nearest
    // it lie on it to within a hair; and outside the brush the panel is still
    // the panel, every vertex on one of its six faces, because nothing there
    // was ever moved. What this replaced left an octagon wider than the brush
    // with the surface around it dragged and creased to the panel's corners.
    {
      const run = stroke(6, [0, 0, 0.01])
      const geometry = melt(THIN, run, 'thin-round').geometry
      const pos = geometry.getAttribute('position')
      let nearest = Infinity
      let rimFar = 0
      let rimCount = 0
      let strayed = 0
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i)
        const y = pos.getY(i)
        const z = pos.getZ(i)
        const d = Math.hypot(x, y, z - 0.01)
        nearest = Math.min(nearest, d)
        if (d < 0.95 * BRUSH) {
          rimCount++
          rimFar = Math.max(rimFar, d)
        }
        if (d <= BRUSH) continue
        const onFace =
          Math.abs(Math.abs(z) - 0.01) < 1e-6 ||
          Math.abs(Math.abs(x) - 0.15) < 1e-6 ||
          Math.abs(Math.abs(y) - 0.15) < 1e-6
        if (!onFace) strayed++
      }
      // To within the little a lip melts back after it is cut: the dabs that
      // follow the cut sink the lip down and outward, a few hundredths of a
      // radius over six, and not all of it evenly.
      check(
        'a hole in a thin panel is cut round, on the sphere of the flame',
        rimCount > 20 && nearest >= 0.9 * BRUSH && rimFar - nearest < 0.06 * BRUSH,
        `${rimCount} rim vertices between ${(nearest / BRUSH).toFixed(4)} and ${(rimFar / BRUSH).toFixed(4)} brush radii`
      )
      check(
        'and outside the brush the panel is still the panel',
        strayed === 0,
        `${strayed} vertices off the panel's faces`
      )
      geometry.dispose()
    }
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

  {
    // WHY TWICE COMES BACK, checked at the joint rather than at the outcome.
    // The turn that pays for a primitive being reflected in a plane other than
    // the one asked for is self-cancelling only when the plane used is parallel
    // or perpendicular to the axis asked for; at any other angle a second press
    // leaves the object turned by four times the mismatch, and a merged one
    // walks a little further round the scene on every press after that. Every
    // faceted primitive therefore has to stand square with its own axes, which
    // is what `azimuthAlignment` spends the free azimuth of a resting solid on.
    const faceted: [string, BaseSolid][] = [
      ...[3, 4, 5, 6, 8].flatMap((sides): [string, BaseSolid][] => [
        [`${sides}-sided prism`, { kind: 'prism', radius: 0.5, height: 0.9, sides }],
        [`${sides}-sided pyramid`, { kind: 'pyramid', radius: 0.5, height: 0.9, sides }],
      ]),
      ...(['tetrahedron', 'octahedron', 'dodecahedron'] as const).map(
        (s): [string, BaseSolid] => [s, { kind: 'platonic', solid: s, radius: 0.55 }]
      ),
    ]
    for (const [label, base] of faceted) {
      // |n . axis| is 1 for a plane parallel to the one asked for and 0 for a
      // perpendicular one; both cancel, so the distance from the nearer of the
      // two is how far off square the plane is, and it has to be nothing.
      const off = ([0, 1, 2] as Axis[]).map((axis) => {
        const dot = Math.abs(mirrorNormal(base, axis).dot(new Vector3().setComponent(axis, 1)))
        return Math.min(dot, 1 - dot)
      })
      const worst = Math.max(...off)
      check(
        `a ${label} is square with its own axes, so a mirror of it undoes itself`,
        worst < 1e-9,
        `worst plane sits ${(Math.asin(worst) * (180 / Math.PI)).toFixed(2)} deg off square`
      )
    }
  }

  {
    // The shape the bug actually took. A lone solid reflected in a leaning plane
    // only spins in place, since its centre IS its origin and there is nothing
    // for the leftover turn to swing; a MERGED object's centre sits away from
    // it, so the same turn carries every part round and the assembly comes back
    // from two presses somewhere else entirely. A tetrahedron was the one
    // primitive with no square plane to use, and so the one host this failed on.
    const hosts: BaseSolid[] = [
      { kind: 'platonic', solid: 'tetrahedron', radius: 0.55 },
      { kind: 'platonic', solid: 'dodecahedron', radius: 0.5 },
      { kind: 'pyramid', radius: 0.5, height: 0.9, sides: 5 },
      { kind: 'cone', radius: 0.5, height: 1.2 },
      { kind: 'box', size: [1, 1, 1] },
    ]
    /** Every solid in the assembly, where it stands in the object's own frame. */
    const poses = (o: SceneObject): number[] => {
      const out: number[] = []
      const walk = (x: SceneObject, into: Matrix4) => {
        out.push(...into.elements)
        for (const p of x.parts) walk(p, into.clone().multiply(objectMatrix(p.transform)))
      }
      walk(o, objectMatrix(o.transform))
      return out
    }
    for (const base of hosts) {
      const label = base.kind === 'platonic' ? base.solid : base.kind
      const merged = solid(base, {
        parts: [
          solid(
            { kind: 'box', size: [0.3, 0.3, 0.3] },
            { id: 'part', transform: { position: [0.4, 0.2, 0.1], rotation: [0.1, 0.2, 0.3] } }
          ),
        ],
        transform: { position: [0.5, 0.25, -0.4], rotation: [0.3, 0.9, -0.2] },
      })
      const start = poses(merged)
      for (const axis of [0, 1, 2] as Axis[]) {
        // Four presses rather than two: a turn that cancels over a pair cancels
        // over any even count, and one that does not has drifted further by
        // here, so a fix that merely halved the error would still be caught.
        let o = merged
        for (let i = 0; i < 4; i++) o = mirrorAssembly(o, axis)
        const drift = Math.max(...poses(o).map((v, i) => Math.abs(v - start[i])))
        check(
          `a merged ${label} mirrored four times about ${'XYZ'[axis]} is back where it began`,
          drift < 1e-9,
          `worst drift ${drift.toExponential(2)}`
        )
      }
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

  /**
   * HOW MANY FACETS THIS PIECE IS ACTUALLY SWEPT WITH, and the share of a
   * circle's area the polygon that many facets holds.
   *
   * Both used to be constants and neither is one any more: a round piece's
   * count is worked out from how wide it is (see `roundFacets`) and a polygonal
   * one's is its own side count. Every volume below is measured against the
   * polygon the mesh REALLY is, so the deficit stays predicted rather than
   * tolerated and the checks stay tight enough to catch a dropped cap.
   */
  const sweptWith = (c: Clay): number =>
    c.sides === null ? roundFacets(widestRadius(c)) : c.sides
  const deficitOf = (n: number): number => (n * Math.sin((2 * Math.PI) / n)) / (2 * Math.PI)

  /**
   * The volume the SWEPT profile encloses, as against the stored one.
   *
   * The wall is remembered as ninety-six rings and swept as however few the
   * shape earns -- see `meridian` -- so on a curved piece the mesh is built
   * from chords across the profile rather than from the profile itself, and
   * comes out a shade light exactly as the inscribed polygon does going round.
   * Measuring against the chords is what keeps these checks at 1e-5: the
   * thinning is predicted here, and how far it moves the answer is pinned as a
   * fact of its own rather than hidden inside a loosened tolerance.
   */
  const sweptVolume = (c: Clay): number => {
    const span = pieceSpan(c)
    if (span === null) return 0
    const heights: number[] = []
    const radii: number[] = []
    for (let i = span.lo; i <= span.hi; i += 1) {
      heights.push(ringHeight(c, i))
      radii.push(c.wall[i])
    }
    const line = meridian(heights, radii)
    let sum = 0
    for (let i = 0; i < line.radii.length - 1; i += 1) {
      // Nothing between the two copies of a creased ring: they stand at the
      // same height, so the frustum has no depth and the mesh builds no band.
      if (line.seams[i]) continue
      const step = line.heights[i + 1] - line.heights[i]
      const a = line.radii[i]
      const b = line.radii[i + 1]
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
  // piece inside the frame it is drawn in -- and on the way IN the bound is the
  // axis itself, so a piece may close. See `CLAY_FLARE`.
  {
    const { min, max } = wallBounds(0.4)
    check('the floor is the axis', min === 0, `${min}`)
    const pinched = hold(stock, { y: 0.75, radius: 0, reach: 0.3, bite: 1, tool: 'push' }, 200)
    // EXACTLY nothing, and it takes both halves of the change to get there. The
    // floor no longer holds the wall out at a twentieth of the stock -- but the
    // tool would still only CONVERGE on the axis, because the relax pass that
    // keeps it from creasing the wall lifts the middle of its dish by a fraction
    // of the neighbours either side, and what that leaves is a whisker five
    // hundredths of a millimetre thick. `CLAY_CLOSED` is what turns the last
    // fraction of a millimetre into nothing at all.
    check(
      'a wall pinched as hard as possible closes onto the axis',
      Math.min(...pinched.wall) === 0,
      `closed to ${Math.min(...pinched.wall)}`
    )
    check(
      'and never crosses it',
      pinched.wall.every((r) => r >= 0),
      `${Math.min(...pinched.wall)}`
    )
    const flared = hold(stock, { y: 0.75, radius: 99, reach: 0.3, bite: 1, tool: 'pull' }, 200)
    near(
      'and a wall pulled as hard as possible stops at the ceiling',
      Math.max(...flared.wall),
      max,
      1e-9
    )
  }

  // A ROUND TOP, which is the most ordinary thing anybody turns and the one
  // shape a floor of a twentieth made impossible: the tool held on the axis at
  // the rim closes the piece to a point and leaves the body under it alone.
  {
    const domed = hold(stock, { y: 1.5, radius: 0, reach: 0.35, bite: 1, tool: 'push' }, 200)
    check(
      'a tool held on the axis at the rim closes the top to a point',
      domed.wall[CLAY_RINGS - 1] === 0,
      `rim at ${domed.wall[CLAY_RINGS - 1]}`
    )
    // And what it leaves under the point is a dome rather than a spike: every
    // ring up the shoulder narrower than the one below it, all the way from the
    // untouched wall to the axis.
    let dents = 0
    for (let i = CLAY_RINGS - 22; i < CLAY_RINGS - 1; i += 1) {
      if (domed.wall[i + 1] > domed.wall[i] + 1e-9) dents += 1
    }
    check('and the shoulder under it falls away smoothly', dents === 0, `${dents} dents`)
    check(
      'while the wall below the tool is untouched',
      domed.wall[CLAY_RINGS - 30] === stock.wall[CLAY_RINGS - 30],
      `${domed.wall[CLAY_RINGS - 30]}`
    )
    // And the case the old floor was there to forbid, allowed on purpose: a
    // piece pinched through the middle is two lobes meeting at a point, which
    // still sweeps to a solid with volume in it.
    const waisted = hold(stock, { y: 0.75, radius: 0, reach: 0.3, bite: 1, tool: 'push' }, 200)
    const volume = clayVolume(waisted)
    check(
      'a piece pinched in two still has volume in it',
      volume > 0 && Number.isFinite(volume),
      `${volume}`
    )
  }

  // ROUNDING THE TOP OFF, which is the gesture the whole of the change above is
  // for: run the tool up the axis and clean off the top of the piece, and what
  // is left is a piece with a domed top and no stock standing over it.
  //
  // What used to happen instead is worth writing down, because it is the shape
  // of the bug. The floor held the wall out at a twentieth of the stock, so the
  // top never closed; lifted, the tool converged on the axis but the relax left
  // a whisker of five hundredths of a millimetre; and the viewport draws a wall
  // of any width at all with a stroke a pixel and a half wide. The top of the
  // piece came off as a NEEDLE standing on the shoulder the hand had rounded.
  {
    const from = stock.wall
    let run = stock
    // A hand dragging the tool up the axis, forty positions and eight frames of
    // contact at each, ending clean above the rim.
    for (let step = 0; step <= 40; step += 1) {
      const y = 1.15 + (step / 40) * 0.5
      for (let f = 0; f < 8; f += 1) {
        run = mold(run, { y, radius: 0, reach: 0.35, bite: 0.5, tool: 'push' }, from)
      }
    }

    const span = pieceSpan(run)
    check('a tool run up the axis closes the piece below the rim', span !== null && span.hi < CLAY_RINGS - 1, `${span?.hi}`)
    check(
      'and every ring above the clay is nothing at all, not a whisker',
      run.wall.slice((span?.hi ?? 0) + 1).every((r) => r === 0),
      `${run.wall.slice((span?.hi ?? 0) + 1).filter((r) => r !== 0).length} rings still standing`
    )
    // A dome rather than a spike: the shoulder narrows all the way up, and it
    // does it without a step in it -- the same promise the tools make anywhere
    // else on the wall.
    let rises = 0
    for (let i = 40; i < (span?.hi ?? 0); i += 1) if (run.wall[i + 1] > run.wall[i] + 1e-12) rises += 1
    check('the shoulder narrows all the way to the top', rises === 0, `${rises} rises`)
    let sharpest = 0
    for (let i = 1; i <= (span?.hi ?? 0); i += 1) {
      sharpest = Math.max(sharpest, Math.abs(run.wall[i] - run.wall[i - 1]))
    }
    check('and does it without a step', sharpest < 0.03, `sharpest step ${sharpest.toFixed(4)}`)

    // THE PIECE IS SHORTER THAN ITS STOCK, and every consumer has to agree
    // about that or the readout, the drawing and the pasted solid tell three
    // different stories.
    const top = ringHeight(run, span?.hi ?? 0)
    near('the piece is as tall as its clay, not as tall as its stock', pieceHeight(run), top, 1e-12)
    check('which is shorter than the stock it came out of', pieceHeight(run) < run.height - 0.1, `${pieceHeight(run).toFixed(3)} of ${run.height}`)
    const box = new Box3().setFromBufferAttribute(
      revolveClay(run).getAttribute('position') as BufferAttribute
    )
    // A looser tolerance than the rest of this file uses, and it is the buffer
    // rather than the arithmetic: positions land in a Float32Array, which holds
    // about seven digits.
    near('and the solid it sweeps to stops where the clay does', box.max.y, top, 1e-6)
    near('still standing on the faceplate', box.min.y, 0, 1e-9)
    check('and still holding clay', signedVolume(revolveClay(run)) > 0, `${signedVolume(revolveClay(run)).toFixed(5)}`)

    // A FRESH LUMP IS THE WHOLE OF ITSELF, which is what says the trim only
    // takes what the tools have actually closed.
    const whole = pieceSpan(stock)
    check('an untouched lump is clay from the plate to the rim', whole?.lo === 0 && whole?.hi === CLAY_RINGS - 1, `${whole?.lo}..${whole?.hi}`)
    near('and stands its full stock height', pieceHeight(stock), 1.5, 1e-12)
  }

  // CLOSING IS THE TOOL'S RULE, NOT THE MODEL'S -- see `CLAY_CLOSED`. The tool
  // snaps a ring it has worked under a millimetre; the size fields and undo,
  // which touch every ring at once and are not aimed at anything, do not.
  {
    const stem = withWall(stock, stock.wall.map((r, i) => (i > 60 ? 0.011 : r)))
    const shrunk = resize(stem, { radius: 0.04 })
    check(
      'shrinking the stock does not close the walls it thins',
      shrunk.wall.every((r) => r > 0),
      `${shrunk.wall.filter((r) => r === 0).length} rings closed`
    )
    check(
      'and putting a hair-thin wall back does not close it either',
      withWall(stock, stem.wall).wall.every((r) => r > 0),
      ''
    )
    // But a tool worked over one does, and only over the rings it reached.
    const closed = mold(stem, { y: 1.5, radius: 0, reach: 0.15, bite: 1, tool: 'push' })
    check('while a tool worked over one closes it', closed.wall[CLAY_RINGS - 1] === 0, `${closed.wall[CLAY_RINGS - 1]}`)
    check('and leaves the rings it never reached alone', closed.wall[0] === stem.wall[0], `${closed.wall[0]}`)
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
    // area -- 0.99715 at the 48 facets a 4 cm piece is swept with -- so a swept
    // cylinder comes out three tenths of a percent light, and that is the mesh
    // being RIGHT rather than wrong. The deficit is predicted rather than
    // tolerated, so the check stays tight enough that a missing cap or a
    // dropped ring fails it outright.
    const exact = Math.PI * 0.4 * 0.4 * 1.5
    const facets = deficitOf(sweptWith(cylinder))
    near('a swept cylinder holds a cylinder of clay', signedVolume(solid), exact * facets, 1e-5)

    // AND A CYLINDER COSTS WHAT A CYLINDER SHOULD. The wall is stored as
    // ninety-six rings whatever shape is on it, and sweeping the storage rather
    // than the shape is what used to put 12,288 triangles into the scene for a
    // lump with no detail in it at all -- the same count as a fluted bowl,
    // because the count had nothing to do with the piece. A straight wall is
    // two rings; the rest is the caps. See `meridian`.
    const plainTris = (solid.getIndex()?.count ?? 0) / 3
    const swept = sweptWith(cylinder)
    check(
      'and it costs one band of facets and two caps, not ninety-five bands',
      plainTris === swept * 4,
      `${plainTris} triangles at ${swept} facets`
    )
    check(
      'and it is wound the right way out',
      signedVolume(solid) > 0,
      `${signedVolume(solid).toFixed(5)}`
    )

    // The same, on a piece that has actually been worked: the frustum sum of the
    // profile AS SWEPT, times the same polygon deficit.
    const worked = hold(cylinder, { y: 0.9, radius: 0.15, reach: 0.35, bite: 1, tool: 'push' }, 60)
    near(
      'and a shaped piece holds what its profile says',
      signedVolume(revolveClay(worked)),
      sweptVolume(worked) * deficitOf(sweptWith(worked)),
      1e-4
    )

    // AND THINNING THE PROFILE COSTS ALMOST NONE OF IT, which is the claim
    // `PROFILE_TOLERANCE` is making and the one worth measuring rather than
    // asserting. A curve swept as chords comes out light the same way an
    // inscribed polygon does; a tenth of a millimetre of chord error on a piece
    // 4 cm across is a couple of parts in a thousand of the clay, and it is
    // systematically INWARD rather than noisy, which is what a chord is.
    const lost = 1 - sweptVolume(worked) / clayVolume(worked)
    check(
      'and thinning the rings costs a fraction of a percent of the clay',
      lost > 0 && lost < 0.005,
      `${(lost * 100).toFixed(3)}% light against the stored profile`
    )
    // The other half of the same claim: it is cheap. A shaped piece keeps the
    // rings its curve earns and drops the rest, so it is a fraction of what
    // sweeping the storage cost -- and still far more rings than the cylinder.
    const workedTris = (revolveClay(worked).getIndex()?.count ?? 0) / 3
    check(
      'while the piece costs a fraction of the 12,288 it used to',
      workedTris < 4000 && workedTris > plainTris,
      `${workedTris} triangles, against 12,288 before and ${plainTris} for the bare lump`
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
    //
    // WALKED OVER THE RINGS THAT ARE THERE rather than over `CLAY_RINGS`. The
    // wall is stored at ninety-six and swept at however few the shape earns, so
    // a loop counting the storage reads off the end of the buffer and compares
    // undefined with undefined -- which passes. The count comes off the
    // meridian itself, and the check fails if that disagrees with the buffer.
    const pos = solid.getAttribute('position')
    const columns = sweptWith(cylinder) + 1
    const bands = meridian(
      [0, cylinder.height],
      [cylinder.radius, cylinder.radius]
    ).heights.length
    check(
      'a straight wall is swept as its two ends and nothing between',
      bands === 2,
      `${bands} rings`
    )
    let seam = 0
    for (let i = 0; i < bands; i += 1) {
      const first = i * columns
      const last = first + columns - 1
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
      const deficit = deficitOf(sides)
      near(
        `a ${sides}-sided piece holds the ${sides}-gon of its profile`,
        signedVolume(mesh),
        sweptVolume(piece) * deficit,
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
    // The rings the wall is SWEPT at, which is no longer the rings it is stored
    // at: the profile is thinned to what its shape earns before it is turned
    // into triangles. Reading the radii back off the meridian rather than off
    // `hexagonal.wall` is what keeps this a check on the buffer instead of a
    // walk past the end of it.
    const hexSpan = pieceSpan(hexagonal) as { lo: number; hi: number }
    const hexHeights: number[] = []
    const hexRadii: number[] = []
    for (let i = hexSpan.lo; i <= hexSpan.hi; i += 1) {
      hexHeights.push(ringHeight(hexagonal, i))
      hexRadii.push(hexagonal.wall[i])
    }
    const hexLine = meridian(hexHeights, hexRadii)
    let worstCorner = 0
    let worstFlat = 0
    for (let i = 0; i < hexLine.radii.length; i += 1) {
      const r = hexLine.radii[i]
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
    // A ring in the middle of the swept wall, wherever that now falls.
    const ring = Math.floor(hexLine.radii.length / 2) * width
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

  // WHAT THE SWEEP COSTS, which for a long time was one number whatever was
  // being swept. The wall is STORED as ninety-six rings because that is what a
  // brush needs to have somewhere to put a millimetre of clay -- and it was
  // SWEPT as ninety-six rings too, so a bare cylinder and a fluted bowl both
  // arrived in the scene at 12,288 triangles. The count said nothing about the
  // shape. See `meridian`, which fits the rings to the profile and the facets
  // to the size, both against one tolerance.
  {
    const along = (c: Clay) => {
      const span = pieceSpan(c) as { lo: number; hi: number }
      const heights: number[] = []
      const radii: number[] = []
      for (let i = span.lo; i <= span.hi; i += 1) {
        heights.push(ringHeight(c, i))
        radii.push(c.wall[i])
      }
      return { heights, radii }
    }
    const thinned = (c: Clay) => {
      const { heights, radii } = along(c)
      return meridian(heights, radii)
    }
    const trisOf = (c: Clay) => (revolveClay(c).getIndex()?.count ?? 0) / 3

    // A STRAIGHT RUN IS ITS TWO ENDS. Nothing between them stands off the chord
    // at all, so every ring in the middle was a band of triangles describing a
    // straight line with a straight line.
    const cylinder = freshClay(1.5, 0.4)
    check('a cylinder is swept as two rings', thinned(cylinder).heights.length === 2, `${thinned(cylinder).heights.length}`)
    const cone = sculpt(cylinder, [
      [0, 0.4],
      [1.5, 0.05],
    ])
    check('and a cone as two as well', thinned(cone).heights.length === 2, `${thinned(cone).heights.length}`)
    check(
      'so a cone costs what a cylinder costs',
      trisOf(cone) === trisOf(cylinder),
      `${trisOf(cone)} against ${trisOf(cylinder)}, where both were 12,288`
    )

    // AND BOTH ENDS SURVIVE WHATEVER IS DROPPED BETWEEN THEM, which the caps
    // depend on: a sweep whose first ring had been thinned away would close the
    // piece at the wrong height.
    const ends = thinned(cone)
    near('the foot is kept exactly', ends.heights[0], 0, 1e-12)
    near('and the crown', ends.heights[ends.heights.length - 1], 1.5, 1e-12)
    near('at the radii the wall stands at', ends.radii[0], 0.4, 1e-12)

    // A CURVE KEEPS WHAT IT NEEDS. The claim `PROFILE_TOLERANCE` makes is not
    // "fewer rings" but "no ring further than a tenth of a millimetre from the
    // wall it came from", so it is measured rather than asserted: every stored
    // ring is checked against the thinned line at its own height.
    {
      const curved = hold(cylinder, { y: 0.9, radius: 0.15, reach: 0.35, bite: 1, tool: 'push' }, 60)
      const line = thinned(curved)
      const { heights, radii } = along(curved)
      // PERPENDICULAR to the swept surface, which is what the tolerance means
      // and what the eye sees: how far the mesh stands off the profile,
      // measured square to it rather than along one axis. A radial reading
      // would call a steep wall out of tolerance for being steep -- the same
      // surface error read across instead of square is bigger by a factor of
      // one over the cosine, and says nothing about the shape.
      let worst = 0
      for (let i = 0; i < heights.length; i += 1) {
        let near = Infinity
        for (let k = 0; k < line.heights.length - 1; k += 1) {
          const ay = line.heights[k]
          const ar = line.radii[k]
          const dy = line.heights[k + 1] - ay
          const dr = line.radii[k + 1] - ar
          const len2 = dy * dy + dr * dr
          const t =
            len2 === 0 ? 0 : Math.min(1, Math.max(0, ((heights[i] - ay) * dy + (radii[i] - ar) * dr) / len2))
          near = Math.min(near, Math.hypot(heights[i] - (ay + dy * t), radii[i] - (ar + dr * t)))
        }
        worst = Math.max(worst, near)
      }
      check(
        'a thinned curve stands within a tenth of a millimetre of the wall',
        worst <= PROFILE_TOLERANCE,
        `worst ${(worst * 100).toFixed(4)} mm against ${(PROFILE_TOLERANCE * 100).toFixed(2)}`
      )
      check(
        'and it keeps enough rings to do it',
        line.heights.length > 10 && line.heights.length < CLAY_RINGS,
        `${line.heights.length} of ${CLAY_RINGS}`
      )
      // A CURVE IS NOT A CORNER. Every ring a fitted curve keeps turns by a few
      // degrees -- that is what staying within the tolerance means -- so a
      // threshold that creased them would face a dome like a lampshade.
      check('and creases none of them', line.seams.every((x) => !x), `${line.seams.filter(Boolean).length} creases`)
    }

    // THE CORNERS POINT SCULPT IS FOR. With `Fit to line` off the tool states
    // the wall in straight segments, and a step drawn that way used to arrive
    // shaded ROUND: the sweep read every normal from a central difference, so
    // the ring at the corner faced half way between the wall below it and the
    // shoulder above. The one thing on this screen that can leave a corner was
    // the one thing the mesh would not show.
    {
      const step = sculpt(cylinder, [
        [0.2, 0.35],
        [0.8, 0.35],
        [0.8, 0.2],
        [1.3, 0.2],
      ])
      const line = thinned(step)
      const creases = line.seams.filter(Boolean).length
      check('a stepped profile creases where it turns', creases > 0, `${creases} creases`)
      // A creased ring is the same ring TWICE, which is what lets each copy
      // take the slope of its own side. Standing at one height and one radius
      // is what makes it an edge rather than a chamfer nobody asked for.
      let doubled = 0
      for (let i = 0; i < line.seams.length; i += 1) {
        if (!line.seams[i]) continue
        if (line.heights[i] === line.heights[i + 1] && line.radii[i] === line.radii[i + 1]) doubled += 1
      }
      check('and every crease is one ring written twice', doubled === creases, `${doubled} of ${creases}`)

      // AND THE MESH SHOWS IT. Two copies at one place with two normals is a
      // hard edge; the same two with one normal is the smooth shoulder this
      // fixes. Measured on the built buffer rather than on the intention.
      const mesh = revolveClay(step)
      const nrm = mesh.getAttribute('normal')
      const columns = roundFacets(widestRadius(step)) + 1
      let sharpest = 0
      for (let i = 0; i < line.seams.length; i += 1) {
        if (!line.seams[i]) continue
        const a = i * columns
        const b = (i + 1) * columns
        const dot =
          nrm.getX(a) * nrm.getX(b) + nrm.getY(a) * nrm.getY(b) + nrm.getZ(a) * nrm.getZ(b)
        sharpest = Math.max(sharpest, Math.acos(Math.min(1, Math.max(-1, dot))))
      }
      check(
        'the two copies of a corner face plainly different ways',
        sharpest > CREASE_TURN,
        `${((sharpest * 180) / Math.PI).toFixed(1)} degrees apart, against a ${((CREASE_TURN * 180) / Math.PI).toFixed(0)} degree threshold`
      )

      // NOTHING BETWEEN THE TWO COPIES. They stand at the same height and the
      // same radius, so a band there would be a full turn of triangles with no
      // area in them -- invisible, and real enough to trip a welder that trusts
      // a triangle to have a normal.
      const index = mesh.getIndex() as BufferAttribute
      const pos = mesh.getAttribute('position')
      let flat = 0
      for (let t = 0; t < index.count; t += 3) {
        const ax = pos.getX(index.getX(t))
        const ay = pos.getY(index.getX(t))
        const az = pos.getZ(index.getX(t))
        const bx = pos.getX(index.getX(t + 1))
        const by = pos.getY(index.getX(t + 1))
        const bz = pos.getZ(index.getX(t + 1))
        const cx = pos.getX(index.getX(t + 2))
        const cy = pos.getY(index.getX(t + 2))
        const cz = pos.getZ(index.getX(t + 2))
        const ux = bx - ax
        const uy = by - ay
        const uz = bz - az
        const vx = cx - ax
        const vy = cy - ay
        const vz = cz - az
        const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
        if (area < 1e-12) flat += 1
      }
      check('and the mesh carries no triangle with no area in it', flat === 0, `${flat} degenerate`)

      // The whole point of the exercise: a shape made of five straight runs
      // costs about what five straight runs should.
      check(
        'a stepped piece costs a fraction of the 12,288 it used to',
        trisOf(step) < 1200,
        `${trisOf(step)} triangles`
      )
    }

    // HOW MANY FACETS GO ROUND, asked of the piece instead of named once. The
    // deepest a chord falls inside the circle it spans is `r(1 - cos(pi/n))`,
    // so the count is whatever holds that under the same tolerance the rings
    // are thinned to -- which is the property worth having: a piece is no
    // coarser up the meridian than it is round the axis.
    {
      for (const r of [0.05, 0.1, 0.2, 0.4, 0.8, 1.6]) {
        const n = roundFacets(r)
        const sag = r * (1 - Math.cos(Math.PI / n))
        // The ceiling is a ceiling: past the width where 64 facets stop being
        // enough, a piece is swept at 64 anyway rather than at two hundred.
        if (n < TURN_FACETS) {
          check(
            `a piece ${(r * 20).toFixed(0)} cm wide is swept fine enough`,
            sag <= PROFILE_TOLERANCE,
            `${n} facets, ${(sag * 100).toFixed(3)} mm off the circle`
          )
          const coarser = r * (1 - Math.cos(Math.PI / (n - 8)))
          check('and no finer than it has to be', coarser > PROFILE_TOLERANCE, `${n - 8} would be ${(coarser * 100).toFixed(3)} mm off`)
        }
      }
      check('a wide piece is capped rather than run away with', roundFacets(4) === TURN_FACETS, `${roundFacets(4)}`)
      check('and a hair-thin one still reads as round', roundFacets(1e-6) >= 16, `${roundFacets(1e-6)}`)
      check('a piece of no width at all is not a division by zero', Number.isFinite(roundFacets(0)), `${roundFacets(0)}`)

      // IT SCALES, which is the whole reason to compute it. A fixed count is
      // always wrong somewhere: too coarse for the widest piece the stock
      // allows and several times too fine for a stem.
      check(
        'a thin piece is swept with fewer facets than a fat one',
        roundFacets(0.05) < roundFacets(0.4) && roundFacets(0.4) < roundFacets(1.2),
        `${roundFacets(0.05)}, ${roundFacets(0.4)}, ${roundFacets(1.2)}`
      )
    }
  }
}

// --- The rib and the bore ----------------------------------------------------
//
// The two things the lathe grew after its two tools: a smoothing tool that is
// the second half of the other two, and a way to take the middle out. Both are
// arithmetic on the same row of radii, which is why they are checked here
// rather than in front of a window.
console.log('\nThe lathe fairs itself and bores itself out')
{
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

    /**
     * A wall shaped by hand, for the two pieces below: control points as
     * `[height fraction, radius as a multiple of the stock]`, sampled onto the
     * rings, held inside what the tools allow and then faired.
     *
     * A FIXTURE, not a feature. The app has no palette of starting shapes --
     * every piece is pushed and pulled out of the cylinder -- but the two
     * questions below are about shapes a cylinder cannot ask: whether a neck
     * stops the cavity, and which pocket gets bored when the wall pinches into
     * several. Working them up with `mold` would be a hundred dabs describing
     * a shape six numbers describe, so the shape is written down here, in the
     * check that needs it.
     */
    const shapedWall = (c: Clay, points: [number, number][]): number[] => {
      const { min, max } = wallBounds(c.radius)
      const hold = (r: number) => Math.min(max, Math.max(min, r))
      const wall = new Array<number>(CLAY_RINGS)
      for (let i = 0; i < CLAY_RINGS; i += 1) {
        const t = i / (CLAY_RINGS - 1)
        let r = points[0][1]
        for (let k = 1; k < points.length; k += 1) {
          const [t1, r1] = points[k]
          if (t > t1 && k < points.length - 1) continue
          const [t0, r0] = points[k - 1]
          const span = t1 - t0
          const f = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - t0) / span))
          r = r0 + (r1 - r0) * f
          break
        }
        wall[i] = hold(r * c.radius)
      }
      // Faired the way a stroke's own relax pass fairs, so the straight runs
      // between control points arrive as the curves they stand for -- a wall
      // with corners in it is not something anybody turned.
      for (let pass = 0; pass < 24; pass += 1) {
        const from = wall.slice()
        for (let i = 1; i < CLAY_RINGS - 1; i += 1) {
          wall[i] = hold((from[i - 1] + from[i] * 2 + from[i + 1]) / 4)
        }
      }
      return wall
    }

    // ASKING IS NOT GETTING. A neck narrower than two walls stops the cavity
    // before it reaches the end, and the bore says so rather than pretending.
    // A vase: a belly, a neck drawn in above it, and a small flare at the rim.
    const vase: [number, number][] = [
      [0, 0.7],
      [0.15, 1.15],
      [0.38, 1.4],
      [0.7, 0.72],
      [0.88, 0.55],
      [1, 0.78],
    ]
    // Thick enough that the vase's own rim is narrower than two walls, so
    // there is nothing to bore through at the end that was asked for. The
    // cavity ends up in the belly, blind at both ends.
    const necked = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.31, capTop: false, capBottom: true } }
    const shaped = { ...necked, wall: shapedWall(necked, vase) }
    const blind = bore(shaped) as Bore
    check('a neck too thin to bore through stops the cavity', blind !== null && !blind.openTop, `${blind?.openTop}`)
    check('and the end that was asked for is honestly not open', blind !== null && blind.hi < shaped.height, `${blind?.hi.toFixed(3)} of ${shaped.height}`)

    // BORED FROM THE OPEN END, which is what stops a goblet being hollowed
    // through its foot -- the widest part of it, and the wrong end entirely.
    // A goblet: a wide foot, a thin stem, and a cup opening out above it.
    const goblet: [number, number][] = [
      [0, 1.2],
      [0.08, 1.1],
      [0.16, 0.28],
      [0.42, 0.24],
      [0.6, 0.85],
      [1, 1.25],
    ]
    // A wall thicker than the stem is wide, so the stem cannot be bored at all
    // -- which is what makes this a test of WHICH pocket gets chosen rather
    // than of whether one exists. At a thinner wall the bore runs right down
    // through the stem into the foot, and that is correct: there is room.
    const cupLump = { ...freshClay(1.5, 0.4), hollow: { thickness: 0.095, capTop: false, capBottom: true } }
    const stem = { ...cupLump, wall: shapedWall(cupLump, goblet) }
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
    const facets = (roundFacets(0.4) * Math.sin((2 * Math.PI) / roundFacets(0.4))) / (2 * Math.PI)
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


// --- Point Sculpt -------------------------------------------------------------
//
// The one tool on the lathe that is not a brush. Push, Pull and Smooth all work
// by holding something against the wall and letting the clay come to it; this
// states the wall outright, from a line drawn through placed points. So what is
// checked here is different in kind: not that a stroke stops where the pointer
// is, but that the line IS the profile -- exactly, over exactly the span it
// covers, and nowhere else.
console.log('\nPoint Sculpt states the wall, over the span its line covers')
{
  const lump = freshClay(1.5, 0.4)
  /** A ring's height, as the line has to be drawn in. */
  const at = (i: number) => ringHeight(lump, i)

  {
    // THE LINE IS THE WALL, and that is the whole promise. A straight line down
    // one radius leaves every ring it covers standing at exactly that radius --
    // not near it, which is what a brush would leave.
    const cut = sculpt(lump, [
      [at(20), 0.15],
      [at(60), 0.15],
    ])
    const inside = cut.wall.slice(20, 61)
    check(
      'a line at one radius puts every ring it covers exactly there',
      inside.every((r) => Math.abs(r - 0.15) < 1e-9),
      `${Math.min(...inside).toFixed(6)}..${Math.max(...inside).toFixed(6)}`
    )
  }

  {
    // AND NOWHERE ELSE. The rest of the wall is not touched, which is what lets
    // a neck be re-cut on a piece whose belly took ten minutes to get right --
    // and it is the whole reason this is a tool rather than a reset.
    const cut = sculpt(lump, [
      [at(20), 0.15],
      [at(60), 0.15],
    ])
    const below = cut.wall.slice(0, 20)
    const above = cut.wall.slice(61)
    check(
      'and leaves the wall below the line exactly as it was',
      below.every((r, i) => r === lump.wall[i]),
      `${below.length} rings`
    )
    check(
      'and the wall above it too',
      above.every((r, i) => r === lump.wall[i + 61]),
      `${above.length} rings`
    )
  }

  {
    // IT CAN SHARPEN, which nothing else on this screen can. Every dab relaxes
    // the window it moved -- see RELAX -- so a brush cannot leave a corner
    // however hard it is held. A step is two points at one height, and the two
    // rings either side of it have to stand a step apart.
    const step = sculpt(lump, [
      [at(30), 0.35],
      [at(50), 0.35],
      [at(50), 0.12],
      [at(70), 0.12],
    ])
    const jump = Math.abs(step.wall[49] - step.wall[51])
    check(
      'a step in the line comes out as a step in the wall',
      jump > 0.2,
      `${step.wall[49].toFixed(3)} then ${step.wall[51].toFixed(3)}`
    )
    // The brushes are held to the opposite promise, and it is worth stating the
    // two beside each other: this is the tool you reach for BECAUSE the others
    // fair themselves off.
    const held = mold(lump, { y: at(50), radius: 0.12, reach: 0.2, bite: 1, tool: 'push' })
    const brushed = Math.abs(held.wall[49] - held.wall[51])
    check(
      'where a brush held at the same place cannot',
      brushed < jump / 4,
      `brush leaves ${brushed.toFixed(4)} against the line's ${jump.toFixed(4)}`
    )
  }

  {
    // A CURVE THAT DOUBLES BACK still has to come out as a wall, because a wall
    // is one radius per ring and there is no such thing as two. The outermost
    // crossing is the reading -- the material a real tool would leave -- and the
    // point of checking it is that the alternative is a crash or a hole.
    const looped = sculpt(lump, [
      [at(40), 0.1],
      [at(60), 0.3],
      [at(40), 0.2],
      [at(70), 0.25],
    ])
    const covered = looped.wall.slice(40, 71)
    check(
      'a line that doubles back still leaves one radius per ring',
      covered.every((r) => Number.isFinite(r) && r >= 0),
      `${Math.min(...covered).toFixed(3)}..${Math.max(...covered).toFixed(3)}`
    )
    // At the height it crosses three times, the wall stands at the furthest of
    // them rather than at whichever the walk met first.
    check(
      'taking the outermost crossing where there are several',
      looped.wall[40] >= 0.2 - 1e-9,
      `${looped.wall[40].toFixed(4)}`
    )
  }

  {
    // CLAMPED like every other wholesale write, so a line drawn past the flare
    // limit or through the axis lands on the piece the stock allows rather than
    // turning the section inside out. Negative radii are the one that matters:
    // they wind the sweep the wrong way round.
    const { min, max } = wallBounds(lump.radius)
    const wild = sculpt(lump, [
      [at(10), -5],
      [at(80), 99],
    ])
    check(
      'a line drawn off the end of the world is clamped to the lump',
      wild.wall.every((r) => r >= min - 1e-9 && r <= max + 1e-9),
      `${Math.min(...wild.wall).toFixed(3)}..${Math.max(...wild.wall).toFixed(3)}`
    )
  }

  {
    // A LINE THAT MOVES NOTHING hands back the very lump it was given, the way
    // `mold` and `withWall` do. It is what lets the panel tell a press that did
    // nothing from one that did -- see `SculptPanel`, which says so out loud
    // rather than leaving the button looking broken.
    const flat = sculpt(lump, [
      [at(0), lump.radius],
      [at(CLAY_RINGS - 1), lump.radius],
    ])
    check('a line drawn along the wall it already has changes nothing', flat === lump, '')
    check('and one point is not a line at all', sculpt(lump, [[at(30), 0.2]]) === lump, '')
    check('nor is none', sculpt(lump, []) === lump, '')
  }

  {
    // WHICH WALL YOU DREW ON IS NOT A FACT ABOUT THE PIECE. The screen is a
    // section, so there are two walls on it to point at, and the knots follow
    // the pointer onto whichever one was clicked -- see `toClay` in
    // `SculptLayer`. A turned piece is the same all the way round, so the same
    // line drawn on the left has to leave the same wall as on the right.
    const right = sculpt(lump, [
      [at(25), 0.3],
      [at(55), 0.12],
      [at(75), 0.28],
    ])
    const left = sculpt(lump, [
      [at(25), -0.3],
      [at(55), -0.12],
      [at(75), -0.28],
    ])
    check(
      'a profile drawn on the far wall leaves the same piece',
      left.wall.every((r, i) => Math.abs(r - right.wall[i]) < 1e-12),
      `worst ${Math.max(...left.wall.map((r, i) => Math.abs(r - right.wall[i]))).toExponential(1)}`
    )
    // And a line dragged ACROSS the axis pinches the wall to nothing there
    // rather than jumping between two radii, which is what a tool run through
    // the centre would really leave.
    const through = sculpt(lump, [
      [at(40), -0.25],
      [at(60), 0.25],
    ])
    check(
      'and one drawn across the axis pinches the wall to nothing',
      Math.min(...through.wall.slice(40, 61)) < 1e-9,
      `${Math.min(...through.wall.slice(40, 61)).toExponential(1)}`
    )
  }

  {
    // THE SPAN IS THE LINE'S OWN, not the piece's: a line drawn entirely off the
    // top of the lump touches no ring, and must not be read as "the whole wall"
    // by an empty span.
    const past = sculpt(lump, [
      [lump.height * 2, 0.1],
      [lump.height * 3, 0.1],
    ])
    check('a line drawn clear of the piece leaves it alone', past === lump, '')
  }

  // A CORNER DRAWN BETWEEN TWO RINGS IS STILL A CORNER, which is the one thing
  // this tool exists for and the one thing it used to lose.
  //
  // Every check above draws its knots AT ring heights -- `at(i)` -- which is
  // exactly the case that always worked, and is why none of them caught this.
  // A hand does not click on ring heights. A knot that falls BETWEEN two rings
  // was never visited by the sampling: both rings either side landed short by
  // about the same amount, and two neighbouring rings at nearly one radius is
  // not a point, it is a FLAT. A zigzag of six corners came back with six
  // little chamfers on it. See `onRings`.
  {
    const step = lump.height / (CLAY_RINGS - 1)
    /** Half a ring up from ring `i`: the worst place a knot can fall. */
    const between = (i: number) => at(i) + step / 2

    const zig: Pt[] = [
      [between(4), 0.3],
      [between(20), 0.08],
      [between(38), 0.3],
      [between(55), 0.08],
      [between(72), 0.3],
    ]
    const cut = sculpt(lump, zig)

    // THE RADIUS IS EXACT. What gives is the HEIGHT, by under half a ring, and
    // that is the trade: a corner has a height and a radius, the grid can hold
    // one of them, and the sharp one is the one worth keeping.
    let worstRadius = 0
    let worstHeight = 0
    for (const [h, r] of zig) {
      let nearest = Infinity
      let where = 0
      for (let i = 0; i < CLAY_RINGS; i += 1) {
        if (Math.abs(at(i) - h) > step) continue
        if (Math.abs(cut.wall[i] - r) < nearest) {
          nearest = Math.abs(cut.wall[i] - r)
          where = at(i)
        }
      }
      worstRadius = Math.max(worstRadius, nearest)
      worstHeight = Math.max(worstHeight, Math.abs(where - h))
    }
    check(
      'a corner drawn between two rings lands on the wall exactly',
      worstRadius < 1e-9,
      `worst ${(worstRadius * 100).toExponential(1)} mm out in radius`
    )
    check(
      'and pays for it in height, by under half a ring',
      worstHeight <= step / 2 + 1e-9,
      `worst ${(worstHeight * 100).toFixed(2)} mm, against a ${((step / 2) * 100).toFixed(2)} mm half-ring`
    )

    // AND THERE IS NO FLAT. This is the failure as the eye met it: the section
    // drew a little vertical facet where a point had been asked for. Two
    // neighbouring rings at one radius, inside a run that is sloping everywhere
    // else, is that facet as a number.
    //
    // Measured strictly INSIDE the span. Outside it the wall is the untouched
    // lump, which is flat because it is a cylinder -- see the tool's own rule
    // that it leaves the wall above and below the line alone.
    let flats = 0
    for (let i = 1; i < CLAY_RINGS; i += 1) {
      if (at(i - 1) < between(4) || at(i) > between(72)) continue
      if (Math.abs(cut.wall[i] - cut.wall[i - 1]) < 1e-9) flats += 1
    }
    check('and no flat where a point was asked for', flats === 0, `${flats} pairs of rings at one radius`)

    // THE RUNS BETWEEN THE CORNERS STAY STRAIGHT, which is the other half of
    // what `Fit to line` off promises -- and the thing a fix that only nudged
    // the ring nearest each corner would have broken, leaving a kink a ring
    // short of every knot.
    //
    // STRAIGHTNESS IS MEASURED ON THE WALL ITSELF, as a second difference: a
    // run of rings whose radius steps by the same amount every time is a
    // straight segment, and it says so without restating where the tool decided
    // to put the corners.
    let worstBend = 0
    const corner = zig.map(([h]) => Math.round(h / step))
    for (let k = 1; k < corner.length; k += 1) {
      for (let i = corner[k - 1] + 2; i <= corner[k]; i += 1) {
        const second = cut.wall[i] - 2 * cut.wall[i - 1] + cut.wall[i - 2]
        worstBend = Math.max(worstBend, Math.abs(second))
      }
    }
    check(
      'and the straight runs between them stay straight',
      worstBend < 1e-12,
      `worst kink ${(worstBend * 100).toExponential(1)} mm between one ring and the next`
    )

    // AND IT SWEEPS AS CORNERS. The mesh reads the wall, so a corner the wall
    // does not hold is a corner no amount of creasing can put back -- which is
    // why this had to be fixed here rather than in `meridian`. Five knots is
    // three interior corners, and the two ends are where the line meets the
    // wall it was drawn onto.
    const span = pieceSpan(cut) as { lo: number; hi: number }
    const heights: number[] = []
    const radii: number[] = []
    for (let i = span.lo; i <= span.hi; i += 1) {
      heights.push(ringHeight(cut, i))
      radii.push(cut.wall[i])
    }
    const line = meridian(heights, radii)
    check(
      'so the sweep finds a crease at every corner drawn',
      line.seams.filter(Boolean).length >= 3,
      `${line.seams.filter(Boolean).length} creases for ${zig.length} knots`
    )
    check(
      'and the whole zigzag costs a dozen rings, not ninety-six',
      line.heights.length < 20,
      `${line.heights.length} rings`
    )

    // TWO KNOTS INSIDE ONE RING GAP land on the same ring, and a wall of one
    // radius per height cannot hold two. It reads as a STEP -- the outermost of
    // the two, which is the rule the whole tool is read by -- rather than as a
    // hole or a NaN, and that is the only case snapping the heights can create
    // that the drawn line could not.
    const tight = sculpt(lump, [
      [at(20), 0.35],
      [at(40) + step * 0.1, 0.35],
      [at(40) + step * 0.3, 0.15],
      [at(70), 0.15],
    ])
    check(
      'two knots inside one ring gap read as a step, not a hole',
      tight.wall[40] === 0.35 && tight.wall[41] === 0.15,
      `${tight.wall[40].toFixed(3)} then ${tight.wall[41].toFixed(3)}`
    )
    check('with a whole wall behind it', tight.wall.every(Number.isFinite), '')

    // AND A KNOT DRAWN CLEAR OF THE PIECE IS NOT DRAGGED BACK ONTO IT. A profile
    // is often aimed past the stock -- run the line out above the lump to hold
    // an angle -- and clamping that knot to the rim would tilt the segment
    // reaching it, changing the shape everywhere it crosses clay. The grid
    // carries on past both ends instead.
    const over = sculpt(lump, [
      [at(50), 0.3],
      [lump.height + step * 3.4, 0.1],
    ])
    const held = (over.wall[95] - over.wall[50]) / (at(95) - at(50))
    near(
      'a line aimed past the rim keeps the angle it was drawn at',
      held,
      (0.1 - 0.3) / (lump.height + step * 3 - at(50)),
      1e-12
    )
  }
}


// --- the laser cutter's kerf --------------------------------------------------
//
// Cutting with a LINE rather than a plane, which is the one thing `cut.ts`
// cannot do and the whole of what the third screen is for. The line is swept
// into a thin closed wall, that wall is subtracted, and the pieces are whatever
// the result falls into -- so what has to hold here is that a block conserves
// its volume less the slot, that a line which misses leaves it alone, and that
// the pieces come back as separate solids rather than as one geometry holding
// two shells. See `laserCut.ts`.
console.log('\nThe laser cutter cuts with a line, and the line burns a kerf')
{
  const FRONT: LaserFace = { axis: 2, sign: 1 }

  // The frame each face is drawn in. It has to be right for all six or a line
  // drawn on one of them lands somewhere else entirely -- and the handedness is
  // what the wall builder leans on to decide which way its faces point.
  for (const face of [
    { axis: 0, sign: 1 },
    { axis: 0, sign: -1 },
    { axis: 1, sign: 1 },
    { axis: 1, sign: -1 },
    { axis: 2, sign: 1 },
    { axis: 2, sign: -1 },
  ] as LaserFace[]) {
    const { u, v, n } = faceBasis(face)
    const name = `axis ${face.axis}${face.sign > 0 ? '+' : '-'}`
    check(`${name}: the face frame is right-handed`, u.clone().cross(v).distanceTo(n) < 1e-9, '')
    check(`${name}: and its axes are unit and square`, Math.abs(u.length() - 1) < 1e-9 && Math.abs(u.dot(n)) < 1e-9, '')
  }

  near('a fresh block is the unit cube', pieceVolume(freshBlock()), 1, 1e-6)

  // A CUT CONSERVES THE BLOCK, less the slot it burned. That is the one
  // arithmetic claim the whole screen rests on: material is removed by the kerf
  // and by nothing else.
  const down = cutPieces([freshBlock()], [[[0, -0.2], [0, 0.2]]], FRONT)
  check('a line down the front splits the block in two', down.pieces.length === 2, `${down.pieces.length}`)
  check('and reports the one piece that came apart', down.split === 1, `${down.split}`)
  near(
    'the halves are the block less one kerf',
    down.pieces.reduce((t, g) => t + pieceVolume(g), 0),
    1 - LASER_KERF,
    2e-3
  )
  check(
    'cut down the middle they are equal',
    Math.abs(pieceVolume(down.pieces[0]) - pieceVolume(down.pieces[1])) < 1e-3,
    down.pieces.map((g) => pieceVolume(g).toFixed(4)).join(' / ')
  )

  // WHAT THE CUT MADE, all of it, because which piece is waste is not this
  // function's to decide -- it hands back the bed and the screen applies the
  // rule. See `keeperSet` in `laserStore`.
  //
  // IT USED TO ALSO HAND BACK WHICH OF THEM THIS CUT MADE, so that the screen
  // could offer a choice bounded to the last act. Nothing needs it now: the
  // keeper is the piece under the drawing and everything else is offcut, and
  // that question is answered the same way for a sliver cut three cuts ago.
  const off = cutPieces([freshBlock()], [[[0.3, -0.2], [0.3, 0.2]]], FRONT)
  check('a cut hands back both pieces', off.pieces.length === 2, `${off.pieces.length}`)
  // Biggest first, so a screen reading down the list reads down in size.
  check(
    'biggest first',
    pieceVolume(off.pieces[0]) > pieceVolume(off.pieces[1]),
    off.pieces.map((g) => pieceVolume(g).toFixed(4)).join(' / ')
  )
  near('and the last of them is the sliver it looks like', pieceVolume(off.pieces[1]), 0.2 - LASER_KERF / 2, 5e-3)

  // WHICH PIECE IS THE WORK, asked of the FACE rather than of the solid: the
  // reference sits in the middle and the line is drawn round it, so the piece
  // whose own share of the face covers the middle is the one to keep. This is
  // the test the whole choice now rests on -- see `touchesFacePoint`.
  check(
    'the piece holding the middle of the face is the big one',
    touchesFacePoint(off.pieces[0], FRONT, [0, 0]),
    'the offcut side does not hold it: ' + `${touchesFacePoint(off.pieces[1], FRONT, [0, 0])}`
  )
  check(
    'and the sliver holds a point over its own ground',
    touchesFacePoint(off.pieces[1], FRONT, [0.4, 0]) && !touchesFacePoint(off.pieces[0], FRONT, [0.4, 0]),
    ''
  )
  // NOBODY HOLDS A POINT IN THE KERF, which is what makes the fallback in
  // `keeperSet` a case that really happens: a line drawn straight through the
  // middle leaves the middle in the slot the beam took out.
  {
    const halved = cutPieces([freshBlock()], [[[0, -0.6], [0, 0.6]]], FRONT)
    check(
      'and a point in the slot itself is held by neither piece',
      halved.pieces.every((g) => !touchesFacePoint(g, FRONT, [0, 0])),
      `${halved.pieces.filter((g) => touchesFacePoint(g, FRONT, [0, 0])).length} of them hold it`
    )
    // A face the cut never reached still answers, and answers about ITSELF: the
    // two halves each hold their own half of the top.
    const TOP: LaserFace = { axis: 1, sign: 1 }
    check(
      'a piece is asked about the face being cut, not about the block',
      halved.pieces.filter((g) => touchesFacePoint(g, TOP, [0.25, 0])).length === 1,
      `${halved.pieces.filter((g) => touchesFacePoint(g, TOP, [0.25, 0])).length}`
    )
  }
  // AND A STROKE THAT WANDERED OFF THE FACE AND BACK is the case the old rule
  // could not describe at all: three pieces, one of them the work, and the
  // other two waste TOGETHER rather than one of them being lit and the third
  // left with nothing that could be said about it.
  {
    const wander: LaserPt[] = [
      [-0.6, 0.2], [-0.1, 0.2], [-0.1, -0.6], [0.1, -0.6], [0.1, 0.2], [0.6, 0.2],
    ]
    const three = cutPieces([freshBlock()], [wander], FRONT)
    check('a stroke that leaves the face and comes back cuts three', three.pieces.length === 3, `${three.pieces.length}`)
    const holds = three.pieces.filter((g) => touchesFacePoint(g, FRONT, [0, 0]))
    check('and exactly one of the three holds the middle', holds.length === 1, `${holds.length}`)
    check(
      'leaving two to light as waste',
      three.pieces.length - holds.length === 2,
      `${three.pieces.length - holds.length}`
    )
  }

  // A miss has to be reported rather than silently doing nothing, or the button
  // reads as broken -- the same lesson the plane cut's receipt already carries.
  const missed = cutPieces([freshBlock()], [[[2, 2], [2, 2.4]]], FRONT)
  check('a line clear of the block cuts nothing', missed.split === 0 && missed.pieces.length === 1, `${missed.pieces.length}`)
  check('and leaves the block whole', pieceVolume(missed.pieces[0]) > 0.99, pieceVolume(missed.pieces[0]).toFixed(4))

  // Every drawn end is carried on to the border, so a stroke that stops in the
  // middle of a face still separates the block. Without it the wall has a dead
  // end and the cut is a slot rather than a cut.
  const carried = carryToBorder([[0, -0.2], [0, 0.2]])
  check(
    'an open line is carried well past the face',
    carried[0][1] < -0.5 && carried[carried.length - 1][1] > 0.5,
    `${carried[0][1].toFixed(2)} .. ${carried[carried.length - 1][1].toFixed(2)}`
  )
  check('along the tangent it was already travelling', Math.abs(carried[0][0]) < 1e-9, '')
  const short = cutPieces([freshBlock()], [[[-0.15, -0.05], [-0.15, 0.05]]], FRONT)
  check('so a stroke across a tenth of the face still cuts it in two', short.pieces.length === 2, `${short.pieces.length}`)

  // Cuts stack, and a later one acts on every piece it crosses -- there being
  // no selection on that screen to aim it with.
  const again = cutPieces(down.pieces, [[[-0.4, 0], [0.4, 0]]], FRONT)
  check('a second cut across both pieces makes four', again.pieces.length === 4, `${again.pieces.length}`)
  check('and reports both of them coming apart', again.split === 2, `${again.split}`)

  // A curve cuts exactly as a straight line does, which is the point of
  // sweeping a wall rather than intersecting a half-space.
  const control: LaserPt[] = [[-0.2, -0.3], [0.15, 0], [-0.1, 0.3]]
  const curved = cutPieces([freshBlock()], [bezierChain(control, fittedHandles(control), 20)], FRONT)
  check('a curved line splits it too', curved.pieces.length === 2, `${curved.pieces.length}`)
  near('and still conserves the block', curved.pieces.reduce((t, g) => t + pieceVolume(g), 0), 1 - LASER_KERF, 4e-3)

  // A LOOP CUTS OUT WHAT IT ENCIRCLES, which is the one thing a line across
  // the face cannot do: an open cut divides the block, and a closed one drops
  // an island out of the middle of it. The whole of the difference is that the
  // ends are not carried to the border and the wall is bent round into a ring
  // -- see `isClosedLine`, which is how the line says which of the two it is.
  {
    // A square, closed the way `draftLine` closes one: by writing the first
    // point out again at the end.
    const corners: LaserPt[] = [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]]
    const loop: LaserPt[] = [...corners, corners[0]]

    check('a line that ends where it began is read as closed', isClosedLine(loop), '')
    check('and one that does not, is not', !isClosedLine(corners), '')
    // Three entries cannot enclose anything -- they are one segment out and
    // back -- so the test refuses them rather than sweeping a ring of no area.
    check(
      'two points bridged back enclose nothing',
      !isClosedLine([[0, 0], [0.1, 0], [0, 0]] as LaserPt[]),
      ''
    )

    // THE CARRY STANDS ASIDE. Firing two rays off the seam and out through the
    // border is exactly the wrong thing to do to a ring: it would turn the loop
    // into a stroke wandering off the face.
    const walked = simplify(stations(loop))
    check('a loop survives the walk still closed', isClosedLine(walked), `${walked.length}`)
    check(
      'and the carry leaves it exactly alone',
      carryToBorder(walked).length === walked.length,
      `${carryToBorder(walked).length} against ${walked.length}`
    )

    // The wall is a torus rather than a capped tube: every station has a
    // neighbour on both sides, and there is no end to cap.
    const ring = buildKerfWall(carryToBorder(walked), FRONT)
    const stroke = buildKerfWall(carryToBorder(simplify(stations(corners))), FRONT)
    check('a closed line sweeps a wall', ring !== null, '')
    check(
      'with no caps on it -- one span per corner, four quads each',
      ring !== null && ring.getAttribute('position').count / 3 === 4 * 4 * 2,
      `${ring ? ring.getAttribute('position').count / 3 : 0} triangles`
    )
    check(
      'where the open line of the same corners is capped at both ends',
      stroke !== null && ring !== null &&
        stroke.getAttribute('position').count > ring.getAttribute('position').count,
      ''
    )

    const island = cutPieces([freshBlock()], [loop], FRONT)
    check('and it drops an island out of the block', island.pieces.length === 2, `${island.pieces.length}`)
    check('reported as one piece coming apart', island.split === 1, `${island.split}`)
    // AND THE ISLAND IS THE KEEPER, which is the case the old rule got exactly
    // backwards: it lit the smallest, and the smallest is the part you drew
    // round. See `keeperSet`.
    check(
      'and the island it dropped out is the piece holding the middle',
      touchesFacePoint(island.pieces[1], FRONT, [0, 0]) &&
        !touchesFacePoint(island.pieces[0], FRONT, [0, 0]),
      `${island.pieces.map((g) => touchesFacePoint(g, FRONT, [0, 0])).join(' / ')}`
    )
    // The island is the square less half a kerf all the way round, and the
    // block is the rest less the other half: what the loop took is its
    // perimeter times the slot, and nothing else.
    near('the island is the square it encircled', pieceVolume(island.pieces[1]), (0.4 - LASER_KERF) ** 2, 1e-3)
    near(
      'and the block is whole less the ring of slot',
      island.pieces.reduce((t, g) => t + pieceVolume(g), 0),
      1 - 4 * 0.4 * LASER_KERF,
      2e-3
    )

    // A LOOP CAN MISS TOO, and has to say so the same way a stroke does -- the
    // carry is what used to guarantee a line reached the block, and a ring
    // gives that up by design.
    const clear = cutPieces(
      [freshBlock()],
      [[[2, 2], [2.2, 2], [2.1, 2.2], [2, 2]] as LaserPt[]],
      FRONT
    )
    check('a loop drawn clear of the block cuts nothing', clear.split === 0, `${clear.split}`)

    // And one hanging off the edge is not a loop that failed: it bites the
    // corner off, which is the answer a ring gives on its own with nothing
    // special written for it.
    const bite = cutPieces(
      [freshBlock()],
      [[[0.4, -0.1], [0.7, -0.1], [0.7, 0.1], [0.4, 0.1], [0.4, -0.1]] as LaserPt[]],
      FRONT
    )
    check('a loop over the border takes a bite out of it', bite.split === 1, `${bite.split}`)
    near('of just the part that was inside', pieceVolume(bite.pieces[1]), 0.1 * 0.2 - LASER_KERF * 0.5, 3e-3)

    // A CURVED LOOP IS THE SAME LOOP. The chain closes on its own first point
    // exactly, which is what keeps `isClosedLine` true all the way down.
    const round = bezierChain(corners, fittedHandles(corners, true), 16, true)
    check('a closed chain comes back to its first point', isClosedLine(round), '')
    check(
      'exactly, rather than nearly',
      round[0][0] === round[round.length - 1][0] && round[0][1] === round[round.length - 1][1],
      ''
    )
    // The seam is not a corner: on a ring every point's tangent is fitted from
    // the neighbours either side of it, the first point included.
    const fitted = fittedHandles(corners, true)
    const open = fittedHandles(corners)
    // THE SEAM IS NOT AN END ANY MORE, which is the claim worth making and is
    // about DIRECTION rather than length: on a ring the first point's tangent
    // is the chord between the two neighbours either side of it, exactly as at
    // every other point, where an open run's first handle can only point at the
    // second point. Read as cross products against that chord -- zero is
    // parallel -- because the two are the same tangent only when one of them is
    // wrong.
    const chord: LaserPt = [corners[1][0] - corners[3][0], corners[1][1] - corners[3][1]]
    const askew = (h: LaserPt) => Math.abs(h[0] * chord[1] - h[1] * chord[0])
    check(
      'the seam is fitted from both its neighbours, not just the next point',
      askew(fitted[0]) < 1e-12,
      askew(fitted[0]).toExponential(1)
    )
    check(
      'which is a different tangent from the one an open run ends on',
      askew(open[0]) > 1e-6,
      askew(open[0]).toExponential(1)
    )
    // Every handle on a ring is the same sixth of the chord between the two
    // neighbours, so a square's four come out equal -- which is the property a
    // one-sided end difference breaks.
    const reaches = fitted.map((h) => Math.hypot(h[0], h[1]))
    check(
      'so a square encircled is fitted evenly all the way round',
      Math.max(...reaches) - Math.min(...reaches) < 1e-12,
      reaches.map((r) => r.toFixed(6)).join(' ')
    )
    const curl = cutPieces([freshBlock()], [round], FRONT)
    check('and a curved loop drops an island too', curl.pieces.length === 2, `${curl.pieces.length}`)
    check(
      'a rounder one than the square it was fitted through',
      pieceVolume(curl.pieces[1]) > pieceVolume(island.pieces[1]),
      `${pieceVolume(curl.pieces[1]).toFixed(4)} against ${pieceVolume(island.pieces[1]).toFixed(4)}`
    )

    // AND AN OPEN RUN IS UNTOUCHED BY ANY OF IT, which is the claim that keeps
    // the loop from being a change to the tool rather than an addition: the
    // same four corners left open still cut clean across the block.
    const still = cutPieces([freshBlock()], [corners], FRONT)
    check('the same points left open still cut across', still.pieces.length === 2, `${still.pieces.length}`)
    check('and are still carried to the border', carryToBorder(corners).length === corners.length + 2, '')
  }

  // WHAT THE CURVE IS. Fit and Manual are one Bezier chain given different
  // handles, which is what lets the tool switch between them without the line
  // moving -- and the fitted curve has to pass through every placed point, or
  // "Fit to line" is not fitting to anything.
  {
    const pts: LaserPt[] = [[-0.3, -0.3], [0, 0.1], [0.3, -0.2]]
    const curve = bezierChain(pts, fittedHandles(pts), 24)
    const misses = pts.map((p) => Math.min(...curve.map((c) => Math.hypot(c[0] - p[0], c[1] - p[1]))))
    check('the fitted curve passes through every point', misses.every((d) => d < 1e-9), misses.map((d) => d.toExponential(1)).join(' '))
    const flat: LaserPt[] = [[-0.4, 0], [0, 0], [0.4, 0]]
    check(
      'and collinear points stay collinear',
      bezierChain(flat, fittedHandles(flat), 16).every((p) => Math.abs(p[1]) < 1e-9),
      ''
    )
  }

  // THE STABILISER IS A ROPE, not an average: nothing at all happens inside the
  // slack, and a long pull is followed exactly, one slack behind. That is what
  // lets the recorded line be the line that gets cut.
  {
    let at: LaserPt = [0, 0]
    at = ropeFollow(at, [0.05, 0], 0.1)
    check('a wobble inside the slack moves the tool not at all', at[0] === 0 && at[1] === 0, `${at}`)
    at = ropeFollow(at, [0.5, 0], 0.1)
    near('a long pull drags it to one slack behind', at[0], 0.4, 1e-9)
    near('and with no slack it arrives exactly', ropeFollow(at, [0.5, 0], 0)[0], 0.5, 1e-9)
  }

  // Simplifying is what keeps a cut cheap: a straight stroke arrives with a
  // station every STEP and needs two.
  {
    const dense: LaserPt[] = []
    for (let i = 0; i <= 200; i += 1) dense.push([-0.4 + (i / 200) * 0.8, 0])
    check('a dead straight run simplifies to its two ends', simplify(dense).length === 2, `${simplify(dense).length}`)
    const bend: LaserPt[] = [[-0.4, 0], [0, 0.3], [0.4, 0]]
    check('and a corner is kept', simplify(bend).length === 3, `${simplify(bend).length}`)
    check(
      'so a straight cut is a handful of triangles, not hundreds',
      down.pieces.every((g) => triangleCount(g) < 60),
      down.pieces.map(triangleCount).join(' / ')
    )
  }

  // A CORNER DRAWN WITH POINT CUT IS BURNT WHERE IT WAS DRAWN, which is the one
  // thing `resample` could not do and the reason `stations` exists beside it.
  //
  // `resample` strides the whole polyline at a fixed step and carries the
  // leftover across each vertex -- right for a freehand stroke, whose vertices
  // are pointer samples, and wrong for a line whose vertices ARE the drawing. A
  // stride that steps over a corner never puts a station on it, so what gets
  // burnt is a chord across it: a chamfer where a point was asked for, up to a
  // third of a millimetre off on a 10 cm block. That is further than the slot
  // the cut burns, and four times the budget `simplify` is so careful to stay
  // inside -- the pipeline was strict about its second pass and careless about
  // its first.
  {
    // Deliberately off any multiple of the step, which is what a hand produces
    // and what every check here had quietly avoided by drawing on round
    // numbers.
    const zig: LaserPt[] = [
      [-0.4, -0.34],
      [-0.13, 0.21],
      [0.07, -0.29],
      [0.28, 0.24],
      [0.41, -0.18],
    ]

    /** How far a polyline passes from a point: the cut's own error at a corner. */
    const misses = (poly: LaserPt[], c: LaserPt): number => {
      let off = Infinity
      for (let i = 1; i < poly.length; i += 1) {
        const a = poly[i - 1]
        const b = poly[i]
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const l2 = dx * dx + dy * dy
        const t =
          l2 === 0 ? 0 : Math.min(1, Math.max(0, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / l2))
        off = Math.min(off, Math.hypot(c[0] - (a[0] + dx * t), c[1] - (a[1] + dy * t)))
      }
      return off
    }
    const worstCorner = (pass: (l: LaserPt[]) => LaserPt[]): number => {
      const out = simplify(pass(zig))
      let worst = 0
      for (let k = 1; k < zig.length - 1; k += 1) worst = Math.max(worst, misses(out, zig[k]))
      return worst
    }

    // The fault, kept as a check so nobody puts the stride back.
    check(
      'striding through a corner burns a chamfer where a point was drawn',
      worstCorner(resample) > LASER_KERF / 2,
      `${(worstCorner(resample) * 100).toFixed(3)} mm off, against a ${(LASER_KERF * 100).toFixed(2)} mm slot`
    )
    check(
      'restarting the walk at every vertex burns the corner itself',
      worstCorner(stations) < 1e-12,
      `${(worstCorner(stations) * 100).toExponential(1)} mm off`
    )
    check(
      'and what is left IS the line that was drawn',
      simplify(stations(zig)).length === zig.length,
      `${simplify(stations(zig)).length} stations for ${zig.length} points`
    )

    // AND IT COSTS NOTHING. Every gap stays between half a step and one and a
    // half -- nothing piled up for the wall builder to make a degenerate quad
    // out of, nothing stretched far enough to cut a corner off somewhere else.
    let closest = Infinity
    let widest = 0
    const walked = stations(zig)
    for (let i = 1; i < walked.length; i += 1) {
      const gap = Math.hypot(walked[i][0] - walked[i - 1][0], walked[i][1] - walked[i - 1][1])
      closest = Math.min(closest, gap)
      widest = Math.max(widest, gap)
    }
    check(
      'with every gap still about a step wide',
      closest >= LASER_STEP / 2 - 1e-9 && widest <= LASER_STEP * 1.5 + 1e-9,
      `${(closest * 100).toFixed(3)} to ${(widest * 100).toFixed(3)} mm, against a ${(LASER_STEP * 100).toFixed(2)} mm step`
    )
    check(
      'and no more of them than the stride wanted',
      stations(zig).length <= resample(zig).length,
      `${stations(zig).length} against ${resample(zig).length}`
    )

    // THE WALL STILL CLOSES ROUND THEM. A corner sharper than the sideways
    // offset could fold the wall through itself, which is what the even spacing
    // is really protecting -- so the sharp zigzag is swept and measured, not
    // reasoned about. Signed volume is the whole test: only a closed mesh wound
    // outward lands on a positive number.
    const wall = buildKerfWall(carryToBorder(simplify(stations(zig))), { axis: 2, sign: 1 })
    check('the wall round a sharp zigzag is closed and wound out', wall !== null && signedVolume(wall) > 0, `${wall ? signedVolume(wall).toExponential(2) : 'no wall'}`)

    // AND IT CUTS. The point of a corner is that the block comes apart along
    // it: a zigzag across the face makes two pieces whose volumes still add up
    // to the block less the slot.
    const zagged = cutPieces([freshBlock()], [zig], { axis: 2, sign: 1 })
    check('and a zigzag cut parts the block', zagged.pieces.length === 2, `${zagged.pieces.length} pieces`)
    const held = zagged.pieces.reduce((sum, g) => sum + pieceVolume(g), 0)
    check(
      'with the block conserved but for the slot',
      held < 1 && held > 0.97,
      `${held.toFixed(4)} of the unit block`
    )

    // A FREEHAND STROKE IS UNTOUCHED, which is why `resample` is still there.
    // Its vertices are pointer samples rather than corners, and it reaches this
    // pipeline having already been evened out by `draftLine`.
    const raw: LaserPt[] = []
    for (let i = 0; i <= 400; i += 1) {
      const t = i / 400
      raw.push([-0.45 + t * 0.9, Math.sin(t * 6) * 0.25])
    }
    const stroke = resample(raw)
    check(
      'an evened-out stroke passes through unchanged',
      simplify(stations(stroke)).length === simplify(resample(stroke)).length,
      `${simplify(stations(stroke)).length} against ${simplify(resample(stroke)).length}`
    )
  }

  // AND THE OUTLINE. Three's own `EdgesGeometry` cannot do this one: a boolean
  // leaves T-junctions, so half the shared edges find no partner and every
  // triangle of the fan across a flat cut face is drawn as a silhouette. A cut
  // box has twelve edges and that is a thing worth being able to state.
  {
    const edgeSpan = (g: BufferGeometry) => {
      const a = outlineOf(g).getAttribute('position').array as ArrayLike<number>
      let total = 0
      for (let i = 0; i < a.length; i += 6) {
        total += Math.hypot(a[i + 3] - a[i], a[i + 4] - a[i + 1], a[i + 5] - a[i + 2])
      }
      return total
    }
    const edgeCount = (g: BufferGeometry) => outlineOf(g).getAttribute('position').count / 2
    check('a cube outlines as twelve edges', edgeCount(freshBlock()) === 12, `${edgeCount(freshBlock())}`)
    near('of twelve unit lengths', edgeSpan(freshBlock()), 12, 1e-6)

    const boxes = cutPieces([freshBlock()], [[[0.1, -0.3], [0.1, 0.3]]], FRONT)
    check('and each half of a straight cut as twelve too', boxes.pieces.every((g) => edgeCount(g) === 12), boxes.pieces.map(edgeCount).join(' / '))
    const wide = [0.5 + 0.1 - LASER_KERF / 2, 0.5 - 0.1 - LASER_KERF / 2]
    check(
      'each measuring its own box exactly',
      boxes.pieces.every((g, i) => Math.abs(edgeSpan(g) - (4 * wide[i] + 8)) < 0.02),
      boxes.pieces.map((g, i) => `${edgeSpan(g).toFixed(3)} vs ${(4 * wide[i] + 8).toFixed(3)}`).join(' / ')
    )
    check(
      'and a curved piece outlines its silhouette rather than its facets',
      curved.pieces.every((g) => edgeSpan(g) < 16),
      curved.pieces.map((g) => `${edgeSpan(g).toFixed(1)} over ${triangleCount(g)} facets`).join(' / ')
    )

    // AND A MERGE DOES NOT HATCH ITS SEAM. A union leaves offcuts -- triangles
    // clipped to a hair -- and a sliver's normal is the cross product of two
    // nearly parallel edges, so it points wherever the noise says and both
    // tests above believe it. Left in the adjacency they spray lines across the
    // faces around a weld. See `SLIVER`.
    //
    // A sphere sunk WHOLLY inside a box is the sharpest way to ask, because the
    // right answer is known without measuring anything: none of it can be seen,
    // so the outline is the box's own twelve edges and nothing else. It drew
    // thirty-three.
    const swallowed: SceneObject = {
      ...object(CUBE, [], [], 'swallowed'),
      parts: [
        {
          ...object({ kind: 'sphere', radius: 0.8 }, [], [], 'inside'),
          transform: { ...IDENTITY_TRANSFORM, position: [0, 0.2, 0] },
        },
      ],
    }
    const hidden = evaluateObject(swallowed)
    check(
      'a sphere sunk inside a box leaves the box twelve edges',
      edgeCount(hidden.geometry) === 12,
      `${edgeCount(hidden.geometry)}`
    )
    hidden.geometry.dispose()

    // And one pushed OUT through a face has an answer just as strict, because
    // the shape is still known: every line on it is either an edge of the box
    // or the seam the sphere cuts through it, and NOTHING ELSE IS A LINE. So
    // each segment's middle has to sit either on two of the box's planes, which
    // is what being one of its edges means, or on one of them and on the
    // sphere, which is what being on the seam means. Anything else is a line
    // adrift in the middle of a face. Seventeen were.
    const at: Vec3 = [0.75, -0.45, 1.15]
    const through: SceneObject = {
      ...object(CUBE, [], [], 'through'),
      parts: [{ ...object(SPHERE, [], [], 'poking'), transform: { ...IDENTITY_TRANSFORM, position: at } }],
    }
    const pushed = evaluateObject(through)
    const seam = outlineOf(pushed.geometry).getAttribute('position').array as ArrayLike<number>
    const centre = new Vector3(...at)
    let adrift = 0
    for (let i = 0; i < seam.length; i += 6) {
      const mid = new Vector3(
        (seam[i] + seam[i + 3]) / 2,
        (seam[i + 1] + seam[i + 4]) / 2,
        (seam[i + 2] + seam[i + 5]) / 2
      )
      const planes = [mid.x, mid.y, mid.z].filter((n) => Math.abs(Math.abs(n) - 1) < 1e-6).length
      // A chord of the seam sags inside the sphere by its length squared over
      // eight radii, a couple of thousandths at the facet size a sphere has.
      const onSeam = planes >= 1 && Math.abs(mid.distanceTo(centre) - 1) < 5e-3
      if (planes < 2 && !onSeam) adrift += 1
    }
    check(
      'and one pushed through draws the seam and nothing adrift on a face',
      adrift === 0,
      `${adrift} of ${seam.length / 6}`
    )
    pushed.geometry.dispose()
  }
}

console.log('\nThe symmetry axis divides the face, and reflects what is drawn in one part')
{
  /** The area of a convex polygon, by the shoelace: what a part is worth. */
  const area = (poly: LaserPt[]): number => {
    let sum = 0
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      sum += a[0] * b[1] - b[0] * a[1]
    }
    return Math.abs(sum) / 2
  }

  // The face every one of these is aimed at, named here as it is in the section
  // above rather than reached for across a block scope.
  const FRONT: LaserFace = { axis: 2, sign: 1 }
  const upright: MirrorAxis = FRESH_MIRROR
  const cross: MirrorAxis = { mode: 'cross', angle: 90, part: 0 }

  // WHICH PART A POINT IS IN. An upright mirror is the one a hand reaches for
  // first, and it has to divide the face the way a person looking at it would:
  // left and right, not top and bottom.
  check('an upright mirror puts the left of the face in the part it opens on', partOf([-0.3, 0], upright) === 0, `${partOf([-0.3, 0], upright)}`)
  check('and the right of it in the other', partOf([0.3, 0], upright) === 1, `${partOf([0.3, 0], upright)}`)
  check('while a cross tells all four apart', new Set([
    partOf([-0.3, 0.3], cross),
    partOf([0.3, 0.3], cross),
    partOf([0.3, -0.3], cross),
    partOf([-0.3, -0.3], cross),
  ]).size === 4, '')

  // AND WHAT EACH PART IS WORTH. Half the face under a mirror and a quarter
  // under a cross, which is the claim the dimming on screen is making.
  near('a mirror halves the face', area(partPolygon(upright, 0, 0.5)), 0.5, 1e-9)
  near('and a cross quarters it', area(partPolygon(cross, 2, 0.5)), 0.25, 1e-9)
  near(
    'with the four quarters accounting for the whole face',
    [0, 1, 2, 3].reduce((t, part) => t + area(partPolygon(cross, part, 0.5)), 0),
    1,
    1e-9
  )

  // CLIPPING. A line that wanders over the axis is cut where it crosses, and
  // the survivor ENDS ON THE AXIS rather than a hair short of it -- which is
  // what makes the two mirrored halves meet instead of leaving a thread of
  // material standing between them.
  const kept = clipToPart([[-0.4, 0], [0.4, 0]], upright)
  check('a line crossing the axis is clipped to one run', kept.length === 1, `${kept.length}`)
  near('ending exactly on the axis', kept[0][kept[0].length - 1][0], 0, 1e-12)
  check('and keeping the end it was drawn from', kept[0][0][0] === -0.4, `${kept[0][0][0]}`)
  check(
    'a line drawn wholly in a dimmed part survives nothing at all',
    clipToPart([[0.2, 0], [0.4, 0]], upright).length === 0,
    ''
  )
  check(
    'and one that leaves and comes back is two runs rather than one',
    clipToPart([[-0.4, 0], [0.1, 0], [0.1, 0.2], [-0.4, 0.2]], upright).length === 2,
    ''
  )

  // THE REFLECTIONS. Two lines under a mirror and four under a cross, and the
  // copy lands where the mirror says rather than merely somewhere else.
  const drawn: LaserPt[] = [[-0.4, -0.1], [-0.2, 0.3]]
  const pair = mirrorLines(drawn, upright)
  check('a mirror makes two lines of one', pair.length === 2, `${pair.length}`)
  check('the first being what was drawn', pair[0][0][0] === -0.4 && pair[0][0][1] === -0.1, '')
  near('and the second its reflection across the axis', pair[1][0][0], 0.4, 1e-12)
  near('at the same height', pair[1][0][1], -0.1, 1e-12)
  // The cross opens on the quadrant above the middle and to the left of it, so
  // a line for it has to be drawn there -- one that strays over an arm would be
  // testing the clip rather than the reflections.
  const quadrant: LaserPt[] = [[-0.4, 0.1], [-0.2, 0.3]]
  const four = mirrorLines(quadrant, cross)
  check('a cross makes four', four.length === 4, `${four.length}`)
  check(
    'the fourth being the half turn, which is the copy easiest to forget',
    four.some((one) => Math.abs(one[0][0] - 0.4) < 1e-12 && Math.abs(one[0][1] + 0.1) < 1e-12),
    four.map((one) => `(${one[0][0].toFixed(2)}, ${one[0][1].toFixed(2)})`).join(' ')
  )
  check(
    'and every one of them a corner of the same rectangle about the middle',
    new Set(four.map((one) => `${Math.abs(one[0][0]).toFixed(6)},${Math.abs(one[0][1]).toFixed(6)}`)).size === 1,
    ''
  )

  // A SLANTED MIRROR IS THE SAME CLAIM, and it is the one an implementation
  // that only knew about right angles would get wrong: reflecting across 45
  // degrees swaps a point's two coordinates rather than negating one of them.
  const across = images([0.3, 0.1], { mode: 'line', angle: 45, part: 0 })[1]
  near('a mirror at 45 degrees swaps a point about the diagonal', across[0], 0.1, 1e-12)
  near('both ways', across[1], 0.3, 1e-12)

  // THE STOPS. Fixed at every 45, with the panel's number saying how near you
  // have to come -- so an angle between two stops stays reachable by hand.
  near('a swing near square holds at square', snapAxisAngle(88, 8), 90, 1e-12)
  near('and one well clear of a stop is left where the hand put it', snapAxisAngle(70, 8), 70, 1e-12)
  near('with the stops off, nothing is pulled anywhere', snapAxisAngle(88, 0), 88, 1e-12)
  near('the diagonal is a stop as much as the square is', snapAxisAngle(43, 8), DETENT, 1e-12)
  near('and half a turn is the whole range, a line having no ends to tell apart', snapAxisAngle(190, 0), 10, 1e-12)

  // HALF A SHAPE DRAWN AGAINST THE MIRROR IS A RING, and this is the check that
  // exists because it once was not. A silhouette drawn from the axis, round,
  // and back to the axis reads as closed on screen the moment the mirror
  // completes it -- and it IS closed, being one loop written in two pieces. Sent
  // to the laser as two separate open lines, each end was carried out to the
  // border along its own tangent, and the block came back slashed corner to
  // corner by a cut nobody drew.
  {
    const half: LaserPt[] = [
      [0, 0.3],
      [-0.3, 0.3],
      [-0.3, -0.3],
      [0, -0.3],
    ]
    const sewn = mirrorLines(half, upright)
    check('half a shape drawn to the axis comes back as one line', sewn.length === 1, `${sewn.length}`)
    check('and that line is closed', isClosedLine(sewn[0]), `${sewn[0].length} points`)
    check(
      'closed EXACTLY, which is the only thing the sweep reads',
      sewn[0][0][0] === sewn[0][sewn[0].length - 1][0] &&
        sewn[0][0][1] === sewn[0][sewn[0].length - 1][1],
      ''
    )
    check(
      'and it goes all the way round rather than doubling back',
      sewn[0].some((p) => p[0] > 0.29) && sewn[0].some((p) => p[0] < -0.29),
      ''
    )

    // AND IT DROPS AN ISLAND OUT, which is the whole of what the user was
    // asking for: the ring the two halves make, cut out in one act.
    const island = cutPieces([freshBlock()], sewn, FRONT)
    check('cutting it leaves the block and one island', island.pieces.length === 2, `${island.pieces.length}`)
    near(
      'the island being the square the two halves enclosed',
      pieceVolume(island.pieces[1]),
      (0.6 - LASER_KERF) ** 2,
      3e-3
    )

    // A HAND DOES NOT LAND ON THE AXIS EXACTLY, so an end that stops a slot's
    // width short of it is taken to be on it. Below that the two halves cannot
    // be told apart by the laser anyway.
    const nearly: LaserPt[] = [
      [-0.0005, 0.3],
      [-0.3, 0.3],
      [-0.3, -0.3],
      [-0.0005, -0.3],
    ]
    check('an end a hair short of the axis still closes the ring', mirrorLines(nearly, upright).length === 1, '')
    check(
      'while one a plain distance short stays two open lines',
      mirrorLines(
        [
          [-0.05, 0.3],
          [-0.3, 0.3],
          [-0.3, -0.3],
          [-0.05, -0.3],
        ],
        upright
      ).length === 2,
      ''
    )

    // ONE END ON THE AXIS IS NOT A RING, but it is still ONE line: the two
    // copies are joined where they meet, so what crosses the mirror is a single
    // stroke carried out to the border at each far end rather than two strokes
    // each carried out of the middle of the block.
    const single = mirrorLines(
      [
        [0, 0],
        [-0.3, 0.4],
      ],
      upright
    )
    check('a line touching the axis at one end is sewn into one', single.length === 1, `${single.length}`)
    check('and left open, having nowhere else to meet', !isClosedLine(single[0]), '')

    // A CROSS CLOSES A QUARTER THE SAME WAY, through three joins rather than
    // one: the quarter, its two reflections and the half turn come back round
    // to where they started.
    const quarterRing = mirrorLines(
      [
        [0, 0.3],
        [-0.2, 0.2],
        [-0.3, 0],
      ],
      { mode: 'cross', angle: 90, part: 0 }
    )
    check('a quarter drawn arm to arm closes into one ring', quarterRing.length === 1, `${quarterRing.length}`)
    check('with all four copies in it', isClosedLine(quarterRing[0]) && quarterRing[0].length === 9, `${quarterRing[0].length} points`)

    // AND NOTHING ELSE IS TOUCHED. A line drawn clear of the axis has ends that
    // meet nothing, and comes out as the two open lines it always was.
    check(
      'a line clear of the axis is still two open lines',
      mirrorLines(drawn, upright).length === 2,
      ''
    )
  }

  // AND IT CUTS. Two mirrored lines are ONE act: three pieces off one press,
  // and the block conserved but for the two slots.
  const twin = cutPieces([freshBlock()], mirrorLines([[-0.3, -0.6], [-0.3, 0.6]], upright), FRONT)
  check('a mirrored cut leaves three pieces', twin.pieces.length === 3, `${twin.pieces.length}`)
  check('off one act, reported as two pieces coming apart', twin.split === 2, `${twin.split}`)
  check('leaving one in the middle and one either side', twin.pieces.length === 3, `${twin.pieces.length}`)
  near(
    'and the block is conserved but for the two slots',
    twin.pieces.reduce((t, g) => t + pieceVolume(g), 0),
    1 - 2 * LASER_KERF,
    3e-3
  )
  // THE TWO OUTER PIECES ARE ONE PIECE TWICE OVER, which is the whole reason
  // the offcut became a set: they are what one press made, mirrored.
  {
    const sizes = twin.pieces.map((g) => pieceVolume(g)).sort((a, b) => a - b)
    near('the two the mirror made match each other', sizes[0], sizes[1], 1e-6)
  }
}

console.log(  failures === 0
    ? '\nAll engine checks passed.\n'
    : `\n${failures} engine check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
