import type { ReactNode } from 'react'
import { useTools } from '../store/toolStore'
import type { NavPanel } from '../store/toolStore'
import { Tip } from './Tip'

/**
 * One tool in the top bar: a button that engages it, and a panel that hangs
 * below holding whatever the tool needs aiming with.
 *
 * The split matters. Engaging a tool is the frequent act and stays one click on
 * the button itself; the parameters are the rare act and live behind the caret.
 * Collapsing the two -- a button that only opens a panel containing a switch --
 * would make turning snapping on cost two clicks instead of one.
 *
 * Which panel is open lives in the tool store rather than here, so the whole
 * bar stays a pure function of store state and a headless render can drive it
 * exactly the way a click does.
 */
export function NavTool({
  id,
  label,
  icon,
  active = false,
  onToggle,
  tip,
  panelTitle,
  align = 'left',
  children,
}: {
  /**
   * Which panel this tool owns, if it has one. Omitted for a tool that is
   * nothing but a switch -- Cut, whose controls live in the console -- so a
   * panel id is never invented for something that can never open one.
   */
  id?: NonNullable<NavPanel>
  label: string
  icon: ReactNode
  /** Whether the tool is engaged -- drives the accent state, not the panel. */
  active?: boolean
  /**
   * Engage or disengage the tool. Omitted for a button that is nothing but its
   * panel (Help), where pressing it opens and closes that panel instead.
   */
  onToggle?: (on: boolean) => void
  /** Prose shown on hover. The bar's tooltips replace the console's old hints. */
  tip?: ReactNode
  panelTitle?: string
  /** Which way the panel opens. Tools near the right edge open leftwards. */
  align?: 'left' | 'right'
  children?: ReactNode
}) {
  const openPanel = useTools((s) => s.openPanel)
  const setOpenPanel = useTools((s) => s.setOpenPanel)

  const open = id !== undefined && openPanel === id
  const hasPanel = id !== undefined && children != null && children !== false
  // A caret with nothing behind it is a dead control, and on a toggle-less tool
  // the button already is the caret.
  const showCaret = hasPanel && onToggle !== undefined

  const togglePanel = () => {
    if (id !== undefined) setOpenPanel(open ? null : id)
  }

  return (
    <div className={`nav-tool${open ? ' nav-tool-open' : ''}`}>
      <div className={`nav-group${active ? ' nav-group-active' : ''}`}>
        <button
          type="button"
          className="nav-btn"
          aria-pressed={onToggle ? active : undefined}
          aria-expanded={onToggle ? undefined : open}
          onClick={() => (onToggle ? onToggle(!active) : togglePanel())}
        >
          <span className="nav-icon" aria-hidden>
            {icon}
          </span>
          <span className="nav-label">{label}</span>
        </button>

        {showCaret && (
          <button
            type="button"
            className="nav-caret"
            aria-expanded={open}
            aria-label={`${label} options`}
            onClick={togglePanel}
          >
            <svg viewBox="0 0 10 10" aria-hidden>
              <path
                d="M2.2 3.8 L5 6.6 L7.8 3.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Sibling of the buttons, not a child of one: the bubble is shown by a
          CSS sibling selector off :hover, which keeps a focusable element from
          being nested inside a button. Suppressed while the panel is open,
          where it would land on top of the controls it describes. */}
      {tip && <span className="tip-bubble nav-tip">{tip}</span>}

      {hasPanel && open && (
        <div
          className={`nav-panel${align === 'right' ? ' nav-panel-right' : ''}`}
          role="group"
          aria-label={panelTitle ?? label}
        >
          <div className="nav-panel-head">
            <span className="nav-panel-title">{panelTitle ?? label}</span>
            {tip && <Tip>{tip}</Tip>}
            <button
              type="button"
              className="nav-panel-close"
              aria-label={`Close ${label.toLowerCase()} options`}
              onClick={() => setOpenPanel(null)}
            >
              <svg viewBox="0 0 10 10" aria-hidden>
                <path
                  d="M2.4 2.4 L7.6 7.6 M7.6 2.4 L2.4 7.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  )
}
