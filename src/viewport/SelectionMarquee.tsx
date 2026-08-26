import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { useDoc } from '../store/docStore'
import {
  MARQUEE_SLOP,
  boxSpan,
  claimsPress,
  normaliseBox,
  objectsInBox,
  selectionFor,
  useMarquee,
} from './marquee'
import type { MarqueeBox } from './marquee'

/**
 * The rubber-band selection, in two halves: the listener that drives it, which
 * has to be inside the canvas because it needs the camera, and the rectangle,
 * which is a DOM overlay outside it.
 *
 * The selection is applied LIVE, on every move, rather than being held back
 * until the button comes up. That is what makes the objects inside the box
 * light up as it is drawn -- they light up because they really are selected,
 * through the same material the rest of the app selects things with, so there
 * is no second highlight to keep in step with the first.
 */

export function MarqueeControl() {
  const { camera, gl } = useThree()
  // The mutable bag R3F keeps its event bookkeeping in. Its identity is fixed
  // for the life of the canvas -- only its fields change -- so subscribing to it
  // reads the live value without re-rendering anything.
  const internal = useThree((s) => s.internal)

  useEffect(() => {
    const canvas = gl.domElement

    /** Push the box's catch into the document selection. */
    const apply = (box: MarqueeBox, additive: boolean) => {
      const s = useDoc.getState()
      const inside = objectsInBox(
        s.doc.objects,
        normaliseBox(box),
        camera,
        canvas.getBoundingClientRect()
      )
      s.selectObjects(selectionFor(useMarquee.getState().base, inside, additive))
    }

    const down = (e: PointerEvent) => {
      // R3F records what a pointer-down hit BEFORE it dispatches to any of the
      // scene's own press handlers, and this listener is on the window -- the
      // last thing an event reaches -- so by now the answer is already sitting
      // there. Reading it is what keeps the marquee out of all six of those
      // handlers: were it announced by each instead, the one handler somebody
      // forgets to tell would start a box in the middle of a gizmo drag.
      const press = {
        button: e.button,
        pointerType: e.pointerType,
        altKey: e.altKey,
        onCanvas: e.target === canvas,
        hits: internal.initialHits.length,
        dragging: useDoc.getState().drag.kind !== 'idle',
      }
      if (!claimsPress(press)) return
      useMarquee.getState().begin(e.clientX, e.clientY, useDoc.getState().selectedObjectIds)
    }

    const move = (e: PointerEvent) => {
      const { box, to } = useMarquee.getState()
      if (!box) return
      const next: MarqueeBox = { ...box, x1: e.clientX, y1: e.clientY }
      to(e.clientX, e.clientY)
      // Below the slop the gesture is still a click, and a click on empty space
      // clears the selection -- so nothing is applied until it is a box.
      if (boxSpan(next) >= MARQUEE_SLOP) apply(next, e.shiftKey)
    }

    const up = (e: PointerEvent) => {
      const { box, clear } = useMarquee.getState()
      if (!box) return
      clear()
      // A press that drew no box is the click that empties the selection. It is
      // handled HERE rather than by the canvas's own pointer-miss so that there
      // is one owner and no gap: the miss only fires within two pixels of the
      // press, which would leave a hairline band where a gesture was neither a
      // click nor a box and nothing at all happened.
      if (boxSpan(box) >= MARQUEE_SLOP) return
      // Shift is additive, and adding nothing to a selection leaves it alone.
      // Without this, shift-clicking past the edge of a solid would throw away
      // the gathering it was in the middle of.
      if (!e.shiftKey) useDoc.getState().selectObjects([])
    }

    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [camera, gl, internal])

  return null
}

/**
 * The box itself: a plain DOM rectangle, drawn over the canvas rather than in
 * the scene.
 *
 * A 2D box IS the gesture -- it catches what the user can see inside it, at the
 * angle they are seeing it from -- so it belongs in the flat space the pointer
 * speaks, where it cannot turn with the camera or be hidden behind a solid.
 */
export function MarqueeRect() {
  const box = useMarquee((s) => s.box)
  if (!box || boxSpan(box) < MARQUEE_SLOP) return null

  const { left, top, right, bottom } = normaliseBox(box)
  return (
    <div
      className="marquee"
      style={{ left, top, width: right - left, height: bottom - top }}
    />
  )
}
