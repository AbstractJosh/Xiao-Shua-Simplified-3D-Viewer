import { Box3, Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import {
  collectSnapTargets,
  objectSnapTargets,
  snapAlongAxis,
  snapSinglePoint,
  snapTranslation,
} from '../geometry/snap'
import type { SnapEntry, SnapHit, SnapTarget } from '../geometry/snap'
import { objectMatrix } from '../geometry/transform'
import { IDENTITY_TRANSFORM } from '../geometry/types'
import type { Vec3 } from '../geometry/types'
import { useTools } from '../store/toolStore'

/**
 * The glue between the evaluator and the snap engine: what the scene currently
 * looks like, and where a drag should land in it.
 *
 * Module-level mutable state rather than a store, deliberately. Every frame of
 * a drag asks this what the pointer can catch on, and a zustand round trip per
 * frame would re-render the whole scene mid-gesture -- the same reasoning that
 * makes Viewport's Interaction component read the document imperatively rather
 * than by subscription.
 */

/** Cap on the sources handed to `snapTranslation`, which is O(sources x
 *  targets). A tessellated sphere offers thousands of corners; feeding all of
 *  them in is exactly what would make dragging one stutter. */
const MAX_DRAG_SOURCES = 64

/** Enough for the objects a drag realistically passes through in one session. */
const CORNER_MEMO_CAPACITY = 24

/** Cache slot for the query that excludes nothing. Object ids are always
 *  `o<n>`, so the empty string can never collide with one. */
const ALL_KEY = ''

type TargetCache = { signature: string; targets: SnapTarget[] }

let entries: SnapEntry[] = []
const targetCache = new Map<string, TargetCache>()

/**
 * Where the last resolve caught, for the viewport's overlay to draw.
 *
 * Mutable and read straight from a frame loop, for the same reason the registry
 * is. Every resolve call clears it first, so a gesture that stops snapping
 * stops drawing; the viewport only has to null it when the drag itself ends.
 */
export const snapIndicator: { hit: SnapHit | null } = { hit: null }

// --- Registry ---------------------------------------------------------------

export function publishScene(next: SnapEntry[]): void {
  entries = next
  // Staleness is caught by the signature check below; this only keeps the cache
  // from accumulating a slot per object the scene has ever held.
  const live = new Set(next.map((e) => e.id))
  for (const key of targetCache.keys()) {
    if (key !== ALL_KEY && !live.has(key)) targetCache.delete(key)
  }
}

function entryFor(objectId: string): SnapEntry | undefined {
  return entries.find((e) => e.id === objectId)
}

// --- Target set -------------------------------------------------------------

/**
 * Identity of the target set for one query.
 *
 * Keyed on the CONTRIBUTING entries only. Dragging an object republishes the
 * scene every frame with a new entry for it, but that object is the one being
 * excluded -- so leaving it out of the signature is what lets the drag reuse
 * one collected target set for its whole duration.
 */
function signatureFor(exclude: string): string {
  let signature = ''
  for (const e of entries) {
    if (e.id === exclude) continue
    const [px, py, pz] = e.transform.position
    const [rx, ry, rz] = e.transform.rotation
    signature += `${e.id}:${e.geometry.uuid}:${px},${py},${pz}:${rx},${ry},${rz};`
  }
  return signature
}

export function snapTargets(excludeObjectId?: string): SnapTarget[] {
  const key = excludeObjectId ?? ALL_KEY
  const signature = signatureFor(key)
  const cached = targetCache.get(key)
  if (cached && cached.signature === signature) return cached.targets

  const targets = collectSnapTargets(entries, excludeObjectId)
  targetCache.set(key, { signature, targets })
  return targets
}

// --- Drag sources -----------------------------------------------------------

const cornerMemo = new Map<string, Vector3[]>()

/**
 * The sampled corner set for a geometry, in LOCAL space.
 *
 * Cached local rather than world on purpose: a drag changes the transform every
 * frame but never the mesh, so the sampling -- linear in the vertex count, and
 * quadratic-ish in the sample size -- must not be keyed on anything that moves.
 * Only the surviving handful is transformed per frame.
 */
function localCornersFor(geometry: BufferGeometry): Vector3[] {
  const hit = cornerMemo.get(geometry.uuid)
  if (hit) {
    // Re-insert to mark it as the most recently used.
    cornerMemo.delete(geometry.uuid)
    cornerMemo.set(geometry.uuid, hit)
    return hit
  }

  // The identity transform is what makes these come back in the object's own
  // space, and the owning id is a placeholder because only the points are read
  // back. The expensive topology pass behind this call is memoised inside
  // snap.ts on the geometry itself, so this shares it with the target
  // collection rather than repeating it -- and two objects the evaluator handed
  // the same cached geometry share this sample as well.
  const vertices: Vector3[] = []
  for (const target of objectSnapTargets('', geometry, IDENTITY_TRANSFORM)) {
    if (target.kind === 'vertex') vertices.push(target.point)
  }

  const sampled = farthestPointSample(vertices, MAX_DRAG_SOURCES)
  cornerMemo.set(geometry.uuid, sampled)
  if (cornerMemo.size > CORNER_MEMO_CAPACITY) {
    for (const oldest of cornerMemo.keys()) {
      cornerMemo.delete(oldest)
      break
    }
  }
  return sampled
}

/**
 * Greedy farthest-point sampling over the points' own bounding box.
 *
 * Taking the first N instead would cluster every source on whichever pole the
 * tessellation happens to emit first, and a drag would only ever snap by one
 * corner of the object. Spreading them leaves a source near wherever the user
 * is actually aiming.
 */
function farthestPointSample(points: Vector3[], limit: number): Vector3[] {
  if (points.length <= limit) return points.map((p) => p.clone())

  // Seeded from the point farthest from the bounding-box centre, so the same
  // geometry always yields the same sample. A seed that moved between frames
  // would make the snap flicker as the set changed under the drag.
  const centre = new Box3().setFromPoints(points).getCenter(new Vector3())
  let seed = 0
  let seedDistance = -1
  for (let i = 0; i < points.length; i++) {
    const d = points[i].distanceToSquared(centre)
    if (d > seedDistance) {
      seedDistance = d
      seed = i
    }
  }

  const chosen = [points[seed].clone()]
  const nearest = points.map((p) => p.distanceToSquared(points[seed]))

  while (chosen.length < limit) {
    let pick = -1
    let worst = 0
    for (let i = 0; i < points.length; i++) {
      if (nearest[i] > worst) {
        worst = nearest[i]
        pick = i
      }
    }
    // Everything left is a duplicate of something already taken; more sources
    // would only cost time.
    if (pick < 0) break
    chosen.push(points[pick].clone())
    for (let i = 0; i < points.length; i++) {
      const d = points[i].distanceToSquared(points[pick])
      if (d < nearest[i]) nearest[i] = d
    }
  }
  return chosen
}

// --- Resolution -------------------------------------------------------------

/**
 * The correction for a whole solid seeking the scene by its own corners.
 *
 * Shared by the two gestures that move a solid, which differ only in where the
 * geometry comes from and what they must not catch on. Both hand over the
 * corners as they would sit ONCE THE DRAG LANDS: the correction has to be
 * measured from where the solid is going, not from where it currently is.
 */
function snapByCorners(
  geometry: BufferGeometry,
  desired: Vec3,
  rotation: Vec3,
  targets: SnapTarget[],
  tol: number
): Vec3 {
  if (targets.length === 0) return desired

  const matrix = objectMatrix({ position: desired, rotation })
  const sources = localCornersFor(geometry).map((p) => p.clone().applyMatrix4(matrix))

  const hit = snapTranslation(sources, targets, tol)
  if (!hit) return desired

  snapIndicator.hit = hit
  return [desired[0] + hit.delta.x, desired[1] + hit.delta.y, desired[2] + hit.delta.z]
}

/**
 * The position an object drag should actually commit, given where the pointer
 * put it.
 *
 * Tool state is read with `getState()` rather than a hook: this is called from
 * a frame loop, where subscribing would re-render the scene on every change to
 * a store the gesture is only reading.
 */
export function resolveObjectMove(objectId: string, desired: Vec3): Vec3 {
  snapIndicator.hit = null

  const { snap, snapDistance } = useTools.getState()
  if (!snap) return desired

  const entry = entryFor(objectId)
  if (!entry) return desired

  // Rotation comes from the published entry because a drag only translates, so
  // the object cannot be turning while this runs.
  return snapByCorners(
    entry.geometry,
    desired,
    entry.transform.rotation,
    snapTargets(objectId),
    snapDistance
  )
}

/**
 * The same thing for a solid that does not exist yet: a template being dropped
 * in from the palette.
 *
 * Takes a geometry instead of an object id for exactly that reason -- there is
 * no entry to look up. Snapping by the corners rather than by the centre is
 * what lets a dropped solid land FLUSH against a neighbour; a centre snap can
 * only ever pull it INTO one. Nothing is excluded, because the thing being
 * dropped owns none of the scene it is seeking.
 */
export function resolveSolidDrop(geometry: BufferGeometry, desired: Vec3): Vec3 {
  snapIndicator.hit = null

  const { snap, snapDistance } = useTools.getState()
  if (!snap) return desired

  // `makeObject` gives a fresh solid the identity rotation, so the drop lands
  // unrotated however the drag is resolved.
  return snapByCorners(
    geometry,
    desired,
    IDENTITY_TRANSFORM.rotation,
    snapTargets(),
    snapDistance
  )
}

/**
 * The single-point case, for sketch and face drags.
 *
 * `excludeObjectId` is what separates the two: a sketch seeks its OWN object's
 * corners and edges and so excludes nothing, while an end face is looking for
 * somewhere else to meet and must not catch the solid it grew out of.
 */
export function resolvePoint(p: Vector3, excludeObjectId?: string): Vector3 {
  snapIndicator.hit = null

  const { snap, snapDistance } = useTools.getState()
  if (!snap) return p.clone()

  const hit = snapSinglePoint(p, snapTargets(excludeObjectId), snapDistance)
  if (!hit) return p.clone()

  snapIndicator.hit = hit
  return hit.point.clone()
}

/**
 * The axis-constrained case, for a gizmo arrow.
 *
 * Separate from `resolveObjectMove` rather than a flag on it, because the
 * question is genuinely different: that one asks "where is the nearest thing in
 * any direction", this one asks "how far along THIS line until a corner meets
 * something". Answering the first and then discarding the components the arrow
 * is not allowed to use would land the solid short of the target while the
 * indicator claimed contact.
 */
export function resolveAxisMove(objectId: string, desired: Vec3, axis: Vector3): Vec3 {
  snapIndicator.hit = null

  const { snap, snapDistance } = useTools.getState()
  if (!snap) return desired

  const entry = entryFor(objectId)
  if (!entry) return desired

  const matrix = objectMatrix({ position: desired, rotation: entry.transform.rotation })
  const sources = localCornersFor(entry.geometry).map((p) => p.clone().applyMatrix4(matrix))

  const hit = snapAlongAxis(sources, snapTargets(objectId), axis, snapDistance)
  if (!hit) return desired

  snapIndicator.hit = hit
  return [desired[0] + hit.delta.x, desired[1] + hit.delta.y, desired[2] + hit.delta.z]
}
