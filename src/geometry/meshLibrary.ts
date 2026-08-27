import { Box3, BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three'
import type { Vec3 } from './types'

/**
 * Where the triangles of an IMPORTED model live.
 *
 * Everything else the app draws is derived from a `Doc` -- a box is three
 * numbers, a dodecahedron is one -- and that is what makes the document cheap
 * to diff, cheap to clone and cheap to key the evaluator's prefix cache on. An
 * imported model is the one thing that cannot be written down that way: it is a
 * hundred thousand vertices that no formula produces.
 *
 * So the vertices stay HERE and the document holds a ticket. A `mesh` base is
 * `{ meshId, size }`, which is six numbers and a short string -- diffable,
 * clonable and stringifiable exactly like every other base, and small enough
 * that `slotKeys` can go on JSON-stringifying it once per evaluation without
 * anybody noticing. Put the vertices in the document instead and every
 * keystroke in the Size field would stringify a megabyte.
 *
 * Nothing is ever evicted. An entry has to outlive the document that points at
 * it, and undo history points at it too: rewinding past an import must bring
 * the model back, not a hole. The cost is bounded by what the user imports in
 * one session, which is the same bound the undo stack already carries.
 */

/**
 * A model as it was read out of a file, normalised so that `size` is the only
 * thing that decides how big it is.
 */
export type MeshEntry = {
  id: string
  /** What the file called itself. Seeds the object's name. */
  label: string
  /**
   * The triangles, CENTRED ON THE LOCAL ORIGIN and scaled so the bounding box
   * is exactly one unit on every axis.
   *
   * Normalised rather than kept at the size the file described, because that is
   * what lets a `mesh` base behave like a `box` base everywhere else: `size`
   * multiplies straight through, `bounds()` is half of it, and the gizmo's
   * arrows and the Width/Height/Depth fields need no special case. An imported
   * model is the one primitive whose three extents are genuinely independent,
   * which is exactly what a box already is.
   *
   * NEVER HANDED OUT. `meshGeometry` returns a scaled copy, because a consumer
   * that disposed this would take every object built on the model with it.
   */
  geometry: BufferGeometry
  /**
   * The size the file actually described, in scene units -- one unit being ten
   * centimetres, the same as everywhere else.
   *
   * An imported model lands at this size, so it arrives the shape it was drawn
   * at rather than stretched to a cube.
   */
  natural: Vec3
  triangles: number
}

const entries = new Map<string, MeshEntry>()
let counter = 0

/**
 * An axis this thin does not survive being normalised: dividing by it would
 * send the other two to infinity.
 *
 * A flat model -- a plate, a laser-cut profile, a single face exported on its
 * own -- genuinely has one, and it stays flat: the coordinates on that axis are
 * already zero once the mesh is centred, so any `size` at all reproduces it.
 */
const FLAT_EPS = 1e-9

/** Zero triangles, with the attributes every consumer expects to find. */
function emptyGeometry(): BufferGeometry {
  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(new Float32Array(0), 3))
  geom.setAttribute('normal', new BufferAttribute(new Float32Array(0), 3))
  return geom
}

/**
 * Put a model on the shelf and hand back the entry the document will point at.
 *
 * The geometry passed in is CONSUMED: it is normalised in place and kept, so
 * the caller must not dispose it or go on drawing it. Importers build a
 * geometry for exactly this and have no other use for it.
 */
export function registerMesh(geometry: BufferGeometry, label: string): MeshEntry {
  const position = geometry.getAttribute('position')
  const count = position ? position.count : 0

  if (count === 0) {
    counter += 1
    const id = `m${counter}`
    const entry: MeshEntry = {
      id,
      label,
      geometry: emptyGeometry(),
      natural: [1, 1, 1],
      triangles: 0,
    }
    geometry.dispose()
    entries.set(id, entry)
    return entry
  }

  const box = new Box3().setFromBufferAttribute(position as BufferAttribute)
  const centre = box.getCenter(new Vector3())
  const span = box.getSize(new Vector3())
  const natural: Vec3 = [span.x, span.y, span.z]

  // Centre first, then divide each axis by its own extent. Two steps rather
  // than one matrix because the divisor is per axis and a flat axis has none:
  // its coordinates are all zero after the centring, and scaling them by 1
  // leaves them there.
  geometry.applyMatrix4(new Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z))
  geometry.applyMatrix4(
    new Matrix4().makeScale(
      span.x > FLAT_EPS ? 1 / span.x : 1,
      span.y > FLAT_EPS ? 1 / span.y : 1,
      span.z > FLAT_EPS ? 1 / span.z : 1
    )
  )

  counter += 1
  const id = `m${counter}`
  const index = geometry.getIndex()
  const entry: MeshEntry = {
    id,
    label,
    geometry,
    natural,
    triangles: Math.floor((index ? index.count : count) / 3),
  }
  entries.set(id, entry)
  return entry
}

export function meshEntry(id: string): MeshEntry | undefined {
  return entries.get(id)
}

/**
 * The model at a given size, as a geometry the CALLER OWNS.
 *
 * A fresh copy every time. The evaluator turns it straight into a brush and
 * disposes it, and the shelf's own copy has to survive that -- it is the only
 * one there is.
 *
 * Throws for an id nobody registered. `baseBrush` catches it and flags the one
 * object, which is the right blast radius: a dangling ticket is a bug, and
 * quietly drawing an empty box in its place would hide it.
 */
export function meshGeometry(id: string, size: Vec3): BufferGeometry {
  const entry = entries.get(id)
  if (!entry) throw new Error(`No imported model ${id}`)
  const copy = entry.geometry.clone()
  copy.applyMatrix4(new Matrix4().makeScale(size[0], size[1], size[2]))
  return copy
}

/** For the check suite, which builds a fresh shelf per run. */
export function forgetMeshes(): void {
  for (const entry of entries.values()) entry.geometry.dispose()
  entries.clear()
}
