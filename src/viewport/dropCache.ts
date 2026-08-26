import { Box3 } from 'three'
import type { BufferGeometry } from 'three'
import { evaluateObject } from '../geometry/evaluate'
import { objectMatrix } from '../geometry/transform'
import type { SceneObject } from '../geometry/types'

/**
 * What a solid being dragged in from the console costs to measure, worked out
 * once per gesture.
 *
 * Two things need it and they MUST agree: the ghost that follows the pointer,
 * and the snap that decides where the release actually lands. Built separately
 * they would each solve the template's booleans, and -- worse -- a ghost drawn
 * from one geometry while the drop was sought with another would promise a
 * placement it does not deliver. So it is built here, by the frame loop, and
 * read by both.
 *
 * A module-level cache rather than a ref for the same reason `rotationIndicator`
 * is one: the frame loop fills it and a component outside that loop reads it,
 * and the read happens every frame anyway because the drag position updates
 * every frame.
 */
export type DropCache = {
  /** Identity, not value: `startPlacingSolid` mints one template per gesture. */
  template: SceneObject
  /** The lift that rests the template on the grid. */
  lift: number
  /**
   * The template as it will look on the ground: every feature, cut and merged
   * part applied, and its own rotation baked in so the corners the snapper
   * seeks are the ones the dropped object will actually have.
   *
   * Its POSITION is not baked in -- that is what the drag is choosing.
   */
  geometry: BufferGeometry
}

let cache: DropCache | null = null

/** The cache for this gesture, rebuilt when the template changes. */
export function dropCacheFor(template: SceneObject): DropCache {
  if (cache?.template === template) return cache
  releaseDropCache()

  const { geometry } = evaluateObject(template)
  // `evaluateObject` hands back a geometry the caller owns, so this is free to
  // turn it in place rather than copying it again.
  geometry.applyMatrix4(
    objectMatrix({ position: [0, 0, 0], rotation: template.transform.rotation })
  )
  const bounds = new Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as never
  )

  cache = {
    template,
    // An empty template has no extent to read, and `Box3` reports +Infinity for
    // one; resting that on the grid would send the ghost out of the scene.
    lift: Number.isFinite(bounds.min.y) ? -bounds.min.y : 0,
    geometry,
  }
  return cache
}

/** What the current gesture has built, or null before it has built anything. */
export function peekDropCache(): DropCache | null {
  return cache
}

/**
 * Free it. The geometry's GPU buffers outlive the JS wrapper, so dropping the
 * reference alone would leak one solve per drag across a working session.
 */
export function releaseDropCache(): void {
  cache?.geometry.dispose()
  cache = null
}
