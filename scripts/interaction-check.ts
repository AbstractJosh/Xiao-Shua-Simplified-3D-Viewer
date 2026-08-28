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
import { readFileSync } from 'node:fs'
import { Euler, Mesh, PerspectiveCamera, Raycaster, Vector3 } from 'three'

const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}

import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { hostSurfaceFor, surfaceFor } from '../src/geometry/surfaces'
import { outlineOnSurface } from '../src/geometry/prism'
import { outlineAxis, sampleOutline } from '../src/geometry/outline'
import { MIN_SHAPE, resizeShapeAlong } from '../src/geometry/dimensions'
import { clampDepth, depthLimits } from '../src/geometry/surfaces'
import { planeSeparates } from '../src/geometry/cut'
import { objectSnapTargets, snapTranslation, DEFAULT_SNAP_DISTANCE } from '../src/geometry/snap'
import { pickAnchorAcrossObjects, pickAnchorOnObject } from '../src/viewport/picking'
import { publishScene, resolveSolidDrop } from '../src/viewport/snapping'
import {
  COMPASS_VIEWS,
  POLAR_LIMIT,
  TURN_PER_SPAN,
  askForTurn,
  askForView,
  orbitPosition,
  takeRequest,
  takeTurn,
  turnFromDrag,
  viewQuaternion,
  viewUp,
} from '../src/viewport/compassViews'
import { useTools } from '../src/store/toolStore'
import { PLANE_ROTATIONS, gizmoParts } from '../src/viewport/TransformGizmo'
import { modifiers, clearModifiers } from '../src/viewport/modifiers'
import { MODE_KEYS } from '../src/viewport/Viewport'
import {
  advanceTurn,
  beginPlaneDrag,
  planeTarget,
  planeTravel,
  pointerAngle,
  turnedRotation,
} from '../src/viewport/gizmoDrag'
import { useDoc } from '../src/store/docStore'
import {
  centreOnScreen,
  claimsPress,
  normaliseBox,
  objectsInBox,
  selectionFor,
} from '../src/viewport/marquee'
import type { Press } from '../src/viewport/marquee'
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
import { iconFrame } from '../src/console/solidMorph'
import type { IconFrame } from '../src/console/solidMorph'
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

  // --- and the two solids that stand on those polygons ---------------------
  //
  // The Solids list has the same family problem the chip has, one dimension up:
  // a pyramid is whatever polygon it is built on. Its icon is that polygon
  // projected, so it inherits the ring, the resampling and the morph -- and the
  // same obligation to land exactly on the real solid at both ends.
  {
    const SOLID_SIDES = [3, 4, 5, 6, 8]
    const points = (s: string) => s.split(' ').map((p) => p.split(',').map(Number))
    const corners = (f: IconFrame) => [
      ...points(f.base),
      ...(f.cap ? points(f.cap) : []),
      ...f.sets.flatMap((s) => s.edges.flatMap((e) => [[e.x1, e.y1], [e.x2, e.y2]])),
    ]
    const span = (f: IconFrame) => {
      const xs = corners(f).map(([x]) => x)
      const ys = corners(f).map(([, y]) => y)
      return {
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
      }
    }

    for (const kind of ['pyramid', 'prism'] as const) {
      const widths = new Set<string>()
      for (const n of SOLID_SIDES) {
        const frame = iconFrame(kind, n, n, 0)
        const edges = frame.sets[0].edges
        const box = span(frame)
        widths.add(box.w.toFixed(3))

        check(`a ${n}-sided ${kind} draws one edge per corner`, edges.length === n, `${edges.length}`)
        // The widest corner is the silhouette however far back it sits, so it
        // is always drawn solid. A count that had none would be a solid with
        // nothing but faint edges holding its outline up.
        check(
          `and stands its silhouette in full strength`,
          edges.some((e) => !e.hidden),
          `${edges.filter((e) => !e.hidden).length} of ${n} solid`
        )
        check(
          `a ${n}-sided ${kind} fits the icon canvas`,
          box.top > 2 && box.bottom < 30,
          `y ${box.top.toFixed(1)}..${box.bottom.toFixed(1)}`
        )
        // The whole reason these two rows can share the list with a cube and a
        // tetrahedron -- which ARE a 4-sided prism and a 3-sided pyramid -- is
        // that they are drawn as columns and spires rather than as blocks.
        check(
          `and is drawn taller than it is wide`,
          box.h / box.w > 1.3,
          `${(box.h / box.w).toFixed(2)}:1`
        )
        // The rim is resampled onto a ring shared by every count so that any
        // two can be interpolated. That is only lossless if the ring carries
        // every corner of every base -- and a corner it missed would be a
        // corner rounded off for as long as the icon sat still. The edges are
        // built from the REAL corners, so a rim that reproduces all of them is
        // a rim that lost nothing.
        const rim = points(frame.base)
        check(
          `and loses no corner to the ring it is sampled on`,
          edges.every((e) => rim.some(([x, y]) => Math.hypot(x - e.x2, y - e.y2) < 0.02)),
          `${n} corners in ${rim.length} samples`
        )
      }
      // A cycle that swelled and shrank as it ran would read as the icon
      // zooming rather than as the solid changing.
      check(
        `every ${kind} in the family is drawn to one width`,
        widths.size === 1,
        `${[...widths].join(', ')}`
      )
    }

    for (const kind of ['pyramid', 'prism'] as const) {
      for (const [from, to] of [[3, 4], [4, 5], [5, 6], [6, 8], [8, 3]] as const) {
        check(
          `a ${kind} morphing ${from} -> ${to} starts on the real ${from}-sided one`,
          iconFrame(kind, from, to, 0).base === iconFrame(kind, from, from, 0).base,
          't=0'
        )
        check(
          `and ends on the real ${to}-sided one`,
          iconFrame(kind, from, to, 1).base === iconFrame(kind, to, to, 0).base,
          't=1'
        )
        // Rims flow; edges cannot, so they cross over instead. The pair has to
        // hold full strength between them, or the solid thins out mid-morph.
        const mid = iconFrame(kind, from, to, 0.5)
        check(
          `and hands its edges over on the way across`,
          mid.sets.length === 2 &&
            Math.abs(mid.sets[0].weight + mid.sets[1].weight - 1) < 1e-9 &&
            mid.sets[0].edges.length === from &&
            mid.sets[1].edges.length === to,
          mid.sets.map((s) => `${s.edges.length}@${s.weight.toFixed(2)}`).join(' + ')
        )
        // Both sets stand on the rim as it is at that INSTANT, not on the rim
        // they were drawn for -- otherwise half the edges detach and hang in
        // the air for as long as the morph lasts. The rim is written to two
        // decimals, so that is the tolerance.
        const rim = points(mid.base)
        const welded = mid.sets.every((s) =>
          s.edges.every((e) => rim.some(([x, y]) => Math.hypot(x - e.x2, y - e.y2) < 0.02))
        )
        check(`with every edge still welded to it`, welded, `${rim.length} rim samples`)
      }
    }
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

// --- 11. The selection box catches objects by their gizmos ------------------
console.log('\n11. The marquee projects centres of mass into screen space')
{
  // 90 degrees of vertical field on a square view makes the projection exact by
  // hand: tan(45) is 1, so a point one unit sideways for every unit of depth
  // lands precisely on the edge of the view.
  const camera = new PerspectiveCamera(90, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  const view = { left: 0, top: 0, width: 800, height: 800 }

  const at = (id: string, position: Vec3) => object(CUBE, id, position)
  const screen = (o: SceneObject) => centreOnScreen(o, camera, view)

  const centre = screen(at('origin', [0, 0, 0]))
  check('an object on the axis lands in the middle of the view', centre !== null)
  if (centre) {
    near('its x is half the width', centre.x, 400, 1e-6)
    near('and its y half the height', centre.y, 400, 1e-6)
  }

  const right = screen(at('right', [5, 0, 0]))
  if (right) near('five units right, ten deep, is half way to the edge', right.x, 600, 1e-6)

  // The one place the two coordinate systems disagree: NDC y climbs toward the
  // top of the screen and client y falls.
  const up = screen(at('up', [0, 5, 0]))
  if (up) near('and five units UP is half way to the TOP', up.y, 200, 1e-6)

  // Behind the camera, which sits at z = 10 looking down -Z. Projected naively
  // this lands back inside the view, mirrored through the origin -- so a box
  // drawn on empty sky would gather up whatever stood behind the user.
  check('an object behind the camera is off screen', screen(at('back', [0, 0, 20])) === null)

  const objects = [at('a', [0, 0, 0]), at('b', [5, 0, 0]), at('c', [-5, 0, 0])]
  const caught = (x0: number, y0: number, x1: number, y1: number) =>
    objectsInBox(objects, normaliseBox({ x0, y0, x1, y1 }), camera, view).join()

  check(
    'a box over the middle takes only what is under it',
    caught(350, 350, 450, 450) === 'a',
    caught(350, 350, 450, 450)
  )
  check(
    'a wider box takes everything it reaches',
    caught(150, 350, 650, 450) === 'a,b,c',
    caught(150, 350, 650, 450)
  )
  // Dragged from the far corner back: the same three, in the same order. The
  // primary is the head of this list, and it must not depend on which way the
  // pointer happened to travel.
  check(
    'and drawing it backwards gives the same list',
    caught(650, 450, 150, 350) === 'a,b,c',
    caught(650, 450, 150, 350)
  )
  check('a box on empty sky takes nothing', caught(10, 10, 60, 60) === '')

  // The centre is the test, not the silhouette. This box covers a good part of
  // the right-hand cube's body -- the solid is 2 units wide and reaches back to
  // x = 4 -- but not the dot the user can see standing for it.
  check('a box over an object but not its gizmo takes nothing', caught(480, 350, 560, 450) === '')
}

// --- 11b. A merged object is caught at the middle of the whole -------------
console.log('\n11b. The marquee reads a merged object as one thing')
{
  const camera = new PerspectiveCamera(90, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  const view = { left: 0, top: 0, width: 800, height: 800 }

  // Two cubes welded four units apart. The single gizmo left behind sits midway
  // between them, at x = 2 -- and that, not the host it was merged into, is what
  // the box has to catch.
  const part = object(CUBE, 'part', [4, 0, 0])
  const merged: SceneObject = { ...object(CUBE, 'merged', [0, 0, 0]), parts: [part] }
  const at = centreOnScreen(merged, camera, view)
  check('a merged pair projects from the middle of the two', at !== null)
  // x = 2 at ten units of depth is a fifth of the way to the edge: 400 + 80.
  if (at) near('which is on neither solid', at.x, 480, 1e-6)

  const box = (x0: number, x1: number) =>
    objectsInBox([merged], normaliseBox({ x0, y0: 350, x1, y1: 450 }), camera, view).join()
  check('a box on the middle catches it', box(460, 500) === 'merged')
  check('a box on the host alone does not', box(380, 420) === '')
}

// --- 11c. What the box produces, and what it leaves alone ------------------
console.log('\n11c. A marquee replaces the selection, or adds to it')
{
  check(
    'a plain box replaces whatever was selected',
    selectionFor(['old'], ['a', 'b'], false).join() === 'a,b'
  )
  // Primary first, and the existing selection leads: sweeping up more solids
  // must not move the gizmo or change what a merge would fold into.
  check(
    'a shift-box appends to it, primary first',
    selectionFor(['old'], ['a', 'b'], true).join() === 'old,a,b'
  )
  check(
    'and never names the same object twice',
    selectionFor(['a'], ['a', 'b'], true).join() === 'a,b'
  )

  // A marquee re-decides the selection on every pointer move, and almost every
  // one of those moves lands on the same set. The store has to recognise that,
  // or the whole scene re-renders at pointer rate.
  const doc = () => useDoc.getState()
  const id = doc().addObject(CUBE, [0, 0, 0])
  doc().selectObjects([id])
  const first = doc().selectedObjectIds
  doc().selectObjects([id])
  check('re-selecting the same set changes nothing at all', doc().selectedObjectIds === first)
  doc().selectObjects([])
  check('and emptying it does', doc().selectedObjectIds.length === 0)
  doc().removeObject(id)
}

// --- 11d. Whose press is it -----------------------------------------------
console.log('\n11d. The box only takes the presses nothing else wanted')
{
  // A plain left press on bare canvas, with nothing under it and no gesture in
  // flight. Every case below is this one with a single field disturbed, so what
  // each check proves is exactly the clause it names.
  const bare: Press = {
    button: 0,
    pointerType: 'mouse',
    altKey: false,
    onCanvas: true,
    hits: 0,
    dragging: false,
  }
  const claims = (patch: Partial<Press>) => claimsPress({ ...bare, ...patch })

  check('a left press on empty canvas starts a box', claims({}))
  check('so does the same press from a pen', claims({ pointerType: 'pen' }))

  // Right-drag pans the camera and right-click opens the object menu; the
  // middle button now orbits.
  check('the right button does not', !claims({ button: 2 }))
  check('nor does the middle one', !claims({ button: 1 }))
  // A touchscreen has no second button to move orbit onto, so one finger keeps
  // turning the camera there.
  check('nor one finger on a touchscreen', !claims({ pointerType: 'touch' }))
  // Alt is what puts orbit back on the left button for a mouse with no wheel
  // to press.
  check('nor a left press with Alt held, which orbits', !claims({ altKey: true }))
  // The hint, the object menu and the box itself all sit inside the viewport
  // without being the scene.
  check('nor a press on an overlay rather than the canvas', !claims({ onCanvas: false }))
  // The press landed on a solid, a gizmo arrow, a sketch or a face handle.
  check('nor a press that landed on something in the scene', !claims({ hits: 1 }))
  // A solid dragged off the palette is released over the canvas, but the press
  // that started it happened on a console chip.
  check('nor a press while a placement is already running', !claims({ dragging: true }))
}

// --- 11e. Delete empties the whole box, in one press ------------------------
console.log('\n11e. Delete takes the whole selection at once')
{
  const doc = () => useDoc.getState()
  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)

  const ids = [
    doc().addObject(CUBE, [0, 0, 0]),
    doc().addObject(CUBE, [4, 0, 0]),
    doc().addObject(CUBE, [8, 0, 0]),
  ]
  const bystander = doc().addObject(CUBE, [12, 0, 0])
  doc().selectObjects(ids)
  check('three of four solids selected', doc().selectedObjectIds.length === 3)

  const before = doc().doc
  doc().removeObjects(doc().selectedObjectIds)
  check('one Delete takes all three', doc().doc.objects.length === 1)
  check('and leaves the one that was not selected', doc().doc.objects[0].id === bystander)
  // The point of doing it in one write rather than three: what the user did
  // once, they undo once.
  check('the selection goes with them', doc().selectedObjectIds.length === 0)
  doc().undo()
  check('and one undo brings all three back', doc().doc.objects.length === 4)
  check('as the document they came from', doc().doc === before)

  // Ids naming nothing must not cost an undo step -- pressing Delete on an
  // empty selection would otherwise bury the edit before it.
  doc().selectObjects([])
  const untouched = doc().doc
  doc().removeObjects([])
  check('deleting nothing is not an edit', doc().doc === untouched)
  doc().removeObjects(['gone', 'also-gone'])
  check('nor is deleting ids that are already gone', doc().doc === untouched)
  // -- and, having cost no history entry, it leaves the redo stack alone.
  doc().redo()
  check('so redo still reaches the delete it did not disturb', doc().doc.objects.length === 1)
  doc().undo()

  // Removing one is the same path now, so the single-object case has to keep
  // behaving exactly as it did.
  doc().removeObject(bystander)
  check('and removing one still removes exactly one', doc().doc.objects.length === 3)
  check(
    'namely the one it was given',
    doc().doc.objects.map((o) => o.id).join() === ids.join()
  )

  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)

  // The key itself: the Delete branch hands over the whole selection rather
  // than the one object wearing the gizmo.
  const viewport = readFileSync(new URL('../src/viewport/Viewport.tsx', import.meta.url), 'utf8')
  check(
    'and the Delete key passes the whole selection',
    viewport.includes('s.removeObjects(s.selectedObjectIds)')
  )
}

// --- 12. The sketch gizmo's own axes ---------------------------------------
console.log('\n12. The tangent arrows follow the OUTLINE, not the surface')
{
  // The two arrows lie along the outline's own axes so a right-drag stretches
  // the dimension the arrow points down. That only holds while this agrees to
  // the last bit with the rotation `sampleOutline` turns the shape by -- and
  // the failure it would cause is silent: a sketch that slides sideways when
  // dragged along its own edge.
  const [u0, v0] = outlineAxis(0, 0)
  near('at rest the first axis is the surface U', u0, 1, 1e-12)
  near('with nothing in V', v0, 0, 1e-12)
  const [u1, v1] = outlineAxis(1, 0)
  near('and the second is V', v1, 1, 1e-12)
  near('with nothing in U', u1, 0, 1e-12)

  for (const rotation of [0.3, 1.1, -0.7, Math.PI]) {
    const a = outlineAxis(0, rotation)
    const b = outlineAxis(1, rotation)
    near(`the pair stays unit at ${rotation}`, Math.hypot(a[0], a[1]), 1, 1e-12)
    near('and perpendicular', a[0] * b[0] + a[1] * b[1], 0, 1e-12)

    // A 2x2 square's far corner is the sum of its two half-axes, and
    // `sampleOutline` puts it wherever it turns the shape to. If the two ever
    // disagreed about which way positive rotation goes, this is where it shows.
    const corner = sampleOutline({ type: 'rect', w: 2, h: 2 }, rotation, false)[2]
    near('and the outline agrees where its corner went', corner[0], a[0] + b[0], 1e-12)
    near('on the other coordinate too', corner[1], a[1] + b[1], 1e-12)
  }
}

// --- 12b. What a right-drag on a tangent arrow does -------------------------
console.log('\n12b. The tangent arrows stretch the outline')
{
  // Centred outlines, so pulling ONE side out by `travel` grows the whole
  // dimension by twice it -- the same convention the object gizmo's arrows use
  // on a solid's width.
  const rect = { type: 'rect', w: 0.6, h: 0.4 } as const
  const wider = resizeShapeAlong(rect, 0, 0.1, 1)
  check('the first arrow drives a rectangle width', wider.type === 'rect')
  if (wider.type === 'rect') {
    near('growing it by twice the travel', wider.w, 0.8, 1e-12)
    near('and leaving the height alone', wider.h, 0.4, 1e-12)
  }
  const taller = resizeShapeAlong(rect, 1, -0.1, 1)
  if (taller.type === 'rect') {
    near('the second drives the height, and shrinks too', taller.h, 0.2, 1e-12)
    near('leaving the width alone', taller.w, 0.6, 1e-12)
  }

  // A radius is measured from the centre already, so it takes the travel
  // unhalved -- and there is no second dimension for the other arrow to drive.
  const circle = { type: 'circle', r: 0.3 } as const
  for (const axis of [0, 1] as const) {
    const grown = resizeShapeAlong(circle, axis, 0.1, 1)
    if (grown.type === 'circle') {
      near(`arrow ${axis} grows a circle by the travel itself`, grown.r, 0.4, 1e-12)
    }
  }
  const ngon = resizeShapeAlong({ type: 'ngon', r: 0.3, sides: 6 }, 0, 0.1, 1)
  check('a polygon keeps its side count', ngon.type === 'ngon' && ngon.sides === 6)

  // The same ceilings the ring and the Inspector honour: a rectangle is
  // measured across, a radius from the middle.
  const capped = resizeShapeAlong(rect, 0, 99, 1)
  if (capped.type === 'rect') near('a rectangle stops at twice the bound', capped.w, 2, 1e-12)
  const cappedR = resizeShapeAlong(circle, 0, 99, 1)
  if (cappedR.type === 'circle') near('a radius stops at the bound itself', cappedR.r, 1, 1e-12)
  const floored = resizeShapeAlong(circle, 0, -99, 1)
  if (floored.type === 'circle') near('and never shrinks past nothing', floored.r, MIN_SHAPE, 1e-12)
}

// --- 12c. One signed depth, with two different reaches ---------------------
console.log('\n12c. Depth is one signed number, clamped asymmetrically')
{
  // A boss may stand further proud of a face than a pocket may sink into it,
  // which is why the slider is not symmetric about zero and why the clamp has
  // to be asked one direction at a time.
  const top: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }
  const host = hostSurfaceFor(CUBE, top)
  const limit = depthLimits(host, top)
  check('a cube reaches further out than in', limit.out > limit.in, `${limit.out} vs ${limit.in}`)
  check('and both are positive magnitudes', limit.in > 0 && limit.out > 0)

  near('a depth inside the range is left alone', clampDepth(host, top, 0.3), 0.3, 1e-12)
  near('so is a negative one', clampDepth(host, top, -0.3), -0.3, 1e-12)
  near('an overreach outward stops at the outward limit', clampDepth(host, top, 99), limit.out, 1e-12)
  // The one that matters: a clamp that took a magnitude would hand this back
  // pointing the wrong way, turning a pocket into a boss at the limit.
  near('and an overreach inward keeps its direction', clampDepth(host, top, -99), -limit.in, 1e-12)
  near('zero is inert either way', clampDepth(host, top, 0), 0, 1e-12)
}

// --- 13. The corner compass ------------------------------------------------
console.log('\n13. The compass flies the camera to the face it names')
{
  // The cube reports a hit as the index of the material it landed on, and hands
  // that index straight back as a view. Nothing checks the two agree at
  // runtime, so it is checked here: the six must stand in the order
  // BoxGeometry takes its materials, or clicking Top would fly you to Left.
  const order = COMPASS_VIEWS.map((v) => `${'xyz'[v.axis]}${v.sign > 0 ? '+' : '-'}`).join(' ')
  check('the six views stand in BoxGeometry material order', order === 'x+ x- y+ y- z+ z-', order)
  check('and each is named for the face that looks that way',
    COMPASS_VIEWS.map((v) => v.label).join(' ') === 'Right Left Top Bottom Front Back',
    COMPASS_VIEWS.map((v) => v.label).join(' '))

  // Every one of them, from a pivot that is NOT the origin -- which is where a
  // panned scene leaves it, and the case a flight measured from the world
  // centre would get wrong.
  const focus = new Vector3(0.4, 1.2, -0.7)
  const radius = 7.3
  for (const view of COMPASS_VIEWS) {
    const facing = viewQuaternion(view.dir)
    const position = orbitPosition(facing, focus, radius)

    near(`${view.label}: the camera keeps the distance it had`, position.distanceTo(focus), radius, 1e-9)
    const stands = position.clone().sub(focus).normalize()
    near(`${view.label}: and stands on that axis`, stands.dot(view.dir), 1, 1e-9)

    const forward = new Vector3(0, 0, -1).applyQuaternion(facing)
    near(`${view.label}: looking back down it`, forward.dot(view.dir), -1, 1e-9)

    // The roll it arrives at is the one `viewUp` names, which is what stops a
    // view from landing spun by an amount nobody asked for.
    const up = new Vector3(0, 1, 0).applyQuaternion(facing)
    near(`${view.label}: rolled the way it should be`, up.dot(viewUp(view.dir)), 1, 1e-9)

    // And the tie between what is DRAWN and where a click goes: the compass
    // turns the world by the inverse of the camera, so the ball just pressed
    // has to end the flight pointing straight out of the screen at the user.
    const drawn = view.dir.clone().applyQuaternion(facing.clone().invert())
    near(`${view.label}: the ball pressed ends up facing you`, drawn.z, 1, 1e-9)
  }

  // Straight up and straight down are the two the general rule cannot answer:
  // there, world Y is the direction being looked ALONG, so it says nothing
  // about which way round the view is. The answer is the one a continuous
  // orbit would have reached -- tip the front view over the top and up tips
  // with it, from +Y to -Z.
  check('the top view puts -Z at the top of the screen',
    viewUp(new Vector3(0, 1, 0)).equals(new Vector3(0, 0, -1)))
  check('and the bottom view the other way about',
    viewUp(new Vector3(0, -1, 0)).equals(new Vector3(0, 0, 1)))
  check('a front view is level', viewUp(new Vector3(0, 0, 1)).equals(new Vector3(0, 1, 0)))
  // Only exactly overhead counts. A view three degrees off it is an ordinary
  // one, and rolling it would be a jump in the middle of a smooth range.
  check('and so is one nearly overhead',
    viewUp(new Vector3(0.06, 1, 0).normalize()).equals(new Vector3(0, 1, 0)))

  // A flight is measured from the point the camera ORBITS. After a pan that is
  // not the origin, and a flight that kept its distance from the origin would
  // land the user somewhere they had never been.
  const camera = new PerspectiveCamera(45, 1, 0.1, 200)
  camera.position.set(0, 0, 12)
  const panned = new Vector3(6, 0, 0)
  const away = camera.position.distanceTo(panned)
  const flown = orbitPosition(viewQuaternion(new Vector3(0, 0, 1)), panned, away)
  near('a flight after a pan keeps the panned distance', flown.distanceTo(panned), away, 1e-9)
  check('which is not the distance to the origin',
    Math.abs(flown.length() - camera.position.length()) > 1,
    `${flown.length().toFixed(2)} vs ${camera.position.length().toFixed(2)}`)

  // One click, one flight: the request is consumed rather than read, so a
  // frame that picks it up cannot pick it up again on the next.
  askForView(new Vector3(1, 0, 0))
  const first = takeRequest()
  check('a click leaves a request behind', first !== null && Math.abs(first.x - 1) < 1e-9)
  check('and taking it clears it', takeRequest() === null)

  askForView(new Vector3(1, 0, 0))
  askForView(new Vector3(0, 0, 1))
  const second = takeRequest()
  check('a second click redirects rather than queueing',
    second !== null && Math.abs(second.z - 1) < 1e-9)
}

console.log('\nEach mode draws the handles for its own job')
{
  // Which plane each quad IS. The rotation stands a +Z-facing quad onto the
  // plane named by the axis it is normal to, and the arithmetic is done by hand
  // in the source -- so it is stated here rather than trusted, because nothing
  // at runtime would notice it drifting until a drag in what looked like the
  // ground plane walked the solid up a wall.
  for (const axis of [0, 1, 2] as const) {
    const euler = new Euler(...PLANE_ROTATIONS[axis], 'XYZ')
    const normal = new Vector3(0, 0, 1).applyEuler(euler)
    const wanted = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
    // Either facing: a quad is drawn double-sided and a slide across it is the
    // same slide from behind, so only the LINE the normal runs along matters.
    near(
      `plane ${axis} faces along its own axis`,
      Math.abs(normal.dot(wanted)),
      1,
      1e-9
    )

    // And the quad has to land in the world's positive corner, where the arrows
    // point -- a handle drawn behind the object it belongs to is a handle
    // nobody finds. Its own local +X and +Y are what the drawn square spans.
    const inU = new Vector3(1, 0, 0).applyEuler(euler)
    const inV = new Vector3(0, 1, 0).applyEuler(euler)
    for (const [name, dir] of [['U', inU], ['V', inV]] as const) {
      const along = [dir.x, dir.y, dir.z]
      const live = along.findIndex((c) => Math.abs(c) > 0.5)
      check(
        `plane ${axis} spans a world axis in ${name}`,
        live >= 0 && Math.abs(Math.abs(along[live]) - 1) < 1e-9,
        `${dir.toArray()}`
      )
      check(`and spans it POSITIVELY in ${name}`, along[live] > 0, `${dir.toArray()}`)
      check(`and it is not the normal in ${name}`, live !== axis)
    }
    // Between them the two must span the OTHER two axes, not the same one
    // twice -- which is what a rotation with a sign wrong would produce.
    check(
      `plane ${axis} spans two different axes`,
      Math.abs(inU.dot(inV)) < 1e-9,
      `${inU.dot(inV)}`
    )
  }

  // WHAT EACH MODE PUTS UP. This is the whole of what choosing a tool does to
  // the viewport, and it is not otherwise reachable without a camera, a pointer
  // and three React trees.
  const move = gizmoParts('move')
  check('Move stands the arrows up', move.arrows)
  check('and a drag on one SLIDES', move.slide)
  check('and the plane quads stand with them', move.planes)
  // The quads used to wait behind Control, because a billboarded ring crossed
  // all three of them whatever the camera angle and the two took each other's
  // presses. Neither ring is drawn in this mode, so the room is theirs.
  check('with no ring to take their room', !move.ring && !move.rings)

  const rotate = gizmoParts('rotate')
  check('Rotate stands the three rings up', rotate.rings)
  // The arrows point along the axes, and a turn is the one gesture that moves
  // those axes -- they would sweep across the dial being read.
  check('and nothing else at all', !rotate.arrows && !rotate.planes && !rotate.ring)

  const scale = gizmoParts('scale')
  check('Scale stands the ring up', scale.ring)
  check('and the arrows with it', scale.arrows)
  // Which is the whole difference between Scale's arrows and Move's: the same
  // three handles, and a left-drag on one resizes rather than slides.
  check('but a drag on one RESIZES', !scale.slide)
  check('and no quads, which are a way of moving', !scale.planes)
  // AND THEY RIDE THE OBJECT. A resize changes one of the solid's OWN three
  // dimensions -- there is no box that is wider along world X -- so an arrow
  // drawn in the world could only be matched to whichever of them it most
  // nearly ran along, exactly at right angles and by guess in between. Ridden
  // to the object, an arrow points down the side it grows.
  check('and the arrows ride the object rather than the world', scale.local)
  // The other two stay in the world, and it is the same reason twice: a turn is
  // the one gesture that MOVES those axes, and handles that rode the object
  // would sweep out from under the second half of it.
  check('which Move does not', !move.local)
  check('and Rotate does not', !rotate.local)

  // Exactly one of the two rings, in every mode. They are the same circle drawn
  // at the same radius, so a mode that asked for both would have them taking
  // each other's presses from every angle.
  for (const mode of ['move', 'rotate', 'scale'] as const) {
    const parts = gizmoParts(mode)
    check(`${mode} never draws both kinds of ring`, !(parts.ring && parts.rings))
  }

  // The keys, which are the same three switches reached without leaving the
  // model. M is bound like the other two, so Move can be asked for by name
  // rather than only arrived at by pressing whichever tool you are in.
  check('M picks Move', MODE_KEYS.m === 'move')
  check('R picks Rotate', MODE_KEYS.r === 'rotate')
  check('S picks Scale', MODE_KEYS.s === 'scale')
  check(
    'and nothing else is bound',
    Object.keys(MODE_KEYS).sort().join() === 'm,r,s',
  )

  // WHAT A KEY DOES is the store'"'"'s answer, not the key handler'"'"'s. The island'"'"'s
  // three buttons call the same action, so a press and a keystroke cannot mean
  // different things -- which is the whole reason the rule moved out of the
  // handler. M pressed twice therefore ends with no gizmo at all, exactly as
  // pressing the lit Move button does.
  {
    const tools = useTools.getState()
    tools.setTransformMode('move')
    tools.setGizmoHidden(false)
    useTools.getState().pressTransformMode(MODE_KEYS.m)
    check('M on Move takes the handles off', useTools.getState().gizmoHidden === true, 'hidden')
    useTools.getState().pressTransformMode(MODE_KEYS.r)
    check('R brings them back as Rotate', useTools.getState().transformMode === 'rotate' && !useTools.getState().gizmoHidden, useTools.getState().transformMode)
    useTools.getState().pressTransformMode(MODE_KEYS.r)
    check('and R again falls back to Move rather than to nothing', useTools.getState().transformMode === 'move' && !useTools.getState().gizmoHidden, useTools.getState().transformMode)
    useTools.getState().setGizmoHidden(false)
    useTools.getState().setTransformMode('move')
  }

  // A window that loses focus never sees the keyup, so the flag is dropped
  // rather than left to send the next object drag vertical out of nowhere.
  modifiers.shift = true
  clearModifiers()
  check('losing focus forgets what was held', !modifiers.shift)

  // WHAT A NAMED RING MEASURES. Three rings mean the axis is no longer guessed
  // from where the camera is standing -- the ring that was grabbed IS the axis
  // -- and this is the arithmetic that turns a pointer somewhere on that circle
  // into a turn about it. It is `readTurn`'s named branch, minus the camera:
  // the basis comes from `PLANE_ROTATIONS`, the axis from that basis, and the
  // angle from where the pointer met the plane.
  for (const axis of [0, 1, 2] as const) {
    const euler = new Euler(...PLANE_ROTATIONS[axis], 'XYZ')
    const right = new Vector3(1, 0, 0).applyEuler(euler)
    const up = new Vector3(0, 1, 0).applyEuler(euler)
    // Taken from the basis rather than from the name, because two of the three
    // Eulers put their local +Z down the NEGATIVE world axis -- they were
    // chosen to span the positive pair, and something had to give. What must
    // hold is only that it runs along the axis the ring is named for.
    const turnAxis = right.clone().cross(up).normalize()
    const named = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
    near(
      `ring ${axis} turns about its own axis`,
      Math.abs(turnAxis.dot(named)),
      1,
      1e-9
    )

    // A point on the ring, at a known angle round it. The centre is off the
    // origin on purpose: a turn is read about where the gizmo IS.
    const centre = new Vector3(2, -1, 0.5)
    const on = (theta: number) =>
      centre
        .clone()
        .addScaledVector(right, Math.cos(theta) * 0.6)
        .addScaledVector(up, Math.sin(theta) * 0.6)

    const from = 0.4
    const to = 1.1
    near(`ring ${axis} reads the angle it was given`, pointerAngle(on(from), centre, right, up), from, 1e-9)

    const grab = {
      axis: turnAxis.clone(),
      rotation: [0, 0, 0] as Vec3,
      position: [centre.x, centre.y, centre.z] as Vec3,
      lastAngle: from,
      total: 0,
    }
    const swept = advanceTurn(grab, pointerAngle(on(to), centre, right, up))
    near(`and the sweep is how far the pointer went`, swept, to - from, 1e-9)

    // THE POINT OF ALL OF IT: the target follows the hand. A probe standing
    // where the pointer started ends up where the pointer ended -- same plane,
    // same direction, same amount -- which is what "the ring turns under your
    // finger" means when it is written down.
    const probe = on(from).sub(centre).applyEuler(new Euler(...turnedRotation(grab, swept), 'XYZ'))
    near(
      `ring ${axis} carries the target round with the pointer`,
      pointerAngle(probe.add(centre), centre, right, up),
      to,
      1e-9
    )

    // And nothing else moves: a turn about this axis leaves the axis alone,
    // which is the promise a named ring makes that a camera-facing one cannot.
    const along = turnAxis
      .clone()
      .applyEuler(new Euler(...turnedRotation(grab, swept), 'XYZ'))
    near(`and leaves its own axis where it was`, along.dot(turnAxis), 1, 1e-9)
  }

  // The drag arithmetic, which is the axis version in two dimensions: pinned at
  // the grab, and every frame computed from that pin rather than added to the
  // last frame's answer.
  const grab = beginPlaneDrag(new Vector3(2, 0, 3), [1, 1, 1])
  const still = planeTarget(grab, planeTravel(grab, new Vector3(2, 0, 3)))
  check(
    'a pointer that has not moved moves nothing',
    JSON.stringify(still) === JSON.stringify([1, 1, 1]),
    `${still}`
  )

  const moved = planeTarget(grab, planeTravel(grab, new Vector3(2.5, 0, 4)))
  check(
    'and travel across the plane carries the target with it',
    JSON.stringify(moved) === JSON.stringify([1.5, 1, 2]),
    `${moved}`
  )

  // The invariant the whole of gizmoDrag exists for: the answer comes from the
  // GRAB, so re-reading it after the target has moved gives the same result
  // rather than compounding. A grab that re-measured would walk the solid a
  // step further every frame the pointer stood still.
  const again = planeTarget(grab, planeTravel(grab, new Vector3(2.5, 0, 4)))
  check(
    'reading it twice gives one answer, not two steps',
    JSON.stringify(again) === JSON.stringify(moved),
    `${again} vs ${moved}`
  )

  // And it is reversible: back to where the grab was taken is back to where the
  // target started, however far the pointer went in between.
  const home = planeTarget(grab, planeTravel(grab, new Vector3(2, 0, 3)))
  check(
    'coming back to the grab comes back to the start',
    JSON.stringify(home) === JSON.stringify([1, 1, 1]),
    `${home}`
  )
}

console.log('\nThe compass is dragged as well as clicked')
{
  const SPAN = 112

  // The rate is a fraction of the WIDGET, not a fixed number of degrees per
  // pixel, so the constant holds at whatever size the corner is given.
  const across = turnFromDrag(SPAN, 0, SPAN)
  near('a drag across the whole compass is half a turn', Math.abs(across.azimuth), TURN_PER_SPAN, 1e-12)
  const half = turnFromDrag(SPAN / 2, 0, SPAN)
  near('and half of it is half of that', Math.abs(half.azimuth), TURN_PER_SPAN / 2, 1e-12)
  const bigger = turnFromDrag(SPAN, 0, SPAN * 2)
  near(
    'the same pixels on a wider compass turn less',
    Math.abs(bigger.azimuth),
    TURN_PER_SPAN / 2,
    1e-12
  )

  // THE SIGNS. Both negative, and both for the same reason: the compass is a
  // readout of the world, so it follows the hand. These are the deltas added to
  // a spherical about the pivot -- theta the azimuth, phi measured from +Y --
  // and they mirror what OrbitControls does with the very same drag, which is
  // what makes the two gestures feel like one control rather than two.
  check('dragging right swings the scene right', turnFromDrag(10, 0, SPAN).azimuth < 0)
  check('and left, left', turnFromDrag(-10, 0, SPAN).azimuth > 0)
  // Down decreases phi, which raises the camera -- pulling the near side of a
  // thing downward tips its top toward you, so the top face comes into view.
  check('dragging down brings the top into view', turnFromDrag(0, 10, SPAN).polar < 0)
  check('and up, the bottom', turnFromDrag(0, -10, SPAN).polar > 0)

  // The two axes are independent: a purely horizontal drag must not tip the
  // camera, or a gesture meant to spin the model would walk it toward a pole.
  check('a level drag stays level', turnFromDrag(40, 0, SPAN).polar === 0)
  check('and a vertical one does not spin', turnFromDrag(0, 40, SPAN).azimuth === 0)

  // A compass that has not been laid out yet has no size to be a fraction of,
  // and dividing by it would ask the camera for a turn of infinity.
  const unlaid = turnFromDrag(10, 10, 0)
  check(
    'an unmeasured compass asks for nothing',
    unlaid.azimuth === 0 && unlaid.polar === 0,
    JSON.stringify(unlaid)
  )

  // ACCUMULATED, where a click is replaced. The pointer can move several times
  // between two frames, and a turn that overwrote would drop most of a fast
  // gesture -- the camera would visibly lag the hand.
  check('nothing pending at rest', takeTurn() === null)
  askForTurn({ azimuth: 0.1, polar: 0.2 })
  askForTurn({ azimuth: 0.3, polar: -0.1 })
  const drained = takeTurn()
  check('two moves in one frame both count', drained !== null)
  if (drained) {
    near('their spins add', drained.azimuth, 0.4, 1e-12)
    near('and so do their tilts', drained.polar, 0.1, 1e-12)
  }
  check('and draining it leaves nothing behind', takeTurn() === null)

  // The pole clamp. Straight up and straight down are where an orbit stops
  // being defined -- the direction looked along IS the up vector -- so the drag
  // stops short of them rather than tipping the world over.
  const clamped = (phi: number) =>
    Math.max(POLAR_LIMIT, Math.min(Math.PI - POLAR_LIMIT, phi))
  check('a drag cannot reach straight up', clamped(-5) > 0)
  check('nor straight down', clamped(5) < Math.PI)
  near('and in between it is left alone', clamped(1), 1, 1e-12)

  // A turn and a flight are answered by one frame loop, and a drag is the user
  // taking the camera back by hand -- so the two channels stay separate all the
  // way through, and draining one must not disturb the other.
  askForView(new Vector3(0, 1, 0))
  askForTurn({ azimuth: 0.5, polar: 0 })
  const stillAsked = takeRequest()
  check('a drag mid-flight does not swallow the request', stillAsked !== null)
  check('and the request does not swallow the drag', takeTurn() !== null)
}

console.log(
  failures === 0
    ? '\nAll interaction checks passed.\n'
    : `\n${failures} interaction check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
