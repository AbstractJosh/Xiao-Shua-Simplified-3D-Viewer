/**
 * Headless verification of GLB / OBJ / STL / STEP import.
 *
 * The load-bearing check is the ROUND TRIP: a solid exported and read straight
 * back in has to be the same solid -- same volume, same box, same size on
 * screen. That is the promise the Import button makes by accepting exactly the
 * four formats Export writes, and it is the one that cannot be verified by
 * looking at a file, because every one of the four can be perfectly valid and
 * still describe something a hundred times too big (STEP writes millimetres) or
 * inside out (a winding dropped in triangulation).
 *
 * Volume catches both. A mesh whose normals came back reversed has a NEGATIVE
 * volume of the same magnitude, and a mesh at the wrong scale is off by the
 * cube of it, so the one number rules out both classes at once.
 *
 * Run: npx tsx scripts/import-check.ts
 */
import { BufferAttribute, BufferGeometry, Box3, Vector3 } from 'three'

// GLTFExporter marshals its binary chunk through FileReader, which browsers
// provide natively but Node does not expose. Polyfilled exactly as
// `export-check.ts` does, and for the same reason: it is the EXPORT half of the
// round trip that needs it, never the app.
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null
    onloadend: (() => void) | null = null
    onload: (() => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    private finish() {
      this.onload?.()
      this.onloadend?.()
    }
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = buf
          this.finish()
        },
        (e) => this.onerror?.(e)
      )
    }
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`
          this.finish()
        },
        (e) => this.onerror?.(e)
      )
    }
  }
  ;(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader
}

const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}

import { evaluateDoc, mergedGeometry, resetEvaluator } from '../src/geometry/evaluate'
import { buildExportBlob } from '../src/geometry/exporters'
import type { ExportFormat } from '../src/geometry/exporters'
import { fitToEnvelope, formatOf, importModel } from '../src/geometry/importers'
import { forgetMeshes, meshGeometry, registerMesh } from '../src/geometry/meshLibrary'
import { parseStep } from '../src/geometry/stepImport'
import { surfaceFor } from '../src/geometry/surfaces'
import { axisDimension, resizeAlongAxis, scaleUniform } from '../src/geometry/dimensions'
import { signedVolume } from '../src/geometry/volume'
import { IDENTITY_TRANSFORM, solidLabel } from '../src/geometry/types'
import { dropPosition } from '../src/console/ImportTools'
import type { BaseSolid, Doc, Feature, SceneObject, Vec3 } from '../src/geometry/types'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}
function near(label: string, actual: number, expected: number, tol: number) {
  check(
    label,
    Math.abs(actual - expected) <= tol,
    `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`
  )
}

function object(
  base: BaseSolid,
  features: Feature[] = [],
  position: Vec3 = [0, 0, 0],
  id = 'obj'
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

function exportGeometry(doc: Doc): BufferGeometry {
  return mergedGeometry(doc, evaluateDoc(doc))
}

function boxOf(geom: BufferGeometry): Box3 {
  return new Box3().setFromBufferAttribute(geom.getAttribute('position') as BufferAttribute)
}

function spanOf(geom: BufferGeometry): Vector3 {
  return boxOf(geom).getSize(new Vector3())
}

function triangles(geom: BufferGeometry): number {
  const index = geom.getIndex()
  const position = geom.getAttribute('position')
  return Math.floor((index ? index.count : position.count) / 3)
}

/** Total area of every triangle: the only measure an open surface has. */
function surfaceArea(geom: BufferGeometry): number {
  const p = geom.getAttribute('position')
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  let area = 0
  for (let t = 0; t < p.count / 3; t++) {
    a.fromBufferAttribute(p as BufferAttribute, t * 3)
    b.fromBufferAttribute(p as BufferAttribute, t * 3 + 1)
    c.fromBufferAttribute(p as BufferAttribute, t * 3 + 2)
    area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2
  }
  return area
}

const EXT: Record<ExportFormat, string> = {
  glb: 'glb',
  obj: 'obj',
  stl: 'stl',
  step: 'step',
}

/** Export a scene, then read the bytes straight back in. */
async function roundTrip(
  doc: Doc,
  format: ExportFormat
): Promise<{ geometry: BufferGeometry; detail?: string }> {
  resetEvaluator()
  const source = exportGeometry(doc)
  try {
    const { blob } = await buildExportBlob(source, format, '2026-01-01T00:00:00')
    const model = await importModel(await blob.arrayBuffer(), `part.${EXT[format]}`)
    return { geometry: model.geometry, detail: model.detail }
  } finally {
    source.dispose()
  }
}

const CIRCLE_BOSS: Feature = {
  id: 'boss',
  anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
  shape: { type: 'circle', r: 0.3 },
  rotation: 0,
  depth: 0.3,
  enabled: true,
  tilt: [0, 0, 0],
  faceOffset: [0, 0],
}

const POCKET: Feature = { ...CIRCLE_BOSS, id: 'pocket', depth: -0.4 }

const CUBE_WITH_BOSS: Doc = scene(object({ kind: 'box', size: [2, 2, 2] }, [CIRCLE_BOSS]))
const DRILLED_CUBE: Doc = scene(object({ kind: 'box', size: [2, 2, 2] }, [POCKET]))

// --- 1. Every format survives the round trip -------------------------------
console.log('\n1. Exported, then imported, is the same solid')
{
  resetEvaluator()
  const source = exportGeometry(CUBE_WITH_BOSS)
  const volume = signedVolume(source)
  const span = spanOf(source)
  const tris = triangles(source)
  source.dispose()

  check('the reference solid is worth measuring', volume > 8, `${volume.toFixed(4)} units^3`)

  for (const format of ['glb', 'obj', 'stl', 'step'] as ExportFormat[]) {
    const { geometry, detail } = await roundTrip(CUBE_WITH_BOSS, format)
    // Relative, because the three mesh formats quantise to float32 and OBJ
    // writes six decimals: the error scales with the size of the model, not
    // with anything fixed.
    near(`${format}: volume survives`, signedVolume(geometry) / volume, 1, 1e-4)
    const back = spanOf(geometry)
    near(`${format}: width survives`, back.x, span.x, span.x * 1e-4)
    near(`${format}: height survives`, back.y, span.y, span.y * 1e-4)
    near(`${format}: depth survives`, back.z, span.z, span.z * 1e-4)
    // STEP is not a mesh format: it comes back as topology retriangulated from
    // scratch, so a matching count would be a coincidence. The other three are
    // triangle lists and must land on exactly what went out.
    if (format === 'step') {
      check(`${format}: it reports the faces it read`, (detail ?? '').includes('face'), detail)
      check(`${format}: and nothing was skipped`, !(detail ?? '').includes('skipped'), detail)
    } else {
      check(
        `${format}: every triangle survives`,
        triangles(geometry) === tris,
        `${triangles(geometry)} of ${tris}`
      )
    }
    geometry.dispose()
  }
}

// --- 2. Normals come back pointing out -------------------------------------
console.log('\n2. The solid is not inside out')
{
  for (const format of ['glb', 'obj', 'stl', 'step'] as ExportFormat[]) {
    const { geometry } = await roundTrip(DRILLED_CUBE, format)
    // A drilled cube is the harder case: the pocket's walls face INWARD, so a
    // reader that decided winding from the outer boundary alone gets the hole
    // right and the block wrong, or the other way about. Only the signed volume
    // of the whole thing is sensitive to both at once.
    check(`${format}: the volume is positive`, signedVolume(geometry) > 0, `${signedVolume(geometry).toFixed(4)}`)
    geometry.dispose()
  }
}

// --- 3. STEP reads the unit the file declares ------------------------------
console.log('\n3. STEP arrives at the size the file says, not the size it writes')
{
  resetEvaluator()
  const source = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] })))
  const { blob } = await buildExportBlob(source, 'step', '2026-01-01T00:00:00')
  source.dispose()
  const text = await blob.text()

  check('the file is written in millimetres', text.includes('SI_UNIT(.MILLI.,.METRE.)'))
  // Centred on its own origin, so a two-unit cube reaches one unit each way:
  // 100 mm, written as `100.` and `-100.`.
  check('and a two-unit cube reaches 100 of them', text.includes('100.') && text.includes('-100.'))

  const back = parseStep(text)
  near('but it imports as two units, not two hundred', spanOf(back.geometry).x, 2, 1e-6)
  check('and it read six faces', back.faces === 6, `${back.faces}`)
  check('with none skipped', back.skipped === 0, `${back.skipped}`)
  back.geometry.dispose()

  // The same file with its unit swapped for metres: a hundred times bigger, and
  // NOT because anything in the geometry changed. This is the check that the
  // reader consults the declaration rather than assuming what the writer emits.
  const inMetres = parseStep(text.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT($,.METRE.)'))
  near('declared in metres, the same numbers are 1000x', spanOf(inMetres.geometry).x, 2000, 1e-3)
  inMetres.geometry.dispose()
}

// --- 4. STEP reads arcs, not just straight edges ---------------------------
console.log('\n4. STEP faces bounded by a circle')
{
  // A single planar disc of radius 10 mm, written by hand: nothing this app
  // exports has a CIRCLE in it -- the booleans facet every curve long before
  // `step.ts` sees it -- so the round trip above can never reach that path.
  const disc = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('disc','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    "#1=CARTESIAN_POINT('',(0.,0.,0.));",
    "#2=DIRECTION('',(0.,0.,1.));",
    "#3=DIRECTION('',(1.,0.,0.));",
    "#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);",
    "#5=CIRCLE('',#4,10.);",
    "#6=CARTESIAN_POINT('',(10.,0.,0.));",
    '#7=VERTEX_POINT(\'\',#6);',
    "#8=EDGE_CURVE('',#7,#7,#5,.T.);",
    "#9=ORIENTED_EDGE('',*,*,#8,.T.);",
    "#10=EDGE_LOOP('',(#9));",
    "#11=FACE_OUTER_BOUND('',#10,.T.);",
    "#12=PLANE('',#4);",
    "#13=ADVANCED_FACE('',(#11),#12,.T.);",
    '#14=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    "#15=( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#14)) REPRESENTATION_CONTEXT('','3D') );",
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n')

  const read = parseStep(disc)
  check('the disc is one face', read.faces === 1, `${read.faces}`)
  check('and nothing was skipped', read.skipped === 0, `${read.skipped}`)
  // 10 mm is 0.1 scene units, so the disc is 0.2 across and pi/100 in area. A
  // 48-segment polygon falls a little short of the true circle, which is why
  // the tolerance is a percent rather than a rounding error.
  near('it measures 0.2 units across', spanOf(read.geometry).x, 0.2, 2e-3)
  near('and its area is close to pi r squared', surfaceArea(read.geometry), Math.PI * 0.01, 1e-4)
  read.geometry.dispose()
}

// --- 5. STEP says what it could not read -----------------------------------
console.log('\n5. A curved surface is skipped, and counted')
{
  const curved = [
    'ISO-10303-21;',
    'DATA;',
    "#1=CARTESIAN_POINT('',(0.,0.,0.));",
    "#2=DIRECTION('',(0.,0.,1.));",
    "#3=DIRECTION('',(1.,0.,0.));",
    "#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);",
    "#5=CYLINDRICAL_SURFACE('',#4,10.);",
    "#6=EDGE_LOOP('',());",
    "#7=FACE_OUTER_BOUND('',#6,.T.);",
    "#8=ADVANCED_FACE('',(#7),#5,.T.);",
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n')

  let message = ''
  try {
    parseStep(curved)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  check('a file of nothing but curved faces is refused', message.length > 0, message)
  check('and the message says why', message.includes('curved'), message)
}

// --- 6. What the library does with a model ---------------------------------
console.log('\n6. An imported model is normalised, and comes back the size asked for')
{
  forgetMeshes()
  resetEvaluator()
  const source = exportGeometry(scene(object({ kind: 'box', size: [3, 1, 2] })))
  const volume = signedVolume(source)
  const entry = registerMesh(source, 'block')

  near('it remembers the width the file described', entry.natural[0], 3, 1e-5)
  near('and the height', entry.natural[1], 1, 1e-5)
  near('and the depth', entry.natural[2], 2, 1e-5)

  const unit = spanOf(entry.geometry)
  near('the stored copy is one unit wide', unit.x, 1, 1e-6)
  near('one unit high', unit.y, 1, 1e-6)
  near('and one unit deep', unit.z, 1, 1e-6)
  const centre = boxOf(entry.geometry).getCenter(new Vector3())
  near('centred on the local origin in x', centre.x, 0, 1e-6)
  near('in y', centre.y, 0, 1e-6)
  near('and in z', centre.z, 0, 1e-6)

  // Asked for at its natural size it is the solid that went in, to the digit.
  const back = meshGeometry(entry.id, entry.natural)
  near('at its natural size the volume returns', signedVolume(back) / volume, 1, 1e-5)
  back.dispose()

  const stretched = meshGeometry(entry.id, [6, 1, 2])
  near('and doubling one axis doubles the volume', signedVolume(stretched) / volume, 2, 1e-5)
  near('the stretched copy is six wide', spanOf(stretched).x, 6, 1e-5)
  near('and still one high', spanOf(stretched).y, 1, 1e-5)
  stretched.dispose()

  check('every copy is a fresh geometry', meshGeometry(entry.id, [1, 1, 1]) !== entry.geometry)
}

// --- 7. A model is an ordinary solid ---------------------------------------
console.log('\n7. It behaves like every other base solid')
{
  forgetMeshes()
  resetEvaluator()
  const source = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] })))
  const entry = registerMesh(source, 'cube')
  const base: BaseSolid = {
    kind: 'mesh',
    meshId: entry.id,
    label: entry.label,
    size: [2, 2, 2],
  }

  check('it is named after the file', solidLabel(base) === 'cube', solidLabel(base))

  const bounds = surfaceFor(base).bounds()
  near('its bounds are its size, halved about the origin', bounds.max.x, 1, 1e-9)
  near('and reach the same distance the other way', bounds.min.y, -1, 1e-9)

  const dim = axisDimension(base, 0)
  check('the gizmo drives its width', dim?.field === 'size', dim?.field)
  check('as a full extent, not a radius', dim?.perUnit === 0.5, `${dim?.perUnit}`)

  const wider = resizeAlongAxis(base, 0, 0.5)
  check('resizing keeps it a model', wider.kind === 'mesh', wider.kind)
  near('and moves the surface by what was asked', surfaceFor(wider).bounds().max.x, 1.5, 1e-9)
  check(
    'and keeps its ticket',
    wider.kind === 'mesh' && wider.meshId === entry.id,
    wider.kind === 'mesh' ? wider.meshId : '-'
  )

  const scaled = scaleUniform(base, 2)
  check(
    'a uniform scale keeps its proportions',
    scaled.kind === 'mesh' &&
      scaled.size[0] === 4 &&
      scaled.size[1] === 4 &&
      scaled.size[2] === 4,
    scaled.kind === 'mesh' ? scaled.size.join(' x ') : '-'
  )

  // The whole point of the mesh base: the evaluator has to build it, features
  // and cuts included, exactly the way it builds a primitive.
  resetEvaluator()
  const doc = scene(object(base, [], [0, 0, 0], 'imported'))
  const evaluated = evaluateDoc(doc)
  check('the evaluator builds it', evaluated.failed.length === 0, evaluated.failed.join(','))
  near('at the volume its size implies', signedVolume(evaluated.objects[0].geometry), 8, 1e-3)

  // And a pocket cut into it, which is a boolean against a derived anchor --
  // the only kind of anchor a mesh ever produces.
  resetEvaluator()
  const holed = scene(
    object(
      base,
      [
        {
          id: 'hole',
          anchor: { on: 'derived', point: [0, 1, 0], normal: [0, 1, 0] },
          shape: { type: 'circle', r: 0.3 },
          rotation: 0,
          depth: -0.5,
          enabled: true,
          tilt: [0, 0, 0],
          faceOffset: [0, 0],
        },
      ],
      [0, 0, 0],
      'imported'
    )
  )
  const cut = evaluateDoc(holed)
  check('a pocket sinks into it', cut.failed.length === 0, cut.failed.join(','))
  const left = signedVolume(cut.objects[0].geometry)
  check('and takes material away', left < 8 - 0.1, `${left.toFixed(4)} of 8`)
  near('about as much as the pocket is big', 8 - left, Math.PI * 0.09 * 0.5, 5e-3)
}

// --- 8. Sizing an import into the world it has to live in ------------------
console.log('\n8. A model too big or too small for the envelope is fitted')
{
  const asIs = fitToEnvelope([2, 1, 3])
  check('one that fits is left alone', asIs.factor === 1, `${asIs.factor}`)
  check('at exactly the size the file described', asIs.size.join(' x ') === '2 x 1 x 3', asIs.size.join(' x '))

  // 200 units is twenty metres, four times the world. A millimetre model that
  // never declared its unit lands here.
  const huge = fitToEnvelope([200, 100, 50])
  near('a giant is scaled down to fit', Math.max(...huge.size), 50, 1e-9)
  near('and keeps its proportions', huge.size[0] / huge.size[1], 2, 1e-9)
  near('all of them', huge.size[1] / huge.size[2], 2, 1e-9)

  const tiny = fitToEnvelope([0.0001, 0.00005, 0.0001])
  near('one too small to see lands at a unit across', Math.max(...tiny.size), 1, 1e-9)
  near('proportions again', tiny.size[0] / tiny.size[1], 2, 1e-6)

  // A profile, a plate, a single face: genuinely flat, and it must not divide
  // by that zero on the way in.
  const flat = fitToEnvelope([2, 0, 2])
  check('a flat model keeps its two real axes', flat.size[0] === 2 && flat.size[2] === 2, flat.size.join(' x '))
  check('and its third is the smallest the app can write', flat.size[1] === 0.01, `${flat.size[1]}`)
}

// --- 9. Which reader a filename asks for -----------------------------------
console.log('\n9. Formats are chosen by extension')
{
  check('.glb', formatOf('part.glb') === 'glb')
  check('.obj', formatOf('part.obj') === 'obj')
  check('.stl', formatOf('part.stl') === 'stl')
  check('.step', formatOf('part.step') === 'step')
  check('.stp is STEP under its other name', formatOf('part.stp') === 'step')
  check('case does not matter', formatOf('PART.STL') === 'stl')
  check('a path with dots in it', formatOf('/a.b/c.d/part.obj') === 'obj')
  check('anything else is refused', formatOf('part.fbx') === null)
  check('and so is a name with no extension', formatOf('part') === null)

  let refused = ''
  try {
    await importModel(new ArrayBuffer(8), 'part.fbx')
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err)
  }
  check('and the reader says so rather than guessing', refused.includes('GLB'), refused)
}

// --- 10. Where an import lands ---------------------------------------------
console.log('\n10. A model is set down on the ground, clear of the scene')
{
  const onNothing = dropPosition(scene(), [2, 3, 4])
  check(
    'into an empty scene it lands at the origin',
    onNothing[0] === 0 && onNothing[2] === 0,
    onNothing.join(', ')
  )
  near('resting on the ground, so half its height up', onNothing[1], 1.5, 1e-9)

  // A two-unit cube parked at the origin fills -1..1, so anything set down
  // beside it has to clear +1 by its own half-width and then some.
  const beside = dropPosition(scene(object({ kind: 'box', size: [2, 2, 2] })), [2, 2, 2])
  check('into an occupied one it lands clear to the right', beside[0] > 2, `x = ${beside[0]}`)
  near('and still on the ground', beside[1], 1, 1e-9)

  // Measured from the SCENE and not from the origin: something parked far out
  // to the right has to be cleared too.
  const far = dropPosition(
    scene(object({ kind: 'box', size: [2, 2, 2] }, [], [10, 1, 0])),
    [2, 2, 2]
  )
  check('wherever that scene happens to be', far[0] > 11, `x = ${far[0]}`)
}

console.log(
  failures === 0 ? '\nAll import checks passed.\n' : `\n${failures} import check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
