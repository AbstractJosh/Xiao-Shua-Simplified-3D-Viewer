/**
 * Headless verification of the geometry engine.
 *
 * The core tool here is signed volume via the divergence theorem. For a closed,
 * consistently wound mesh it returns the true enclosed volume -- so a single
 * number simultaneously checks that the boolean produced the right amount of
 * material AND that the result is watertight. A leaking or inside-out mesh
 * cannot accidentally land on the analytic answer.
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
import type { Doc, Feature, SurfaceAnchor } from '../src/geometry/types'

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

function signedVolume(geom: BufferGeometry): number {
  const pos = geom.getAttribute('position')
  const index = geom.getIndex()
  const triCount = index ? index.count / 3 : pos.count / 3
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const cross = new Vector3()
  let vol = 0
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    cross.crossVectors(b, c)
    vol += a.dot(cross) / 6
  }
  return vol
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
  ...over,
})

const CUBE: Doc['base'] = { kind: 'box', size: [2, 2, 2] }
const SPHERE: Doc['base'] = { kind: 'sphere', radius: 1 }
const TOP_FACE: SurfaceAnchor = { on: 'box-face', face: 2, u: 0, v: 0 }

// --- 1. Base solids --------------------------------------------------------
console.log('\n1. Base solids')
resetEvaluator()
{
  const r = evaluateDoc({ base: CUBE, features: [] })
  near('bare cube volume', signedVolume(r.geometry), 8, 1e-3)
  check('cube has triangles', triangleCount(r.geometry) >= 12, `${triangleCount(r.geometry)} tris`)
  check('no NaN positions', !hasNaN(r.geometry), '')
}
{
  const r = evaluateDoc({ base: SPHERE, features: [] })
  const ideal = (4 / 3) * Math.PI
  const vol = signedVolume(r.geometry)
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
  const r = evaluateDoc({
    base: CUBE,
    features: [feature({ anchor: TOP_FACE, op: 'extrude', depth: 0.3 })],
  })
  near('cube + circular boss', signedVolume(r.geometry), 8 + discVolume, 0.002)
  check('no NaN positions', !hasNaN(r.geometry), '')
}
{
  resetEvaluator()
  const r = evaluateDoc({
    base: CUBE,
    features: [feature({ anchor: TOP_FACE, op: 'intrude', depth: 0.3 })],
  })
  near('cube - circular pocket', signedVolume(r.geometry), 8 - discVolume, 0.002)
}
{
  resetEvaluator()
  const r = evaluateDoc({
    base: CUBE,
    features: [
      feature({ anchor: TOP_FACE, op: 'intrude', depth: 0.3, shape: { type: 'rect', w: 0.6, h: 0.4 } }),
    ],
  })
  near('cube - rectangular pocket', signedVolume(r.geometry), 8 - 0.6 * 0.4 * 0.3, 0.002)
}

// --- 3. Through-cut --------------------------------------------------------
console.log('\n3. Through-cut (depth exceeds thickness)')
{
  resetEvaluator()
  const r = evaluateDoc({
    base: CUBE,
    features: [feature({ anchor: TOP_FACE, op: 'intrude', depth: 2.5 })],
  })
  // A clean bore through a 2-thick cube removes a full-height cylinder.
  near('cube - through hole', signedVolume(r.geometry), 8 - Math.PI * 0.09 * 2, 0.01)
}

// --- 4. Curved surface: the offset-shell payoff ----------------------------
console.log('\n4. Sphere: boss follows the curvature')
{
  resetEvaluator()
  const depth = 0.25
  const r = evaluateDoc({
    base: SPHERE,
    features: [
      feature({
        anchor: { on: 'sphere', theta: 0, phi: Math.PI / 2 },
        op: 'extrude',
        depth,
        shape: { type: 'rect', w: 0.5, h: 0.5 },
      }),
    ],
  })
  const vol = signedVolume(r.geometry)
  check('sphere gained material', vol > (4 / 3) * Math.PI, `volume ${vol.toFixed(4)}`)
  check('no NaN positions', !hasNaN(r.geometry), '')

  // The decisive check. Every vertex on the boss's outer face must sit at
  // exactly R+depth from the centre. A straight prism capped flat would put the
  // corners further out than the middle, so the spread would be large.
  const radii = outerShellRadii(r.geometry, 1 + depth * 0.5)
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
  const r = evaluateDoc({
    base: SPHERE,
    features: [
      feature({
        anchor: { on: 'sphere', theta: Math.PI / 3, phi: Math.PI / 2.5 },
        op: 'intrude',
        depth: 0.25,
      }),
    ],
  })
  const vol = signedVolume(r.geometry)
  check('sphere lost material', vol < (4 / 3) * Math.PI, `volume ${vol.toFixed(4)}`)
  check('sphere pocket did not leak', vol > 0, `volume ${vol.toFixed(4)}`)
}

// --- 5. Stacked features and cache reuse -----------------------------------
console.log('\n5. Stacked features and prefix cache')
{
  resetEvaluator()
  const doc: Doc = {
    base: CUBE,
    features: [
      { ...feature({ anchor: TOP_FACE }), id: 'a', op: 'extrude', depth: 0.3 },
      {
        ...feature({ anchor: { on: 'box-face', face: 4, u: 0.3, v: -0.2 } }),
        id: 'b',
        op: 'intrude',
        depth: 0.4,
        shape: { type: 'ngon', r: 0.25, sides: 6 },
      },
    ],
  }
  const first = evaluateDoc(doc)
  near('two stacked features', signedVolume(first.geometry), 8 + discVolume - hexPrism(0.25, 6, 0.4), 0.01)
  check('no features failed', first.failed.length === 0, first.failed.join(',') || 'none')

  const second = evaluateDoc(doc)
  check('unchanged doc reuses cache', second.millis < first.millis + 1, `${first.millis.toFixed(1)}ms then ${second.millis.toFixed(1)}ms`)
  check('cache returns same geometry object', second.geometry === first.geometry, '')

  // Edit only the LAST feature: the first must be reused, not recomputed.
  const edited: Doc = {
    ...doc,
    features: [doc.features[0], { ...doc.features[1], depth: 0.5 }],
  }
  const third = evaluateDoc(edited)
  check('edited doc produces new geometry', third.geometry !== first.geometry, '')
  near('re-evaluated volume', signedVolume(third.geometry), 8 + discVolume - hexPrism(0.25, 6, 0.5), 0.01)
}

// --- 6. Inert features -----------------------------------------------------
console.log('\n6. Inert features contribute nothing')
{
  resetEvaluator()
  const r = evaluateDoc({
    base: CUBE,
    features: [feature({ anchor: TOP_FACE, depth: 0 })],
  })
  near('depth 0 leaves the solid alone', signedVolume(r.geometry), 8, 1e-3)
}
{
  resetEvaluator()
  const r = evaluateDoc({
    base: CUBE,
    features: [feature({ anchor: TOP_FACE, depth: 0.3, enabled: false })],
  })
  near('disabled feature leaves the solid alone', signedVolume(r.geometry), 8, 1e-3)
}

/** Area of a regular n-gon of circumradius r, times height. */
function hexPrism(r: number, sides: number, h: number): number {
  const area = 0.5 * sides * r * r * Math.sin((2 * Math.PI) / sides)
  return area * h
}

console.log(
  failures === 0
    ? '\nAll engine checks passed.\n'
    : `\n${failures} engine check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
