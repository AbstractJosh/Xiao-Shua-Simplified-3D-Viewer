import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { RefObject } from 'react'
import { assemblyAnchor } from '../geometry/assembly'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'
import {
  clearMoves,
  flightStep,
  lookTarget,
  movesHeld,
  moving,
  pressMove,
  releaseMove,
  speedAfterWheel,
} from './gameCamera'
import { CLICK_SLOP, cancelRightPress } from './ObjectMenu'
import type { Orbit } from './AxisCompass'

/**
 * The wiring behind Game Controls: the listeners that collect a hand's worth of
 * input, and the one frame loop that spends it on the camera.
 *
 * MOUNTED ONLY WHILE THE MODE IS ON, rather than mounted always and gating
 * itself. Everything in here is a global listener or a per-frame callback, and
 * the switch is off for most users most of the time: not existing is cheaper
 * than checking a flag sixty times a second, and it means the orbit rig behaves
 * EXACTLY as it always has with the mode off -- there is no code path left
 * running that could have changed it. See `Scene`, which mounts it.
 *
 * All of the arithmetic lives next door in `gameCamera.ts`. What is left here
 * is the part that genuinely needs a canvas: which events to answer, and in
 * what order the camera is written each frame.
 *
 * THE ORBIT RIG IS NOT REPLACED. Every gesture in here is expressed as a move
 * of the camera and its target together, or of the target alone -- the two
 * things OrbitControls already understands -- so the compass still flies, the
 * middle button still orbits, and switching the mode back off leaves a camera
 * the old scheme can pick up mid-air. Anything else would have meant two rigs
 * fighting over one camera.
 */
/**
 * How far a right-drag travels before it is a LOOK rather than a click.
 *
 * The menu's own threshold, imported rather than restated, because the two are
 * one decision seen from either side: past this the menu will not open, and
 * past this the look takes the pointer. Two fives would drift, and the gap
 * between them would be a band of drags that neither turned the camera nor
 * opened anything.
 */
const LOOK_SLOP = CLICK_SLOP

/**
 * TAKE THE MOUSE AWAY FROM THE WINDOW for the rest of the look.
 *
 * Without it the turn is bounded by the screen: the cursor walks to the edge,
 * stops, and the camera stops with it halfway round -- so seeing what is behind
 * you takes three drags with a re-grab between each. Locked, the pointer has no
 * position to run out of and the deltas keep arriving however far the hand goes.
 * The cursor vanishes while it lasts, which is the other half of what makes this
 * feel like a game, and it comes back where it started on release.
 *
 * NOT AT THE PRESS, but at the slop: a right CLICK still opens the object menu,
 * and locking the pointer for one would hide the cursor and pop the browser's
 * own "press Esc" notice for a gesture that never moved.
 *
 * `unadjustedMovement` asks for the mouse's raw counts, with the operating
 * system's pointer acceleration taken off -- what a game wants, since the
 * acceleration curve is tuned for landing a cursor on a button rather than for
 * turning a view smoothly. It is not everywhere, so a refusal falls back to the
 * ordinary lock, and a refusal of THAT falls back to nothing at all: the drag
 * still turns the camera, it is merely bounded by the screen again. The capture
 * taken at the press is what carries that fallback.
 *
 * Both calls are guarded rather than awaited. The older signature returns
 * `undefined` instead of a promise, and a rejection nobody catches is an
 * unhandled error in the console for a comfort feature that failed.
 */
function grabPointer(canvas: HTMLCanvasElement, pointerId: number): void {
  if (document.pointerLockElement === canvas) return
  // Released first: the pointer cannot be both captured by an element and
  // locked to it, and the lock is the one that can outrun the screen.
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
  const lock = (options?: { unadjustedMovement: boolean }) =>
    (canvas.requestPointerLock(options) as unknown as Promise<void> | undefined) ?? undefined
  try {
    lock({ unadjustedMovement: true })?.catch(() => {
      try {
        lock()?.catch(() => {})
      } catch {}
    })
  } catch {
    try {
      lock()
    } catch {}
  }
}

export function GameControls({ controlsRef }: { controlsRef: RefObject<Orbit> }) {
  const { camera, gl } = useThree()
  /** The turn asked for since the last frame, in pixels; whether the button
   *  that asks for it is still down; how far it has come, so a click can be
   *  told from a drag; and whether the pointer has been taken. Refs rather than
   *  state: this is written on every pointer move and read once a frame, and a
   *  render per mouse move would re-draw the scene to move a camera that a
   *  render cannot move anyway. */
  const look = useRef({ dx: 0, dy: 0, travel: 0, held: false, grabbed: false, pointerId: -1 })
  const step = useRef(new Vector3())
  const pivot = useRef(new Vector3())

  useEffect(() => {
    const canvas = gl.domElement

    /**
     * A press with a field focused is typing, not flying.
     *
     * The same test the viewport's own key handler makes, and made again rather
     * than shared, because the two answer for different things: that one is
     * protecting Delete and the mode keys, this one is protecting the letters
     * of the alphabet. A `w` typed into a name box must reach the box.
     */
    const typing = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return false
      return (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e)) return
      // CHORDS ARE NOT MOVEMENT, and this line is the whole reason the two can
      // share a keyboard. C is the descend key and Ctrl+C is copy: without
      // this, copying an object would leave the camera sinking through the
      // floor with no key-up ever coming to stop it, because the browser hands
      // the chord to the page and the letter's release arrives with Ctrl still
      // down. Alt is the orbit modifier and Meta is the Mac's Ctrl, so both go
      // the same way.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (!pressMove(e.key)) return
      // Swallowed, and Space is why. Left alone it scrolls the page, and worse:
      // the browser fires a focused button's click on it, so a Space aimed at
      // rising would press whichever control in the console was last touched.
      // Taking the key here costs nothing -- by now it is known to be one of
      // ours, and none of ours means anything else outside a text field.
      e.preventDefault()
    }

    const onKeyUp = (e: KeyboardEvent) => releaseMove(e.key)

    /**
     * A window that has lost focus never sees the key come up, so a direction
     * held while alt-tabbing away would still be held on the way back and the
     * camera would set off across the scene by itself. The same reason the
     * viewport clears its modifiers on blur.
     */
    const onBlur = () => clearMoves()

    /**
     * THE RIGHT BUTTON LOOKS, which is the one gesture this mode takes off the
     * old scheme. It used to pan, and the two cannot share a button.
     *
     * What it does NOT take is the right CLICK: the object menu opens on
     * release, and only when the pointer has travelled less than a few pixels
     * from where it went down -- see `isRightClick`. A look is a drag by
     * definition, so the two gestures separate themselves and nothing here has
     * to know the menu exists. This listener neither stops the event nor
     * prevents its default, which is what leaves that alone.
     */
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 || e.target !== canvas) return
      look.current.held = true
      look.current.pointerId = e.pointerId
      look.current.dx = 0
      look.current.dy = 0
      look.current.travel = 0
      look.current.grabbed = false
      // A look that runs off the edge of the window keeps turning. The rig
      // captures the pointer itself for the gestures it answers, but it is
      // switched off for the length of a drag -- and looking about while
      // dragging a solid is exactly when this matters. Superseded by the
      // pointer LOCK below the moment the gesture is plainly a look; until
      // then this is what keeps the drag alive.
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!look.current.held) return
      // Accumulated rather than applied, because a browser can deliver several
      // moves between two frames -- coalesced or not -- and turning the camera
      // once per event would do the same spherical arithmetic five times to
      // draw one picture.
      look.current.dx += e.movementX
      look.current.dy += e.movementY
      if (look.current.grabbed) return

      look.current.travel += Math.abs(e.movementX) + Math.abs(e.movementY)
      if (look.current.travel <= LOOK_SLOP) return
      // PAST THE SLOP THIS IS A LOOK AND NOT A CLICK, and two things follow at
      // exactly this moment. Only one of them is at the user's request.
      look.current.grabbed = true
      grabPointer(canvas, e.pointerId)
      // The other. The menu tells a click from a drag by how far the pointer
      // travelled between press and release, and a locked pointer does not
      // travel -- every look would release within a pixel of its own start and
      // open a menu over the middle of the turn. So the gesture that knows what
      // it has become says so, rather than leaving the menu to measure a cursor
      // that no longer exists. See `cancelRightPress`.
      cancelRightPress()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!look.current.held || e.pointerId !== look.current.pointerId) return
      look.current.held = false
      look.current.grabbed = false
      // Whatever the last few pixels asked for is still owed, and is spent by
      // the next frame. Released rather than dropped: the gesture ends where
      // the hand actually finished.
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      // The cursor comes back where it went, which is where the look started.
      // Only ever OUR lock: a page that called `exitPointerLock` blindly would
      // be reaching into whatever else happened to hold it.
      if (document.pointerLockElement === canvas) document.exitPointerLock()
    }

    /**
     * The lock going away under us, which is not always our doing: Escape
     * releases it, and the browser drops it when the window loses focus.
     *
     * The look does NOT end with it. The button is still down, and the moves
     * keep arriving -- with a cursor again, so they are ordinary deltas and the
     * turn carries on, just bounded by the edge of the screen the way it was
     * before any of this. What must not happen is a re-grab: Chrome refuses a
     * lock requested too soon after Escape released one, and asking on every
     * move would be asking sixty times a second.
     */
    const onLockChange = () => {
      if (document.pointerLockElement !== canvas) look.current.grabbed = true
    }

    /**
     * THE WHEEL SETS THE SPEED, because in this mode it has nothing else to do.
     * Closing in on something is what W is for, so the notches are free -- and
     * they are under the hand that is already flying. See `speedAfterWheel` for
     * why a notch is a ratio rather than a step.
     *
     * Not passive, and it must not be: the page scrolls on a wheel event
     * nobody claims, and a viewport that scrolled the window out from under
     * itself would be worse than one that did nothing. The rig's own zoom is
     * switched off alongside this -- see `enableZoom` in `Scene` -- so the two
     * never both answer one notch.
     */
    const onWheel = (e: WheelEvent) => {
      if (e.target !== canvas) return
      e.preventDefault()
      const { flightSpeed, setFlightSpeed } = useTools.getState()
      setFlightSpeed(speedAfterWheel(flightSpeed, e.deltaY))
    }

    /**
     * A PRESS THAT LANDS MID-FLIGHT IS REFUSED.
     *
     * A gesture measures its grab on the frame it starts -- where the pointer
     * sat relative to the solid, which face it caught, where the stroke begins
     * -- and every one of those is a measurement against a viewport that is
     * sliding out from under it. Started on the move, an object jumps to the
     * pointer and a brush paints a smear across whatever passed underneath. A
     * gesture already running is left alone, which is the other half of the
     * rule: what needs protecting is the measurement, and by then it is made.
     *
     * ONE LISTENER RATHER THAN TWELVE. There are a dozen places a scene gesture
     * can start -- every solid, every gizmo arrow, every ruler end, every face
     * handle, the marquee -- and telling each of them would be telling eleven
     * of them and forgetting the twelfth, which is the very argument
     * `MarqueeControl` makes for reading its press off the window. Capture
     * phase on the window is the one point every press passes through before
     * any of them, so stopping it there stops all of them at once.
     *
     * THE CAMERA'S OWN BUTTONS ARE LET THROUGH. Middle and right are orbit and
     * look, and Alt+left is orbit for a mouse with no middle button: refusing
     * those would mean you could not turn to see where you were going while
     * going there, which is the whole gesture this mode is built on. Only a
     * plain left press -- the one that starts every gesture in the scene -- is
     * taken, and only while a key is actually down.
     */
    const refusePress = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey) return
      if (e.target !== canvas || !moving()) return
      e.stopPropagation()
    }

    /**
     * MIDDLE-DRAG ORBITS THE SELECTED OBJECT, decided at the moment of the
     * press rather than held as state, for the reason `armCamera` re-decides
     * the mouse buttons on every press: the answer is a fact about the scene
     * right now, and one written down at mount would be about a selection that
     * has since changed.
     *
     * The pivot is the object wearing the GIZMO -- `selectedObjectId`, the head
     * of the selection -- and its assembly anchor, which is the point the gizmo
     * is drawn at. That is the one pivot the user can actually see, so an orbit
     * about it does what the picture says it will. For the single click that
     * makes up nearly every selection it is also the most recently selected
     * thing, which is what was asked for; for a gathered selection it is the
     * one the handles are on, which is the better answer than "whichever you
     * shift-clicked last" precisely because it is on screen.
     *
     * WITH NOTHING SELECTED the target is left exactly where it is -- in front
     * of the camera, wherever the last look put it -- so the gesture degrades
     * into turning about the point you are facing rather than snapping back to
     * the middle of the world.
     */
    const aimOrbit = (e: PointerEvent) => {
      if (e.target !== canvas) return
      if (e.button !== 1 && !(e.button === 0 && e.altKey)) return
      const controls = controlsRef.current
      if (!controls) return
      const s = useDoc.getState()
      const chosen = primarySelection(s)
      const object = chosen && s.doc.objects.find((o) => o.id === chosen)
      if (!object) return
      const [x, y, z] = assemblyAnchor(object)
      controls.target.set(x, y, z)
      controls.update()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', refusePress, true)
    window.addEventListener('pointerdown', aimOrbit, true)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    document.addEventListener('pointerlockchange', onLockChange)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', refusePress, true)
      window.removeEventListener('pointerdown', aimOrbit, true)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.removeEventListener('pointerlockchange', onLockChange)
      canvas.removeEventListener('wheel', onWheel)
      // The mode switched off, or the screen changed, with the button still
      // down: the cursor has to come back, and nothing left is listening for
      // the release that would have brought it.
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      // Unmounted with a hand still on the keys -- the switch turned off, or
      // the screen changed under it -- and the key-up will land on nothing.
      clearMoves()
    }
  }, [controlsRef, gl])

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls) return

    // LOOK BEFORE WALKING, because walking is measured along the direction
    // looking just chose. The other order would spend a frame going where the
    // camera used to point, which over a turn-and-run reads as the camera
    // sliding sideways out of the corner it was rounding.
    const turn = look.current
    if (turn.dx !== 0 || turn.dy !== 0) {
      lookTarget(camera.position, controls.target, turn.dx, turn.dy, pivot.current)
      controls.target.copy(pivot.current)
      turn.dx = 0
      turn.dy = 0
      // SETTLED NOW rather than at the foot of the frame, which is what makes
      // the order above worth anything. A new target does not by itself turn
      // the camera -- the rig re-aims it on its next update, and that update is
      // the last thing this loop does -- so the step below would be measured
      // off the quaternion the PREVIOUS frame was drawn with, and a turn-and-run
      // would set off one frame's worth in the direction just left behind.
      controls.update()
    }

    const travel = flightStep(
      movesHeld(),
      camera.quaternion,
      useTools.getState().flightSpeed,
      delta,
      step.current
    )

    if (travel.lengthSq() > 0) {
      // BOTH ENDS MOVE TOGETHER. The rig holds the camera at a fixed offset
      // from its target and re-aims it there on every update, so moving the
      // camera alone would be undone within the frame -- and moving the target
      // alone is the turn above. Carried together, the offset is untouched, the
      // view direction survives, and the pivot stays the distance ahead that
      // every gesture built on it expects.
      camera.position.add(travel)
      controls.target.add(travel)
    }

    // Called whether or not anything moved. The rig damps, so it has its own
    // leftovers to pay out, and skipping the update on a still frame would
    // strand them.
    controls.update()
  })

  return null
}
