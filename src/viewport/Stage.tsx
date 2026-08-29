import { GuideGrid } from './GuideGrid'
import { useSceneColors } from './useSceneColors'

/**
 * The empty room every viewport works in: the background, the light on it, and
 * the ground under it.
 *
 * Extracted the moment there was a second viewport, and for the reason
 * `axisColors.ts` exists: this is a set of values that must agree between
 * screens, and two copies of "the fine grid fades at 14 and the coarse one at
 * 300" is how the ground ends up looking like a different place depending on
 * which button in the bar was last pressed. What a screen does with the room is
 * its own business; what the room IS is one definition.
 *
 * Everything here is inside a `<Canvas>` and draws nothing on its own account:
 * a viewport mounts this and then adds whatever it is for.
 */

/**
 * The grid sits a hair BELOW y = 0 even though objects rest exactly on it:
 * coplanar with a box's bottom face it z-fights across the whole footprint.
 */
const GRID_Y = -0.002

/**
 * The two grids draw before every other transparent thing in the scene, coarse
 * first and fine over it.
 *
 * Stated rather than left to the sort, which is the whole of what stopped the
 * grid shimmering: they are centred on the same point half a thousandth of a
 * unit apart, so three had nothing to separate them by and the order flipped as
 * the camera came round. Negative, because the ground goes under the gizmo, the
 * rulers, the cut plane and the snap marker without any of them having to say
 * so. See `GuideGrid`.
 */
const GRID_ORDER_COARSE = -2
const GRID_ORDER_FINE = -1

export function Stage() {
  const scene = useSceneColors()

  return (
    <>
      <color attach="background" args={[scene.bg]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 9, 5]} intensity={2.1} />
      {/* The cool fill opposite the key, and the one place a theme's hue reaches
          the solids themselves -- everything else it repaints is chrome. */}
      <directionalLight position={[-6, 3, -5]} intensity={0.7} color={scene.fillLight} />

      {/* Grid colours are lifted well clear of whatever ground the theme paints:
          at the original values the ground read as empty space. Major lines
          carry a cast that separates them from the warm-grey solids, and the
          fade is gentler so the plane still reads out toward the horizon.

          Both pairs come from `sceneColors` per theme rather than being tinted
          from one set: "clear of the background" means lighter than it on a dark
          theme and darker than it on a light one, which no single adjustment
          gives you.

          TWO grids, each divided ten ways, because one cannot serve a world
          that runs from a millimetre to five metres. A single grid fine enough
          to count centimetres against turns to moire the moment you pull back
          far enough to see a whole wall; one coarse enough to survive that has
          nothing to say when you are shaping a 5 mm boss.

          So the near grid rules centimetres into decimetres and fades out at
          about a metre and a half, and the far one takes over ruling
          decimetres into metres. Zoom in and the ground gets finer; zoom out
          and it gets coarser, and at every zoom a major square is a round
          number you can count in.

          The fine grid sits a hair ABOVE the coarse one, and draws after it,
          so that where their lines coincide -- every 1 unit, which is a section
          of one and a cell of the other -- the finer of the two wins outright.
          The ORDER is what decides that now rather than the height: neither
          grid writes depth any more, because two nearly coplanar depth-writing
          grids is exactly the fight that had the ground shimmering through
          every camera move. See `GuideGrid` for the whole of it. */}
      <GuideGrid
        renderOrder={GRID_ORDER_FINE}
        position={[0, GRID_Y + 0.0005, 0]}
        args={[24, 24]}
        cellSize={0.1}
        cellThickness={0.6}
        cellColor={scene.gridCell}
        sectionSize={1}
        sectionThickness={1.2}
        sectionColor={scene.gridSection}
        fadeDistance={14}
        fadeStrength={1}
        infiniteGrid
      />
      <GuideGrid
        renderOrder={GRID_ORDER_COARSE}
        position={[0, GRID_Y, 0]}
        args={[24, 24]}
        cellSize={1}
        cellThickness={0.6}
        cellColor={scene.gridCell}
        sectionSize={10}
        sectionThickness={1.4}
        sectionColor={scene.gridSection}
        fadeDistance={300}
        fadeStrength={0.8}
        infiniteGrid
      />
    </>
  )
}

/**
 * How a camera is set down in that room, and how far it may travel from it.
 *
 * Shared for the same reason the grid is: two viewports opening at different
 * distances from the same ground would read as two different worlds. Spread
 * onto the `<Canvas>` and `<OrbitControls>` of whichever screen is up.
 */
export const STAGE_CAMERA = {
  // Four units out -- 40 cm -- which frames the 10 cm solid the palette drops
  // with a comfortable margin of ground around it, rather than the metre of
  // empty grid the opening shot used to hold. The direction is down the corner,
  // so all three axes read at once.
  position: [2.5, 1.85, 2.5],
  fov: 45,
  // A five-metre solid needs the camera 113 units out to frame it; a millimetre
  // one fills the view from 0.023 units away, which was INSIDE the old near
  // plane -- the app simply could not draw a part that small.
  near: 0.005,
  far: 1000,
} as const

/** 114 is what it takes to frame the largest solid `dimensions.ts` allows; 200
 *  leaves room to stand off a scene of them. The near end drops far enough to
 *  put a millimetre feature on screen. */
export const STAGE_MIN_DISTANCE = 0.02
export const STAGE_MAX_DISTANCE = 200
