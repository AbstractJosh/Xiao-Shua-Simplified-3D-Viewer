import { Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import { assemblyCentre } from '../geometry/assembly'
import { evaluateObject } from '../geometry/evaluate'
import { objectMatrix, toWorldDir } from '../geometry/transform'
import type { SceneObject } from '../geometry/types'

/**
 * The mesh behind a clipboard thumbnail, and a small cache in front of it.
 *
 * Building one is a full replay of the object -- features, cuts, the union of
 * every merged part -- so it is the expensive half of a tile. The panel keeps
 * only three models live at a time and mounts them as they scroll into view,
 * which means without a cache a user sweeping back and forth would pay for the
 * same solve over and over and watch the loading ring flash each time.
 *
 * Keyed by the stored object's IDENTITY. A saved object is frozen the moment it
 * is saved -- renaming replaces the entry's name and never its object -- so the
 * reference is a sound key, and an entry that is somehow rebuilt gets a fresh
 * one rather than a stale mesh.
 */

export type Thumbnail = {
  /**
   * Moved so the object's GIZMO POINT is at the origin.
   *
   * Not the middle of its bounding box, which is where this used to sit. The
   * gizmo is the point the object turns about everywhere else in the app -- for
   * a merge, midway between the solids welded together; for a solid carrying a
   * tall boss, the primitive's own centre rather than somewhere up the boss --
   * and a tile that span about a different point would be showing the object
   * doing something it never does.
   */
  geometry: BufferGeometry
  /**
   * The furthest any vertex reaches from that point.
   *
   * Measured exactly rather than taken from a bounding box's diagonal, which
   * over-states a round object by up to a factor of the square root of three,
   * and -- now the pivot is the gizmo rather than the box's middle -- would
   * under-state anything hanging off to one side. Since the model only ever
   * turns and tilts ABOUT this point, a sphere of this radius contains it in
   * every frame, so a camera framed on the sphere can never crop it.
   */
  radius: number
}

/**
 * How many meshes to hold. Comfortably more than the three on screen, so the
 * usual back-and-forth over a shelf of a dozen never re-solves, and small
 * enough that a long session cannot accumulate GPU buffers without bound.
 */
const CACHE_LIMIT = 12

const cache = new Map<SceneObject, Thumbnail>()

/** Whether this object's mesh is ready, and so needs no loading ring at all. */
export function thumbnailCached(object: SceneObject): boolean {
  return cache.has(object)
}

export function thumbnailFor(object: SceneObject): Thumbnail {
  const hit = cache.get(object)
  if (hit) {
    // Re-inserted so the map's own insertion order is a least-recently-used
    // order, which is what makes the eviction below the right one to drop.
    cache.delete(object)
    cache.set(object, hit)
    return hit
  }

  const { geometry } = evaluateObject(object)
  // Turned the way it was saved. A custom put aside lying on its side is that
  // shape, and a thumbnail that stood it upright would be advertising something
  // other than what the tile drops.
  geometry.applyMatrix4(
    objectMatrix({ position: [0, 0, 0], rotation: object.transform.rotation })
  )

  // The gizmo point, carried through the same rotation the geometry just took.
  const centre = assemblyCentre(object)
  const pivot = toWorldDir(
    { position: [0, 0, 0], rotation: object.transform.rotation },
    new Vector3(centre[0], centre[1], centre[2])
  )
  geometry.translate(-pivot.x, -pivot.y, -pivot.z)

  // The exact reach from the pivot, vertex by vertex. An object that failed to
  // evaluate has none, and leaves the floor below standing.
  const position = geometry.getAttribute('position')
  let reach = 0
  if (position) {
    const at = new Vector3()
    for (let i = 0; i < position.count; i++) {
      reach = Math.max(reach, at.fromBufferAttribute(position, i).length())
    }
  }

  const built: Thumbnail = { geometry, radius: Math.max(reach, 0.001) }
  cache.set(object, built)

  // Oldest first, which after the re-insertion above is the least recently used.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.get(oldest.value)?.geometry.dispose()
    cache.delete(oldest.value)
  }

  return built
}

/**
 * Drop an object's mesh, for when the shelf gives it up.
 *
 * Explicit rather than left to the collector: a `BufferGeometry`'s GPU buffers
 * outlive its JS wrapper, so a removed custom would leak one upload.
 */
export function releaseThumbnail(object: SceneObject): void {
  cache.get(object)?.geometry.dispose()
  cache.delete(object)
}
