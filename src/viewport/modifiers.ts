/**
 * What the keyboard is holding down right now, and whether a plane handle is in
 * hand -- for the parts of the viewport that have to react to either without
 * owning them.
 *
 * Module-level and mutable, for the same reason `rotationIndicator` and
 * `snapIndicator` are: these are read from frame loops, many times a second,
 * and routing them through a store would re-render the whole scene to answer a
 * key being held. They also outlive the events that set them -- the gestures
 * are driven from a frame loop rather than from the event, so a flag read on
 * the next frame has to survive the one that wrote it.
 *
 * Its own module rather than a private in `Viewport`, because the gizmo reads
 * it too and `Viewport` is downstream of the gizmo: the import would run the
 * other way round the cycle.
 */
export const modifiers = {
  /** Lifts an object being dragged instead of sliding it across the ground. */
  shift: false,
  /**
   * Swaps the gizmo's ring for its three plane handles.
   *
   * Meta counts as Control here. On a Mac the Control key is a right-click, and
   * the right button already means two things on this gizmo -- resize along an
   * arrow, turn from the ring -- so a Mac user pressing it would get a resize
   * rather than a plane. Command is the key they actually have free, and it is
   * already the one this app answers for copy, paste and undo.
   */
  ctrl: false,
}

/**
 * Whether a plane handle is currently being dragged.
 *
 * The handles are shown while Control is held, and a gesture must not lose its
 * own handle part-way through because a finger came off a key. Latched at the
 * grab and released when the gesture ends, so the planes stay up for exactly as
 * long as one of them is being pulled -- and the ring does not spring back
 * under the pointer mid-drag.
 *
 * Not a field on `modifiers`: nothing here is a key, and the two are cleared at
 * different moments.
 */
export const planeHandles = { held: false }

/**
 * Forget everything, for a window that has lost focus.
 *
 * A window that never sees the keyup would otherwise leave a flag stuck on, and
 * the next object drag would go vertical, or the next gizmo come up wearing
 * planes, out of nowhere.
 */
export function clearModifiers(): void {
  modifiers.shift = false
  modifiers.ctrl = false
  planeHandles.held = false
}
