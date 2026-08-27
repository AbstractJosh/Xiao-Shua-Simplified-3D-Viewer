import { useEffect, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { CutActions, CutTool, SnapTool, UnitsTool } from '../console/NavTools'
import { dockIsland, useTools } from '../store/toolStore'

/**
 * How far the pointer travels before a press on the title strip is a drag
 * rather than a click on the button under it.
 *
 * The strip is the handle AND holds the collapse button, because collapsed the
 * strip is barely wider than that button and a handle you cannot grab is not a
 * handle. So the two gestures start identically and are told apart by distance,
 * the way the right-click menu and the selection box already are.
 */
const GRAB_SLOP = 4

/**
 * The tools you work *with*, as an island floating over the scene: Snap, Cut,
 * and the two actions an armed cut plane brings with it.
 *
 * They were in the bar across the top. Both are aimed at the SCENE -- snapping
 * is watched at the corner of a solid being dragged, a cut is fired at a plane
 * standing in the middle of the viewport -- so reaching them meant the hand at
 * the top edge of the window and the eye on the model, and the panel hanging
 * off the button came down over the thing it was aimed at. Over the scene, the
 * hand and the eye are in one place.
 *
 * It opens at the top-left, the corner nothing else claims: the compass has the
 * top-right, the selection panels the bottom-right, the drag hint the bottom
 * centre. That is a default rather than a fixture -- it is dragged by its title
 * strip, and it SNAPS to the edges and corners it is dropped near, so "out of
 * the way" is one rough throw rather than a pixel hunt. Where it ends up is
 * kept as an offset from the near edge, so a docked island stays docked when
 * the window resizes; see `IslandPlacement`.
 *
 * The buttons inside are the bar's own components, unchanged -- one definition
 * of what Snap is, rendered somewhere else. What makes them a column, and what
 * turns the panels around when the island is over on the right, is CSS scoped
 * to `.tool-island`.
 */
export function ToolIsland() {
  const collapsed = useTools((s) => s.islandCollapsed)
  const setCollapsed = useTools((s) => s.setIslandCollapsed)
  const placement = useTools((s) => s.islandPlacement)

  const ref = useRef<HTMLDivElement>(null)
  // Whether the gesture that just ended moved the island. Read by the click
  // that follows it, to keep a drag begun on the collapse button from also
  // shutting the island when it lands.
  const dragged = useRef(false)

  // The viewport can lose the width the island was placed against -- a window
  // dragged narrower, the browser's own panels opening -- and an offset kept
  // from an edge that has moved leaves it half off the scene. Re-solved from
  // where it currently sits, so it slides back into view and keeps its corner
  // rather than jumping home.
  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      const el = ref.current
      if (!el) return
      const box = el.getBoundingClientRect()
      const bounds = parent.getBoundingClientRect()
      const { islandPlacement, setIslandPlacement } = useTools.getState()
      const next = dockIsland(
        box.left - bounds.left,
        box.top - bounds.top,
        { width: box.width, height: box.height },
        { width: bounds.width, height: bounds.height }
      )
      const same =
        next.hx === islandPlacement.hx &&
        next.hy === islandPlacement.hy &&
        next.x === islandPlacement.x &&
        next.y === islandPlacement.y
      if (!same) setIslandPlacement(next)
    })

    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Left button only. The right one pans the camera everywhere else in the
    // viewport, and a widget that swallowed it would be a hole in that.
    if (e.button !== 0) return

    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return

    const box = el.getBoundingClientRect()
    const bounds = parent.getBoundingClientRect()
    // Where in the island the pointer took hold. Without it the island jumps
    // its own width the moment a drag starts, from wherever it was grabbed to
    // its own top-left corner.
    const grabX = e.clientX - box.left
    const grabY = e.clientY - box.top
    const from = { x: e.clientX, y: e.clientY }

    // Tracked on the WINDOW rather than by capturing the pointer on the strip,
    // although capture is the usual way to hold a drag. Capture retargets the
    // compatibility mouse events with it, and the click that ends a press on
    // the collapse button would arrive at the strip instead of at the button --
    // so grabbing the island would work and pressing the caret would silently
    // stop working. The window sees every move either way.
    dragged.current = false

    const move = (m: PointerEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - from.x, m.clientY - from.y) < GRAB_SLOP) {
        return
      }
      dragged.current = true
      // The island's own size, measured once: the drag decides a corner, and
      // re-measuring per move would let an opening panel shift the answer
      // under the pointer.
      useTools.getState().setIslandPlacement(
        dockIsland(
          m.clientX - bounds.left - grabX,
          m.clientY - bounds.top - grabY,
          { width: box.width, height: box.height },
          { width: bounds.width, height: bounds.height }
        )
      )
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const toggle = () => {
    // Any panel hanging off a button inside the island is closed with it --
    // by `setIslandCollapsed` itself, so it holds however the island came to
    // be collapsed rather than only when this button did it.
    setCollapsed(!collapsed)
  }

  // Two of the four, never a left/right or a top/bottom pair: which two is the
  // answer the drag came to, and stating all four would pin the island to a
  // size instead of to a corner.
  const style: CSSProperties = {
    left: placement.hx === 'left' ? placement.x : undefined,
    right: placement.hx === 'right' ? placement.x : undefined,
    top: placement.hy === 'top' ? placement.y : undefined,
    bottom: placement.hy === 'bottom' ? placement.y : undefined,
  }

  // The near edge is the one there is no room on, so it is also the one the
  // panels have to open away from.
  const side = `tool-island-${placement.hx} tool-island-${placement.hy}`

  return (
    <div
      className={`tool-island ${side}${collapsed ? ' tool-island-shut' : ''}`}
      ref={ref}
      style={style}
    >
      {/* The handle, and the same collapse idiom the console's sections use: a
          caret that points right at rest and is turned by CSS off
          `aria-expanded`, so the open state is written down in one place. */}
      <div
        className="island-head"
        onPointerDown={onPointerDown}
        // Capture, so it lands before the button's own handler rather than
        // after it: a press that turned into a drag must not also collapse the
        // island when the pointer comes up over the caret it started on.
        onClickCapture={(e) => {
          if (!dragged.current) return
          e.preventDefault()
          e.stopPropagation()
          dragged.current = false
        }}
      >
        <button type="button" className="collapse-btn" aria-expanded={!collapsed} onClick={toggle}>
          <svg className="collapse-caret" viewBox="0 0 10 10" aria-hidden>
            <path
              d="M3.2 1.6 L6.8 5 L3.2 8.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Tools
        </button>

        {/* Says the strip can be taken hold of. Inert: the whole strip is the
            handle, and a grip that had to be hit would be a smaller target than
            the one it advertises. */}
        <span className="island-grip" aria-hidden>
          <svg viewBox="0 0 10 10">
            <path
              d="M3 2.2h.01M7 2.2h.01M3 5h.01M7 5h.01M3 7.8h.01M7 7.8h.01"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </div>

      {!collapsed && (
        <div className="island-body">
          <SnapTool />
          <UnitsTool />
          <CutTool />
          {/* Only on screen while the plane is armed, so the island is no taller
              than two buttons for anyone not cutting. */}
          <CutActions />
        </div>
      )}
    </div>
  )
}
