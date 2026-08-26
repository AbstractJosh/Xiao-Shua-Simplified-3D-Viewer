import { useState } from 'react'
import type { ReactNode } from 'react'
import type { BaseSolid } from '../geometry/types'
import { defaultBaseFor, solidLabel } from '../geometry/types'
import { surfaceFor } from '../geometry/surfaces'
import { useDoc } from '../store/docStore'
import { Section } from './Field'
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
 * The side count a row rests on before anyone touches its chips. Read back out of
 * the geometry layer rather than written down here, so the chip that looks active
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

  const base = defaultBaseFor(template.kind, sides, template.platonic)
  const name = solidLabel(base)

  return (
    <div
      className="solid-item"
      role="button"
      tabIndex={0}
      title={`Drag into the scene to place a ${name.toLowerCase()}`}
      aria-label={`${name}, drag into the scene`}
      onPointerDown={(e) => {
        e.preventDefault()
        startPlacingSolid(base)
      }}
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
        <span className="solid-item-sides">
          {template.sides.map((n) => {
            const sideBase = defaultBaseFor(template.kind, n, template.platonic)
            return (
              <button
                key={n}
                type="button"
                className={n === sides ? 'solid-side solid-side-active' : 'solid-side'}
                aria-label={solidLabel(sideBase)}
                aria-pressed={n === sides}
                onPointerDown={(e) => {
                  e.preventDefault()
                  // Handled here rather than let through to the row: the row would
                  // read the previous side count, since this render has not happened
                  // yet. Pressing a chip and dragging off it still places, as it must.
                  e.stopPropagation()
                  onPickSides(n)
                  startPlacingSolid(sideBase)
                }}
              >
                {n}
              </button>
            )
          })}
        </span>
      )}
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
 */
export function SolidPalette() {
  const [sides, setSides] = useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {}
    for (const t of SOLID_TEMPLATES) {
      const n = defaultSidesFor(t)
      if (n !== undefined) seed[t.key] = n
    }
    return seed
  })

  return (
    <Section title="Solids" hint="drag into the scene" collapsible defaultOpen>
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
    </Section>
  )
}
