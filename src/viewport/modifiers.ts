/**
 * What the keyboard is holding down right now, for the parts of the viewport
 * that have to react to it without owning it.
 *
 * Module-level and mutable, for the same reason `rotationIndicator` and
 * `snapIndicator` are: this is read from a frame loop, many times a second, and
 * routing it through a store would re-render the whole scene to answer a key
 * being held. It also outlives the event that sets it -- the gestures are
 * driven from a frame loop rather than from the event, so a flag read on the
 * next frame has to survive the one that wrote it.
 *
 * Its own module rather than a private in `Viewport`, so that anything drawn
 * inside the canvas can read it without an import running back round the cycle.
 */
export const modifiers = {
  /** Lifts an object being dragged instead of sliding it across the ground. */
  shift: false,
}

/**
 * Forget everything, for a window that has lost focus.
 *
 * A window that never sees the keyup would otherwise leave the flag stuck on,
 * and the next object drag would go vertical out of nowhere.
 *
 * Control used to live here too, holding the gizmo's plane quads up in place
 * of its ring. The modes retired that: in Move the quads simply stand, because
 * the ring they were competing with is drawn in another mode now.
 */
export function clearModifiers(): void {
  modifiers.shift = false
}
