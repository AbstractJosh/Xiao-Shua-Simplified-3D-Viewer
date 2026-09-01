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
import {
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'

const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}

import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { hostSurfaceFor, surfaceFor } from '../src/geometry/surfaces'
import {
  endFaceCentre,
  endFaceRing,
  featureHandleOrigin,
  outlineOnSurface,
} from '../src/geometry/prism'
import { outlineAxis, sampleOutline } from '../src/geometry/outline'
import { MIN_SHAPE, resizeShapeAlong } from '../src/geometry/dimensions'
import { clampDepth, depthLimits } from '../src/geometry/surfaces'
import { planeSeparates } from '../src/geometry/cut'
import {
  alignCentres,
  objectSnapTargets,
  snapSinglePoint,
  snapTranslation,
  DEFAULT_SNAP_DISTANCE,
} from '../src/geometry/snap'
import type { SnapSource, SnapTarget } from '../src/geometry/snap'
import { frameOf, perspectiveFrame, pixelsToWorld, zoomFor } from '../src/viewport/orthoFrame'
import { GRAB_PX, GRIP_PX, KNOT_PX, PREVIEW_PX, closeRing, markScale, ribbon } from '../src/viewport/CutLayer'
import type { FaceAxis, Pt } from '../src/geometry/laserCut'
import { KERF, faceBasis } from '../src/geometry/laserCut'
import { NO_PAN, clampPan, panCorrection, panLimits } from '../src/viewport/facePan'
import { faceTolerance, sideAlong, snapToPeers } from '../src/viewport/pointSnap'
import { CLAY_RINGS, bore, freshClay, ringHeight, wallAt, withWall } from '../src/geometry/clay'
import {
  LATHE_RULER_LANES,
  latheRulerLength,
  latheRulerRide,
  latheRulerSlide,
  latheRulerSpawn,
  snapLatheEnd,
} from '../src/viewport/latheRuler'
import type { LatheEnd, LatheRuler } from '../src/viewport/latheRuler'
import { pickAnchorAcrossObjects, pickAnchorOnObject, pointerClient } from '../src/viewport/picking'
import {
  publishScene,
  resolveAxisMove,
  resolveObjectMove,
  resolveSolidDrop,
  sketchCentres,
  snapIndicator,
} from '../src/viewport/snapping'
import {
  COMPASS_VIEWS,
  POLAR_LIMIT,
  TURN_PER_SPAN,
  askForTurn,
  askForView,
  nearestView,
  orbitPosition,
  releaseTurn,
  takeRelease,
  takeRequest,
  takeTurn,
  turnFromDrag,
  viewDirection,
  viewQuaternion,
  viewUp,
} from '../src/viewport/compassViews'
import { DAB_SPACING, useTools } from '../src/store/toolStore'
import type { StrokeBrush } from '../src/store/toolStore'
import {
  GRAB_RADIUS,
  PLANE_FROM,
  PLANE_ROTATIONS,
  PLANE_TO,
  gizmoParts,
  hoverHandlers,
} from '../src/viewport/TransformGizmo'
import { modifiers, clearModifiers } from '../src/viewport/modifiers'
import { MODE_KEYS, dragErode, forgetStroke, pauseStroke } from '../src/viewport/Viewport'
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
  NGON_NAMES,
  morphPoints,
  ngonPoints,
  ngonRadii,
  nextNgonSides,
} from '../src/console/ngon'
import { SOLID_TEMPLATES } from '../src/console/solidIcons'
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
  // The bands run ACROSS the chip and render in this array's own order, so the
  // first rendered band is the triangle and the last is the decagon. There is
  // no second, reversed copy of the list any more: a stacked layout needed one
  // because index 0 sat at the bottom, and nothing stacks now.
  check('leftmost band is the triangle', NGON_SIDES[0] === 3, `${NGON_SIDES[0]}`)
  check('rightmost band is the decagon', NGON_SIDES.at(-1) === 10, `${NGON_SIDES.at(-1)}`)
  // The direction is shared with the side-count ticks on a Solids row, which
  // ascend left to right off the template's own list. A sweep that added sides
  // in one panel and removed them in the other is the kind of thing nobody
  // notices until their hand goes the wrong way.
  {
    const families = SOLID_TEMPLATES.map((t) => t.sides).filter((s): s is number[] => Boolean(s))
    check(
      'and Solids ticks ascend the same way',
      families.length > 0 && families.every((s) => s.every((n, i) => i === 0 || n > s[i - 1])),
      families.map((s) => s.join('<')).join(' | ')
    )
  }

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
    .map((t): SnapSource => ({ point: t.kind === 'vertex' ? t.point : new Vector3(), kind: 'corner' }))

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
    .map((t): SnapSource => ({ point: t.kind === 'vertex' ? t.point : new Vector3(), kind: 'corner' }))
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
    .map((t): SnapSource => ({ point: t.kind === 'vertex' ? t.point : new Vector3(), kind: 'corner' }))
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

// --- 9c. Centres ------------------------------------------------------------
console.log('\n9c. Snapping catches middles as well as corners')
{
  resetEvaluator()
  const doc = scene(object(CUBE, 'still', [0, 0, 0]))
  const geometry = evaluateDoc(doc).objects[0].geometry
  const targets = objectSnapTargets('still', geometry, doc.objects[0].transform)
  const centres = targets.filter((t) => t.kind === 'centre')

  // One for the solid, one for each of the six faces. Face middles come free of
  // the face targets, which already carry an area-weighted centroid apiece.
  check('a cube offers seven middles', centres.length === 7, `${centres.length}`)
  const solidCentres = centres.filter((t) => t.kind === 'centre' && t.of === 'solid')
  check('exactly one of them is the solid s own', solidCentres.length === 1)
  if (solidCentres[0]?.kind === 'centre') {
    near('sitting at the middle of the cube', solidCentres[0].point.length(), 0, 1e-9)
  }

  // The pairing rule, which is what lets a centre exist as a source at all.
  const centreTarget = centres.find((t) => t.kind === 'centre' && t.of === 'solid')!
  const faceCentre = centres.find((t) => t.kind === 'centre' && t.of === 'face')!
  const near0 = (x: number, y: number, z: number) => new Vector3(x, y, z)

  const cornerAtCentre = snapTranslation(
    [{ point: near0(0.1, 0, 0), kind: 'corner' }],
    [centreTarget],
    DEFAULT_SNAP_DISTANCE
  )
  check('a corner never catches a middle', cornerAtCentre === null, `${cornerAtCentre?.target.kind}`)

  const centreOnCentre = snapTranslation(
    [{ point: near0(0.1, 0, 0), kind: 'centre' }],
    [centreTarget],
    DEFAULT_SNAP_DISTANCE
  )
  check('but a middle catches another middle', centreOnCentre !== null)
  if (centreOnCentre) near('landing them concentric', centreOnCentre.delta.x, -0.1, 1e-9)

  // The half-buried case the pairing rule exists to prevent: a solid's middle
  // must not be pulled onto a neighbour's FACE middle, only onto its middle.
  const onFaceCentre = snapTranslation(
    [{ point: faceCentre.kind === 'centre' ? faceCentre.point.clone().addScalar(0.05) : near0(0, 0, 0), kind: 'centre' }],
    [faceCentre],
    DEFAULT_SNAP_DISTANCE
  )
  check('and never onto a FACE middle, which would bury it', onFaceCentre === null)

  // A lone point has no body behind it to bury, so it may have every middle --
  // which is what makes a sketch land in the centre of the face it is on.
  if (faceCentre.kind === 'centre') {
    const point = snapSinglePoint(
      faceCentre.point.clone().add(new Vector3(0, 0.06, 0.06)),
      [faceCentre],
      DEFAULT_SNAP_DISTANCE
    )
    check('a lone point does catch a face middle', point !== null)
    if (point) near('landing on it exactly', point.point.distanceTo(faceCentre.point), 0, 1e-9)
  }

  // A corner still wins its own contest: adding centres must not have changed
  // what a corner drag does.
  const flush = snapTranslation(
    [{ point: near0(0.9, 0.9, 0.9), kind: 'corner' }],
    targets,
    DEFAULT_SNAP_DISTANCE
  )
  check('and a corner drag still catches a corner', flush?.target.kind === 'vertex', `${flush?.target.kind}`)
}

{
  // The whole gesture, not just the engine: a small cube dragged near the
  // middle of a big one. The sizes differ so that NOTHING but the middles is in
  // reach -- the small cube's corners are 0.4 from the big one's faces and
  // further still from its corners -- which is the case that used to have no
  // snap at all, because a solid only ever offered its corners.
  resetEvaluator()
  const SMALL: BaseSolid = { kind: 'box', size: [1, 1, 1] }
  const doc = scene(object(CUBE, 'big', [0, 0, 0]), object(SMALL, 'small', [0.1, 0, 0]))
  const evaluated = evaluateDoc(doc)
  publishScene(
    doc.objects.map((o) => ({
      id: o.id,
      geometry: evaluated.objects.find((e) => e.id === o.id)!.geometry,
      transform: o.transform,
      sketches: sketchCentres(o),
    }))
  )
  useTools.getState().setSnap(true)
  useTools.getState().setSnapDistance(DEFAULT_SNAP_DISTANCE)

  const landed = resolveObjectMove('small', [0.1, 0, 0])
  near('a solid dragged near another s middle goes concentric', landed[0], 0, 1e-6)
  near('on every axis', Math.hypot(landed[1], landed[2]), 0, 1e-9)
  check('and the indicator says what it caught', snapIndicator.hit?.target.kind === 'centre', `${snapIndicator.hit?.target.kind}`)

  // Reach still ends somewhere, or two solids could never be left overlapping
  // slightly without one jumping into the other. 0.3 rather than 0.4 because
  // the corner snap is still doing its own job: at 0.4 the small cube's +X face
  // is a tenth short of the big one's, which is a flush catch that has nothing
  // to do with middles and should go on firing.
  const clear = resolveObjectMove('small', [0.3, 0, 0])
  near('and one well off the middle is left alone', clear[0], 0.3, 1e-9)

  // Snapping off means off, here as everywhere else.
  useTools.getState().setSnap(false)
  near('with snapping off nothing is pulled', resolveObjectMove('small', [0.1, 0, 0])[0], 0.1, 1e-9)
  useTools.getState().setSnap(true)
  publishScene([])
}

// --- 9d. Lining middles up one axis at a time --------------------------------
console.log('\n9d. A middle lines up with another middle axis by axis')
{
  // THE ENGINE FIRST, on bare targets, because the rule is about arithmetic and
  // nothing else: each world axis asks on its own whether some other solid's
  // middle shares that coordinate, and the axes that find one contribute their
  // offset while the rest contribute nothing at all.
  const solid = (x: number, y: number, z: number): SnapTarget => ({
    kind: 'centre',
    objectId: 'other',
    of: 'solid',
    point: new Vector3(x, y, z),
  })

  const one = alignCentres(new Vector3(0.1, 4, 9), [solid(0, 0, 0)], DEFAULT_SNAP_DISTANCE)
  check('an axis within reach lines up', one !== null)
  if (one) {
    near('taking x to the middle it found', one.delta.x, -0.1, 1e-9)
    // ALREADY LEVEL IS NOT A CATCH. A ground drag never changes height, so two
    // boxes of a size standing on it are level on every frame of every drag --
    // an offset of exactly zero, inside any tolerance. Counted, it lights a
    // guide that never goes out; worse, on two solids whose middles differ by
    // less than the tolerance it lifts one off the ground to level them.
    check(
      'an axis already lined up is not one of them',
      alignCentres(new Vector3(4, 0, 9), [solid(0, 0, 0)], DEFAULT_SNAP_DISTANCE) === null,
      'nothing to move is nothing to report'
    )
    // THE WHOLE POINT OF THE FEATURE. A middle four units above another and
    // nine along from it is not concentric and must not be made concentric --
    // the other two coordinates are where the pointer put them and stay there.
    near('and leaving y exactly where it was', one.delta.y, 0, 1e-12)
    near('and z too', one.delta.z, 0, 1e-12)
    check('reporting the one axis it caught', one.axes.length === 1 && one.axes[0].axis === 0, `${one.axes.map((a) => a.axis)}`)
    near('and where the other end of the line is', one.axes[0].partner.y, 0, 1e-12)
  }

  const two = alignCentres(new Vector3(0.05, 3, -0.07), [solid(0, 0, 0)], DEFAULT_SNAP_DISTANCE)
  check('two axes can catch at once', two?.axes.length === 2, `${two?.axes.length}`)
  if (two) {
    near('x lines up', two.delta.x, -0.05, 1e-9)
    near('z lines up', two.delta.z, 0.07, 1e-9)
    // A knob centred on a box but standing clear above it: the gesture this was
    // built for, and the one the whole-point pairing could never express.
    near('and the height between them is untouched', two.delta.y, 0, 1e-12)
  }

  check(
    'nothing in reach on any axis catches nothing',
    alignCentres(new Vector3(5, 5, 5), [solid(0, 0, 0)], DEFAULT_SNAP_DISTANCE) === null,
    ''
  )

  // The nearest middle per axis, not the first one offered: two neighbours can
  // each be the better answer on a different axis, and each axis answers alone.
  const split = alignCentres(
    new Vector3(0.15, 0.02, 0),
    [solid(0, 0, 0), solid(0.16, 0.9, 0)],
    DEFAULT_SNAP_DISTANCE
  )
  if (split) {
    near('x takes the nearer of two middles', split.delta.x, 0.01, 1e-9)
    near('while y takes the other one', split.delta.y, -0.02, 1e-9)
  }

  // A FACE middle is a point on the skin, and a body pulled to share a
  // coordinate with one is a body half inside its neighbour -- the same rule
  // `canPair` enforces for the whole-point case.
  const face: SnapTarget = { kind: 'centre', objectId: 'other', of: 'face', point: new Vector3(0, 0, 0) }
  check(
    'and a face middle is never lined up with',
    alignCentres(new Vector3(0.05, 0.05, 0.05), [face], DEFAULT_SNAP_DISTANCE) === null,
    ''
  )

  const only = alignCentres(new Vector3(0.05, 0.05, 0.05), [solid(0, 0, 0)], DEFAULT_SNAP_DISTANCE, 1)
  check('and an arrow lines up its own axis alone', only?.axes.length === 1 && only.axes[0].axis === 1, `${only?.axes.map((a) => a.axis)}`)
  if (only) near('leaving the axes it is not dragging', Math.abs(only.delta.x) + Math.abs(only.delta.z), 0, 1e-12)
}

{
  // AND THE WHOLE GESTURE. A small cube held well above a big one, a hair off
  // its middle in x: dragging it there must centre it over the big one and
  // leave the height alone. Nothing else is within reach at that separation --
  // no corner, no face -- so this is the alignment or it is nothing.
  resetEvaluator()
  const SMALL: BaseSolid = { kind: 'box', size: [1, 1, 1] }
  const doc = scene(object(CUBE, 'big', [0, 0, 0]), object(SMALL, 'small', [0.1, 4, 0]))
  const evaluated = evaluateDoc(doc)
  publishScene(
    doc.objects.map((o) => ({
      id: o.id,
      geometry: evaluated.objects.find((e) => e.id === o.id)!.geometry,
      transform: o.transform,
      sketches: sketchCentres(o),
    }))
  )
  useTools.getState().setSnap(true)
  useTools.getState().setSnapDistance(DEFAULT_SNAP_DISTANCE)

  const over = resolveObjectMove('small', [0.1, 4, 0])
  near('a solid held above another centres over it', over[0], 0, 1e-6)
  near('and keeps every bit of its height', over[1], 4, 1e-9)
  // The guides are the only thing on screen that says this happened: there is
  // no contact to see, and the object shifted without anything under the
  // pointer being touched. Two of them here -- x was pulled, z was already
  // lined up -- and each runs between the two middles.
  // One guide, not two: x had to move and z was already exactly on the middle,
  // which moves nothing and so says nothing.
  check('the drag reports the axis it lined up', snapIndicator.guides.length === 1, `${snapIndicator.guides.length}`)
  check('and marks no landing, because nothing was landed on', snapIndicator.hit === null, `${snapIndicator.hit?.target.kind}`)
  if (snapIndicator.guides.length === 1) {
    near('a guide starts at the solid s own middle', snapIndicator.guides[0].a.y, 4, 1e-6)
    near('and ends at the middle it found', snapIndicator.guides[0].b.y, 0, 1e-9)
  }

  // OUT OF REACH ON EVERY AXIS, and nothing is touched. 0.25 rather than a
  // rounder number because it has to clear TWO radii at once: it is more than
  // the tolerance from the big cube s middle, so no axis lines up, and the small
  // cube s own face lands 0.25 from the big one s -- a face target is a PLANE
  // and has no edges, so a corner four units above the cube still catches the
  // plane of its side if it strays within reach of it.
  const far = resolveObjectMove('small', [0.25, 4, 0.25])
  near('a solid lined up with nothing keeps its x', far[0], 0.25, 1e-9)
  near('and its z', far[2], 0.25, 1e-9)
  check('with no guides drawn', snapIndicator.guides.length === 0, `${snapIndicator.guides.length}`)

  // THE ARROW KEEPS ITS PROMISE. Dragging along x may change x and nothing
  // else, however near the other two are to lining up -- so the y and z that
  // would have caught in a free drag are left alone here.
  const along = resolveAxisMove('small', [0.1, 4, 0.05], new Vector3(1, 0, 0))
  near('an x arrow lines the middles up in x', along[0], 0, 1e-6)
  near('and refuses to touch z, however near it is', along[2], 0.05, 1e-12)

  // Snapping off means off, here as everywhere else.
  useTools.getState().setSnap(false)
  near('with snapping off nothing lines up', resolveObjectMove('small', [0.1, 4, 0])[0], 0.1, 1e-9)
  check('and nothing is drawn', snapIndicator.guides.length === 0, `${snapIndicator.guides.length}`)
  useTools.getState().setSnap(true)
  publishScene([])
}

{
  // A sketch at depth zero cuts nothing, so its middle is nowhere in the mesh.
  // It has to be carried alongside, or the one sketch a user is most likely to
  // want to line something up with would be the one that could not be caught.
  resetEvaluator()
  const flat: Feature = {
    id: 'f1',
    anchor: { on: 'box-face', face: 2, u: 0.5, v: 0 },
    shape: { type: 'circle', r: 0.3 },
    rotation: 0,
    depth: 0,
    enabled: true,
    tilt: [0, 0, 0],
    faceOffset: [0, 0],
  }
  const doc = scene(object(CUBE, 'host', [0, 0, 0], [flat]))
  const geometry = evaluateDoc(doc).objects[0].geometry
  const withSketch = objectSnapTargets(
    'host',
    geometry,
    doc.objects[0].transform,
    sketchCentres(doc.objects[0])
  )
  const mine = withSketch.filter((t) => t.kind === 'centre' && t.featureId === 'f1')
  check('a flat sketch still offers its middle', mine.length === 1, `${mine.length}`)
  if (mine[0]?.kind === 'centre') {
    // u = 0.5 of a half-extent of 1, on the +Y face of a 2-cube.
    near('at the point on the face it was seated', mine[0].point.x, 0.5, 1e-9)
    near('on the face itself', mine[0].point.y, 1, 1e-9)
  }

  // And a raised one offers the middle of the face it made as well.
  const boss = { ...flat, id: 'f2', depth: 0.4 }
  const raised = scene(object(CUBE, 'host', [0, 0, 0], [boss]))
  const both = objectSnapTargets(
    'host',
    evaluateDoc(raised).objects[0].geometry,
    raised.objects[0].transform,
    sketchCentres(raised.objects[0])
  ).filter((t) => t.kind === 'centre' && t.featureId === 'f2')
  check('a boss offers its base AND its top', both.length === 2, `${both.length}`)
  const tops = both.filter((t) => t.kind === 'centre' && Math.abs(t.point.y - 1.4) < 1e-6)
  check('the top standing at the height it was pulled to', tops.length === 1, `${tops.length}`)
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
  // The two directions are different questions -- a boss's reach is a matter of
  // taste, a pocket's is the crossing it has to make -- so the slider is not
  // symmetric about zero and the clamp has to be asked one direction at a time.
  // On a CUBE the outward number is the larger of the two; on a slab pierced
  // through its long axis it is not, which is the point of asking per anchor.
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

// --- 12d. The sketch gizmo stands on the face the feature created ----------
console.log('\n12d. The sketch gizmo stands at the tip of the extrusion')
{
  const top: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }
  const host = hostSurfaceFor(CUBE, top)
  const frame = host.frame(top)
  const shape = { type: 'circle', r: 0.3 } as const
  const rad = (d: number) => (d * Math.PI) / 180

  const tipOf = (depth: number, tilt: Vec3 = [0, 0, 0], faceOffset: [number, number] = [0, 0]) =>
    featureHandleOrigin(host, top, { depth, tilt, faceOffset })

  // A boss's top, a pocket's floor, and -- while the feature has made neither --
  // the sketch on the surface itself.
  near('a boss puts the gizmo on its top', tipOf(0.3).y, frame.origin.y + 0.3, 1e-12)
  near('a pocket puts it on the floor', tipOf(-0.4).y, frame.origin.y - 0.4, 1e-12)
  near('a flat projection leaves it on the surface', tipOf(0).y, frame.origin.y, 1e-12)

  // The CENTRE of that face, not a point near it: the handle draws the face
  // from `endFaceRing`, and a gizmo standing anywhere else would be annotating
  // a face it was not on.
  const ring = endFaceRing(host, top, {
    shape,
    rotation: 0,
    depth: 0.3,
    tilt: [0, 0, 0],
    faceOffset: [0, 0],
  })
  check(
    'and it is the centre of the face the handle draws',
    tipOf(0.3).distanceTo(endFaceCentre(ring)) < 1e-9,
    `${tipOf(0.3).distanceTo(endFaceCentre(ring)).toExponential(1)} apart`
  )

  // A LEAN MUST NOT MOVE IT. The created plane pivots about its own centre, and
  // that is what lets a ring measure an angle about a point that holds still --
  // a centre that moved with the turn would feed the drag back into itself.
  check(
    'leaning the face does not move the gizmo',
    tipOf(0.3, [rad(30), 0, 0]).distanceTo(tipOf(0.3)) < 1e-12,
    ''
  )
  // A slide does move it, because the face has gone there and the gizmo is on it.
  near('but sliding the face carries it along', tipOf(0.3, [0, 0, 0], [0.5, 0]).x, 0.5, 1e-12)
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

console.log('\nA settling compass comes to rest square on to a face')
{
  // THE LASER CUTTER'S WHOLE CAMERA, and it is arithmetic rather than a widget:
  // the screen offers no orbit and no pan, so where a drag LEAVES the camera is
  // decided entirely by which of the six views this function picks. A wrong
  // answer here is a screen that settles on the face behind you.

  // A camera already square on to a view settles on that view and no other --
  // the case that has to hold, since it is where every gesture ends up.
  for (const view of COMPASS_VIEWS) {
    const settled = nearestView(viewQuaternion(view.dir))
    check(`${view.label} settles on itself`, settled.key === view.key, settled.key)
  }

  // The direction it measures is the one the camera STANDS in, not the one it
  // looks along -- get that backwards and every settle lands on the opposite
  // face, which is the one mistake here that still looks like a working screen.
  for (const view of COMPASS_VIEWS) {
    const dir = viewDirection(viewQuaternion(view.dir))
    near(`${view.label}: the view direction is where the camera stands`, dir.dot(view.dir), 1, 1e-9)
    near(`${view.label}: and it is a unit vector`, dir.length(), 1, 1e-9)
  }

  // A nudge off a face still settles back onto it. Fifteen degrees is well past
  // anything a hand leaves behind when it lets go, and nowhere near the
  // forty-five where the answer is genuinely two-ways.
  {
    const nudged = new Vector3(0, 0, 1)
      .applyAxisAngle(new Vector3(0, 1, 0), (15 * Math.PI) / 180)
      .applyAxisAngle(new Vector3(1, 0, 0), (10 * Math.PI) / 180)
    check('a view nudged off Front settles back on Front',
      nearestView(viewQuaternion(nudged)).key === 'z+',
      nearestView(viewQuaternion(nudged)).key)
  }

  // Past halfway it settles on the NEXT face rather than crawling back to the
  // one it started from: the answer is the nearest face, not the last one.
  {
    const most = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), (60 * Math.PI) / 180)
    check('and one dragged most of the way round settles on Right',
      nearestView(viewQuaternion(most)).key === 'x+',
      nearestView(viewQuaternion(most)).key)
  }

  // Every direction lands on SOMETHING, including the diagonals where two or
  // three faces are equally near. There is no better answer on a corner than a
  // consistent one, and no answer at all would strand the camera between faces.
  {
    let answered = 0
    for (const corner of [
      new Vector3(1, 1, 1),
      new Vector3(-1, 1, 1),
      new Vector3(1, -1, -1),
      new Vector3(-1, -1, -1),
      new Vector3(1, 1, 0),
      new Vector3(0, -1, 1),
    ]) {
      const dir = corner.clone().normalize()
      const settled = nearestView(viewQuaternion(dir))
      // Whichever it picks has to be one of the three the corner actually
      // touches -- a corner settling onto a face it points away from would be
      // the camera swinging past the model to get there.
      if (settled.dir.dot(dir) > 0) answered += 1
    }
    check('a camera on a corner settles onto a face it is already facing', answered === 6, `${answered}/6`)
  }

  // And the flag the widget leaves behind: consumed rather than read, so one
  // release is one settle. A drag that ended two frames ago must not settle a
  // camera the user has since taken somewhere else.
  takeRelease()
  check('nothing to take before a drag ends', takeRelease() === false)
  releaseTurn()
  check('letting go of the compass leaves word behind', takeRelease() === true)
  check('and taking it clears it', takeRelease() === false)
}

console.log('\nAnd a projected camera measures the same everywhere it looks')
{
  // THE LASER CUTTER'S OTHER CAMERA DECISION, and the one the compass cannot
  // make for it. Settling square on to a face fixes the DIRECTION the block is
  // seen from; only a parallel projection fixes the SCALE it is seen at, and
  // that screen needs both, because everything on it is a thing measured
  // against something else -- a reference against the drawing it traces, a cut
  // against the edge of the material.
  //
  // So the difference is stated here as arithmetic: two cameras standing in
  // exactly the same place, looking at exactly the same block. None of it is a
  // thing a screenshot gives away, since both pictures look like a block.

  /** Four units off the block, through the room's own forty-five degree lens
   *  -- see `STAGE_CAMERA`, and `LaserViewport` for the screen that stands
   *  here. Restated rather than imported, because what is checked below is the
   *  geometry these numbers are an instance of; the screen's own choice of them
   *  is pinned in `ui-check`. */
  const STANDOFF = 4
  const FOV = 45
  /** A canvas, because a projection's zoom is pixels per world unit and says
   *  nothing at all without one. */
  const TALL = 900
  const WIDE = 1600

  /** A BAR rather than a cube: one deep enough that its far face is a long way
   *  behind its near one, which is where every difference below lives. Two
   *  units deep, standing on the ground, so the faces are at z = 1 and z = -1
   *  and the middle of it is half a unit up. */
  const DEPTH = 2
  const MIDDLE = new Vector3(0, 0.5, 0)

  const frame = perspectiveFrame(STANDOFF, FOV)

  const lens = new PerspectiveCamera(FOV, WIDE / TALL, 0.005, 1000)
  lens.position.set(0, 0.5, STANDOFF)
  lens.lookAt(MIDDLE)
  lens.updateMatrixWorld()

  // The frustum fiber gives an orthographic camera: the canvas's own half-width
  // and half-height, in pixels, with `zoom` left to say how much world that
  // covers. See `orthoFrame.ts`.
  const flat = new OrthographicCamera(WIDE / -2, WIDE / 2, TALL / 2, TALL / -2, 0.005, 1000)
  flat.zoom = zoomFor(TALL, frame)
  flat.position.set(0, 0.5, STANDOFF)
  flat.lookAt(MIDDLE)
  flat.updateProjectionMatrix()
  flat.updateMatrixWorld()

  /** Where a point in the world lands on screen, as a fraction of half the
   *  window. */
  const seen = (at: Vector3, camera: PerspectiveCamera | OrthographicCamera) =>
    at.clone().project(camera)

  // FIRST, THE THING THAT WAS ALREADY RIGHT, because it is what stops all of
  // this reading as a bug being fixed. A plane parallel to the film is scaled
  // uniformly however far across it you go, so a line drawn square on to a face
  // landed exactly where it looked even under a lens. What a lens got wrong was
  // never the aim; it was everything the aim is measured against.
  {
    const on = (u: number) => new Vector3(u, 0.5, DEPTH / 2)
    const middle = seen(on(0.1), lens).x - seen(on(0), lens).x
    const edge = seen(on(0.5), lens).x - seen(on(0.4), lens).x
    near('a lens square on to a face still measures that face evenly', edge, middle, 1e-12)
  }

  // THE FAR FACE AGAINST THE NEAR ONE, which is the reference's problem: the
  // same picture on the back of the block is a block's depth further off, so a
  // lens draws it smaller -- by the ratio of the two distances, exactly, which
  // for a two-unit bar seen from four units out is five thirds. Size a picture
  // against the drawing on one face and it no longer matches it on the other.
  {
    const span = (z: number, camera: PerspectiveCamera | OrthographicCamera) =>
      seen(new Vector3(0.2, 0.5, z), camera).x - seen(new Vector3(-0.2, 0.5, z), camera).x

    near(
      'through a lens the same picture on the far face is drawn smaller',
      span(DEPTH / 2, lens) / span(-DEPTH / 2, lens),
      (STANDOFF + DEPTH / 2) / (STANDOFF - DEPTH / 2),
      1e-9
    )
    near(
      'projected, the two are the same size to the last digit',
      span(-DEPTH / 2, flat),
      span(DEPTH / 2, flat),
      1e-12
    )
  }

  // THE SIDES AGAINST THE FACE. A lens square on to a block does not show the
  // block's face: the four faces around the one being looked at splay out from
  // behind it, so what the eye reads as the edge of the material stands outside
  // the face the cut has to stay inside. Projected, the silhouette IS the face.
  {
    const front = new Vector3(0.5, 1, DEPTH / 2)
    const back = new Vector3(0.5, 1, -DEPTH / 2)
    check(
      'through a lens the far corner stands outside the near one',
      seen(front, lens).x - seen(back, lens).x > 0.05,
      `${(seen(front, lens).x - seen(back, lens).x).toFixed(3)} of half a window`
    )
    near("projected, the block's outline is the face's own", seen(back, flat).x, seen(front, flat).x, 1e-12)
    near('in both directions', seen(back, flat).y, seen(front, flat).y, 1e-12)
  }

  // AND THE BLOCK AGAINST ITSELF. Type a bigger Depth and a lens brings the
  // front face nearer the camera, so a block made deeper is drawn WIDER without
  // getting wider: one field of the corner panel moving two dimensions on
  // screen, which is the one of these a user would notice and disbelieve.
  {
    const corner = (depth: number, camera: PerspectiveCamera | OrthographicCamera) =>
      seen(new Vector3(0.5, 0.5, depth / 2), camera).x

    near(
      'through a lens a deeper block is drawn wider than a shallow one',
      corner(3, lens) / corner(1, lens),
      (STANDOFF - 0.5) / (STANDOFF - 1.5),
      1e-9
    )
    near(
      'projected, changing the Depth leaves the front face exactly where it was',
      corner(3, flat),
      corner(1, flat),
      1e-12
    )
  }

  // THE SAME FACT FROM THE POINTER'S SIDE, which is how a cut is actually
  // aimed: `CutLayer` fires a ray at the face's own plane and reads off where
  // it lands. Projected, those rays are parallel, so a span of pointer means
  // the same span of face whichever of the six faces the compass has settled on
  // -- which is what lets one drawn line mean one cut on any of them.
  {
    const RAY = new Raycaster()
    const reach = (ndcX: number, z: number, camera: PerspectiveCamera | OrthographicCamera) => {
      RAY.setFromCamera(new Vector2(ndcX, 0), camera)
      const hit = new Vector3()
      // A plane facing the camera, `z` along its own normal from the origin.
      return RAY.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -z), hit) ? hit.x : NaN
    }
    const span = (z: number, camera: PerspectiveCamera | OrthographicCamera) =>
      reach(0.5, z, camera) - reach(-0.5, z, camera)

    near(
      'a pointer span reaches the same distance on the near face and the far one',
      span(-DEPTH / 2, flat),
      span(DEPTH / 2, flat),
      1e-12
    )
    check(
      'where through a lens it reaches further the further off the face is',
      span(-DEPTH / 2, lens) > span(DEPTH / 2, lens) * 1.5,
      `${span(-DEPTH / 2, lens).toFixed(3)} against ${span(DEPTH / 2, lens).toFixed(3)}`
    )
  }

  // AND THE ARITHMETIC UNDER ALL OF IT. `perspectiveFrame` is the join between
  // a projection and the lens the rest of the app looks through, so it is held
  // to three's own camera rather than to itself: a point at the top of the
  // frame it names has to land exactly at the top of the screen, and a
  // projection set to that frame has to put it in the same place.
  {
    const top = new Vector3(0, 0.5 + frame / 2, 0)
    near('the frame a lens throws is the frame it was asked for', seen(top, lens).y, 1, 1e-9)
    near('and a projection set to it frames the very same', seen(top, flat).y, 1, 1e-12)

    // A zoom is not a magnification, which is the whole reason `HoldFrame`
    // exists: half the window at half the zoom holds the same slice of world,
    // so a resize is a rescale rather than a reframing.
    const zoom = zoomFor(TALL, frame)
    near('a zoom is pixels per world unit', zoom, TALL / frame, 1e-12)
    near('and reading it back gives the frame again', frameOf(TALL, zoom), frame, 1e-12)
    const shorter = zoomFor(TALL / 2, frameOf(TALL, zoom))
    near('a window half as tall holds that frame at half the zoom', shorter, zoom / 2, 1e-12)
    near('which is the same slice of the world', frameOf(TALL / 2, shorter), frame, 1e-12)
  }

  // --- FURNITURE HOLDS ITS SIZE, THE WORK DOES NOT ------------------------
  //
  // WHAT ZOOMING IN IS FOR. The knots on a point cut used to be two hundredths
  // of the block, so the wheel magnified them along with everything else:
  // leaning in to place a point precisely made the point itself cover the
  // detail being aimed at, and a reference underneath it disappeared behind a
  // row of dots. A mark you put a finger on belongs to the SCREEN and is drawn
  // at a size in pixels; the kerf, the block and the drawing stuck to it belong
  // to the BLOCK and grow. See `pixelsToWorld` and `markScale`.
  //
  // Held to real numbers rather than to a source string: the marks are drawn
  // inside the block's own scaled group, so the arithmetic has two transforms
  // to undo and either could be dropped without anything else complaining.
  {
    /** What a mark of `px` actually measures on screen, drawn on this block. */
    const onScreen = (px: number, zoom: number, dims: [number, number, number], axis: number) =>
      markScale(px, zoom, dims)[axis] * dims[axis] * zoom

    // Every block shape this app allows, including the extremes: a millimetre
    // sheet and a five-metre bar are both looked at square on here, and the
    // mark has to come out the same size on either.
    const BLOCKS: [number, number, number][] = [[1, 1, 1], [0.01, 5, 0.4], [50, 0.1, 12]]
    const opening = zoomFor(TALL, frame)
    for (const [what, zoom] of [
      ['at the opening frame', opening],
      ['zoomed in four times', opening * 4],
      ['zoomed right in', opening * 40],
      ['and pulled well back', opening / 8],
    ] as [string, number][]) {
      let worst = 0
      for (const dims of BLOCKS) {
        for (let axis = 0; axis < 3; axis++) {
          worst = Math.max(worst, Math.abs(onScreen(KNOT_PX, zoom, dims, axis) - KNOT_PX))
        }
      }
      check(
        `a knot is ${KNOT_PX}px ${what}, on any block and any axis of it`,
        worst < 1e-9,
        `worst ${worst} off at zoom ${zoom.toFixed(0)}`
      )
    }
    near('and a handle grip is the finer of the two', onScreen(GRIP_PX, opening * 3, [1, 2, 3], 1), GRIP_PX, 1e-9)
    check('which is smaller than the knot it stands off from', GRIP_PX < KNOT_PX, `${GRIP_PX} of ${KNOT_PX}`)

    // A knot is round on a SHEET, which is the half of it the block's own scale
    // would take away: undo two of the three axes and the mark comes out an
    // ellipse on any stock that is not a cube.
    const sheet: [number, number, number] = [3, 0.05, 2]
    const mark = markScale(KNOT_PX, opening, sheet)
    near('a knot on a sheet is a ball, not an egg', mark[0] * sheet[0], mark[1] * sheet[1], 1e-12)
    near('on every axis of it', mark[1] * sheet[1], mark[2] * sheet[2], 1e-12)

    near('a mark of no pixels is nothing at any zoom', pixelsToWorld(0, opening), 0, 1e-12)

    // AND THE LINE ITSELF, which is the same rule applied to the one piece of
    // furniture that is not a dot. It used to be drawn three kerfs wide -- a
    // width in the MATERIAL -- so ten turns in it was a fifty-pixel band of
    // solid colour lying across the drawing being traced. Now it is four
    // pixels, at every zoom, and the slot it used to stand for is read off
    // `KERF` instead. See `PREVIEW_PX`.
    //
    // MEASURED OFF THE BUILT STRIP rather than trusted: `ribbon` offsets each
    // station sideways in FACE coordinates and the block scales those by a
    // different number on each axis, so the width is only constant if that
    // stretch is undone per station, in the direction that station happens to
    // point. A straight line would pass either way; the bent ones are what
    // catch it.
    {
      /** The strip's actual width in world units, at its widest and narrowest. */
      const widths = (line: Pt[], face: FaceAxis, dims: [number, number, number], zoom: number) => {
        const strip = ribbon(line, face, pixelsToWorld(PREVIEW_PX, zoom), dims)
        if (!strip) return null
        const at = strip.getAttribute('position')
        const out: number[] = []
        // Six vertices per station pair, of which the first two are the two
        // edges of the same station -- see the winding in `ribbon`.
        for (let i = 0; i + 1 < at.count; i += 6) {
          const edge = new Vector3(
            (at.getX(i) - at.getX(i + 1)) * dims[0],
            (at.getY(i) - at.getY(i + 1)) * dims[1],
            (at.getZ(i) - at.getZ(i + 1)) * dims[2]
          )
          out.push(edge.length())
        }
        strip.dispose()
        return out
      }

      const LINES: [string, Pt[]][] = [
        ['straight across', [[-0.4, 0], [0.4, 0]]],
        ['straight up', [[0, -0.4], [0, 0.4]]],
        ['on the diagonal', [[-0.4, -0.4], [0.4, 0.4]]],
        ['round a corner', [[-0.4, -0.3], [0, 0], [0.3, -0.35], [0.4, 0.2]]],
      ]
      const FACES: FaceAxis[] = [
        { axis: 2, sign: 1 },
        { axis: 0, sign: -1 },
        { axis: 1, sign: 1 },
      ]

      let worst = 0
      let worstWhere = ''
      for (const zoom of [opening, opening * 4, opening * 40]) {
        for (const dims of BLOCKS) {
          for (const face of FACES) {
            for (const [what, line] of LINES) {
              for (const width of widths(line, face, dims, zoom) ?? []) {
                const off = Math.abs(width * zoom - PREVIEW_PX)
                if (off > worst) {
                  worst = off
                  worstWhere = `${what} on ${dims.join('x')} at zoom ${zoom.toFixed(0)}: ${(width * zoom).toFixed(3)}px`
                }
              }
            }
          }
        }
      }
      // A twentieth of a pixel, and the slack is FLOAT32 rather than doubt. The
      // strip is a buffer attribute, so an offset of a few millionths of a face
      // is stored against a coordinate of nearly half a one -- on a fifty-unit
      // block wound right in, that quantises the width by about a hundredth of
      // a pixel. What this is looking for is a systematic wedge, which is off
      // by a factor rather than by a rounding.
      check(
        `the line is ${PREVIEW_PX}px wide down its whole length, on any block, face and bearing`,
        worst < 0.05,
        worstWhere || 'no strip was built'
      )

      // A line of one point is nothing to draw, not a strip of no width.
      check('and a line of one point draws nothing at all', ribbon([[0, 0]], FACES[0], 0.01, [1, 1, 1]) === null, '')
    }

    // THE RING THAT SAYS WHERE THE LOOP CLOSES follows the same rule, and has
    // one claim of its own on top of it: it is drawn at exactly the radius the
    // press catches at, so the circle IS the target rather than a decoration
    // near it. A ring that lied about its reach would be worse than none --
    // a user would aim at the edge of it and place a point instead. See
    // `closeRing` and `GRAB_PX`.
    {
      const RING_FACES: FaceAxis[] = [
        { axis: 0, sign: 1 },
        { axis: 0, sign: -1 },
        { axis: 1, sign: 1 },
        { axis: 1, sign: -1 },
        { axis: 2, sign: 1 },
        { axis: 2, sign: -1 },
      ]
      // Read off the built geometry rather than trusted: the circle is laid out
      // in the face's own two axes, and the mark scale then divides by each
      // side of the block separately. Both have to be right or it comes out an
      // ellipse, edge-on, or off the plane entirely.
      let roundest = 0
      let flattest = 0
      let offPlane = 0
      for (const face of RING_FACES) {
        for (const dims of BLOCKS) {
          const geometry = closeRing(faceBasis(face))
          const at = geometry.getAttribute('position').array as ArrayLike<number>
          const scale = markScale(GRAB_PX, opening, dims)
          const { n } = faceBasis(face)
          let min = Infinity
          let max = 0
          for (let v = 0; v < at.length; v += 3) {
            // What the vertex is worth in WORLD units: the mark's own scale,
            // then the block's, which is the pair `markScale` exists to undo.
            const x = at[v] * scale[0] * dims[0]
            const y = at[v + 1] * scale[1] * dims[1]
            const z = at[v + 2] * scale[2] * dims[2]
            const r = Math.hypot(x, y, z)
            min = Math.min(min, r)
            max = Math.max(max, r)
            offPlane = Math.max(offPlane, Math.abs(x * n.x + y * n.y + z * n.z))
          }
          roundest = Math.max(roundest, Math.abs(max * opening - GRAB_PX))
          // As a RATIO rather than a difference: the ring is a buffer
          // attribute, so its vertices are float32, and on a fifty-unit block
          // that is a few billionths of noise on a mark a thousandth of a unit
          // across. What an ellipse would be is a factor.
          flattest = Math.max(flattest, max / min - 1)
          geometry.dispose()
        }
      }
      check(
        `the closing ring is ${GRAB_PX}px across -- the very reach the press catches at`,
        roundest < 1e-9,
        `worst ${roundest.toExponential(1)}px off`
      )
      check('and round on any stock, not an egg on a sheet', flattest < 1e-5, `${flattest.toExponential(1)} out of round`)
      check('lying flat in the face it rings, on all six of them', offPlane < 1e-12, `${offPlane.toExponential(1)} out`)
      check('and standing clear of the knot inside it', GRAB_PX > KNOT_PX, `${GRAB_PX} against ${KNOT_PX}`)
    }

    // AND WHAT DOES NOT FOLLOW THE RULE, which is what makes the rest of it
    // worth having: the slot the laser actually burns is measured in the
    // material and is whatever it is. Nothing on screen stands for it any more,
    // so this is where its size lives.
    const kerfPixels = (zoom: number) => KERF * zoom
    check(
      'while the kerf the cut takes is still material, and grows with the wheel',
      kerfPixels(opening * 4) > kerfPixels(opening) * 3.9,
      `${kerfPixels(opening).toFixed(2)}px to ${kerfPixels(opening * 4).toFixed(2)}px`
    )
  }

  // AND THE OTHER HALF OF THE WHEEL. A projection cannot be walked closer, so
  // zooming magnifies about the middle of the window and carries the edges of
  // the face out past the rim -- which is where a cut is aimed. The right
  // button slides the view across the face to reach them, bounded so the block
  // can never be carried off the screen. See `facePan.ts`.
  {
    // The bar the rest of this section is measured on: two deep, standing on
    // the ground, so its middle is half a unit up and its front face is the
    // square at z = 1.
    const BAR: [number, number, number] = [1, 1, DEPTH]

    // THE LIMIT IS THE EDGE OF THE FACE, in the two directions the face has,
    // and nothing at all in the third.
    for (const axis of [0, 1, 2] as const) {
      const limits = panLimits(axis, BAR)
      near(`looking along ${axis}, no travel toward the face`, limits[axis], 0, 1e-12)
      for (const other of [0, 1, 2] as const) {
        if (other === axis) continue
        near(
          `and half the block across it -- ${axis} sees ${other}`,
          limits[other],
          BAR[other] / 2,
          1e-12
        )
      }
    }

    // A RECTANGLE RATHER THAN A DISC, which is the whole reason this is not
    // three's own `maxTargetRadius`: the corners of a face are further from its
    // middle than its edges are, and a round limit would refuse to reach them.
    {
      const limits = panLimits(2, BAR)
      const corner = clampPan([BAR[0] / 2, BAR[1] / 2, 0], limits)
      near('the far corner of a face is reachable in x', corner[0], BAR[0] / 2, 1e-12)
      near('and in y at the same time', corner[1], BAR[1] / 2, 1e-12)
    }

    // And a shove past it stops AT it, either way about.
    {
      const limits = panLimits(2, BAR)
      const held = clampPan([99, -99, 99], limits)
      near('a shove past the edge stops on it', held[0], BAR[0] / 2, 1e-12)
      near('and on the other side too', held[1], -BAR[1] / 2, 1e-12)
      near('with the face axis pinned whatever is asked of it', held[2], 0, 1e-12)
      const inside: [number, number, number] = [0.1, -0.2, 0]
      const kept = clampPan(inside, limits)
      near('while a pan inside the face is left exactly alone', kept[0], inside[0], 1e-12)
      near('in both directions', kept[1], inside[1], 1e-12)
    }

    // WHAT THE LIMIT IS WORTH, against three's own camera: slid all the way,
    // the corner of the face stands in the MIDDLE of the window. Which is the
    // promise -- every part of a face can be brought to the middle of the
    // screen at any zoom -- and it is a claim about a camera rather than about
    // arithmetic, so it is asked of one.
    {
      const limits = panLimits(2, BAR)
      const panned = new OrthographicCamera(WIDE / -2, WIDE / 2, TALL / 2, TALL / -2, 0.005, 1000)
      // Twenty times the zoom the screen opens on: a face that fills the window
      // twenty times over, which is the case the pan exists for.
      panned.zoom = zoomFor(TALL, frame) * 20
      panned.position.set(limits[0], 0.5 + limits[1], STANDOFF)
      panned.lookAt(new Vector3(limits[0], 0.5 + limits[1], 0))
      panned.updateProjectionMatrix()
      panned.updateMatrixWorld()

      const corner = new Vector3(BAR[0] / 2, 0.5 + BAR[1] / 2, DEPTH / 2)
      near('slid to the limit, the corner of the face is dead centre', seen(corner, panned).x, 0, 1e-9)
      near('in both directions', seen(corner, panned).y, 0, 1e-9)

      // And at that zoom the middle of the block is long gone off the window,
      // which is what makes the pan the only way to have reached the corner.
      check(
        'while the middle of the block is far outside it',
        Math.abs(seen(new Vector3(0, 0.5, DEPTH / 2), panned).y) > 1,
        `${seen(new Vector3(0, 0.5, DEPTH / 2), panned).y.toFixed(2)} of half a window`
      )
    }

    // AND THE CORRECTION ITSELF, driven into a camera the way the screen drives
    // it. This is the part with a sign in it, and a sign that is the wrong way
    // round does not look like a bug -- it looks like a pan with a rubber band
    // on it. So the whole loop is run: shove the pivot past the edge the way a
    // drag does, correct it, and ask the camera what it can see.
    //
    // WHAT MUST SURVIVE is the offset between the camera and the point it
    // orbits. Three rebuilds the camera's position from those two every update,
    // so a correction applied to one and not the other is a view tipped off the
    // face -- which on this screen is a cut that lands somewhere other than
    // where it was drawn.
    {
      const middle = new Vector3(0, 0.5, 0)
      const limits = panLimits(2, BAR)

      const run = (pivot: Vector3) => {
        const eye = new OrthographicCamera(WIDE / -2, WIDE / 2, TALL / 2, TALL / -2, 0.005, 1000)
        eye.zoom = zoomFor(TALL, frame) * 20
        // Where a drag leaves the two: the pivot slid across the face, and the
        // camera carried along with it.
        eye.position.set(pivot.x, pivot.y, STANDOFF)
        const before = eye.position.clone().sub(pivot)

        const [dx, dy, dz] = panCorrection(
          [pivot.x, pivot.y, pivot.z],
          [middle.x, middle.y, middle.z],
          limits
        )
        const held = pivot.clone().add(new Vector3(dx, dy, dz))
        eye.position.add(new Vector3(dx, dy, dz))
        eye.lookAt(held)
        eye.updateProjectionMatrix()
        eye.updateMatrixWorld()
        return { eye, held, before, after: eye.position.clone().sub(held) }
      }

      // A shove a long way past the top right corner of the front face.
      const wild = run(new Vector3(4, 0.5 + 4, 0))
      near('a pan shoved past the corner is pulled back to it in x', wild.held.x, BAR[0] / 2, 1e-12)
      near('and in y', wild.held.y - middle.y, BAR[1] / 2, 1e-12)
      near('with the camera kept exactly where it stood off the pivot', wild.after.x, wild.before.x, 1e-12)
      near('in every direction', wild.after.y, wild.before.y, 1e-12)
      near('so the view is still square on to the face', wild.after.z, wild.before.z, 1e-12)
      // Which is the point of keeping it: the face is still drawn face-on, so a
      // line drawn across it is still the line that gets cut.
      const on = (u: number) => new Vector3(u, 0.5, DEPTH / 2)
      near(
        'and still measures that face evenly across the window',
        seen(on(0.4), wild.eye).x - seen(on(0.3), wild.eye).x,
        seen(on(0.1), wild.eye).x - seen(on(0), wild.eye).x,
        1e-9
      )

      // A pan that is inside its limits is not touched at all -- the ordinary
      // frame, and the one where a correction that fired anyway would feel like
      // a camera fighting the hand.
      const easy = run(new Vector3(0.2, 0.5 + 0.1, 0))
      near('a pan inside the face is left where it was put', easy.held.x, 0.2, 1e-12)
      near('to the last digit', easy.held.y - middle.y, 0.1, 1e-12)

      // AND A FACE CHANGE WALKS IT HOME by the same path: the limits go to
      // nothing for one frame, and the correction that follows is the whole pan
      // in reverse. One road back, so a reset cannot land anywhere a clamp
      // could not.
      const slid = new Vector3(0.4, 0.5 - 0.3, 0)
      const [hx, hy, hz] = panCorrection(
        [slid.x, slid.y, slid.z],
        [middle.x, middle.y, middle.z],
        NO_PAN
      )
      near('a face change puts the pivot back on the middle in x', slid.x + hx, middle.x, 1e-12)
      near('and in y', slid.y + hy, middle.y, 1e-12)
      near('and in z', slid.z + hz, middle.z, 1e-12)
    }
  }
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

// --- 14b. One handle at a time ---------------------------------------------
console.log('\n14b. Only ever one gizmo handle is grabbable')
{
  // WHY THE RULE IS NEEDED, measured rather than asserted: the grab volumes
  // overlap heavily and on purpose. The cylinders are six times fatter than the
  // arrows they wrap, the quads sit in the corners between them, and a ring is
  // a circle drawn AROUND all three axes -- so a pointer ray passes through
  // more than one of them from most angles a scene is ever looked at.
  //
  // Rebuilt from the same proportions the component draws at rather than
  // imported, because what is being checked is the SHAPE of the problem, and a
  // gizmo redrawn at other proportions would still have it.
  const grabVolumes = (mode: 'move' | 'rotate' | 'scale', camera: PerspectiveCamera) => {
    const SHAFT_FROM = 0.17, GRAB_RADIUS = 0.17
    const PLANE_FROM = 0.16, PLANE_TO = 0.4
    const RING_RADIUS = 0.27, GRAB_TUBE = 0.045
    const BALL_RADIUS = 0.62, BALL_GRAB_TUBE = 0.07
    const AXIS_ROTATIONS: Vec3[] = [[0, 0, -Math.PI / 2], [0, 0, 0], [Math.PI / 2, 0, 0]]
    const root = new Group()
    const put = (geo: BufferGeometry, rot?: Vec3, pos?: Vec3) => {
      const group = new Group()
      if (rot) group.rotation.set(...rot)
      const mesh = new Mesh(geo)
      if (pos) mesh.position.set(...pos)
      group.add(mesh)
      root.add(group)
    }
    const grabLength = 1 - SHAFT_FROM
    if (mode !== 'rotate') {
      for (const axis of [0, 1, 2] as const) {
        put(new CylinderGeometry(GRAB_RADIUS, GRAB_RADIUS, grabLength, 8),
          AXIS_ROTATIONS[axis], [0, SHAFT_FROM + grabLength / 2, 0])
      }
    }
    if (mode === 'move') {
      const side = PLANE_TO - PLANE_FROM
      const centre = (PLANE_FROM + PLANE_TO) / 2
      for (const axis of [0, 1, 2] as const) {
        put(new PlaneGeometry(side, side), PLANE_ROTATIONS[axis], [centre, centre, 0])
      }
    }
    if (mode === 'scale') {
      // Billboarded, so it is turned to face wherever the camera happens to be.
      const ring = new Mesh(new TorusGeometry(RING_RADIUS, GRAB_TUBE, 6, 32))
      ring.quaternion.copy(camera.quaternion)
      root.add(ring)
    }
    if (mode === 'rotate') {
      for (const axis of [0, 1, 2] as const) {
        put(new TorusGeometry(BALL_RADIUS, BALL_GRAB_TUBE, 6, 40), PLANE_ROTATIONS[axis])
      }
    }
    root.updateMatrixWorld(true)
    return root
  }

  /** The worst a pointer can do: how many handles one ray passes through. */
  const crowding = (mode: 'move' | 'rotate' | 'scale') => {
    let most = 0
    for (let azimuth = 0; azimuth < 360; azimuth += 15) {
      for (const elevation of [12, 35, 60]) {
        const camera = new PerspectiveCamera(50, 1.6, 0.1, 100)
        const a = (azimuth * Math.PI) / 180
        const e = (elevation * Math.PI) / 180
        camera.position.set(6 * Math.cos(e) * Math.cos(a), 6 * Math.sin(e), 6 * Math.cos(e) * Math.sin(a))
        camera.lookAt(0, 0, 0)
        camera.updateMatrixWorld(true)
        const root = grabVolumes(mode, camera)
        for (let px = -0.4; px <= 0.4; px += 0.02) {
          for (let py = -0.4; py <= 0.4; py += 0.02) {
            const caster = new Raycaster()
            caster.setFromCamera(new Vector2(px, py), camera)
            const meshes = new Set(caster.intersectObject(root, true).map((hit) => hit.object))
            most = Math.max(most, meshes.size)
          }
        }
      }
    }
    return most
  }

  check('a Move pointer can be over two handles at once', crowding('move') >= 2, `${crowding('move')}`)
  check('and a Scale pointer over the ring and an arrow together', crowding('scale') >= 2)
  // The worst of the three by a distance: three big rings sharing one centre.
  check('and a Rotate pointer over all three rings', crowding('rotate') >= 3, `${crowding('rotate')}`)

  // WHAT THE RULE DOES ABOUT IT. The claim is the whole mechanism: a hovered
  // handle stops the event, so no handle further along the ray is ever told
  // the pointer is on it -- which is the tie-break the PRESS already used,
  // applied to the light, so the handle that lights is by construction the
  // handle a press would take.
  {
    let hot: boolean | null = null
    let stopped = false
    const event = { stopPropagation: () => { stopped = true } } as never

    const claiming = hoverHandlers((on) => { hot = on })
    claiming.onPointerOver(event)
    check('a hovered handle lights up', hot === true)
    check('and takes the pointer with it', stopped)
    claiming.onPointerOut()
    check('and gives it back on the way out', hot === false)

    // A handle standing down -- a plane quad seen edge-on -- refuses the press,
    // so it must refuse the hover too. One that claimed a pointer it would then
    // hand back would leave the arrow behind it taking a press it never lit for.
    hot = null
    stopped = false
    hoverHandlers((on) => { hot = on }, () => false).onPointerOver(event)
    check('a handle standing down claims nothing', !stopped)
    check('and does not light', hot === null)
  }

  // The three places the rule lives. None of them is reachable without a
  // camera, a pointer and a React tree, so they are read out of the source --
  // and a handle added without one is what these are here to catch.
  const gizmo = readFileSync(new URL('../src/viewport/TransformGizmo.tsx', import.meta.url), 'utf8')
  check(
    'every gizmo handle claims its hover through the one helper',
    !/onPointerOver=/.test(gizmo),
    gizmo.match(/onPointerOver=[^\n]*/)?.[0] ?? ''
  )
  check(
    'and so does the ruler knob, which is drawn among them',
    /hoverHandlers/.test(readFileSync(new URL('../src/viewport/Rulers.tsx', import.meta.url), 'utf8'))
  )
  // The other half: once a handle is held the pointer has left it, and the
  // handles it swept on the way must not light behind the drag.
  check(
    'a held handle overrides the pointer',
    (gizmo.match(/held \?\? /g) ?? []).length >= 3,
    `${(gizmo.match(/held \?\? /g) ?? []).length} of 3`
  )
  // And a second gesture cannot be started over the top of the first, by a
  // right button or by a second finger.
  check(
    'and a second grab is refused outright',
    gizmo.includes("if (useDoc.getState().drag.kind !== 'idle') return")
  )
}

// --- 14c. The plane quads are big enough to press --------------------------
console.log('\n14c. A plane handle is a target, not a speck')
{
  // The two ends of the square are each pinned to something. Stated here
  // rather than trusted, because nothing at runtime would notice them drifting
  // -- the quads would simply get harder to hit again, which is exactly the
  // failure they were just brought back from.
  check(
    'a quad starts outside the arrows\' grab cylinders',
    PLANE_FROM > GRAB_RADIUS,
    `${PLANE_FROM} vs ${GRAB_RADIUS}`
  )
  // Which is what licenses `planeRaycast`'s weight: disjoint volumes mean the
  // depth between a quad and an arrow is real, so the nearer of the two can be
  // taken -- and the nearer one is also the one drawn in front.
  check(
    'and its corner stays inside the arrow tips',
    PLANE_TO * Math.SQRT2 < 1,
    `corner at ${(PLANE_TO * Math.SQRT2).toFixed(2)} of the arrow's 1`
  )

  // WHAT A POINTER CAN ACTUALLY LAND ON, which is not the quad's area: an
  // arrow's grab cylinder crosses its territory in projection, and where the
  // two meet along a ray only one of them can win. Measured by asking, over a
  // ring of camera angles, which handle a press at each pointer position would
  // take -- the same question the app answers, with the same arithmetic.
  const SHAFT_FROM = 0.17
  const AXIS_ROTATIONS: Vec3[] = [[0, 0, -Math.PI / 2], [0, 0, 0], [Math.PI / 2, 0, 0]]
  const PLANE_EDGE_ON = 0.2

  const built = (from: number, to: number, planeBias: number, camera: PerspectiveCamera) => {
    const root = new Group()
    const bias = new Map<Mesh, number>()
    const quad = new Set<Mesh>()
    const grabLength = 1 - SHAFT_FROM
    for (const axis of [0, 1, 2] as const) {
      const group = new Group()
      group.rotation.set(...AXIS_ROTATIONS[axis])
      const mesh = new Mesh(new CylinderGeometry(GRAB_RADIUS, GRAB_RADIUS, grabLength, 12))
      mesh.position.set(0, SHAFT_FROM + grabLength / 2, 0)
      group.add(mesh)
      root.add(group)
      bias.set(mesh, 1e-6)
    }
    const view = camera.getWorldDirection(new Vector3())
    for (const axis of [0, 1, 2] as const) {
      const group = new Group()
      group.rotation.set(...PLANE_ROTATIONS[axis])
      // Double-sided, as the real quad is: a slide across a plane is the same
      // slide from behind it, and a front-facing test would report half the
      // handles missing.
      const mesh = new Mesh(
        new PlaneGeometry(to - from, to - from),
        new MeshBasicMaterial({ side: DoubleSide })
      )
      mesh.position.set((from + to) / 2, (from + to) / 2, 0)
      group.add(mesh)
      root.add(group)
      root.updateMatrixWorld(true)
      // Standing down when edge-on takes it out of the picking as well as out
      // of the drawing.
      if (Math.abs(group.getWorldDirection(new Vector3()).dot(view)) <= PLANE_EDGE_ON) {
        root.remove(group)
        continue
      }
      bias.set(mesh, planeBias)
      quad.add(mesh)
    }
    root.updateMatrixWorld(true)
    return { root, bias, quad }
  }

  /** Pointer positions that would take a QUAD, and the leanest single view. */
  const reachable = (from: number, to: number, planeBias: number) => {
    let total = 0
    let leanest = Infinity
    for (let azimuth = 0; azimuth < 360; azimuth += 30) {
      for (const elevation of [20, 45]) {
        // The opening shot: the camera sits this many GIZMO units out once the
        // gizmo has been scaled to hold its size on screen.
        const away = 3.99 / 0.279
        const camera = new PerspectiveCamera(45, 1.5, 0.005, 1000)
        const a = (azimuth * Math.PI) / 180
        const e = (elevation * Math.PI) / 180
        camera.position.set(away * Math.cos(e) * Math.cos(a), away * Math.sin(e), away * Math.cos(e) * Math.sin(a))
        camera.lookAt(0, 0, 0)
        camera.updateMatrixWorld(true)
        const gizmo = built(from, to, planeBias, camera)
        let here = 0
        for (let px = -0.22; px <= 0.22; px += 0.008) {
          for (let py = -0.22; py <= 0.22; py += 0.008) {
            const caster = new Raycaster()
            caster.setFromCamera(new Vector2(px, py), camera)
            let won: Mesh | null = null
            let at = Infinity
            for (const hit of caster.intersectObject(gizmo.root, true)) {
              const weight = gizmo.bias.get(hit.object as Mesh)
              if (weight === undefined) continue
              if (hit.distance * weight < at) {
                at = hit.distance * weight
                won = hit.object as Mesh
              }
            }
            if (won && gizmo.quad.has(won)) here++
          }
        }
        total += here
        leanest = Math.min(leanest, here)
      }
    }
    return { total, leanest }
  }

  // What it was: a 0.16-to-0.40 square that lost every meeting with an arrow.
  const before = reachable(0.16, 0.4, 1e-5)
  // And what the file now draws, read from the source so a change to either
  // end of the square is a change to this answer.
  const after = reachable(PLANE_FROM, PLANE_TO, 1e-6)

  // THE WORST ANGLE, not the average, because that is the one that made these
  // feel broken: a handle that is hard from every direction is a small handle,
  // but one that is fine from most and impossible from a few reads as a bug.
  // Sampled coarsely here to keep the suite quick -- a finer sweep found
  // angles where the old square offered NOTHING at all -- so what is claimed
  // is the improvement rather than the old zero.
  check(
    'the leanest camera angle offers something to press',
    after.leanest > 0,
    `${after.leanest} pointer positions`
  )
  check(
    'and many times what the old square left it',
    after.leanest > before.leanest * 5,
    `${after.leanest} against ${before.leanest}`
  )
  // Both halves of the fix in one number: a bigger square, and a tie-break that
  // stops handing the arrow ground the quad is drawn in front of.
  check(
    'with several times the area a pointer can land on',
    after.total > before.total * 4,
    `${after.total} positions against ${before.total}`
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

// --- A brush stroke is a path, not a sample --------------------------------
//
// THE BUG, STATED AS THE USER SAW IT: drag the torch quickly and it stopped
// drawing a groove and started printing a row of separate round dents with the
// surface between them untouched. Nothing was wrong with the brush. The stroke
// was read once a frame and one dab was laid wherever the pointer had got to,
// so the space between the marks was the user's speed times the app's frame
// time -- and past about a brush width per frame the marks stop overlapping at
// all.
//
// The claim, then, is about SPACING RATHER THAN SPEED: however far the pointer
// travels between two frames, the dabs it leaves behind are as far apart as the
// ones a slow hand leaves, because the frame fills in the path it missed. See
// `dragErode` and `DAB_SPACING`.
console.log('\nA fast brush stroke fills itself in')
{
  const BRUSH = 0.3
  const spacing = BRUSH * DAB_SPACING

  // Square on to the front face, so a pixel is the same number of units across
  // the whole stroke and the arithmetic below is honest.
  const camera = new PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(0, 0, 6)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const rect = { left: 0, top: 0, width: 800, height: 800 } as DOMRect
  const canvas = { getBoundingClientRect: () => rect } as unknown as HTMLElement
  const raycaster = new Raycaster()

  useTools.setState({
    brushTool: 'torch',
    erodeRadius: BRUSH,
    erodeHeat: 0.5,
    erodeSmooth: 0.7,
  })

  /**
   * The marks a run of frames leaves on a solid, in its own space.
   *
   * The mesh the brush is held against is built ONCE rather than re-evaluated
   * per frame the way the viewport does it. The dabs still land where the ray
   * hits; they all hit the surface as it stood at the start, which is what
   * makes the spacing below a number rather than a drift. What is under test is
   * where the marks go, not how deep they get.
   */
  const stroke = (
    base: BaseSolid,
    frames: ([number, number] | 'off-canvas')[],
    /** Which brush is in hand. The spacing checks below are the torch's; the
     *  parameter is here so the same rig can ask what the OTHER brushes hand
     *  the document, which is the half of `dragErode` that reads the panel. */
    brush: StrokeBrush = 'torch'
  ): Vector3[] => {
    resetEvaluator()
    const doc = scene(object(base))
    const meshes = sceneMeshes(doc)
    forgetStroke()
    useDoc.setState({ doc, past: [], future: [], drag: { kind: 'idle' } })
    useDoc.getState().startErode('obj', brush)
    for (const frame of frames) {
      if (frame === 'off-canvas') {
        // What the frame loop does when the pointer leaves the canvas: the
        // stroke lives on, its path does not. See `pauseStroke`.
        pauseStroke()
        continue
      }
      pointerClient.x = frame[0]
      pointerClient.y = frame[1]
      const s = useDoc.getState()
      if (s.drag.kind === 'erode') dragErode(s, s.drag, raycaster, meshes, camera, canvas)
    }
    const laid = useDoc.getState().doc.objects[0].erosion ?? []
    useDoc.setState({ drag: { kind: 'idle' } })
    forgetStroke()
    return laid.map((d) => new Vector3(...d.at))
  }

  const widest = (path: Vector3[]) => {
    let out = 0
    for (let i = 1; i < path.length; i++) out = Math.max(out, path[i].distanceTo(path[i - 1]))
    return out
  }

  // Two frames three hundred pixels apart: a flick. On this camera the cube's
  // front face is a little under four hundred pixels across, so the second dab
  // used to land well over a brush diameter from the first, and the two of them
  // were the whole stroke.
  const flick = stroke(CUBE, [
    [250, 400],
    [550, 400],
  ])
  const reach = flick[flick.length - 1].distanceTo(flick[0])
  check(
    'a flick across a face lays a run of dabs, not two',
    flick.length >= Math.floor(reach / spacing),
    `${flick.length} dabs over ${reach.toFixed(3)}, spacing ${spacing.toFixed(3)}`
  )
  check(
    'and none of them lands further than the spacing from the last',
    widest(flick) <= spacing * 1.05,
    `widest gap ${widest(flick).toFixed(4)}`
  )

  // The same ground covered slowly. This is the stroke the tool always got
  // right, and it is what the fast one now has to match: the marks are the
  // gesture, not the frame rate it happened to be caught at.
  const slow = stroke(
    CUBE,
    Array.from({ length: 13 }, (_, i): [number, number] => [250 + i * 25, 400])
  )
  check(
    'a slow drag over the same ground lays about the same stroke',
    Math.abs(slow.length - flick.length) <= 2,
    `${slow.length} dabs slowly against ${flick.length} quickly`
  )
  near('and both end in the same place', slow[slow.length - 1].x, flick[flick.length - 1].x, 1e-9)

  // EVERY DAB IS ON THE SURFACE. The fill walks the screen and asks the
  // geometry where each step lands, rather than interpolating between the two
  // ends in the object's own space: the straight line between two points on a
  // flat face is that face, but on anything curved it runs UNDER the surface,
  // and a dab is a sphere about its centre -- one sunk below the surface bites
  // deeper than the one the user aimed, and on a thin wall burns through where
  // nothing was pointed.
  const onBall = stroke(SPHERE, [
    [300, 400],
    [500, 400],
  ]).map((at) => at.length())
  check(
    'a flick across a sphere keeps every dab on the sphere',
    onBall.length > 2 && onBall.every((r) => Math.abs(r - 1) < 0.01),
    `${onBall.length} dabs, radii ${Math.min(...onBall).toFixed(4)}..${Math.max(...onBall).toFixed(4)}`
  )

  // THE WORST FORM OF THE SAME BUG: a flick that carries clean past the solid
  // between one frame and the next. Neither end of the frame is over anything,
  // so a tool that reads only where the pointer IS finds nothing under it twice
  // and leaves the object untouched by a stroke drawn straight across it.
  const past = stroke(CUBE, [
    [120, 400],
    [680, 400],
  ])
  check(
    'a flick that overshoots the solid still marks it',
    past.length > 4,
    `${past.length} dabs`
  )
  check(
    'and lays nothing off it',
    past.every((at) => Math.abs(at.x) <= 1 + 1e-6 && Math.abs(at.z - 1) < 1e-6),
    `x ${Math.min(...past.map((a) => a.x)).toFixed(3)}..${Math.max(...past.map((a) => a.x)).toFixed(3)}`
  )
  check(
    'and still lands them a spacing apart',
    widest(past) <= spacing * 1.05,
    `widest gap ${widest(past).toFixed(4)}`
  )

  // A stroke that leaves the canvas and comes back somewhere else. The hand
  // went somewhere in between and the app did not see it, so the return is a
  // jump: one dab where it lands, and no line drawn along a path nobody drew.
  const away = stroke(CUBE, [[300, 400], 'off-canvas', [500, 400]])
  check(
    'a stroke that leaves the canvas does not fill in on its way back',
    away.length === 2,
    `${away.length} dabs`
  )

  // WHAT THE FRAME LOOP HANDS THE DOCUMENT, asked of the Smoother because it is
  // the brush whose numbers do not survive being read wrong. The torch and the
  // sculpt tool differ by a flag; this one sends a target instead of a bite,
  // and a `dragErode` that forwarded only the three numbers it always had would
  // lay dabs that round by nothing at all -- a tool that silently does nothing,
  // which is the failure a stroke test is worth having for.
  useTools.setState({
    brushTool: 'smoother',
    smootherRadius: BRUSH,
    smootherStrength: 0.4,
  })
  {
    const marks = stroke(CUBE, [[300, 400], [420, 400]], 'smoother')
    check('a Smoother drag fills its path in the same way', marks.length > 2, `${marks.length} dabs`)
    check('and none of them lands further than the spacing from the last', widest(marks) <= spacing * 1.05, `${widest(marks).toFixed(4)}`)
    const dabs = useDoc.getState().doc.objects[0].erosion ?? []
    check('the panel\'s Strength reaches the dab as its target', dabs.every((d) => d.round === 0.4), JSON.stringify(dabs[0]))
    check('and the panel\'s brush size reaches it as the radius', dabs.every((d) => d.radius === BRUSH), JSON.stringify(dabs[0]))
    check('with no bite and no flow, which this brush has neither of', dabs.every((d) => d.heat === 0 && d.smooth === 0), JSON.stringify(dabs[0]))
  }

  useDoc.setState({ doc: { objects: [] }, past: [], future: [], drag: { kind: 'idle' } })
  useTools.setState({ brushTool: null })
  resetEvaluator()
}

console.log('  ')
console.log('A Point Cut knot lines up with the knots already placed')
{
  // THE TWO AXES ARE DECIDED SEPARATELY, which is the whole design. It does not
  // snap to the other POINT -- two knots on top of each other is the one
  // arrangement a cut has no use for -- it snaps to its row and to its column,
  // so a knot can take its height from one neighbour and its width from
  // another and land on the corner the two of them imply.
  const TOL = [0.05, 0.05] as const

  {
    const held = snapToPeers([0.32, -0.4], [[0.3, 0.1]], TOL)
    near('a knot within reach of a column takes it', held.at[0], 0.3, 1e-12)
    near('and keeps the height it was dragged to', held.at[1], -0.4, 1e-12)
    check('reporting the line it caught', held.onU === 0.3 && held.onV === null, `${held.onU} / ${held.onV}`)
  }
  {
    const held = snapToPeers([-0.4, 0.12], [[0.3, 0.1]], TOL)
    near('a knot within reach of a row takes that instead', held.at[1], 0.1, 1e-12)
    near('and keeps its own width', held.at[0], -0.4, 1e-12)
  }
  {
    // Two neighbours, one lending a column and the other a row: the knot lands
    // on the corner they imply, which squares a slot off and is exactly what a
    // single nearest-POINT snap could never give.
    const held = snapToPeers([0.28, 0.42], [[0.3, -0.2], [-0.1, 0.4]], TOL)
    near('a knot can take its width from one neighbour', held.at[0], 0.3, 1e-12)
    near('and its height from another', held.at[1], 0.4, 1e-12)
    check('landing on the corner the two of them imply', held.onU === 0.3 && held.onV === 0.4, '')
  }
  {
    // NEAREST RATHER THAN FIRST, or the answer would depend on the order the
    // points happen to be stored in, and dragging past one knot could leave you
    // caught on a further one.
    const held = snapToPeers([0.3, 0], [[0.34, 0], [0.31, 0]], TOL)
    near('the nearer of two columns wins', held.at[0], 0.31, 1e-12)
  }
  {
    const held = snapToPeers([0.2, 0.2], [[0.3, 0.4]], TOL)
    near('and a knot out of reach is left exactly where it was', held.at[0], 0.2, 1e-12)
    near('on both axes', held.at[1], 0.2, 1e-12)
    check('with nothing reported as caught', held.onU === null && held.onV === null, '')
  }
  {
    // Off is not a mode inside the arithmetic: a reach of nothing catches
    // nothing, which is what lets the switch in the bar simply not call it.
    const held = snapToPeers([0.301, 0], [[0.3, 0]], [0, 0])
    near('no reach, no snap', held.at[0], 0.301, 1e-12)
  }

  // WHAT A PIXEL IS WORTH ON A FACE, which is the part that has to know about
  // the stock. Face coordinates are FRACTIONS of the block, and a face's two
  // directions run along two different sides of it -- so on a sheet the same
  // screen distance is worth wildly different fractions of each, and one
  // tolerance for both would be unusable across the face and immovable up it.
  {
    // A sheet: two units wide, a twentieth thick, one deep. Looking at the
    // front, u runs along the width and v up the height.
    const SHEET = [2, 0.05, 1] as const
    near('a face direction knows which side it runs along', sideAlong({ x: 1, y: 0, z: 0 }, SHEET), 2, 1e-12)
    near('whichever way it points', sideAlong({ x: -1, y: 0, z: 0 }, SHEET), 2, 1e-12)
    near('and up is the height', sideAlong({ x: 0, y: 1, z: 0 }, SHEET), 0.05, 1e-12)

    const zoom = 400
    const [tu, tv] = faceTolerance(10, zoom, [SHEET[0], SHEET[1]])
    // Ten pixels at 400 pixels per world unit is 0.025 of the world, which is
    // an eightieth of the sheet across and half of it up.
    near('ten pixels across the sheet is a small fraction of it', tu, 0.025 / 2, 1e-12)
    near('and up the sheet, the very same pixels are a large one', tv, 0.025 / 0.05, 1e-12)
    check('which is the whole reason the two are computed apart', tv > tu * 10, `${tv.toFixed(3)} against ${tu.toFixed(4)}`)

    // AND IT SHRINKS AS YOU LEAN IN, which is what makes pixels the right unit:
    // zoom in twice as far and the same ten pixels reach half as much block, so
    // points can be placed at half the spacing without being swallowed.
    const [closer] = faceTolerance(10, zoom * 2, [SHEET[0], SHEET[1]])
    near('twice the zoom, half the reach', closer, tu / 2, 1e-12)
  }
}

console.log('  ')
console.log("A ruler's end on the lathe catches the edges, the centre, and its own other end")
{
  // A plain cylinder: 1.5 tall, 0.4 from the axis all the way up, so every
  // number below can be read off the stock rather than off a shaped wall.
  const stock = freshClay(1.5, 0.4, null)
  // Two centimetres, which is a fat reach at this size and keeps every case
  // below a plain statement about which target won rather than a near miss.
  const TOL = 0.02

  {
    // THE EDGE. The section's outline is exactly `x = ±wallAt(y)`, so an end
    // pulled onto it is ON the material rather than near it.
    const held = snapLatheEnd([0.39, 0.75], [0, 0], stock, TOL)
    near('an end near the wall lands on it', held.at[0], 0.4, 1e-12)
    near('and keeps the height it was dragged to', held.at[1], 0.75, 1e-12)
    check('reporting the line it caught', held.onX === 0.4 && held.onY === null, `${held.onX} / ${held.onY}`)
  }
  {
    // The wall on the side the end is ALREADY ON. A section is symmetrical
    // about the axis, and an end dragged up the left of the drawing catching
    // the right-hand wall would jump the whole width of the piece.
    const held = snapLatheEnd([-0.39, 0.75], [0, 0], stock, TOL)
    near('the wall it catches is the one it is standing beside', held.at[0], -0.4, 1e-12)
  }
  {
    // THE CENTRE. An end on the axis is what makes a ruler read a RADIUS, and
    // it is where every height measurement wants to be taken.
    const held = snapLatheEnd([0.008, 0.75], [0.4, 0.75], stock, TOL)
    near('an end near the axis takes it', held.at[0], 0, 1e-12)
  }
  {
    // THE RIM AND THE PLATE: the two heights the piece ends at, which are the
    // numbers the corner readout already shows. A ruler dropped across them has
    // to agree with it exactly rather than come out a hair under.
    const rim = snapLatheEnd([0.2, 1.492], [0.2, 0], stock, TOL)
    near('an end near the rim takes the rim', rim.at[1], 1.5, 1e-12)
    const base = snapLatheEnd([0.2, 0.006], [0.2, 1.5], stock, TOL)
    near('and one near the plate takes the plate', base.at[1], 0, 1e-12)
  }
  {
    // A CORNER, which is the whole point of deciding the two axes apart: the
    // height comes from the rim and the width from the wall, and the end lands
    // where they meet. A single nearest-POINT snap could give this too; what it
    // could not give is either half on its own.
    const held = snapLatheEnd([0.393, 1.494], [0, 0], stock, TOL)
    near('an end can take its height from the rim', held.at[1], 1.5, 1e-12)
    near('and its width from the wall', held.at[0], 0.4, 1e-12)
    check('landing on the corner the two of them imply', held.onX === 0.4 && held.onY === 1.5, '')
  }
  {
    // PERFECTLY LEVEL. The other end's row is a target like any other, which is
    // what turns two ends on the wall into a true diameter rather than a
    // measurement taken across a slight diagonal.
    const held = snapLatheEnd([-0.385, 0.744], [0.4, 0.75], stock, TOL)
    near('an end nearly level with the other goes exactly level', held.at[1], 0.75, 1e-12)
    near('and lands on the wall at that height', held.at[0], -0.4, 1e-12)
    near(
      'so the ruler reads the diameter and not a hair more',
      latheRulerLength({ id: 'x', ends: [held.at, [0.4, 0.75]] }),
      0.8,
      1e-12
    )
  }
  {
    // PERFECTLY UPRIGHT, the same rule turned ninety degrees: the other end's
    // column, which is what makes a height measurement a height rather than a
    // slight diagonal across one.
    const held = snapLatheEnd([0.006, 1.494], [0, 0], stock, TOL)
    near('an end nearly above the other goes exactly above it', held.at[0], 0, 1e-12)
    near('and takes the rim for its height', held.at[1], 1.5, 1e-12)
  }
  {
    // ONE LOCK AT A TIME, and it is the axis the pair is ALREADY more nearly
    // aligned on. Both at once would put the end on top of the end it is
    // measuring from, which is the one arrangement this tool has no use for.
    // The other end is parked in mid-air here on purpose: sitting on an edge it
    // would lend its row and its column to the piece's own targets, and the
    // question would stop being about the ortho lock at all.
    const held = snapLatheEnd([0.204, 0.758], [0.2, 0.75], stock, TOL)
    near('the nearer axis is the one that locks', held.at[0], 0.2, 1e-12)
    check('and the further one is left alone', held.onY === null, `${held.onY}`)
    near('so the ruler keeps a length', held.at[1], 0.758, 1e-12)
  }
  {
    // THE WALL AS IT STANDS, not as the stock left it. A shaped piece is the
    // only kind worth measuring, and the wall the end catches has to be the one
    // on screen.
    const waisted = withWall(
      stock,
      stock.wall.map((r, i) => (i === Math.round((CLAY_RINGS - 1) / 2) ? 0.2 : r))
    )
    const held = snapLatheEnd([0.21, ringHeight(waisted, Math.round((CLAY_RINGS - 1) / 2))], [0, 0], waisted, TOL)
    near('an end at the waist catches the waist', held.at[0], 0.2, 1e-12)
  }
  {
    // THE CAVITY WALL, which is the only way to measure how thick a wall has
    // actually been left.
    const cup = { ...stock, hollow: { thickness: 0.1, capTop: false, capBottom: true } }
    const inner = bore(cup)
    check('the cup really is bored', inner !== null, '')
    const held = snapLatheEnd([0.295, 0.75], [0.4, 0.75], cup, TOL)
    near('an end inside the piece catches the cavity wall', held.at[0], 0.3, 1e-9)
  }
  {
    // NOT ABOVE THE PIECE. `wallAt` clamps to the end rings, so without a guard
    // the wall would go on being reported in the air over the rim -- a phantom
    // edge to catch on where there is no material at all.
    //
    // Asked of a TAPERED piece, because on a cylinder the wall and the widest
    // radius are the same number everywhere and the question cannot be put: the
    // widest IS offered at any height, deliberately, so a neck can be lined up
    // with the bulge it stands inside. What must not be offered up there is the
    // rim's own radius, and on this piece the two are 0.2 apart.
    const tapered = withWall(
      stock,
      stock.wall.map((_, i) => 0.4 - 0.2 * (i / (CLAY_RINGS - 1)))
    )
    const held = snapLatheEnd([0.198, 1.7], [0, 1.7], tapered, TOL)
    near('an end in the air above the rim catches no wall', held.at[0], 0.198, 1e-12)
    check('and nothing is reported as caught', held.onX === null, `${held.onX}`)
    // While the widest, which is a column rather than an edge, still is.
    const lined = snapLatheEnd([0.396, 1.7], [0, 1.7], tapered, TOL)
    near('though the widest of the piece is still a column to line up with', lined.at[0], 0.4, 1e-12)
  }
  {
    // Off is not a mode inside the arithmetic: a reach of nothing catches
    // nothing, which is what lets the switch in the bar simply pass a zero.
    const held = snapLatheEnd([0.399, 0.75], [0, 0], stock, 0)
    near('no reach, no snap', held.at[0], 0.399, 1e-12)
    check('and nothing caught', held.onX === null && held.onY === null, '')
  }

  // WHERE A FRESH ONE LANDS: across the piece, an end on each wall, so it
  // arrives measuring something instead of asking for two placements first.
  {
    const [a, b] = latheRulerSpawn(0, stock)
    near('a fresh ruler lies level', a[1], b[1], 1e-12)
    near('halfway up the piece', a[1], 0.75, 1e-9)
    near('with an end on each wall', a[0], -0.4, 1e-12)
    near('and the other on the far one', b[0], 0.4, 1e-12)
    near('so it reads the diameter', latheRulerLength({ id: 'x', ends: [a, b] }), 0.8, 1e-12)

    // Consecutive rulers go at different heights, or the second would be
    // hidden -- exactly -- by the first.
    const heights = new Set(
      Array.from({ length: LATHE_RULER_LANES.length }, (_, i) => latheRulerSpawn(i, stock)[0][1])
    )
    check(
      'and every lane is a height of its own',
      heights.size === LATHE_RULER_LANES.length,
      `${heights.size} of ${LATHE_RULER_LANES.length}`
    )
    check(
      'none of them lying along the rim or the plate',
      [...heights].every((h) => h > 0 && h < 1.5),
      [...heights].join(', ')
    )
  }
}

console.log('  ')
console.log('A level ruler on the lathe is pushed by its middle and its ends follow the piece')
{
  const stock = freshClay(1.5, 0.4, null)
  /** A ruler laid between two points, which is all this file needs one to be. */
  const lay = (a: LatheEnd, b: LatheEnd): LatheRuler => ({ id: 'r', ends: [a, b] })
  const reads = (ends: [LatheEnd, LatheEnd]) => latheRulerLength(lay(ends[0], ends[1]))

  // A CONE, 0.4 at the plate and 0.2 at the rim with a straight wall between,
  // so what the ends should land on at any height is a number anybody can work
  // out on paper rather than one read back off the code that produced it.
  const tapered = withWall(
    stock,
    stock.wall.map((_, i) => 0.4 - 0.2 * (i / (CLAY_RINGS - 1)))
  )
  const wallOf = (y: number) => 0.4 - 0.2 * (y / 1.5)

  // --- WHAT MAY BE PUSHED AT ALL -----------------------------------------
  {
    const ride = latheRulerRide(lay(...latheRulerSpawn(0, tapered)), tapered)
    check('a fresh ruler laid across the piece can be taken by its middle', ride !== null, '')
    check(
      'both its ends riding the outer wall',
      ride?.holds.join(' ') === 'wall wall',
      `${ride?.holds.join(' ')}`
    )
    check('one either side of the axis', ride?.sides.join(' ') === '-1 1', `${ride?.sides.join(' ')}`)
    // On a piece the wall never closes on, that is the whole of it.
    near('and it may be pushed from the plate', ride?.lo ?? -1, 0, 1e-12)
    near('to the rim', ride?.hi ?? -1, 1.5, 1e-12)
  }
  {
    // NOT ONE ACROSS A DIAGONAL. There is no single height for the pair to be
    // moved to, and lifting it onto the level to invent one would change the
    // reading a user placed by hand.
    const askew = latheRulerRide(lay([-wallOf(0.75), 0.75], [wallOf(0.76), 0.76]), tapered)
    check('a ruler lying across a diagonal has no middle to take hold of', askew === null, `${askew}`)
  }
  {
    // NOR ONE WITH AN END IN MID-AIR: nothing to follow, and no honest guess
    // about where it should go.
    const loose = latheRulerRide(lay([-wallOf(0.75), 0.75], [0.2, 0.75]), tapered)
    check('nor one with an end standing off the piece', loose === null, `${loose}`)
  }
  {
    // NOR A RULER OF NO LENGTH, which is what two ends on the centre line are:
    // it reads nothing now and would read nothing wherever it was pushed.
    const nothing = latheRulerRide(lay([0, 0.75], [0, 0.75]), tapered)
    check('nor one lying on the axis with no length at all', nothing === null, `${nothing}`)
  }

  // --- WHERE IT GOES ------------------------------------------------------
  {
    const ride = latheRulerRide(lay(...latheRulerSpawn(0, tapered)), tapered)
    if (ride !== null) {
      // UP THE CURVE. The height is the only thing the hand gives; the widths
      // are the piece's to say, and on a cone they narrow the whole way.
      const up = latheRulerSlide(ride, tapered, 1.2, 0)
      near('pushed up, both ends go to the height asked for', up.ends[0][1], 1.2, 1e-12)
      near('and stay exactly level with each other', up.ends[1][1], up.ends[0][1], 1e-12)
      near('the left end landing on the wall up there', up.ends[0][0], -wallOf(1.2), 1e-9)
      near('the right end on its own side of it', up.ends[1][0], wallOf(1.2), 1e-9)
      near('so the ruler reads the piece where it now lies', reads(up.ends), wallOf(1.2) * 2, 1e-9)
      check(
        'which is a narrower piece than it was measuring before',
        reads(up.ends) < wallOf(0.75) * 2,
        `${reads(up.ends).toFixed(3)}`
      )

      // AND IT STOPS AT THE ENDS OF THE PIECE rather than sailing into the air
      // above it, where there is no wall for an end to be on.
      const past = latheRulerSlide(ride, tapered, 9, 0)
      near('pushed past the rim it stops at the rim', past.ends[0][1], 1.5, 1e-12)
      near('still on the wall', past.ends[1][0], wallOf(1.5), 1e-9)
      near(
        'and pushed under the plate it stops on the plate',
        latheRulerSlide(ride, tapered, -9, 0).ends[0][1],
        0,
        1e-12
      )

      // NO REACH, NO CATCH: the switch in the bar hands this a zero, and the
      // ruler goes exactly where it was put. See `snapLatheEnd`.
      const loose = latheRulerSlide(ride, tapered, 1.1234, 0)
      near('with the snap down it lands where it was pushed', loose.ends[0][1], 1.1234, 1e-12)
      check('and catches nothing', loose.onY === null, `${loose.onY}`)
    }
  }

  // --- WHAT IT CATCHES ON THE WAY ----------------------------------------
  {
    // A BELLY, widest at ring 60. This is the height the gesture exists to
    // find: "how fat is it at the fattest" is a question about a ring nobody
    // can point at, and an end dragged on its own already catches it -- so the
    // middle must too, or the same ruler would behave two ways.
    const hill = withWall(
      stock,
      stock.wall.map((_, i) => (i <= 60 ? 0.2 + 0.2 * (i / 60) : 0.4 - 0.2 * ((i - 60) / 35)))
    )
    const peak = ringHeight(hill, 60)
    const level = wallAt(hill, 0.75)
    const ride = latheRulerRide(lay([-level, 0.75], [level, 0.75]), hill)
    check('a ruler on a bellied piece rides its wall', ride !== null, '')
    if (ride !== null) {
      const caught = latheRulerSlide(ride, hill, peak - 0.01, 0.02)
      near('pushed near the widest ring, it clicks onto it', caught.onY ?? -1, peak, 1e-12)
      near('landing there rather than near it', caught.ends[0][1], peak, 1e-12)
      near('and reading the piece at its widest', reads(caught.ends), 0.8, 1e-9)
    }
  }

  // --- A HOLLOW PIECE -----------------------------------------------------
  {
    // THE SURFACE IT WAS ALREADY ON. A bored piece has two walls at every
    // height, and which of them a ruler is measuring is not the gesture's to
    // change halfway up.
    const cup = { ...tapered, hollow: { thickness: 0.1, capTop: false, capBottom: true } }
    check('the cup really is bored', bore(cup) !== null, '')
    const boreOf = (y: number) => wallOf(y) - 0.1

    const across = latheRulerRide(lay([-boreOf(0.75), 0.75], [boreOf(0.75), 0.75]), cup)
    check(
      'a ruler laid across the cavity rides the cavity',
      across?.holds.join(' ') === 'bore bore',
      `${across?.holds.join(' ')}`
    )
    if (across !== null) {
      const up = latheRulerSlide(across, cup, 1.2, 0)
      near('and pushed up the piece it is still on the inner wall', up.ends[1][0], boreOf(1.2), 1e-9)
      check(
        'rather than out on the outside of it',
        Math.abs(up.ends[1][0] - wallOf(1.2)) > 0.05,
        `${up.ends[1][0].toFixed(4)}`
      )
      // The floor of the cavity is the end of the ride: below it there is no
      // inner wall for an end to be on at all.
      near('its travel starts at the cavity floor', across.lo, 0.1, 1e-9)
      near(
        'so pushed under it, it stops there',
        latheRulerSlide(across, cup, -9, 0).ends[0][1],
        0.1,
        1e-9
      )
    }

    // AND THE MEASUREMENT A HOLLOW PIECE IS REALLY FOR: outer wall to inner
    // wall, which is the thickness that has been left. One end on each, and
    // both on the same side of the axis.
    const thick = latheRulerRide(lay([boreOf(0.75), 0.75], [wallOf(0.75), 0.75]), cup)
    check(
      'a ruler laid from the inside out rides one of each',
      thick?.holds.join(' ') === 'bore wall',
      `${thick?.holds.join(' ')}`
    )
    check('both on the same side of the axis', thick?.sides.join(' ') === '1 1', `${thick?.sides.join(' ')}`)
    if (thick !== null) {
      near(
        'and pushed up a tapering piece it goes on reading the wall',
        reads(latheRulerSlide(thick, cup, 1.2, 0).ends),
        0.1,
        1e-9
      )
    }
  }

  // --- THE CENTRE LINE ----------------------------------------------------
  {
    // The axis is at every height there is, so an end on it simply stays on it
    // while the other walks the wall -- and the ruler goes on reading a RADIUS
    // rather than a width the whole way up.
    const radius = latheRulerRide(lay([0, 0.75], [wallOf(0.75), 0.75]), tapered)
    check(
      'a ruler from the axis to the wall can be pushed as well',
      radius?.holds.join(' ') === 'axis wall',
      `${radius?.holds.join(' ')}`
    )
    if (radius !== null) {
      const up = latheRulerSlide(radius, tapered, 1.2, 0)
      near('its inner end stays on the centre line', up.ends[0][0], 0, 1e-12)
      near('and it goes on reading a radius', reads(up.ends), wallOf(1.2), 1e-9)
    }
  }

  // --- A DOMED TOP --------------------------------------------------------
  {
    // WHERE THE WALL RUNS OUT is where the ride stops, and that is NOT where
    // the piece is said to end: `pieceSpan` keeps one closed ring past the
    // material so the surface can run out to a point, and a ruler pushed onto
    // that ring would have both ends on the axis and read zero.
    const domed = withWall(
      stock,
      stock.wall.map((_, i) => (i <= 60 ? 0.4 : Math.max(0, 0.4 * (1 - (i - 60) / 20))))
    )
    const ride = latheRulerRide(lay([-0.4, 0.75], [0.4, 0.75]), domed)
    check('a ruler on a domed piece rides its wall', ride !== null, '')
    if (ride !== null) {
      // The wall crosses the closed mark half a ring above 79, which is where
      // 0.02 falls to nothing.
      near('the ride stops where the wall closes', ride.hi, (79.5 * 1.5) / (CLAY_RINGS - 1), 1e-9)
      check(
        'short of the ring the piece is said to end on',
        ride.hi < ringHeight(domed, 80),
        `${ride.hi.toFixed(4)} against ${ringHeight(domed, 80).toFixed(4)}`
      )
      const top = latheRulerSlide(ride, domed, 9, 0)
      check(
        'so a ruler pushed as high as it goes still has a length to read',
        reads(top.ends) > 0,
        `${reads(top.ends)}`
      )
    }
  }
}

console.log(
  failures === 0
    ? '\nAll interaction checks passed.\n'
    : `\n${failures} interaction check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
