/**
 * Headless verification of GLB / OBJ / STL / STEP export.
 *
 * The load-bearing check is that welding preserves signed volume exactly. A
 * weld that merged across a hard edge, or collapsed a sliver, would still
 * produce a file that opens -- and would be wrong in a way only noticed later
 * in Blender. Volume catches it here.
 *
 * Run: npx tsx scripts/export-check.ts
 */
import { BufferGeometry } from 'three'

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

import { evaluateDoc, mergedGeometry, resetEvaluator } from '../src/geometry/evaluate'
import { buildExportBlob, prepareForExport, triangleCount } from '../src/geometry/exporters'
import {
  flatFaces,
  healTJunctions,
  indexByPosition,
  isManifold,
  shells,
} from '../src/geometry/brep'
import type { BrepMesh } from '../src/geometry/brep'
import { signedVolume } from '../src/geometry/volume'
import { EXPORT_MODEL_NAME } from '../src/appInfo'
import { IDENTITY_TRANSFORM } from '../src/geometry/types'
import type { BaseSolid, Doc, Feature, SceneObject, Vec3 } from '../src/geometry/types'

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

/** A fixed clock, so a STEP file written twice is the same bytes twice. */
const STAMP = '2026-01-01T00:00:00'

function occurrencesOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * What the export panel actually hands to the exporter: every object baked
 * through its own transform into one world-space geometry.
 *
 * THE CALLER OWNS IT. Every use below disposes it, which is also the check that
 * disposal never reaches the evaluator's cached per-object geometry -- a later
 * check would evaluate to an empty mesh if it did.
 */
function exportGeometry(doc: Doc): BufferGeometry {
  return mergedGeometry(doc, evaluateDoc(doc))
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

const CUBE_WITH_BOSS: Doc = scene(object({ kind: 'box', size: [2, 2, 2] }, [CIRCLE_BOSS]))

// --- 1. Welding preserves the solid ---------------------------------------
console.log('\n1. Welding preserves the solid exactly')
{
  resetEvaluator()
  const geometry = exportGeometry(CUBE_WITH_BOSS)
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
  // Exporting must not consume what it was handed: the panel evaluates once
  // and may write both formats from the same merged geometry.
  near('source geometry still intact', signedVolume(geometry), before, 1e-9)
  geometry.dispose()

  // And the merged copy shares no buffer with the evaluator's cache, so
  // disposing it must leave the object on screen intact.
  near(
    'the cached per-object geometry is untouched',
    signedVolume(evaluateDoc(CUBE_WITH_BOSS).objects[0].geometry),
    before,
    1e-9
  )
}

// --- 2. Hard edges survive the weld ---------------------------------------
console.log('\n2. Hard edges survive the weld')
{
  resetEvaluator()
  const geometry = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] })))
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
  const geometry = exportGeometry(CUBE_WITH_BOSS)
  const { blob, triangles, vertices } = await buildExportBlob(geometry, 'obj')
  const text = await blob.text()

  const vLines = (text.match(/^v /gm) ?? []).length
  const vnLines = (text.match(/^vn /gm) ?? []).length
  const fLines = (text.match(/^f /gm) ?? []).length

  check('declares an object name', text.includes(`o ${EXPORT_MODEL_NAME}`), text.split('\n')[0])
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
  const geometry = exportGeometry(CUBE_WITH_BOSS)
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
    check('mesh is named', JSON.stringify(json).includes(EXPORT_MODEL_NAME), '')
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
  const geometry = exportGeometry(CUBE_WITH_BOSS)
  const expected = signedVolume(geometry)
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const { blob } = await buildExportBlob(geometry, 'glb')
    const buf = await blob.arrayBuffer()

    const loaded = await new Promise<import('three').Group>((resolve, reject) => {
      new GLTFLoader().parse(buf, '', (gltf) => resolve(gltf.scene), reject)
    })

    let total = 0
    let meshes = 0
    loaded.traverse((o) => {
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

// --- 5. The scene, baked into world space ---------------------------------
console.log('\n5. Every object, baked through its own transform')
{
  resetEvaluator()
  const one = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] })))
  const single = signedVolume(one)
  one.dispose()

  resetEvaluator()
  const pair = exportGeometry(
    scene(
      object({ kind: 'box', size: [2, 2, 2] }, [], [-3, 0, 0], 'left'),
      object({ kind: 'box', size: [2, 2, 2] }, [], [3, 0.5, 0], 'right')
    )
  )
  near('two cubes export as two cubes', signedVolume(pair), 2 * single, 1e-6)

  // Placement is the whole reason the transform exists, so it has to reach the
  // file: a merge that dropped it would land both cubes on top of each other
  // and still pass a volume check.
  pair.computeBoundingBox()
  const box = pair.boundingBox!
  near('the scene spans both placements', box.min.x, -4, 1e-6)
  near('and reaches the far one', box.max.x, 4, 1e-6)
  near('carrying the second cube lift', box.max.y, 1.5, 1e-6)
  pair.dispose()

  // A rotation must go through the normal matrix, not the full one. Baking a
  // translation into a normal is invisible in the vertex positions and shows up
  // only as inverted shading -- or, here, as a negative signed volume.
  resetEvaluator()
  const turned = exportGeometry(
    scene({
      id: 'turned',
      name: 'turned',
      base: { kind: 'box', size: [2, 2, 2] },
      transform: { position: [0, 4, 0], rotation: [0.3, 0.7, -0.2] },
      features: [CIRCLE_BOSS],
      cuts: [],
      parts: [],
    })
  )
  resetEvaluator()
  const upright = exportGeometry(CUBE_WITH_BOSS)
  near('a rotated object keeps its volume', signedVolume(turned), signedVolume(upright), 1e-6)
  check(
    'and its winding, so it is not inside out',
    signedVolume(turned) > 0,
    `${signedVolume(turned).toFixed(4)}`
  )
  const nrm = turned.getAttribute('normal')
  let worst = 0
  for (let i = 0; i < nrm.count; i++) {
    worst = Math.max(worst, Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1))
  }
  check('normals survive the bake unit length', worst < 1e-5, `worst deviation ${worst.toExponential(2)}`)
  turned.dispose()
  upright.dispose()
}

// --- 7. STL output ---------------------------------------------------------
console.log('\n7. STL output')
{
  resetEvaluator()
  const geometry = exportGeometry(CUBE_WITH_BOSS)
  const expected = signedVolume(geometry)
  const tris = triangleCount(geometry)
  const { blob, triangles } = await buildExportBlob(geometry, 'stl', STAMP)
  const buf = await blob.arrayBuffer()
  const view = new DataView(buf)

  // Binary STL is a fixed-size record format and nothing else: 80 bytes of
  // header nobody reads, a triangle count, then exactly 50 bytes per triangle.
  // If that arithmetic lands, the file is structurally sound by construction.
  check(
    'the header counts the triangles',
    view.getUint32(80, true) === tris,
    `${view.getUint32(80, true)} vs ${tris}`
  )
  check(
    'and the file is exactly as long as that many records',
    blob.size === 84 + tris * 50,
    `${blob.size} vs ${84 + tris * 50}`
  )
  check('the reported triangle count agrees', triangles === tris, `${triangles}`)

  const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
  const reopened = new STLLoader().parse(buf)
  // The decisive one, as with GLB: reading the solid back out of the bytes.
  // Winding, float order and the record stride all have to be right to land on
  // the same volume, and STL stores a normal per facet that must not disagree.
  near('the file reopens as the same solid', signedVolume(reopened), expected, 1e-3)
  reopened.dispose()
  geometry.dispose()
}

// --- 8. Triangles read back as topology ------------------------------------
console.log('\n8. Triangles read back as topology')
{
  /** Signed volume straight off a welded mesh, without going through three. */
  const meshVolume = (mesh: BrepMesh): number => {
    let volume = 0
    const p = mesh.points
    for (let t = 0; t < mesh.tris.length; t += 3) {
      const a = mesh.tris[t] * 3
      const b = mesh.tris[t + 1] * 3
      const c = mesh.tris[t + 2] * 3
      volume +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
          p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6
    }
    return volume
  }

  resetEvaluator()
  const plain = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] })))
  const cube = indexByPosition(plain)
  check(
    'a cube welds to 8 vertices, not 24',
    cube.points.length / 3 === 8,
    `${cube.points.length / 3}`
  )
  check('and it is already closed', isManifold(cube))
  check('one solid', shells(cube).length === 1, `${shells(cube).length}`)
  // The whole reason `flatFaces` exists. Twelve triangles are six faces, and a
  // file that says twelve is one where every flat face arrives pre-shattered.
  const cubeFaces = flatFaces(cube, shells(cube)[0])
  check('twelve triangles are six faces', cubeFaces.length === 6, `${cubeFaces.length}`)
  check(
    'each bounded by one loop of four edges',
    cubeFaces.every((f) => f.loops.length === 1 && f.loops[0].length === 4),
    cubeFaces.map((f) => f.loops[0].length).join(',')
  )
  plain.dispose()

  resetEvaluator()
  const pair = exportGeometry(
    scene(
      object({ kind: 'box', size: [2, 2, 2] }, [], [-3, 0, 0], 'left'),
      object({ kind: 'box', size: [2, 2, 2] }, [], [3, 0, 0], 'right')
    )
  )
  const twoShells = shells(indexByPosition(pair)).length
  check('two objects are two shells', twoShells === 2, `${twoShells}`)
  pair.dispose()

  // The case the repair exists for. A boolean retriangulates the face its tool
  // touched and leaves the neighbours alone, so along every shared edge one
  // side is a single long edge and the other a chain of short ones. Invisible
  // in a mesh format; fatal to a solid.
  resetEvaluator()
  const bossed = exportGeometry(CUBE_WITH_BOSS)
  const raw = indexByPosition(bossed)
  check('a boolean leaves the mesh cracked', !isManifold(raw))
  const healed = healTJunctions(raw)
  check('and the repair closes it', isManifold(healed.mesh))
  check('by splitting edges, not by moving anything', healed.split > 0, `${healed.split} points`)
  // Nothing may be added to or taken from the solid on the way. A repair that
  // nudged a vertex to close a crack would still produce a file that opens, and
  // would be a different part.
  //
  // Not to the last bit, and it could not be: closing a crack means adopting
  // the neighbour's vertex, which sits within a weld tolerance of this edge
  // rather than exactly on it. The measured shift is around 1e-8 on a solid of
  // volume 8 -- a hundredth of what float32 can even represent at that size --
  // where a vertex genuinely dragged somewhere would move it by thousandths.
  near('the repair closes cracks without moving the surface', meshVolume(healed.mesh), meshVolume(raw), 1e-6)
  near('and matches what was exported', meshVolume(healed.mesh), signedVolume(bossed), 1e-6)
  bossed.dispose()

  // A curved surface must NOT collapse. The flood fill measures every candidate
  // against the seed triangle's plane rather than its neighbour's for exactly
  // this reason: compared neighbour to neighbour the plane drifts a little at
  // each step, and a sphere is nothing but a great many little steps.
  resetEvaluator()
  const ball = exportGeometry(scene(object({ kind: 'sphere', radius: 1 })))
  const sphere = indexByPosition(ball)
  const round = flatFaces(sphere, shells(sphere)[0])
  check('a sphere keeps its facets rather than flattening', round.length > 100, `${round.length} faces`)
  ball.dispose()
}

// --- 9. STEP output --------------------------------------------------------
console.log('\n9. STEP output')
{
  /**
   * Ids must be unique, and every reference in the file has to land on one that
   * exists. A dangling reference is the one error that makes a STEP file open
   * as nothing at all, with no useful message.
   */
  const audit = (text: string) => {
    const lines = text.split('\n')
    const defined = new Set<number>()
    let duplicated = 0
    for (const line of lines) {
      const at = /^#(\d+)=/.exec(line)
      if (!at) continue
      const id = Number(at[1])
      if (defined.has(id)) duplicated++
      defined.add(id)
    }
    let dangling = 0
    for (const line of lines) {
      const split = line.indexOf('=')
      if (!line.startsWith('#') || split < 0) continue
      for (const ref of line.slice(split).match(/#(\d+)/g) ?? []) {
        if (!defined.has(Number(ref.slice(1)))) dangling++
      }
    }
    return { defined, duplicated, dangling }
  }

  resetEvaluator()
  const geometry = exportGeometry(CUBE_WITH_BOSS)
  const { blob, detail } = await buildExportBlob(geometry, 'step', STAMP)
  const text = await blob.text()

  check('it is an ISO 10303-21 exchange file', text.startsWith('ISO-10303-21;'), text.slice(0, 20))
  check('and it is terminated', text.trimEnd().endsWith('END-ISO-10303-21;'))
  check('the header names a schema', text.includes("FILE_SCHEMA(('AUTOMOTIVE_DESIGN"))
  check(
    'and both sections are closed',
    occurrencesOf(text, 'ENDSEC;') === 2,
    `${occurrencesOf(text, 'ENDSEC;')}`
  )
  check('no NaN reached the file', !text.includes('NaN'))
  // A STEP real must carry a decimal point. A bare integer among the
  // coordinates is the easiest way to write a file every reader rejects.
  check('every coordinate is written as a real', !/\(-?\d+,/.test(text))

  const { defined, duplicated, dangling } = audit(text)
  check('every entity id is unique', duplicated === 0, `${duplicated} repeated`)
  check('and every reference resolves', dangling === 0, `${dangling} dangling`)
  check('the file is not trivial', defined.size > 500, `${defined.size} entities`)

  // The load-bearing check, and the reason `brep.ts` exists at all. In a solid,
  // every edge is walked by exactly two faces, once in each direction. Any
  // other count and the file describes faces that merely touch -- which opens
  // as a heap of surfaces rather than as a body that can be cut or measured.
  const orientations = new Map<string, string[]>()
  for (const line of text.split('\n')) {
    const at = /ORIENTED_EDGE\('',\*,\*,(#\d+),\.(T|F)\.\)/.exec(line)
    if (!at) continue
    const list = orientations.get(at[1])
    if (list) list.push(at[2])
    else orientations.set(at[1], [at[2]])
  }
  const curves = occurrencesOf(text, '=EDGE_CURVE(')
  check('every edge belongs to two faces', [...orientations.values()].every((o) => o.length === 2))
  check(
    'and they walk it in opposite directions',
    [...orientations.values()].every((o) => o.length === 2 && o[0] !== o[1])
  )
  check(
    'with no edge left unused',
    orientations.size === curves,
    `${orientations.size} used of ${curves}`
  )

  check('the body is a solid, not a surface model', text.includes('MANIFOLD_SOLID_BREP'))
  check('inside a B-rep shape representation', text.includes('ADVANCED_BREP_SHAPE_REPRESENTATION'))
  check('reachable from a product definition', text.includes('SHAPE_DEFINITION_REPRESENTATION'))
  check('and the receipt reports what it built', /^1 solid/.test(String(detail)), String(detail))

  // Same solid, same stamp, same bytes -- which is what makes a file diffable,
  // and this suite able to compare one against another at all.
  const again = await buildExportBlob(geometry, 'step', STAMP)
  check('the same solid writes the same file', (await again.blob.text()) === text)
  geometry.dispose()
}

{
  // A hole has to survive as a HOLE. Drilled through, the top and bottom faces
  // are each one face carrying an inner boundary -- not a ring of loose
  // triangles, and not a face with the middle quietly filled in.
  resetEvaluator()
  const pocket: Feature = { ...CIRCLE_BOSS, id: 'pocket', depth: -3 }
  const geometry = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] }, [pocket])))
  const text = await (await buildExportBlob(geometry, 'step', STAMP)).blob.text()
  const withHoles = (text.match(/ADVANCED_FACE\('',\(#\d+,#\d+/g) ?? []).length
  check('a drilled solid has faces with holes in them', withHoles === 2, `${withHoles} faces`)
  check('the holes are inner bounds', text.includes('FACE_BOUND('))
  check('and the outer boundaries stay outer', text.includes('FACE_OUTER_BOUND('))
  geometry.dispose()
}

{
  // Two objects are two bodies. One closed shell wrapped round two disjoint
  // lumps is not a solid, and the stricter readers say so.
  resetEvaluator()
  const geometry = exportGeometry(
    scene(
      object({ kind: 'box', size: [2, 2, 2] }, [], [-3, 0, 0], 'left'),
      object({ kind: 'sphere', radius: 1 }, [], [3, 0, 0], 'right')
    )
  )
  const { blob, detail } = await buildExportBlob(geometry, 'step', STAMP)
  const text = await blob.text()
  check(
    'two objects export as two solid bodies',
    occurrencesOf(text, '=MANIFOLD_SOLID_BREP(') === 2,
    `${occurrencesOf(text, '=MANIFOLD_SOLID_BREP(')}`
  )
  check('each in its own closed shell', occurrencesOf(text, '=CLOSED_SHELL(') === 2)
  check('and the receipt says so', String(detail).startsWith('2 solids'), String(detail))
  geometry.dispose()
}

{
  // An eraser is a solid the user has AIMED and not yet taken. It is a
  // translucent red ghost standing for material that is about to go, and
  // writing it into a file would export the tool along with the work.
  resetEvaluator()
  const solidOnly = exportGeometry(scene(object({ kind: 'box', size: [2, 2, 2] })))
  const expected = signedVolume(solidOnly)
  solidOnly.dispose()

  resetEvaluator()
  const withGhost = exportGeometry({
    objects: [
      object({ kind: 'box', size: [2, 2, 2] }, [], [0, 0, 0], 'solid'),
      { ...object({ kind: 'sphere', radius: 1 }, [], [0.5, 0, 0], 'ghost'), erase: true },
    ],
  })
  near('an eraser in the scene is left out of the file', signedVolume(withGhost), expected, 1e-6)
  withGhost.dispose()
}

// --- 6. Empty guard --------------------------------------------------------
console.log('\n6. Refuses to export nothing')
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
