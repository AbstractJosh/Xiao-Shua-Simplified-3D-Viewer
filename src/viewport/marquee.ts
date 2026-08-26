import { Vector3 } from 'three'
import type { Camera } from 'three'
import { create } from 'zustand'
import { assemblyAnchor } from '../geometry/assembly'
import type { SceneObject } from '../geometry/types'

/**
 * The rubber-band selection: the box the pointer is drawing, and the arithmetic
 * that decides what falls inside it.
 *
 * The store lives beside the viewport rather than in `src/store` for the same
 * reason the object menu's does -- it IS the gesture, and nothing outside the
 * viewport has any business knowing a box is being drawn. What the gesture
 * PRODUCES is a selection, and that belongs to the document store like every
 * other selection, so there is still exactly one answer to "what is selected".
 *
 * Coordinates are CLIENT space throughout, because that is what a pointer event
 * hands over and what the overlay rectangle is positioned in. The one place
 * that leaves client space is the projection below, and it converts INTO client
 * space rather than dragging the box down into the canvas's.
 */

/** The two corners the gesture has produced, press point first. */
export type MarqueeBox = { x0: number; y0: number; x1: number; y1: number }

/** The same box sorted, so left <= right and top <= bottom. */
export type ScreenBox = { left: number; top: number; right: number; bottom: number }

/**
 * How far the pointer must travel before the press reads as a box rather than
 * as a click on empty space.
 *
 * A press below this draws nothing and gathers nothing -- it is the click that
 * clears the selection, which is what pressing empty space has always done. The
 * threshold is small because the box is drawn live: anything larger and the
 * rectangle would jump into existence some distance from where it was started.
 */
export const MARQUEE_SLOP = 3

/** The longer side of the box, which is what the slop is judged against. */
export function boxSpan(box: MarqueeBox): number {
  return Math.max(Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
}

export function normaliseBox(box: MarqueeBox): ScreenBox {
  return {
    left: Math.min(box.x0, box.x1),
    right: Math.max(box.x0, box.x1),
    top: Math.min(box.y0, box.y1),
    bottom: Math.max(box.y0, box.y1),
  }
}

/** The canvas rectangle, in the shape a `DOMRect` already has. */
export type ViewRect = { left: number; top: number; width: number; height: number }

const projected = new Vector3()

/**
 * Where an object's gizmo lands on screen, or null when it is not in front of
 * the camera at all.
 *
 * The GIZMO point, not the bounding box and not the object's transform: it is
 * the one dot the user can already see standing for the whole object -- dead
 * centre of a merged assembly as much as of a bare solid -- so "did the box
 * catch it" is a question they can answer by looking, before they let go.
 *
 * The z guard is the whole of "not in the view". A point behind the camera
 * still projects, to z > 1 and with x and y mirrored through the origin, so
 * taking the result at face value would let a box drawn on empty sky gather up
 * the solids standing behind the user.
 */
export function centreOnScreen(
  object: SceneObject,
  camera: Camera,
  rect: ViewRect
): { x: number; y: number } | null {
  const [x, y, z] = assemblyAnchor(object)
  projected.set(x, y, z).project(camera)
  if (projected.z < -1 || projected.z > 1) return null
  return {
    x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
    // NDC y climbs toward the top of the screen and client y falls, so the
    // half-span is subtracted rather than added.
    y: rect.top + (projected.y * -0.5 + 0.5) * rect.height,
  }
}

/**
 * Every object whose centre falls inside the box, in DOCUMENT order.
 *
 * Document order rather than the order the box swept them up in, because the
 * head of the list is the primary selection -- the one that keeps the gizmo and
 * the one a merge folds everything else into -- and a primary that depended on
 * which corner the drag started from would be a rule nobody could hold.
 */
export function objectsInBox(
  objects: SceneObject[],
  box: ScreenBox,
  camera: Camera,
  rect: ViewRect
): string[] {
  const inside: string[] = []
  for (const object of objects) {
    const at = centreOnScreen(object, camera, rect)
    if (!at) continue
    if (at.x < box.left || at.x > box.right) continue
    if (at.y < box.top || at.y > box.bottom) continue
    inside.push(object.id)
  }
  return inside
}

/**
 * The selection a box produces, given what was already selected.
 *
 * Additive is what Shift means everywhere else in the viewport -- shift-click
 * gathers objects one at a time, and this is the same gesture with a box -- so
 * the existing selection leads and the newcomers follow. That ordering is not
 * incidental: it keeps the primary where the user left it, so sweeping up three
 * more solids does not move the gizmo or change what a merge would fold into.
 */
export function selectionFor(base: string[], inside: string[], additive: boolean): string[] {
  if (!additive) return inside
  const already = new Set(base)
  return [...base, ...inside.filter((id) => !already.has(id))]
}

/**
 * Everything about a pointer-down that decides whose gesture it is.
 *
 * A plain record rather than the event, so the rule below can be read -- and
 * checked -- without a DOM. `hits` is how many scene objects R3F's raycast found
 * under the press; `dragging` is whether the document already has a gesture in
 * flight.
 */
export type Press = {
  button: number
  pointerType: string
  altKey: boolean
  onCanvas: boolean
  hits: number
  dragging: boolean
}

/**
 * Whether the marquee, rather than the camera or something in the scene, owns
 * this press.
 *
 * Every clause is a gesture the left button already meant, and the box is only
 * allowed what is left over.
 */
export function claimsPress(press: Press): boolean {
  // Left button only, and never the one-finger touch that turns the camera --
  // there is no second button on a touchscreen to move orbit onto.
  if (press.button !== 0 || press.pointerType === 'touch') return false
  // Alt is the camera's: it is what puts orbit back on the left button, which
  // this gesture otherwise takes.
  if (press.altKey) return false
  // The overlays inside the viewport -- the hint, the object menu, the box
  // itself -- are not the canvas, and a press on one of them is not a press in
  // the scene.
  if (!press.onCanvas) return false
  // A press that landed on a solid, a gizmo, a sketch or a face handle belongs
  // to that thing.
  if (press.hits > 0) return false
  // A solid or a sketch dragged in from the console already owns the pointer,
  // even though the press that started it never touched the canvas.
  if (press.dragging) return false
  return true
}

type MarqueeState = {
  /** The box being drawn, or null when no marquee is running. */
  box: MarqueeBox | null
  /**
   * The selection the gesture started from.
   *
   * Kept because the marquee applies its result LIVE -- that is what makes the
   * highlight follow the box -- so the state it is adding to, and the state
   * Escape has to put back, are both gone the moment the first pointer move
   * lands.
   */
  base: string[]
  begin: (x: number, y: number, base: string[]) => void
  to: (x: number, y: number) => void
  clear: () => void
}

export const useMarquee = create<MarqueeState>((set) => ({
  box: null,
  base: [],
  begin: (x, y, base) => set({ box: { x0: x, y0: y, x1: x, y1: y }, base }),
  to: (x, y) => set((s) => (s.box ? { box: { ...s.box, x1: x, y1: y } } : {})),
  clear: () => set({ box: null, base: [] }),
}))
