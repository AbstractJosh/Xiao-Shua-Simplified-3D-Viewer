import { BufferAttribute, BufferGeometry, Mesh, Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { normalizeGeometry } from './brush'
import { MAX_SIZE, MIN_DIMENSION } from './dimensions'
import { parseStep } from './stepImport'
import { FORMAT_INFO } from './exporters'
import type { ExportFormat } from './exporters'
import type { Vec3 } from './types'

/**
 * Reading a model back in.
 *
 * The formats are EXACTLY the ones `exporters.ts` writes, which is the whole
 * design rule here: anything the app can hand you, it can take back. That makes
 * the export bar a save button in everything but name -- work, export, come
 * back tomorrow, import, keep working -- and it is why this file has no format
 * of its own and no list of its own. `ExportFormat` is the list.
 *
 * What comes back is TRIANGLES, not the document that produced them. A .glb has
 * no idea that a solid was once a cylinder with two sketches on it, and neither
 * has a .step: both describe a finished surface. So an import lands as a `mesh`
 * base -- one solid, sized, moved, cut, coloured and merged like any other, but
 * without the parametric history it never carried in the file. That is not a
 * shortcut; it is what the file says.
 */

/** Same four the export menu offers. `.stp` is `.step` under its other name. */
export type ImportFormat = ExportFormat

/** What the file picker will let through. */
export const IMPORT_ACCEPT = '.glb,.obj,.stl,.step,.stp'

export type ImportedModel = {
  /** Triangles in SCENE UNITS, ready to be handed to `registerMesh`. */
  geometry: BufferGeometry
  /** What to call the object: the file's own name, without its extension. */
  label: string
  format: ImportFormat
  triangles: number
  /** Anything the format wants to say for itself; STEP reports its faces. */
  detail?: string
}

/**
 * Which reader a filename asks for, or null for one nothing here can open.
 *
 * By extension, not by sniffing the bytes. Two of the four are plain text and
 * one of those -- OBJ -- has no magic number at all, so the name is the only
 * thing that can tell an OBJ from a STEP without guessing.
 */
export function formatOf(filename: string): ImportFormat | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filename.slice(dot + 1).toLowerCase()
  if (ext === 'stp') return 'step'
  const known = (Object.keys(FORMAT_INFO) as ImportFormat[]).find(
    (format) => FORMAT_INFO[format].ext === ext
  )
  return known ?? null
}

/** The filename without its extension, which is what the object gets called. */
function labelOf(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const name = filename.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'Model'
}

function triangleCount(geom: BufferGeometry): number {
  const position = geom.getAttribute('position')
  if (!position) return 0
  const index = geom.getIndex()
  return Math.floor((index ? index.count : position.count) / 3)
}

/**
 * Every mesh under a loaded scene, baked through its own world matrix and
 * concatenated into one geometry.
 *
 * A .glb or .obj is a TREE -- meshes inside groups inside a scene, each with
 * its own transform -- and an imported model here is one solid. So the tree is
 * flattened the same way `mergedGeometry` flattens the document for export:
 * every mesh through its matrix, position and normal only, nothing indexed.
 *
 * The scene's own transform is included, which matters for glTF: the format is
 * Y-up like this app, but a scene node may still carry a rotation, and a model
 * that arrived lying on its side because the root node was ignored would be a
 * bug nobody could find from the file.
 */
function flatten(root: Object3D): BufferGeometry {
  root.updateMatrixWorld(true)

  const parts: BufferGeometry[] = []
  root.traverse((node) => {
    if (!(node instanceof Mesh) || !node.geometry) return
    const geom: BufferGeometry = node.geometry
    const copy = geom.getIndex() ? geom.toNonIndexed() : geom.clone()
    normalizeGeometry(copy)
    copy.applyMatrix4(node.matrixWorld)
    parts.push(copy)
  })

  if (parts.length === 0) throw new Error('No meshes in this file.')
  if (parts.length === 1) return parts[0]

  let vertices = 0
  for (const part of parts) vertices += part.getAttribute('position').count

  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  let offset = 0
  for (const part of parts) {
    const p = part.getAttribute('position')
    const n = part.getAttribute('normal')
    position.set(p.array as ArrayLike<number>, offset)
    normal.set(n.array as ArrayLike<number>, offset)
    offset += p.count * 3
    part.dispose()
  }

  const merged = new BufferGeometry()
  merged.setAttribute('position', new BufferAttribute(position, 3))
  merged.setAttribute('normal', new BufferAttribute(normal, 3))
  return merged
}

const decoder = new TextDecoder()

/**
 * Read one file into a geometry.
 *
 * `data` is the whole file. Two of the four readers want text and two want
 * bytes, so the caller reads it once as an ArrayBuffer and this decodes where
 * it has to -- rather than every call site having to know which is which.
 *
 * THE COORDINATES ARE TAKEN AS SCENE UNITS for the three mesh formats, because
 * that is exactly how `exporters.ts` writes them: no conversion out, none back.
 * STEP is the exception, and it is not a special case so much as the format
 * being honest -- a STEP file DECLARES its unit, and `stepImport` reads the
 * declaration rather than assuming the one this app happens to write.
 */
export async function importModel(
  data: ArrayBuffer,
  filename: string
): Promise<ImportedModel> {
  const format = formatOf(filename)
  if (!format) {
    throw new Error(`Cannot read ${filename}: only GLB, OBJ, STL and STEP files.`)
  }
  const label = labelOf(filename)

  let geometry: BufferGeometry
  let detail: string | undefined

  if (format === 'glb') {
    // Path '' rather than a URL: a .glb has every buffer and texture inside it,
    // so nothing is ever resolved relative to anything. (A .gltf would resolve
    // external files over the network, which is why only .glb is offered.)
    const gltf = await new GLTFLoader().parseAsync(data, '')
    geometry = flatten(gltf.scene)
  } else if (format === 'obj') {
    geometry = flatten(new OBJLoader().parse(decoder.decode(data)))
  } else if (format === 'stl') {
    // The one loader that hands back a geometry rather than a scene: STL has no
    // hierarchy and no transforms, only triangles.
    geometry = normalizeGeometry(new STLLoader().parse(data))
  } else {
    const step = parseStep(decoder.decode(data))
    geometry = step.geometry
    // A STEP file is topology, not triangles, so the count that means anything
    // to someone looking at it is faces -- and what was left out is part of the
    // same sentence rather than a warning to be found later.
    detail =
      `${step.faces.toLocaleString()} face${step.faces === 1 ? '' : 's'}` +
      (step.skipped > 0 ? ` · ${step.skipped} curved faces skipped` : '')
  }

  const triangles = triangleCount(geometry)
  if (triangles === 0) {
    geometry.dispose()
    throw new Error('Nothing to import: the file holds no triangles.')
  }

  return { geometry, label, format, triangles, detail }
}

/**
 * The size an imported model lands at: the size the file describes, unless that
 * puts it outside the range the app can work in.
 *
 * There IS a range, and it is not a matter of taste. `dimensions.ts` fixes the
 * world at fifty units across -- five metres -- because that is as far as
 * float32 stays fine enough for the B-rep layer to weld a solid back together;
 * and at a millimetre across, the other end, a solid is smaller than the
 * tolerance the same layer works to. A file knows nothing about either. An STL
 * whose author worked in millimetres and never said so arrives two hundred
 * metres wide, and dropped in at face value it would be an object nobody could
 * see, size or export.
 *
 * So a model outside the range is scaled UNIFORMLY to fit -- proportions are
 * the one thing about an import that must survive -- and the caller says so in
 * the receipt, because a model that is not the size the file said is exactly
 * the kind of thing to find out about now rather than later.
 *
 * The floor is per axis and separate: a flat model -- a plate, a profile, one
 * face on its own -- genuinely has an extent of zero on one axis, and its
 * `size` there stands for nothing at all once the geometry is normalised.
 */
export function fitToEnvelope(natural: Vec3): { size: Vec3; factor: number } {
  const longest = Math.max(natural[0], natural[1], natural[2])

  let factor = 1
  if (longest > MAX_SIZE) factor = MAX_SIZE / longest
  // Below a millimetre the fields cannot even write the number down. Landing it
  // at one unit puts it at the size a cube off the palette arrives at, which is
  // the one size in the app that means "here, look at this".
  else if (longest > 0 && longest < MIN_DIMENSION) factor = 1 / longest

  const clamp = (v: number) => Math.min(MAX_SIZE, Math.max(MIN_DIMENSION, v * factor))
  return { size: [clamp(natural[0]), clamp(natural[1]), clamp(natural[2])], factor }
}
