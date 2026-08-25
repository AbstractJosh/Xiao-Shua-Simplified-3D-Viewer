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

import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { buildExportBlob } from '../src/geometry/exporters'
import type { Doc } from '../src/geometry/types'
import type { ExportFormat } from '../src/geometry/exporters'
import { APP_SLUG } from '../src/appInfo'

const outDir = resolve(process.argv[2] ?? join(process.cwd(), 'samples'))
mkdirSync(outDir, { recursive: true })

const SAMPLES: { name: string; format: ExportFormat; doc: Doc }[] = [
  {
    // The distinctive case: a square boss on a sphere. Its top must be a
    // curved patch concentric with the sphere, and its walls must converge
    // toward the centre -- visible immediately in any 3D viewer.
    name: `${APP_SLUG}-sphere-curved-boss`,
    format: 'glb',
    doc: {
      base: { kind: 'sphere', radius: 1.2 },
      features: [
        {
          id: 'boss',
          anchor: { on: 'sphere', theta: 0, phi: Math.PI / 2 },
          shape: { type: 'rect', w: 0.7, h: 0.7 },
          rotation: 0,
          op: 'extrude',
          depth: 0.3,
          enabled: true,
        },
        {
          id: 'pocket',
          anchor: { on: 'sphere', theta: Math.PI, phi: Math.PI / 2 },
          shape: { type: 'circle', r: 0.45 },
          rotation: 0,
          op: 'intrude',
          depth: 0.3,
          enabled: true,
        },
      ],
    },
  },
  {
    name: `${APP_SLUG}-cube-boss-and-pocket`,
    format: 'glb',
    doc: {
      base: { kind: 'box', size: [2, 2, 2] },
      features: [
        {
          id: 'boss',
          anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
          shape: { type: 'circle', r: 0.35 },
          rotation: 0,
          op: 'extrude',
          depth: 0.35,
          enabled: true,
        },
        {
          id: 'hex',
          anchor: { on: 'box-face', face: 4, u: 0.35, v: -0.2 },
          shape: { type: 'ngon', r: 0.3, sides: 6 },
          rotation: 0,
          op: 'intrude',
          depth: 0.4,
          enabled: true,
        },
        {
          id: 'bore',
          anchor: { on: 'box-face', face: 0, u: -0.4, v: 0.4 },
          shape: { type: 'circle', r: 0.2 },
          rotation: 0,
          op: 'intrude',
          depth: 2.5,
          enabled: true,
        },
      ],
    },
  },
  {
    name: `${APP_SLUG}-cube-boss-and-pocket`,
    format: 'obj',
    doc: {
      base: { kind: 'box', size: [2, 2, 2] },
      features: [
        {
          id: 'boss',
          anchor: { on: 'box-face', face: 2, u: 0, v: 0 },
          shape: { type: 'circle', r: 0.35 },
          rotation: 0,
          op: 'extrude',
          depth: 0.35,
          enabled: true,
        },
        {
          id: 'hex',
          anchor: { on: 'box-face', face: 4, u: 0.35, v: -0.2 },
          shape: { type: 'ngon', r: 0.3, sides: 6 },
          rotation: 0,
          op: 'intrude',
          depth: 0.4,
          enabled: true,
        },
      ],
    },
  },
]

for (const { name, format, doc } of SAMPLES) {
  resetEvaluator()
  const { geometry, failed } = evaluateDoc(doc)
  const { blob, triangles, vertices } = await buildExportBlob(geometry, format)
  const buf = Buffer.from(await blob.arrayBuffer())
  const file = join(outDir, `${name}.${format}`)
  writeFileSync(file, buf)
  console.log(
    `${file}\n  ${(buf.length / 1024).toFixed(1)} KB · ${triangles.toLocaleString()} tris · ` +
      `${vertices.toLocaleString()} verts${failed.length ? ` · FAILED: ${failed.join(',')}` : ''}`
  )
}

console.log(`\nWrote ${SAMPLES.length} sample(s) to ${outDir}\n`)
