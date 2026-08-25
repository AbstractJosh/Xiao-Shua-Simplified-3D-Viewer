import { Mesh, MeshStandardMaterial } from 'three'
import type { BufferGeometry } from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

export type ExportFormat = 'glb' | 'obj'

export type ExportResult = {
  filename: string
  bytes: number
  triangles: number
  vertices: number
  /** False when welding was skipped, so the caller can stay honest about it. */
  welded: boolean
}

const MODEL_NAME = 'EZ3D_Model'

export const FORMAT_INFO: Record<ExportFormat, { label: string; mime: string; ext: string }> = {
  glb: { label: 'GLB', mime: 'model/gltf-binary', ext: 'glb' },
  obj: { label: 'OBJ', mime: 'model/obj', ext: 'obj' },
}

export function triangleCount(geom: BufferGeometry): number {
  const index = geom.getIndex()
  return Math.round((index ? index.count : geom.getAttribute('position').count) / 3)
}

/**
 * Boolean results come out of the evaluator as non-indexed triangle soup: every
 * triangle carries its own three vertices, so a cube face exports as six loose
 * corners rather than four shared ones. Importers accept that, but the mesh
 * arrives in Blender needing a Merge by Distance before it is editable.
 *
 * `mergeVertices` compares every attribute, not just position, so vertices are
 * welded across a flat face (identical normals) while hard edges survive
 * intact (differing normals). Welding is best-effort -- a failure here should
 * cost file size, never the export itself.
 */
export function prepareForExport(geometry: BufferGeometry): {
  geom: BufferGeometry
  welded: boolean
} {
  let geom: BufferGeometry | null = null
  let welded = false

  try {
    const merged = mergeVertices(geometry)
    // Guard against a degenerate merge throwing geometry away.
    if (triangleCount(merged) === triangleCount(geometry)) {
      geom = merged
      welded = true
    } else {
      merged.dispose()
    }
  } catch (err) {
    console.warn('[EZ3D] vertex welding skipped', err)
  }

  // Always hand back a geometry we own, so the caller can normalise and
  // dispose it freely without touching the copy that is still on screen.
  if (!geom) geom = geometry.clone()

  // Booleans interpolate vertex normals along every cut edge, and a blend of
  // two unit vectors is shorter than either. Left alone, importers either
  // repair it themselves or shade the seams subtly wrong.
  geom.normalizeNormals()

  return { geom, welded }
}

/**
 * Serialise the current solid. Returns the blob rather than downloading it, so
 * the encoding is testable without a DOM.
 */
export async function buildExportBlob(
  geometry: BufferGeometry,
  format: ExportFormat
): Promise<{ blob: Blob; triangles: number; vertices: number; welded: boolean }> {
  if (triangleCount(geometry) === 0) {
    throw new Error('Nothing to export: the solid is empty.')
  }

  const { geom, welded } = prepareForExport(geometry)
  const material = new MeshStandardMaterial({
    color: 0x9aa3b4,
    metalness: 0.15,
    roughness: 0.55,
  })
  const mesh = new Mesh(geom, material)
  mesh.name = MODEL_NAME
  mesh.updateMatrixWorld(true)

  try {
    const stats = {
      triangles: triangleCount(geom),
      vertices: geom.getAttribute('position').count,
      welded,
    }

    if (format === 'obj') {
      const text = new OBJExporter().parse(mesh)
      return { blob: new Blob([text], { type: FORMAT_INFO.obj.mime }), ...stats }
    }

    const gltf = await new GLTFExporter().parseAsync(mesh, { binary: true })
    if (!(gltf instanceof ArrayBuffer)) {
      throw new Error('GLTFExporter did not return binary output')
    }
    return { blob: new Blob([gltf], { type: FORMAT_INFO.glb.mime }), ...stats }
  } finally {
    material.dispose()
    // `prepareForExport` always returns a copy, so this never touches the
    // geometry the evaluator has cached and the viewport is still drawing.
    geom.dispose()
  }
}

/** Hand the blob to the browser as a file. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function exportSolid(
  geometry: BufferGeometry,
  format: ExportFormat,
  baseName: string
): Promise<ExportResult> {
  const { blob, triangles, vertices, welded } = await buildExportBlob(geometry, format)
  const filename = `${baseName}.${FORMAT_INFO[format].ext}`
  downloadBlob(blob, filename)
  return { filename, bytes: blob.size, triangles, vertices, welded }
}
