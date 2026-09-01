import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { baseName } from '../console/BasePanel'
import { HollowTool } from '../console/HollowTool'
import { LatheRulerTool } from '../console/LatheRulerTool'
import { PointSculptTool, PullTool, PushTool, SmoothTool } from '../console/LatheTools'
import { bite, bore, isFresh, pieceHeight, widestRadius } from '../geometry/clay'
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
import { LatheRulers } from './LatheRulers'
import { SculptLayer, useSculptGesture } from './SculptLayer'
import { SculptPanel } from './SculptPanel'
import { useSculptDraft } from './sculptDraft'
import { StockPanel } from './StockPanel'
import { ViewResetButton } from './ViewResetButton'
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

/**
 * How big the tool's ghost is drawn, and the band it may never leave.
 *
 * A SIXTH OF THE REACH, not the reach itself. The ghost used to be the tool's
 * true footprint -- a circle of r = reach, which at the default is a fifth of
 * the frame across -- and a mark that size is not a cursor, it is a shape
 * standing between the hand and the thing it is aimed at. It is also unread at
 * the one moment it was sized for: the instant the tool goes down, the wall
 * itself starts moving, and what the eye follows from then on is the wall.
 *
 * Scaled by the reach rather than fixed, because the Size dial has to show
 * SOMETHING on this screen -- a dial whose only effect arrives on the next
 * stroke is a dial nobody can aim -- and clamped at both ends, because a reach
 * runs from a millimetre to twelve metres and a cursor may be neither invisible
 * nor a screenful.
 *
 * The clamps are fractions of the FRAME, which is what makes them screen sizes:
 * the frame is a fixed square fitted to the window, so a ghost held at either
 * clamp is the same size on glass at every zoom, while one inside the band
 * zooms with the clay it is measured against.
 */
const GHOST_OF_REACH = 1 / 6
const GHOST_MIN_OF_FRAME = 0.007
const GHOST_MAX_OF_FRAME = 0.029

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
  // Read for one reason only: empty hands mean something different while the
  // Ruler is up. See the hint at the bottom of this component.
  const measuring = useTools((s) => s.latheRulerActive)
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
  /** The drawing itself, for the Point Sculpt gesture to hang its press on --
   *  see `useSculptGesture`, which needs the element to read the pointer back
   *  into the clay's own terms. */
  const svgRef = useRef<SVGSVGElement | null>(null)
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

  /**
   * The right-drag that slides the view, or null when nothing is being dragged.
   *
   * A ref rather than state, because nothing about it is DRAWN: what the drag
   * produces is a new pan in the store, and the store is what re-renders. Only
   * the previous pointer position is kept -- each move is worth its own delta,
   * so the gesture needs no memory of where it started.
   */
  const sliding = useRef<{ id: number; x: number; y: number } | null>(null)

  const zoom = useTools((s) => s.latheZoom)
  const pan = useTools((s) => s.lathePan)
  // The frame is a function of the ZOOM AND THE PAN and of nothing else -- no
  // `clay` in the call and none in the dependencies -- which is what makes
  // resizing the lump unable to move the view. See `clayFrame`.
  const frame = useMemo(() => clayFrame(zoom, pan), [zoom, pan])
  // Point Sculpt listens on the drawing itself rather than through the handlers
  // below, because what its press means is not what theirs means: it takes hold
  // of a knot, or puts a new one down, and never starts a stroke. See
  // `useSculptGesture`.
  useSculptGesture(svgRef, frame)
  // THE SECTION rather than the silhouette, because a hollow piece has an
  // inside and this screen is a cut through the middle of it. On a solid piece
  // the two are the same string -- see `sectionPath`.
  const wall = useMemo(() => sectionPath(clay, frame), [clay, frame])
  const flats = useMemo(() => flatsProfile(clay, frame), [clay, frame])
  const rings = useMemo(() => turningRings(clay, frame), [clay, frame])
  const stock = stockRect(clay, frame)
  // See `GHOST_OF_REACH`: cursor-sized, and only loosely the tool's own size.
  const ghost = Math.min(
    Math.max(reach * GHOST_OF_REACH, frame.width * GHOST_MIN_OF_FRAME),
    frame.width * GHOST_MAX_OF_FRAME
  )

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
      // Not while the caret is in a number field -- the stock panel is a
      // window's width from the clay, and undoing a stroke because somebody
      // corrected a typo would be the surprise that stops it being trusted.
      // Backspace makes this load-bearing rather than merely polite: in a text
      // field it is how you delete a character.
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, [contenteditable="true"]')) return

      // ESCAPE AND DELETE, which this screen used to answer to neither of --
      // "there is nothing to select and nothing to delete" was true right up
      // until something on it could be selected. A ruler was the first such
      // thing and a sculpt knot is the second, and the two keys mean here
      // exactly what they mean on the bench: put the handles down, and take
      // that away.
      if (e.key === 'Escape') {
        useTools.getState().selectLatheRuler(null)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // THE KNOT IN HAND FIRST, and only while Point Sculpt is the tool
        // held. A press on a knot already makes it the live one -- that is how
        // its handles come out -- so "click a point, press Delete" needs no
        // gesture of its own: the selection the tool already keeps is the
        // thing the key acts on. The filled knot says which. See `removePoint`
        // in `sculptDraft` for what taking one off does to the line: an end
        // point backtracks it, a middle one is bridged by its neighbours.
        const tools = useTools.getState()
        if (tools.latheTool === 'points') {
          const drawn = useSculptDraft.getState()
          if (drawn.selected !== null) {
            e.preventDefault()
            drawn.removePoint(drawn.selected)
            return
          }
        }
        // THEN a selected RULER, and the order matters rather than merely
        // being one: putting a tool in hand does not put a lit ruler out, so
        // both can be true at once, and a key that took the ruler off the
        // piece while the user was plainly editing a profile would delete the
        // thing they were not looking at.
        //
        // The piece itself is not deletable either way and must not become so
        // by a key held down over the wrong window: the way out of a lump gone
        // wrong is Reset, which says what it will do.
        const chosen = tools.selectedLatheRuler
        if (chosen === null) return
        e.preventDefault()
        tools.removeLatheRuler(chosen)
        return
      }

      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      const lathe = useLathe.getState()
      if (e.shiftKey) lathe.redo()
      else lathe.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * How many scene units a pixel of this element is currently worth.
   *
   * The `meet` fit, read for its SCALE rather than for its offsets --
   * `pointerToClay` inverts the same thing for its position. A drag has to be
   * measured this way rather than by asking where the pointer now is in the
   * clay: the pan is what moves the frame, so a delta taken between two
   * readings of a moving frame would be a delta fed back into itself, and the
   * view would run away under the hand.
   */
  const unitsPerPixel = (rect: DOMRect) => {
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
    return Number.isFinite(scale) && scale > 0 ? 1 / scale : 0
  }

  const track = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()

    // THE VIEW FIRST, and it returns: with the right button down the pointer is
    // moving the window rather than aiming anything, so the ghost has nothing
    // to follow and `held` must not be rewritten from a frame that is sliding.
    const slide = sliding.current
    if (slide && slide.id === e.pointerId) {
      const per = unitsPerPixel(rect)
      // NEGATED, which is what makes it feel like dragging the drawing rather
      // than the window: the hand goes right, so the window goes left and the
      // piece comes right with the hand. Both axes read the same way, and the
      // y needs no flip -- screen y and the frame's y both run downward.
      useTools.getState().panLathe(-(e.clientX - slide.x) * per, -(e.clientY - slide.y) * per)
      slide.x = e.clientX
      slide.y = e.clientY
      return
    }

    const spot = pointerToClay(frame, rect, e.clientX, e.clientY)
    held.current = spot
    setAt(spot)
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    // THE RIGHT BUTTON SLIDES THE VIEW, which is what it does on the modelling
    // screen and what it has done in every drawing program the user has met.
    // It matters more here than there: this frame does not fit itself to the
    // piece any more -- see `clayFrame` -- so at any zoom past the one that
    // shows the whole lump, the rim is somewhere off the top of the window and
    // the wheel alone cannot reach it.
    //
    // It is the only gesture on this screen that works with EMPTY HANDS as
    // readily as with a tool, because it is not aimed at the clay at all.
    if (e.button === 2) {
      capture(e, true)
      sliding.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
      return
    }

    // Left button only, and only with a tool in hand.
    const held = useTools.getState().latheTool
    if (e.button !== 0 || held === null) return
    // POINT SCULPT IS NOT HELD AGAINST ANYTHING, so it takes none of what
    // follows: no capture, no stroke, no frame loop. Its press is handled by
    // `useSculptGesture`, which is listening on this same element and has
    // already stopped the event by the time this would run -- this guard is
    // what makes that belt-and-braces rather than load-bearing. Without it a
    // press would push an undo entry (see `beginStroke`) for a stroke that can
    // never work anything, since `armedLatheTool` answers null for this tool.
    if (held === 'points') return
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
    // The slide ends on ANY release, whichever button reports it. A right-drag
    // that ended while the left button happened to be down would otherwise
    // leave the view stuck to the pointer with nothing holding it.
    sliding.current = null
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
  // THE PIECE'S HEIGHT, NOT THE STOCK'S -- see `pieceHeight`. Round the top off
  // and the piece really is shorter than the lump it came out of, and the two
  // numbers beside each other in the corner are both what the clay has BECOME.
  // The Stock panel goes on showing what it was cut from, which is the same
  // division this readout already makes about the width.
  const tall = pieceHeight(clay)
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
    ` ${formatLength(tall, displayUnit)} tall` +
    ` and ${formatLength(widest * 2, displayUnit)} across${hollowed}`

  return (
    <div className={`viewport lathe${tool ? ' lathe-armed' : ''}`}>
      <svg
        ref={svgRef}
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
        // The right button slides the view here, so it must not also summon the
        // browser's menu over the drawing being slid. The modelling viewport
        // does exactly this, for exactly this reason.
        onContextMenu={(e) => e.preventDefault()}
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
          // CENTRED ON THE AXIS rather than measured in from the frame's own
          // left edge, which is the same number at rest and a different thing
          // entirely once the view can slide: `frame.x` is where the WINDOW
          // starts, so a plate measured from it was glued to the screen and
          // would have travelled with a pan -- a bench that followed the eye
          // instead of standing still under the piece. Half of 0.88 either side
          // of x = 0 is exactly where it always was.
          x={-frame.width * 0.44}
          y={frame.base}
          width={frame.width * 0.88}
          height={frame.rule * 0.42}
          rx={frame.rule * 0.14}
          vectorEffect="non-scaling-stroke"
        />

        {/* The rulers, over the clay and under the two things that are AIMED.
            A measurement drawn behind the piece it measures is a measurement
            you have to move the piece to read; a measurement drawn over the
            cursor is a cursor you cannot see. Between the two is the whole of
            where an annotation belongs. See `LatheRulers`. */}
        <LatheRulers frame={frame} clay={clay} svg={svgRef} />

        {/* The tool, where the pointer is: WHICH WAY IT WORKS, said in colour,
            and only loosely how wide it is -- see `GHOST_OF_REACH`. A small
            filled ghost rather than an outline of the tool's footprint, and one
            mark rather than two: at this size the disc is both the aim point
            and the tool, and the tick that used to say where the pointer was
            has nothing left to add. Drawn only while a tool is in hand -- with
            empty hands the pointer is just a pointer. */}
        {tool && tool !== 'points' && at && (
          <circle
            className={`lathe-tool lathe-tool-${tool}`}
            cx={at.x}
            cy={clayY(frame, at.y)}
            r={ghost}
            vectorEffect="non-scaling-stroke"
            aria-hidden
          />
        )}

        {/* The profile being drawn, over everything: it is what you are aiming,
            and a line under the clay would be invisible exactly where the piece
            is widest. Point Sculpt wears no tool ghost -- the knots ARE the
            tool, and a disc following the pointer over them would be a second
            mark for the same hand. See `SculptLayer`. */}
        <SculptLayer frame={frame} />
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
        <span>{formatLength(tall, displayUnit)} tall</span>
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
          tool is taken up, and never comes back while one is in hand.

          AND NOT WHILE THE RULER IS UP, which is the other way a hand ends up
          empty and the reason this is two conditions rather than one. Taking up
          the Ruler puts the tool down -- see `setLatheRulerActive` -- so without
          this, arming it would summon a line telling you to take up Push, over
          a screen where you have just said you want to measure. An idle hand
          and a hand doing something else are not the same state. */}
      {!tool && !measuring && (
        <p className="viewport-hint">
          Take up <b>Push</b> or <b>Pull</b>, then hold the pointer against the clay
        </p>
      )}

      {/* How big the lump is, in the corner nearest the piece it describes --
          see `StockPanel`. It was a panel hanging off the top bar, which put
          the number and the shape it changes at opposite ends of the window. */}
      {/* A COLUMN NOW, the one the cutting bench already uses, because a second
          panel wants that corner whenever Point Sculpt is in hand: the lump,
          and the profile you are cutting into it, stacked in the order they are
          used. With any other tool it is the stock panel alone, exactly where it
          has always been -- see `.lathe-corner`. */}
      {/* THREE THINGS NOW, AND THE ORDER IS WHAT THEY COST. The view reset is
          first because it throws nothing away -- a view is not a piece -- then
          the line you have drawn, then the shaping itself, which on a screen
          with no undo is the most expensive press in the app. A hand reaching
          for "put it back" meets the harmless one first. */}
      <div className="lathe-corner">
        <ViewResetButton />
        <SculptPanel />
        <StockPanel />
      </div>

      {/* And the way out, in the free corner opposite: the piece, swept into a
          solid and put on the clipboard for the modelling screen to paste. */}
      <CopyPieceButton />

      {/* The island the modelling screen uses -- see `IslandShell`. It drags to
          the same corners and remembers the one it was left in, because where
          your hand likes the tools is a fact about you rather than about which
          screen you are on.

          THE RULE IS THE ISLAND'S OWN IDIOM, the one the modelling screen draws
          between what acts on a selected object and what puts something new in
          the scene. Here it separates the tools that MOVE MATERIAL from
          everything else. Push and Pull are one behaviour with a sign in front
          of it; Point Sculpt is that same act asked for a different way -- you
          draw the wall you want instead of holding a tool against the one you
          have -- so it stands with them rather than after them. What is below
          the rule is everything that shapes nothing: Smooth fairs what the
          three left, Hollow is a setting, and the Ruler only measures. Inert
          and hidden from the reader -- it separates nothing that is not already
          two groups in the markup. */}
      <IslandShell>
        <PushTool />
        <PullTool />
        <PointSculptTool />
        <div className="island-rule" aria-hidden />
        <SmoothTool />
        <HollowTool />
        {/* Last, because it is the only thing on this island that changes
            nothing about the piece. See `LatheRulerTool`. */}
        <LatheRulerTool />
      </IslandShell>
    </div>
  )
}
