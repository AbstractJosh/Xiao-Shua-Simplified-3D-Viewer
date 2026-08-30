import { useEffect, useRef, useState } from 'react'
import type { SceneObject } from '../geometry/types'
import { surfaceFor } from '../geometry/surfaces'
import { useDoc } from '../store/docStore'
import type { CustomObject } from '../store/libraryStore'
import { templateOf, useLibrary } from '../store/libraryStore'
import { Section } from './Field'
import { ObjectThumbnail } from './ObjectThumbnail'
import { releaseThumbnail } from './thumbnailGeometry'

/**
 * How many models are live at once.
 *
 * Each one is its own WebGL context, and browsers hand out somewhere between
 * eight and sixteen before they start evicting the oldest -- which on this page
 * would mean the main viewport going black because a shelf scrolled. Three fills
 * the panel's width; the rest of the shelf is a horizontal scroll away and
 * shows a loading ring for the moment it takes to arrive.
 */
const LIVE_LIMIT = 3

/**
 * Which tiles get a live model: the `limit` most-visible, and never more.
 *
 * Ranked by measured visibility rather than counted off the scroll offset. The
 * row's width is the console's and the tiles are sized in fractions of it, so
 * arithmetic on "which three" would drift the first time either changed -- and a
 * scroll caught mid-way has to light the three the user is looking at, not the
 * three whose indices happen to come first.
 *
 * `ratios` is empty until the observer has reported, which covers the first
 * render and the frame a newly saved tile appears in; the leading `limit` are
 * the ones on screen then, so they start live rather than starting as rings.
 *
 * Pure, and exported, because this cap IS the optimization -- a fourth context
 * slipping through is not something to find out about from a black viewport.
 */
export function liveTiles(
  ids: string[],
  ratios: Record<string, number>,
  limit: number
): Set<string> {
  return new Set(
    ids
      .map((id, i) => ({ id, ratio: ratios[id] ?? (i < limit ? 1 : 0) }))
      .filter((t) => t.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, limit)
      .map((t) => t.id)
  )
}

/**
 * How many empty slots stand in for the shelf before anything is saved.
 *
 * Three, because three is what `.custom-grid` fits across the panel -- the
 * stylesheet is where that number is really decided, and the two have to move
 * together. It is the same three as `LIVE_LIMIT` by arithmetic and not by
 * argument: one is what fits, the other is how many WebGL contexts may be lit
 * at once, and they are free to part company.
 */
const EMPTY_SLOTS = 3

/** What to do about an empty shelf, on the slots themselves. The panel's own
 *  tip says it too; this is the copy that is under the pointer when someone
 *  wonders what the dashed squares are for. */
const SAVE_HINT = 'Right-click an object in the scene and choose Save as custom object'

/** Primitives are centred on the local origin; this is the lift that rests one
 *  on the grid, for the keyboard path that drops without a pointer. */
function groundedPosition(object: SceneObject): [number, number, number] {
  return [0, -surfaceFor(object.base).bounds().min.y, 0]
}

/**
 * How a name too long for its tile walks past while the pointer is on it.
 *
 * Thirty pixels a second is reading pace rather than ticker pace: the whole
 * point is to be READ, and a name that has gone by before the eye has caught up
 * has to be waited out for another lap. The rest at each end is what makes the
 * two ends legible at all -- a walk that turned round the instant it arrived
 * would show the last word for one frame.
 */
const MARQUEE_SPEED = 30
const MARQUEE_PAUSE = 800

/**
 * Where a walking name has got to, `elapsed` milliseconds in.
 *
 * Out to the end, a rest, back to the start, a rest, repeat -- and it is a
 * FUNCTION OF THE CLOCK rather than a position nudged along each frame. Nudging
 * accumulates: a tile whose animation is throttled in a background tab, or
 * whose frames arrive unevenly, drifts away from where it should be and has no
 * way back. Read off the elapsed time, a dropped frame is a frame the name is
 * simply further along in, which is what a marquee is.
 *
 * Pure and exported so the check suite can walk a lap of it without a DOM --
 * the only part of this that is arithmetic rather than paint.
 */
export function marqueeOffset(travel: number, elapsed: number): number {
  if (!(travel > 0) || !Number.isFinite(elapsed)) return 0
  const walk = (travel / MARQUEE_SPEED) * 1000
  const lap = 2 * (MARQUEE_PAUSE + walk)
  // Modulo twice, so a clock that somehow runs backwards lands in the lap
  // rather than at a negative offset the scroller would clamp to zero.
  const t = ((elapsed % lap) + lap) % lap

  if (t < MARQUEE_PAUSE) return 0
  if (t < MARQUEE_PAUSE + walk) return (travel * (t - MARQUEE_PAUSE)) / walk
  if (t < 2 * MARQUEE_PAUSE + walk) return travel
  return travel - (travel * (t - 2 * MARQUEE_PAUSE - walk)) / walk
}

/** Whether the reader has asked for less movement. Guarded, because this runs
 *  in a check suite that renders components without a window around them. */
function wantsStillness(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function CustomTile({ custom, live }: { custom: CustomObject; live: boolean }) {
  const startPlacingSolidTemplate = useDoc((s) => s.startPlacingSolidTemplate)
  const addObject = useDoc((s) => s.addObject)
  const renameCustom = useLibrary((s) => s.renameCustom)
  const removeCustom = useLibrary((s) => s.removeCustom)
  // The field is only bound while it is being edited, so a rename in another
  // tile -- or a name that arrives from anywhere else -- cannot fight the caret.
  const [draft, setDraft] = useState<string | null>(null)
  /** Whether the pointer is on this tile, which is what sets a long name off. */
  const [reading, setReading] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)

  const { object } = custom

  /**
   * Walk an over-long name past while the pointer is on the tile.
   *
   * A name is docked across the top of a square about a hundred pixels wide, so
   * "Bearing block, left hand" does not fit and never will. At rest it is cut
   * off with an ellipsis, which says there is more without saying what -- and
   * the only way to read the rest was to click into the field and arrow across,
   * which is an edit gesture performed in order to READ. Hovering the tile you
   * were already looking at costs nothing and answers the question.
   *
   * MEASURED, NOT ASSUMED: nothing moves unless the text actually overflows, so
   * a shelf of short names is a still shelf. The measurement happens after the
   * ellipsis is turned off, because the point of asking is how wide the text
   * would be without one.
   */
  useEffect(() => {
    const el = nameField.current
    if (!reading || !el || wantsStillness()) return

    el.dataset.walking = 'true'
    const travel = el.scrollWidth - el.clientWidth
    // A pixel of slack: sub-pixel text metrics routinely leave a fraction of
    // overflow on a name that plainly fits, and a tile that twitches is worse
    // than one that says nothing.
    if (travel <= 1) {
      delete el.dataset.walking
      return
    }

    let raf = 0
    const start = performance.now()
    const step = (now: number) => {
      raf = requestAnimationFrame(step)
      // The caret owns the scroll while the field is being typed in. The clock
      // keeps running underneath, so letting go picks the walk up where it
      // would have been rather than restarting it.
      if (document.activeElement === el) return
      el.scrollLeft = marqueeOffset(travel, now - start)
    }
    raf = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(raf)
      delete el.dataset.walking
      // Back to the beginning, because the beginning is the part of a name that
      // identifies it -- a shelf left showing the tail ends of three names is a
      // shelf you cannot read at a glance.
      el.scrollLeft = 0
    }
  }, [reading, custom.name])

  const commitName = () => {
    if (draft === null) return
    // An empty name would leave a tile with nothing to identify it and no way
    // to click into the field again; the old name stands instead.
    const trimmed = draft.trim()
    if (trimmed && trimmed !== custom.name) renameCustom(custom.id, trimmed)
    setDraft(null)
  }

  return (
    <div
      className="custom-tile"
      data-custom={custom.id}
      // The whole tile, not the field: you point at the object to find out what
      // it is called, and the field is a twenty-pixel strip at the top of it.
      // `onFocus` and `onBlur` come along for the keyboard, which reaches the
      // tile through the drag surface's own tab stop -- React's are the
      // bubbling focusin and focusout, so a child taking focus counts as the
      // tile taking it.
      onPointerEnter={() => setReading(true)}
      onPointerLeave={() => setReading(false)}
      onFocus={() => setReading(true)}
      onBlur={() => setReading(false)}
    >
      <div
        className="custom-grab"
        role="button"
        tabIndex={0}
        title={`Drag ${custom.name} into the scene`}
        aria-label={`${custom.name}, drag into the scene`}
        onPointerDown={(e) => {
          e.preventDefault()
          startPlacingSolidTemplate(object)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          // A keyboard "drag" would leave the ghost following nothing, with no
          // release to end it, so activation drops the object on the grid --
          // the same bargain the solid palette's rows strike.
          e.preventDefault()
          const template = templateOf(object)
          addObject(template.base, groundedPosition(template))
        }}
      >
        <ObjectThumbnail object={object} label={custom.name} live={live} />
      </div>

      {/* The name, docked across the top of the tile's own little viewport.
          Under the square it was a caption on a picture; over it, the tile is
          one object with its name on it, and the shelf gets a row of chrome per
          tile back.

          STILL A SIBLING OF THE DRAG SURFACE, NOT A CHILD OF IT, and that is
          load-bearing rather than incidental. `.custom-grab` is a
          `role="button"` that starts a placement on pointerdown: a text field
          inside it would be interactive content inside a button -- which no
          screen reader can present sensibly -- and every press meant for the
          caret would start a drag instead. Laid over the square from outside
          it, the two gestures stay exactly as separate as they were when the
          field sat below, and the only thing that changed is where it is
          drawn. */}
      <input
        ref={nameField}
        className="custom-name"
        value={draft ?? custom.name}
        // The whole name, for a reader who has asked for less movement and for
        // anyone who would rather not wait out a lap of it.
        title={custom.name}
        aria-label={`Name of ${custom.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // Abandon the edit rather than letting Escape fall through to the
          // viewport, where it would clear the selection instead.
          if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(null)
          }
        }}
      />

      <button
        type="button"
        className="custom-remove"
        title={`Remove ${custom.name}`}
        aria-label={`Remove ${custom.name}`}
        onClick={() => {
          releaseThumbnail(object)
          removeCustom(custom.id)
        }}
      >
        <svg viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}

/**
 * The shelf: objects the user built and chose to keep, ready to be dragged back
 * into the scene.
 *
 * A row of turntables rather than a grid of icons. These are things the user
 * made, and two of them built from the same primitive draw as the same icon --
 * the model, turning, is the only thing that tells a bracket from a bearing
 * block. Three are live at a time and the row scrolls sideways to reach the
 * rest, because each live model costs a WebGL context.
 *
 * The tiles ARE drag sources, the same gesture the palette uses: a press starts
 * a placement and the window carries it onto the canvas from there. What lands
 * is a full copy -- features, cuts, merged parts, and the rotation it was saved
 * at -- with fresh ids, so it edits independently of the one it came from.
 *
 * EMPTY, IT IS STILL THE SHELF. Three dashed slots stand where the tiles will
 * go, rather than a paragraph explaining that there are none. A shelf with
 * spaces in it says what it holds and how much of it there is at a glance, and
 * it says the same thing in the same place once something has been saved --
 * where the paragraph was a different panel, in a different shape, that
 * disappeared the moment it had been read once. The count beside the title
 * reads 0 for the same reason: an empty list is a list, and it can say so.
 */
export function ClipboardPanel() {
  const customs = useLibrary((s) => s.customs)
  const scroller = useRef<HTMLDivElement>(null)
  const [ratios, setRatios] = useState<Record<string, number>>({})

  useEffect(() => {
    const root = scroller.current
    if (!root || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) =>
        setRatios((prev) => {
          const next = { ...prev }
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.custom
            if (id) next[id] = entry.intersectionRatio
          }
          return next
        }),
      // A spread of thresholds rather than one: a tile half in view has to
      // report a ratio that can be RANKED against its neighbours, and a single
      // threshold only ever reports crossing it.
      { root, threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] }
    )
    for (const tile of root.querySelectorAll('[data-custom]')) observer.observe(tile)
    return () => observer.disconnect()
  }, [customs])

  const live = liveTiles(customs.map((c) => c.id), ratios, LIVE_LIMIT)

  return (
    <Section
      title="Clipboard"
      hint={`${customs.length}`}
      tip="Right-click a solid in the scene and choose Save as custom object to put it here. Each tile turns on its own; sweep across one to spin it and look it over. Drag a tile onto the grid to place a copy, and scroll the row sideways for the rest."
      collapsible
      defaultOpen
    >
      <div className="custom-grid" ref={scroller}>
        {customs.length === 0
          ? // Decoration, and hidden from a screen reader as such: an empty
            // shelf read out as three unlabelled somethings is worse than an
            // empty shelf read out as nothing, which is what it is. The tip on
            // the heading is where that reader is told how to fill it.
            Array.from({ length: EMPTY_SLOTS }, (_, i) => (
              <div key={i} className="custom-slot" title={SAVE_HINT} aria-hidden />
            ))
          : customs.map((custom) => (
              <CustomTile key={custom.id} custom={custom} live={live.has(custom.id)} />
            ))}
      </div>
    </Section>
  )
}
