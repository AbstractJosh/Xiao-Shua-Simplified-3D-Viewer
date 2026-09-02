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

/**
 * Reflections already on the shelf, keyed `sourceId:axis`.
 *
 * Not an optimisation. Mirroring a model twice along the same axis has to hand
 * back the model, not a third copy of it that merely looks like one -- a user
 * flipping a part to compare the two ways round would otherwise leave a new
 * entry on the shelf on every press, and undo would rewind past tickets that
 * stayed registered forever. Both directions are recorded, so the second flip
 * finds the original by the same lookup the first one filled in.
 */
const reflections = new Map<string, string>()

/**
 * The model reflected in one of its own axis planes, as a ticket for the shelf.
 *
 * The one primitive a mirror cannot leave alone. Every other base here is a
 * handful of numbers describing something symmetric enough that the reflection
 * can be absorbed by choosing which plane to use -- see `mirrorNormal` -- but a
 * model off a file is whatever it is, so the triangles themselves are flipped.
 *
 * WINDING IS REVERSED with the coordinate, and that is not optional: a
 * reflection turns every triangle inside out, and a solid whose faces all point
 * inward is one the boolean will happily subtract the whole world from. The
 * normals are recomputed rather than reflected for the same reason -- they have
 * to agree with the winding that is now there.
 *
 * The entry stays normalised the way `registerMesh` left it: reflecting a
 * centred model in a plane through its own centre leaves it centred, and leaves
 * its bounding box exactly the unit box it was. So `size` and `natural` carry
 * straight over and the base keeps every dimension it had.
 */
export function mirrorMesh(id: string, axis: 0 | 1 | 2): string {
  const key = `${id}:${axis}`
  const known = reflections.get(key)
  if (known !== undefined) return known

  const source = entries.get(id)
  // A dangling ticket is a bug, and it is `meshGeometry` that says so out loud
  // once per evaluation. Carrying it through unchanged keeps the mirror from
  // being the place that reports it.
  if (!source) return id

  const geometry = source.geometry.clone()
  const scale: Vec3 = [1, 1, 1]
  scale[axis] = -1
  geometry.applyMatrix4(new Matrix4().makeScale(scale[0], scale[1], scale[2]))
  flipWinding(geometry)
  geometry.computeVertexNormals()

  counter += 1
  const mirroredId = `m${counter}`
  // `natural` is copied rather than shared: a `Vec3` is a mutable array, and
  // two entries pointing at one would alias the day anything reached past a
  // spread to write into it.
  entries.set(mirroredId, {
    ...source,
    id: mirroredId,
    geometry,
    natural: [...source.natural] as Vec3,
  })
  reflections.set(key, mirroredId)
  reflections.set(`${mirroredId}:${axis}`, id)
  return mirroredId
}

/** Swap two vertices of every triangle, so the faces point outward again. */
function flipWinding(geometry: BufferGeometry): void {
  const index = geometry.getIndex()
  if (index) {
    const a = index.array
    for (let i = 0; i + 2 < a.length; i += 3) {
      const swap = a[i + 1]
      a[i + 1] = a[i + 2]
      a[i + 2] = swap
    }
    index.needsUpdate = true
    return
  }

  // Non-indexed: the triangle IS three consecutive vertices, so the swap moves
  // whole positions rather than pointers to them.
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name) as BufferAttribute
    const size = attr.itemSize
    const a = attr.array
    for (let i = 0; i + 3 * size <= a.length; i += 3 * size) {
      for (let k = 0; k < size; k++) {
        const swap = a[i + size + k]
        a[i + size + k] = a[i + 2 * size + k]
        a[i + 2 * size + k] = swap
      }
    }
    attr.needsUpdate = true
  }
}

/** For the check suite, which builds a fresh shelf per run. */
export function forgetMeshes(): void {
  for (const entry of entries.values()) entry.geometry.dispose()
  entries.clear()
  reflections.clear()
}

// --- Keeping the shelf across a reload ---------------------------------------

/**
 * One entry, flattened into things a browser can store.
 *
 * A `BufferGeometry` cannot go on a shelf: it is a live GPU-bound object with
 * methods, and IndexedDB stores structured clones. What it CAN store, and store
 * well, is the typed arrays inside it -- a Float32Array survives a round trip as
 * itself rather than as a JSON list of numbers three times the size.
 *
 * EVERY ATTRIBUTE, not just position and normal, and read off the geometry by
 * name rather than from a list written here. The importers are free to attach a
 * uv or a colour and this keeps working; a hardcoded pair would quietly drop
 * whatever the next format brings and leave a model that draws wrong rather
 * than a model that fails.
 */
export type MeshRecord = {
  id: string
  label: string
  natural: Vec3
  triangles: number
  attributes: { name: string; array: Float32Array; itemSize: number }[]
  /** Widened to 32 bits on the way out, so the reader has one case to handle
   *  rather than three. A model small enough for 16 costs an extra byte a
   *  vertex on a shelf that is not short of room. */
  index: Uint32Array | null
}

/** What is on the shelf under an id, ready to be stored. Undefined for an id
 *  nobody registered, which is what a caller walking a document's tickets gets
 *  for a ticket that has already gone stale. */
export function meshRecord(id: string): MeshRecord | undefined {
  const entry = entries.get(id)
  if (!entry) return undefined
  const attributes: MeshRecord['attributes'] = []
  for (const name of Object.keys(entry.geometry.attributes)) {
    const attr = entry.geometry.getAttribute(name) as BufferAttribute
    // Copied rather than referenced. The stored record outlives this call and
    // may be handed to IndexedDB on another tick; a view onto the live geometry
    // would be a view onto something the evaluator is free to have disposed.
    attributes.push({
      name,
      array: new Float32Array(attr.array as ArrayLike<number>),
      itemSize: attr.itemSize,
    })
  }
  const index = entry.geometry.getIndex()
  return {
    id: entry.id,
    label: entry.label,
    natural: [...entry.natural] as Vec3,
    triangles: entry.triangles,
    attributes,
    index: index ? new Uint32Array(index.array as ArrayLike<number>) : null,
  }
}

/**
 * Puts a stored model back on the shelf UNDER THE ID IT HAD.
 *
 * The id is the whole point. A document -- or a saved custom, which is the
 * thing that actually needs this -- holds a ticket and nothing else, so a
 * restored model registered under a fresh id would be a shelf that has the
 * triangles and a ticket that cannot find them. `registerMesh` cannot do this
 * job: it mints, and it normalises what it is given, and what is stored here is
 * already normalised.
 *
 * THE COUNTER IS SEEDED PAST WHATEVER COMES BACK. Ids are `m1`, `m2`, `m3` off
 * a counter that starts at zero every time the page loads -- so restoring `m3`
 * into a fresh session and then importing a file would mint `m1`, then `m2`,
 * then `m3` again, and the second `m3` would silently replace the first under
 * every object pointing at it. This is the one line that stops that, and it is
 * the same seeding every other restored id in the app needs.
 *
 * An id already on the shelf is LEFT ALONE. Nothing restored is worth replacing
 * a model this session has imported and is drawing.
 */
export function restoreMesh(record: MeshRecord): void {
  const numbered = /^m([0-9]+)$/.exec(record.id)
  if (numbered) counter = Math.max(counter, Number(numbered[1]))
  if (entries.has(record.id)) return

  const geometry = new BufferGeometry()
  for (const attr of record.attributes) {
    geometry.setAttribute(attr.name, new BufferAttribute(attr.array, attr.itemSize))
  }
  if (record.index) geometry.setIndex(new BufferAttribute(record.index, 1))

  entries.set(record.id, {
    id: record.id,
    label: record.label,
    geometry,
    natural: record.natural,
    triangles: record.triangles,
  })
}
