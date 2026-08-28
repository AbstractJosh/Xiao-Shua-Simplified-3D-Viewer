/**
 * The glyphs the tool buttons carry.
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

/**
 * A dimension line: a span with a tick standing across each end.
 *
 * Deliberately NOT a rule with graduations, which is the Units glyph above --
 * the two buttons sit one above the other in the island, and a second ruler
 * shape there would say they were two halves of one control. This draws what
 * the tool actually makes: a measurement pinned between two ends, which are the
 * two things you take hold of.
 */
export function RulerIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M4 13 L16 7" {...STROKE} />
      <path d="M2.9 10.9 L5.1 15.1" {...STROKE} />
      <path d="M14.9 4.9 L17.1 9.1" {...STROKE} />
    </svg>
  )
}

/**
 * A four-headed cross: go that way, any of the four.
 *
 * The one glyph here that IS the stock metaphor, and deliberately -- Move is
 * the resting tool, the one a user is in without having chosen it, so the
 * button wants to be recognised rather than read. It is also honest about the
 * handles: arrows out along the axes, and the quads between them are the
 * quadrants the cross cuts the square into.
 */
export function MoveIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M10 3.2v13.6M3.2 10h13.6" {...STROKE} />
      <path d="M7.9 5.5 10 3.4 12.1 5.5" {...STROKE} />
      <path d="M7.9 14.5 10 16.6 12.1 14.5" {...STROKE} />
      <path d="M5.5 7.9 3.4 10 5.5 12.1" {...STROKE} />
      <path d="M14.5 7.9 16.6 10 14.5 12.1" {...STROKE} />
    </svg>
  )
}

/**
 * An arc with a head on it, turning about a marked centre.
 *
 * Three quarters of a circle rather than a full one, because a full one is the
 * Scale glyph below and the two sit one above the other: what tells them apart
 * has to be the gap and the arrowhead, at 14 pixels.
 */
export function RotateIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M15.6 6.6a6.6 6.6 0 1 0 1.2 5.2" {...STROKE} />
      <path d="M15.9 3.1 15.9 7.1 11.9 7.1" {...STROKE} />
      <circle cx="10" cy="10" r="1.5" fill="currentColor" />
    </svg>
  )
}

/**
 * A ring with an arrow running out through it: the gesture itself, which is to
 * take hold of the circle and pull it outward.
 */
export function ScaleIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="5.2" {...STROKE} />
      <path d="M12.4 7.6 17 3" {...STROKE} />
      <path d="M13.2 3 17 3 17 6.8" {...STROKE} />
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

/**
 * The torch's business end: a live flame standing on the nozzle it comes out of.
 *
 * THE FLAME IS THE WHOLE ICON and the nozzle is there to say what kind. The old
 * glyph was a plain teardrop over a dish it had melted, and the dish was doing
 * the naming -- "Erode" said nothing about heat, so a symmetric drop of flame
 * could as easily have read as weld, or as water. The label an inch away now
 * says blowtorch, which frees the picture to be one thing drawn properly.
 *
 * So the flame CURLS. A teardrop is a drop; what makes a shape read as fire at
 * eighteen pixels is the notch where the tip folds back over itself, and it is
 * the first thing to go if this is ever redrawn smaller. The nozzle FLARES
 * toward its base, which is what keeps the pair from reading as a candle -- a
 * candle is a straight column, and a torch is a jet held in something.
 *
 * Everything else here is axis-aligned or a plain diagonal, so this glyph is
 * the busiest in the set by some way. That is affordable for exactly one of
 * them and this is the one worth spending it on: it is the only tool in the bar
 * that changes the surface irreversibly under a moving pointer.
 */
export function BlowtorchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      {/* The flame. Written out at its final size rather than a scaled copy of
          a larger one: a `scale` on the group would thin the stroke with it,
          and the one thing every glyph here shares is its weight. */}
      <path
        d="M11.1 1.7c.36 1.73 0 2.88-1.08 3.53-1.08.65-1.22 1.44-.43 2.3-1.01 0-1.73-.43-2.16-1.3-.58.72-.86 1.51-.86 2.3 0 1.8 1.44 3.1 3.46 3.1s3.46-1.3 3.46-3.1c0-2.45-.79-4.75-2.38-6.84Z"
        {...STROKE}
      />
      {/* The nozzle, wider at the foot than at the mouth. */}
      <path d="M8.6 12 7.2 17.9h5.6L11.4 12Z" {...STROKE} />
    </svg>
  )
}

/**
 * The sculpt tool: a stylus held over a surface that has swelled under it.
 *
 * THE MOUND IS THE VERB. The blowtorch's glyph is a flame, and the flame is
 * what names it -- but "a flame, upside down" names nothing, so this is not
 * drawn as that icon mirrored. What the two tools share is not a picture, it is
 * a surface being changed, and the honest way to say "the other direction" is
 * to show the surface bulging where the torch's dish would dip.
 *
 * The line is flat at both ends and swells only in the middle, which is the
 * falloff the brush actually has -- see `falloff` in `erode.ts`. A bump that
 * met the baseline with a corner would be drawing the one thing this tool never
 * leaves behind.
 *
 * The STYLUS is what stops the mound reading as an extrusion. An arrow over a
 * line is what push-pull does to a sketch, and this app has that gesture
 * already; a tool held against the surface says a brush instead, which is the
 * gesture this one is. Angled from the top right, so it lands on the peak
 * rather than crossing it, with a collar across the shaft -- the one detail
 * that makes a diagonal line read as an instrument rather than a stroke.
 */
export function SculptIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      {/* The surface, swelling under the tool. */}
      <path d="M2.4 15.4C5.6 15.4 6.1 10.4 10 10.4s4.4 5 7.6 5" {...STROKE} />
      {/* The stylus, and the collar that names it one. */}
      <path d="M16.9 2.6 11.6 7.9" {...STROKE} />
      <path d="M14.4 3.2 16.3 5.1" {...STROKE} />
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

/**
 * In off the disk: the same tray Export draws, with the arrow the other way up.
 *
 * Deliberately a MIRROR rather than a different picture. The two are the only
 * pair of controls in the app that are one act in two directions, and drawing
 * them as a pair is what says so at a glance -- a folder or a file glyph here
 * would have been a second, unrelated metaphor sitting next to the first.
 */
export function ImportIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M10 11.4V3.2" {...STROKE} />
      <path d="M6.9 6.3 10 3.2 13.1 6.3" {...STROKE} />
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

/**
 * A sketch: the outline lying on the face it was dropped on.
 *
 * The ellipse rather than a circle, and a line under it rather than a box: what
 * distinguishes a sketch from any other round glyph in this set is that it is
 * lying ON something, and foreshortening is the only thing at 15px that says so.
 */
export function SketchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M2.6 14.2h14.8" {...STROKE} />
      <ellipse cx="10" cy="8.6" rx="5.4" ry="3.1" {...STROKE} />
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
/**
 * A cog: the one stock metaphor in this set, and worth it.
 *
 * Every other glyph here draws what its tool does, because every other button
 * is a tool. This one is not -- it holds the preferences that are true of the
 * whole app rather than of anything you can point at -- and there is no shape
 * that says "settings" better than the one every application has agreed on.
 * Inventing one here would cost recognition and buy nothing.
 *
 * Six teeth rather than the usual eight: the button renders it at 15px, and at
 * that size eight teeth close up into a ring with a texture rather than a gear.
 */
export function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path
        d="M8.2 2.21L11.8 2.21L12.11 4.49L13.71 5.41L15.85 4.54L17.65 7.66L15.83 9.08L15.83 10.92L17.65 12.34L15.85 15.46L13.71 14.59L12.11 15.51L11.8 17.79L8.2 17.79L7.89 15.51L6.29 14.59L4.15 15.46L2.35 12.34L4.17 10.92L4.17 9.08L2.35 7.66L4.15 4.54L6.29 5.41L7.89 4.49Z"
        {...STROKE}
      />
      <circle cx="10" cy="10" r="2.6" {...STROKE} />
    </svg>
  )
}
