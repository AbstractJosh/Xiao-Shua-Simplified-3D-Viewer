import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import type { SceneObject } from '../geometry/types'
import { DEFAULT_OBJECT_COLOR } from '../geometry/types'
import type { Thumbnail } from './thumbnailGeometry'
import { thumbnailCached, thumbnailFor } from './thumbnailGeometry'

/**
 * A turntable view of a saved object, small enough to sit in a grid tile.
 *
 * The tile it replaced was an icon of the object's HOST primitive, which for
 * anything worth saving -- a merge of four solids with pockets cut through them
 * -- was a picture of the wrong thing. A model the user can turn is the only
 * honest answer to "which one of these is which".
 */

/**
 * How far above the model the view sits, in degrees.
 *
 * Applied as a TILT ON THE MODEL rather than as a raised camera aimed back down
 * at it. The two are the same picture, but only one of them can be got wrong:
 * an elevated camera has to be pointed, and a `lookAt` is a thing that can fail
 * to be re-applied -- on a resize, on a prop the renderer reasserts -- leaving
 * the model quietly sitting below the bottom of its frame. Tilted, the camera
 * looks straight down its own -Z from the moment it exists and never needs
 * aiming at all.
 */
const ELEVATION = 30

/** Idle turn rate, radians per second. Slow enough to read, not to wait on. */
const IDLE_SPIN = 0.45

/**
 * How the model is framed.
 *
 * `fit` is the share of the frame's half-height the model's bounding sphere
 * fills, and it is deliberately a long way short of 1. The sphere is the
 * model's WORST case -- the furthest any vertex reaches on any frame of the
 * turn -- so a value near the edge has the silhouette grazing the frame at one
 * point in the spin and clearing it at another, and a tile that crops only
 * sometimes is worse than one that is simply small. A tile is an identifier at
 * a glance, not a viewport; the object wants air around it more than it wants
 * pixels.
 *
 * Exported, with the distance that falls out of it, because the check suite
 * measures the framing and must read these rather than keep a second copy that
 * drifts the first time one is tuned.
 */
export const VIEW = { fov: 22, elevation: ELEVATION, fit: 0.32 } as const

/** How far back the camera sits to frame a model of this reach. */
export function framingDistance(radius: number): number {
  return radius / VIEW.fit / Math.tan((VIEW.fov * Math.PI) / 360)
}

/**
 * The live turn, shared between the DOM handlers on the tile and the frame loop
 * inside the canvas.
 *
 * A ref rather than state because it changes every frame: routing a turntable's
 * angle through React would re-render three canvases sixty times a second to
 * move a number that only three.js reads.
 */
export type Turn = { angle: number; grabbed: boolean }

function Model({
  thumbnail,
  turn,
  color,
}: {
  thumbnail: Thumbnail
  turn: { current: Turn }
  color: string
}) {
  const spin = useRef<Group>(null)

  useFrame((_, delta) => {
    // While the pointer is on the tile it owns the angle outright -- the idle
    // spin would otherwise crawl out from under a user holding the model still
    // to look at one face.
    if (!turn.current.grabbed) turn.current.angle += IDLE_SPIN * delta
    if (spin.current) spin.current.rotation.y = turn.current.angle
  })

  // Two groups, and the order matters: the inner one turns the model about its
  // OWN upright axis, the outer one tips the result toward the camera. Folded
  // into one, the turn would run about an axis that had already been tilted and
  // the model would tumble rather than sit on a turntable.
  return (
    <group rotation-x={(ELEVATION * Math.PI) / 180}>
      <group ref={spin}>
        {/* The geometry is already moved so the object's gizmo point is at the
            origin, which is what both of these rotations run about and what the
            camera is looking at. */}
        <mesh geometry={thumbnail.geometry}>
          {/* The object's own colour -- the scene's grey until it was given one
              -- so a tile reads as the thing it will drop rather than as a
              differently-painted cousin of it. */}
          <meshStandardMaterial color={color} metalness={0.15} roughness={0.55} />
        </mesh>
      </group>
    </group>
  )
}

/**
 * The circular loading bar shown while a model is being built.
 *
 * Indeterminate -- a sweeping arc rather than a filling one -- because there is
 * no honest progress to report: the work is one synchronous replay of the
 * object's features and cuts, which either has not started or is done.
 */
function LoadingRing() {
  return (
    <svg className="thumb-ring" viewBox="0 0 36 36" role="progressbar" aria-label="Loading model">
      <circle className="thumb-ring-track" cx="18" cy="18" r="13" />
      <circle className="thumb-ring-arc" cx="18" cy="18" r="13" />
    </svg>
  )
}

export function ObjectThumbnail({
  object,
  label,
  live,
}: {
  object: SceneObject
  label: string
  /**
   * Whether this tile is one of the three the panel is showing. False mounts
   * the ring alone: a canvas per saved object is a WebGL context per saved
   * object, and browsers hand out very few of those.
   */
  live: boolean
}) {
  // Seeded from the cache so a tile scrolling back into view is instant rather
  // than flashing a ring for a mesh that is already built.
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(() =>
    thumbnailCached(object) ? thumbnailFor(object) : null
  )
  const turn = useRef<Turn>({ angle: 0, grabbed: false })
  const frame = useRef<HTMLDivElement>(null)
  /** Where the pointer entered, and the angle it found -- see `scrub`. */
  const from = useRef({ x: 0, angle: 0 })

  useEffect(() => {
    if (!live) return
    if (thumbnailCached(object)) {
      setThumbnail(thumbnailFor(object))
      return
    }
    setThumbnail(null)
    // Deferred by a turn of the event loop so the ring is on screen BEFORE the
    // replay begins. The solve is synchronous and will block once it starts; a
    // ring that only appears after the thing it was waiting for has finished is
    // no ring at all.
    const id = window.setTimeout(() => setThumbnail(thumbnailFor(object)), 0)
    return () => window.clearTimeout(id)
    // The geometry belongs to the cache, which owns its disposal -- freeing it
    // here would pull a mesh out from under a tile that is merely scrolled away.
  }, [object, live])

  /**
   * Horizontal travel across the tile turns the model, one full revolution per
   * tile width, so the whole object can be walked round in a single sweep --
   * far faster than waiting for the idle spin to bring a face into view.
   *
   * Measured as travel FROM where the pointer came in, not as an absolute
   * position across the tile: the model has been turning on its own, and an
   * absolute mapping would snap it to a new angle the instant the pointer
   * touched the tile -- a flinch, right at the moment the user meant to look
   * closely.
   *
   * Vertical travel is dropped on the floor. The tile is small and a pointer
   * crossing it rarely runs level; letting Y tip the model would make every
   * inspection a wobble, and there is no second axis worth having at this size.
   */
  const scrub = (clientX: number) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    turn.current.angle =
      from.current.angle + ((clientX - from.current.x) / box.width) * Math.PI * 2
  }

  // Derived from the object's own reach, so a bead and a wall -- and a sphere
  // and a cube of the same reach -- are all framed the same way.
  const distance = thumbnail ? framingDistance(thumbnail.radius) : 4

  return (
    <div
      ref={frame}
      className="thumb-frame"
      onPointerEnter={(e) => {
        turn.current.grabbed = true
        from.current = { x: e.clientX, angle: turn.current.angle }
      }}
      onPointerMove={(e) => scrub(e.clientX)}
      // Handing the angle back rather than snapping it home: the model carries
      // on turning from wherever the pointer left it.
      onPointerLeave={() => {
        turn.current.grabbed = false
      }}
    >
      {live && thumbnail ? (
        <Canvas
          // A tile is 60-ish pixels; anything past 2x is spent on a model nobody
          // can see the extra detail in.
          dpr={[1, 2]}
          camera={{
            fov: VIEW.fov,
            // Sized off the framing rather than fixed, so a shelf holding a bead
            // and a wall both get usable depth precision.
            near: distance / 100,
            far: distance * 10,
            // Straight back along +Z, which is where a camera points by default.
            // The view from above comes from tilting the MODEL, so there is no
            // aim here to be lost -- see ELEVATION.
            position: [0, 0, distance],
          }}
          aria-label={`${label}, drag to place`}
        >
          <ambientLight intensity={0.55} />
          <directionalLight position={[6, 9, 5]} intensity={2.1} />
          <directionalLight position={[-6, 3, -5]} intensity={0.7} color="#8fb4ff" />
          <Model thumbnail={thumbnail} turn={turn} color={object.color ?? DEFAULT_OBJECT_COLOR} />
        </Canvas>
      ) : (
        <LoadingRing />
      )}
    </div>
  )
}
