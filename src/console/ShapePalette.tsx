import { useState } from 'react'
import type { Shape2D } from '../geometry/types'
import {
  DEFAULT_SIDES,
  NGON_NAMES,
  NGON_SIDES_TOP_DOWN,
  ngonPoints,
} from './ngon'
import { useDoc } from '../store/docStore'
import { Section } from './Field'

const NGON_RADIUS = 0.35
function ChipIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 32 32" className="chip-icon" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  )
}

/**
 * The polygon chip is one square target split into six invisible bands. The
 * band under the pointer previews its polygon in the chip's own icon, so the
 * side count is chosen by *where* the drag starts rather than by a separate
 * control. Bands carry no visible edges by design.
 */
function NgonChip() {
  const startPlacing = useDoc((s) => s.startPlacing)
  const [hovered, setHovered] = useState<number | null>(null)
  // Remembering the last pick means the chip rests on what you actually use,
  // instead of snapping back to a default every time the pointer leaves.
  const [lastUsed, setLastUsed] = useState(DEFAULT_SIDES)

  const shown = hovered ?? lastUsed

  return (
    <div
      className="chip chip-ngon"
      onPointerLeave={() => setHovered(null)}
      title="Drag from a band to place that polygon"
    >
      <div className="chip-face">
        <ChipIcon>
          <polygon points={ngonPoints(shown)} />
        </ChipIcon>
        <span>{NGON_NAMES[shown]}</span>
      </div>

      <div className="ngon-bands">
        {/* Laid out top-down, so fewest sides land at the bottom. */}
        {NGON_SIDES_TOP_DOWN.map((sides) => (
          <button
            key={sides}
            type="button"
            className="ngon-band"
            aria-label={`${NGON_NAMES[sides]}, ${sides} sides`}
            onPointerEnter={() => setHovered(sides)}
            onFocus={() => setHovered(sides)}
            onBlur={() => setHovered(null)}
            onPointerDown={(e) => {
              e.preventDefault()
              setLastUsed(sides)
              startPlacing({ type: 'ngon', r: NGON_RADIUS, sides })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function SimpleChip({
  label,
  shape,
  children,
}: {
  label: string
  shape: Shape2D
  children: React.ReactNode
}) {
  const startPlacing = useDoc((s) => s.startPlacing)
  return (
    <button
      type="button"
      className="chip"
      onPointerDown={(e) => {
        e.preventDefault()
        startPlacing(shape)
      }}
    >
      <div className="chip-face">
        <ChipIcon>{children}</ChipIcon>
        <span>{label}</span>
      </div>
    </button>
  )
}

/**
 * The drag source. A gesture begins here on pointerdown and is tracked on the
 * window from then on, so the pointer can travel from this panel onto the
 * canvas without either element losing the thread.
 */
export function ShapePalette() {
  return (
    <Section
      title="Shapes"
      tip="Drag a shape onto any object in the scene. It lands on the surface under the pointer, flat faces and curved ones alike, and becomes a boss or a pocket once it has a depth."
    >
      <div className="palette">
        <SimpleChip label="Circle" shape={{ type: 'circle', r: 0.3 }}>
          <circle cx="16" cy="16" r="12" />
        </SimpleChip>
        <SimpleChip label="Rectangle" shape={{ type: 'rect', w: 0.6, h: 0.6 }}>
          <rect x="4" y="6" width="24" height="20" rx="1.5" />
        </SimpleChip>
        <NgonChip />
      </div>
    </Section>
  )
}
