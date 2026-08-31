import { Box3, Vector3 } from 'three'
import type { BufferGeometry, Matrix4 } from 'three'
import { endFaceFrame } from '../geometry/prism'
import {
  collectSnapTargets,
  objectSnapTargets,
  snapAlongAxis,
  snapSinglePoint,
  snapTranslation,
} from '../geometry/snap'
import type {
  SketchCentre,
  SnapEntry,
  SnapHit,
  SnapSource,
  SnapTarget,
} from '../geometry/snap'
import { hostSurfaceFor } from '../geometry/surfaces'
import { objectMatrix } from '../geometry/transform'
import { IDENTITY_TRANSFORM } from '../geometry/types'
import type { SceneObject, Vec3 } from '../geometry/types'
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
    signature += `${e.id}:${e.geometry.uuid}:${px},${py},${pz}:${rx},${ry},${rz}:${sketchKey(e)};`
  }
  return signature
}

/**
 * Sketch centres have to be part of what the cache is keyed on, because they
 * are the one thing here that moves WITHOUT the mesh changing: a sketch at
 * depth zero is a projection that cuts nothing, so sliding one leaves the
 * geometry -- and its uuid -- exactly as it was, and the cache would go on
 * handing back the centre the sketch used to be at.
 */
function sketchKey(entry: SnapEntry): string {
  if (!entry.sketches || entry.sketches.length === 0) return ''
  let key = ''
  for (const { featureId, point } of entry.sketches) {
    key += `${featureId}@${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}|`
  }
  return key
}

/**
 * Where each of an object's sketches sits, in the object's OWN space: the
 * middle of the outline on its host face, and -- once it has been pushed or
 * pulled into a boss or a pocket -- the middle of the face that made.
 *
 * Read from the document rather than off the mesh for the reason `SnapEntry`
 * gives: a flat sketch is not IN the mesh. Both centres carry the same feature
 * id, so a sketch drag drops both of its own and catches everything else's.
 */
export function sketchCentres(object: SceneObject): SketchCentre[] {
  const out: SketchCentre[] = []
  for (const feature of object.features) {
    const host = hostSurfaceFor(object.base, feature.anchor)
    out.push({ featureId: feature.id, point: host.frame(feature.anchor).origin })
    // Null at depth zero, which is exactly when there is no created face.
    const end = endFaceFrame(host, feature.anchor, feature)
    if (end) out.push({ featureId: feature.id, point: end.origin })
  }
  return out
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
 * The dragged solid's own middle, in LOCAL space.
 *
 * Cached on the geometry by three itself, and correct for the same reason the
 * corner sample is cached local: a drag moves the object every frame and its
 * mesh never.
 */
function localCentreOf(geometry: BufferGeometry): Vector3 {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  return geometry.boundingBox?.getCenter(new Vector3()) ?? new Vector3()
}

/**
 * What a solid being dragged offers the scene: its corners, and its middle.
 *
 * The two are offered as DIFFERENT KINDS of source rather than as one bag of
 * points, and the snap engine's pairing rule is what that buys. A corner
 * seeking a neighbour's face lands the solid flush against it; the middle
 * seeking that same face would land it half buried, which is why the middle was
 * left out of this list entirely until centres existed to catch it. Now it is
 * here and can only ever meet another centre.
 */
function dragSources(geometry: BufferGeometry, matrix: Matrix4): SnapSource[] {
  const sources: SnapSource[] = localCornersFor(geometry).map((p) => ({
    point: p.clone().applyMatrix4(matrix),
    kind: 'corner',
  }))
  sources.push({
    point: localCentreOf(geometry).applyMatrix4(matrix),
    kind: 'centre',
  })
  return sources
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
 * The correction for a whole solid seeking the scene by its own corners and its
 * own middle.
 *
 * Shared by the two gestures that move a solid, which differ only in where the
 * geometry comes from and what they must not catch on. Both hand over the
 * sources as they would sit ONCE THE DRAG LANDS: the correction has to be
 * measured from where the solid is going, not from where it currently is.
 */
function snapBySources(
  geometry: BufferGeometry,
  desired: Vec3,
  rotation: Vec3,
  targets: SnapTarget[],
  tol: number
): Vec3 {
  if (targets.length === 0) return desired

  const hit = snapTranslation(
    dragSources(geometry, objectMatrix({ position: desired, rotation })),
    targets,
    tol
  )
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
  return snapBySources(
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
 * no entry to look up. The corners are what let a dropped solid land FLUSH
 * against a neighbour, and its middle can only ever meet another middle, which
 * is the rule that keeps a centre from pulling it INTO one. Nothing is
 * excluded, because the thing being dropped owns none of the scene it seeks.
 */
export function resolveSolidDrop(geometry: BufferGeometry, desired: Vec3): Vec3 {
  snapIndicator.hit = null

  const { snap, snapDistance } = useTools.getState()
  if (!snap) return desired

  // `makeObject` gives a fresh solid the identity rotation, so the drop lands
  // unrotated however the drag is resolved.
  return snapBySources(
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
  const sources = dragSources(entry.geometry, matrix)

  const hit = snapAlongAxis(sources, snapTargets(objectId), axis, snapDistance)
  if (!hit) return desired

  snapIndicator.hit = hit
  return [desired[0] + hit.delta.x, desired[1] + hit.delta.y, desired[2] + hit.delta.z]
}
