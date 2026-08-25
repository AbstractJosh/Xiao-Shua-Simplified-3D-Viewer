/**
 * Headless verification of the interaction math: how a raycast becomes an
 * anchor, and how an anchor becomes surface geometry.
 *
 * This is the logic the viewport depends on but that a screenshot cannot prove
 * -- whether a hit was classified against the right face, whether a sketch on
 * a sphere really fans its normals outward from the centre, and whether a
 * sketch stays on the face it was dropped on.
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
import { pickAnchorOnBase, pickAnchorOnSolid } from '../src/viewport/picking'
import {
  NGON_SIDES,
  NGON_SIDES_TOP_DOWN,
  NGON_NAMES,
  ngonPoints,
} from '../src/console/ngon'
import type { BaseSolid, Doc, SurfaceAnchor } from '../src/geometry/types'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}
function near(label: string, actual: number, expected: number, tol: number) {
  check(label, Math.abs(actual - expected) <= tol, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`)
}

function solidFor(doc: Doc): Mesh {
  const mesh = new Mesh(evaluateDoc(doc).geometry)
  mesh.updateMatrixWorld(true)
  return mesh
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
  const doc: Doc = { base: CUBE, features: [] }
  const mesh = solidFor(doc)
  const rc = rayFrom([0.3, 5, -0.2], [0, -1, 0])

  const anchor = pickAnchorOnSolid(rc, CUBE, mesh)
  check('hit resolves to an anchor', anchor !== null)
  check('classified as a box face', anchor?.on === 'box-face', `got ${anchor?.on}`)
  if (anchor?.on === 'box-face') {
    check('picked the +Y face', anchor.face === 2, `face index ${anchor.face}`)
    near('u coordinate', anchor.u, 0.3, 1e-3)
    near('v coordinate', anchor.v, 0.2, 1e-3)
  }

  const viaBase = pickAnchorOnBase(rc, CUBE)
  check(
    'analytic base pick agrees with mesh pick',
    JSON.stringify(viaBase) === JSON.stringify(anchor),
    `${JSON.stringify(viaBase)}`
  )

  const miss = pickAnchorOnSolid(rayFrom([5, 5, 5], [0, 1, 0]), CUBE, mesh)
  check('ray into empty space yields no anchor', miss === null)
}

// --- 2. Dropping on a sphere ----------------------------------------------
console.log('\n2. Hit classification on a sphere')
{
  resetEvaluator()
  const mesh = solidFor({ base: SPHERE, features: [] })
  // Aim slightly off-axis so the hit lands on a facet, not a seam vertex.
  const rc = rayFrom([5, 0.2, 0.1], [-1, 0, 0])
  const anchor = pickAnchorOnSolid(rc, SPHERE, mesh)
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
  const doc: Doc = {
    base: CUBE,
    features: [
      {
        id: 'boss',
        anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
        shape: { type: 'circle', r: 0.3 },
        rotation: 0,
        op: 'extrude',
        depth: 0.3,
        enabled: true,
      },
    ],
  }
  const mesh = solidFor(doc)
  // Straight down onto the top of the boss, which is 0.3 above the cube face.
  const anchor = pickAnchorOnSolid(rayFrom([0.05, 5, 0.05], [0, -1, 0]), CUBE, mesh)
  check('boss top is not mistaken for the base face', anchor?.on === 'derived', `got ${anchor?.on}`)
  if (anchor?.on === 'derived') {
    near('derived hit height', anchor.point[1], 1.3, 1e-3)
    near('derived normal points up', anchor.normal[1], 1, 1e-3)
  }

  // Beside the boss, the original face must still classify analytically.
  const beside = pickAnchorOnSolid(rayFrom([0.8, 5, 0.8], [0, -1, 0]), CUBE, mesh)
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

console.log(
  failures === 0
    ? '\nAll interaction checks passed.\n'
    : `\n${failures} interaction check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
