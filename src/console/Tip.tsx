import type { ReactNode } from 'react'

/**
 * An explanation that costs no panel space until it is asked for.
 *
 * The console used to carry its prose inline: every tool, every field that
 * needed a caveat, spent four or five permanent lines on it. That reads well
 * once and then never again, and it pushed the controls people actually use
 * below the fold. The text is worth keeping -- it is the only place several
 * non-obvious rules are written down -- so it moves behind the dot rather than
 * being deleted.
 *
 * A focusable <span>, not a <button>: these sit inside section headings and
 * beside field labels, and a couple of the places they land are already
 * interactive. `role="note"` says what it is without promising a click does
 * anything, and the bubble is a real child, so a screen reader reaches the text
 * by focusing the dot rather than needing a hover it cannot perform.
 */
export function Tip({
  children,
  align = 'left',
}: {
  children: ReactNode
  /**
   * Which edge of the dot the bubble hangs from, and so which way it opens.
   *
   * Rightwards by default, because every dot in the app sits just after a label
   * near the left edge of its panel, and the console clips its own overflow --
   * a bubble opening the other way would be cut off. Pass 'right' for a dot
   * near a right-hand edge, where that reverses.
   *
   * The console is sized so the widest bubble still fits beside the longest
   * heading in it. That is a real constraint on `.console`'s width, not a
   * coincidence: these bubbles keep their boxes while hidden, so one that did
   * not fit used to give the whole console a horizontal scrollbar.
   */
  align?: 'left' | 'right'
}) {
  return (
    <span className={`tip${align === 'right' ? ' tip-right' : ''}`} tabIndex={0} role="note">
      <svg className="tip-icon" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        <path
          d="M8 7.3v4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
      <span className="tip-bubble">{children}</span>
    </span>
  )
}
