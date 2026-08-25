/**
 * Headless verification of GLB / OBJ export.
 *
 * The load-bearing check is that welding preserves signed volume exactly. A
 * weld that merged across a hard edge, or collapsed a sliver, would still
 * produce a file that opens -- and would be wrong in a way only noticed later
 * in Blender. Volume catches it here.
 *
 * Run: npx tsx scripts/export-check.ts
 */
import { BufferGeometry, Vector3 } from 'three'

// GLTFExporter marshals its binary chunk through FileReader, which browsers
// provide natively but Node does not expose. Polyfilling it here is purely so
// the GLB bytes can be verified headlessly; the app never relies on this.
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null
    // GLTFExporter assigns `onloadend` AFTER calling read*, and never uses
    // `onload`. Resolving on a microtask means the handler is always in place
    // by the time it fires.
    onloadend: (() => void) | null = null
    onload: (() => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    private finish() {
      this.onload?.()
      this.onloadend?.()
    }
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        (buf) => { this.result = buf; this.finish() },
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

import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { buildExportBlob, prepareForExport, triangleCount } from '../src/geometry/exporters'
import type { Doc } from '../src/geometry/types'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}
function near(label: string, actual: number, expected: number, tol: number) {
  check(label, Math.abs(actual - expected) <= tol, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`)
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

const CUBE_WITH_BOSS: Doc = {
  base: { kind: 'box', size: [2, 2, 2] },
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

// --- 1. Welding preserves the solid ---------------------------------------
console.log('\n1. Welding preserves the solid exactly')
{
  resetEvaluator()
  const { geometry } = evaluateDoc(CUBE_WITH_BOSS)
  const before = signedVolume(geometry)
  const beforeVerts = geometry.getAttribute('position').count

  const beforeTris = triangleCount(geometry)

  const { geom: weldedGeom, welded } = prepareForExport(geometry)
  check('welding ran', welded)
  check(
    'welding reduced the vertex count',
    weldedGeom.getAttribute('position').count < beforeVerts,
    `${beforeVerts} -> ${weldedGeom.getAttribute('position').count} vertices`
  )
  check(
    'triangle count is unchanged',
    triangleCount(weldedGeom) === beforeTris,
    `${beforeTris} -> ${triangleCount(weldedGeom)} tris`
  )
  // The decisive one: a weld that merged across a hard edge or collapsed a
  // sliver would still export cleanly, and would be wrong. Volume catches it.
  near('welded solid encloses the same volume', signedVolume(weldedGeom), before, 1e-6)
  // Normals must come back unit length, or importers shade the seams wrong.
  const nrm = weldedGeom.getAttribute('normal')
  let worstNormal = 0
  for (let i = 0; i < nrm.count; i++) {
    const len = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
    worstNormal = Math.max(worstNormal, Math.abs(len - 1))
  }
  check('all normals are unit length', worstNormal < 1e-5, `worst deviation ${worstNormal.toExponential(2)}`)
  weldedGeom.dispose()

  const { triangles, vertices } = await buildExportBlob(geometry, 'obj')
  check('reported triangles match', triangles === beforeTris, `${triangles}`)
  check('reported vertices are the welded count', vertices < beforeVerts, `${vertices}`)
  // The source geometry must survive untouched: it is still on screen.
  near('source geometry still intact', signedVolume(geometry), before, 1e-9)
}

// --- 2. Hard edges survive the weld ---------------------------------------
console.log('\n2. Hard edges survive the weld')
{
  resetEvaluator()
  const { geometry } = evaluateDoc({ base: { kind: 'box', size: [2, 2, 2] }, features: [] })
  const { vertices } = await buildExportBlob(geometry, 'obj')
  // A cube welded by position ALONE would collapse to 8 corners and shade
  // round. Welding by position AND normal must leave 4 per face, i.e. 24.
  check(
    'cube welds to 24 vertices, not 8',
    vertices === 24,
    `${vertices} vertices (8 would mean hard edges were lost)`
  )
}

// --- 3. OBJ output --------------------------------------------------------
console.log('\n3. OBJ output')
{
  resetEvaluator()
  const { geometry } = evaluateDoc(CUBE_WITH_BOSS)
  const { blob, triangles, vertices } = await buildExportBlob(geometry, 'obj')
  const text = await blob.text()

  const vLines = (text.match(/^v /gm) ?? []).length
  const vnLines = (text.match(/^vn /gm) ?? []).length
  const fLines = (text.match(/^f /gm) ?? []).length

  check('declares an object name', text.includes('o EZ3D_Model'), text.split('\n')[0])
  check('vertex count matches', vLines === vertices, `${vLines} v lines`)
  check('normals were written', vnLines > 0, `${vnLines} vn lines`)
  check('face count matches triangles', fLines === triangles, `${fLines} f lines`)
  check('faces reference normals', /^f \d+\/\/?\d*\/?\d*/m.test(text), '')
  check('no NaN in output', !text.includes('NaN'), '')
  check('blob is non-trivial', blob.size > 1000, `${blob.size} bytes`)
}

// --- 4. GLB output --------------------------------------------------------
console.log('\n4. GLB output')
{
  resetEvaluator()
  const { geometry } = evaluateDoc(CUBE_WITH_BOSS)
  try {
    const { blob } = await buildExportBlob(geometry, 'glb')
    const buf = await blob.arrayBuffer()
    const view = new DataView(buf)

    // glTF binary container: magic 'glTF', version 2, then total length.
    const magic = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    )
    check('starts with the glTF magic', magic === 'glTF', `got "${magic}"`)
    check('container version is 2', view.getUint32(4, true) === 2, `${view.getUint32(4, true)}`)
    check(
      'header length matches the payload',
      view.getUint32(8, true) === buf.byteLength,
      `${view.getUint32(8, true)} vs ${buf.byteLength}`
    )
    check('blob is non-trivial', blob.size > 1000, `${blob.size} bytes`)

    // The JSON chunk should name the mesh and declare a single node.
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)).replace(/\0+$/, '')
    )
    check('mesh is named', JSON.stringify(json).includes('EZ3D_Model'), '')
    check('has exactly one mesh', json.meshes?.length === 1, `${json.meshes?.length}`)
    check(
      'declares POSITION and NORMAL',
      'POSITION' in (json.meshes?.[0]?.primitives?.[0]?.attributes ?? {}) &&
        'NORMAL' in (json.meshes?.[0]?.primitives?.[0]?.attributes ?? {}),
      Object.keys(json.meshes?.[0]?.primitives?.[0]?.attributes ?? {}).join(',')
    )
  } catch (err) {
    check('GLB export completes', false, err instanceof Error ? err.message : String(err))
  }
}

// --- 4b. Round trip: the file actually reopens as the same solid ----------
console.log('')
console.log('4b. GLB round-trip')
{
  resetEvaluator()
  const { geometry } = evaluateDoc(CUBE_WITH_BOSS)
  const expected = signedVolume(geometry)
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const { blob } = await buildExportBlob(geometry, 'glb')
    const buf = await blob.arrayBuffer()

    const scene = await new Promise<import('three').Group>((resolve, reject) => {
      new GLTFLoader().parse(buf, '', (gltf) => resolve(gltf.scene), reject)
    })

    let total = 0
    let meshes = 0
    scene.traverse((o) => {
      const m = o as import('three').Mesh
      if (m.isMesh && m.geometry) {
        meshes++
        m.updateMatrixWorld(true)
        const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
        total += signedVolume(g)
        g.dispose()
      }
    })

    check('exported file reopens', meshes === 1, `${meshes} mesh(es) found`)
    // Reading the solid back out of the bytes is the real proof: buffer
    // offsets, index types and winding all have to be right for this to land.
    near('round-tripped volume matches the original', total, expected, 1e-3)
  } catch (err) {
    check('GLB round-trip', false, err instanceof Error ? err.message : String(err))
  }
}

// --- 5. Empty guard --------------------------------------------------------
console.log('\n5. Refuses to export nothing')
{
  const empty = new BufferGeometry()
  empty.setAttribute('position', new (await import('three')).BufferAttribute(new Float32Array(0), 3))
  let threw = false
  try {
    await buildExportBlob(empty, 'obj')
  } catch {
    threw = true
  }
  check('empty geometry is rejected', threw)
}

console.log(
  failures === 0 ? '\nAll export checks passed.\n' : `\n${failures} export check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
