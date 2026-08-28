import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CircleGeometry, DoubleSide, Group, Mesh } from 'three'
import type { Object3D } from 'three'
import { useSceneColors } from './useSceneColors'
import { rotationIndicator } from './rotationIndicator'

/**
 * The wedge that reads out a ring turn, drawn only while one is running.
 *
 * A number alone does not answer the question a turn actually raises, which is
 * "how far round am I" -- a pie does, at a glance, and keeps its meaning past a
 * full circle where a number in degrees starts needing to be read rather than
 * seen. The exact figure goes in the drag hint alongside it, for the times the
 * answer has to be typed into the panel afterwards.
 *
 * Everything here is imperative. The angle changes on every frame of a drag,
 * and this is one wedge: routing it through React would re-render the scene
 * sixty times a second to rebuild a geometry that has twelve vertices.
 */

/** Sized against the ring it replaces, a shade smaller so it sits inside it. */
const DIAL_RADIUS = 0.23
const SEGMENTS = 64

/** The wedge stops growing here; the readout carries on past it. Beyond a full
 *  turn the pie has nothing left to say -- it is a full disc either way. */
const MAX_SWEEP = Math.PI * 2

/** Decoration. It sits over the very thing being turned. */
const noRaycast: Object3D['raycast'] = () => {}

export function RotationDial() {
  // styles.css --accent, per theme, mirrored in `sceneColors` and guarded by
  // `ui-check` -- a three material cannot read a CSS custom property.
  const scene = useSceneColors()
  const root = useRef<Group>(null)
  const wedge = useRef<Mesh>(null)
  const drawn = useRef(0)

  useFrame(({ camera, size }) => {
    const group = root.current
    const mesh = wedge.current
    if (!group || !mesh) return

    group.visible = rotationIndicator.active
    if (!rotationIndicator.active) return

    group.position.copy(rotationIndicator.centre)
    // The dial lies in the plane the turn was measured in, which is the plane
    // the ring was drawn in when it was grabbed. Held from the grab rather than
    // re-read from the live camera: orbiting mid-turn would otherwise swing the
    // wedge round and make the angle it reports look wrong.
    group.quaternion.copy(rotationIndicator.facing)
    group.scale.setScalar(
      // Clamps widened with the size envelope, at both ends -- see the same
      // pair in `TransformGizmo`.
      Math.max(0.03, Math.min(25, camera.position.distanceTo(group.position) * 0.16))
    )

    // Project the dial's centre so the degree chip can sit beside it. Done here
    // rather than in the readout because this is where the camera is, and it is
    // two multiplies -- far cheaper than lifting a camera out to the DOM layer.
    const ndc = group.position.clone().project(camera)
    rotationIndicator.screen.x = ((ndc.x + 1) / 2) * size.width
    rotationIndicator.screen.y = ((1 - ndc.y) / 2) * size.height

    const swept = rotationIndicator.angle
    // A degree of arc is finer than the wedge can show, so the geometry is only
    // rebuilt when the drawn angle has actually moved -- otherwise a slow drag
    // would allocate a fresh CircleGeometry every frame and leak its buffers.
    if (Math.abs(swept - drawn.current) < 0.005) return
    drawn.current = swept

    const sweep = Math.min(Math.abs(swept), MAX_SWEEP)
    // CircleGeometry measures theta from its own +X, so the wedge is started at
    // the angle the ring was grabbed at and grows the way the pointer went.
    const from = rotationIndicator.startAngle + (swept < 0 ? -sweep : 0)
    mesh.geometry.dispose()
    mesh.geometry = new CircleGeometry(DIAL_RADIUS, SEGMENTS, from, sweep)
  })

  return (
    <group ref={root} visible={false} raycast={noRaycast}>
      <mesh ref={wedge} renderOrder={31} raycast={noRaycast}>
        <circleGeometry args={[DIAL_RADIUS, SEGMENTS, 0, 0]} />
        <meshBasicMaterial
          color={scene.accent}
          transparent
          opacity={0.45}
          side={DoubleSide}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}
