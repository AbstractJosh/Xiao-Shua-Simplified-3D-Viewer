import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { Edges } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import type { Mesh } from 'three'
import { lighten } from '../color'
import { assemblyAnchor } from '../geometry/assembly'
import { evaluateDoc } from '../geometry/evaluate'
import type { SnapEntry } from '../geometry/snap'
import { DEFAULT_OBJECT_COLOR } from '../geometry/types'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import { FaceHandle } from './FaceHandle'
import { SketchGizmo } from './SketchGizmo'
import { ObjectSketches } from './SketchLayer'
import { publishScene } from './snapping'
import { isRightClick, noteRightPress, useObjectMenu } from './ObjectMenu'
import { useMarquee } from './marquee'
import { TransformGizmo } from './TransformGizmo'

/** Selection is carried by the object's own material and outline, which is why
 *  there is no separate highlight pass to keep in sync with the scene. */
const EDGE_IDLE = '#2b3442'
const EDGE_SELECTED = '#7cc0ff'

/**
 * The unselected solid: warm grey, and the colour every solid wears until the
 * Colour panel gives it one of its own. The literal lives with the document
 * model, because an absent `color` and this string have to mean the same thing
 * to everything that draws an object.
 */
const SOLID_COLOR = DEFAULT_OBJECT_COLOR

/**
 * A selected solid is lit from within rather than merely outlined.
 *
 * The outline alone was a one-pixel line in a colour close to the grid's, and
 * on a busy scene it was genuinely hard to tell which solid was selected --
 * which matters far more now that shift-click gathers several at once and the
 * answer decides what a merge is about to take. Three things move together: the
 * body warms toward the accent, the material picks up a low emissive so the
 * shift survives a face turned away from the lights, and the outline thickens.
 *
 * Emissive rather than a brighter `color`, because `color` is multiplied by the
 * lighting: a face in shadow would barely change, which is exactly the face a
 * user is squinting at when they cannot tell what is selected.
 */
const SELECTED_COLOR = '#b9c9e6'
const SELECTED_EMISSIVE = '#2a5c96'
const SELECTED_EMISSIVE_INTENSITY = 0.55

/** The same glow for a solid emitting its OWN colour, which is a far stronger
 *  signal than a wash of blue over grey and wants a good deal less of it. */
const SELECTED_OWN_INTENSITY = 0.28

const EDGE_WIDTH_IDLE = 1
const EDGE_WIDTH_SELECTED = 2.5

/**
 * How far a COLOURED solid is lifted toward white while it is selected.
 *
 * `SELECTED_COLOR` above cannot serve here: it is one hand-picked shade, warmer
 * grey lifted and cooled, and painting it over a red solid would say "selected"
 * by throwing away the very thing the user just chose. A lift toward white
 * carries the same "this one is lit" reading while leaving the hue intact --
 * the same trick the gizmo plays on a hovered arrow, but done in sRGB rather
 * than through three's linear-space `lerp`, which at a visible lift turns a
 * saturated solid pastel. See `lighten`.
 */
const SELECT_LIFT = 0.24

// One parse per distinct colour rather than one per render: this runs for every
// selected object in the scene, and a scene's palette is a handful of strings.
const liftCache = new Map<string, string>()
function lifted(color: string): string {
  const cached = liftCache.get(color)
  if (cached) return cached
  const value = lighten(color, SELECT_LIFT)
  liftCache.set(color, value)
  return value
}

/**
 * A solid's material, given its own colour and whether it is selected.
 *
 * One function returning all three numbers rather than three conditionals at
 * the call site, because they only make sense together: an uncoloured solid
 * takes the hand-tuned grey pair the scene has always used, and a coloured one
 * takes a lift of its OWN hue in both channels. The blue emissive is what says
 * "selected" on grey; on a red solid it would say "purple" instead, and a
 * selection highlight that repaints the colour the user just chose is a
 * highlight that argues with the panel that set it.
 *
 * Exported for the check suite, which pins the part that is easy to lose in a
 * later tweak: that a solid the user coloured is still recognisably that colour
 * while it is selected.
 */
export function bodyPaint(
  color: string | undefined,
  selected: boolean
): { color: string; emissive: string; emissiveIntensity: number } {
  if (!selected) return { color: color ?? SOLID_COLOR, emissive: '#000000', emissiveIntensity: 0 }
  if (color === undefined) {
    return {
      color: SELECTED_COLOR,
      emissive: SELECTED_EMISSIVE,
      emissiveIntensity: SELECTED_EMISSIVE_INTENSITY,
    }
  }
  return { color: lifted(color), emissive: color, emissiveIntensity: SELECTED_OWN_INTENSITY }
}

type Props = {
  meshes: RefObject<Map<string, Mesh>>
  controlsRef: RefObject<{ enabled: boolean } | null>
}

/**
 * The whole scene: one group per object, carrying that object's evaluated mesh,
 * its sketches and -- for the selected feature -- its end-face handle.
 */
export function SceneObjects({ meshes, controlsRef }: Props) {
  const doc = useDoc((s) => s.doc)
  const selectedObjectId = useDoc(primarySelection)
  const selectedObjectIds = useDoc((s) => s.selectedObjectIds)
  const startGizmo = useDoc((s) => s.startGizmo)
  // An armed cut plane carries a gizmo of its own, a few units away and often
  // overlapping this one. Two sets of arrows on screen is two sets of arrows to
  // tell apart mid-drag, so the plane -- the thing being actively aimed -- takes
  // the gizmo for as long as the tool is armed, and the selection gives it up.
  const cutActive = useTools((s) => s.cutActive)
  const openMenu = useObjectMenu((s) => s.openMenu)
  const selectedFeatureId = useDoc((s) => s.selectedFeatureId)
  const dragging = useDoc((s) => s.drag.kind !== 'idle')
  // A marquee re-decides the selection on every pointer move. The highlight is
  // the point of that and follows along, but a gizmo hopping between solids as
  // the box grows would read as three objects being dragged at once -- so it
  // stands down until the box is let go, the way it does for the cut plane.
  const marqueeing = useMarquee((s) => s.box !== null)
  // The finer selection wins the gizmo. Selecting a sketch is a statement about
  // wanting to work on the sketch, and the same precedence already governs the
  // Delete key -- a feature goes before the object that hosts it.
  const sketchSelected = selectedFeatureId !== null
  const publish = useEvalStatus((s) => s.publish)

  // The viewport is a pure function of the document: every edit replays the
  // feature tree, and the per-object prefix cache keeps that cheap. Nothing in
  // the cache keys mentions a transform, so dragging an object through the
  // scene re-renders groups and does no boolean work at all.
  const result = useMemo(() => evaluateDoc(doc), [doc])

  const geometries = useMemo(
    () => new Map(result.objects.map((o) => [o.id, o.geometry])),
    [result]
  )

  // One stable ref callback per object id. A fresh closure each render would
  // make React detach and re-attach the ref every time, so the map the
  // raycaster reads would briefly lose the mesh it is about to hit.
  const registrars = useRef(new Map<string, (mesh: Mesh | null) => void>())
  const registrarFor = (id: string) => {
    const cached = registrars.current.get(id)
    if (cached) return cached
    const register = (mesh: Mesh | null) => {
      if (mesh) meshes.current.set(id, mesh)
      // A stale entry would let picking raycast a mesh that has left the scene.
      else meshes.current.delete(id)
    }
    registrars.current.set(id, register)
    return register
  }

  useEffect(() => {
    publish({
      objects: result.objects,
      failed: result.failed,
      millis: result.millis,
      triangles: result.triangles,
    })

    // The snapping registry has to describe the scene AS EVALUATED: publishing
    // anything else would catch corners and edges that are no longer there.
    const entries: SnapEntry[] = []
    for (const object of doc.objects) {
      const geometry = geometries.get(object.id)
      if (geometry) entries.push({ id: object.id, geometry, transform: object.transform })
    }
    publishScene(entries)

    // React nulls the ref of an unmounted mesh, but the closure that does it
    // would otherwise be retained for every object the scene has ever held.
    const live = new Set(doc.objects.map((o) => o.id))
    for (const id of registrars.current.keys()) {
      if (!live.has(id)) registrars.current.delete(id)
    }
  }, [doc, geometries, result, publish])

  const onObjectPointerDown = (e: ThreeEvent<PointerEvent>, id: string) => {
    e.stopPropagation()
    const s = useDoc.getState()
    // A placement gesture already owns the pointer; letting a press through
    // here would abandon the drop half-finished and grab something else.
    if (s.drag.kind !== 'idle') return

    // The right button is not a drag on the body. It selects, notes where it
    // landed, and leaves the rest to the release: a small movement opens the
    // menu, a large one was the camera being panned. Starting a move here --
    // which is what used to happen, since nothing checked the button -- meant a
    // right-click walked the solid to the pointer before the menu appeared.
    if (e.nativeEvent.button === 2) {
      noteRightPress(e.nativeEvent.clientX, e.nativeEvent.clientY)
      if (primarySelection(s) !== id) s.selectObject(id)
      return
    }

    // Shift adds to the selection instead of replacing it, which is how a merge
    // is chosen. It never starts a drag: the press is about picking, and moving
    // the object under it would be a surprise on a gesture meant to gather.
    if (e.nativeEvent.shiftKey) {
      s.toggleObjectSelection(id)
      return
    }

    if (primarySelection(s) !== id) {
      // The first press only selects, so an object cannot be shoved across the
      // scene by a click that was only meant to pick it. The press is spent
      // either way: the left button no longer orbits from the body of a solid
      // any more than it does from empty space, where it draws a box instead.
      s.selectObject(id)
      return
    }

    // Pressing the bare solid steps the selection back up from any sketch on
    // it. Without this the sketch gizmo, which outranks the object's, could
    // never be dismissed: sketches are deselected by selecting something else,
    // and the obvious something else is the solid they sit on. Done in the same
    // gesture rather than costing a click, since the press is a move anyway.
    if (s.selectedFeatureId !== null) s.selectFeature(id, null)

    // OrbitControls listens on the canvas directly, so a React-level
    // stopPropagation never reaches it. Disable it synchronously or the camera
    // orbits while the object is being dragged.
    if (controlsRef.current) controlsRef.current.enabled = false
    s.startMovingObject(id)
  }

  const selected = doc.objects.find((o) => o.id === selectedObjectId) ?? null
  // Selection is a set now. The outline says what a merge would take, and the
  // primary -- the one everything else merges INTO -- is the one that keeps the
  // gizmo, so the two together read as "this one, plus these".
  const chosen = new Set(selectedObjectIds)

  return (
    <>
      {/* Drawn outside the per-object groups on purpose. Those carry the
          object's transform, and the gizmo sets its own scale from camera
          distance -- nested, the two would multiply and the arrows would grow
          with whatever they were parented to.

          It stays up through every gesture, including the ones it is not part
          of: its position comes from the same store update the mesh does, so
          there is no lag to hide, and a gizmo that blinked out whenever the
          object was touched would read as the selection being lost.

          Exactly one gizmo is ever on screen. This is the selected object's,
          and it stands down for the three things that outrank it: an armed cut
          plane, whose own arrows would otherwise be one of two sets to tell
          apart, a selected sketch, which gets the finer gizmo of the two, and a
          marquee in flight, whose selection is still being drawn.

          It sits at the object's ASSEMBLY ANCHOR, not at its transform: merging
          two solids leaves one gizmo, and it belongs midway between the two that
          went in rather than parked on whichever happened to be the host. For an
          unmerged object the two are the same point.

          It takes the anchor's POSITION but not its rotation. The arrows stand
          in the world frame and stay there: red is world X at every angle the
          object is ever turned to, and the ring turns about world X, Y or Z.
          Axes that rode the object had the property every rotation gesture has
          to fight -- turning a thing moves the very handles you turn it by, so
          a second turn is aimed at arrows the first one carried off, and there
          is no way back to square except by eye. Fixed axes are a frame to work
          against. What the object's own rotation still decides is which of its
          DIMENSIONS a right-drag resizes; `nearestLocalAxis` makes that call. */}
      {selected && !cutActive && !sketchSelected && !marqueeing && (
        <TransformGizmo
          position={assemblyAnchor(selected)}
          controlsRef={controlsRef}
          onGrab={(handle) => startGizmo(selected.id, handle)}
        />
      )}

      {doc.objects.map((object) => {
        const geometry = geometries.get(object.id)
        if (!geometry) return null

        const isSelected = chosen.has(object.id)
        const feature =
          object.id === selectedObjectId
            ? object.features.find((f) => f.id === selectedFeatureId) ?? null
            : null

        return (
          <group
            key={object.id}
            position={object.transform.position}
            rotation={object.transform.rotation}
          >
            {/* The geometry belongs to the evaluator's cache -- this is a
                borrow. Disposing it here would free a buffer the next
                evaluation hands straight back. */}
            <mesh
              ref={registrarFor(object.id)}
              geometry={geometry}
              castShadow
              receiveShadow
              onPointerDown={(e) => onObjectPointerDown(e, object.id)}
              onContextMenu={(e) => {
                e.stopPropagation()
                const { clientX, clientY } = e.nativeEvent
                // Only a click, never the tail of a pan. See ObjectMenu.
                if (!isRightClick(clientX, clientY)) return
                openMenu(clientX, clientY, object.id)
              }}
            >
              <meshStandardMaterial
                {...bodyPaint(object.color, isSelected)}
                metalness={0.15}
                roughness={0.55}
              />
              {/* Edge outlines read as CAD, but rebuilding them every frame
                  competes with the boolean solve, so they are dropped for the
                  duration of a drag. */}
              {!dragging && (
                <Edges
                  threshold={18}
                  color={isSelected ? EDGE_SELECTED : EDGE_IDLE}
                  lineWidth={isSelected ? EDGE_WIDTH_SELECTED : EDGE_WIDTH_IDLE}
                />
              )}
            </mesh>

            <ObjectSketches object={object} controlsRef={controlsRef} />
            {feature && (
              <>
                {/* Inside the object's group, so both are in object-local
                    space -- which is the space a sketch anchor and a surface
                    frame are stored in. Safe to nest, unlike the object gizmo:
                    an ObjectTransform is rigid, so there is no parent scale
                    here to multiply with the gizmo's own. */}
                {!cutActive && (
                  <SketchGizmo
                    object={object}
                    feature={feature}
                    controlsRef={controlsRef}
                  />
                )}
                <FaceHandle object={object} feature={feature} controlsRef={controlsRef} />
              </>
            )}
          </group>
        )
      })}
    </>
  )
}
