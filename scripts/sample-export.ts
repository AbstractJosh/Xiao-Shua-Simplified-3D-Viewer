/**
 * Writes sample exports to disk so the output can be opened in a real 3D tool.
 *
 * Run: npx tsx scripts/sample-export.ts [outputDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// GLTFExporter marshals its binary chunk through FileReader, which browsers
// provide natively but Node does not expose. The app never relies on this.
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
      blob.arrayBuffer().then((buf) => {
        this.result = buf
        this.finish()
      }, (e) => this.onerror?.(e))
    }
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`
        this.finish()
      }, (e) => this.onerror?.(e))
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
import { splitPlanes } from '../src/geometry/cut'
import { IDENTITY_TRANSFORM } from '../src/geometry/types'
import type { BaseSolid, Doc, Feature, SceneObject, Vec3 } from '../src/geometry/types'
import type { ExportFormat } from '../src/geometry/exporters'
import { APP_SLUG } from '../src/appInfo'

const outDir = resolve(process.argv[2] ?? join(process.cwd(), 'samples'))
mkdirSync(outDir, { recursive: true })

let counter = 0
function object(
  base: BaseSolid,
  opts: { at?: Vec3; turn?: Vec3; features?: Feature[]; cut?: 'keep+' | 'keep-' } = {}
): SceneObject {
  counter += 1
  const cuts =
    opts.cut === undefined
      ? []
      : [splitPlanes([0, 0, 0], [1, 0, 0])[opts.cut === 'keep+' ? 0 : 1]]
  return {
    id: `s${counter}`,
    name: `s${counter}`,
    base,
    transform: {
      position: opts.at ?? IDENTITY_TRANSFORM.position,
      rotation: opts.turn ?? IDENTITY_TRANSFORM.rotation,
    },
    features: opts.features ?? [],
    cuts,
  }
}

let featureCounter = 0
function sketch(over: Partial<Feature> & { anchor: Feature['anchor'] }): Feature {
  featureCounter += 1
  return {
    id: `k${featureCounter}`,
    shape: { type: 'circle', r: 0.3 },
    rotation: 0,
    op: 'extrude',
    depth: 0.3,
    enabled: true,
    tilt: [0, 0, 0],
    faceOffset: [0, 0],
    ...over,
  }
}

const SAMPLES: { name: string; format: ExportFormat; doc: Doc }[] = [
  {
    // The distinctive case: a square boss on a sphere. Its top must be a
    // curved patch concentric with the sphere, and its walls must converge
    // toward the centre -- visible immediately in any 3D viewer.
    name: `${APP_SLUG}-sphere-curved-boss`,
    format: 'glb',
    doc: {
      objects: [
        object(
          { kind: 'sphere', radius: 1.2 },
          {
            features: [
              sketch({
                anchor: { on: 'sphere', theta: 0, phi: Math.PI / 2 },
                shape: { type: 'rect', w: 0.7, h: 0.7 },
                op: 'extrude',
                depth: 0.3,
              }),
              sketch({
                anchor: { on: 'sphere', theta: Math.PI, phi: Math.PI / 2 },
                shape: { type: 'circle', r: 0.45 },
                op: 'intrude',
                depth: 0.3,
              }),
            ],
          }
        ),
      ],
    },
  },
  {
    name: `${APP_SLUG}-cube-boss-and-pocket`,
    format: 'glb',
    doc: {
      objects: [
        object(
          { kind: 'box', size: [2, 2, 2] },
          {
            features: [
              sketch({
                anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
                shape: { type: 'circle', r: 0.35 },
                op: 'extrude',
                depth: 0.35,
              }),
              sketch({
                anchor: { on: 'box-face', face: 4, u: 0.35, v: -0.2 },
                shape: { type: 'ngon', r: 0.3, sides: 6 },
                op: 'intrude',
                depth: 0.4,
              }),
              sketch({
                anchor: { on: 'box-face', face: 0, u: -0.4, v: 0.4 },
                shape: { type: 'circle', r: 0.2 },
                op: 'intrude',
                depth: 2.5,
              }),
            ],
          }
        ),
      ],
    },
  },
  {
    name: `${APP_SLUG}-cube-boss-and-pocket`,
    format: 'obj',
    doc: {
      objects: [
        object(
          { kind: 'box', size: [2, 2, 2] },
          {
            features: [
              sketch({
                anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
                shape: { type: 'circle', r: 0.35 },
                op: 'extrude',
                depth: 0.35,
              }),
              sketch({
                anchor: { on: 'box-face', face: 4, u: 0.35, v: -0.2 },
                shape: { type: 'ngon', r: 0.3, sides: 6 },
                op: 'intrude',
                depth: 0.4,
              }),
            ],
          }
        ),
      ],
    },
  },
  {
    // What the single-solid samples above cannot show: several primitives
    // placed on the ground, one leaning boss, and a cube kept as one half of a
    // cut. Everything here is baked through its own transform on export.
    name: `${APP_SLUG}-scene`,
    format: 'glb',
    doc: {
      objects: [
        object({ kind: 'box', size: [2, 2, 2] }, {
          at: [-3.2, 1, 0],
          cut: 'keep+',
        }),
        object({ kind: 'cylinder', radius: 0.8, height: 2 }, {
          at: [0, 1, 0],
          features: [
            sketch({
              anchor: { on: 'cylinder', theta: 0, y: 0.2 },
              shape: { type: 'circle', r: 0.3 },
              op: 'intrude',
              depth: 0.35,
            }),
          ],
        }),
        object({ kind: 'prism', radius: 0.9, height: 1.8, sides: 6 }, {
          at: [3, 0.9, 0],
          features: [
            // A leaning pillar: the base stays welded to the cap, the created
            // face is tilted and slid clear of it.
            sketch({
              anchor: { on: 'planar-face', face: 0, u: 0, v: 0 },
              shape: { type: 'ngon', r: 0.35, sides: 6 },
              op: 'extrude',
              depth: 0.8,
              tilt: [0, 0, Math.PI / 9],
              faceOffset: [0.35, 0],
            }),
          ],
        }),
        object({ kind: 'platonic', solid: 'dodecahedron', radius: 1.1 }, {
          at: [0, 1.05, -3.2],
          turn: [0, Math.PI / 7, 0],
        }),
      ],
    },
  },
]

for (const { name, format, doc } of SAMPLES) {
  resetEvaluator()
  const result = evaluateDoc(doc)
  const geometry = mergedGeometry(doc, result)
  const { blob, triangles, vertices } = await buildExportBlob(geometry, format)
  geometry.dispose()
  const buf = Buffer.from(await blob.arrayBuffer())
  const file = join(outDir, `${name}.${format}`)
  writeFileSync(file, buf)
  console.log(
    `${file}\n  ${(buf.length / 1024).toFixed(1)} KB - ${doc.objects.length} object(s) - ` +
      `${triangles.toLocaleString()} tris - ${vertices.toLocaleString()} verts` +
      `${result.failed.length ? ` - FAILED: ${result.failed.join(',')}` : ''}`
  )
}

console.log(`\nWrote ${SAMPLES.length} sample(s) to ${outDir}\n`)
