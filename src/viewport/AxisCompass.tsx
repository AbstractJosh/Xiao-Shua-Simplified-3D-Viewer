import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Quaternion,
  SRGBColorSpace,
  Spherical,
  Vector3,
} from 'three'
import type { Object3D, OrthographicCamera } from 'three'
import { AXIS_COLORS } from './axisColors'
import { COMPASS_FACE_SHADE } from './sceneColors'
import { useSceneColors } from './useSceneColors'
import {
  COMPASS_VIEWS,
  POLAR_LIMIT,
  askForTurn,
  askForView,
  compass,
  orbitPosition,
  takeRequest,
  takeTurn,
  turnFromDrag,
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

/* The per-face shading moved to `sceneColors` as COMPASS_FACE_SHADE, where the
   check suite can read it without importing a renderer -- the darkest face is
   the worst case for reading a label, and that is now pinned per theme. */
/* The compass's own colours are per theme and live in `sceneColors`. It is the
   widget that flips hardest between them: `compassFace` is near-white on the
   dark theme and near-black on the light one, because on a pale scene a pale
   cube is a smudge rather than an object.

   `compassInk` is the ground colour, and letters are CUT OUT of a ball in it
   rather than laid on in white -- the three axis colours are fully saturated,
   and a white glyph on the green one is barely a glyph at all. */

/* 256, not the 128 this was. The cube is drawn small -- the whole compass is
   112px and the cube a fraction of that -- but a texture is not sampled at the
   size it is drawn: it is minified through a perspective camera onto a turning
   face, and at 128 the lettering arrived soft, which reads as THIN however heavy
   the weight is set. Nine textures of 256 square is a couple of megabytes and
   they are built once and kept. Everything drawn into them is sized as a
   fraction of this, so raising it changes sharpness and nothing else. */
const TEXTURE_PX = 256

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
function headTexture(
  color: string,
  letter: string | null,
  /** The ground colour a letter is cut out in, and the near-opaque wash behind a
   *  negative direction's ring. Both are per theme, so both are part of the
   *  cache key -- a texture built under one theme must not be handed back under
   *  another, which is exactly what a key of colour-and-letter alone would do. */
  ink: string,
  dim: string
): CanvasTexture {
  return drawnTexture(`head|${color}|${letter ?? ''}|${ink}|${dim}`, (ctx, px) => {
    const mid = px / 2
    ctx.beginPath()
    ctx.arc(mid, mid, letter ? mid - 6 : mid - 14, 0, Math.PI * 2)
    if (letter) {
      ctx.fillStyle = color
      ctx.fill()
      ctx.font = `600 ${px * 0.5}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = ink
      ctx.fillText(letter, mid, mid + px * 0.03)
    } else {
      // Filled as well as stroked, faintly. A bare outline reads as a hole cut
      // in the scene behind it; a dim fill reads as the far end of an axis.
      ctx.fillStyle = dim
      ctx.fill()
      ctx.lineWidth = px * 0.09
      ctx.strokeStyle = color
      ctx.stroke()
    }
  })
}

/** As heavy as the face offers. A system stack rarely ships a true 900, and the
 *  browser picks the nearest weight it has, which is the heaviest one. */
const FACE_TEXT_WEIGHT = 900
const FACE_TEXT_FONT = 'system-ui, sans-serif'
/** The share of the face's width a label spans, corner to corner. */
const FACE_TEXT_FIT = 0.92
/** The tallest a label may be set, as a fraction of the face. Short labels reach
 *  this and stop -- it is what keeps "Top" off the cube's own edges. */
const FACE_TEXT_MAX = 0.52
/** And the shortest. Below this a label is CONDENSED rather than shrunk any
 *  further: six characters across a square face cannot be set at a readable
 *  height any other way, and a narrow "Bottom" beats a tiny one. */
const FACE_TEXT_MIN = 0.38

/**
 * How big one label is set, and the width it may not spill past.
 *
 * PER LABEL, and that is the point of it: every face is set as large as that
 * face can carry, so "Top" is genuinely bigger than "Front" and "Front" than
 * "Bottom". One shared size set by the longest label -- which is what this was
 * -- means every face on the cube is as small as the worst one, and the worst
 * one is a six-letter word.
 *
 * Measured rather than computed from a constant, because a font's advance
 * widths are the browser's business and nothing hard-coded here would survive a
 * different system font. Measured at `px` and scaled, so it is one measurement
 * per label rather than a search.
 *
 * The floor is what makes the long labels work. Fitting purely to width puts
 * "Bottom" at a quarter of the face and there is no arrangement of six glyphs
 * that does better -- so below the floor the size stops falling and the width
 * cap handed to `fillText` squeezes the glyphs instead. Condensed heavy type is
 * a CAD idiom rather than a compromise; it is what the app's own cyberpunk face
 * does by design.
 */
function faceType(
  ctx: CanvasRenderingContext2D,
  px: number,
  label: string
): { size: number; room: number } {
  const room = px * FACE_TEXT_FIT
  ctx.font = `${FACE_TEXT_WEIGHT} ${px}px ${FACE_TEXT_FONT}`
  const perPx = ctx.measureText(label).width / px
  const wanted = perPx > 0 ? room / perPx : px * FACE_TEXT_MAX
  return {
    size: Math.min(px * FACE_TEXT_MAX, Math.max(px * FACE_TEXT_MIN, wanted)),
    room,
  }
}

/** A face: its name, on the shade of grey that face stands at. */
function faceTexture(
  label: string,
  shade: number,
  /** Per theme, and therefore part of the key -- see `headTexture`. */
  base: string,
  text: string
): CanvasTexture {
  return drawnTexture(`face|${label}|${shade}|${base}|${text}`, (ctx, px) => {
    // Dimmed in three's working space rather than by scaling the hex digits, so
    // the steps between faces read as even light rather than as even numbers.
    ctx.fillStyle = new Color(base).multiplyScalar(shade).getStyle()
    ctx.fillRect(0, 0, px, px)
    const { size, room } = faceType(ctx, px, label)
    ctx.font = `${FACE_TEXT_WEIGHT} ${size}px ${FACE_TEXT_FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = text
    // The third argument is a maximum WIDTH: canvas condenses the glyphs to fit
    // it and leaves them alone if they already do. Only the labels that hit the
    // size floor above are ever touched by it.
    ctx.fillText(label, px / 2, px / 2, room)
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
  const scene = useSceneColors()
  const geometry = useMemo(() => new BoxGeometry(CUBE, CUBE, CUBE), [])
  useEffect(() => () => geometry.dispose(), [geometry])

  const press = (e: ThreeEvent<MouseEvent>) => {
    const index = e.face?.materialIndex
    const view = index === undefined ? undefined : COMPASS_VIEWS[index]
    if (view) askForView(view.dir)
  }

  return (
    <group position={CUBE_AT}>
      <mesh
        geometry={geometry}
        onPointerOver={() => onHot(true)}
        onPointerOut={() => onHot(false)}
        onClick={press}
      >
        {COMPASS_VIEWS.map((view, index) => (
          <meshBasicMaterial
            key={view.key}
            attach={`material-${index}`}
            map={faceTexture(view.label, COMPASS_FACE_SHADE[index] ?? 1, scene.compassFace, scene.compassText)}
            toneMapped={false}
          />
        ))}
      </mesh>

      {/* The corners, so the cube keeps its shape against a dark scene. */}
      <lineSegments raycast={noRaycast}>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color={scene.compassInk} toneMapped={false} />
      </lineSegments>
    </group>
  )
}

/** One end of one axis: a ball, and for a positive direction the stalk it
 *  stands on. Both answer the same press -- they are one handle drawn in two
 *  parts, and the group carrying the events is what makes them behave as one. */
function AxisHandle({ view, onHot }: { view: CompassView; onHot: (hot: boolean) => void }) {
  const scene = useSceneColors()
  const [hovered, setHovered] = useState(false)
  const color = AXIS_COLORS[view.axis]
  const positive = view.sign > 0

  const map = headTexture(color, positive ? view.letter : null, scene.compassInk, scene.compassDim)
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

/**
 * Scratch for the orbit arithmetic, reused rather than allocated.
 *
 * Safe as module state because the frame loop below is the only reader and it
 * runs to completion before anything else can touch them -- the same bargain
 * `picking.ts` strikes with its own. A drag writes these on every frame of the
 * gesture, so allocating would mean a pair of throwaway objects sixty times a
 * second for arithmetic that fits in two.
 */
const SPHERICAL = new Spherical()
const OFFSET = new Vector3()
/** The pivot when there are no controls to ask, which is only ever a test. */
const ORIGIN = new Vector3()

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
    const controls = controlsRef.current

    // The camera, published for everything outside this canvas: the compass
    // widget turns by `facing`, and the tool island puts a new ruler in front of
    // the eye with all three. Written before the flight below moves anything, so
    // what a reader sees is the camera the frame was drawn with rather than the
    // one the next frame will draw.
    compass.facing.copy(camera.quaternion)
    compass.eye.copy(camera.position)
    compass.focus.copy(controls ? controls.target : ORIGIN)

    // A drag on the compass, applied before anything else this frame: it is the
    // user's hand on the camera, and it outranks a flight the way a press in
    // the viewport already does. The flight is dropped rather than blended
    // with, or the two would pull against each other for as long as it lasted.
    const turn = takeTurn()
    if (turn) {
      flight.current = null
      const focus = controls ? controls.target : ORIGIN
      // Straight spherical arithmetic about the pivot, which is what an orbit
      // is. Read fresh from the camera's own offset each frame rather than kept
      // alongside it: OrbitControls derives its state from the position too, so
      // one of the two would be stale the moment anything else moved the camera
      // -- a flight, a compass click, a pan.
      const spin = SPHERICAL.setFromVector3(OFFSET.copy(camera.position).sub(focus))
      spin.theta += turn.azimuth
      // Clamped rather than wrapped: past the pole the world would be upside
      // down and `camera.up` would be fighting the very drag that got it there.
      spin.phi = Math.max(POLAR_LIMIT, Math.min(Math.PI - POLAR_LIMIT, spin.phi + turn.polar))

      camera.position.copy(focus).add(OFFSET.setFromSpherical(spin))
      // Level, always. The compass turns the view; it has no roll to offer, and
      // OrbitControls orbits ABOUT this vector -- left tipped by an earlier
      // flight over the pole, the next drag would spin the scene about Z.
      camera.up.set(0, 1, 0)
      camera.lookAt(focus)
      controls?.update()
    }

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
 * How far the pointer travels before a press on the compass is a drag rather
 * than a click on the handle under it.
 *
 * The compass answers two gestures that start identically -- click a ball to
 * fly to that view, drag anywhere to orbit by hand -- so they are told apart by
 * distance, which is the same bargain the tool island's title strip and the
 * right-click menu already strike. Every part of the widget is grabbable,
 * handles included: a drag region that was only the margin around the cube
 * would be a few pixels of an already small corner.
 */
const TURN_SLOP = 4

/**
 * The widget itself: a canvas of its own, over the top-right corner of the
 * viewport.
 *
 * It is a readout and a control at once. Clicking any part of it flies the
 * camera to that view; DRAGGING any part of it orbits the camera by hand, at
 * half a turn across the widget -- see `TURN_PER_SPAN`. Rotation is all it
 * offers: there is no pan or zoom here, because neither is a thing a compass
 * has an opinion about, and the wheel and the right button already do both a
 * few pixels away in the scene itself.
 *
 * The drag is read HERE, in the DOM, rather than inside the canvas. Three
 * reasons, all of them the same reason in different clothes: it has to work on
 * the empty corners of the widget where there is no object to hit, it wants the
 * widget's pixel size to set its rate, and it has to go on tracking after the
 * pointer has left the 112 pixels it started in -- which is most of any real
 * gesture. What it produces is handed to the scene through `compass`, the same
 * one mutable object a click already goes through.
 *
 * The cursor is owned out here too, because it belongs to the DOM element --
 * and because "is the pointer on something" is one answer for the whole compass
 * however many handles have an opinion.
 */
export function AxisCompass() {
  const [hot, setHot] = useState(false)
  const [turning, setTurning] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Whether the gesture that just ended turned the camera. Read by the click
  // that follows it, to keep a drag begun on a ball from also flying to that
  // ball's view when it lands.
  const dragged = useRef(false)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Left button only. The right one pans the camera everywhere else over the
    // scene, and a widget that swallowed it would be a hole in that.
    if (e.button !== 0) return
    const el = ref.current
    if (!el) return

    // The widget's own size, measured once at the press: the rate is a fraction
    // of it, and re-measuring per move would let a window resize mid-drag
    // change what the gesture already begun is worth.
    const span = Math.min(el.clientWidth, el.clientHeight)
    const from = { x: e.clientX, y: e.clientY }
    let last = from
    dragged.current = false

    // Tracked on the WINDOW rather than by capturing the pointer, although
    // capture is the usual way to hold a drag: capture retargets the
    // compatibility mouse events with it, so the click ending a press on a ball
    // would arrive at this div instead of at the canvas -- and clicking a view
    // would silently stop working. The window sees every move either way, which
    // also lets the gesture carry on well outside the corner it began in.
    const move = (m: PointerEvent) => {
      if (!dragged.current) {
        if (Math.hypot(m.clientX - from.x, m.clientY - from.y) < TURN_SLOP) return
        dragged.current = true
        setTurning(true)
        // Re-seated at the moment the gesture becomes a drag, so the slop is
        // spent deciding what this is rather than being paid out as a jump the
        // instant it is decided.
        last = { x: m.clientX, y: m.clientY }
        return
      }
      askForTurn(turnFromDrag(m.clientX - last.x, m.clientY - last.y, span))
      last = { x: m.clientX, y: m.clientY }
    }

    const up = () => {
      setTurning(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      className="axis-compass"
      ref={ref}
      onPointerDown={onPointerDown}
      // Capture, so it lands before the canvas's own listener rather than
      // after it: R3F answers the DOM `click`, and a press that turned into a
      // drag must not also fly the camera to whichever ball it started on.
      onClickCapture={(e) => {
        if (!dragged.current) return
        e.preventDefault()
        e.stopPropagation()
        dragged.current = false
      }}
      // Grabbable everywhere, and a pointer over the parts that are also
      // clickable. Both are true of a ball at once -- it flies on a click and
      // orbits on a drag -- and the click is the finer claim, so it wins the
      // cursor.
      style={{ cursor: turning ? 'grabbing' : hot ? 'pointer' : 'grab' }}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 10], near: 0.1, far: 100 }}
        dpr={[1, 2]}
        // A press that lands on none of the handles leaves the compass as it
        // was, cursor included: nothing out there is CLICKABLE. It is still
        // grabbable, which the div above answers for.
        onPointerMissed={() => setHot(false)}
      >
        <FitCompass />
        <CompassScene onHot={setHot} />
      </Canvas>
    </div>
  )
}
