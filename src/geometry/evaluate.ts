import { BufferAttribute, BufferGeometry } from 'three'
import type { Matrix4 } from 'three'
import type { Brush } from 'three-bvh-csg'
import {
  ADDITION,
  INTERSECTION,
  SUBTRACTION,
  csg,
  disposeBrush,
  makeBrush,
  normalizeGeometry,
} from './brush'
import { applyCuts } from './cut'
import { buildSweptPrism, endPlaneFor, outlineOnSurface } from './prism'
import { anchorIsCurved, hostSurfaceFor, surfaceFor } from './surfaces'
import { objectMatrix } from './transform'
import type { BaseSolid, Doc, Feature, SceneObject } from './types'
import { LOG_TAG } from '../appInfo'

/**
 * The scene is a pure function of the `Doc`. Per object the pipeline is
 * base -> features in order -> cuts, and every stage of it runs in OBJECT-LOCAL
 * space. The transform enters exactly once, in `mergedGeometry`, because the
 * viewport draws each object inside a group that already carries it -- so
 * dragging an object costs no boolean work at all.
 */

export type ObjectEval = {
  id: string
  /** OBJECT-LOCAL space. */
  geometry: BufferGeometry
  failed: string[]
}

export type EvalResult = {
  objects: ObjectEval[]
  /**
   * Ids of everything that could not be applied; surfaced in the UI, never
   * thrown. Feature, cut and object ids come from separate counters, so an id
   * in here identifies exactly one thing no matter which kind it is.
   */
  failed: string[]
  /** Wall-clock cost of the boolean work, used to decide on ghost previews. */
  millis: number
  triangles: number
}

/** A feature with no depth contributes nothing; it is drawn as a projection. */
function isInert(f: Feature): boolean {
  return !f.enabled || f.depth <= 0
}

/**
 * Build the solid that a single feature adds or removes.
 *
 * Flat and curved anchors diverge here, and they have to: a derived face has no
 * analytic offset, so an offset-shell trim is impossible for it. Since the
 * branch is forced anyway, flat surfaces take the cheaper exact-prism path.
 *
 *   flat    -> the swept prism already ends exactly `depth` from the surface
 *   curved  -> trim the prism against the base offset by `depth`, so the new
 *              face follows the curvature instead of capping it flat
 *
 * A tilted or slid face takes the flat path even on a curved host. The end
 * plane already terminates the created end exactly where `endFaceRing` draws
 * the drag handle, and the shell is a surface of constant `depth`: intersecting
 * the two would shave every part of the tilted face that reaches past `depth`
 * straight back onto the shell, so the handle would float free of a solid that
 * had quietly ignored most of the tilt. The buried end is untouched either way,
 * so the boolean still has material to bite into.
 */
function buildTool(base: BaseSolid, feature: Feature): Brush | null {
  const host = hostSurfaceFor(base, feature.anchor)
  const ring = outlineOnSurface(host, feature.anchor, feature)
  const { tIn, tOut } = host.sweep(feature.anchor, feature.depth, feature.op)
  const endPlane = endPlaneFor(host, feature.anchor, feature)
  const prism = buildSweptPrism(ring, tIn, tOut, endPlane)
  // A null prism means the tilt drove the tool degenerate; the caller reports
  // the feature as failed and keeps the solid.
  if (!prism) return null

  if (endPlane || !anchorIsCurved(feature.anchor)) return makeBrush(prism)

  const signed = feature.op === 'extrude' ? feature.depth : -feature.depth
  const offset = host.offsetGeometry(signed)
  // A collapsed offset means the feature passes clean through: the untrimmed
  // prism is then exactly the right tool.
  if (!offset) return makeBrush(prism)

  const prismBrush = makeBrush(prism)
  const offsetBrush = makeBrush(offset)
  const trimmed = csg(
    prismBrush,
    offsetBrush,
    feature.op === 'extrude' ? INTERSECTION : SUBTRACTION
  )
  disposeBrush(prismBrush)
  disposeBrush(offsetBrush)
  return trimmed
}

// --- Prefix cache ----------------------------------------------------------
// slots[0] holds the base brush, slots[i + 1] the brush after features[0..i],
// and the last slot the result of the cuts, so editing feature k replays k
// onward and nothing before it. Keys are cheap because the document is plain
// data.
//
// The cache is keyed PER OBJECT: editing feature k of object B must not touch
// object A's brushes, let alone free the GPU buffer the viewport is drawing for
// it. No key mentions the object transform -- geometry is local space, so
// moving an object never invalidates anything.

/**
 * `owned` distinguishes a slot that allocated its own brush from one that just
 * carries the previous slot's brush forward (an inert feature, a failed tool,
 * or an empty cut list change nothing). Without it, invalidating an aliased
 * slot would dispose a geometry an earlier slot still holds -- and the viewport
 * would render a freed buffer.
 *
 * `failed` is stored on the slot rather than accumulated per evaluation so a
 * failure survives being cached: a feature that failed three edits ago must
 * still be flagged while the user drags feature ten.
 */
type Step = { brush: Brush; owned: boolean; failed: string[] }
type CacheSlot = Step & { key: string }

const caches = new Map<string, CacheSlot[]>()
/** Disposal is deferred one generation so a geometry is never freed in the
 *  same tick that React might still be rendering it. */
let retired: Brush[] = []

function featureKey(f: Feature): string {
  return isInert(f) ? 'inert' : JSON.stringify(f)
}

/** One key per slot: base, one per feature, then the cuts. */
function slotKeys(obj: SceneObject): string[] {
  // Slot zero is the welded union, so it has to name the parts as well as the
  // base -- otherwise merging something would reuse a cached brush that predates
  // it and the new part would simply never appear.
  const keys: string[] = [JSON.stringify(obj.base) + `|parts:${JSON.stringify(obj.parts)}`]
  for (const f of obj.features) keys.push(`${keys[keys.length - 1]}|${featureKey(f)}`)
  // Cuts hang off the end of the same chain, so retweaking a cut replays only
  // the boolean cut, and retweaking a feature never replays more than it must.
  keys.push(`${keys[keys.length - 1]}|cuts:${JSON.stringify(obj.cuts)}`)
  return keys
}

function flushRetired(): void {
  for (const brush of retired) disposeBrush(brush)
  retired = []
}

/** Zero triangles, but with the attributes every consumer expects to find. */
function emptyGeometry(): BufferGeometry {
  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(new Float32Array(0), 3))
  geom.setAttribute('normal', new BufferAttribute(new Float32Array(0), 3))
  return geom
}

function triangleCount(geom: BufferGeometry): number {
  const position = geom.getAttribute('position')
  if (!position) return 0
  const index = geom.getIndex()
  return Math.floor((index ? index.count : position.count) / 3)
}

/**
 * A base that will not build is fatal to its own object and to nothing else --
 * throwing here would blank every other object in the scene.
 */
function baseBrush(base: BaseSolid): Brush | null {
  try {
    return makeBrush(surfaceFor(base).geometry())
  } catch (err) {
    console.warn(`[${LOG_TAG}] base solid ${base.kind} failed to build`, err)
    return null
  }
}

/**
 * The object's own primitive with every merged part welded onto it.
 *
 * A part is a whole SceneObject in this object's local space, so it is
 * evaluated exactly the way a top-level object is -- base, then its features,
 * then its cuts -- and only then baked through its local transform and unioned
 * in. Recursion falls out of that: a part that was itself a merge brings its
 * own parts with it, and nothing had to be flattened at merge time.
 *
 * This is slot ZERO of the prefix cache, which is what makes the cost sane: a
 * merged object rebuilds its union only when the merge itself changes, not when
 * a feature on top of it is dragged.
 */
function mergedBase(obj: SceneObject): { brush: Brush | null; failed: string[] } {
  const base = baseBrush(obj.base)
  if (!base || obj.parts.length === 0) return { brush: base, failed: base ? [] : [obj.id] }

  const failed: string[] = []
  let current = base

  for (const part of obj.parts) {
    let welded: BufferGeometry | null = null
    let tool: Brush | null = null
    try {
      // `evaluateObject` hands back a geometry the caller owns, which is what
      // lets this dispose it once the brush has copied it.
      const evaluated = evaluateObject(part)
      failed.push(...evaluated.failed)
      welded = bakeWorld(evaluated.geometry, objectMatrix(part.transform))
      evaluated.geometry.dispose()
      tool = makeBrush(welded)
      const next = csg(current, tool, ADDITION)
      disposeBrush(current)
      current = next
    } catch (err) {
      console.warn(`[${LOG_TAG}] merged part ${part.id} failed to weld`, err)
      failed.push(part.id)
    } finally {
      if (tool) disposeBrush(tool)
      else welded?.dispose()
    }
  }

  return { brush: current, failed }
}

function applyFeature(base: BaseSolid, feature: Feature, prev: Brush): Step {
  if (isInert(feature)) return { brush: prev, owned: false, failed: [] }

  let tool: Brush | null = null
  try {
    tool = buildTool(base, feature)
    if (!tool) return { brush: prev, owned: false, failed: [feature.id] }
    const next = csg(prev, tool, feature.op === 'extrude' ? ADDITION : SUBTRACTION)
    return { brush: next, owned: true, failed: [] }
  } catch (err) {
    // A malformed tool must never take the whole document down; skip the
    // feature, keep the solid, and let the UI flag it.
    console.warn(`[${LOG_TAG}] feature ${feature.id} failed to evaluate`, err)
    return { brush: prev, owned: false, failed: [feature.id] }
  } finally {
    // Runs after `csg` has consumed the tool, and also on the throwing path,
    // where the tool would otherwise leak once per frame of a drag.
    disposeBrush(tool)
  }
}

function applyObjectCuts(obj: SceneObject, prev: Brush): Step {
  try {
    // Each half-space sizes itself from the solid it is actually cutting, so it
    // covers whatever the features grew and reaches back from a plane parked
    // far outside the object.
    const { brush, owned } = applyCuts(prev, obj.cuts)
    return { brush, owned, failed: [] }
  } catch (err) {
    console.warn(`[${LOG_TAG}] cuts on object ${obj.id} failed to evaluate`, err)
    return { brush: prev, owned: false, failed: obj.cuts.map((c) => c.id) }
  }
}

function evaluateCached(obj: SceneObject): ObjectEval {
  const keys = slotKeys(obj)
  const previous = caches.get(obj.id) ?? []

  // Longest cached prefix that still matches.
  let reuse = 0
  while (
    reuse < previous.length &&
    reuse < keys.length &&
    previous[reuse].key === keys[reuse]
  ) {
    reuse++
  }
  for (let i = reuse; i < previous.length; i++) {
    if (previous[i].owned) retired.push(previous[i].brush)
  }
  const slots = previous.slice(0, reuse)
  caches.set(obj.id, slots)

  if (slots.length === 0) {
    const welded = mergedBase(obj)
    if (!welded.brush) {
      caches.delete(obj.id)
      return { id: obj.id, geometry: emptyGeometry(), failed: [obj.id] }
    }
    slots.push({ key: keys[0], brush: welded.brush, owned: true, failed: welded.failed })
  }

  for (let i = slots.length - 1; i < obj.features.length; i++) {
    slots.push({ key: keys[i + 1], ...applyFeature(obj.base, obj.features[i], slots[i].brush) })
  }

  if (slots.length === obj.features.length + 1) {
    const prev = slots[slots.length - 1].brush
    slots.push({ key: keys[keys.length - 1], ...applyObjectCuts(obj, prev) })
  }

  const failed: string[] = []
  for (const slot of slots) failed.push(...slot.failed)

  return { id: obj.id, geometry: slots[slots.length - 1].brush.geometry, failed }
}

/** Objects that left the doc keep no brushes alive; undo brings them back cold. */
function evictDeparted(doc: Doc): void {
  const live = new Set(doc.objects.map((o) => o.id))
  for (const [id, slots] of caches) {
    if (live.has(id)) continue
    for (const slot of slots) if (slot.owned) retired.push(slot.brush)
    caches.delete(id)
  }
}

export function evaluateDoc(doc: Doc): EvalResult {
  const started = performance.now()
  flushRetired()
  evictDeparted(doc)

  const objects: ObjectEval[] = []
  const failed: string[] = []
  let triangles = 0

  for (const obj of doc.objects) {
    const result = evaluateCached(obj)
    objects.push(result)
    failed.push(...result.failed)
    triangles += triangleCount(result.geometry)
  }

  return { objects, failed, millis: performance.now() - started, triangles }
}

/**
 * One object, uncached, for headless callers and for the store's cut test.
 *
 * Intermediates are disposed as they are superseded: nothing outside this call
 * ever sees them, so the deferred-disposal discipline the cache needs does not
 * apply. The caller owns the returned geometry.
 */
export function evaluateObject(obj: SceneObject): {
  geometry: BufferGeometry
  failed: string[]
} {
  const welded = mergedBase(obj)
  if (!welded.brush) return { geometry: emptyGeometry(), failed: [obj.id] }

  const failed: string[] = [...welded.failed]
  let current = welded.brush

  for (const feature of obj.features) {
    const step = applyFeature(obj.base, feature, current)
    failed.push(...step.failed)
    // An unowned step aliases `current`; disposing it would free the brush the
    // step just handed back.
    if (!step.owned) continue
    disposeBrush(current)
    current = step.brush
  }

  const cut = applyObjectCuts(obj, current)
  failed.push(...cut.failed)
  if (cut.owned) {
    disposeBrush(current)
    current = cut.brush
  }

  return { geometry: current.geometry, failed }
}

/**
 * Copy a local-space geometry into world space.
 *
 * `applyMatrix4` routes the normals through `Matrix3.getNormalMatrix` -- the
 * inverse transpose -- instead of the full matrix. Transforming them directly
 * would add the translation to every normal, and a moved or turned object would
 * export with inverted shading.
 */
function bakeWorld(geometry: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const copy = geometry.getIndex() ? geometry.toNonIndexed() : geometry.clone()
  // Same normalisation rule as brush.ts: an indexed base solid still carries
  // uvs and groups, a boolean result carries neither, and the two cannot be
  // concatenated until both are plain position+normal triangle soup.
  normalizeGeometry(copy)
  copy.applyMatrix4(matrix)
  return copy
}

/**
 * Every object baked through its own transform and concatenated into one
 * world-space geometry, for export.
 *
 * THE CALLER OWNS THE RESULT and must dispose it. It shares no buffer with the
 * cache, so disposing it never disturbs what is on screen.
 */
export function mergedGeometry(doc: Doc, result: EvalResult): BufferGeometry {
  const byId = new Map(result.objects.map((o) => [o.id, o.geometry]))

  const parts: BufferGeometry[] = []
  for (const obj of doc.objects) {
    const geometry = byId.get(obj.id)
    if (!geometry) continue
    parts.push(bakeWorld(geometry, objectMatrix(obj.transform)))
  }

  let vertices = 0
  for (const part of parts) vertices += part.getAttribute('position').count

  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  let offset = 0
  for (const part of parts) {
    const p = part.getAttribute('position')
    const n = part.getAttribute('normal')
    position.set(p.array, offset)
    normal.set(n.array, offset)
    offset += p.count * 3
    part.dispose()
  }

  const merged = new BufferGeometry()
  merged.setAttribute('position', new BufferAttribute(position, 3))
  merged.setAttribute('normal', new BufferAttribute(normal, 3))
  return merged
}

/** Drop every cached brush. Used when the document is replaced wholesale. */
export function resetEvaluator(): void {
  for (const slots of caches.values()) {
    for (const slot of slots) if (slot.owned) retired.push(slot.brush)
  }
  caches.clear()
  flushRetired()
}
