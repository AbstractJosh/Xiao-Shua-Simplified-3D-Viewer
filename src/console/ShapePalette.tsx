import { useEffect, useRef, useState } from 'react'
import type { Shape2D } from '../geometry/types'
import { defaultShape } from '../geometry/types'
import {
  DEFAULT_SIDES,
  NGON_HOLD_MS,
  NGON_LABEL,
  NGON_MORPH_MS,
  NGON_NAMES,
  NGON_SIDES,
  morphPoints,
  nextNgonSides,
  ngonPoints,
} from './ngon'
import { prefersReducedMotion } from './motion'
import { useDoc } from '../store/docStore'
import { Section } from './Field'

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
 * The polygon chip is one target split into six invisible bands. The band under
 * the pointer previews its polygon in the chip's own icon, so the side count is
 * chosen by *where* the drag starts rather than by a separate control. Bands
 * carry no visible edges by design.
 *
 * The bands run ACROSS the chip, not down it. They used to stack, and the chip
 * was square to give six of them room to stack in -- which is what made this
 * the tallest thing in the console for three shapes. Turned on their side they
 * are as wide as they used to be tall, so the sweep lost nothing, and the chip
 * stopped having to be as tall as the panel is wide. It is also the gesture a
 * Solids row already asks for, which is the other half of why: the two controls
 * choose the same polygon and should not want opposite hands.
 *
 * Left alone, it morphs through every polygon it can place, named for the
 * family rather than for whichever member is on screen: a chip sitting still
 * on a hexagon labelled "Hexagon" looks like a hexagon button, and the bands
 * that make it more than that are invisible until the pointer finds them.
 * Under the pointer it stops cycling and behaves exactly as before -- a hover
 * is a question about one band, and an icon that kept moving would answer a
 * different one every beat.
 */
function NgonChip() {
  const startPlacing = useDoc((s) => s.startPlacing)
  const [hovered, setHovered] = useState<number | null>(null)
  // Where the cycle has got to. A pick drops it onto that polygon, so letting
  // go of a drag does not throw the chip somewhere unrelated to what you did.
  const [resting, setResting] = useState(DEFAULT_SIDES)

  const outline = useRef<SVGPolygonElement>(null)

  // One run of this effect is one turn of the cycle: hold what is on screen,
  // morph off it, then hand the finished polygon back to React -- which
  // re-renders, re-runs this, and holds again.
  //
  // Frames go straight to the node. Re-rendering to move an outline would push
  // 33 fresh coordinates through the reconciler sixty times a second for
  // something no other part of the UI reads.
  useEffect(() => {
    if (hovered !== null || prefersReducedMotion()) return
    let frame = 0
    const hold = setTimeout(() => {
      const to = nextNgonSides(resting)
      const begun = performance.now()
      const draw = (now: number) => {
        // Clamped both ends: a frame timestamp can predate the call that
        // scheduled it, and t < 0 would extrapolate past the shape we left.
        const t = Math.min(1, Math.max(0, (now - begun) / NGON_MORPH_MS))
        outline.current?.setAttribute('points', morphPoints(resting, to, t))
        if (t < 1) frame = requestAnimationFrame(draw)
        // The final frame drew `to` exactly, so this hands the shape back
        // without changing it -- and starts the next hold.
        else setResting(to)
      }
      frame = requestAnimationFrame(draw)
    }, NGON_HOLD_MS)
    return () => {
      clearTimeout(hold)
      cancelAnimationFrame(frame)
    }
  }, [hovered, resting])

  const shown = hovered ?? resting

  return (
    <div
      className="chip chip-ngon"
      onPointerLeave={() => setHovered(null)}
      title="Drag from a band to place that polygon"
    >
      <div className="chip-face">
        <ChipIcon>
          {/* Keyed: a morph leaves coordinates on the node that React never
              wrote, so landing back on a shape it has already rendered --
              hovering the band the cycle is resting on -- needs a remount to
              repaint rather than a prop it considers unchanged. */}
          <polygon key={shown} ref={outline} points={ngonPoints(shown)} />
        </ChipIcon>
        <span>{hovered === null ? NGON_LABEL : NGON_NAMES[hovered]}</span>
      </div>

      <div className="ngon-bands">
        {/* Ascending left to right, as the ticks on a Solids row read. */}
        {NGON_SIDES.map((sides) => (
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
              setResting(sides)
              // The size comes from `defaultShape` rather than from a literal
              // here: the palette is not the place that decides how big a
              // fresh sketch is, and a second copy of that number is a second
              // thing to miss when the scale of the app moves.
              startPlacing(defaultShape('ngon', sides))
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
        <SimpleChip label="Circle" shape={defaultShape('circle')}>
          <circle cx="16" cy="16" r="12" />
        </SimpleChip>
        <SimpleChip label="Rectangle" shape={defaultShape('rect')}>
          <rect x="4" y="6" width="24" height="20" rx="1.5" />
        </SimpleChip>
        <NgonChip />
      </div>
    </Section>
  )
}
