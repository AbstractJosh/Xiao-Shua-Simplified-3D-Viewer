import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry } from 'three'
import type { Object3D } from 'three'
import { BLOCK_HALF, faceBasis, faceToBlock } from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'
import {
  axisFrame,
  partOf,
  partPolygon,
  partsIn,
  snapAxisAngle,
} from '../geometry/faceMirror'
import { mirrorOn, useTools } from '../store/toolStore'
import { GRAB_PX, stalk } from './CutLayer'
import { LIFT, facePixels, pointerToFace } from './facePointer'
import { useSceneColors } from './useSceneColors'

/**
 * THE MIRROR ON THE FACE: the green line through the middle of it, the parts it
 * cuts the face into, and the hand that swings it.
 *
 * A LAYER OF ITS OWN BESIDE `CutLayer` RATHER THAN A PIECE OF IT, and the
 * reason is the one fact that decides everything about this tool: the axis
 * outlives the hand holding it. `CutLayer` draws nothing at all with no cutter
 * in hand -- it is the line you are drawing -- and this has to go on standing
 * through every one of those states, because a mirror that vanished when you
 * picked up a cutter would be a mirror you could never cut with. It is a guide
 * on the block, like a ruler in a scene, not a drawing in progress.
 *
 * WHAT IT DRAWS. The axis itself, run right out past the edges of the window so
 * it reads as a plane the block is standing in rather than as a line lying on
 * it; and a wash over every part of the face that is NOT being worked in, which
 * is the whole of how the tool says where you may draw. The lit part is left
 * exactly as it was -- dimming three quarters is quieter than lighting one, and
 * the thing you are about to draw on should be the thing wearing no film.
 *
 * WHAT IT READS. Only with Symmetry in hand, and then two gestures: a press
 * within reach of the line swings it, and a press anywhere else picks the part
 * under the pointer. Both are a left press on the face, which is exactly why
 * holding this tool puts the cutter down -- see `LaserTool`.
 */

/**
 * How far past the middle of the face the axis is drawn, in face coordinates.
 *
 * TEN BLOCKS EITHER WAY, which is far more than a line needs and is the point:
 * the axis has to leave the window at every zoom the wheel reaches, so that it
 * reads as something the block is standing in rather than as a stick lying on
 * the face with two ends the eye starts hunting for. Two vertices, whatever the
 * number, so the extravagance costs nothing.
 */
const AXIS_REACH = 10

/** Decoration; nothing here is picked by the renderer -- `MirrorLayer` does its
 *  own hit testing against the face plane, exactly as `CutLayer` does. */
const noRaycast: Object3D['raycast'] = () => {}

/** How near the middle a press has to land before it is too close to say which
 *  way it points, in face coordinates. Under this the swing starts from the
 *  angle the axis already has rather than from a direction read off nothing. */
const DEAD_CENTRE = 0.01

/** A convex face polygon, fanned into triangles and lifted onto the face. */
function sheet(poly: Pt[], face: FaceAxis, depth: number): BufferGeometry | null {
  if (poly.length < 3) return null
  const basis = faceBasis(face)
  const at = (p: Pt) => faceToBlock(basis, p, depth)
  const positions: number[] = []
  const first = at(poly[0])
  for (let i = 1; i < poly.length - 1; i += 1) {
    for (const v of [first, at(poly[i]), at(poly[i + 1])]) positions.push(v.x, v.y, v.z)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  return geometry
}

export function MirrorLayer({
  face,
  dims,
}: {
  face: FaceAxis
  dims: [number, number, number]
}) {
  const scene = useSceneColors()
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const mirror = useTools(mirrorOn(face))
  const aiming = useTools((s) => s.laserTool === 'symmetry')

  /**
   * The two ends of each arm, in face coordinates: one arm for a mirror and two
   * for a cross.
   *
   * The cross's second arm is the first one turned a right angle, which is what
   * makes it a `+` rather than a pair of lines that can drift apart. There is
   * one angle in the store and both arms are read off it, so there is no state
   * in which they are not square to each other.
   */
  const arms = useMemo(() => {
    if (!mirror) return []
    const frame = axisFrame(mirror.angle)
    const ends = (dir: Pt): [Pt, Pt] => [
      [-dir[0] * AXIS_REACH, -dir[1] * AXIS_REACH],
      [dir[0] * AXIS_REACH, dir[1] * AXIS_REACH],
    ]
    return mirror.mode === 'line'
      ? [ends(frame.along)]
      : [ends(frame.along), ends(frame.across)]
  }, [mirror])

  /** The film over every part that is not being worked in. */
  const shade = useMemo(() => {
    if (!mirror) return []
    const out: BufferGeometry[] = []
    for (let part = 0; part < partsIn(mirror.mode); part += 1) {
      if (part === mirror.part) continue
      const poly = partPolygon(mirror, part, BLOCK_HALF)
      const geometry = sheet(poly, face, BLOCK_HALF + LIFT / 2)
      if (geometry) out.push(geometry)
    }
    return out
  }, [mirror, face])
  useEffect(() => () => shade.forEach((one) => one.dispose()), [shade])

  /**
   * The two gestures, on the canvas rather than on a mesh.
   *
   * THE MIRROR IS READ FRESH INSIDE EVERY LISTENER, never captured, and this
   * effect deliberately does not depend on it. Swinging the axis writes the
   * angle on every pointer move; an effect that re-ran on the angle would tear
   * its own listeners down mid-swing and drop the gesture it was in the middle
   * of. The same bargain `CutLayer` strikes with the wheel, for the same
   * reason.
   */
  useEffect(() => {
    if (!aiming) return
    const el = gl.domElement
    /** The angle the axis had, less the angle the press was at: what keeps the
     *  line under the pointer as it swings rather than jumping to meet it. */
    let offset: number | null = null

    const angleAt = (at: Pt): number => (Math.atan2(at[1], at[0]) * 180) / Math.PI

    /** Whether a press is near enough an arm to take hold of it, in pixels. */
    const onArm = (at: Pt): boolean => {
      const held = mirrorOn(face)(useTools.getState())
      if (!held) return false
      const frame = axisFrame(held.angle)
      // Distance from an arm is measured ACROSS it, so the reach is converted
      // to pixels along that same direction -- which is what keeps the grab the
      // same size under the finger on stock that is not a cube.
      const reaches: [number, Pt][] = [
        [Math.abs(at[0] * frame.across[0] + at[1] * frame.across[1]), frame.across],
      ]
      if (held.mode === 'cross') {
        reaches.push([
          Math.abs(at[0] * frame.along[0] + at[1] * frame.along[1]),
          frame.along,
        ])
      }
      return reaches.some(
        ([off, dir]) => facePixels(off, dir, face, dims, camera.zoom) <= GRAB_PX
      )
    }

    const onDown = (e: PointerEvent) => {
      // Left button only. The wheel zooms and the right button pans, the way
      // they do everywhere else over this viewport.
      if (e.button !== 0) return
      const at = pointerToFace(e, camera, el, face, dims)
      if (!at) return
      const held = mirrorOn(face)(useTools.getState())
      if (!held) return

      if (onArm(at)) {
        // A press right on the middle points nowhere, so the swing starts from
        // where the axis already is rather than from a direction read off two
        // zeroes.
        offset = Math.hypot(at[0], at[1]) < DEAD_CENTRE ? 0 : held.angle - angleAt(at)
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      } else {
        // Anywhere else names the part under it. On pointer-down rather than on
        // release, because it is a pick rather than a drag and there is nothing
        // it could turn into.
        useTools.getState().aimMirror(face, { part: partOf(at, held) })
      }
      e.preventDefault()
      // The press is this tool's own, so it stops here: without it the bar
      // would shut whatever panel is open on it, which is the trap `CutPanel`
      // was written to record.
      e.stopPropagation()
    }

    const onMove = (e: PointerEvent) => {
      if (offset === null) return
      const at = pointerToFace(e, camera, el, face, dims)
      if (!at) return
      const tools = useTools.getState()
      // SNAPPING OFF MEANS NO STOPS AT ALL, handed on as a tolerance of zero
      // rather than tested here: the bar's switch governs every snap in the
      // app, and this is that switch reaching one more of them.
      const tolerance = tools.snap ? tools.mirrorSnapAngle : 0
      tools.aimMirror(face, { angle: snapAxisAngle(angleAt(at) + offset, tolerance) })
    }

    const onUp = () => {
      offset = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    el.addEventListener('pointerdown', onDown)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      onUp()
    }
  }, [aiming, gl, camera, face.axis, face.sign, dims])

  if (!mirror) return null
  const basis = faceBasis(face)

  return (
    // The block's own transform, so block-space marks land on the block --
    // the same group `CutLayer` and `Pieces` draw inside.
    <group position={[0, dims[1] / 2, 0]} scale={dims}>
      {/* The parts that are not being worked in, washed toward the ground
          colour. UNDER the drawing and over the block: a line already drawn in
          a part you have since dimmed should still be visible, because it is
          still the line you are about to lose. */}
      {shade.map((one, i) => (
        <mesh key={i} geometry={one} raycast={noRaycast} renderOrder={1}>
          <meshBasicMaterial
            color={scene.bg}
            opacity={0.62}
            transparent
            toneMapped={false}
            depthTest={false}
          />
        </mesh>
      ))}

      {/* And the axis, in its own colour: not the erase red every mark that
          becomes a cut wears, because this one never becomes anything. It is
          the only line on the block that burns nothing. */}
      {arms.map((ends, i) => (
        <lineSegments
          key={i}
          raycast={noRaycast}
          renderOrder={2}
          geometry={stalk(
            faceToBlock(basis, ends[0], BLOCK_HALF + LIFT),
            faceToBlock(basis, ends[1], BLOCK_HALF + LIFT)
          )}
        >
          <lineBasicMaterial color={scene.mirror} toneMapped={false} depthTest={false} />
        </lineSegments>
      ))}
    </group>
  )
}
