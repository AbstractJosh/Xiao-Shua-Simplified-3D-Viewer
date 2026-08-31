import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { Clay } from '../geometry/clay'
import { snapsHere, useTools } from '../store/toolStore'
import { formatLength } from '../units'
import { latheRulerLength, snapLatheEnd } from './latheRuler'
import type { LatheRuler, LatheRulerEnd } from './latheRuler'
import { clayY, pointerToClay } from './latheView'
import type { ClayFrame } from './latheView'

/**
 * The rulers laid over the section, and the readings that say what they
 * measure.
 *
 * The modelling screen's ruler ported to a screen with no camera in it. What
 * came across is the whole of what the tool IS -- two ends, the line between
 * them, the number riding the middle of it rather than sitting in a panel
 * across the window from the thing being measured, and hazard stripes on the
 * one that is selected. What could not come across is every mechanism it used
 * to do that: there is no gizmo here, no raycaster and nothing to project,
 * because this viewport is an `<svg>` whose viewBox is measured in scene units
 * and the browser does the one transform there is.
 *
 * WHICH MAKES THE ENDS SIMPLER RATHER THAN HARDER. On the bench an end is
 * dragged by three arrows and three quads, because a point in a room cannot be
 * placed by pointing at it -- the pointer names a RAY, and the gizmo is what
 * chooses a point along it. Here the drawing is flat and the pointer names a
 * point outright, so an end is taken hold of and moved, which is what everybody
 * expected the first tool to do anyway.
 *
 * WHAT IT CATCHES lives next door in `latheRuler.ts`, pure and checkable. This
 * file's share of the snap is the one thing that file cannot know: how big the
 * drawing currently is on glass, which is what turns the user's tolerance in
 * pixels into a length in the clay.
 */

/**
 * The line's width, the end markers' radii and the reading's type size, as
 * fractions of the FRAME.
 *
 * Which is what makes every one of them a size on SCREEN. The frame is a fixed
 * square fitted to the window -- see `clayFrame` -- so a mark measured as a
 * fraction of it is the same size under the eye at every zoom, while one
 * measured in the clay would be a hairline on a small piece and a bar across a
 * large one. It is the rule the tool's own ghost already follows.
 *
 * The stroke widths are NOT done this way: the rest of this screen draws its
 * strokes with `vector-effect: non-scaling-stroke` and a width in CSS pixels,
 * which is the same guarantee arrived at from the other end, and a ruler that
 * measured its line one way and its knobs another would drift apart from the
 * clay it is drawn over.
 */
const DOT_OF_FRAME = 0.006
const KNOB_OF_FRAME = 0.0105
/** The invisible disc that catches a press: half again as big as the knob it
 *  stands under, so an end can be grabbed by aiming AT it rather than by
 *  hitting it exactly. */
const GRAB_OF_FRAME = 0.017
/** The reading, sized so it comes out at about eleven pixels in a window this
 *  screen is usually given -- the size the modelling screen's chip is set in. */
const TEXT_OF_FRAME = 0.0165
/** How far the reading floats off the line it belongs to, so it is beside the
 *  measurement rather than lying along it. */
const TEXT_LIFT_OF_FRAME = 0.022

/**
 * The reference the reading's type is scaled from.
 *
 * The text is drawn inside a group scaled by `frame.width / TEXT_SPACE`, rather
 * than with a font-size of `frame.width * TEXT_OF_FRAME` written straight onto
 * it, and the difference is not style. At the far end of this screen's zoom the
 * frame is under four millimetres across, which would put the declared
 * font-size at four thousandths of a unit -- a number small enough that
 * browsers start disagreeing about hinting, letter spacing and whether to draw
 * the text at all. Scaled by a transform instead, the declared size stays an
 * ordinary two-figure number at every zoom and the browser is doing the one
 * thing it is reliably good at.
 */
const TEXT_SPACE = 1000

/** Which end of a ruler is in hand, and which ruler it belongs to. */
type Grip = { id: string; end: LatheRulerEnd }

/**
 * One ruler: the line, a knob at each end, and its reading.
 *
 * Everything is drawn in the frame's space -- `x` straight through, because the
 * clay's signed radius IS the drawing's x, and the height through `clayY`,
 * which is the one place the flip lives.
 */
function RulerBody({
  ruler,
  frame,
  chosen,
  handlers,
}: {
  ruler: LatheRuler
  frame: ClayFrame
  chosen: boolean
  /** The whole gesture, bound to one end: press, move, release. All four hang
   *  off the knob itself rather than off a sheet over the drawing, because the
   *  press takes the pointer CAPTURE -- so every move and the release are
   *  retargeted here however far the hand has wandered, and a sheet would never
   *  see them. */
  handlers: (end: LatheRulerEnd) => {
    onPointerDown: (e: ReactPointerEvent<SVGCircleElement>) => void
    onPointerMove: (e: ReactPointerEvent<SVGCircleElement>) => void
    onPointerUp: (e: ReactPointerEvent<SVGCircleElement>) => void
    onPointerCancel: (e: ReactPointerEvent<SVGCircleElement>) => void
  }
}) {
  const displayUnit = useTools((s) => s.displayUnit)

  const [a, b] = ruler.ends
  const ax = a[0]
  const ay = clayY(frame, a[1])
  const bx = b[0]
  const by = clayY(frame, b[1])

  const length = latheRulerLength(ruler)
  // A ruler dragged onto itself has no direction for the reading to stand off,
  // and a zero-length line normalises to NaN -- which takes the text out of the
  // frame entirely rather than merely drawing it in an odd place.
  const span = Math.hypot(bx - ax, by - ay)
  const lift = frame.width * TEXT_LIFT_OF_FRAME
  // Perpendicular to the line, so the number sits beside a level ruler and
  // beside an upright one without a case for either.
  const offX = span > 1e-9 ? (-(by - ay) / span) * lift : 0
  const offY = span > 1e-9 ? ((bx - ax) / span) * lift : -lift

  return (
    <g className={`lathe-ruler${chosen ? ' lathe-ruler-on' : ''}`}>
      {/* Selected: yellow marks over a dark band. TWO lines rather than one
          dashed one, because a dash pattern shows whatever is BEHIND the gaps
          -- over the clay that is the clay, and the stripes would read as a
          ruler with holes in it rather than as hazard tape. The band underneath
          is what makes the gaps black. It is the modelling ruler's own trick,
          and it is here so the two screens' selected rulers look like the same
          object. */}
      {chosen && (
        <line
          className="lathe-ruler-band"
          x1={ax}
          y1={ay}
          x2={bx}
          y2={by}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <line
        className="lathe-ruler-line"
        x1={ax}
        y1={ay}
        x2={bx}
        y2={by}
        vectorEffect="non-scaling-stroke"
      />

      {/* The reading, floated off the middle of the line. SVG text rather than
          the DOM chip the modelling screen uses, and that is not an
          inconsistency -- the chip exists over there because the number would
          otherwise be 3D text, which cannot stay upright or crisp under an
          orbiting camera. Here the drawing is flat and square on, so text in it
          is already upright and already crisp, and putting it in the DOM would
          mean writing this screen's one transform out a second time in pixels
          to place it. */}
      <g transform={`translate(${(ax + bx) / 2 + offX} ${(ay + by) / 2 + offY}) scale(${frame.width / TEXT_SPACE})`}>
        <text
          className="lathe-ruler-text"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={TEXT_OF_FRAME * TEXT_SPACE}
          // Painted stroke-first so the halo sits BEHIND the glyphs rather than
          // eating into them: it is there to lift the number off whatever it
          // happens to lie across, not to outline it.
          paintOrder="stroke"
        >
          {formatLength(length, displayUnit)}
        </text>
      </g>

      {([0, 1] as const).map((end) => {
        const at = end === 0 ? a : b
        return (
          <g key={end}>
            <circle
              className="lathe-ruler-end"
              cx={at[0]}
              cy={clayY(frame, at[1])}
              r={frame.width * (chosen ? KNOB_OF_FRAME : DOT_OF_FRAME)}
              vectorEffect="non-scaling-stroke"
            />
            {/* Drawn rather than merely sized: the disc that CATCHES the press
                is wider than the knob and fully transparent, so aiming near an
                end is enough. Filled, because an SVG shape with no fill takes
                no pointer at all in its middle. */}
            <circle
              className="lathe-ruler-grab"
              cx={at[0]}
              cy={clayY(frame, at[1])}
              r={frame.width * GRAB_OF_FRAME}
              {...handlers(end)}
            />
          </g>
        )
      })}
    </g>
  )
}

/**
 * Every ruler on the section, and the guides that show what an end has caught.
 *
 * A `<g>` inside the lathe's own `<svg>` rather than a layer of its own, so it
 * shares the one viewBox and needs no transform. It is mounted over the clay
 * and under the tool's ghost: a measurement drawn behind the piece it measures
 * is a measurement you cannot read, and the ghost is the cursor, which nothing
 * may cover.
 */
export function LatheRulers({
  frame,
  clay,
  svg,
}: {
  frame: ClayFrame
  clay: Clay
  /** The element the whole screen is drawn in, for reading the pointer back
   *  against. The ends are inside it, so their own boxes are no use: the
   *  transform `pointerToClay` inverts is the svg's. */
  svg: RefObject<SVGSVGElement | null>
}) {
  const active = useTools((s) => s.latheRulerActive)
  const rulers = useTools((s) => s.latheRulers)
  const selected = useTools((s) => s.selectedLatheRuler)

  /**
   * Which end is in hand, and what it last caught.
   *
   * React state rather than a ref, because both are DRAWN -- the grip decides
   * nothing on its own, but the guides are lines on screen and they have to
   * appear and go with the gesture. It costs a render per pointer move, which
   * is what this screen already spends on the tool's ghost.
   */
  const [grip, setGrip] = useState<Grip | null>(null)
  const [guide, setGuide] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  })
  const held = useRef<Grip | null>(null)

  /**
   * Where the pointer is in the clay's terms, and how much of the clay a pixel
   * is worth there.
   *
   * The scale is the whole reason this is one function: the user sets the
   * snap's reach in pixels, `snapLatheEnd` wants a length in the clay, and the
   * only thing that knows the exchange rate is the element the drawing is
   * currently laid out in. It is the same `meet` fit `pointerToClay` inverts,
   * read for its scale rather than for its offsets.
   */
  const readPointer = (clientX: number, clientY: number) => {
    const node = svg.current
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
    if (!Number.isFinite(scale) || scale <= 0) return null
    const spot = pointerToClay(frame, rect, clientX, clientY)
    return { at: [spot.x, spot.y] as [number, number], scale }
  }

  const grab = (e: ReactPointerEvent<SVGCircleElement>, id: string, end: LatheRulerEnd) => {
    // The right button pans and opens menus everywhere else in the app, and a
    // ruler lying across the piece must not be a hole in that.
    if (e.button !== 0) return
    // THE PRESS STOPS HERE. The svg underneath takes a left press as a stroke
    // with whatever tool is in hand, so without this, taking hold of a ruler
    // would gouge the piece it was measuring. It is also what lets the ruler
    // and the shaping tools share a screen without either being a mode: with a
    // tool in hand a press on the clay still shapes it, and a press on an end
    // still moves the end.
    e.stopPropagation()
    // Captured on the knob, so a drag that leaves the drawing keeps working and
    // -- more to the point -- so the release is heard wherever it happens. An
    // uncaptured pointer let go outside the element would leave the end stuck
    // to the cursor. Guarded, because capture is an improvement and the drag is
    // not: the call throws on a pointer the browser no longer knows about,
    // which is what a synthetic event is.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Without capture the drag still works; it simply ends at the edge.
    }
    held.current = { id, end }
    setGrip({ id, end })
    useTools.getState().selectLatheRuler(id)
  }

  const move = (e: ReactPointerEvent<SVGCircleElement>) => {
    const grabbed = held.current
    if (!grabbed) return
    const read = readPointer(e.clientX, e.clientY)
    if (!read) return

    const tools = useTools.getState()
    const ruler = tools.latheRulers.find((r) => r.id === grabbed.id)
    // Deleted mid-drag -- from the panel, or by the Delete key -- which is rare
    // and must not write to a ruler that is no longer there.
    if (!ruler) return

    // Off is not a mode inside the arithmetic: with the switch down the reach
    // is simply nothing, and nothing catches. See `snapLatheEnd`.
    const reach = tools.snap && snapsHere(tools) ? tools.latheSnapDistance / read.scale : 0
    const other = ruler.ends[grabbed.end === 0 ? 1 : 0]
    const landed = snapLatheEnd(read.at, other, clay, reach)

    tools.setLatheRulerEnd(grabbed.id, grabbed.end, landed.at)
    // Compared before it is written, so a drag along an edge it is already
    // caught on does not re-render the guides sixty times a second to draw the
    // same two lines.
    setGuide((was) =>
      was.x === landed.onX && was.y === landed.onY ? was : { x: landed.onX, y: landed.onY }
    )
  }

  const release = (e: ReactPointerEvent<SVGCircleElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // Nothing to do about it, and nothing that needs doing.
    }
    held.current = null
    setGrip(null)
    // The guides belong to the gesture, so they go with it. What they said is
    // still true -- the end really is on that edge -- but a guide left standing
    // is a line across the drawing nobody is using.
    setGuide({ x: null, y: null })
  }

  if (!active) return null

  return (
    <g className="lathe-rulers">
      {/* The guides, UNDER the rulers, so one never hides the end that
          summoned it. Each runs the full frame, which is what makes it read as
          a line the end has landed ON rather than as a second measurement. */}
      {grip && guide.x !== null && (
        <line
          className="lathe-ruler-guide"
          x1={guide.x}
          y1={frame.y}
          x2={guide.x}
          y2={frame.y + frame.height}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {grip && guide.y !== null && (
        <line
          className="lathe-ruler-guide"
          x1={frame.x}
          y1={clayY(frame, guide.y)}
          x2={frame.x + frame.width}
          y2={clayY(frame, guide.y)}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {rulers.map((ruler) => (
        <RulerBody
          key={ruler.id}
          ruler={ruler}
          frame={frame}
          chosen={ruler.id === selected}
          handlers={(end) => ({
            onPointerDown: (e) => grab(e, ruler.id, end),
            onPointerMove: move,
            onPointerUp: release,
            onPointerCancel: release,
          })}
        />
      ))}
    </g>
  )
}
