import { MOUSE } from 'three'
import type { TransformMode } from './store/toolStore'

/**
 * Whose hands the app is driven with: which button turns the camera, which
 * slides it, which way the wheel runs, and which letters pick a gizmo.
 *
 * ONE TABLE, AND EVERY SCREEN ASKS IT. The modelling viewport, the laser cutter
 * and the lathe each used to carry their own copy of "middle orbits, right
 * pans" in their own words, which was fine while there was one answer. There
 * are five now, and five answers written out in three places is fifteen chances
 * for a screen to disagree with Help. So the bindings are data, here, and a
 * screen asks `cameraPress` what a press means instead of reading the button
 * itself.
 *
 * WHAT A SCHEME DOES NOT TOUCH is everything that is not navigation or a gizmo
 * letter: the left button still selects and still draws the marquee, the right
 * click still opens the object menu, Escape and the Ctrl chords are where they
 * always were. All three of the applications named here agree with this app on
 * those, so there was nothing to translate.
 *
 * `game` IS A SCHEME RATHER THAN A SWITCH BESIDE THEM. It is the Default
 * bindings with the keyboard handed to the camera on the one screen that can be
 * walked -- see `flyingHere` -- so it shares Default's table and the flying is
 * layered on top by `GameControls`.
 *
 * Near enough plain data, like `motion.ts` and `theme.ts`: the one import is
 * the rig's own vocabulary for a gesture, which `rigButtons` has to speak.
 */
export type ControlScheme = 'default' | 'blender' | 'maya' | 'fusion' | 'game'

/** Every scheme on offer, in the order the switch shows them. */
export const CONTROL_SCHEMES: ControlScheme[] = ['default', 'blender', 'maya', 'fusion', 'game']

/** What each is called on the switch. */
export const CONTROL_SCHEME_LABELS: Record<ControlScheme, string> = {
  default: 'Default',
  blender: 'Blender',
  maya: 'Maya',
  fusion: 'Fusion 360',
  game: 'Game',
}

/** What a first visit gets: the controls this app has always had. */
export const DEFAULT_CONTROL_SCHEME: ControlScheme = 'default'

/** The three things a mouse can do to a camera. */
export type CameraGesture = 'orbit' | 'pan' | 'zoom'

/**
 * One way of asking for a camera gesture.
 *
 * `mod` is the modifier that has to be DOWN for the binding to answer. A
 * binding without one answers its button whatever else is held, which is why
 * the chorded ones are listed first -- see `cameraPress`.
 */
export type CameraBinding = {
  /** `PointerEvent.button`: 0 left, 1 middle, 2 right. */
  button: 0 | 1 | 2
  mod?: 'alt' | 'shift' | 'ctrl'
  does: CameraGesture
}

export type SchemeBindings = {
  /** First match wins, so a chord goes before the bare button it is built on. */
  camera: readonly CameraBinding[]
  /** 1 where rolling away closes in, -1 where it backs off. */
  wheel: 1 | -1
  /** The bare letters that pick a gizmo. */
  modeKeys: Readonly<Record<string, TransformMode>>
  /** A letter that deletes, beside Delete and Backspace. */
  deleteKey?: string
}

/**
 * The controls the app has always had.
 *
 * M, R and S are bare rather than chorded: a mode you reach for between every
 * other gesture is not worth a chord, and none of the three was spoken for --
 * the app's other shortcuts are all held behind Control.
 *
 * M is the odd one, since Move is where the gizmo rests and the other two
 * already fall back to it. It earns its key anyway: that fallback is reached by
 * pressing the tool you are IN, so leaving Move nameless made it the one mode
 * you could not ask for -- from Rotate the way back was R, which is not the key
 * for the thing you want. See `pressTransformMode`, which is where what a press
 * means actually lives.
 */
const DEFAULT_BINDINGS: SchemeBindings = {
  camera: [
    // For the mice and trackpads with no middle button to press.
    { button: 0, mod: 'alt', does: 'orbit' },
    { button: 1, does: 'orbit' },
    { button: 2, does: 'pan' },
  ],
  wheel: 1,
  modeKeys: { m: 'move', r: 'rotate', s: 'scale' },
}

/**
 * Each scheme's bindings, as the application it is named for ships them.
 *
 * NO RIGHT-DRAG PAN OUTSIDE DEFAULT. None of the three pans on a bare right
 * button -- it is their context menu, as it is this app's -- so under them a
 * right-drag across empty space does nothing, and the pan is on the chord its
 * own application puts it on.
 *
 * FUSION KEEPS R AND S. It has no bare key of its own for turning or sizing,
 * so there was nothing to translate them to and no reason to take them away.
 * Its wheel runs the other way from everyone else's, and that is copied: the
 * whole point of a preset is that the hand does not have to think.
 */
export const SCHEME_BINDINGS: Record<ControlScheme, SchemeBindings> = {
  default: DEFAULT_BINDINGS,
  blender: {
    camera: [
      { button: 1, mod: 'shift', does: 'pan' },
      { button: 1, mod: 'ctrl', does: 'zoom' },
      { button: 1, does: 'orbit' },
    ],
    wheel: 1,
    modeKeys: { g: 'move', r: 'rotate', s: 'scale' },
    deleteKey: 'x',
  },
  maya: {
    camera: [
      { button: 0, mod: 'alt', does: 'orbit' },
      { button: 1, mod: 'alt', does: 'pan' },
      { button: 2, mod: 'alt', does: 'zoom' },
    ],
    wheel: 1,
    modeKeys: { w: 'move', e: 'rotate', r: 'scale' },
  },
  fusion: {
    camera: [
      { button: 1, mod: 'shift', does: 'orbit' },
      { button: 1, does: 'pan' },
    ],
    wheel: -1,
    modeKeys: DEFAULT_BINDINGS.modeKeys,
  },
  game: DEFAULT_BINDINGS,
}

/** As much of a pointer event as decides whose press it is. A record rather
 *  than the event, so the rules below can be checked without a DOM. */
export type PressKeys = {
  button: number
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

const held = (press: PressKeys, mod: NonNullable<CameraBinding['mod']>): boolean =>
  mod === 'alt'
    ? press.altKey
    : mod === 'shift'
      ? press.shiftKey
      : // Ctrl is Cmd on a Mac, here as in every chord the app answers.
        press.ctrlKey || press.metaKey

/** The camera binding this press answers under `scheme`, or null if the press
 *  is not the camera's at all. */
export function cameraPress(scheme: ControlScheme, press: PressKeys): CameraBinding | null {
  return (
    SCHEME_BINDINGS[scheme].camera.find(
      (b) => b.button === press.button && (b.mod === undefined || held(press, b.mod))
    ) ?? null
  )
}

/**
 * Whether this press is the camera's ALONE, so that nothing in the scene may
 * answer it as well.
 *
 * A CHORD IS UNAMBIGUOUS AND A BARE BUTTON IS NOT. Alt+left under Maya is an
 * orbit and cannot also be a brush stroke on whatever solid happened to be
 * under the pointer -- which is nearly always some solid, since the model is
 * what fills the view. A bare button is shared the way it always was: a right
 * press on a solid still selects it and opens its menu, and only becomes a pan
 * if it turns into a drag.
 */
export function cameraClaims(scheme: ControlScheme, press: PressKeys): boolean {
  return cameraPress(scheme, press)?.mod !== undefined
}

/**
 * What OrbitControls must be told so that THIS press does what the scheme says.
 *
 * Written into the rig's `mouseButtons` before every press, because the rig
 * reads that map at pointer-down and never again during the drag -- and because
 * the answer depends on the modifiers held at that instant.
 *
 * THE RIG HAS A CHORD OF ITS OWN and it has to be undone. With Shift, Ctrl or
 * Meta down it swaps orbit and pan, whichever it was asked for. So a binding
 * that is ITSELF chorded asks for the opposite of what it wants whenever one of
 * those three is held, and the rig's swap lands it on the right one. A bare
 * binding is passed through as it stands, which leaves Default's middle button
 * doing exactly what it did before any of this existed.
 */
export function rigButtons(
  scheme: ControlScheme,
  press: PressKeys
): { LEFT: MOUSE | null; MIDDLE: MOUSE | null; RIGHT: MOUSE | null } {
  const binding = cameraPress(scheme, press)
  let action: MOUSE | null = null
  if (binding?.does === 'zoom') {
    action = MOUSE.DOLLY
  } else if (binding) {
    const swapped =
      binding.mod !== undefined && (press.shiftKey || press.ctrlKey || press.metaKey)
    action = (binding.does === 'orbit') !== swapped ? MOUSE.ROTATE : MOUSE.PAN
  }
  return {
    LEFT: press.button === 0 ? action : null,
    MIDDLE: press.button === 1 ? action : null,
    RIGHT: press.button === 2 ? action : null,
  }
}

/** Whether this key press deletes: Delete and Backspace always, and the
 *  scheme's own letter where it has one -- bare, so Ctrl+X is still a chord. */
export function deletes(
  scheme: ControlScheme,
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }
): boolean {
  if (e.key === 'Delete' || e.key === 'Backspace') return true
  const letter = SCHEME_BINDINGS[scheme].deleteKey
  return (
    letter !== undefined &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    e.key.toLowerCase() === letter
  )
}
