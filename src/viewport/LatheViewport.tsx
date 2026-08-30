import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { baseName } from '../console/BasePanel'
import { HollowTool } from '../console/HollowTool'
import { PullTool, PushTool, SmoothTool } from '../console/LatheTools'
import { bite, bore, isFresh, widestRadius } from '../geometry/clay'
import { useLathe } from '../store/latheStore'
import { armedLatheTool, useTools } from '../store/toolStore'
import { formatLength } from '../units'
import {
  clayFrame,
  clayY,
  flatsProfile,
  pointerToClay,
  sectionPath,
  stockRect,
  turningRings,
  viewBoxOf,
} from './latheView'
import { CopyPieceButton } from './CopyPieceButton'
import { StockPanel } from './StockPanel'
import { IslandShell } from './ToolIsland'
import { ZoomControl } from './ZoomControl'

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
 * here by not asking it. The frame is a fixed ruled square -- see `clayFrame` --
 * so the piece sits still under the hand for the whole sitting: no zoom, no pan,
 * nothing to put back.
 *
 * WHICH MAKES THE FRAME THE ONLY RULER ON THE SCREEN, and everything below that
 * is not clay is drawn against it rather than against the lump. The faceplate,
 * the rings across the body, the overshoot on the axis: every one of them is
 * some number of `frame.rule`, and none of them is a fraction of `clay.height`.
 * That is not tidiness. A plate measured in the lump's own height is a plate
 * that grows when the lump does, which leaves the lump exactly as big as it ever
 * was against the only thing it could be compared to -- so the piece is drawn
 * bigger and does not LOOK bigger. Measured in rules, the plate stays put and
 * the piece grows past it.
 */

/**
 * How far the wheel has to be turned to halve or double the view.
 *
 * Five hundred pixels of scroll, which is three or four notches of a typical
 * mouse and one unhurried swipe on a trackpad. Slow enough that a flick meant
 * for a scrollbar somewhere else does not throw the view across its range, fast
 * enough that going from a thumbnail to a close-up is a gesture rather than an
 * errand.
 */
const WHEEL_PER_DOUBLING = 500 / Math.LN2

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
/**
 * The id the turning rings are clipped by.
 *
 * A constant rather than a literal written twice, and a plain string rather
 * than `useId`: exactly one lathe viewport is ever mounted -- only the screen
 * on show is -- so a stable name is honest, where a generated one would put a
 * fresh id in the markup on every render for a check to chase.
 */
const BODY_CLIP = 'lathe-body-clip'

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
  const reach = useTools((s) =>
    s.latheTool === 'pull' ? s.pullReach : s.latheTool === 'smooth' ? s.smoothReach : s.pushReach
  )

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

  const zoom = useTools((s) => s.latheZoom)
  // The frame is a function of the ZOOM and of nothing else -- no `clay` in the
  // call and none in the dependencies -- which is what makes resizing the lump
  // unable to move the view. See `clayFrame`.
  const frame = useMemo(() => clayFrame(zoom), [zoom])
  // THE SECTION rather than the silhouette, because a hollow piece has an
  // inside and this screen is a cut through the middle of it. On a solid piece
  // the two are the same string -- see `sectionPath`.
  const wall = useMemo(() => sectionPath(clay, frame), [clay, frame])
  const flats = useMemo(() => flatsProfile(clay, frame), [clay, frame])
  const rings = useMemo(() => turningRings(clay, frame), [clay, frame])
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
        tool: armed.tool,
      })
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [working])

  /**
   * Ctrl+Z, and Ctrl+Shift+Z, on the screen the modelling viewport's key
   * handler does not cover.
   *
   * Its own listener rather than a shared one, because it is the same
   * arrangement the other screen has: `Viewport` owns the modelling keys and is
   * not mounted here -- only the screen on show is -- so the two cannot fight
   * over a press. What they must agree about is the KEY, and they do: the bar's
   * two buttons and these two chords call whichever store the screen in view
   * keeps its history in.
   *
   * `preventDefault` for the same reason the other one does it: the browser's
   * own undo would otherwise walk a text field the user is not in.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      // Not while the caret is in a number field -- the stock panel is a
      // window's width from the clay, and undoing a stroke because somebody
      // corrected a typo would be the surprise that stops it being trusted.
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      const lathe = useLathe.getState()
      if (e.shiftKey) lathe.redo()
      else lathe.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  /**
   * Scroll to zoom, which is what the wheel does on the other screen too.
   *
   * WORTH HAVING EVEN THOUGH THERE ARE BUTTONS, because it is the gesture a hand
   * already reaches for, and because the buttons are eleven presses from one end
   * of the range to the other. It works mid-stroke as well: the loop reads the
   * frame through `held.current`, which `track` rewrites on the next move, so a
   * wheel turned with the tool down changes the view and the stroke carries on.
   *
   * `deltaMode` matters and is usually forgotten. A trackpad reports pixels, a
   * notched wheel on some machines reports LINES, and one line is about sixteen
   * pixels -- read raw, the same flick zooms sixteen times as far on one mouse as
   * on another. Normalising to pixels first is what makes the rate a property of
   * the gesture rather than of the hardware.
   */
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    // Negative delta is a scroll UP, which everywhere in this app and every
    // other means closer.
    useTools.getState().zoomLathe(Math.exp((-e.deltaY * lines) / WHEEL_PER_DOUBLING))
  }

  const widest = widestRadius(clay)
  // Read out to anyone who cannot see the drawing, in the same terms the
  // readout in the corner shows: what is on the lathe, how big it has got, and
  // what it is turned on. Across the CORNERS on a faceted piece, which is what
  // `widest` measures and what the Base panel spells out.
  // A hollow piece says so here and nowhere else in words: the drawing shows a
  // section, which is no use to somebody who cannot see it, and the panel that
  // set it is behind a button that may well be shut.
  const cavity = bore(clay)
  const hollowed =
    cavity === null
      ? ''
      : cavity.openTop && cavity.openBottom
        ? ', hollow and open at both ends'
        : cavity.openTop
          ? ', hollow and open at the top'
          : cavity.openBottom
            ? ', hollow and open underneath'
            : ', hollow and sealed'
  const label =
    `Clay on the lathe, ${baseName(clay.sides).toLowerCase()} based,` +
    ` ${formatLength(clay.height, displayUnit)} tall` +
    ` and ${formatLength(widest * 2, displayUnit)} across${hollowed}`

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
        onWheel={onWheel}
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
        <path
          className="lathe-clay"
          d={wall}
          // A sealed cavity is a second loop INSIDE the first, and only this
          // rule reads that as a hole rather than as a solid drawn over a
          // solid. It costs the other cases nothing -- none of them nest -- so
          // one rule serves every shape the section can take. See
          // `sectionPath`.
          fillRule="evenodd"
          vectorEffect="non-scaling-stroke"
        />

        {/* WHERE THE FLATS RUN, on a piece that has any: the same profile drawn
            at the apothem, so the corners the tools work and the flats between
            them are both on screen. It is the whole of what the Base panel
            changes about this drawing, and it has to change something -- a
            selector whose effect only shows up after the piece has been copied
            is a selector nobody can aim.

            Over the clay, like the axis, and for the same reason: it is a mark
            ON the piece, and under the fill it would be invisible. Withheld
            entirely on a round piece, where it would lie exactly along the
            silhouette -- see `flatsProfile`, and `isFresh` for the same rule
            about the stock ghost. */}
        {flats && (
          <path className="lathe-flats" d={flats} vectorEffect="non-scaling-stroke" />
        )}

        {/* The axis the piece is turned about, drawn OVER the clay and running a
            little past both ends of it.

            A centre line, in the sense a sectioned drawing means: this whole
            screen is a section through something round, and the line down the
            middle is what says so. It was under the clay to begin with, which
            hid all of it but a stub above the rim -- a dashed inch of nothing
            floating over the piece, which reads as an artefact rather than as
            an axis. Over the clay and faint, it reads as the thing the piece
            turns about, and it marks the limit a push works toward.

            The overshoot at each end is a fraction of a RULE rather than of the
            lump, so a short piece gets the same stub of axis over its rim as a
            tall one -- which is what a stub is for. Measured in the lump it
            would be a long line on a tall piece and none to speak of on a small
            one, which is exactly the size at which a piece most needs something
            saying which way is up. */}
        <line
          className="lathe-axis"
          x1={0}
          y1={clayY(frame, clay.height) - frame.rule * 0.5}
          x2={0}
          y2={frame.base + frame.rule * 0.2}
          vectorEffect="non-scaling-stroke"
        />

        {/* The rings a hand leaves in a turning piece -- see `turningRings`.

            CLIPPED TO THE CLAY, which matters the moment a piece is hollow: a
            ring is a mark on a SURFACE, and one drawn straight across the mouth
            of a cup is a mark on nothing. Each is one line from wall to wall,
            so on a bored piece the middle of it has to go -- and the shape it
            has to go by is the section itself, which the clip already holds
            exactly. Two segments computed per ring per frame would be the same
            answer worked out a second time, in a second place, from numbers
            that could disagree.

            `evenodd` on the clip for the reason the fill uses it: a sealed
            cavity is a loop inside a loop, and the void is not clay. */}
        <clipPath id={BODY_CLIP}>
          <path d={wall} clipRule="evenodd" />
        </clipPath>
        <g className="lathe-rings" clipPath={`url(#${BODY_CLIP})`} aria-hidden>
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
            can never overhang the thing it is standing on.

            EVERY NUMBER HERE IS THE FRAME'S, AND NONE OF THEM IS THE CLAY'S.
            It is the fixed thing on this screen -- the bench the piece stands on
            -- so it is drawn at the same place, the same width and the same
            thickness whatever is on it, and it is the mark against which the
            lump is seen to grow. Its thickness used to be a fraction of the
            lump's height, which meant the plate swelled and shrank with the very
            number it was there to be a reference for: a taller lump got a
            thicker plate under it and, with the frame stretching to match, the
            two changes cancelled and nothing on screen moved at all. */}
        <rect
          className="lathe-plate"
          x={frame.x + frame.width * 0.06}
          y={frame.base}
          width={frame.width * 0.88}
          height={frame.rule * 0.42}
          rx={frame.rule * 0.14}
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

      {/* How far the view is zoomed, and the way back to a piece that has run
          off the edge of it -- see `ZoomControl`. Directly over the readout,
          because the two are the same kind of thing in the same corner: one
          says how big the piece is, the other how big it is being drawn. */}
      <ZoomControl />

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
        {/* And what it is turned on, which the two numbers cannot say: every
            base has this same profile. Last, because it is the one thing here
            that is CHOSEN rather than measured -- and here at all so the
            console's selector has an answer in the corner the piece is already
            read in. */}
        <span className="lathe-readout-sep" aria-hidden>
          ·
        </span>
        <span className="lathe-readout-base">{baseName(clay.sides).toLowerCase()}</span>
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

      {/* The island the modelling screen uses -- see `IslandShell`. It drags to
          the same corners and remembers the one it was left in, because where
          your hand likes the tools is a fact about you rather than about which
          screen you are on.

          THE RULE IS THE ISLAND'S OWN IDIOM, the one the modelling screen draws
          between what acts on a selected object and what puts something new in
          the scene. Here it separates the two tools that MOVE MATERIAL from
          everything else: Push and Pull are one behaviour with a sign in front
          of it, and a column of four switches at one gap reads as a list of
          unrelated things rather than as a pair and its company. Inert and
          hidden from the reader -- it separates nothing that is not already two
          groups in the markup. */}
      <IslandShell>
        <PushTool />
        <PullTool />
        <div className="island-rule" aria-hidden />
        <SmoothTool />
        <HollowTool />
      </IslandShell>
    </div>
  )
}
