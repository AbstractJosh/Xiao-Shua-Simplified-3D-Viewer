import type { Doc } from '../geometry/types'
import type { BrushScope } from '../store/toolStore'

/**
 * Whether the armed brush is allowed to work this object.
 *
 * Its own module because THREE things have to agree about it and any two of
 * them drifting is a bug the user experiences as the tool lying: the ghost,
 * which promises what a press would do; the press itself, which has to fall
 * through to ordinary selection on an object the brush may not touch, or
 * "Selected only" would leave no way to select anything; and the stroke, which
 * must not work a solid the ghost was never drawn on.
 *
 * ONE RULE FOR BOTH BRUSHES, and not merely because they happen to share a
 * scope setting. The rule is about what a brush may be pointed at, and neither
 * the blowtorch nor the sculpt tool has a claim the other lacks -- so a second
 * copy of it, phrased for adding material instead of removing it, would be a
 * second thing to keep in step with the first for no benefit at all.
 *
 * An ERASER is never a target whatever the scope says. It is a tool sitting in
 * the scene rather than a solid -- it exists to be aimed and consumed -- and
 * melting one would be melting the knife instead of the bread.
 *
 * Pure, and given the pieces rather than reading a store, so a check can state
 * the rule without a document or a pointer.
 */
export function brushAllows(
  doc: Doc,
  selectedObjectIds: readonly string[],
  scope: BrushScope,
  objectId: string
): boolean {
  const object = doc.objects.find((o) => o.id === objectId)
  if (!object || object.erase) return false
  if (scope === 'all') return true
  return selectedObjectIds.includes(objectId)
}
