import { useEffect } from 'react'
import { create } from 'zustand'
import { canParent } from '../geometry/hierarchy'
import { useDoc } from '../store/docStore'
import { isRightClick, noteRightPress } from './ObjectMenu'

/**
 * Choosing a parent: the moment between "Choose Parent" in an object's menu
 * and the click on the object it is to ride on.
 *
 * A MODE, and a loud one. While it lasts the next left click on a solid means
 * "this one", and nothing else on screen is allowed to look as though it means
 * anything: the console, the Tools island and the selection's panels are greyed
 * out and taken out of reach, every gizmo stands down -- the object's, a
 * sketch's, the cut plane's, a ruler's -- and so does the brush's ghost, a
 * press on empty space draws no box, and the keyboard answers Escape and
 * nothing else. What is left is the scene, the camera -- you may well have to
 * turn round to find the parent -- and the box at the top saying what the next
 * click does.
 *
 * THE SCENE ANSWERS THE POINTER. The solid under it that could be the parent
 * lights up in a colour of its own, not the selection's: the selection is what
 * is WAITING for a parent, and lit the same way the two would read as one
 * thing. A solid that cannot be the parent does not light at all, which is the
 * whole of what tells you a click there would do nothing. And the parent
 * chosen goes on glowing for a moment after the click, once everything else
 * has come back, so the click visibly landed somewhere.
 *
 * Ended by a click on an object that can be the parent, by Escape, by a
 * right-click, by the box's own cancel, or by leaving the viewport. A click on
 * something that CANNOT be the parent -- one of the objects waiting for it, or
 * anything riding on them -- does nothing, and the choice stays open: a
 * miss-click is not a reason to start again from the menu.
 *
 * Its own small store rather than a field on the document's, because it is not
 * an edit and has no business in undo, and rather than the object menu's,
 * because the menu is closed for the whole of it.
 */
type PickState = {
  /** The objects waiting for a parent, or null when none is being chosen. */
  childIds: string[] | null
  /** The solid under the pointer that a click would make the parent, if any. */
  hoverId: string | null
  /** The parent just chosen, glowing for a moment after the click. See
   *  `FLASH_MS`. */
  flashId: string | null
  begin: (ids: string[]) => void
  cancel: () => void
  /** The pointer is over `id`, or over nothing when null. Only a solid that
   *  could be the parent is remembered; anything else reads as nothing. */
  hover: (id: string | null) => void
}

/**
 * How long the chosen parent keeps glowing after the click: long enough to be
 * seen once the panels have come back, short enough to be gone before the next
 * thing is reached for.
 */
export const FLASH_MS = 700

let flashTimer: ReturnType<typeof setTimeout> | undefined

export const useParentPick = create<PickState>((set, get) => ({
  childIds: null,
  hoverId: null,
  flashId: null,
  begin: (ids) => set({ childIds: ids.length > 0 ? ids : null, hoverId: null }),
  cancel: () => set({ childIds: null, hoverId: null }),
  hover: (id) => {
    const next = id !== null && canChoose(get().childIds, id) ? id : null
    if (next !== get().hoverId) set({ hoverId: next })
  },
}))

/** Whether `objectId` can be the parent of at least one of the waiting
 *  objects, without being one of them. See `pickParent`. */
function canChoose(childIds: string[] | null, objectId: string): boolean {
  if (!childIds || childIds.includes(objectId)) return false
  const { objects } = useDoc.getState().doc
  return childIds.some((id) => canParent(objects, id, objectId))
}

/** Whether a parent is being chosen: what greys the panels out. */
export const picking = (s: PickState): boolean => s.childIds !== null

/**
 * A left click on `objectId` while a parent is being chosen.
 *
 * Links every waiting object that can ride on it and ends the choice -- or, when
 * none of them can, does nothing at all, and the choice stays open.
 */
export function pickParent(objectId: string): void {
  const { childIds, cancel } = useParentPick.getState()
  // One of the objects waiting is not a parent for the rest of them. Two
  // selected and one of them clicked is far likelier to be a slip than a way
  // of saying "the other one rides on this one".
  if (!childIds || !canChoose(childIds, objectId)) return
  useDoc.getState().setParent(childIds, objectId)
  cancel()
  // The click landed: the parent goes on glowing a moment longer. See
  // `FLASH_MS`.
  clearTimeout(flashTimer)
  useParentPick.setState({ flashId: objectId })
  flashTimer = setTimeout(() => useParentPick.setState({ flashId: null }), FLASH_MS)
}

/**
 * The box at the top of the viewport for as long as a parent is being chosen,
 * and the two ways out of it that are not a key.
 */
export function ParentPickBanner() {
  const active = useParentPick(picking)
  const cancel = useParentPick((s) => s.cancel)

  // Leaving the viewport -- another screen, the front door -- ends the choice.
  // Left standing, it would greet the user on the way back with every panel
  // dead and no memory of why.
  useEffect(() => () => useParentPick.getState().cancel(), [])

  useEffect(() => {
    if (!active) return
    // A RIGHT-CLICK cancels, judged the way the object menu judges one -- the
    // same slop, and the same word from Game Controls that a press has become
    // a look -- so a right-drag that pans the camera to find the parent does
    // not throw the choice away at the end of it. Capture phase, so it is
    // heard whatever the press landed on, the greyed-out panels included.
    //
    // Answered on the MENU event rather than on the release, and swallowed
    // there. The menu event arrives after the release, and a choice already
    // cancelled by then would let it through to the solid under the pointer --
    // which would open that solid's menu as the way out of choosing a parent.
    // Swallowing it also keeps it from the viewport's own handler, so the
    // browser's menu is refused here instead.
    const down = (e: PointerEvent) => {
      if (e.button === 2) noteRightPress(e.clientX, e.clientY)
    }
    const menu = (e: MouseEvent) => {
      if (!isRightClick(e.clientX, e.clientY)) return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('contextmenu', menu, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('contextmenu', menu, true)
    }
  }, [active, cancel])

  if (!active) return null

  return (
    <div className="parent-pick" role="status">
      <span className="parent-pick-label">Choose Parent...</span>
      <button type="button" className="icon-btn" aria-label="Cancel" onClick={cancel}>
        {'×'}
      </button>
    </div>
  )
}
