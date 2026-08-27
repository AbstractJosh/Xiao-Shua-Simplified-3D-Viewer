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

function CustomTile({ custom, live }: { custom: CustomObject; live: boolean }) {
  const startPlacingSolidTemplate = useDoc((s) => s.startPlacingSolidTemplate)
  const addObject = useDoc((s) => s.addObject)
  const renameCustom = useLibrary((s) => s.renameCustom)
  const removeCustom = useLibrary((s) => s.removeCustom)
  // The field is only bound while it is being edited, so a rename in another
  // tile -- or a name that arrives from anywhere else -- cannot fight the caret.
  const [draft, setDraft] = useState<string | null>(null)

  const { object } = custom

  const commitName = () => {
    if (draft === null) return
    // An empty name would leave a tile with nothing to identify it and no way
    // to click into the field again; the old name stands instead.
    const trimmed = draft.trim()
    if (trimmed && trimmed !== custom.name) renameCustom(custom.id, trimmed)
    setDraft(null)
  }

  return (
    <div className="custom-tile" data-custom={custom.id}>
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

      <input
        className="custom-name"
        value={draft ?? custom.name}
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
