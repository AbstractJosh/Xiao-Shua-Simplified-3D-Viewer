import { useEffect, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { BaseSolid } from '../geometry/types'
import { defaultBaseFor, solidLabel } from '../geometry/types'
import { surfaceFor } from '../geometry/surfaces'
import { useDoc } from '../store/docStore'
import { activates } from '../store/toolStore'
import { Section } from './Field'
import { prefersReducedMotion } from './motion'
import { EraseIcon } from './navIcons'
import { NGON_HOLD_MS, NGON_MORPH_MS } from './ngon'
import { SOLID_TEMPLATES, SolidFrame, restingSides } from './solidIcons'
import type { SolidTemplate } from './solidIcons'
import { iconFrame } from './solidMorph'
import type { MorphKind } from './solidMorph'

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
 * The icon of a row that places a FAMILY of solids rather than one solid.
 *
 * It draws the count the row is showing -- the band under the pointer, or the
 * row's own -- and MORPHS between counts rather than cutting, exactly as the
 * polygon chip in Shapes does. The two controls are choosing the same polygon,
 * and a cut here beside a morph there reads as two unrelated widgets.
 *
 * Left alone, it also spins through the family on its own. That is the only
 * sign the row gives, from across the panel, that a pyramid here can be any
 * pyramid: the ticks say a choice exists, but never what is in it. Under the
 * pointer it stops -- a hover is a question about one count, and an icon that
 * kept moving would answer a different one every beat -- and when it starts
 * again it starts from whatever the row is resting on, so the spin can never
 * carry the row away from the count the user picked.
 *
 * The label and the ticks sit this out. They are the row's promise about what a
 * drag will place, and a promise that rewrites itself once a second is not one.
 */
function FamilyIcon({
  kind,
  counts,
  shown,
  idle,
}: {
  kind: MorphKind
  counts: number[]
  shown: number
  idle: boolean
}) {
  /** Where the idle spin has got to; only ever the icon's business. */
  const [spun, setSpun] = useState(shown)
  const [morph, setMorph] = useState({ from: shown, to: shown, t: 1 })
  const goal = idle ? spun : shown
  const still = morph.t >= 1

  // A hover, or a pick, hands the spin a new place to carry on from.
  useEffect(() => setSpun(shown), [shown])

  useEffect(() => {
    const reduced = prefersReducedMotion()
    setMorph((m) =>
      m.to === goal
        ? m
        : reduced
          ? { from: goal, to: goal, t: 1 }
          : // A sweep across the bands can interrupt a morph in flight. The rim
            // is what the eye is following, so the new one sets off from the
            // count the old one had mostly arrived at rather than from where it
            // began -- close enough that the outline does not jump.
            { from: m.t >= 0.5 ? m.to : m.from, to: goal, t: 0 }
    )
  }, [goal])

  // One run is one morph. Unlike the polygon chip's single outline, a frame here
  // adds and removes whole edges -- three verticals are not eight -- so there is
  // no set of attributes to write straight to the node, and each frame goes
  // through React. It is a dozen frames on a handful of elements, twice.
  useEffect(() => {
    const { from, to } = morph
    if (from === to) return
    let frame = 0
    const begun = performance.now()
    const draw = (now: number) => {
      // Clamped both ends: a frame timestamp can predate the call that
      // scheduled it, and t < 0 would extrapolate past the shape we left.
      const t = Math.min(1, Math.max(0, (now - begun) / NGON_MORPH_MS))
      setMorph({ from, to, t })
      if (t < 1) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [morph.from, morph.to])

  // And one run of this is one turn of the spin: hold what has arrived, then
  // hand the next count to the morph above, which re-runs this when it lands.
  useEffect(() => {
    if (!idle || !still || prefersReducedMotion()) return
    const hold = setTimeout(
      // An unknown count restarts the family, as the chip's cycle does.
      () => setSpun(counts[(counts.indexOf(spun) + 1) % counts.length]),
      NGON_HOLD_MS
    )
    return () => clearTimeout(hold)
  }, [idle, still, spun, counts])

  return <SolidFrame frame={iconFrame(kind, morph.from, morph.to, morph.t)} />
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
 *
 * Two rows do cycle: the two that place a family, whose icon spins through the
 * bases it can be built on. That is nothing like ten, and it is confined to the
 * icon -- the ticks and the name hold still, so the row is still saying one
 * thing about what a drag will place while the picture beside it shows the
 * range. See `FamilyIcon`.
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
  /** Anywhere on the row, grip included: enough to call the row's spin off. */
  const [pointerOn, setPointerOn] = useState(false)

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
      onPointerEnter={() => setPointerOn(true)}
      onPointerLeave={() => {
        setPointerOn(false)
        setHovered(null)
      }}
      onPointerDown={(e) => place(e, false)}
      onKeyDown={(e) => {
        if (!activates(e.key)) return
        // A keyboard "drag" would leave the ghost following nothing, with no
        // release to end it, so activation drops the solid on the grid outright.
        e.preventDefault()
        addObject(base, groundedPosition(base))
      }}
    >
      <SolidIcon>
        {template.morph && template.sides && shown !== undefined ? (
          <FamilyIcon
            kind={template.morph}
            counts={template.sides}
            shown={shown}
            idle={!pointerOn && hovered === null}
          />
        ) : (
          template.icon
        )}
      </SolidIcon>
      {/* A family row rests under the family's name and takes the member's name
          only under the pointer, where the choice is. The tooltip and the
          accessible name stay specific either way: they say what a drag would
          place, which is a question the icon answers and a plural does not. */}
      <span className="solid-item-label">{hovered === null ? template.label : name}</span>

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
          if (!activates(e.key)) return
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
      const n = restingSides(t.kind)
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
