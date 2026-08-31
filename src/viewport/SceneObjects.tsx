import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { Edges } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import type { Mesh } from 'three'
import { lighten } from '../color'
import { assemblyAnchor, assemblyColors } from '../geometry/assembly'
import { evaluateDoc } from '../geometry/evaluate'
import type { SnapEntry } from '../geometry/snap'
import { DEFAULT_OBJECT_COLOR } from '../geometry/types'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import type { TransformMode } from '../store/toolStore'
// Imported for the side effect as much as the function: the module registers
// `<biasedStandardMaterial>` with the reconciler, which is the element both
// bodies below are built from.
import { depthBias } from './depthBias'
import { FaceHandle } from './FaceHandle'
import { SketchGizmo } from './SketchGizmo'
import { ObjectSketches } from './SketchLayer'
import { publishScene, sketchCentres } from './snapping'
import { isRightClick, noteRightPress, useObjectMenu } from './ObjectMenu'
import { brushAllows } from './brushTarget'
import { useMarquee } from './marquee'
import type { SceneColors } from './sceneColors'
import { useSceneColors } from './useSceneColors'
import { TransformGizmo, gizmoParts } from './TransformGizmo'

/* Selection is carried by the object's own material and outline, which is why
   there is no separate highlight pass to keep in sync with the scene.

   The edge colours themselves are per theme and live in `sceneColors`:
   `edgeIdle` has to sit BETWEEN the solid and the ground, and which direction
   that is flips between a dark theme and a light one, so it is re-decided per
   palette rather than tinted. */

/**
 * An ERASER: a solid placed to take material away, drawn as a red ghost and
 * taking nothing until it is confirmed.
 *
 * Translucent because what matters while aiming one is what is INSIDE it -- the
 * material about to go -- and an opaque solid hides exactly that. Red because
 * it is a subtraction, which is the reading `--in` already carries on an inward
 * feature; the literal is repeated here because a material cannot read a CSS
 * custom property, the same bargain `axisColors` strikes.
 *
 * It still writes depth. A ghost that did not would show through the very solid
 * it is buried in, and "am I far enough in" is the one question aiming it asks.
 */
const ERASE_OPACITY = 0.42
const ERASE_EMISSIVE_INTENSITY = 0.3
/** Selected, it brightens rather than turning blue -- the same rule a coloured
 *  solid follows, and for the same reason: the red IS the message. */
const ERASE_SELECTED_OPACITY = 0.6

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
  selected: boolean,
  /** The palette of the theme that is on. Required rather than defaulted to the
   *  dark one: a default here would let a caller forget the theme and get the
   *  wrong shade with nothing failing, which is the exact bug this parameter
   *  exists to make impossible. */
  scene: SceneColors
): { color: string; emissive: string; emissiveIntensity: number } {
  if (!selected) return { color: color ?? SOLID_COLOR, emissive: '#000000', emissiveIntensity: 0 }
  if (color === undefined) {
    return {
      color: scene.selected,
      emissive: scene.selectedEmissive,
      emissiveIntensity: SELECTED_EMISSIVE_INTENSITY,
    }
  }
  return { color: lifted(color), emissive: color, emissiveIntensity: SELECTED_OWN_INTENSITY }
}

/**
 * The material -- or materials -- a solid's body wears.
 *
 * An unmerged object is one solid and takes one material, which is the whole of
 * what this used to be. A MERGED one is a single mesh cut from several solids,
 * and the evaluator hands back a group per solid still showing a face, in
 * `paints`. Each group gets its own material here, attached by index, and each
 * looks its own colour up by the id its paint carries -- so a merge of a red
 * cube and a blue one is drawn red and blue, and stays that way through the
 * pockets and cuts that come after.
 *
 * The single case is kept genuinely single rather than folded into an array of
 * one. `attach="material-0"` builds an array on the mesh, and a mesh with an
 * array material draws GROUP BY GROUP -- so an object whose geometry never went
 * through a boolean, and therefore has no groups at all, would render nothing.
 */
/**
 * The eraser's own material. One, not one per paint: an eraser is never merged
 * and never coloured, so there is only ever the one surface to describe.
 */
function EraseBody({ selected, bias }: { selected: boolean; bias: ReturnType<typeof depthBias> }) {
  const scene = useSceneColors()
  return (
    <biasedStandardMaterial
      color={scene.in}
      emissive={scene.in}
      emissiveIntensity={selected ? ERASE_EMISSIVE_INTENSITY : 0}
      transparent
      opacity={selected ? ERASE_SELECTED_OPACITY : ERASE_OPACITY}
      metalness={0}
      roughness={0.5}
      {...bias}
    />
  )
}

function Body({
  paints,
  colors,
  selected,
  bias,
}: {
  paints: string[]
  colors: Map<string, string | undefined>
  selected: boolean
  /** The object's place in the scene tree, as a depth offset. See `depthBias`. */
  bias: ReturnType<typeof depthBias>
}) {
  const scene = useSceneColors()
  if (paints.length === 1) {
    return (
      <biasedStandardMaterial
        {...bodyPaint(colors.get(paints[0]), selected, scene)}
        {...bias}
        metalness={0.15}
        roughness={0.55}
      />
    )
  }

  // One bias for every group: the solids inside one object were welded into a
  // single mesh by a union, which already removed the surfaces they shared, so
  // there is nothing here to break a tie between. The tie is between OBJECTS.
  return (
    <>
      {paints.map((paint, i) => (
        <biasedStandardMaterial
          key={paint}
          attach={`material-${i}`}
          {...bodyPaint(colors.get(paint), selected, scene)}
          {...bias}
          metalness={0.15}
          roughness={0.55}
        />
      ))}
    </>
  )
}

type Props = {
  meshes: RefObject<Map<string, Mesh>>
  controlsRef: RefObject<{ enabled: boolean } | null>
}

/**
 * Everything that can take the handles off the selected object.
 *
 * A record rather than six arguments, because six booleans in a row is six
 * chances to pass them in the wrong order and no way to notice.
 */
export type GizmoClaims = {
  /** Something is selected to put handles ON. */
  selected: boolean
  /** The user pressed the lit Move button. See `gizmoHidden`. */
  hidden: boolean
  cutActive: boolean
  /** Either brush is up. Which one is not a question the handles care about. */
  brushArmed: boolean
  rulerSelected: boolean
  sketchSelected: boolean
  marqueeing: boolean
}

/**
 * Whether the selection wears a gizmo at all.
 *
 * Lifted out of the JSX because it is a SIX-WAY rule and the sixth was added
 * recently: a condition that long, inlined, is one nobody re-reads, and the
 * cost of getting it wrong is a set of arrows lying over the surface a brush is
 * trying to work on. Pure and exported, so `ui-check` can state each claim
 * rather than trust the reading of a boolean chain.
 *
 * Five of the six are OTHER CLAIMS on the handles -- another tool's gizmo, a
 * finer selection, a gesture still in flight. The sixth, `hidden`, is the user
 * saying so outright, which is why it is not a guess and cannot be overridden.
 */
/**
 * Whether a press on an object's BODY may drag it across the scene.
 *
 * The body is the second way to move a solid, and it is invisible: the arrows
 * announce themselves, the body just sits there being the object. So taking the
 * handles away and leaving it draggable produced exactly the wrong result --
 * the picker said the object was not being transformed, and it moved anyway the
 * first time anybody pressed it.
 *
 * THE MODE IS THE SAME ARGUMENT, and it was the bigger hole. The body has only
 * ever offered ONE gesture -- a slide across the ground -- so in Rotate and in
 * Scale it was a handle for something the tool does not do. Pick Rotate,
 * intending to turn a solid, press anywhere on it that is not a ring, and it
 * slid. The gizmo said the tool was Rotate and the object moved instead, which
 * is the same lie as a dark picker and a solid that still walks. So the body
 * drags in MOVE and nowhere else; the rings and the scale arrows are what those
 * two modes offer, and they are enough.
 *
 * What a press in the other two modes still does is select -- pick the object,
 * step back from a sketch on it -- and then stop, spending the press and
 * leaving the camera alone. Nothing else on the object is being taken away.
 *
 * TWO of the six claims in `selectionWearsGizmo` reach this far, and only two,
 * because the other four are answered inside the press itself:
 *
 *  - a selected SKETCH or RULER stands the object's gizmo down, but pressing
 *    the body is precisely how you hand the gizmo BACK -- the handler clears
 *    the finer selection and the arrows return, so the press ends with the
 *    object wearing handles and a drag is honest;
 *  - a MARQUEE in flight cannot be the thing you just pressed an object with;
 *  - an armed CUT PLANE owns the gizmo but has never owned the object. Moving
 *    a solid into the blade is a normal way to aim a cut, and taking that away
 *    would be answering a question nobody asked.
 *
 * What is left is the two that mean the object genuinely is not being
 * transformed right now: the user put the handles down, or a brush is up.
 */
export function bodyCanBeDragged(
  claims: Pick<GizmoClaims, 'hidden' | 'brushArmed'> & { mode: TransformMode }
): boolean {
  return claims.mode === 'move' && !claims.hidden && !claims.brushArmed
}

export function selectionWearsGizmo(claims: GizmoClaims): boolean {
  return (
    claims.selected &&
    !claims.hidden &&
    !claims.cutActive &&
    !claims.brushArmed &&
    !claims.rulerSelected &&
    !claims.sketchSelected &&
    !claims.marqueeing
  )
}

/**
 * The whole scene: one group per object, carrying that object's evaluated mesh,
 * its sketches and -- for the selected feature -- its end-face handle.
 */
export function SceneObjects({ meshes, controlsRef }: Props) {
  const scene = useSceneColors()
  const doc = useDoc((s) => s.doc)
  const selectedObjectId = useDoc(primarySelection)
  const selectedObjectIds = useDoc((s) => s.selectedObjectIds)
  const startGizmo = useDoc((s) => s.startGizmo)
  // An armed cut plane carries a gizmo of its own, a few units away and often
  // overlapping this one. Two sets of arrows on screen is two sets of arrows to
  // tell apart mid-drag, so the plane -- the thing being actively aimed -- takes
  // the gizmo for as long as the tool is armed, and the selection gives it up.
  const cutActive = useTools((s) => s.cutActive)
  // An armed brush -- either of them -- stands the handles down for the same
  // reason an armed cut plane does, only more so: a brush is used ON the
  // surface, and the arrows and plane quads sit over exactly the part of it you
  // are trying to work, where they would take the press instead of the stroke.
  // The cut plane keeps its own gizmo through this; a brush has none to keep.
  const brushArmed = useTools((s) => s.brushTool !== null)
  // And the user can put them down by hand, whatever tool is up. See
  // `gizmoHidden`.
  const gizmoHidden = useTools((s) => s.gizmoHidden)
  const showOutlines = useTools((s) => s.showOutlines)
  // And a selected ruler is the same claim: its own end carries arrows, and one
  // set at a time is the rule the whole viewport keeps. Deselecting the ruler --
  // Escape, or a click on empty space -- hands the gizmo straight back.
  const rulerSelected = useTools((s) => s.rulerActive && s.selectedRuler !== null)
  // Which frame the selected object's arrows stand in follows from the tool, so
  // the mode is subscribed here as well as inside the gizmo. See the comment on
  // the gizmo below.
  const transformMode = useTools((s) => s.transformMode)
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

  // Which solid each group of each object's mesh came from. Alongside the
  // geometries rather than inside them because it is the one thing about a
  // merged mesh the geometry cannot say for itself.
  const paints = useMemo(
    () => new Map(result.objects.map((o) => [o.id, o.paints])),
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
      if (!geometry) continue
      entries.push({
        id: object.id,
        geometry,
        transform: object.transform,
        // Not in the mesh, so they have to be carried alongside it: a sketch at
        // depth zero cuts nothing, and its middle is still somewhere a drag
        // should be able to catch.
        sketches: sketchCentres(object),
      })
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

    // A press on a solid is a claim on the gizmo, and a selected ruler is
    // holding it. Handed over here rather than left for Escape, so the rule
    // stays the one the viewport keeps everywhere: whatever you pressed last is
    // the thing with handles on it. The ruler itself stays exactly where it is
    // -- this puts it down, it does not throw it away.
    useTools.getState().selectRuler(null)

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

    // AN ARMED BRUSH OUTRANKS BOTH SELECTING AND MOVING. A plain left press on
    // a solid the brush may touch is a stroke: without this the commonest thing
    // anyone would try -- press on the model and drag -- would walk the object
    // across the scene instead of working it.
    //
    // It is placed after the right-button and Shift branches on purpose, so
    // those two go on selecting exactly as they always did. That is what keeps
    // "Selected only" usable: with a brush armed and everything in scope, a
    // plain press can no longer pick anything up, and right-click stays the way
    // to choose what the brush is then allowed to touch.
    //
    // A press on an object OUT of scope falls through to ordinary selection
    // rather than doing nothing, which is how you pick the objects that
    // "Selected only" is about to let you work on.
    const tools = useTools.getState()
    if (
      tools.brushTool &&
      brushAllows(s.doc, s.selectedObjectIds, tools.brushScope, id)
    ) {
      // OrbitControls listens on the canvas directly, so a React-level
      // stopPropagation never reaches it; without this the camera orbits while
      // the brush is being dragged across the surface.
      if (controlsRef.current) controlsRef.current.enabled = false
      // WHICH brush is fixed here, at the press, and carried by the drag --
      // see the `erode` drag's `brush`. Reading it per dab instead would let a
      // stroke change kind halfway along.
      s.startErode(id, tools.brushTool)
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
    // and the obvious something else is the solid they sit on. Done here rather
    // than costing a click, and it happens whether or not the press goes on to
    // become a drag -- putting the sketch down is the half of it that is about
    // the selection.
    if (s.selectedFeatureId !== null) s.selectFeature(id, null)

    // MOVE ONLY, AND ONLY WITH HANDLES UP. The body is the invisible second
    // way to move a solid: the arrows announce themselves, the body just sits
    // there being the object. So it must not go on offering a slide when the
    // tool on screen says Rotate or Scale, or when the picker has been put
    // down. The press is spent on the selection above and the camera is left
    // alone, since nothing is about to be dragged.
    //
    // Read from `tools` rather than from the subscribed copies, so the answer
    // is the mode as it stands at the PRESS rather than as of the last render.
    if (
      !bodyCanBeDragged({
        mode: tools.transformMode,
        hidden: tools.gizmoHidden,
        brushArmed: tools.brushTool !== null,
      })
    ) {
      return
    }

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
          and it stands down for six things that outrank it.

          FIVE ARE OTHER CLAIMS ON THE HANDLES: an armed cut plane, whose own
          arrows would otherwise be one of two sets to tell apart; an armed
          torch, which has no gizmo of its own but is used ON the surface, so
          arrows and plane quads lying over the very spot being melted would
          take the press instead of the stroke; a selected ruler, which is the
          same claim made by a different tool; a selected sketch, which gets the
          finer gizmo of the two; and a marquee in flight, whose selection is
          still being drawn.

          THE SIXTH IS THE USER SAYING SO. `gizmoHidden` is the lit Move button
          pressed a second time, and it outranks everything here because it is
          not a guess about what someone is doing -- it is the answer.

          It sits at the object's ASSEMBLY ANCHOR, not at its transform: merging
          two solids leaves one gizmo, and it belongs midway between the two that
          went in rather than parked on whichever happened to be the host. For an
          unmerged object the two are the same point.

          It takes the anchor's POSITION always, and its ROTATION only in the
          mode that needs it -- `gizmoParts().local`, which is Scale and nothing
          else.

          In Move and Rotate the arrows and rings stand in the world and stay
          there: red is world X at every angle the object is ever turned to.
          Axes that rode the object had the property every rotation gesture has
          to fight -- turning a thing moves the very handles you turn it by, so
          a second turn is aimed at arrows the first one carried off, and there
          is no way back to square except by eye. Fixed axes are a frame to work
          against.

          A Scale arrow is the one that cannot be: it resizes one of the
          object's OWN three dimensions, and there is no such thing as a box
          that is wider along world X. So in Scale the arrows ride the object,
          each one pointing down the side it grows. */}
      {selectionWearsGizmo({
        selected: selected !== null,
        hidden: gizmoHidden,
        cutActive,
        brushArmed,
        rulerSelected,
        sketchSelected,
        marqueeing,
      }) &&
        selected && (
          <TransformGizmo
            position={assemblyAnchor(selected)}
            rotation={
              gizmoParts(transformMode).local ? selected.transform.rotation : undefined
            }
            controlsRef={controlsRef}
            onGrab={(handle) => startGizmo(selected.id, handle)}
          />
        )}

      {doc.objects.map((object, rank) => {
        const geometry = geometries.get(object.id)
        if (!geometry) return null

        const isSelected = chosen.has(object.id)
        const bodyPaints = paints.get(object.id) ?? [object.id]
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
              // Keyed by the paint set, so a merge or an unmerge remounts the
              // mesh rather than editing a material array in place. React
              // detaching one material of several restores whatever the slot
              // held before it, which on a shrinking array is a stale entry --
              // and a stale material slot draws a group the wrong colour. An
              // eraser is one material whatever it is made of, so it keys as
              // itself and never shares a mesh with the solid branch.
              key={object.erase ? 'erase' : bodyPaints.join('|')}
              ref={registrarFor(object.id)}
              geometry={geometry}
              // A ghost casts no shadow. It is not there yet, and a shadow
              // under it would be the one part of the scene claiming it is.
              castShadow={!object.erase}
              receiveShadow={!object.erase}
              onPointerDown={(e) => onObjectPointerDown(e, object.id)}
              onContextMenu={(e) => {
                e.stopPropagation()
                const { clientX, clientY } = e.nativeEvent
                // Only a click, never the tail of a pan. See ObjectMenu.
                if (!isRightClick(clientX, clientY)) return
                openMenu(clientX, clientY, object.id)
              }}
            >
              {object.erase ? (
                <EraseBody
                  selected={isSelected}
                  bias={depthBias(rank, doc.objects.length)}
                />
              ) : (
                <Body
                  paints={bodyPaints}
                  colors={assemblyColors(object)}
                  selected={isSelected}
                  bias={depthBias(rank, doc.objects.length)}
                />
              )}
              {/* Edge outlines read as CAD, but rebuilding them every frame
                  competes with the boolean solve, so they are dropped for the
                  duration of a drag.

                  And they are a preference: Settings can put them away for
                  good, selected objects included. Nothing is lost by that --
                  a chosen solid is lit by its own material as well as ringed,
                  so selection still reads with every line in the scene gone. */}
              {showOutlines && !dragging && (
                <Edges
                  threshold={18}
                  color={
                    object.erase
                      ? scene.eraseEdge
                      : isSelected
                        ? scene.edgeSelected
                        : scene.edgeIdle
                  }
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
                {/* Stood down by exactly what stands the object's gizmo down:
                    the picker governs both, and a torch held against a solid is
                    no more able to work around a sketch's arrows than around an
                    object's. */}
                {!cutActive && !brushArmed && !gizmoHidden && (
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
