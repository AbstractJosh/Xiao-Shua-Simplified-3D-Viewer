/**
 * Headless verification of the interaction math: how a raycast becomes an
 * anchor, how an anchor becomes surface geometry, and how a drag finds the
 * thing it should land on.
 *
 * This is the logic the viewport depends on but that a screenshot cannot prove
 * -- whether a hit was classified against the right face of the right object,
 * whether a sketch on a sphere really fans its normals outward from the centre,
 * whether a sketch stays on the face it was dropped on, and whether snapping
 * pulls two solids exactly flush rather than approximately so.
 *
 * Run: npx tsx scripts/interaction-check.ts
 */
import { Mesh, Raycaster, Vector3 } from 'three'

const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}

import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { hostSurfaceFor, surfaceFor } from '../src/geometry/surfaces'
import { outlineOnSurface } from '../src/geometry/prism'
import { planeSeparates } from '../src/geometry/cut'
import { objectSnapTargets, snapTranslation, DEFAULT_SNAP_DISTANCE } from '../src/geometry/snap'
import { pickAnchorAcrossObjects, pickAnchorOnObject } from '../src/viewport/picking'
import { publishScene, resolveSolidDrop } from '../src/viewport/snapping'
import { useTools } from '../src/store/toolStore'
import {
  MORPH_ANGLES,
  NGON_HOLD_MS,
  NGON_MORPH_MS,
  NGON_SIDES,
  NGON_SIDES_TOP_DOWN,
  NGON_NAMES,
  morphPoints,
  ngonPoints,
  ngonRadii,
  nextNgonSides,
} from '../src/console/ngon'
import { IDENTITY_TRANSFORM } from '../src/geometry/types'
import type {
  BaseSolid,
  Doc,
  Feature,
  SceneObject,
  SurfaceAnchor,
  Vec3,
} from '../src/geometry/types'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}
function near(label: string, actual: number, expected: number, tol: number) {
  check(label, Math.abs(actual - expected) <= tol, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`)
}

function object(
  base: BaseSolid,
  id = 'obj',
  position: Vec3 = [0, 0, 0],
  features: Feature[] = []
): SceneObject {
  return {
    id,
    name: id,
    base,
    transform: { ...IDENTITY_TRANSFORM, position },
    features,
    cuts: [],
    parts: [],
  }
}

const scene = (...objects: SceneObject[]): Doc => ({ objects })

/**
 * The evaluated mesh per object, placed the way the viewport places it.
 *
 * `picking` deliberately raycasts through a stand-in pinned at the identity, so
 * the matrix set here changes no result -- but a mesh whose transform disagreed
 * with the document would be a lie waiting for the next reader.
 */
function sceneMeshes(doc: Doc): Map<string, Mesh> {
  const result = evaluateDoc(doc)
  const meshes = new Map<string, Mesh>()
  for (const obj of doc.objects) {
    const evaluated = result.objects.find((o) => o.id === obj.id)
    if (!evaluated) continue
    const mesh = new Mesh(evaluated.geometry)
    mesh.position.set(...obj.transform.position)
    mesh.rotation.set(...obj.transform.rotation)
    mesh.updateMatrixWorld(true)
    meshes.set(obj.id, mesh)
  }
  return meshes
}

function rayFrom(origin: [number, number, number], dir: [number, number, number]): Raycaster {
  const rc = new Raycaster()
  rc.set(new Vector3(...origin), new Vector3(...dir).normalize())
  return rc
}

const CUBE: BaseSolid = { kind: 'box', size: [2, 2, 2] }
const SPHERE: BaseSolid = { kind: 'sphere', radius: 1 }

// --- 1. Dropping on a cube face -------------------------------------------
console.log('\n1. Hit classification on a cube')
{
  resetEvaluator()
  const doc = scene(object(CUBE))
  const meshes = sceneMeshes(doc)
  const rc = rayFrom([0.3, 5, -0.2], [0, -1, 0])

  const hit = pickAnchorAcrossObjects(rc, doc, meshes)
  check('hit resolves to an anchor', hit !== null)
  check('the hit names its object', hit?.objectId === 'obj', `${hit?.objectId}`)
  const anchor = hit?.anchor
  check('classified as a box face', anchor?.on === 'box-face', `got ${anchor?.on}`)
  if (anchor?.on === 'box-face') {
    check('picked the +Y face', anchor.face === 2, `face index ${anchor.face}`)
    near('u coordinate', anchor.u, 0.3, 1e-3)
    near('v coordinate', anchor.v, 0.2, 1e-3)
  }

  // The sliding pick consults the primitive analytically before it consults the
  // evaluated mesh. On a bare solid the two must agree exactly, or a sketch
  // would jump the instant a drag began.
  const viaSurface = pickAnchorOnObject(rc, doc.objects[0], meshes.get('obj') ?? null)
  check(
    'analytic surface pick agrees with mesh pick',
    JSON.stringify(viaSurface) === JSON.stringify(anchor),
    `${JSON.stringify(viaSurface)}`
  )

  const miss = pickAnchorAcrossObjects(rayFrom([5, 5, 5], [0, 1, 0]), doc, meshes)
  check('ray into empty space yields no anchor', miss === null)
}

// --- 2. Dropping on a sphere ----------------------------------------------
console.log('\n2. Hit classification on a sphere')
{
  resetEvaluator()
  const doc = scene(object(SPHERE))
  const meshes = sceneMeshes(doc)
  // Aim slightly off-axis so the hit lands on a facet, not a seam vertex.
  const rc = rayFrom([5, 0.2, 0.1], [-1, 0, 0])
  const anchor = pickAnchorAcrossObjects(rc, doc, meshes)?.anchor
  check('classified as sphere surface', anchor?.on === 'sphere', `got ${anchor?.on}`)

  if (anchor?.on === 'sphere') {
    const frame = surfaceFor(SPHERE).frame(anchor)
    near('frame sits on the surface', frame.origin.length(), 1, 1e-6)
    near('frame normal is radial', frame.normal.dot(frame.origin.clone().normalize()), 1, 1e-6)
    near('u tangent is perpendicular to normal', frame.uDir.dot(frame.normal), 0, 1e-6)
    near('v tangent is perpendicular to normal', frame.vDir.dot(frame.normal), 0, 1e-6)
    // Right-handed: uDir x vDir must equal the outward normal, or every
    // generated face would point inward.
    const cross = new Vector3().crossVectors(frame.uDir, frame.vDir)
    near('uDir x vDir == normal', cross.dot(frame.normal), 1, 1e-6)
  }
}

// --- 3. The radial claim ---------------------------------------------------
console.log('\n3. A sketch on a sphere extrudes away from the centre')
{
  const anchor: SurfaceAnchor = { on: 'sphere', theta: 0.4, phi: 1.1 }
  const surface = surfaceFor(SPHERE)
  const centreNormal = surface.frame(anchor).normal

  const ring = outlineOnSurface(surface, anchor, {
    shape: { type: 'rect', w: 0.7, h: 0.7 },
    rotation: 0,
  })

  const onSurface = ring.every((p) => Math.abs(p.position.length() - 1) < 1e-6)
  check('every outline point lies on the sphere', onSurface, `${ring.length} points`)

  const radial = ring.every(
    (p) => Math.abs(p.normal.dot(p.position.clone().normalize()) - 1) < 1e-6
  )
  check('every outline normal points away from the centre', radial)

  // The decisive difference from a flat prism: normals must FAN OUT across the
  // footprint. If they were all parallel the walls would not converge.
  const spread = Math.min(...ring.map((p) => p.normal.dot(centreNormal)))
  check(
    'normals fan out across the footprint',
    spread < 0.99,
    `most divergent normal is ${((Math.acos(spread) * 180) / Math.PI).toFixed(2)} deg off centre`
  )
}

// --- 4. Sketching on geometry a feature created ---------------------------
console.log('\n4. Hits on derived geometry')
{
  resetEvaluator()
  const doc = scene(
    object(CUBE, 'obj', [0, 0, 0], [
      {
        id: 'boss',
        anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
        shape: { type: 'circle', r: 0.3 },
        rotation: 0,
        op: 'extrude',
        depth: 0.3,
        enabled: true,
        tilt: [0, 0, 0],
        faceOffset: [0, 0],
      },
    ])
  )
  const meshes = sceneMeshes(doc)
  // Straight down onto the top of the boss, which is 0.3 above the cube face.
  const anchor = pickAnchorAcrossObjects(rayFrom([0.05, 5, 0.05], [0, -1, 0]), doc, meshes)?.anchor
  check('boss top is not mistaken for the base face', anchor?.on === 'derived', `got ${anchor?.on}`)
  if (anchor?.on === 'derived') {
    // A derived anchor is stored in OBJECT-LOCAL space, like every anchor.
    near('derived hit height', anchor.point[1], 1.3, 1e-3)
    near('derived normal points up', anchor.normal[1], 1, 1e-3)
  }

  // Beside the boss, the original face must still classify analytically.
  const beside = pickAnchorAcrossObjects(rayFrom([0.8, 5, 0.8], [0, -1, 0]), doc, meshes)?.anchor
  check('face beside the boss still classifies exactly', beside?.on === 'box-face', `got ${beside?.on}`)
}

// --- 5. Clamping -----------------------------------------------------------
console.log('\n5. A sketch stays on its face')
{
  const surface = surfaceFor(CUBE)
  const shape = { type: 'circle' as const, r: 0.4 }
  // Dropped hard against the face edge.
  const clamped = surface.clampAnchor({ on: 'box-face', face: 2, u: 0.98, v: -1.2 }, shape)
  if (clamped.on === 'box-face') {
    // Face half-extent is 1, so a radius-0.4 circle can reach |u| = 0.6.
    near('u pulled inside the face', clamped.u, 0.6, 1e-6)
    near('v pulled inside the face', clamped.v, -0.6, 1e-6)
  } else {
    check('clamp preserved the anchor kind', false, clamped.on)
  }

  const big = surface.clampAnchor({ on: 'box-face', face: 2, u: 0.9, v: 0.9 }, { type: 'circle', r: 2 })
  if (big.on === 'box-face') {
    check('oversized sketch centres rather than escaping', big.u === 0 && big.v === 0)
  }

  // A sphere has no edge to fall off.
  const sphereAnchor: SurfaceAnchor = { on: 'sphere', theta: 1, phi: 2 }
  const host = hostSurfaceFor(SPHERE, sphereAnchor)
  check(
    'sphere anchors are never clamped',
    JSON.stringify(host.clampAnchor(sphereAnchor, shape)) === JSON.stringify(sphereAnchor)
  )
}

// --- 6. Polygon chip bands -------------------------------------------------
console.log('')
console.log('6. Polygon chip: band order and icon geometry')
{
  check('offers six side counts', NGON_SIDES.length === 6, NGON_SIDES.join(','))
  check('every count is named', NGON_SIDES.every((n) => Boolean(NGON_NAMES[n])))
  check(
    'sorted fewest to most sides',
    NGON_SIDES.every((n, i) => i === 0 || n > NGON_SIDES[i - 1]),
    NGON_SIDES.join(' < ')
  )
  // The bands render top-down, so the FIRST rendered band is the largest and
  // the LAST is the triangle -- that is what puts 3 at the bottom.
  check('bottom band is the triangle', NGON_SIDES_TOP_DOWN.at(-1) === 3, `${NGON_SIDES_TOP_DOWN.at(-1)}`)
  check('top band is the decagon', NGON_SIDES_TOP_DOWN[0] === 10, `${NGON_SIDES_TOP_DOWN[0]}`)
  check(
    'top-down order is the exact reverse',
    NGON_SIDES_TOP_DOWN.join() === [...NGON_SIDES].reverse().join(),
    NGON_SIDES_TOP_DOWN.join(',')
  )

  // Left alone the chip advertises itself by walking its own list. The walk
  // has to reach every band's polygon -- a cycle that skipped one would be
  // claiming the chip offers less than it does -- and it has to come home.
  {
    const walk = [NGON_SIDES[0]]
    while (walk.length < NGON_SIDES.length) walk.push(nextNgonSides(walk.at(-1)!))
    check('the idle cycle visits every polygon', new Set(walk).size === NGON_SIDES.length, walk.join(' -> '))
    check('in the order the bands sit in', walk.join() === NGON_SIDES.join(), walk.join(' -> '))
    check('and wraps back to the start', nextNgonSides(walk.at(-1)!) === NGON_SIDES[0], `${nextNgonSides(walk.at(-1)!)}`)
    // A count the chip does not offer (7, say, or a stale saved value) must
    // not strand the cycle on a polygon with no band under it.
    check('an off-list count rejoins the cycle', nextNgonSides(7) === NGON_SIDES[0], `${nextNgonSides(7)}`)
  }

  // --- the morph between them -------------------------------------------
  //
  // Six polygons with six different vertex counts cannot be interpolated
  // point by point, so they are all resampled onto one shared ring of angles
  // first. The whole design rests on that resampling being lossless: if it
  // rounds a corner off, every held polygon is drawn wrong for a full second,
  // which is far more visible than anything the 200ms in motion could do.
  {
    check('a polygon is held for a second', NGON_HOLD_MS === 1000, `${NGON_HOLD_MS}ms`)
    check('and the morph itself is 200ms', NGON_MORPH_MS === 200, `${NGON_MORPH_MS}ms`)

    const TOL = 1e-9
    const TWO_PI = Math.PI * 2
    const wrap = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI

    // Sampling at the union of every polygon's corners is what makes the
    // resampling exact -- so every corner has to actually be in there.
    const missing = NGON_SIDES.flatMap((n) => {
      const start = -Math.PI / 2 + (n % 2 === 0 ? Math.PI / n : 0)
      return Array.from({ length: n }, (_, i) => wrap(start + (i / n) * TWO_PI)).filter(
        (a) => !MORPH_ANGLES.some((m) => Math.abs(m - a) < TOL || Math.abs(m - a) > TWO_PI - TOL)
      )
    })
    check('the ring samples every corner of every polygon', missing.length === 0, `${missing.length} missed`)
    check(
      'and carries no duplicate angles',
      MORPH_ANGLES.every((a, i) => i === 0 || a - MORPH_ANGLES[i - 1] > TOL),
      `${MORPH_ANGLES.length} angles`
    )

    // Area off the unrounded radii: a ring that clipped a corner would come
    // out smaller than the polygon it is standing in for.
    const ringArea = (radii: number[]) =>
      radii.reduce((acc, r, i) => {
        const j = (i + 1) % radii.length
        const sweep = MORPH_ANGLES[j] - MORPH_ANGLES[i] + (j === 0 ? TWO_PI : 0)
        return acc + 0.5 * r * radii[j] * Math.sin(sweep)
      }, 0)

    for (const n of NGON_SIDES) {
      const exact = 0.5 * n * 12 * 12 * Math.sin(TWO_PI / n)
      const got = ringArea(ngonRadii(n))
      check(
        `${NGON_NAMES[n]} survives resampling intact`,
        Math.abs(got - exact) / exact < 1e-12,
        `area ${got.toFixed(6)} vs ${exact.toFixed(6)}`
      )
    }

    for (const from of NGON_SIDES) {
      const to = nextNgonSides(from)
      check(
        `${NGON_NAMES[from]} to ${NGON_NAMES[to]} starts on the real ${NGON_NAMES[from].toLowerCase()}`,
        morphPoints(from, to, 0) === morphPoints(from, from, 0),
        `t=0`
      )
      check(
        `and ends on the real ${NGON_NAMES[to].toLowerCase()}`,
        morphPoints(from, to, 1) === morphPoints(to, to, 0),
        `t=1`
      )

      // Halfway is a blend of the two, never a bulge past either -- and every
      // radius stays positive, so the outline cannot fold through itself.
      const a = ngonRadii(from)
      const b = ngonRadii(to)
      const mid = morphPoints(from, to, 0.5)
        .split(' ')
        .map((p) => p.split(',').map(Number))
        .map(([x, y]) => Math.hypot(x - 16, y - 16))
      check(
        `and stays between the two on the way across`,
        mid.every(
          (m, i) => m > 0 && m >= Math.min(a[i], b[i]) - 0.01 && m <= Math.max(a[i], b[i]) + 0.01
        ),
        `${mid.length} sampled radii`
      )
    }
  }

  for (const sides of NGON_SIDES) {
    const pts = ngonPoints(sides).split(' ').map((p) => p.split(',').map(Number))
    const radii = pts.map(([x, y]) => Math.hypot(x - 16, y - 16))
    const minY = Math.min(...pts.map(([, y]) => y))
    const atTop = pts.filter(([, y]) => Math.abs(y - minY) < 1e-6).length

    check(`${NGON_NAMES[sides]} has ${sides} vertices`, pts.length === sides, `${pts.length}`)
    check(
      `${NGON_NAMES[sides]} vertices lie on the icon circle`,
      radii.every((r) => Math.abs(r - 12) < 1e-2),
      `radius spread ${(Math.max(...radii) - Math.min(...radii)).toExponential(1)}`
    )
    // Even shapes should rest on a flat edge (two vertices share the top),
    // odd ones should point upward (a single apex). Get this wrong and a
    // square renders as a diamond.
    check(
      `${NGON_NAMES[sides]} is ${sides % 2 === 0 ? 'flat-topped' : 'point-topped'}`,
      atTop === (sides % 2 === 0 ? 2 : 1),
      `${atTop} vertices at the top edge`
    )
  }
}

// --- 7. Picking across a scene --------------------------------------------
console.log('\n7. The nearer object wins')
{
  resetEvaluator()
  const doc = scene(object(CUBE, 'left', [-3, 0, 0]), object(CUBE, 'right', [3, 0, 0]))
  const meshes = sceneMeshes(doc)

  // Both cubes lie on the ray. The winner has to be decided on WORLD distance:
  // each object's ray is rebased into that object's own space first, so the
  // parameter that comes back is measured from a different origin every time.
  const fromRight = pickAnchorAcrossObjects(rayFrom([10, 0.2, 0.1], [-1, 0, 0]), doc, meshes)
  check('picked the near object', fromRight?.objectId === 'right', `${fromRight?.objectId}`)
  near('hit the near face of it', fromRight?.point.x ?? NaN, 4, 1e-3)
  check(
    'and its anchor is local to that object',
    fromRight?.anchor.on === 'box-face' && fromRight.anchor.face === 0,
    `${JSON.stringify(fromRight?.anchor)}`
  )

  const fromLeft = pickAnchorAcrossObjects(rayFrom([-10, 0.2, 0.1], [1, 0, 0]), doc, meshes)
  check('reversing the ray picks the other one', fromLeft?.objectId === 'left', `${fromLeft?.objectId}`)
  near('and hits its -X face', fromLeft?.point.x ?? NaN, -4, 1e-3)

  // Nothing between the two: the gap has to stay empty, not resolve to whatever
  // the raycaster last touched.
  const gap = pickAnchorAcrossObjects(rayFrom([0, 5, 0], [0, 1, 0]), doc, meshes)
  check('a ray through the gap hits nothing', gap === null, `${gap?.objectId}`)
}

// --- 8. Anchors on the faceted and latheed primitives ---------------------
console.log('\n8. Anchors on a prism and on a cylinder wall')
{
  resetEvaluator()
  const PRISM: BaseSolid = { kind: 'prism', radius: 0.9, height: 1.8, sides: 6 }
  const doc = scene(object(PRISM))
  const meshes = sceneMeshes(doc)

  // Aim at the MIDDLE of a wall. A hexagon built as (r sin t, y, r cos t) puts
  // a vertex at +Z, so firing along +Z would strike an edge exactly end-on.
  const mid = Math.PI / 6
  const dir = new Vector3(Math.sin(mid), 0, Math.cos(mid))
  const wall = pickAnchorAcrossObjects(
    rayFrom([dir.x * 5, 0.4, dir.z * 5], [-dir.x, 0, -dir.z]),
    doc,
    meshes
  )
  check('prism wall is a planar face', wall?.anchor.on === 'planar-face', `got ${wall?.anchor.on}`)
  if (wall?.anchor.on === 'planar-face') {
    const frame = surfaceFor(PRISM).frame(wall.anchor)
    near('the face normal is the wall direction', frame.normal.dot(dir), 1, 1e-6)
    near('a prism wall is vertical', frame.normal.y, 0, 1e-9)
    // Apothem of a hexagon of circumradius 0.9.
    near('the hit sits on the apothem', Math.hypot(wall.point.x, wall.point.z), 0.9 * Math.cos(mid), 1e-3)
  }

  const cap = pickAnchorAcrossObjects(rayFrom([0.2, 5, 0.1], [0, -1, 0]), doc, meshes)
  check('prism cap is a planar face too', cap?.anchor.on === 'planar-face', `got ${cap?.anchor.on}`)
  if (cap?.anchor.on === 'planar-face') {
    near('and it faces straight up', surfaceFor(PRISM).frame(cap.anchor).normal.y, 1, 1e-9)
  }
}
{
  resetEvaluator()
  const CYL: BaseSolid = { kind: 'cylinder', radius: 0.8, height: 2 }
  const doc = scene(object(CYL))
  const meshes = sceneMeshes(doc)

  const hit = pickAnchorAcrossObjects(rayFrom([5, 0.3, 0], [-1, 0, 0]), doc, meshes)
  check('cylinder wall gets its own anchor kind', hit?.anchor.on === 'cylinder', `got ${hit?.anchor.on}`)
  if (hit?.anchor.on === 'cylinder') {
    near('height along the axis is recorded', hit.anchor.y, 0.3, 1e-3)
    near('and the azimuth faces the camera', hit.anchor.theta, 0, 1e-3)
    const frame = surfaceFor(CYL).frame(hit.anchor)
    near('frame sits on the barrel', Math.hypot(frame.origin.x, frame.origin.z), 0.8, 1e-9)
    near('its normal is radial and level', frame.normal.dot(new Vector3(1, 0, 0)), 1, 1e-9)
    // Up on the screen is up on the solid, which is what makes a rectangle
    // dropped on a barrel read as upright rather than wrapped diagonally.
    near('v runs up the barrel', frame.vDir.y, 1, 1e-9)
  }

  const cap = pickAnchorAcrossObjects(rayFrom([0.2, 5, 0.1], [0, -1, 0]), doc, meshes)
  check('the flat cap is a planar face', cap?.anchor.on === 'planar-face', `got ${cap?.anchor.on}`)
}

// --- 9. Snapping two boxes flush ------------------------------------------
console.log('\n9. Snapping pulls two boxes flush')
{
  resetEvaluator()
  const gap = 0.1
  const doc = scene(object(CUBE, 'still', [0, 0, 0]), object(CUBE, 'moving', [2 + gap, 0, 0]))
  const result = evaluateDoc(doc)
  const geometryOf = (id: string) => result.objects.find((o) => o.id === id)!.geometry

  const targets = objectSnapTargets('still', geometryOf('still'), doc.objects[0].transform)
  const sources = objectSnapTargets('moving', geometryOf('moving'), doc.objects[1].transform)
    .filter((t) => t.kind === 'vertex')
    .map((t) => (t.kind === 'vertex' ? t.point : new Vector3()))

  check('a cube offers its eight corners', sources.length === 8, `${sources.length} corner targets`)

  const hit = snapTranslation(sources, targets, DEFAULT_SNAP_DISTANCE)
  check('a 0.1 gap is inside the snap radius', hit !== null)
  if (hit) {
    // A corner outranks the face plane it lies on, so the whole box goes flush
    // AND stays aligned, rather than sliding along the face it landed against.
    check('it caught a corner, not a face', hit.target.kind === 'vertex', hit.target.kind)
    near('the pull closes the gap exactly', hit.delta.x, -gap, 1e-6)
    near('and moves nothing sideways', Math.hypot(hit.delta.y, hit.delta.z), 0, 1e-9)
    near('the reported distance is the true gap', hit.distance, gap, 1e-6)

    // The proof that "flush" means flush: the moved box's -X face lands exactly
    // on the still box's +X face.
    const movedFace = 2 + gap - 1 + hit.delta.x
    near('the faces meet at x = 1', movedFace, 1, 1e-6)
  }

  // Out of reach, nothing should move: a snap that fired at any distance would
  // make placing two objects near each other impossible. The far box is offset
  // on all three axes on purpose -- a face target is an unbounded plane, so two
  // boxes left at the same height would still agree about that plane at zero
  // distance and the check would prove nothing about reach.
  const far = scene(object(CUBE, 'still', [0, 0, 0]), object(CUBE, 'moving', [2.9, 0.37, 0.21]))
  resetEvaluator()
  const farResult = evaluateDoc(far)
  const farSources = objectSnapTargets(
    'moving',
    farResult.objects[1].geometry,
    far.objects[1].transform
  )
    .filter((t) => t.kind === 'vertex')
    .map((t) => (t.kind === 'vertex' ? t.point : new Vector3()))
  const farTargets = objectSnapTargets('still', farResult.objects[0].geometry, far.objects[0].transform)
  const noPull = snapTranslation(farSources, farTargets, DEFAULT_SNAP_DISTANCE)
  check(
    'a box 0.21 clear on every axis is left alone',
    noPull === null,
    noPull ? `${noPull.target.kind} at ${noPull.distance.toFixed(3)}` : ''
  )

  // A source already ON a target has a zero delta, so winning costs it nothing
  // -- yet it used to beat a real corner that had to pay the priority handicap,
  // and the handicap is what cuts a vertex's usable radius to 70% of the
  // Distance setting. Here the moving box's -X face lies exactly on the still
  // box's +X face plane while its corners sit 0.15 above their counterparts:
  // 0.15 is inside the 0.18 setting but outside the 0.126 a handicapped vertex
  // could reach, so the zero-delta face won and the drag froze while the
  // indicator claimed a catch that moved nothing.
  const rested = scene(object(CUBE, 'still', [0, 0, 0]), object(CUBE, 'moving', [2, 0.15, 0]))
  resetEvaluator()
  const restedResult = evaluateDoc(rested)
  const restedSources = objectSnapTargets(
    'moving',
    restedResult.objects[1].geometry,
    rested.objects[1].transform
  )
    .filter((t) => t.kind === 'vertex')
    .map((t) => (t.kind === 'vertex' ? t.point : new Vector3()))
  const restedTargets = objectSnapTargets(
    'still',
    restedResult.objects[0].geometry,
    rested.objects[0].transform
  )
  const onFace = snapTranslation(restedSources, restedTargets, DEFAULT_SNAP_DISTANCE)
  check('a box resting on a face plane still snaps', onFace !== null)
  if (onFace) {
    check(
      'and the zero-delta face does not outrank the corner',
      onFace.target.kind === 'vertex',
      onFace.target.kind
    )
    near('so the corner it caught is the one 0.15 away', onFace.distance, 0.15, 1e-6)
    near('and the pull actually moves the box', onFace.delta.y, -0.15, 1e-6)
    near('without breaking the contact it already had', onFace.delta.x, 0, 1e-9)
  }
}

// --- 9b. A dropped solid seeks the scene by its corners --------------------
console.log('\n9b. A solid dropped from the palette lands flush')
{
  // The palette drop is the one gesture with no document entry to look up, so
  // it goes through `resolveSolidDrop` rather than `resolveObjectMove`. It used
  // to hand the snap engine the drop POSITION as its only source -- a single
  // point at the solid's centre, which for a 2-unit cube is a whole unit from
  // anything worth catching, so the snap could never fire at all. Corners can.
  resetEvaluator()
  const resident = scene(object(CUBE, 'resident', [0, 0, 0]))
  const evaluated = evaluateDoc(resident)
  publishScene(
    evaluated.objects.map((o) => ({
      id: o.id,
      geometry: o.geometry,
      transform: resident.objects[0].transform,
    }))
  )
  useTools.getState().setSnap(true)
  useTools.getState().setSnapDistance(DEFAULT_SNAP_DISTANCE)
  const dropped = surfaceFor(CUBE).geometry()

  // The resident cube spans x -1..1 and the dropped one is 2 wide, so flush is
  // a centre at x = 2. Approaching from either side must land on it.
  for (const desired of [1.85, 1.9, 2.1, 2.15]) {
    const landed = resolveSolidDrop(dropped, [desired, 0, 0])
    near(`a drop at x = ${desired} lands flush`, landed[0], 2, 1e-6)
    near('and is not lifted or slid sideways', Math.hypot(landed[1], landed[2]), 0, 1e-9)
  }
  // Reach still has to end somewhere, or a solid could never be placed beside
  // another without being sucked onto it.
  const clear = resolveSolidDrop(dropped, [2.4, 0, 0])
  near('a drop 0.4 clear is left where it was released', clear[0], 2.4, 1e-9)

  // Leave the registry empty: it is module state, and a later suite reading a
  // scene this one published would be reading a document that no longer exists.
  publishScene([])
}

// --- 10. A plane that only grazes is not a cut ----------------------------
console.log('\n10. planeSeparates refuses a graze')
{
  resetEvaluator()
  const geometry = evaluateDoc(scene(object(CUBE))).objects[0].geometry
  const origin = (x: number) => new Vector3(x, 0, 0)
  const X = new Vector3(1, 0, 0)

  check('a plane through the middle separates', planeSeparates(geometry, origin(0), X))
  // Exactly on the face: one side has no volume at all.
  check('a plane lying on a face does not', !planeSeparates(geometry, origin(1), X))
  // Just inside it: the sliver is real but is 0.02% of the solid, which is a
  // graze, not a cut -- and a user who saw the object "split" here would find
  // one half invisible.
  check('a plane shaving a 0.0002 sliver does not', !planeSeparates(geometry, origin(0.9999), X))
  check('a plane that misses entirely does not', !planeSeparates(geometry, origin(3), X))
  // A plane at 45 degrees still separates: the test does the boolean rather
  // than inspecting axis-aligned bounds.
  check(
    'a diagonal plane through the middle does',
    planeSeparates(geometry, origin(0), new Vector3(1, 1, 0).normalize())
  )
}

console.log(
  failures === 0
    ? '\nAll interaction checks passed.\n'
    : `\n${failures} interaction check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
