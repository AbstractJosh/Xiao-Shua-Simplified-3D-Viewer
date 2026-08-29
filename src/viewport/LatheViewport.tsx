import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { PullTool, PushTool } from '../console/LatheTools'
import { bite, isFresh, widestRadius } from '../geometry/clay'
import { useLathe } from '../store/latheStore'
import { armedLatheTool, useTools } from '../store/toolStore'
import { formatLength } from '../units'
import {
  clayFrame,
  clayY,
  pointerToClay,
  silhouette,
  stockRect,
  turningRings,
  viewBoxOf,
} from './latheView'
import { CopyPieceButton } from './CopyPieceButton'
import { StockPanel } from './StockPanel'
import { IslandShell } from './ToolIsland'

/**
 * The Lathe screen's viewport: a lump of clay on a lathe, seen from the side.
 *
 * NO CANVAS, NO CAMERA, NO RENDERER -- and that is the design rather than a
 * corner cut. A piece turned on a lathe is a solid of revolution: it is the same
 * all the way round, so a side view of it loses NOTHING. There is no angle it
 * looks different from, no face hidden behind another, and nothing an orbit
 * could reveal. Given that, rendering it in three dimensions would be spending
 * a WebGL context, a mesh rebuild per frame and a camera the user has to fly
 * around, in order to show a shape that one filled path already shows exactly.
 * So the whole screen is an `<svg>` whose viewBox is measured in scene units --
 * see `latheView.ts` -- and the shaping is a loop over an array of radii.
 *
 * What that buys, beyond the frames: the second screen no longer holds a WebGL
 * context open. A browser hands out eight to sixteen, the clipboard's live
 * thumbnails are already spending three, and this one now costs none.
 *
 * IT DOES NOT SPIN, and that is not a thing left undone. A shape that is the
 * same all the way round looks IDENTICAL while it turns -- a spinning piece, seen
 * from the side, is a still picture. Animating one would be inventing a wobble
 * the piece does not have. What the lathe actually gives the user is somewhere
 * else, in the one behaviour that would make no sense on a static object: hold
 * the tool still and the wall keeps coming to it, because it is the clay that is
 * moving, not the tool. See the frame loop below.
 *
 * The camera question the modelling screen answers with an orbit is answered
 * here by not asking it. The frame is fitted to the STOCK and never re-fitted
 * (see `clayFrame`), so the piece sits still under the hand for the whole
 * sitting: no zoom, no pan, nothing to put back.
 */

/** How many turning rings are drawn across the body. Enough to read the curve
 *  they lie on, few enough that they stay marks on a piece rather than a chart. */
const RINGS_DRAWN = 11

/**
 * Take or give up the pointer, and survive being told no.
 *
 * Both calls throw on a pointer the browser does not currently know about, and
 * "currently" covers more cases than it sounds like: a pointer already released
 * by the browser itself, one cancelled by the system, and any event that did
 * not come from real hardware. Capture is what keeps a stroke alive past the
 * edge of the element; it is not what makes the stroke work, so it must never
 * be able to stop one starting or -- worse -- stop one ending.
 */
function capture(e: ReactPointerEvent<SVGSVGElement>, take: boolean) {
  try {
    if (take) e.currentTarget.setPointerCapture(e.pointerId)
    else if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  } catch {
    // Nothing to do about it, and nothing that needs doing: without capture the
    // stroke still works, it simply ends at the edge of the drawing.
  }
}

export function LatheViewport() {
  const clay = useLathe((s) => s.clay)
  const displayUnit = useTools((s) => s.displayUnit)
  const tool = useTools((s) => s.latheTool)
  // Only the armed tool's size is subscribed to, because only it is DRAWN. The
  // strength is read at the instant of contact instead -- see the loop below --
  // so turning that dial mid-stroke changes the next frame without making this
  // component re-render for a number nothing on screen shows.
  const reach = useTools((s) => (s.latheTool === 'pull' ? s.pullReach : s.pushReach))

  /**
   * Where the pointer is, in the clay's own terms, or null when it is not over
   * the lathe.
   *
   * React state rather than a ref, because it is DRAWN: the ghost circle is how
   * you aim, and a circle updated outside React would have to be moved by hand
   * every frame. It costs a render per pointer move, which is what a viewport
   * that follows the pointer costs.
   */
  const [at, setAt] = useState<{ x: number; y: number; radius: number } | null>(null)
  /** Whether the tool is against the clay right now. */
  const [working, setWorking] = useState(false)
  /**
   * The same position, for the frame loop to read.
   *
   * A ref beside the state, and not redundant: the loop below runs on its own
   * clock and must see where the pointer is NOW, not where it was when the
   * effect that started the loop last closed over it. Writing both from one
   * place is what keeps them from disagreeing.
   */
  const held = useRef<{ x: number; y: number; radius: number } | null>(null)

  const frame = useMemo(() => clayFrame(clay), [clay.height, clay.radius])
  const wall = useMemo(() => silhouette(clay, frame), [clay, frame])
  const rings = useMemo(() => turningRings(clay, frame, RINGS_DRAWN), [clay, frame])
  const stock = stockRect(clay, frame)

  /**
   * THE LATHE ITSELF. While the tool is held against the clay, the wall goes on
   * travelling toward it, frame after frame, whether or not the hand is moving.
   *
   * This is the one place the metaphor is load-bearing. On a lathe it is the
   * PIECE that moves: you hold a tool at a height and the clay turns under it
   * until the wall is where the tool is. A drawing program would move the wall
   * once per pointer event, so shaping would mean scrubbing the mouse back and
   * forth; here it means holding still, and the shape arrives at the speed the
   * Strength dial sets.
   *
   * It cannot overshoot, which is what makes holding still safe: a dab carries
   * the wall a fraction of the way TO the pointer and stops there -- see `mold`
   * -- so a tool left down for a second longer changes nothing except how
   * finished the curve is.
   *
   * Measured in milliseconds rather than in frames, so the same gesture takes
   * the same material off at 60 Hz and at 144. The tool is read from the store
   * at the top of each frame rather than closed over, so switching tool or
   * turning a dial mid-stroke takes effect on the next frame rather than at the
   * next press.
   */
  useEffect(() => {
    if (!working) return

    let raf = 0
    let last = performance.now()

    const step = (now: number) => {
      raf = requestAnimationFrame(step)
      const ms = now - last
      last = now

      const armed = armedLatheTool(useTools.getState())
      const spot = held.current
      // The tool can be put down mid-stroke from the island, and the pointer can
      // be somewhere the frame does not reach. Either way there is nothing to
      // work, and the loop keeps turning rather than tearing down: the button
      // that disarmed it is one click from arming it again.
      if (!armed || !spot) return

      useLathe.getState().work({
        y: spot.y,
        radius: spot.radius,
        reach: armed.reach,
        bite: bite(armed.strength, ms),
        push: armed.tool === 'push',
      })
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [working])

  const track = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const spot = pointerToClay(frame, rect, e.clientX, e.clientY)
    held.current = spot
    setAt(spot)
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    // Left button only, and only with a tool in hand. The right button is left
    // alone the way it is everywhere else in the app.
    if (e.button !== 0 || useTools.getState().latheTool === null) return
    track(e)
    // Captured, so a stroke that runs off the edge of the lathe keeps working
    // and, more to the point, so the release is heard wherever it happens --
    // an uncaptured pointer let go outside the element would leave the tool
    // down and the wall still travelling.
    //
    // Guarded, because capture is an optimisation and the stroke is not: the
    // call throws on a pointer the browser no longer knows about -- one already
    // released, or one that never existed, which is what a synthetic event is
    // -- and a throw here would take the whole press down with it.
    capture(e, true)
    // The wall this stroke is cut from, remembered before the first frame
    // touches it: it is what the dish is measured against. See `mold`.
    useLathe.getState().beginStroke()
    setWorking(true)
  }

  const stopWorking = (e: ReactPointerEvent<SVGSVGElement>) => {
    capture(e, false)
    useLathe.getState().endStroke()
    setWorking(false)
  }

  const widest = widestRadius(clay)
  // Read out to anyone who cannot see the drawing, in the same two numbers the
  // readout in the corner shows: what is on the lathe, and how big it has got.
  const label =
    `Clay on the lathe, ${formatLength(clay.height, displayUnit)} tall` +
    ` and ${formatLength(widest * 2, displayUnit)} across`

  return (
    <div className={`viewport lathe${tool ? ' lathe-armed' : ''}`}>
      <svg
        className="lathe-view"
        viewBox={viewBoxOf(frame)}
        // The frame is fitted inside whatever shape the window leaves, centred,
        // never stretched: a piece in a narrow window is a smaller piece, not an
        // oval one. `pointerToClay` inverts exactly this.
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={track}
        onPointerUp={stopWorking}
        onPointerCancel={stopWorking}
        // Only meaningful when nothing is captured, which is exactly when it
        // should fire: the ghost belongs to a pointer that is over the lathe.
        onPointerLeave={() => {
          held.current = null
          setAt(null)
        }}
        role="img"
        aria-label={label}
      >
        {/* The stock, once the piece has left it: a dashed rectangle where the
            lump started, so you can see what you have taken off and what you
            have pulled out past it. Withheld while the wall is still where the
            stock left it, where it would be a dashed line drawn along a solid
            edge -- which reads as a rendering fault, not as a reference. */}
        {!isFresh(clay) && (
          <rect
            className="lathe-stock"
            x={stock.x}
            y={stock.y}
            width={stock.width}
            height={stock.height}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* The clay. One filled path, mirrored from one row of radii, so the
            two walls cannot disagree about the shape between them. */}
        <path className="lathe-clay" d={wall} vectorEffect="non-scaling-stroke" />

        {/* The axis the piece is turned about, drawn OVER the clay and running a
            little past both ends of it.

            A centre line, in the sense a sectioned drawing means: this whole
            screen is a section through something round, and the line down the
            middle is what says so. It was under the clay to begin with, which
            hid all of it but a stub above the rim -- a dashed inch of nothing
            floating over the piece, which reads as an artefact rather than as
            an axis. Over the clay and faint, it reads as the thing the piece
            turns about, and it marks the limit a push works toward. */}
        <line
          className="lathe-axis"
          x1={0}
          y1={clayY(frame, clay.height) - clay.height * 0.05}
          x2={0}
          y2={frame.base + clay.height * 0.02}
          vectorEffect="non-scaling-stroke"
        />

        {/* The rings a hand leaves in a turning piece -- see `turningRings`. */}
        <g className="lathe-rings" aria-hidden>
          {rings.map((ring, i) => (
            <line
              key={i}
              x1={-ring.r}
              y1={ring.y}
              x2={ring.r}
              y2={ring.y}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>

        {/* The faceplate: the disc the lump is centred on, edge-on. It is
            drawn wider than the widest the wall may ever be worked, so the piece
            can never overhang the thing it is standing on. */}
        <rect
          className="lathe-plate"
          x={frame.x + frame.width * 0.06}
          y={frame.base}
          width={frame.width * 0.88}
          height={clay.height * 0.035}
          rx={clay.height * 0.012}
          vectorEffect="non-scaling-stroke"
        />

        {/* The tool, where the pointer is: how wide it is, and which way it
            works. Drawn only while a tool is in hand -- with empty hands the
            pointer is just a pointer -- and it is the tool's REACH, so what you
            see is exactly the stretch of wall a press would move. */}
        {tool && at && (
          <g className={`lathe-tool lathe-tool-${tool}`} aria-hidden>
            <circle
              cx={at.x}
              cy={clayY(frame, at.y)}
              r={reach}
              vectorEffect="non-scaling-stroke"
            />
            {/* The line the wall is being called to. It is the whole promise of
                the tool -- the wall stops here and not past it -- and it is the
                only mark that says where the pointer is as opposed to how big
                the tool is. */}
            <line
              className="lathe-tool-mark"
              x1={at.x}
              y1={clayY(frame, at.y) - reach * 0.34}
              x2={at.x}
              y2={clayY(frame, at.y) + reach * 0.34}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>

      {/* What is on the lathe, in whatever unit the app is being read in. The
          two numbers the Clay panel sets, plus the one it cannot: how wide the
          piece has actually become. Bottom-right, the corner the modelling
          screen keeps for what is selected -- this screen has one thing and it
          is always selected. */}
      <div className="lathe-readout">
        <span>{formatLength(clay.height, displayUnit)} tall</span>
        <span className="lathe-readout-sep" aria-hidden>
          ·
        </span>
        <span>{formatLength(widest * 2, displayUnit)} across</span>
      </div>

      {/* Empty hands, and the one thing to say about it. It goes the moment a
          tool is taken up, and never comes back while one is in hand. */}
      {!tool && (
        <p className="viewport-hint">
          Take up <b>Push</b> or <b>Pull</b>, then hold the pointer against the clay
        </p>
      )}

      {/* How big the lump is, in the corner nearest the piece it describes --
          see `StockPanel`. It was a panel hanging off the top bar, which put
          the number and the shape it changes at opposite ends of the window. */}
      <StockPanel />

      {/* And the way out, in the free corner opposite: the piece, swept into a
          solid and put on the clipboard for the modelling screen to paste. */}
      <CopyPieceButton />

      {/* Two tools, and the island they stand on is the modelling screen's own
          -- see `IslandShell`. It drags to the same corners and remembers the
          one it was left in, because where your hand likes the tools is a fact
          about you rather than about which screen you are on. */}
      <IslandShell>
        <PushTool />
        <PullTool />
      </IslandShell>
    </div>
  )
}
