/**
 * How much of the world an orthographic viewport shows, and what to set on the
 * camera to show it.
 *
 * Pure arithmetic in a file of its own, for the reason `decalPlacement.ts` and
 * `latheView.ts` are: this is the part of a camera that can be wrong in a way
 * an eye does not catch. A frame half again too wide still looks like a
 * viewport -- it is only when somebody measures a drawing against the block
 * they traced it from that it turns out to have been a screen that lied.
 * Numbers in, numbers out, and a headless check can hold every one of them to
 * account.
 *
 * THE ONE FACT THE REST FOLLOWS FROM: react-three-fiber sizes an orthographic
 * frustum in PIXELS -- `left` and `right` are the canvas's own half-width, `top`
 * and `bottom` its half-height -- and leaves `zoom` to say how much world that
 * covers. So the height of world on screen is `pixels / zoom`, and `zoom` is not
 * a magnification but a SCALE: pixels per world unit. Which is why a zoom is
 * meaningless on its own, and why nothing here takes one without also being told
 * the height it belongs to. See `updateCamera` in fiber's own source.
 *
 * A perspective camera needs none of this, and that is the trade. An fov is an
 * ANGLE: the same camera frames the same world in a window of any size, and the
 * pixels only decide how finely it is drawn. Trading the lens for a projection
 * means taking that job on by hand.
 */

/**
 * The height of world a perspective camera of `fov` degrees frames at
 * `distance`.
 *
 * Here rather than at the one screen that uses it, because it is the join
 * between a projection and the lens the rest of the app looks through: the
 * frames worth choosing are the ones the fov already chose, and this is how they
 * are read off. Degrees in, to match the camera's own field; the halving that
 * turns it into an angle from the axis is folded into the 360.
 */
export function perspectiveFrame(distance: number, fov: number): number {
  return 2 * distance * Math.tan((fov * Math.PI) / 360)
}

/**
 * The zoom that spreads `frame` world units down `pixels` of canvas.
 *
 * Undefined for a frame of nothing, and deliberately not defended here: a caller
 * that does not know how much world it wants has a bug, and an Infinity that
 * quietly becomes a black screen is a worse way to find out than the number
 * itself. The one caller guards on having a canvas to measure, which is the
 * only way it can arise.
 */
export function zoomFor(pixels: number, frame: number): number {
  return pixels / frame
}

/**
 * And what a zoom is showing, which is the same fact read the other way.
 *
 * How a frame survives a window being resized: read the frame out at the height
 * it was set at, and set the zoom back at the new one. That is what keeps a
 * resize from throwing away wherever the wheel had got to.
 */
export function frameOf(pixels: number, zoom: number): number {
  return pixels / zoom
}

/**
 * How much WORLD a mark of `pixels` pixels covers at this zoom.
 *
 * The same division `frameOf` does, named for the other question it answers: a
 * frame is how much world fills the canvas, and this is how much world fills a
 * dot drawn on it. Since `zoom` is pixels per world unit, dividing by it is the
 * whole of holding something to a size under the eye.
 *
 * WHAT THIS IS FOR, and the line it draws. Two kinds of thing are drawn on a
 * face and they must behave in opposite ways under the wheel:
 *
 *   - FURNITURE -- a knot on a line, a grip to pull, a hit radius -- belongs to
 *     the screen. It is somewhere to put a finger, so it is the same size under
 *     that finger at every zoom, and it is drawn this many world units across.
 *   - THE WORK -- the kerf the laser burns, the block, the reference stuck to
 *     it -- belongs to the block. It is measured in the material, so zooming in
 *     draws it bigger.
 *
 * Getting that the wrong way round is what makes zooming in useless: the whole
 * point of it is to work more finely, and furniture that grows with the picture
 * covers the very detail you leaned in to see.
 */
export function pixelsToWorld(pixels: number, zoom: number): number {
  return pixels / zoom
}
