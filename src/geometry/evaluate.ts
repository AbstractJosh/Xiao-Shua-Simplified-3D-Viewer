import { Box3, BufferAttribute, BufferGeometry } from 'three'
import type { Matrix4 } from 'three'
import type { Brush } from 'three-bvh-csg'
import {
  ADDITION,
  INTERSECTION,
  SUBTRACTION,
  csg,
  disposeBrush,
  forgetPaints,
  makeBrush,
  normalizeGeometry,
  paintsOf,
} from './brush'
import { applyCuts } from './cut'
import { buildSweptPrism, endPlaneFor, outlineOnSurface } from './prism'
import { anchorIsCurved, hostSurfaceFor, surfaceFor } from './surfaces'
import { objectMatrix } from './transform'
import { signedVolume } from './volume'
import { sweepOp } from './types'
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
  /**
   * Which solid each of the geometry's groups came from, indexed to match the
   * groups' `materialIndex`: the object's own id, and the id of every merged
   * part that still shows a face.
   *
   * This is how a merged object keeps more than one colour. The document holds
   * a colour per solid and always did -- merging never threw one away -- but
   * the union that gets drawn is a single mesh, so until it could say which
   * triangles were whose, one colour was all it could wear. A list of ids
   * rather than a list of colours on purpose: recolouring then moves a material
   * prop and never re-runs the boolean. See `paintMaterial`.
   *
   * Never empty. An object that failed to build reports its own id over an
   * empty geometry, so a consumer always has one paint per group and one group
   * to spare.
   */
  paints: string[]
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
  // Exactly zero, not "at most zero": depth is signed now, and a negative one
  // is a pocket rather than nothing at all.
  return !f.enabled || f.depth === 0
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
function buildTool(base: BaseSolid, feature: Feature, paint: string): Brush | null {
  const host = hostSurfaceFor(base, feature.anchor)
  const ring = outlineOnSurface(host, feature.anchor, feature)
  // The surface layer is asked for a MAGNITUDE and a direction: it branches on
  // the direction anyway -- what a sweep buries behind the face is not what it
  // raises in front of it -- so handing it a signed number would only move that
  // branch inside seven implementations of it.
  const op = sweepOp(feature.depth)
  const { tIn, tOut } = host.sweep(feature.anchor, Math.abs(feature.depth), op)
  const endPlane = endPlaneFor(host, feature.anchor, feature)
  const prism = buildSweptPrism(ring, tIn, tOut, endPlane)
  // A null prism means the tilt drove the tool degenerate; the caller reports
  // the feature as failed and keeps the solid.
  if (!prism) return null

  if (endPlane || !anchorIsCurved(feature.anchor)) return makeBrush(prism, paint)

  const offset = host.offsetGeometry(feature.depth)
  // A collapsed offset means the feature passes clean through: the untrimmed
  // prism is then exactly the right tool.
  if (!offset) return makeBrush(prism, paint)

  // Both halves of the trim take the SAME paint, so the intersection folds them
  // back into one group instead of splitting a feature's own surface in two.
  const prismBrush = makeBrush(prism, paint)
  const offsetBrush = makeBrush(offset, paint)
  const trimmed = csg(prismBrush, offsetBrush, op === 'extrude' ? INTERSECTION : SUBTRACTION)
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

/**
 * The merged parts, as the BOOLEAN sees them.
 *
 * Colour and name are dropped, because neither is geometry. Colour especially:
 * it now reaches the screen through the union's groups rather than through a
 * single material on the mesh, and if it stayed in this key then repainting one
 * solid of a five-part assembly would re-run every boolean in it -- for a
 * result identical triangle for triangle to the one already cached. The paint a
 * group carries is the part's ID, which this does keep, so a cached union stays
 * correct through any number of recolourings.
 */
function structureOf(parts: SceneObject[]): string {
  return JSON.stringify(parts, (key, value) =>
    key === 'color' || key === 'name' ? undefined : value
  )
}

/** One key per slot: base, one per feature, then the cuts. */
function slotKeys(obj: SceneObject): string[] {
  // Slot zero is the welded union, so it has to name the parts as well as the
  // base -- otherwise merging something would reuse a cached brush that predates
  // it and the new part would simply never appear.
  const keys: string[] = [JSON.stringify(obj.base) + `|parts:${structureOf(obj.parts)}`]
  for (const f of obj.features) keys.push(`${keys[keys.length - 1]}|${featureKey(f)}`)
  // Cuts hang off the end of the same chain, so retweaking a cut replays only
  // the boolean cut, and retweaking a feature never replays more than it must.
  keys.push(`${keys[keys.length - 1]}|cuts:${JSON.stringify(obj.cuts)}`)
  // And the erased solids hang off the end of THAT, because they are the last
  // thing applied: a hole is not something a later feature may fill back in.
  keys.push(`${keys[keys.length - 1]}|erased:${structureOf(obj.erased ?? [])}`)
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
function baseBrush(base: BaseSolid, paint: string): Brush | null {
  try {
    return makeBrush(surfaceFor(base).geometry(), paint)
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
 *
 * Each solid goes in under its OWN paint -- the host under its id, every part
 * under the part's -- and the union carries those through as groups. That is
 * what lets a merge of a red cube and a blue one come back red and blue: the
 * document always kept both colours, and this is the step that used to lose
 * them.
 */
function mergedBase(obj: SceneObject): { brush: Brush | null; failed: string[] } {
  const base = baseBrush(obj.base, obj.id)
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
      // Groups kept, unlike every other bake here: a part that was itself a
      // merge arrives carrying several paints, and dropping its groups on the
      // way in would flatten it to one colour before the union ever saw it.
      welded = bakeWorld(evaluated.geometry, objectMatrix(part.transform), true)
      evaluated.geometry.dispose()
      tool = makeBrush(welded, evaluated.paints)
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

/**
 * `paint` is the host object's own key. A feature belongs to the object rather
 * than to any one solid inside it, so both the material a boss adds and the
 * walls a pocket opens up wear the object's colour -- the pocket's walls come
 * from the tool, and the tool is the object's.
 */
function applyFeature(
  base: BaseSolid,
  feature: Feature,
  prev: Brush,
  paint: string
): Step {
  if (isInert(feature)) return { brush: prev, owned: false, failed: [] }

  let tool: Brush | null = null
  try {
    tool = buildTool(base, feature, paint)
    if (!tool) return { brush: prev, owned: false, failed: [feature.id] }
    const next = csg(
      prev,
      tool,
      sweepOp(feature.depth) === 'extrude' ? ADDITION : SUBTRACTION
    )
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

/**
 * Take away every solid erased out of this object.
 *
 * Last in the chain, and its own slot in the prefix cache, so a hole costs its
 * boolean once and nothing that comes after re-runs it.
 *
 * The walls the eraser opens up wear the object's OWN paint, the same rule a
 * pocket's walls and a cut's face already follow: the hole belongs to the
 * object rather than to any one solid inside it, and an eraser has no colour of
 * its own to lend -- it is not in the scene any more by the time this runs.
 */
function applyErased(obj: SceneObject, prev: Brush): Step {
  const erased = obj.erased ?? []
  if (erased.length === 0) return { brush: prev, owned: false, failed: [] }

  let current = prev
  let owned = false
  const failed: string[] = []

  for (const hole of erased) {
    let baked: BufferGeometry | null = null
    let tool: Brush | null = null
    try {
      // Evaluated exactly the way a merged part is -- base, features, cuts, its
      // own parts -- then carried through its transform into this object's
      // space. An eraser can be anything the palette can build, including
      // something the user had already shaped.
      const evaluated = evaluateObject(hole)
      failed.push(...evaluated.failed)
      baked = bakeWorld(evaluated.geometry, objectMatrix(hole.transform))
      evaluated.geometry.dispose()
      tool = makeBrush(baked, obj.id)
      const next = csg(current, tool, SUBTRACTION)
      if (owned) disposeBrush(current)
      current = next
      owned = true
    } catch (err) {
      console.warn(`[${LOG_TAG}] erased solid ${hole.id} failed to subtract`, err)
      failed.push(hole.id)
    } finally {
      if (tool) disposeBrush(tool)
      else baked?.dispose()
    }
  }

  return { brush: current, owned, failed }
}

function applyObjectCuts(obj: SceneObject, prev: Brush): Step {
  try {
    // Each half-space sizes itself from the solid it is actually cutting, so it
    // covers whatever the features grew and reaches back from a plane parked
    // far outside the object.
    const { brush, owned } = applyCuts(prev, obj.cuts, obj.id)
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
      return { id: obj.id, geometry: emptyGeometry(), paints: [obj.id], failed: [obj.id] }
    }
    slots.push({ key: keys[0], brush: welded.brush, owned: true, failed: welded.failed })
  }

  for (let i = slots.length - 1; i < obj.features.length; i++) {
    slots.push({
      key: keys[i + 1],
      ...applyFeature(obj.base, obj.features[i], slots[i].brush, obj.id),
    })
  }

  if (slots.length === obj.features.length + 1) {
    const prev = slots[slots.length - 1].brush
    slots.push({ key: keys[obj.features.length + 1], ...applyObjectCuts(obj, prev) })
  }

  if (slots.length === obj.features.length + 2) {
    const prev = slots[slots.length - 1].brush
    slots.push({ key: keys[keys.length - 1], ...applyErased(obj, prev) })
  }

  const failed: string[] = []
  for (const slot of slots) failed.push(...slot.failed)

  // Read off the LAST slot, which is the brush the viewport draws. Every
  // boolean along the way carried the paints of both its inputs forward and
  // dropped the ones nothing points at any more, so this is exactly the set of
  // solids with a face still showing.
  const last = slots[slots.length - 1].brush
  return { id: obj.id, geometry: last.geometry, paints: paintsOf(last), failed }
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
  paints: string[]
  failed: string[]
} {
  const welded = mergedBase(obj)
  if (!welded.brush) return { geometry: emptyGeometry(), paints: [obj.id], failed: [obj.id] }

  const failed: string[] = [...welded.failed]
  let current = welded.brush

  for (const feature of obj.features) {
    const step = applyFeature(obj.base, feature, current, obj.id)
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

  const holes = applyErased(obj, current)
  failed.push(...holes.failed)
  if (holes.owned) {
    disposeBrush(current)
    current = holes.brush
  }

  return { geometry: current.geometry, paints: paintsOf(current), failed }
}

/**
 * Copy a local-space geometry into world space.
 *
 * `applyMatrix4` routes the normals through `Matrix3.getNormalMatrix` -- the
 * inverse transpose -- instead of the full matrix. Transforming them directly
 * would add the translation to every normal, and a moved or turned object would
 * export with inverted shading.
 *
 * `keepGroups` is for geometry on its way back INTO a boolean, where the groups
 * are what say which solid each triangle came from. Everything else -- export,
 * above all -- wants the plain triangle soup that concatenates.
 */
function bakeWorld(
  geometry: BufferGeometry,
  matrix: Matrix4,
  keepGroups = false
): BufferGeometry {
  const copy = geometry.getIndex() ? geometry.toNonIndexed() : geometry.clone()
  // Same normalisation rule as brush.ts: an indexed base solid still carries
  // uvs, and nothing can be concatenated until every input is plain
  // position+normal triangle soup.
  normalizeGeometry(copy, keepGroups)
  copy.applyMatrix4(matrix)
  return copy
}

/**
 * Every object baked through its own transform and concatenated into one
 * world-space geometry, for export.
 *
 * ERASERS ARE LEFT OUT. One is a solid the user has aimed but not yet taken --
 * a translucent red ghost standing for material that is about to go -- and
 * writing it into a file would export the tool along with the work. Here rather
 * than at each of the four call sites, because "the scene, as one solid" is
 * exactly the question this answers and a ghost is not part of the answer.
 *
 * THE CALLER OWNS THE RESULT and must dispose it. It shares no buffer with the
 * cache, so disposing it never disturbs what is on screen.
 */
export function mergedGeometry(doc: Doc, result: EvalResult): BufferGeometry {
  const byId = new Map(result.objects.map((o) => [o.id, o.geometry]))

  const parts: BufferGeometry[] = []
  for (const obj of doc.objects) {
    if (obj.erase) continue
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

/**
 * The box an object's EVALUATED solid fills, in world space.
 *
 * Off the geometry rather than off `assemblyBounds`, which measures the base
 * and its merged parts analytically and so knows nothing of a boss standing
 * proud of the primitive or a cut that took half of it away. As a cheap reject
 * before a boolean, an under-reported box is the dangerous kind of wrong: it
 * says "these cannot touch" about a solid one of them is sitting inside.
 *
 * Uncached, so the caller pays a full replay. Meant for one-off answers -- is
 * this eraser anywhere near that object -- and not for anything per frame.
 */
export function worldBounds(obj: SceneObject): Box3 {
  const { geometry } = evaluateObject(obj)
  try {
    const world = bakeWorld(geometry, objectMatrix(obj.transform))
    try {
      // An object that failed to build has no vertices, and the box stays empty
      // -- which reports as intersecting nothing, exactly as it should.
      return new Box3().setFromBufferAttribute(world.getAttribute('position') as BufferAttribute)
    } finally {
      world.dispose()
    }
  } finally {
    geometry.dispose()
  }
}

/**
 * Below this, a subtraction took nothing worth keeping a hole for.
 *
 * Two evaluations of the same solid are not bit-identical once one of them has
 * an extra boolean in it -- the result is retriangulated, and the volume moves
 * in the last few digits. This sits far above that and far below a real bite:
 * the smallest solid the app can build is 0.1 across, which is a thousand times
 * this even if only a corner of it lands.
 */
const MIN_ERASE_VOLUME = 1e-6

/**
 * Did the second version of this object genuinely lose material to the first?
 *
 * Asked of the GEOMETRY, because a box overlap is not an intersection: an
 * eraser can share a bounding box with a solid and pass clean by it. An object
 * made to carry a hole that removes nothing is an object paying for a boolean
 * on every evaluation, for ever, to produce the shape it already had.
 */
export function removesMaterial(before: SceneObject, after: SceneObject): boolean {
  const was = evaluateObject(before)
  const wasVolume = signedVolume(was.geometry)
  was.geometry.dispose()

  const now = evaluateObject(after)
  const nowVolume = signedVolume(now.geometry)
  now.geometry.dispose()

  return wasVolume - nowVolume > MIN_ERASE_VOLUME
}

/** Drop every cached brush. Used when the document is replaced wholesale. */
export function resetEvaluator(): void {
  for (const slots of caches.values()) {
    for (const slot of slots) if (slot.owned) retired.push(slot.brush)
  }
  caches.clear()
  flushRetired()
  // Safe only here, and only after the flush: a paint stand-in has to outlive
  // every brush painted with it, or two brushes cut from the same solid would
  // hold different materials and their groups would stop merging.
  forgetPaints()
}
