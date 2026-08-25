import type { BufferGeometry } from 'three'
import type { Brush } from 'three-bvh-csg'
import {
  ADDITION,
  INTERSECTION,
  SUBTRACTION,
  csg,
  disposeBrush,
  makeBrush,
} from './brush'
import { buildSweptPrism, outlineOnSurface } from './prism'
import { anchorIsCurved, hostSurfaceFor, surfaceFor } from './surfaces'
import type { BaseSolid, Doc, Feature } from './types'

export type EvalResult = {
  geometry: BufferGeometry
  /** Features that could not be applied; surfaced in the UI, never thrown. */
  failed: string[]
  /** Wall-clock cost of the boolean work, used to decide on ghost previews. */
  millis: number
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
 */
function buildTool(base: BaseSolid, feature: Feature): Brush | null {
  const host = hostSurfaceFor(base, feature.anchor)
  const ring = outlineOnSurface(host, feature.anchor, feature)
  const { tIn, tOut } = host.sweep(feature.anchor, feature.depth, feature.op)
  const prism = buildSweptPrism(ring, tIn, tOut)
  if (!prism) return null

  if (!anchorIsCurved(feature.anchor)) return makeBrush(prism)

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
// cache[i] holds the brush after applying features[0..i-1], so editing feature
// k only replays k onward. Keys are cheap because the document is plain data.

/**
 * `owned` distinguishes a slot that allocated its own brush from one that just
 * carries the previous slot's brush forward (an inert feature changes nothing).
 * Without it, invalidating an aliased slot would dispose a geometry an earlier
 * slot still holds -- and the viewport would render a freed buffer.
 */
type CacheSlot = { key: string; brush: Brush; owned: boolean }

let cache: CacheSlot[] = []
/** Disposal is deferred one generation so a geometry is never freed in the
 *  same tick that React might still be rendering it. */
let retired: Brush[] = []

function featureKey(f: Feature): string {
  return isInert(f) ? 'inert' : JSON.stringify(f)
}

function flushRetired(): void {
  for (const brush of retired) disposeBrush(brush)
  retired = []
}

export function evaluateDoc(doc: Doc): EvalResult {
  const started = performance.now()
  flushRetired()

  const keys: string[] = [JSON.stringify(doc.base)]
  for (const f of doc.features) {
    keys.push(`${keys[keys.length - 1]}|${featureKey(f)}`)
  }

  // Longest cached prefix that still matches.
  let reuse = 0
  while (reuse < cache.length && reuse < keys.length && cache[reuse].key === keys[reuse]) {
    reuse++
  }
  for (let i = reuse; i < cache.length; i++) {
    if (cache[i].owned) retired.push(cache[i].brush)
  }
  cache = cache.slice(0, reuse)

  if (cache.length === 0) {
    cache.push({
      key: keys[0],
      brush: makeBrush(surfaceFor(doc.base).geometry()),
      owned: true,
    })
  }

  const failed: string[] = []
  for (let i = cache.length - 1; i < doc.features.length; i++) {
    const feature = doc.features[i]
    const prev = cache[i].brush
    let next = prev
    let owned = false

    if (!isInert(feature)) {
      try {
        const tool = buildTool(doc.base, feature)
        if (tool) {
          next = csg(prev, tool, feature.op === 'extrude' ? ADDITION : SUBTRACTION)
          owned = true
          disposeBrush(tool)
        } else {
          failed.push(feature.id)
        }
      } catch (err) {
        // A malformed tool must never take the whole document down; skip the
        // feature, keep the solid, and let the UI flag it.
        console.warn(`[EZ3D] feature ${feature.id} failed to evaluate`, err)
        failed.push(feature.id)
        next = prev
      }
    }

    cache.push({ key: keys[i + 1], brush: next, owned })
  }

  return {
    geometry: cache[cache.length - 1].brush.geometry,
    failed,
    millis: performance.now() - started,
  }
}

/** Drop every cached brush. Used when the document is replaced wholesale. */
export function resetEvaluator(): void {
  for (const slot of cache) if (slot.owned) retired.push(slot.brush)
  cache = []
  flushRetired()
}
