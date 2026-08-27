/**
 * The four glyphs in the top bar.
 *
 * All on one 20x20 grid with the same 1.6 stroke, because they sit inches apart
 * on a single row and any drift in weight between them shows immediately. Each
 * one draws what the tool does rather than a stock metaphor: the cut mark is a
 * line running past the solid it crosses, which is the whole point of that tool
 * -- the plane is unbounded and the square on screen is only a guide.
 */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** Two corners closing on a point: align to what is already there. */
export function SnapIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M3 7.5V3h4.5" {...STROKE} />
      <path d="M17 12.5V17h-4.5" {...STROKE} />
      <circle cx="10" cy="10" r="1.7" fill="currentColor" />
    </svg>
  )
}

/** A rule with its graduations -- the thing a length is read against, and the
 *  one object in a workshop whose whole job is to say what a number means. */
export function UnitsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <rect x="2.5" y="6.5" width="15" height="7" rx="1.2" {...STROKE} />
      <path d="M6 6.5v3M10 6.5v4M14 6.5v3" {...STROKE} />
    </svg>
  )
}

/** A solid crossed by a line that carries on past both of its edges. */
export function CutIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <rect x="4.6" y="4.6" width="10.8" height="10.8" rx="1.6" {...STROKE} />
      <path d="M1.6 13.8 L18.4 6.2" {...STROKE} />
    </svg>
  )
}

/** Out of the app and onto the disk. */
export function ExportIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M10 3.2v8.2" {...STROKE} />
      <path d="M6.9 8.3 10 11.4 13.1 8.3" {...STROKE} />
      <path d="M4.2 13.4v1.9a1.6 1.6 0 0 0 1.6 1.6h8.4a1.6 1.6 0 0 0 1.6-1.6v-1.9" {...STROKE} />
    </svg>
  )
}

/** Two solids closing into one: the overlap is what merging keeps. */
export function MergeIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <rect x="2.6" y="5.4" width="9" height="9" rx="1.5" {...STROKE} />
      <rect x="8.4" y="5.4" width="9" height="9" rx="1.5" {...STROKE} />
      <path d="M8.4 8.2v3.6" {...STROKE} strokeDasharray="1.6 1.6" />
      <path d="M11.6 8.2v3.6" {...STROKE} strokeDasharray="1.6 1.6" />
    </svg>
  )
}

/**
 * Subtract, as CAD has always drawn it: a minus inside the solid.
 *
 * Not a pencil eraser, which would say "undo" as loudly as it says "take
 * away", and not a second solid ghosted over the first the way `MergeIcon`
 * pairs two rectangles -- at the 14px this is drawn at, the ghost is mush.
 */
export function EraseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <rect x="3.2" y="5.4" width="13.6" height="9.2" rx="1.8" {...STROKE} />
      <path d="M6.8 10h6.4" {...STROKE} />
    </svg>
  )
}

export function HelpIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="7.2" {...STROKE} />
      <path d="M7.9 8a2.1 2.1 0 1 1 2.9 1.95c-.5.23-.8.7-.8 1.25v.4" {...STROKE} />
      <circle cx="10" cy="14" r="0.95" fill="currentColor" />
    </svg>
  )
}
