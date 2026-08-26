import { Quaternion, Vector3 } from 'three'

/**
 * The turn currently in progress, for the parts of the scene that have to react
 * to it without owning it.
 *
 * Module-level and mutable, for the same reason `snapIndicator` is: this
 * changes on every frame of a drag, and two things read it -- the gizmo, which
 * hides its arrows so they are not in the way of what is being read, and the
 * dial, which draws the swept angle. Routing that through the store would
 * re-render the whole scene sixty times a second to move one wedge.
 *
 * Exactly one gizmo is ever on screen, so a single global is unambiguous.
 */
export const rotationIndicator: {
  /** Whether a ring turn is running right now. */
  active: boolean
  /** Signed angle swept since the grab, unwrapped, in radians. */
  angle: number
  /** Where the dial is drawn. */
  centre: Vector3
  /** The camera-facing plane the dial lies in, at the moment of the grab. */
  facing: Quaternion
  /** Where round that plane the grab was taken, so the wedge starts there. */
  startAngle: number
  /**
   * Where the dial has landed on screen, in CSS pixels from the canvas corner.
   *
   * Written by the dial, which is inside the Canvas and has the camera; read by
   * the readout, which is a plain DOM node outside it. The number wants to be
   * crisp text next to the wedge rather than geometry in the scene, and this is
   * the shortest path between the two worlds that does not put a projection
   * matrix in a React render.
   */
  screen: { x: number; y: number }
} = {
  active: false,
  angle: 0,
  centre: new Vector3(),
  facing: new Quaternion(),
  startAngle: 0,
  screen: { x: 0, y: 0 },
}

/** Called when any gesture ends, so a released turn never leaves a dial up. */
export function clearRotationIndicator(): void {
  rotationIndicator.active = false
  rotationIndicator.angle = 0
}
