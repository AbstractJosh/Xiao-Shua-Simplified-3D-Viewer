import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { canParent, descendantIds } from '../geometry/hierarchy'
import type { SceneObject } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { useLibrary } from '../store/libraryStore'
import { useParentPick } from './ParentPick'

/**
 * The right-click menu on an object, and the little bit of state that opens it.
 *
 * The store lives beside the component rather than in `src/store` because it IS
 * the menu -- nothing else in the app has any business knowing whether one is
 * open, and the only things that open it are a right-click on a solid and a
 * right-click on that solid's row in the Scene list. Both open the SAME menu:
 * an object is one thing whichever end of the screen it was reached from.
 *
 * Position is in CLIENT coordinates, since that is what a pointer event hands
 * over and the menu is a plain DOM overlay rather than anything in the scene.
 */
type MenuState = {
  menu: { x: number; y: number; objectId: string } | null
  openMenu: (x: number, y: number, objectId: string) => void
  closeMenu: () => void
}

export const useObjectMenu = create<MenuState>((set) => ({
  menu: null,
  openMenu: (x, y, objectId) => set({ menu: { x, y, objectId } }),
  closeMenu: () => set({ menu: null }),
}))

/**
 * How far the pointer may travel between pressing the right button and letting
 * it go before the gesture counts as a drag rather than a click.
 *
 * The right button already means two things in the viewport -- pan the camera,
 * and resize or turn from the gizmo -- and the context menu arrives on RELEASE,
 * by which time a pan has usually finished. Without this, every right-drag that
 * happened to start on a solid would end with a menu in the middle of it.
 */
export const CLICK_SLOP = 5

/** The least daylight the menu keeps between itself and the window's edge. */
const EDGE = 4

let pressedAt: { x: number; y: number } | null = null

/** Record where a right-press landed, so its release can be judged against it. */
export function noteRightPress(x: number, y: number): void {
  pressedAt = { x, y }
}

/** Whether the release at (x, y) still counts as a click on the same spot. */
export function isRightClick(x: number, y: number): boolean {
  if (!pressedAt) return false
  return Math.abs(x - pressedAt.x) <= CLICK_SLOP && Math.abs(y - pressedAt.y) <= CLICK_SLOP
}

/**
 * Say outright that this press has become a drag, whatever the pixels claim.
 *
 * THE DISTANCE TEST CANNOT SEE A LOCKED POINTER. Game Controls take the mouse
 * away from the window once a right-drag is plainly a look -- that is what
 * stops the cursor reaching the edge of the screen and stopping the turn -- and
 * a captured pointer reports the same `clientX` and `clientY` for the whole
 * gesture, because there is no longer a cursor anywhere for them to describe.
 * Measured on those, a hundred-and-eighty-degree turn releases within a pixel
 * of where it started and the menu opens over the middle of it.
 *
 * So the gesture that knows says so. See `GameControls`, which calls this the
 * moment a look passes the same slop the menu judges by -- which is also the
 * moment it takes the pointer. Nothing else calls it, and with the mode off
 * nothing does: the distance test is exactly right when there is a cursor to
 * measure.
 */
export function cancelRightPress(): void {
  pressedAt = null
}

/**
 * The menu itself: a DOM overlay, not part of the scene.
 *
 * Rendered as a sibling of the canvas so it is unaffected by the camera and
 * legible at any zoom -- a menu drawn in the scene would scale, turn and end up
 * behind the solid it belongs to.
 */
export function ObjectMenu() {
  const menu = useObjectMenu((s) => s.menu)
  const closeMenu = useObjectMenu((s) => s.closeMenu)
  const object = useDoc((s) => s.doc.objects.find((o) => o.id === menu?.objectId) ?? null)
  const objects = useDoc((s) => s.doc.objects)
  const selectedObjectIds = useDoc((s) => s.selectedObjectIds)
  const pasteObject = useDoc((s) => s.pasteObject)
  const clearParent = useDoc((s) => s.clearParent)
  const beginPick = useParentPick((s) => s.begin)
  const clipboard = useLibrary((s) => s.clipboard)
  const clipboardTree = useLibrary((s) => s.clipboardTree)
  const copyObject = useLibrary((s) => s.copyObject)
  const saveCustom = useLibrary((s) => s.saveCustom)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    // Capture, so a press that lands on a solid closes the menu before that
    // press starts dragging the solid -- otherwise the menu would sit open over
    // an object being moved.
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) closeMenu()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    // Scrolling the console or turning the camera would leave the menu pinned
    // to a point that no longer means anything.
    window.addEventListener('wheel', closeMenu, { passive: true })
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('wheel', closeMenu)
      window.removeEventListener('blur', closeMenu)
    }
  }, [menu, closeMenu])

  // KEPT ON SCREEN. The menu opens with its corner at the pointer, and a
  // right-click on a Scene row sits against the window's right edge -- low in a
  // long list, against its bottom edge as well -- where a corner at the pointer
  // would put most of the menu off the screen. Measured once it is drawn, and
  // pulled back in by however much it overhangs; before paint, so it is never
  // seen in the wrong place.
  useLayoutEffect(() => {
    const el = root.current
    if (!menu || !el) return
    const box = el.getBoundingClientRect()
    const x = Math.max(EDGE, Math.min(menu.x, window.innerWidth - box.width - EDGE))
    const y = Math.max(EDGE, Math.min(menu.y, window.innerHeight - box.height - EDGE))
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [menu])

  // The object it was opened on can be deleted from under it -- by the Delete
  // key, or by an undo -- and a menu offering to copy something that is gone is
  // worse than no menu.
  if (!menu || !object) return null

  // What rides on it, in tree order: what "Copy Parent Tree" takes along.
  const riding = descendantIds(objects, object.id)
  const riders: SceneObject[] = objects.filter((o) => riding.has(o.id))
  // The objects a parent is about to be chosen FOR. The whole selection when
  // the menu was opened on part of it -- the same reading Delete and Merge give
  // a selection -- and otherwise the one object under the pointer.
  const waiting = selectedObjectIds.includes(object.id) ? selectedObjectIds : [object.id]
  // Somewhere for it to go: some other object in the scene it could ride on.
  const canChoose = objects.some((o) => canParent(objects, object.id, o.id))

  const item = (label: string, hint: string, enabled: boolean, run: () => void) => (
    <button
      type="button"
      className="menu-item"
      disabled={!enabled}
      onClick={() => {
        run()
        closeMenu()
      }}
    >
      <span className="menu-label">{label}</span>
      <span className="menu-hint">{hint}</span>
    </button>
  )

  return (
    <div
      ref={root}
      className="object-menu"
      style={{ left: menu.x, top: menu.y }}
      // The viewport suppresses the native menu everywhere; saying so again here
      // stops a second right-click ON the menu from reaching through to it.
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-head">{object.name}</div>
      {item('Copy', 'Ctrl+C', true, () => copyObject(object))}
      {/* Dimmed rather than missing on an object nothing rides on, for the
          reason Paste is: the menu keeps its height and says what it can do. */}
      {item('Copy Parent Tree', '', riders.length > 0, () => copyObject(object, riders))}
      {item('Paste', 'Ctrl+V', clipboard !== null, () => {
        if (clipboard) pasteObject(clipboard, clipboardTree)
      })}
      {item('Save as custom object', '', true, () => saveCustom(object))}
      {item('Choose Parent', '', canChoose, () => beginPick(waiting))}
      {item('Clear Parent', '', object.parentId !== undefined, () => clearParent(waiting))}
    </div>
  )
}
