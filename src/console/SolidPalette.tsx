import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { BaseSolid } from '../geometry/types'
import { defaultBaseFor, solidLabel } from '../geometry/types'
import { surfaceFor } from '../geometry/surfaces'
import { useDoc } from '../store/docStore'
import { Section } from './Field'
import { EraseIcon } from './navIcons'
import { SOLID_TEMPLATES } from './solidIcons'
import type { SolidTemplate } from './solidIcons'

function SolidIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 32 32" className="solid-item-icon" aria-hidden>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {children}
      </g>
    </svg>
  )
}

/**
 * The side count a row rests on before anyone touches it. Read back out of the
 * geometry layer rather than written down here, so the count that looks active
 * is the one a plain drag would actually produce.
 */
function defaultSidesFor(template: SolidTemplate): number | undefined {
  const base = defaultBaseFor(template.kind)
  return 'sides' in base ? base.sides : undefined
}

/** Primitives are centred on the local origin, so this is the lift that rests one on the grid. */
function groundedPosition(base: BaseSolid): [number, number, number] {
  return [0, -surfaceFor(base).bounds().min.y, 0]
}

/**
 * A row of a solid catalogue, and two drag sources in one.
 *
 * The body places a solid. The GRIP at the right end places the same solid as
 * an ERASER -- a translucent red ghost that takes material away once it is
 * confirmed. The grip is deliberately a fraction of the row: adding is the
 * common act and gets the room, and a target the size of the row itself would
 * be caught by every drag that started a little too far right.
 *
 * Where the grip now sits, the row used to carry a chip per side count -- 3, 4,
 * 5, 6, 8. Those are gone, and the count is chosen by sweeping ACROSS the row
 * instead, the way the polygon chip in Shapes has always worked: the body is
 * split into invisible bands, and the band under the pointer is the polygon the
 * drag will place. It costs no width at all, which is what freed the right end.
 *
 * The one thing this borrows and the polygon chip does not is a visible track.
 * A chip that cycles through its shapes advertises that there is a family
 * inside it; ten rows all cycling at once would be a panel nobody could read,
 * so the family is advertised by a row of ticks under the name instead --
 * quiet, and it doubles as the readout for where the sweep has got to.
 */
function SolidRow({
  template,
  sides,
  onPickSides,
}: {
  template: SolidTemplate
  sides: number | undefined
  onPickSides: (sides: number) => void
}) {
  const startPlacingSolid = useDoc((s) => s.startPlacingSolid)
  const addObject = useDoc((s) => s.addObject)
  /** The band under the pointer, which outranks the resting count while it lasts. */
  const [hovered, setHovered] = useState<number | null>(null)

  const shown = hovered ?? sides
  const base = defaultBaseFor(template.kind, shown, template.platonic)
  const name = solidLabel(base)

  // Every press on the row places what the row is showing. A press that lands
  // on a band has already told us which polygon that is.
  const place = (e: ReactPointerEvent, erase: boolean, pick?: number) => {
    e.preventDefault()
    e.stopPropagation()
    if (pick !== undefined) onPickSides(pick)
    startPlacingSolid(defaultBaseFor(template.kind, pick ?? shown, template.platonic), erase)
  }

  return (
    <div
      className="solid-item"
      role="button"
      tabIndex={0}
      title={`Drag into the scene to place a ${name.toLowerCase()}`}
      aria-label={`${name}, drag into the scene`}
      onPointerLeave={() => setHovered(null)}
      onPointerDown={(e) => place(e, false)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        // A keyboard "drag" would leave the ghost following nothing, with no
        // release to end it, so activation drops the solid on the grid outright.
        e.preventDefault()
        addObject(base, groundedPosition(base))
      }}
    >
      <SolidIcon>{template.icon}</SolidIcon>
      <span className="solid-item-label">{name}</span>

      {template.sides && (
        <span className="solid-item-track" aria-hidden>
          {template.sides.map((n) => (
            <span key={n} className={n === shown ? 'solid-tick solid-tick-on' : 'solid-tick'} />
          ))}
        </span>
      )}

      {/* Laid over the row's body and stopping short of the grip. Buttons rather
          than bare divs so every polygon stays reachable by tab, and so the
          count can be chosen without a pointer at all. */}
      {template.sides && (
        <span className="solid-bands">
          {template.sides.map((n) => (
            <button
              key={n}
              type="button"
              className="solid-band"
              aria-label={solidLabel(defaultBaseFor(template.kind, n, template.platonic))}
              aria-pressed={n === sides}
              onPointerEnter={() => setHovered(n)}
              onFocus={() => setHovered(n)}
              onBlur={() => setHovered(null)}
              onPointerDown={(e) => place(e, false, n)}
            />
          ))}
        </span>
      )}

      <button
        type="button"
        className="solid-erase"
        title={`Drag out to erase with a ${name.toLowerCase()}. It takes nothing away until you confirm it under Position & Rotation.`}
        aria-label={`${name} eraser, drag into the scene`}
        onPointerDown={(e) => place(e, true)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          addObject(base, groundedPosition(base), true)
        }}
      >
        <EraseIcon />
      </button>
    </div>
  )
}

/**
 * Every template as a row, in a scroller four rows tall. All ten open at once
 * made the console's tallest panel the one you look at least: the scene tree and
 * the selected object both sat below the fold.
 *
 * Its own component so it can be rendered -- and checked -- without the closed
 * header above it.
 */
export function SolidList() {
  const [sides, setSides] = useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {}
    for (const t of SOLID_TEMPLATES) {
      const n = defaultSidesFor(t)
      if (n !== undefined) seed[t.key] = n
    }
    return seed
  })

  return (
    <div className="solid-list">
      {SOLID_TEMPLATES.map((t) => (
        <SolidRow
          key={t.key}
          template={t}
          sides={sides[t.key]}
          onPickSides={(n) => setSides((prev) => ({ ...prev, [t.key]: n }))}
        />
      ))}
    </div>
  )
}

/**
 * The drag source for 3D primitives. A gesture begins on pointerdown here and is
 * tracked on the window from then on, so the pointer can travel from this panel
 * onto the canvas without either element losing the thread.
 *
 * Side counts live per row and persist: the list rests on what the user actually
 * builds with instead of snapping back to a default between drags.
 *
 * Open at rest, but only four rows tall: the catalogue is what a session starts
 * with, so it should be there without a click -- what it must not do is push the
 * scene tree and the selected object off the bottom of the console, which all
 * ten rows at once did.
 */
export function SolidPalette() {
  return (
    <Section
      title="Solids"
      hint={`${SOLID_TEMPLATES.length}`}
      tip="Drag a row out of this list and onto the grid. The ghost follows the ground plane and the solid lands resting on it; hold Shift while moving one to lift it instead. Sweep across a row to choose how many sides its base has, and drag the small grip on the right to place the same solid as an eraser."
      collapsible
      defaultOpen
    >
      <SolidList />
    </Section>
  )
}
