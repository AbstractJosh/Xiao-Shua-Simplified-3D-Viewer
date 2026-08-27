import { Matrix4, Quaternion, Vector3 } from 'three'

/**
 * The six views the corner compass can send the camera to, and the arithmetic
 * that puts it there.
 *
 * No React and no renderer, for the same reason `axisColors` has neither: the
 * component that draws the compass and the check suite that guards where a
 * click lands can both import this, and "where does the camera end up" is a
 * question with one answer rather than one per caller.
 */

/** World up. The scene is Y-up throughout -- the grid lies in XZ and
 *  OrbitControls orbits about Y -- so this is a fact about the app, not a
 *  parameter. */
const UP = new Vector3(0, 1, 0)
const ORIGIN = new Vector3()

/**
 * A face of the world, named twice: once for the axis it stands on and once
 * for what a modeller calls the view from there.
 *
 * Both names are needed because both are shown. The ball on the end of each
 * stalk carries the letter -- it is an axis marker, and the arrows on the gizmo
 * it echoes are lettered the same way -- while the cube's faces carry the word,
 * because "Top" is what the face of a box IS, and a cube labelled X/Y/Z would
 * be saying the same thing as the balls twice over.
 */
export type CompassView = {
  /** Stable id, for keys and for naming a failure in the checks. */
  key: string
  axis: 0 | 1 | 2
  sign: 1 | -1
  /** Where the camera goes, as a unit direction from the point it orbits. */
  dir: Vector3
  letter: 'X' | 'Y' | 'Z'
  /** The face of the cube that looks this way. */
  label: string
}

/**
 * In the order `BoxGeometry` takes its materials -- +X, -X, +Y, -Y, +Z, -Z --
 * so the cube can hand a hit's `materialIndex` straight back as a view without
 * a lookup table in between. Every other consumer iterates, and does not care.
 */
export const COMPASS_VIEWS: CompassView[] = [
  { key: 'x+', axis: 0, sign: 1, dir: new Vector3(1, 0, 0), letter: 'X', label: 'Right' },
  { key: 'x-', axis: 0, sign: -1, dir: new Vector3(-1, 0, 0), letter: 'X', label: 'Left' },
  { key: 'y+', axis: 1, sign: 1, dir: new Vector3(0, 1, 0), letter: 'Y', label: 'Top' },
  { key: 'y-', axis: 1, sign: -1, dir: new Vector3(0, -1, 0), letter: 'Y', label: 'Bottom' },
  { key: 'z+', axis: 2, sign: 1, dir: new Vector3(0, 0, 1), letter: 'Z', label: 'Front' },
  { key: 'z-', axis: 2, sign: -1, dir: new Vector3(0, 0, -1), letter: 'Z', label: 'Back' },
]

/**
 * Which way is up, looking from `dir`.
 *
 * World +Y everywhere except straight up and straight down, where +Y is the
 * direction being looked ALONG and so says nothing about the roll. The answer
 * there is the one a continuous orbit would have arrived at: tip the front view
 * up over the top and the up vector tips with it, from +Y to -Z. Anything else
 * makes the top view arrive spun by some amount the gesture never asked for.
 */
export function viewUp(dir: Vector3): Vector3 {
  const along = dir.dot(UP)
  return Math.abs(along) > 0.999 ? new Vector3(0, 0, -Math.sign(along)) : UP.clone()
}

/** The orientation a camera carries when it looks at its pivot from `dir`. */
export function viewQuaternion(dir: Vector3): Quaternion {
  const matrix = new Matrix4().lookAt(dir, ORIGIN, viewUp(dir))
  return new Quaternion().setFromRotationMatrix(matrix)
}

/**
 * Where a camera with that orientation has to stand to be looking at `focus`
 * from `radius` away.
 *
 * Position is DERIVED from orientation rather than tracked alongside it, which
 * is what keeps a flight coherent frame by frame: the two cannot disagree if
 * there is only one of them. A camera's own +Z points backwards out of the
 * screen, so pushing the pivot that way by the orbit radius is the position
 * that looks back at it.
 */
export function orbitPosition(facing: Quaternion, focus: Vector3, radius: number): Vector3 {
  return new Vector3(0, 0, 1).applyQuaternion(facing).multiplyScalar(radius).add(focus)
}

/**
 * The live link between the compass and the scene, in one mutable object.
 *
 * Module-level for the reason `rotationIndicator` is: the orientation changes
 * on every frame of an orbit, and putting it through a store would re-render
 * the console sixty times a second to turn a 112-pixel widget. The compass is
 * also a SECOND canvas -- its own renderer, its own frame loop, its own React
 * root inside the same tree -- so the two have no camera in common to read;
 * this object is the whole of what passes between them.
 */
export const compass: {
  /** The main camera's orientation, written every frame by `CompassControl`.
   *  The compass draws the world axes turned by its inverse, which is what
   *  makes it a readout of where the camera is rather than a fixed diagram. */
  facing: Quaternion
  /** A view the user has clicked, waiting to be picked up by the scene, or
   *  null. Consumed rather than read, so one click is one flight. */
  request: Vector3 | null
} = {
  facing: new Quaternion(),
  request: null,
}

/** Ask the camera to fly to a view. Latest wins: a second click mid-flight
 *  redirects it rather than queueing behind it. */
export function askForView(dir: Vector3): void {
  compass.request = dir.clone()
}

/** Take the pending request, if there is one, and clear it. */
export function takeRequest(): Vector3 | null {
  const asked = compass.request
  compass.request = null
  return asked
}
