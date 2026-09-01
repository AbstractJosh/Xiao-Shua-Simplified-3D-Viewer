import { Box3, BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three'
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
import { erodeGeometry } from './erode'
import { buildSweptPrism, endPlaneFor, outlineOnSurface } from './prism'
import { anchorIsCurved, hostSurfaceFor, surfaceFor } from './surfaces'
import { objectMatrix } from './transform'
import { signedVolume } from './volume'
import { sweepOp } from './types'
import type {
  BaseSolid,
  CutPlane,
  Doc,
  ErodeDab,
  ErodeStamp,
  Feature,
  SceneObject,
} from './types'
import { LOG_TAG } from '../appInfo'

/**
 * The scene is a pure function of the `Doc`. Per object the pipeline is
 * base -> merged parts -> features in order -> cuts -> erasers -> melting, and
 * every stage of it runs in OBJECT-LOCAL space. The transform enters exactly
 * once, in `mergedGeometry`, because the viewport draws each object inside a
 * group that already carries it -- so dragging an object costs no boolean work
 * at all.
 *
 * That order is the DEFAULT rather than a law: the melting is spliced back into
 * it at the point each stroke was actually laid down. See `planSteps`.
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
// slots[0] holds the base brush and slots[i + 1] the brush after step i of the
// plan, so editing step k replays k onward and nothing before it. Keys are
// cheap because the document is plain data.
//
// The cache is keyed PER OBJECT: editing feature k of object B must not touch
// object A's brushes, let alone free the GPU buffer the viewport is drawing for
// it. No key mentions the object transform -- geometry is local space, so
// moving an object never invalidates anything.

/**
 * `owned` distinguishes a slot that allocated its own brush from one that just
 * carries the previous slot's brush forward (an inert feature, a failed tool,
 * or a melt with nothing to melt change nothing). Without it, invalidating an
 * aliased slot would dispose a geometry an earlier slot still holds -- and the
 * viewport would render a freed buffer.
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

// --- The plan ---------------------------------------------------------------

/** How far the object had got when a dab was laid. Absent means all of it. */
function stampOf(obj: SceneObject, dab: ErodeDab): ErodeStamp {
  return (
    dab.stamp ?? {
      parts: obj.parts.length,
      features: obj.features.length,
      cuts: obj.cuts.length,
      erased: obj.erased?.length ?? 0,
    }
  )
}

function sameStamp(a: ErodeStamp, b: ErodeStamp): boolean {
  return (
    a.parts === b.parts &&
    a.features === b.features &&
    a.cuts === b.cuts &&
    a.erased === b.erased
  )
}

/**
 * The dabs split into RUNS: each a maximal block of consecutive dabs that were
 * all laid against the same shape of object.
 *
 * Melted as a block rather than one at a time, and that is not only a saving.
 * `erodeGeometry` welds, refines and relaxes ONCE for the set it is handed --
 * so a stroke of forty dabs replayed as forty separate melts would not merely
 * cost forty times as much, it would come out a different, coarser surface.
 * Grouping is what keeps a stamp from changing the geometry of a solid nobody
 * has edited since: with nothing added after the strokes, every dab carries the
 * same stamp, there is one run, and the melt is bit for bit the one that ran
 * before any of this existed.
 */
function meltRuns(obj: SceneObject): { stamp: ErodeStamp; dabs: ErodeDab[] }[] {
  const runs: { stamp: ErodeStamp; dabs: ErodeDab[] }[] = []
  for (const dab of obj.erosion ?? []) {
    const stamp = stampOf(obj, dab)
    const last = runs[runs.length - 1]
    if (last && sameStamp(last.stamp, stamp)) last.dabs.push(dab)
    else runs.push({ stamp, dabs: [dab] })
  }
  return runs
}

/** One step of the build: what it contributes to the key, and what it does. */
type PlanStep = { key: string; apply: (prev: Brush) => Step }

/**
 * The whole build of one object, in order: a list of steps that each take the
 * brush so far and hand back the next one.
 *
 * The DEFAULT order is the one the pipeline has always run in -- merged parts,
 * then features, then cuts, then erasers, then the melting -- and for an object
 * nobody has torched that is exactly the list this produces, one step per item
 * instead of one slot per stage.
 *
 * What this adds is that the MELTING IS SPLICED BACK IN WHERE IT HAPPENED. Each
 * run of dabs carries the counts the object had when they were laid (see
 * `ErodeStamp`), so the steps needed to reach that shape are emitted, then the
 * melt, and only then whatever was added afterwards. A solid merged in after a
 * melt welds onto the melted surface rather than being melted by it, and a boss
 * grown after a melt grows out of the melted face rather than coming out
 * pre-melted. Both were the same bug, and it was the fixed position of one
 * stage that caused it.
 *
 * ONE STEP PER PART, PER CUT AND PER HOLE rather than one per stage, because a
 * melt can now land in the middle of any of the three -- merge, torch, merge
 * again, and the second weld has to happen after the melting that the first one
 * predates. It buys finer caching for free: welding a second part no longer
 * re-welds the first.
 *
 * `done` only ever climbs, and every limit is clamped to the list it indexes.
 * So a stamp that points past the end of a list it outlived -- delete a feature
 * after melting and it does -- builds what is actually there and stops, and a
 * stamp that somehow points BACKWARDS is a step already emitted rather than a
 * step emitted twice.
 */
function planSteps(obj: SceneObject): PlanStep[] {
  const erased = obj.erased ?? []
  const steps: PlanStep[] = []
  const done = { parts: 0, features: 0, cuts: 0, erased: 0 }

  const buildTo = (limit: ErodeStamp): void => {
    for (; done.parts < Math.min(limit.parts, obj.parts.length); done.parts++) {
      const part = obj.parts[done.parts]
      steps.push({ key: `part:${structureOf([part])}`, apply: (prev) => weldPart(prev, part) })
    }
    const features = Math.min(limit.features, obj.features.length)
    for (; done.features < features; done.features++) {
      const feature = obj.features[done.features]
      steps.push({
        key: featureKey(feature),
        apply: (prev) => applyFeature(obj.base, feature, prev, obj.id),
      })
    }
    for (; done.cuts < Math.min(limit.cuts, obj.cuts.length); done.cuts++) {
      const cut = obj.cuts[done.cuts]
      steps.push({
        key: `cut:${JSON.stringify(cut)}`,
        apply: (prev) => applyOneCut(prev, cut, obj.id),
      })
    }
    for (; done.erased < Math.min(limit.erased, erased.length); done.erased++) {
      const hole = erased[done.erased]
      steps.push({
        key: `erased:${structureOf([hole])}`,
        apply: (prev) => subtractHole(prev, hole, obj.id),
      })
    }
  }

  for (const run of meltRuns(obj)) {
    buildTo(run.stamp)
    // Its own step, so a stroke in flight replays the melting and nothing else:
    // every boolean the object is built from stays cached through a drag that
    // adds a dab on every frame.
    steps.push({
      key: `erosion:${JSON.stringify(run.dabs)}`,
      apply: (prev) => applyMelt(prev, run.dabs, obj.id),
    })
  }
  buildTo({
    parts: obj.parts.length,
    features: obj.features.length,
    cuts: obj.cuts.length,
    erased: erased.length,
  })

  return steps
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
 * Weld one merged part onto the solid so far.
 *
 * A part is a whole SceneObject in this object's local space, so it is
 * evaluated exactly the way a top-level object is -- base, then its features,
 * then its cuts, then its own melting -- and only then baked through its local
 * transform and unioned in. Recursion falls out of that: a part that was itself
 * a merge brings its own parts with it, and nothing had to be flattened at
 * merge time. It is also why a melted solid absorbed AS a part was never the
 * half of this bug that showed: its dabs run inside its own evaluation, and
 * arrive here already baked into the triangles.
 *
 * Each solid goes in under its OWN paint -- the host under its id, every part
 * under the part's -- and the union carries those through as groups. That is
 * what lets a merge of a red cube and a blue one come back red and blue.
 *
 * `prev` is NOT disposed. Every step in the plan leaves that to whoever owns
 * the chain: the cache defers it a generation, `evaluateObject` does it as it
 * goes, and a step that did it itself would free a brush a live cache slot is
 * still holding.
 */
/**
 * How much a part is swollen before it is unioned in. Relative to its own size,
 * so a bead and a wall are nudged off the degenerate point by the same amount
 * of their own extent rather than by the same absolute distance.
 *
 * At the app's ten centimetres to the unit this is half a micron on a
 * hand-sized part -- below any printer, any screen, and any dimension the
 * inspector will ever show. See `swell` for what it buys.
 */
const WELD_SWELL = 1e-6

/**
 * Grow a part a hair about its own centre, so a flush contact becomes an
 * overlapping one.
 *
 * WHY A BOOLEAN NEEDS THIS. The union asks one question of every triangle: is
 * it inside the other solid, or outside it. That question has an answer
 * everywhere except exactly ON the other surface, and two faces laid flush
 * against each other are nothing but that case. The splitter cannot cut a
 * triangle against a plane it already lies in, so it falls back to clipping
 * against the other triangle's EDGES -- three planes per triangle -- and
 * nothing it produces can be discarded as interior, because every piece sits
 * exactly on the boundary. A 32-triangle cylinder cap laid on a 2-triangle box
 * face turned twelve triangles into 1,866, all of them slivers.
 *
 * The app walks users straight into it: snapping "lands the solid flush against"
 * a neighbour's face by design -- see `snapping.ts` -- so the exact coplanarity
 * that detonates the boolean is the thing the placement tools aim for.
 *
 * SWOLLEN RATHER THAN SHRUNK, and the direction is the whole of the choice. A
 * union of two solids that overlap is a well-posed question with a robust
 * answer; a union of two that merely touch is the degenerate one above; and a
 * union of two separated by even a hair is two shells that a merge was supposed
 * to weld into one. Growing can only ever turn a touch into an overlap, so it
 * moves every contact off the bad case and none of them into a worse one.
 *
 * THE DOCUMENT IS NOT TOUCHED. This runs on the baked tool geometry on its way
 * into the boolean, so what the user placed, what the inspector reports and what
 * a reopened file rebuilds are all still exactly the numbers they typed.
 */
function swell(geom: BufferGeometry): void {
  geom.computeBoundingBox()
  const box = geom.boundingBox
  if (!box) return
  const at = box.getCenter(new Vector3())
  const k = 1 + WELD_SWELL
  geom.applyMatrix4(
    new Matrix4()
      .makeTranslation(at.x, at.y, at.z)
      .multiply(new Matrix4().makeScale(k, k, k))
      .multiply(new Matrix4().makeTranslation(-at.x, -at.y, -at.z))
  )
}

function weldPart(prev: Brush, part: SceneObject): Step {
  const failed: string[] = []
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
    // Off the degenerate point before the boolean ever sees it. See `swell`.
    swell(welded)
    tool = makeBrush(welded, evaluated.paints)
    return { brush: csg(prev, tool, ADDITION), owned: true, failed }
  } catch (err) {
    console.warn(`[${LOG_TAG}] merged part ${part.id} failed to weld`, err)
    failed.push(part.id)
    return { brush: prev, owned: false, failed }
  } finally {
    if (tool) disposeBrush(tool)
    else welded?.dispose()
  }
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
 * Take one erased solid out of the object.
 *
 * The walls the eraser opens up wear the object's OWN paint, the same rule a
 * pocket's walls and a cut's face already follow: the hole belongs to the
 * object rather than to any one solid inside it, and an eraser has no colour of
 * its own to lend -- it is not in the scene any more by the time this runs.
 */
function subtractHole(prev: Brush, hole: SceneObject, paint: string): Step {
  const failed: string[] = []
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
    tool = makeBrush(baked, paint)
    return { brush: csg(prev, tool, SUBTRACTION), owned: true, failed }
  } catch (err) {
    console.warn(`[${LOG_TAG}] erased solid ${hole.id} failed to subtract`, err)
    failed.push(hole.id)
    return { brush: prev, owned: false, failed }
  } finally {
    if (tool) disposeBrush(tool)
    else baked?.dispose()
  }
}

/**
 * Melt the surface wherever one run of the torch has been.
 *
 * The one step here that is NOT a boolean. It moves the vertices of the
 * geometry it is handed rather than cutting a tool out of it -- see `erode.ts`
 * for why a sphere subtraction is the wrong shape of answer for a blowtorch.
 * The result is wrapped back into a brush anyway, so this step looks like every
 * other step to the cache and to `paintsOf`; the paints come across untouched,
 * since melting never changes which solid a triangle belongs to, only where it
 * is.
 *
 * That wrapping is load-bearing now in a way it was not when the melting always
 * ran last: a merge or an extrude can follow it, so the melted surface goes
 * back INTO the boolean evaluator. `erodeGeometry` welds and stitches its
 * output for exactly that reason, and a weld that came out too torn to cut
 * against costs the step that follows rather than this one -- every step in the
 * plan keeps the previous brush when its own work throws.
 *
 * An object nobody has torched never reaches here at all: `planSteps` emits no
 * melt step, so it pays nothing -- not even a copy.
 */
function applyMelt(prev: Brush, dabs: ErodeDab[], objectId: string): Step {
  try {
    const melted = erodeGeometry(prev.geometry, dabs)
    // Null means there was nothing to melt -- an object that evaluated to no
    // triangles at all. Keep what we have rather than reporting a failure the
    // user can do nothing about.
    if (!melted) return { brush: prev, owned: false, failed: [] }
    return { brush: makeBrush(melted, paintsOf(prev)), owned: true, failed: [] }
  } catch (err) {
    // Same bargain the features strike: a stroke that cannot be applied must
    // not take the object down with it. Keep the unmelted solid and flag it.
    console.warn(`[${LOG_TAG}] erosion on object ${objectId} failed`, err)
    return { brush: prev, owned: false, failed: [objectId] }
  }
}

function applyOneCut(prev: Brush, cut: CutPlane, paint: string): Step {
  try {
    // The half-space sizes itself from the solid it is actually cutting, so it
    // covers whatever the features grew and reaches back from a plane parked
    // far outside the object.
    const { brush, owned } = applyCuts(prev, [cut], paint)
    return { brush, owned, failed: [] }
  } catch (err) {
    console.warn(`[${LOG_TAG}] cut ${cut.id} failed to evaluate`, err)
    return { brush: prev, owned: false, failed: [cut.id] }
  }
}

function evaluateCached(obj: SceneObject): ObjectEval {
  const plan = planSteps(obj)
  // Cumulative, so a key names the whole history that produced its slot rather
  // than the one step at the end of it: a step whose own key is unchanged still
  // has to be replayed when something before it moved.
  const keys: string[] = [JSON.stringify(obj.base)]
  for (const step of plan) keys.push(`${keys[keys.length - 1]}|${step.key}`)

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
    const base = baseBrush(obj.base, obj.id)
    if (!base) {
      caches.delete(obj.id)
      return { id: obj.id, geometry: emptyGeometry(), paints: [obj.id], failed: [obj.id] }
    }
    slots.push({ key: keys[0], brush: base, owned: true, failed: [] })
  }

  // One slot per plan step, replayed from wherever the cached prefix ran out.
  for (let i = slots.length - 1; i < plan.length; i++) {
    slots.push({ key: keys[i + 1], ...plan[i].apply(slots[i].brush) })
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
  const base = baseBrush(obj.base, obj.id)
  if (!base) return { geometry: emptyGeometry(), paints: [obj.id], failed: [obj.id] }

  const failed: string[] = []
  let current = base

  // The SAME plan the cache walks, so the two paths cannot disagree about what
  // an object is -- which matters most for the one thing only the plan knows:
  // where in the chain each run of the torch belongs.
  for (const step of planSteps(obj)) {
    const applied = step.apply(current)
    failed.push(...applied.failed)
    // An unowned step aliases `current`; disposing it would free the brush the
    // step just handed back.
    if (!applied.owned) continue
    disposeBrush(current)
    current = applied.brush
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
 * the smallest solid the app can build is 0.01 across -- a millionth of a cubic
 * unit -- which is a thousand times this even if only a corner of it lands.
 *
 * It moved with `MIN_DIMENSION`, and had to: volume is cubic, so dropping the
 * smallest legal solid from 0.1 to 0.01 across took its volume from 1e-3 to
 * 1e-6. Left at the old 1e-6 this would have sat exactly ON the smallest
 * possible bite, and a one-millimetre eraser would have reported removing
 * nothing at all.
 */
const MIN_ERASE_VOLUME = 1e-9

/**
 * And a RELATIVE floor beside it, because the noise this is trying to clear is
 * itself proportional to the volume being measured.
 *
 * The two evaluations differ by a boolean, so the vertices it created are new
 * ones, quantised by float32 at whatever magnitude the solid sits at. The
 * resulting wobble goes as (changed area) x (float32 step) -- both linear in
 * size -- so it lands at roughly a billionth of the volume itself, whatever
 * that volume is. A fixed floor cannot straddle that: 1e-9 is right for a
 * millimetre cube and pure noise for a five-metre one, where the same
 * arithmetic wobbles by about 1e-4 and every eraser that MISSED would report a
 * bite.
 *
 * A hundred times the noise. At a volume of 8 -- the two-unit cube this
 * constant was originally hand-tuned against -- it works out at 8e-7, which is
 * the 1e-6 that used to be written here. The old absolute number was a relative
 * one in disguise. `cut.ts` has been doing it this way all along; see
 * `MIN_HALF_FRACTION`.
 */
const MIN_ERASE_FRACTION = 1e-7

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

  return (
    wasVolume - nowVolume >
    Math.max(MIN_ERASE_VOLUME, Math.abs(wasVolume) * MIN_ERASE_FRACTION)
  )
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
