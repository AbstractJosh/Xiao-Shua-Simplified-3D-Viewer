import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { curveHandles } from '../geometry/curve'
import type { Pt } from '../geometry/curve'
import { useTools } from '../store/toolStore'
import { clayY, pointerToClay } from './latheView'
import type { ClayFrame } from './latheView'
import { sculptLine, useSculptDraft } from './sculptDraft'

/**
 * THE PROFILE ON THE LATHE: the points you have placed, the line through them,
 * and the pointer work that puts them there.
 *
 * The Lathe screen's answer to `CutLayer`, and the same tool seen through a
 * different window. What is placed, how the finer target wins, what a drag of a
 * handle means, why the press must stop here -- every one of those is settled
 * next door and repeated rather than re-argued. What is genuinely different is
 * that this screen is an `<svg>` in scene units rather than a WebGL canvas, so
 * there is no ray to cast and no plane to cast it at: `pointerToClay` inverts
 * the viewBox and the answer is the pointer's place on the piece. See
 * `LatheViewport` for why the screen is drawn that way at all.
 *
 * EVERYTHING HERE IS IN THE CLAY'S OWN TERMS -- `[height, radius]`, in scene
 * units off the faceplate -- and turned into the drawing's coordinates only at
 * the moment of drawing. That is what lets a point survive a turn of the wheel,
 * a re-cut stock and a change of base: a mark kept in the SVG's numbers would
 * slide off the piece the first time the view moved under it.
 */

/**
 * How big a knot is drawn, as a share of the FRAME rather than of the piece.
 *
 * Which makes it a screen size. The frame is fitted to the window and shrinks
 * as the view zooms in, so a fraction of it is the same number of pixels at
 * every zoom -- exactly the trick the tool ghost already uses, and for the same
 * reason: a knot is a thing you take hold of with a pointer, so it is sized in
 * what the pointer is measured in. A knot sized in scene units would be a
 * grabbable dot at one zoom and a saucer over the whole piece at another.
 *
 * The frame is square and the drawing is fitted to whichever side of the window
 * is shorter, so a mark of `frame.width * K` comes out at `shorter * K` pixels
 * whatever the zoom -- about four across for the number below on an ordinary
 * window. SMALL ON PURPOSE: these are what you aim a profile WITH rather than
 * the profile itself, and a knot big enough to see from across the room is a
 * knot standing on top of the very curve it is bending. The first of these was
 * more than twice this and covered the line between its own points.
 */
const KNOT_OF_FRAME = 0.005
/** The grips that aim a tangent, drawn smaller again than the knots they belong
 *  to so a point still reads as the thing the curve passes through. */
const GRIP_OF_FRAME = 0.0035
/**
 * How near the pointer has to be to take hold of something, in the same
 * currency.
 *
 * MUCH wider than either mark, and the gap is the point: the marks are sized to
 * be read and this is sized to be hit. A gesture that demanded the exact centre
 * of a four-pixel dot would be a gesture that misses, so the target is a good
 * two knots across while the knot itself stays out of the way of the line.
 */
const GRAB_OF_FRAME = 0.012

/** Where the two ends of a point's mirrored handle sit. Out along the tangent
 *  and back against it, which is the whole of what "mirrored" means. */
function handleEnds(point: Pt, handle: Pt): { out: Pt; back: Pt } {
  return {
    out: [point[0] + handle[0], point[1] + handle[1]],
    back: [point[0] - handle[0], point[1] - handle[1]],
  }
}

const between = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** What the tool has hold of between a press and its release. */
type Grab = { kind: 'point'; index: number } | { kind: 'handle'; index: number; side: 1 | -1 }

/**
 * The press, the drag and the release, hung off the drawing itself.
 *
 * A hook rather than markup because it is not a thing on screen: it is the
 * gesture, and the marks it moves are drawn by `SculptLayer` below from the
 * store it writes to.
 *
 * THE MOVE AND THE RELEASE ARE ON THE WINDOW, not on the element. A point
 * dragged off the edge of the drawing has to keep following the pointer -- a
 * profile is often aimed past the piece, since the wall may be pulled wider
 * than the stock -- and, more to the point, the release has to be heard
 * wherever it happens. A drag that ended outside the svg with the listener on
 * the svg would leave the point stuck to the pointer.
 */
export function useSculptGesture(svgRef: RefObject<SVGSVGElement | null>, frame: ClayFrame) {
  const tool = useTools((s) => s.latheTool)
  const grab = useRef<Grab | null>(null)

  useEffect(() => {
    const el = svgRef.current
    if (!el || tool !== 'points') return

    /**
     * The pointer, in the clay's own terms -- and the radius SIGNED, which is
     * the difference between a knot that lands under the pointer and one that
     * jumps across the piece.
     *
     * `pointerToClay` hands back both: `radius` is the distance from the axis,
     * which is what the WALL is made of, and `x` is which side of the axis that
     * distance was measured on. A draft kept in the first is a draft that draws
     * every knot on the right whatever wall you clicked, because the screen is a
     * section and both walls are the same row of radii mirrored -- so half the
     * time the mark you just placed appears on the other side of the piece from
     * your pointer.
     *
     * So the DRAFT keeps the side and the WALL does not. Which wall a profile
     * was drawn on is a fact about the drawing; a turned piece is the same all
     * the way round, so it cannot be a fact about the piece. `sculpt` takes the
     * distance and ignores the sign -- see it for what a line drawn ACROSS the
     * axis means.
     */
    const toClay = (e: PointerEvent): Pt => {
      const rect = el.getBoundingClientRect()
      const spot = pointerToClay(frame, rect, e.clientX, e.clientY)
      return [spot.y, spot.x]
    }

    const onMove = (e: PointerEvent) => {
      const held = grab.current
      if (!held) return
      const at = toClay(e)
      const draft = useSculptDraft.getState()
      if (held.kind === 'point') draft.movePoint(held.index, at)
      else draft.moveHandle(held.index, at, held.side)
    }

    const onUp = () => {
      grab.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    const onDown = (e: PointerEvent) => {
      // Left button only. The wheel zooms and the right button is left alone,
      // the way they are everywhere else over a viewport.
      if (e.button !== 0) return
      const at = toClay(e)
      const draft = useSculptDraft.getState()
      const reach = frame.width * GRAB_OF_FRAME

      // THE FINER TARGET WINS, and handles are finer than knots: they are
      // smaller, they are drawn over the points, and a press that landed on a
      // handle but moved the point under it would be the one gesture in this
      // tool that could not be undone by eye. Handles exist only while the
      // curve does, and are read through `curveHandles`, so a grip is grabbed
      // exactly where it is drawn whether the tangent is the user's or the
      // fit's.
      //
      // AND ONLY THE LIVE POINT HAS ANY. What is drawn is what can be grabbed
      // -- see `selected` in `sculptDraft` for why one tangent is on screen at
      // a time -- and a grip hit-tested where nothing is drawn is a control
      // that bends the curve from a bare patch of scene.
      const live = draft.selected
      if (useTools.getState().sculptFit && live !== null && draft.points[live]) {
        const aim = curveHandles(draft.points, draft.handles)
        const ends = handleEnds(draft.points[live], aim[live])
        if (between(ends.out, at) <= reach) {
          grab.current = { kind: 'handle', index: live, side: 1 }
        } else if (between(ends.back, at) <= reach) {
          grab.current = { kind: 'handle', index: live, side: -1 }
        }
      }
      // A PRESS ON A KNOT TAKES HOLD OF IT AND MAKES IT LIVE, which is the whole
      // of how a tangent you have moved on from is got back: the earlier points
      // are all still there and still draggable, and pressing one puts its grips
      // back on screen where they were left. Selecting costs no gesture of its
      // own -- the press that was already the start of a drag is the press that
      // selects -- so a hand that only ever moves knots never learns it is doing
      // two things.
      if (!grab.current) {
        for (let i = 0; i < draft.points.length; i += 1) {
          if (between(draft.points[i], at) <= reach) {
            grab.current = { kind: 'point', index: i }
            draft.selectPoint(i)
            break
          }
        }
      }
      // Nothing under the pointer, so this is a new point at the end of the
      // line -- which is what a press on bare scene means for this tool. It is
      // taken hold of as it lands, so placing and then adjusting is one gesture
      // rather than a click and then a drag, and `addPoint` makes it the live
      // one: the tangent on screen is always the one you are drawing with.
      if (!grab.current) {
        draft.addPoint(at)
        grab.current = { kind: 'point', index: draft.points.length }
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      e.preventDefault()
      // AND THE PRESS STOPS HERE, which is the one thing this listener has to
      // do besides start a point.
      //
      // The bar closes whichever tool panel is open on any press that lands
      // outside the bar and the island -- see `NavBar` -- which is the right
      // rule for every panel it was written for, all of them aimed with the
      // controls inside them. This tool is aimed by drawing on the scene. The
      // Apply is standing chrome rather than a flyout for exactly that reason
      // (see `SculptPanel`), but the tool's own caret holds the curve switch,
      // and without this the first point of every profile would shut it.
      e.stopPropagation()
    }

    el.addEventListener('pointerdown', onDown)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      onUp()
    }
  }, [svgRef, tool, frame])
}

/**
 * The marks themselves: the line, the knots on it, and the grips that aim it.
 *
 * Drawn INSIDE the lathe's own svg, in the same viewBox as the clay, so the
 * profile and the piece it will become are placed by one rule rather than by
 * two that could disagree.
 *
 * MIRRORED LIKE THE WALL IT WILL BECOME. The screen draws one row of radii on
 * both sides of the axis -- that is what makes it a section -- so a profile
 * shown on one side only would be a promise about half the piece. The KNOTS are
 * on the right alone all the same: they are things to take hold of, and two
 * grabbable copies of one point is an interface where half your presses move a
 * point you were not looking at.
 *
 * AND ONE TANGENT AT A TIME. Every knot is drawn -- they are the drawing -- but
 * the bar and grips belong to the live point alone, which is the one just
 * placed or the one last pressed. See `selected` in `sculptDraft` for why the
 * handles come out singly rather than all at once.
 */
export function SculptLayer({ frame }: { frame: ClayFrame }) {
  const tool = useTools((s) => s.latheTool)
  const fit = useTools((s) => s.sculptFit)
  const points = useSculptDraft((s) => s.points)
  const handles = useSculptDraft((s) => s.handles)
  const selected = useSculptDraft((s) => s.selected)

  if (tool !== 'points') return null

  const knot = frame.width * KNOT_OF_FRAME
  const grip = frame.width * GRIP_OF_FRAME
  /** A clay point in the drawing's coordinates: radius across, height up. */
  const px = (p: Pt) => p[1]
  const py = (p: Pt) => clayY(frame, p[0])
  const path = (line: Pt[], side: 1 | -1) =>
    line.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p) * side} ${py(p)}`).join(' ')

  const line = sculptLine({ points, handles }, fit)
  // The tangents, while the curve is on and not at all while it is off: a
  // straight segment has none to aim. Resolved for the whole run even though
  // one of them is drawn, because the fit is a function of every point -- so
  // asking for one costs exactly what asking for all of them costs.
  const aim = fit ? curveHandles(points, handles) : []

  /**
   * THE LIVE POINT: the only one wearing its handles, and the only one whose
   * grips answer a press. See `selected` in `sculptDraft` for why the tangents
   * come out one at a time.
   *
   * Guarded against an index naming no point -- `selectPoint` will not store
   * one, but a `clear` between the store read and this render would leave one.
   */
  const live = selected !== null && selected < points.length ? selected : null
  const aimed = live !== null && handles[live] != null
  const ends = live !== null && fit ? handleEnds(points[live], aim[live] ?? [0, 0]) : null
  // A tangent of nothing would stack both grips inside the knot, where they are
  // a control nobody can find. It happens on a run of one and on two points at
  // the same height, which is exactly when somebody is most likely to be
  // reaching for one.
  const tangent = ends && between(ends.out, ends.back) >= knot ? ends : null

  return (
    <g className="lathe-sculpt" aria-hidden>
      {line.length >= 2 && (
        <>
          <path className="lathe-sculpt-line" d={path(line, 1)} vectorEffect="non-scaling-stroke" />
          {/* The far wall, which is the same line: a section cannot show one
              side of a turned piece bending and the other staying put. */}
          <path
            className="lathe-sculpt-line lathe-sculpt-ghost"
            d={path(line, -1)}
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}

      {tangent && (
        <g className={aimed ? 'aimed' : undefined}>
          <line
            className="lathe-sculpt-bar"
            x1={px(tangent.back)}
            y1={py(tangent.back)}
            x2={px(tangent.out)}
            y2={py(tangent.out)}
            vectorEffect="non-scaling-stroke"
          />
          {/* `non-scaling-stroke` on every stroked mark in here, and it is not
              decoration: this svg's viewBox is measured in SCENE UNITS, so a
              width in the stylesheet is read as that many units -- about 340
              pixels at the opening zoom. Without it a grip is a ring the size
              of the window with the piece somewhere inside it. */}
          <circle
            className="lathe-sculpt-grip"
            cx={px(tangent.back)}
            cy={py(tangent.back)}
            r={grip}
            vectorEffect="non-scaling-stroke"
          />
          <circle
            className="lathe-sculpt-grip"
            cx={px(tangent.out)}
            cy={py(tangent.out)}
            r={grip}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}

      {/* EVERY KNOT, live or not: they are the drawing, and a point that were
          not drawn would be a point that cannot be pressed -- which is the one
          way back to its tangent. The live one is MARKED instead. The class
          goes on a wrapper rather than on the circle so the mark itself keeps a
          plain literal class, which is what lets the stroke check in `ui-check`
          find it. */}
      {points.map((p, i) => (
        <g key={`p${i}`} className={i === live ? 'live' : undefined}>
          <circle
            className="lathe-sculpt-knot"
            cx={px(p)}
            cy={py(p)}
            r={knot}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </g>
  )
}
