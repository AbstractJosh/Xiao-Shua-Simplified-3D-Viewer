import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useDoc } from '../store/docStore'
import { useLibrary } from '../store/libraryStore'

/**
 * The right-click menu on an object, and the little bit of state that opens it.
 *
 * The store lives beside the component rather than in `src/store` because it IS
 * the menu -- nothing else in the app has any business knowing whether one is
 * open, and the only thing that opens it is a right-click on a solid.
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
const CLICK_SLOP = 5

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
  const pasteObject = useDoc((s) => s.pasteObject)
  const clipboard = useLibrary((s) => s.clipboard)
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

  // The object it was opened on can be deleted from under it -- by the Delete
  // key, or by an undo -- and a menu offering to copy something that is gone is
  // worse than no menu.
  if (!menu || !object) return null

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
      {item('Paste', 'Ctrl+V', clipboard !== null, () => {
        if (clipboard) pasteObject(clipboard)
      })}
      {item('Save as custom object', '', true, () => saveCustom(object))}
    </div>
  )
}
