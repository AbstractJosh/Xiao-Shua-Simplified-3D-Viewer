import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { MOUSE } from 'three'
import type { Object3D } from 'three'
import { FreehandTool, MoveRefTool, PointCutTool, SymmetryTool } from '../console/LaserTools'
import { ReferenceEditor } from '../console/ReferenceEditor'
import { outlineOf } from '../geometry/laserCut'
import type { FaceAxis } from '../geometry/laserCut'
import { DEFAULT_OBJECT_COLOR } from '../geometry/types'
import { DEFAULT_BLOCK, useLaser } from '../store/laserStore'
import type { Piece as LaserPiece } from '../store/laserStore'
import { useReference, visiblePlacements } from '../store/referenceStore'
import { isCutTool, useTools } from '../store/toolStore'
import { AxisCompass, CompassControl } from './AxisCompass'
import type { Orbit } from './AxisCompass'
import { BlockPanel } from './BlockPanel'
import { CopyBlockButton } from './CopyBlockButton'
import { CutPanel } from './CutPanel'
import { nearestView } from './compassViews'
import { CutLayer } from './CutLayer'
import { MirrorLayer } from './MirrorLayer'
import { SymmetryPanel } from './SymmetryPanel'
import { ReferenceHandles, ReferenceMaterial, useReferencePointer } from './ReferenceDecals'
import { useCutDraft } from './cutDraft'
import { NO_PAN, panCorrection, panLimits } from './facePan'
import { frameOf, perspectiveFrame, zoomFor } from './orthoFrame'
import { STAGE_CAMERA, STAGE_MAX_DISTANCE, STAGE_MIN_DISTANCE, Stage } from './Stage'
import { IslandShell } from './ToolIsland'
import { useSceneColors } from './useSceneColors'

/**
 * The Laser Cutter screen: a block of stock on the bed, a compass that is the
 * only way to look at it, and two ways of drawing the cut.
 *
 * THE VIEW THAT CUTS IS SQUARE ON TO A FACE. A laser cuts straight down through
 * whatever is under it, so a view that is only NEARLY square on is the bad case:
 * everything it shows is foreshortened by an amount nobody chose, and a line
 * drawn on it lands somewhere other than where it looked. The compass in the
 * corner is what guarantees that view -- it comes to rest on an axis every time
 * the hand comes off it, so a gesture that ends on the compass always ends on a
 * face. See `CompassControl`'s `settle`, and `nearestView` for what "nearest"
 * means.
 *
 * THE MIDDLE BUTTON ORBITS, on the same binding the modelling screen uses. This
 * screen used to refuse the camera outright, on the reasoning above; that made
 * the compass the only way to look at the block at all, and left the middle
 * button doing the one thing nobody wanted from it here, which was dolly.
 *
 * AND IT SETTLES, exactly as the compass does. That is what keeps the reasoning
 * above intact rather than trading it away for the orbit: mid-drag the view goes
 * wherever the hand takes it, and the moment the hand comes off it flies to
 * whichever face it ended up nearest. So the camera still only ever RESTS square
 * on to a face -- what changed is that there are now two ways to choose which
 * face, and one of them is the whole viewport instead of a widget in the corner.
 * `CompassControl` owns both: its `settle` covers the compass's release and this
 * one, down the same flight.
 *
 * AND THE RIGHT BUTTON SLIDES IT ACROSS THAT FACE. The pan was off for a long
 * time, on the reasoning that `FocusOnBlock` owns the pivot and a pan writes the
 * same target, so the two would fight and the view would drift off the thing the
 * screen is about. The first half of that was true and is now settled -- the
 * pivot is translated rather than reseated, so the two no longer write over each
 * other -- and the second half was answered the wrong way round: the view drifts
 * off the block only if nothing stops it, and something does. The pan is clamped
 * to the face being looked at, so the middle of the window can be carried as far
 * as the edge of that face and no further, and a face change puts it back on the
 * middle. See `PanAcrossFace`.
 *
 * IT IS THE OTHER HALF OF THE WHEEL, which is why it is worth the machinery. A
 * projection cannot be walked closer: zooming magnifies about the middle of the
 * window, so the closer you look at a face the further its own edges are outside
 * the window -- and the edges are where a cut has to be aimed. Without a pan the
 * zoom can only be used on the middle of the stock.
 *
 * The left button is not a camera either -- it draws, which is the whole screen
 * -- so there is no Alt+left orbit here to match the modelling screen's, and the
 * pan took the one button that was still free.
 *
 * That is what makes the drawing possible at all. Square on to a face, the
 * pointer maps to a place on that face by one plane intersection, and what is
 * drawn is what is cut -- see `CutLayer`. It is not a 2D viewport; it is a
 * camera in the same room the other screens work in, and the block is a solid
 * the whole time. But a cube seen square on hides five of its faces behind the
 * sixth, so what is on screen is a square, and a cut aimed at it lands where it
 * looks like it lands.
 *
 * AND IT PROJECTS RATHER THAN FORESHORTENS. The camera is ORTHOGRAPHIC, alone
 * among the three screens, and that is the other half of the same promise:
 * settling square on to a face fixes the DIRECTION the block is seen from, and
 * a parallel projection fixes the SCALE it is seen at. This screen needs both,
 * because everything on it is a thing measured against something else.
 *
 * A lens makes size fall away with distance, and three things here stand at
 * different distances even with the view dead square on:
 *
 *   - THE FAR FACE AGAINST THE NEAR ONE. A reference stuck on the back of the
 *     block is a whole block's depth further off than the same reference on the
 *     front, so a lens draws it smaller. Turn the block round and a picture
 *     sized against the drawing on one face no longer matches it on the other
 *     -- and matching a drawing is the whole of what a reference is for.
 *   - THE SIDES AGAINST THE FACE. A lens square on to a cube does not show a
 *     square: the four faces around the one being looked at splay out from
 *     behind it, so the shape on screen is wider than the face the cut is drawn
 *     on, and the silhouette the eye reads as the edge of the material is not
 *     the edge the cut has to stay inside. Projected, the silhouette IS the
 *     face.
 *   - AND THE BLOCK AGAINST ITSELF. Type a bigger Depth and a lens brings the
 *     front face nearer the camera, so a block made deeper is drawn WIDER: one
 *     field moving two dimensions, on a screen whose corner panel is three
 *     numbers side by side.
 *
 * The face being drawn on is the one case a lens gets right -- a plane parallel
 * to the film is scaled uniformly, so a line drawn square on landed where it
 * looked even before this. Which is why this is a promise being finished rather
 * than a bug being fixed: what the lens got wrong was never the aim, it was
 * everything the aim is measured against.
 *
 * THE WHEEL STILL ZOOMS, and it is the same wheel over the same range: with no
 * lens to dolly, it scales the projection instead. Zooming does not tip the
 * camera off its axis, so it costs the screen nothing, and without it a
 * five-metre block and a one-millimetre one could not both be looked at. What a
 * projection does cost is that the scale is no longer carried by an angle, so
 * the height of the window has to be answered for by hand -- see `HoldFrame`.
 *
 * THE ROOM IS THE ROOM: background, lights and the ground the block stands on,
 * all of it `Stage`, exactly as the modelling screen has it, and kept rather
 * than blanked as the lathe blanks it -- the ground is what says the stock is
 * standing on a bed.
 *
 * WITH ITS FLOOR CUT DOWN TO THAT BED, which is the one thing this screen asks
 * the room to change. Every screen stands on a patch of ground rather than a
 * floor without end -- see `Stage` -- and this screen asks for the app's
 * smallest: under a projection nothing dims with distance, so a patch sized
 * for a camera that travels would arrive at the edge of the window at very
 * nearly the brightness it has under the block. This one reaches three blocks
 * out and is gone. See `GROUND_REACH`.
 *
 * AND A PROJECTION PUTS MOST OF WHAT IS LEFT AWAY, which is worth knowing here
 * rather than discovering. The camera rests level with the middle of the block,
 * so on the four side views the ground plane CONTAINS the direction being
 * looked along -- and a plane seen edge-on by a parallel projection is a line,
 * with no width for a grid to be drawn in. It comes back on Top and Bottom,
 * where the ground is square on. That is the ordinary bargain of an elevation,
 * and the job the grid used to do here -- showing that a block being resized
 * really is getting bigger -- has passed to the frame, which does not move at
 * all now and measures the block exactly. See `OPENING_FRAME`.
 */

/**
 * How far the camera stands off the block's centre.
 *
 * The distance the modelling screen frames the same ten-centimetre solid from
 * -- `STAGE_CAMERA` stands 3.9 units out down the corner of the world -- rounded
 * to the four units it is within a rounding error of. Square on rather than down
 * the corner, because this screen has no corner views: every view it can be in
 * is one of the six.
 *
 * IT NO LONGER FRAMES ANYTHING, which is what the name change is about. Under a
 * projection the picture is the same from four units out as from forty, so what
 * the standoff decides is not how big the block looks but only what the camera
 * is CLEAR of: the near plane, and the solid itself. The framing moved to
 * `OPENING_FRAME` and the wheel went with it.
 */
export const BLOCK_STANDOFF = 4

/**
 * How much of the block stands in the height of the window when the screen
 * opens, and how much world that works out to.
 *
 * IT USED TO BE READ OFF THE ROOM'S LENS -- the frame forty-five degrees threw
 * at the standoff, 3.31 units, which put the default block across a third of
 * the window. That is the right opening shot for a screen you ARRIVE at, with a
 * scene in it you have not seen yet and room all round to find your way about.
 * This screen is the opposite: there is exactly one thing on it, it is in the
 * middle, and what you came here to do is draw a line on its face. A third of
 * the window is a third of the resolution to aim with, and the ground it buys
 * in exchange is empty bed.
 *
 * So the frame is stated as a share of the BLOCK instead, and the share is
 * three fifths -- twice the zoom it opened on. The face is big enough to place
 * points on carefully, and the two fifths left over still show the stock
 * standing on something rather than floating in a crop.
 *
 * It stays the one number a projection needs and a lens does not: with no field
 * of view to hold the angle, something has to hold the scale. See
 * `orthoFrame.ts` for why that something cannot simply be a zoom, and
 * `HoldFrame` for what turns it into pixels.
 */
export const OPENING_SHARE = 0.6
export const OPENING_FRAME = DEFAULT_BLOCK / OPENING_SHARE

/**
 * How far the wheel may take that frame, in and out.
 *
 * The two distances the room lets a camera dolly between, read as the frames
 * that same lens would have thrown at them -- so the wheel reaches exactly as
 * far as it always did at both ends, and the room stays the one place the range
 * is decided. About a millimetre and a half of world across the window at the
 * near end, which is the smallest block this app allows filling most of it; about
 * sixteen metres at the far end, which stands the largest one off with ground to
 * spare.
 */
export const CLOSEST_FRAME = perspectiveFrame(STAGE_MIN_DISTANCE, STAGE_CAMERA.fov)
export const WIDEST_FRAME = perspectiveFrame(STAGE_MAX_DISTANCE, STAGE_CAMERA.fov)

/**
 * How close to the block the camera may ever get, as a share of the block's own
 * side.
 *
 * THE ONE THING THE FIXED CAMERA NEEDS PROTECTING FROM. The frame does not
 * re-fit itself when the block is resized -- that is deliberate, and it is what
 * makes a bigger block LOOK bigger rather than being redrawn at the same size
 * on a rescaled frame, which is the mistake the lathe's own frame is written up
 * for. But a block grown far enough would swallow the camera whole, and a
 * camera inside a solid sees the insides of its faces, which are culled: the
 * screen goes empty, with nothing on it to say which way to scroll back out.
 *
 * Nine tenths of the side, which is just outside the cube's own half-diagonal
 * of 0.866 -- so the camera is always clear of the corner, and no closer than
 * it has to be. Zooming right up to a face is still allowed, which is a thing
 * anyone aiming a cut will want; going inside is not.
 *
 * Enforced by OrbitControls itself, which clamps the orbit radius in `update`
 * whichever kind of camera it is flying. It has ONE job now where it used to
 * have two: the wheel cannot reach the wall any more, since an orthographic
 * camera zooms where it stands rather than dollying in, so all that is left is
 * a block grown around a camera pushing that camera out ahead of it -- see
 * `FocusOnBlock`, whose `update` is what applies it.
 */
const BLOCK_CLEARANCE = 0.9

/**
 * Where the camera is set down: looking at the front face of a block of the
 * default size, from the height of that block's own middle.
 *
 * NO FIELD OF VIEW, because there is no lens to have one -- and no `zoom`
 * either, though that is the field a projection frames with. A zoom is pixels
 * per world unit, so the one that frames `OPENING_FRAME` cannot be known until
 * there is a canvas to measure; `HoldFrame` sets it before the first frame is
 * drawn. What is left is the room's own near and far -- a near plane close
 * enough to put a millimetre feature on screen -- so the three screens still
 * agree about how near and how far a thing may be. See `STAGE_CAMERA`.
 */
const LASER_CAMERA = {
  position: [0, DEFAULT_BLOCK / 2, BLOCK_STANDOFF] as [number, number, number],
  near: STAGE_CAMERA.near,
  far: STAGE_CAMERA.far,
}

/**
 * How far the ground reaches past the middle of the bed, as a multiple of the
 * block's longest side.
 *
 * THE ROOM'S GROUND IS SIZED FOR THE OTHER SCREEN AND THIS ONE CANNOT USE IT.
 * Under a projection nothing dims with distance, so drei's fade -- which is a
 * function of distance and nothing else -- has almost no work to do across a
 * window that is only a couple of units of world wide: the grid arrives at the
 * edge of the screen at very nearly the brightness it has under the block. And
 * the camera here rests LEVEL with the block, so on the four side views that
 * ground is edge-on: one hard line ruled clean across the window, with nothing
 * about it that says where the bed is.
 *
 * The other screen needs no bound as tight: it orbits and pans, its lens dims
 * the far ground on its own, and it asks only for enough floor to hold the
 * model standing on it -- see `groundReach`. This camera does not travel at
 * all -- it rests on one of six faces of one block that never leaves the
 * middle -- so the ground here can be a patch under that block rather than a
 * patch under a scene.
 *
 * THREE BLOCKS, so the bed reads as bed. One is the footprint itself and shows
 * nothing outside the stock; much more and the fade is so far out that it is
 * back to being a flat endless sheet. At three the grid runs a block's width
 * clear on every side and is gone by two more, which puts the falloff where the
 * eye is already looking.
 *
 * A MULTIPLE RATHER THAN A DISTANCE, because the stock runs from a millimetre
 * to five metres and the frame does not refit itself -- see `OPENING_FRAME`. A
 * fixed reach would be a sheet of graph paper behind the small end and an
 * invisible speck at the large one. Scaled, the ground is the same picture at
 * every size of block, which is the same bargain `Stage` strikes by ruling two
 * grids instead of one.
 */
const GROUND_REACH = 3

/** The face the screen opens on: Front, square on, which is where the camera
 *  above is standing. */
const FRONT: FaceAxis = { axis: 2, sign: 1 }

/** Decoration, and in the way of the faces it outlines. */
const noRaycast: Object3D['raycast'] = () => {}

/** How hard the offcut glows. Enough to read across a window as "this one",
 *  short of the wash that would hide the cut running down its edge. */
const OFFCUT_GLOW = 0.4

/**
 * Everything on the bed: the block, or the pieces it has been cut into.
 *
 * ON THE GROUND rather than centred in the air, because that is where stock
 * sits -- in this app every solid rests exactly on y = 0, and a laser cutter's
 * bed is the most literal case of it there is. Everything inside the group is
 * in BLOCK SPACE, a unit cube centred on the origin, so the Side field scales
 * the group and touches no geometry: a cut block resized is not re-cut.
 *
 * THE PIECES DO NOT MOVE APART. A cut leaves them exactly where the block was,
 * a kerf's width from each other -- see `laserCut.ts` -- which is what a real
 * cutter leaves and what keeps a part where it was made. What says a cut
 * happened is the OFFCUT, lit in the colour material-being-taken-away wears
 * everywhere else in this app: it names the piece that goes, and it is what
 * Delete acts on.
 *
 * AND WHICH PIECE THAT IS, IS YOURS TO SAY. It opens on the smallest, which is
 * right for most cuts and wrong for exactly the ones that matter most -- free a
 * part from the stock around it and the keeper is the small one. A press on a
 * piece moves the light onto it. Only with a cutter PUT DOWN, because with one
 * in hand a press on the block is the start of a line and there is no way to be
 * both; the panel's Other piece steps the same choice with the tool still in
 * hand, which is where a hand fresh from pressing Apply actually is. See
 * `choices` in `laserStore`.
 *
 * NOTHING ELSE IS CLICKABLE, and a press on a piece the last cut did not make
 * does nothing at all. The offer is about the cut just performed: a sliver from
 * three cuts ago may have been kept on purpose, and a bed where everything can
 * be lit and binned is a selection, which this screen deliberately does not
 * have.
 *
 * Each piece keeps its own outline, so the seam between two of them reads as
 * two edges a hair apart rather than as one line drawn on a solid. The outline
 * is `outlineOf` rather than three's own `EdgesGeometry`, and that is not a
 * preference -- see the note there for what the built-in one draws on a
 * boolean's output.
 */
function Piece({
  piece,
  waste,
  choosable,
}: {
  piece: LaserPiece
  waste: boolean
  choosable: boolean
}) {
  const scene = useSceneColors()
  const reference = useReferencePointer()
  const markOffcut = useLaser((s) => s.markOffcut)
  // Cut once and kept: a piece's geometry never changes after the boolean that
  // made it, so its outline never has to be found twice.
  const outline = useMemo(() => outlineOf(piece.geometry), [piece.geometry])
  useEffect(() => () => outline.dispose(), [outline])

  return (
    <group>
      {/* The material is the block's own, taught to paint reference pictures --
          same colour, same finish, plus a shader that puts whatever drawing is
          stuck to a face ONTO that face. Which is what makes a cut cut the
          drawing too: every piece asks the same question of its own surface,
          so what survives the boolean carries its part of the picture and what
          was removed took its part with it. See `decalMaterial.ts`.

          The pointer handler is the block's as well: a drag out of the panel,
          and a decal being slid or sized, both need a surface wide enough to
          catch a gesture that has run past the picture it started on. */}
      <mesh
        geometry={piece.geometry}
        {...reference}
        // A CLICK, not a press: fiber only calls this when the press and the
        // release both land on this mesh, so an orbit or a pan that happened to
        // start over a piece does not also relight it. It is a left-button
        // event by the browser's own definition, which is the other half of the
        // same guarantee -- see `PanAcrossFace` for what the right button does
        // over this same surface.
        onClick={choosable ? () => markOffcut(piece.id) : undefined}
      >
        <ReferenceMaterial
          color={waste ? scene.in : DEFAULT_OBJECT_COLOR}
          emissive={waste ? scene.in : '#000000'}
          emissiveIntensity={waste ? OFFCUT_GLOW : 0}
        />
      </mesh>
      <lineSegments geometry={outline} raycast={noRaycast}>
        <lineBasicMaterial
          color={waste ? scene.eraseEdge : scene.edgeIdle}
          toneMapped={false}
        />
      </lineSegments>
    </group>
  )
}

function Pieces({ dims }: { dims: [number, number, number] }) {
  const pieces = useLaser((s) => s.pieces)
  const offcut = useLaser((s) => s.offcut)
  const choices = useLaser((s) => s.choices)
  // With a cutter in hand a press on the block starts a line, so the choosing
  // press is only live with the tool put down -- Move counts as put down here,
  // since it takes hold of pictures rather than of the block. See `CutLayer`,
  // which arms its own listeners by the same test.
  const cutting = useTools((s) => isCutTool(s.laserTool))

  return (
    // The block's three sides, as the scale on the unit cube everything inside
    // is built in. Standing on the bed, so the group rises by half its height.
    <group position={[0, dims[1] / 2, 0]} scale={dims}>
      {pieces.map((piece) => (
        <Piece
          key={piece.id}
          piece={piece}
          waste={offcut.includes(piece.id)}
          choosable={
            !cutting &&
            !offcut.includes(piece.id) &&
            choices.some((set) => set.includes(piece.id))
          }
        />
      ))}
    </group>
  )
}

/**
 * Which face is being looked at, published out of the canvas.
 *
 * The compass settles the camera on one of six views and `nearestView` is what
 * decides which -- so the face being drawn on is not a thing to track
 * separately, it is that answer read every frame. Reported only when it
 * changes, because it changes about once a minute and everything downstream of
 * it re-renders.
 *
 * Read from the camera rather than from a settled flag, so it flips at the
 * halfway point of a turn rather than at the end of one. That is the right
 * moment: it is where the user has committed to the new face, and it is when a
 * line drawn on the old one should stop being live.
 */
function FaceWatch({ onFace }: { onFace: (face: FaceAxis) => void }) {
  const camera = useThree((s) => s.camera)
  const showing = useRef<string>('')
  useFrame(() => {
    const view = nearestView(camera.quaternion)
    if (view.key === showing.current) return
    showing.current = view.key
    onFace({ axis: view.axis, sign: view.sign })
  })
  return null
}

/**
 * The controls as this screen holds them: the compass's `Orbit`, and the two
 * fields only a projection has any use for.
 *
 * `Orbit` is the contract the COMPASS needs -- where the camera is aimed, and
 * how to make it so -- and it is deliberately no wider than that, because every
 * screen that mounts a `CompassControl` has to satisfy it. How far a wheel may
 * zoom is not a fact about aiming and belongs to nobody but this screen, so it
 * is added here rather than there.
 */
type LaserOrbit = (NonNullable<Orbit> & { minZoom: number; maxZoom: number }) | null

/**
 * Keeps a fixed slice of the world in the height of the window, and tells the
 * controls how far the wheel may push it.
 *
 * THE ONE JOB A PROJECTION TAKES ON THAT A LENS DID FOR FREE. A perspective
 * camera carries its scale in its field of view, which is an ANGLE: the same
 * camera frames the same world in a window of any size, and the pixels only
 * decide how finely it is drawn. An orthographic one carries it in `zoom`, and
 * react-three-fiber sizes the frustum in pixels -- so a zoom is pixels per world
 * unit, and one that frames the block on a tall window crops it on a short one.
 * See `orthoFrame.ts`.
 *
 * So the zoom is anchored to the canvas, and what is held steady across a resize
 * is the FRAME -- how much world stands in the window -- which is exactly what
 * the fov held steady before: drag the window smaller and the block keeps the
 * share of it that it had, rather than being cropped out of it. What the wheel
 * has done in between is kept, not thrown away: the frame is read back out of
 * the zoom at the height it was set at, and set again at the new one.
 *
 * THE LIMITS RIDE ALONG for the same reason. `minDistance` and `maxDistance` no
 * longer bound the wheel -- three's controls leave an orthographic camera where
 * it stands and scale its zoom instead, clamping that to `minZoom` and
 * `maxZoom` -- so the range has to be restated in zooms, and a zoom means
 * nothing until there is a height to state it against.
 *
 * A LAYOUT effect, not a frame callback and not an ordinary one: this has to be
 * right on the FIRST frame drawn, or the screen opens on one frame of a block
 * either lost in the distance or filling the window, which is a flash the eye
 * catches every time. Fiber does not mount the scene until it has measured the
 * canvas, so there is a real height here by the time this runs -- the guard is
 * for the degenerate window, not for the first pass.
 */
function HoldFrame({ controlsRef }: { controlsRef: RefObject<LaserOrbit> }) {
  const camera = useThree((s) => s.camera)
  const pixels = useThree((s) => s.size.height)
  /** The canvas height the frame was last set against, and the whole of what
   *  makes a resize a rescale rather than a reset. */
  const was = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (!(pixels > 0)) return
    // What is being held: the opening frame the first time, and whatever the
    // wheel has since made of it every time after.
    const frame = was.current === null ? OPENING_FRAME : frameOf(was.current, camera.zoom)
    was.current = pixels
    camera.zoom = zoomFor(pixels, frame)
    camera.updateProjectionMatrix()

    const controls = controlsRef.current
    if (!controls) return
    // The wider frame is the smaller zoom -- pixels over world units, so the two
    // ends swap as they cross the division.
    controls.minZoom = zoomFor(pixels, WIDEST_FRAME)
    controls.maxZoom = zoomFor(pixels, CLOSEST_FRAME)
  }, [camera, controlsRef, pixels])

  return null
}

/**
 * Keeps the camera pointed at the middle of the block as the block changes
 * size.
 *
 * IT HAS TO BE THE MIDDLE, and not the origin, or the screen's one promise
 * breaks. The block stands on the ground, so its centre rises as it grows; a
 * camera left aiming at the world's origin would be looking UP at a tall block,
 * and a view that is looking up at a face is not square on to it however
 * carefully the compass was settled.
 *
 * TRANSLATED, NOT RE-AIMED. Both the camera and the point it orbits move by the
 * same rise, so the direction between them and the distance along it are
 * untouched -- which is the whole of what an axis view is. Re-aiming the camera
 * at a new target instead would tip it by however far the centre had moved, and
 * the settled view would quietly stop being settled.
 *
 * AND TRANSLATED RATHER THAN RESEATED for a second reason now: the pivot is no
 * longer this component's alone. The pan slides it across the face -- see
 * `PanAcrossFace` -- so a resize that put it back on the middle of the block
 * would take the camera's own position with it only halfway, leaving the two
 * out of step and the view tipped off the face. Moving it by the rise leaves
 * whatever has been slid exactly where it was, and the pan's own clamp is what
 * pulls it in if the block it is measured against has shrunk underneath it.
 *
 * The `update` at the end is also what pushes the camera clear of a block that
 * has grown around it -- the controls clamp the orbit radius to their own
 * `minDistance`, which this screen sets from the block's side. See
 * `BLOCK_CLEARANCE`.
 *
 * A LAYOUT EFFECT, for the reason `HoldFrame` is one: this has to be true of
 * the FIRST frame drawn, not of the second.
 *
 * Nothing here aims the camera at the middle of the block until this runs, and
 * two separate things aim it at the world ORIGIN until it does -- fiber points
 * a camera it created with `lookAt(0, 0, 0)`, and the controls open with their
 * pivot there. The origin is on the ground, the camera stands at the height of
 * the block's middle, so a frame drawn before the pivot is seated is pitched
 * DOWN by however tall the block is: the block rides high in the window and the
 * ground, which a level camera sees exactly edge-on and which is the whole of
 * what tells you this screen is square on, is spread out underneath it.
 *
 * An ordinary effect is flushed after the browser has painted, and fiber's loop
 * is already running by then, so that pitched view is what the screen opened
 * on. It is also the frame that costs the most -- a fresh canvas is compiling
 * every shader in the scene -- so it stays up long enough to read, and then the
 * view snaps level. A layout effect runs inside the commit, before any of it.
 */
function FocusOnBlock({
  controlsRef,
  centre,
}: {
  controlsRef: RefObject<Orbit>
  centre: number
}) {
  const camera = useThree((s) => s.camera)
  // Where the middle was last time, so the change can be applied as a rise
  // rather than recomputed from a position the camera may have been dollied to.
  // Null until the first run, which is the one run that has to SEAT the pivot
  // rather than nudge it: the controls open aiming at the origin, and there is
  // no rise from there to the middle of the block -- the camera is already
  // standing at that height. See `LASER_CAMERA`.
  const was = useRef<number | null>(null)

  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (was.current === null) controls?.target.set(0, centre, 0)
    else {
      const rise = centre - was.current
      controls?.target.setY(controls.target.y + rise)
      camera.position.y += rise
    }
    was.current = centre
    controls?.update()
  }, [camera, controlsRef, centre])

  return null
}

/**
 * Slides the view across the face, and will not let it off.
 *
 * THE WHEEL ON ITS OWN IS HALF A CAMERA HERE. A projection cannot be walked
 * closer, so zooming in on a face magnifies it about the middle of the window
 * and carries its edges out past the rim -- and the edges are exactly where a
 * cut has to be aimed. The pan is what reaches them. It is on the RIGHT button,
 * which is the one button on this screen that was doing nothing: the left draws
 * and the middle orbits. See the controls below.
 *
 * BOUNDED TO THE FACE, and that is `facePan`'s arithmetic rather than this
 * component's -- what is here is only the applying of it. The middle of the
 * window may travel as far as the edge of the face and no further, so every
 * corner of a face can be brought to the middle at any zoom and the block can
 * never be slid off the screen and lost.
 *
 * AFTER THE CONTROLS, DELIBERATELY. Drei runs `update` at priority -1 and this
 * is left at the default, so every frame the controls have already applied
 * whatever the hand asked for by the time the clamp reads it. Correcting a pan
 * that has been made is the only way to bound one: three's controls take a
 * radius around a point, which is a disc, and a face is a rectangle.
 *
 * BOTH THE PIVOT AND THE CAMERA MOVE, by the same correction. The controls
 * rebuild the camera's position from the target and the orbit every update, so
 * moving both leaves that relationship untouched -- which is the whole of what
 * keeps the view square on while it is being carried sideways. Moving only the
 * target would work too, and would show a frame of tipped view before the next
 * update put it right.
 *
 * A FACE CHANGE PUTS IT BACK. The pan belongs to the face it was made on: it is
 * measured from the middle of a face, in the plane of that face, and the same
 * numbers mean something else on the next one. So switching faces clamps
 * against nothing for one frame, which walks the view home by the same path a
 * limit does. It fires at the halfway point of a turn, where `FaceWatch`
 * reports the change -- by which time the camera is swinging anyway and there
 * is nothing to see.
 */
function PanAcrossFace({
  controlsRef,
  dims,
  centre,
  face,
}: {
  controlsRef: RefObject<Orbit>
  dims: [number, number, number]
  centre: number
  face: FaceAxis
}) {
  const camera = useThree((s) => s.camera)
  /** Set by a face change, spent on the next frame. */
  const home = useRef(false)

  useEffect(() => {
    home.current = true
  }, [face.axis, face.sign])

  useFrame(() => {
    const controls = controlsRef.current
    if (!controls) return

    const limits = home.current ? NO_PAN : panLimits(face.axis, dims)
    home.current = false

    const target = controls.target
    const [dx, dy, dz] = panCorrection([target.x, target.y, target.z], [0, centre, 0], limits)
    if (dx === 0 && dy === 0 && dz === 0) return

    // The same delta into both, which is the whole of what keeps the view
    // square on -- see `panCorrection`.
    target.set(target.x + dx, target.y + dy, target.z + dz)
    camera.position.set(
      camera.position.x + dx,
      camera.position.y + dy,
      camera.position.z + dz
    )
  })

  return null
}

export function LaserViewport() {
  const controlsRef = useRef<LaserOrbit>(null)
  const dims = useLaser((s) => s.dims)
  // How far out the camera has to stay to clear the biggest side of it.
  const widest = Math.max(dims[0], dims[1], dims[2])
  const tool = useTools((s) => s.laserTool)
  const offcut = useLaser((s) => s.offcut)
  /** Whether a reference slot is lit -- which is what Move's handles hang on. */
  const lit = useReference((s) => s.highlightId !== null)
  const [face, setFace] = useState<FaceAxis>(FRONT)

  /**
   * The three keys this screen answers, and its own listener to answer them
   * with.
   *
   * Its own rather than a shared one, because it is the arrangement both other
   * screens already have: `Viewport` owns the modelling keys and `LatheViewport`
   * the lathe's, and only the screen on show is mounted, so no two can fight
   * over a press.
   *
   * DELETE takes whatever is HIGHLIGHTED, which is the same rule the modelling
   * screen's Delete follows: the thing wearing the highlight is the thing the
   * key acts on. Two things here can wear one, so they are answered in the
   * order they were taken hold of -- a lit reference slot is a picture in hand
   * and goes first, taking that drawing off every face it is on; with nothing
   * lit the key means the offcut, as it always has.
   *
   * ESCAPE puts the drawing down without putting the tool down -- "put that
   * down" is what Escape has always meant in this app, and here the thing in
   * hand is a line, or a picture whose slot is lit.
   *
   * CTRL+Z walks the cuts. The bar's two buttons call the same store; these are
   * the chord, for a hand that is already on the block.
   *
   * None of them fire while the caret is in a number field: the Side box is a
   * window away from the bed, and undoing a cut because somebody corrected a
   * typo would be the surprise that stops the screen being trusted.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, [contenteditable="true"]')) return

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        const laser = useLaser.getState()
        if (e.shiftKey) laser.redo()
        else laser.undo()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // A LIT SLOT COMES FIRST. Delete has always thrown the offcut away, and
        // it still does with nothing lit -- but a lit slot is a picture in
        // hand, and the thing in hand is what a key acts on. It takes every
        // copy of that drawing off the block and leaves the picture in the
        // panel, which is the one way off a face short of deleting the file.
        const reference = useReference.getState()
        const lit = reference.highlightId
        const on = lit ? visiblePlacements(reference).some((p) => p.imageId === lit) : false
        if (lit && on) reference.clearPlacementsOf(lit)
        else useLaser.getState().discardOffcut()
      } else if (e.key === 'Escape') {
        // "Put that down", for both things that can be in hand: the line being
        // drawn, and the picture whose slot is lit.
        useCutDraft.getState().clear()
        useReference.getState().highlight(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * A CUTTER TAKEN UP PUTS THE LIGHT OUT.
   *
   * The lit slot is what arms the handles and what Delete acts on, and neither
   * of those is a thing you want while a beam is in hand: the grips would sit
   * on the face where the line has to be started, and Delete would take a
   * drawing off instead of throwing the offcut away. So picking up Freehand or
   * Point Cut clears it -- which leaves the picture exactly as it was and only
   * takes the furniture off it.
   *
   * Here rather than in `setLaserTool`, because the rule is about this screen
   * rather than about the tool store, and because the tool can be changed from
   * the island, from the panel and from a drag out of the shelf -- one effect
   * on the tool covers all three.
   */
  useEffect(() => {
    if (isCutTool(tool)) useReference.getState().highlight(null)
  }, [tool])

  // A crosshair while a CUTTER is in hand, on the wrapper rather than the
  // canvas so it also covers the chrome the pointer crosses on the way -- the
  // same arrangement the modelling brushes and the lathe's tools have. Move
  // gets an open hand instead: it aims at nothing, it takes hold of things.
  const armed = isCutTool(tool)
  const moving = tool === 'move'
  const aiming = tool === 'symmetry'

  return (
    <div className={`viewport laser${armed ? ' laser-armed' : ''}${moving ? ' laser-moving' : ''}`}>
      <Canvas
        // ORTHOGRAPHIC, which is the half of this screen's camera the compass
        // does not own -- see the head of the file for what a lens was costing
        // a screen that projects pictures onto faces and then cuts them.
        // `HoldFrame` is what makes the projection frame anything at all.
        orthographic
        camera={LASER_CAMERA}
        // AND NO LOG DEPTH BUFFER, which both other screens take. Under a
        // projection three stands its own log depth down: the vertex chunk sets
        // `vIsPerspective` from `isPerspectiveMatrix( projectionMatrix )`, and
        // the fragment one writes plain `gl_FragCoord.z` when that is zero. So
        // the flag cannot do the job it does next door -- all it would buy is a
        // `gl_FragDepth` write per fragment, and the early-Z that write costs,
        // to arrive at the number the hardware already had.
        //
        // Nothing is given up with it. The reason the other screens need it is
        // that a 200,000:1 frustum is hopeless under a PERSPECTIVE division,
        // which spends most of the buffer in the first inch past the near
        // plane. A projection's depth is linear, so the same frustum spreads
        // evenly across it: a step of about six microns, against a kerf of
        // three tenths of a millimetre. See `Viewport` for the case that does
        // need it, and `depthBias.ts` for what a log buffer costs elsewhere.
        dpr={[1, 2]}
      >
        {/* The room, with its ground cut down to the bed -- see `GROUND_REACH`
            for why the one screen that does not travel is the one that asks for
            the smallest patch of floor. */}
        <Stage reach={Math.max(...dims) * GROUND_REACH} />
        <Pieces dims={dims} />

        {/* ORBIT ON THE MIDDLE BUTTON, exactly where the modelling screen puts
            it, and nowhere else. The left button DRAWS here -- that is the
            whole screen -- so it cannot also be a camera, which is why there is
            no Alt+left fallback to match the other screen's.

            AND PAN ON THE RIGHT, which used to be the button that did nothing.
            It is not a convenience: a projection cannot be walked closer, so
            the wheel magnifies about the middle of the window and carries the
            edges of the face -- where a cut is aimed -- out past the rim. The
            pan is what reaches them, and it is bounded to the face it is
            crossing so the block can never be slid off the screen. See
            `PanAcrossFace`, which is what bounds it: `enablePan` here only
            gives the gesture a button.

            The buttons are a static map rather than the modelling screen's
            re-armed-per-press one, because none of it is conditional here --
            there is no modifier to read and no second gesture competing for a
            button.

            The wheel is left alone, as it always was: zooming does not tip the
            camera off the axis the compass put it on, and the block runs from a
            millimetre to five metres. What it MEANS moved with the camera --
            three's controls leave an orthographic camera standing where it is
            and scale its zoom instead -- so the range it obeys is stated in
            zooms rather than in distances, and it is `HoldFrame` that states
            it, since a zoom is only a scale once there is a canvas to measure
            it against. */}
        <OrbitControls
          ref={controlsRef as never}
          makeDefault
          enableDamping
          dampingFactor={0.12}
          // `undefined`, not a "none" value -- OrbitControls has no such
          // constant. Its button switch falls through to `STATE.NONE` for
          // anything it does not recognise, which is what leaves the left
          // button free to draw and the right doing nothing at all.
          mouseButtons={{ LEFT: undefined, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN }}
          // In the plane of the screen rather than of the ground, which square
          // on to a face is the plane of the FACE -- so up on a side view is up
          // the block rather than back along the bed. Three's own default, said
          // out loud because the whole of the clamp next door assumes it.
          screenSpacePanning
          // WHERE THE CAMERA STANDS, which is no longer where the wheel puts
          // it: these bound the orbit radius, and under a projection the only
          // thing left that moves it is a block growing around it. The room's
          // floor, or clear of the block, whichever is further out -- see
          // `BLOCK_CLEARANCE`.
          minDistance={Math.max(STAGE_MIN_DISTANCE, widest * BLOCK_CLEARANCE)}
          maxDistance={STAGE_MAX_DISTANCE}
        />

        {/* Inside the canvas because it is the camera it flies. What it draws
            is a canvas of its own, outside -- see `AxisCompass`. `settle` is
            what makes this screen's camera come to rest on an axis every time
            the hand comes off the compass. */}
        <CompassControl controlsRef={controlsRef} settle />
        <FocusOnBlock controlsRef={controlsRef} centre={dims[1] / 2} />

        {/* What keeps the right button from carrying the view off the block,
            and what puts it back on the middle when the compass lands on
            another face. After `FocusOnBlock`, whose pivot it measures from. */}
        <PanAcrossFace
          controlsRef={controlsRef}
          dims={dims}
          centre={dims[1] / 2}
          face={face}
        />

        {/* What the fov used to do for nothing: hold the scale. Inside the
            canvas because the canvas is the only thing that knows how tall it
            is, and after the controls so their ref is in hand by the time it
            hands them the zooms they may clamp to. */}
        <HoldFrame controlsRef={controlsRef} />
        <FaceWatch onFace={setFace} />

        {/* The line being drawn, and the pointer work that puts it there. It
            draws nothing with no tool in hand. See `CutLayer`. */}
        <CutLayer face={face} dims={dims} />

        {/* The mirror standing on the face, if one is: the axis, the parts it
            cuts the face into, and the hand that swings it. Its wash goes under
            the drawing and over the block, so a line already drawn in a part
            you have since dimmed is still visible -- it is still the line you
            are about to lose. Unlike the cut layer it does not come and go with
            the tool: an axis stands until it is taken away. See `MirrorLayer`,
            and `LaserTool` for why aiming it puts the cutter down. */}
        <MirrorLayer face={face} dims={dims} />

        {/* What is drawn ON the block for each reference: an outline always,
            and with Move in hand four corners to pull. Inside the canvas
            because they are objects on the faces rather than chrome over them,
            and after the cut layer so a handle never sits between the pointer
            and a line being drawn. See `ReferenceDecals`. */}
        <ReferenceHandles />
      </Canvas>

      {/* The one way to turn the view, in the corner it has on the modelling
          screen. It is a bigger part of this screen than of that one: there,
          it is a readout you can also click; here, it is the camera control. */}
      <AxisCompass />

      {/* The way off this screen, docked against the compass rather than given
          a corner of its own. The lathe's copy button HAS that corner because
          the lathe has no compass to want it -- here it does, and a button on
          the far side of the window from its twin would be a button the user
          has to go looking for. Beside the compass it is still the top right,
          still the end of the sitting, and still nowhere near the hand that is
          cutting. See `CopyBlockButton`. */}
      <CopyBlockButton />

      {/* THE BOTTOM-LEFT SHELF: the facts about the job rather than about the
          scene. The block is set once at the start and sits at the foot of it,
          where the lathe keeps its lump; the cut panel appears above it for as
          long as a cutter is in hand and goes when the hands are empty.

          A COLUMN RATHER THAN TWO CORNERS, because the block panel collapses --
          so anything placed above it by a fixed offset would leave a gap when
          it shut and sit on top of it when it opened. The flex gap is the one
          number, and neither panel has to know the other's height. */}
      <div className="laser-corner">
        {/* Above the cut, because it governs it: the mirror is set up once and
            then every line drawn under it is reflected. It stands as long as
            the AXIS does rather than as long as a tool is held -- see
            `SymmetryPanel`. */}
        <SymmetryPanel face={face} />
        <CutPanel />
        <BlockPanel />
      </div>

      {/* The reference editor: a screen over the whole app while it is open,
          and nothing at all while it is not. It belongs to this screen because
          the panel that opens it does -- see `ReferencePanel`. */}
      <ReferenceEditor />

      {/* ONE HINT AT A TIME, and a chain rather than four conditions because
          they can all be true at once and the answer is not "show them all".
          They used to be mutually exclusive: a lit offcut only ever appeared
          with a cutter in hand, so the tool-less and Move hints could not
          collide with it. Choosing a piece is done with the tool PUT DOWN, so
          now they can -- and stacked, two hints in one corner read as neither.

          A LIT PIECE COMES FIRST, because it is the one that is about something
          that has just happened rather than about something you might do. */}
      {offcut.length > 0 ? (
        <p className="viewport-hint">
          {/* What to do about it, and the half of that which is reachable
              depends on what is in your hand: the click is the direct way and
              is shut off while a cutter is armed, because a press on the block
              is the start of a line. The panel's step is open either way, and
              is what a hand fresh from Apply is already resting on. */}
          {offcut.length > 1 ? 'The lit pieces are one piece of work' : 'The lit piece is the one'}{' '}
          <b>Del</b> throws {offcut.length > 1 ? 'them all away' : 'away'}.{' '}
          {armed ? (
            <>
              <b>Other piece</b> lights the next.
            </>
          ) : (
            <>
              <b>Click</b> another to change it.
            </>
          )}
        </p>
      ) : aiming ? (
        /* Symmetry in hand, which is the one tool here whose two gestures are
           not guessable from the screen: the line is plainly draggable, and
           nothing says that pressing a dimmed part of the face brings it over
           to your side of the mirror. */
        <p className="viewport-hint">
          <b>Drag</b> the green line to swing it, <b>click</b> a part of the face to work in it
        </p>
      ) : tool === null ? (
        /* Empty hands, and the one thing to say about it -- the lathe's own
           hint, in the same place, saying the same kind of thing. It goes the
           moment a tool is taken up. */
        <p className="viewport-hint">
          Take up <b>Freehand</b> or <b>Point Cut</b>, then draw across the face
        </p>
      ) : moving && !lit ? (
        /* And the same for Move, which needs it more: the handles it puts on
           the pictures are the only sign it is in hand, and on a face you have
           turned away from there are none.

           TWO OF THEM, because Move has two states. The handles belong to the
           lit slot, so a hand holding Move over an unlit block would otherwise
           find the tool inert with nothing on screen saying why. */
        <p className="viewport-hint">
          Click a reference in the <b>panel</b> to take hold of the copies on the block
        </p>
      ) : moving && lit ? (
        <p className="viewport-hint">
          Drag it to slide, pull a <b>corner</b> to size, <b>Del</b> takes it off the block
        </p>
      ) : null}

      {/* The island every screen carries. It drags to the same corners and
          remembers the one it was left in, because where your hand likes the
          tools is a fact about you rather than about which screen you are on.

          MOVE FIRST, THEN SYMMETRY, THEN A RULE. Move is what a hand reaches
          for between cuts -- lay the references down, then burn to them -- so
          it stands at the head of the island where it is found without
          hunting. Symmetry follows it because the two are the same kind of
          thing: neither burns anything, and each takes hold of something that
          is not the block -- a picture, and a mirror. The rule sits under the
          pair, which is exactly what a rule is for saying. Freehand and Point
          Cut are one kind of thing twice over -- two ways of putting a line on
          a face, sharing every step after the line exists -- so nothing stands
          between THEM. See `LaserTools`. */}
      <IslandShell>
        <MoveRefTool />
        <SymmetryTool face={face} />
        <div className="island-rule" aria-hidden />
        <FreehandTool />
        <PointCutTool />
      </IslandShell>
    </div>
  )
}
