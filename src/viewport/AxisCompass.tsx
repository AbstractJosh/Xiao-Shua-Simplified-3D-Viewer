import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three'
import type { Object3D, OrthographicCamera } from 'three'
import { AXIS_COLORS } from './axisColors'
import {
  COMPASS_VIEWS,
  askForView,
  compass,
  orbitPosition,
  takeRequest,
  viewQuaternion,
} from './compassViews'
import type { CompassView } from './compassViews'

/**
 * The compass in the top-right corner: the world's three axes as the camera
 * currently sees them, springing from the corner of a cube that stands where
 * they cross, and a click on any of it flies the camera round to look from
 * there.
 *
 * It answers the one question an orbit camera keeps raising -- which way am I
 * facing -- and it answers it in the two vocabularies the app already uses. The
 * balls carry X, Y and Z, matching the gizmo's arrows down to the colour. The
 * cube carries Top, Front, Right and their opposites, because a face of a box
 * is a thing a modeller names rather than a component of a vector, and a cube
 * lettered X/Y/Z would only be saying what the balls already say.
 *
 * IT IS ITS OWN CANVAS, and that is the decision worth writing down.
 *
 * The alternative -- drawing it into a corner of the main canvas, as drei's
 * `GizmoHelper` does -- means taking over the render loop (its `Hud` renders
 * the whole scene itself, so it can clear the depth buffer and lay a second
 * pass over the top) and sharing the main camera's perspective projection,
 * which shears anything sitting out at the edge of a 45-degree frustum. A
 * compass is exactly the object that must NOT shear: the whole of what it says
 * is angles.
 *
 * A second canvas gets an orthographic camera of its own for nothing, leaves
 * the scene's rendering untouched, and -- the part that pays for the extra
 * context -- it is a separate DOM element, so a press on it is not a press on
 * the viewport. The selection box, the gizmo handles, OrbitControls and
 * `onPointerMissed` never see these clicks, and not one of them needed a clause
 * added to ignore them.
 *
 * What passes between the two canvases is `compass`, one mutable object: the
 * scene writes the camera's orientation into it every frame, the compass reads
 * it to turn itself, and a click leaves a request there for the scene to pick
 * up. The same shape as `rotationIndicator`, for the same reason -- a value
 * that changes sixty times a second has no business in a store.
 */

/** How far out the widget draws, in its own units. The canvas is fitted to
 *  this, so everything below is a fraction of the corner it occupies. */
const HALF_SPAN = 2.0

const CUBE = 1.0
/**
 * The cube stands CORNER-ON at the middle of the compass: one vertex sits
 * exactly where the three axes cross, and the block stands forward from it
 * into the positive octant -- the octant the three lettered axes run into.
 *
 * Centred, the axes left through the middles of its faces, and the balls -- the
 * part of the compass actually aimed at -- were the far ends of three lines
 * that began somewhere hidden inside it. Set on this corner instead, each axis
 * runs out along an EDGE of the cube and its ball sits just past the corner
 * that edge ends at, which is what makes the two halves read as one object: a
 * solid seen from a direction, with the direction marked on it.
 *
 * It is the far vertex from any camera looking down the positive octant, so the
 * block recedes from the crossing rather than standing over it, and the three
 * faces carrying the names are the three that face the viewer whenever the
 * balls do.
 */
const CUBE_AT = new Vector3(CUBE / 2, CUBE / 2, CUBE / 2)
/** Where the balls sit, measured from that crossing -- the same in all six
 *  directions, which is what keeps the thing a compass rather than a diagram of
 *  a cube. */
const HEAD_AT = 1.6
/** A lettered ball, and the bare stub that marks a negative direction. The stub
 *  is smaller and quieter on purpose: it is the same axis seen from behind, not
 *  a fourth direction. */
const HEAD = 0.62
const STUB = 0.34
const HOVER_GROW = 1.18

const STALK_RADIUS = 0.035

/**
 * The cube's faces, lit as the scene's own key light would light them -- from
 * above, in front, and to the right.
 *
 * Constant per face rather than computed from a lamp, because the cube turns
 * WITH the world: a fixed brightness per face is exactly what a fixed light in
 * the world looks like. It costs no lights, no normals and no second guess
 * about tone mapping. In `BoxGeometry`'s material order: +X, -X, +Y, -Y, +Z, -Z.
 */
const FACE_SHADE = [0.8, 0.5, 1.0, 0.44, 0.72, 0.5]
const FACE_BASE = '#e6ecf5'
const FACE_TEXT = '#11151b'
/** styles.css --accent, which a material cannot read for itself. */
const FACE_HOT = '#59a5ff'
const EDGE_COLOR = '#0e1013'

/** Letters are cut out of the ball in the app's own background colour rather
 *  than laid on in white: the three axis colours are fully saturated, and a
 *  white glyph on the green one is barely a glyph at all. */
const HEAD_TEXT = '#0e1013'

const TEXTURE_PX = 128

/**
 * One canvas per distinct ball and face, drawn on first use and kept.
 *
 * There are nine in all and none of them ever changes, while `CanvasTexture`
 * costs a fresh GPU upload every time one is constructed -- so building them
 * per render would be pure waste. Built lazily rather than at module scope so
 * that importing this file outside a browser, which the check suite does when
 * it reaches for the view maths next door, does not go looking for `document`.
 */
const textures = new Map<string, CanvasTexture>()

function drawnTexture(
  key: string,
  paint: (ctx: CanvasRenderingContext2D, px: number) => void
): CanvasTexture {
  const cached = textures.get(key)
  if (cached) return cached

  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_PX
  canvas.height = TEXTURE_PX
  const ctx = canvas.getContext('2d')
  if (ctx) paint(ctx, TEXTURE_PX)
  const texture = new CanvasTexture(canvas)
  // A 2D canvas holds sRGB, and a texture that does not say so is taken for
  // raw linear data and comes out washed pale. It matters more here than it
  // usually would: the whole claim of the balls is that their red, green and
  // blue are the SAME red, green and blue the gizmo's arrows carry, and a
  // colour that has been through the wrong conversion is merely similar.
  texture.colorSpace = SRGBColorSpace
  textures.set(key, texture)
  return texture
}

/** A ball: a filled disc in the axis colour with its letter cut out of it, or,
 *  for a negative direction, a dim ring. */
function headTexture(color: string, letter: string | null): CanvasTexture {
  return drawnTexture(`head|${color}|${letter ?? ''}`, (ctx, px) => {
    const mid = px / 2
    ctx.beginPath()
    ctx.arc(mid, mid, letter ? mid - 6 : mid - 14, 0, Math.PI * 2)
    if (letter) {
      ctx.fillStyle = color
      ctx.fill()
      ctx.font = `600 ${px * 0.5}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = HEAD_TEXT
      ctx.fillText(letter, mid, mid + px * 0.03)
    } else {
      // Filled as well as stroked, faintly. A bare outline reads as a hole cut
      // in the scene behind it; a dim fill reads as the far end of an axis.
      ctx.fillStyle = 'rgba(14, 16, 19, 0.72)'
      ctx.fill()
      ctx.lineWidth = px * 0.09
      ctx.strokeStyle = color
      ctx.stroke()
    }
  })
}

/** A face: its name, on the shade of grey that face stands at. */
function faceTexture(label: string, shade: number): CanvasTexture {
  return drawnTexture(`face|${label}|${shade}`, (ctx, px) => {
    // Dimmed in three's working space rather than by scaling the hex digits, so
    // the steps between faces read as even light rather than as even numbers.
    ctx.fillStyle = new Color(FACE_BASE).multiplyScalar(shade).getStyle()
    ctx.fillRect(0, 0, px, px)
    ctx.font = `500 ${px * 0.2}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = FACE_TEXT
    ctx.fillText(label, px / 2, px / 2)
  })
}

/** Decoration, and in the way of the faces it outlines. */
const noRaycast: Object3D['raycast'] = () => {}

/**
 * The cube, six labelled faces of it, each one a view.
 *
 * Clickable for the same reason it is labelled: a face that says "Top" and does
 * nothing when pressed reads as broken. WHICH face was hit comes from the hit
 * itself -- three fills in the `materialIndex` of the group a triangle came
 * from -- so there are no six meshes and no six hit boxes here, and
 * `COMPASS_VIEWS` is kept in `BoxGeometry`'s material order precisely so that
 * index IS the view.
 */
function ViewCube({ onHot }: { onHot: (hot: boolean) => void }) {
  const [face, setFace] = useState<number | null>(null)
  const geometry = useMemo(() => new BoxGeometry(CUBE, CUBE, CUBE), [])
  useEffect(() => () => geometry.dispose(), [geometry])

  // Tracked on move rather than on over, because the pointer can cross from
  // one face to the next without ever leaving the mesh.
  const over = (e: ThreeEvent<PointerEvent>) => {
    const index = e.face?.materialIndex
    if (index === undefined) return
    setFace(index)
    onHot(true)
  }

  const out = () => {
    setFace(null)
    onHot(false)
  }

  const press = (e: ThreeEvent<MouseEvent>) => {
    const index = e.face?.materialIndex
    const view = index === undefined ? undefined : COMPASS_VIEWS[index]
    if (view) askForView(view.dir)
  }

  return (
    <group position={CUBE_AT}>
      <mesh geometry={geometry} onPointerMove={over} onPointerOut={out} onClick={press}>
        {COMPASS_VIEWS.map((view, index) => (
          <meshBasicMaterial
            key={view.key}
            attach={`material-${index}`}
            map={faceTexture(view.label, FACE_SHADE[index] ?? 1)}
            color={face === index ? FACE_HOT : '#ffffff'}
            toneMapped={false}
          />
        ))}
      </mesh>

      {/* The corners, so the cube keeps its shape against a dark scene. */}
      <lineSegments raycast={noRaycast}>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color={EDGE_COLOR} toneMapped={false} />
      </lineSegments>
    </group>
  )
}

/** One end of one axis: a ball, and for a positive direction the stalk it
 *  stands on. Both answer the same press -- they are one handle drawn in two
 *  parts, and the group carrying the events is what makes them behave as one. */
function AxisHandle({ view, onHot }: { view: CompassView; onHot: (hot: boolean) => void }) {
  const [hovered, setHovered] = useState(false)
  const color = AXIS_COLORS[view.axis]
  const positive = view.sign > 0

  const map = headTexture(color, positive ? view.letter : null)
  const at = useMemo(() => view.dir.clone().multiplyScalar(HEAD_AT), [view.dir])
  // Stood on end along its own axis, running from the cube's corner -- which is
  // the middle of the compass -- out to the back of the ball. All three start
  // at that one point, so they read as three axes crossing rather than as three
  // rods stuck into a block, and the stretch in between lies along an edge of
  // the cube: tinted where that edge can be seen, hidden by the solid where it
  // cannot, which is the depth test saying which corner is nearest.
  const stalk = useMemo(() => {
    const from = 0
    const to = HEAD_AT - HEAD / 2
    return {
      length: to - from,
      at: view.dir.clone().multiplyScalar((from + to) / 2),
      facing: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), view.dir),
    }
  }, [view.dir])

  const size = (positive ? HEAD : STUB) * (hovered ? HOVER_GROW : 1)

  return (
    <group
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        onHot(true)
      }}
      onPointerOut={() => {
        setHovered(false)
        onHot(false)
      }}
      onClick={(e) => {
        e.stopPropagation()
        askForView(view.dir)
      }}
    >
      {positive && (
        <mesh position={stalk.at} quaternion={stalk.facing}>
          <cylinderGeometry args={[STALK_RADIUS, STALK_RADIUS, stalk.length, 6]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      )}

      {/* A sprite, so the ball and its letter face the viewer however the
          compass has turned -- the same reason the turn readout is a DOM node
          rather than text in the scene. Depth-tested but not depth-writing: a
          ball behind the cube is hidden by it, while the transparent corners of
          its own quad hide nothing. */}
      <sprite position={at} scale={[size, size, 1]}>
        <spriteMaterial map={map} transparent depthWrite={false} toneMapped={false} />
      </sprite>
    </group>
  )
}

/**
 * Hold the widget at one size in its own canvas, whatever that canvas measures.
 *
 * An orthographic camera in R3F spans the canvas in PIXELS at zoom 1, so the
 * zoom wanted here is simply pixels per compass unit: half the shorter side,
 * over the half-span the compass draws into. Taken from the live size rather
 * than from the CSS number so the two cannot drift apart.
 */
function FitCompass() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const ortho = camera as OrthographicCamera
    ortho.zoom = Math.min(size.width, size.height) / 2 / HALF_SPAN
    ortho.updateProjectionMatrix()
  }, [camera, size])

  return null
}

/** The world's axes, turned into the main camera's frame. */
function CompassScene({ onHot }: { onHot: (hot: boolean) => void }) {
  const root = useRef<Group>(null)

  useFrame(() => {
    // The inverse of where the camera is looking: a world direction as SEEN
    // from the camera is that direction carried back into the camera's own
    // frame. The compass camera never moves, so this one rotation is the whole
    // of the readout.
    if (root.current) root.current.quaternion.copy(compass.facing).invert()
  })

  return (
    <group ref={root}>
      <ViewCube onHot={onHot} />
      {COMPASS_VIEWS.map((view) => (
        <AxisHandle key={view.key} view={view} onHot={onHot} />
      ))}
    </group>
  )
}

/**
 * How fast the camera swings to a clicked view, in radians per second.
 *
 * A quarter turn -- front to side, the commonest of them -- takes a quarter of
 * a second: fast enough not to be waited on, slow enough to read as a move
 * rather than a cut. A cut would throw away the one thing the compass is for,
 * which is knowing which way round you have ended up.
 */
const TURN_RATE = 2 * Math.PI

/** Near enough to be there. */
const ARRIVED = 1e-3

type Orbit = {
  enabled: boolean
  /** The point the camera orbits, which panning moves. */
  target: Vector3
  update: () => void
} | null

/**
 * The compass's other half, inside the scene: it publishes where the camera is
 * looking, and flies it to whatever the compass asks for.
 *
 * The flight keeps the pivot and the distance the camera already had and
 * changes only the direction it is seen from. Taking both from the controls'
 * own target is what makes it behave after a pan -- the camera orbits that
 * point, not the world's origin, and a flight that ended a fixed distance from
 * the origin would put the user somewhere they had never been.
 *
 * ORIENTATION LEADS AND POSITION FOLLOWS -- `orbitPosition` derives the second
 * from the first -- because OrbitControls has the last word on both. Its own
 * frame callback runs at priority -1, ahead of this one, and it ends every
 * update by pointing the camera at the target using `camera.up`. So the up
 * vector is flown as well: left level, it would drag the camera back upright on
 * the very frame the flight was tipping it over the pole.
 */
export function CompassControl({ controlsRef }: { controlsRef: RefObject<Orbit> }) {
  const flight = useRef<{ to: Quaternion; focus: Vector3; radius: number } | null>(null)

  // Any press in the viewport is the user taking the camera back, so the flight
  // stands down: carried on through an orbit, it would fight the drag for as
  // long as it lasted. Presses on the compass are how flights START, so they
  // are the one place this does not apply.
  useEffect(() => {
    const interrupt = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('.axis-compass')) return
      flight.current = null
    }
    window.addEventListener('pointerdown', interrupt, true)
    return () => window.removeEventListener('pointerdown', interrupt, true)
  }, [])

  useFrame(({ camera }, delta) => {
    compass.facing.copy(camera.quaternion)

    const controls = controlsRef.current
    const asked = takeRequest()
    if (asked) {
      const focus = controls ? controls.target.clone() : new Vector3()
      flight.current = {
        to: viewQuaternion(asked),
        focus,
        radius: camera.position.distanceTo(focus),
      }
    }

    const run = flight.current
    if (!run) return

    const done = camera.quaternion.angleTo(run.to) < ARRIVED
    if (done) camera.quaternion.copy(run.to)
    else camera.quaternion.rotateTowards(run.to, delta * TURN_RATE)

    camera.position.copy(orbitPosition(camera.quaternion, run.focus, run.radius))
    // Rolled with the camera while it flies, then handed back to the world.
    // OrbitControls orbits ABOUT `up`, so leaving it tipped after a top view
    // would spin the whole scene about Z on the next drag. Putting it back
    // costs nothing visible even at the pole, where the controls answer by
    // nudging the camera a millionth of a radian off the axis and pointing it
    // at the target again -- which is the view it is already showing.
    if (done) camera.up.set(0, 1, 0)
    else camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
    controls?.update()

    if (done) flight.current = null
  })

  return null
}

/**
 * The widget itself: a canvas of its own, over the top-right corner of the
 * viewport.
 *
 * The cursor is owned out here rather than inside the canvas, because it
 * belongs to the DOM element -- and because "is the pointer on something" is
 * one answer for the whole compass however many handles have an opinion.
 */
export function AxisCompass() {
  const [hot, setHot] = useState(false)

  return (
    <div className="axis-compass" style={{ cursor: hot ? 'pointer' : 'default' }}>
      <Canvas
        orthographic
        camera={{ position: [0, 0, 10], near: 0.1, far: 100 }}
        dpr={[1, 2]}
        // A press that lands on none of the handles leaves the compass as it
        // was, cursor included: nothing out there is grabbable.
        onPointerMissed={() => setHot(false)}
      >
        <FitCompass />
        <CompassScene onHot={setHot} />
      </Canvas>
    </div>
  )
}
