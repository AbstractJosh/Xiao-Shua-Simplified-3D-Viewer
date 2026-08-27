import { create } from 'zustand'
import { Vector3, type BufferGeometry } from 'three'
import type {
  BaseSolid,
  Doc,
  Feature,
  ObjectTransform,
  SceneObject,
  Shape2D,
  SurfaceAnchor,
  Vec2,
  Vec3,
} from '../geometry/types'
import {
  cloneObject,
  defaultFeature,
  makeObject,
  nextFeatureId,
  nextObjectId,
  solidLabel,
} from '../geometry/types'
import { clampDepth, conform, hostSurfaceFor, reseat, surfaceFor } from '../geometry/surfaces'
import { assemblyBounds, assemblyParams, scaleAssembly } from '../geometry/assembly'
import { baseParams } from '../geometry/dimensions'
import { planeSeparates, splitPlanes } from '../geometry/cut'
import { evaluateObject, removesMaterial, worldBounds } from '../geometry/evaluate'
import { relativeTransform, toLocalDir, toLocalPoint } from '../geometry/transform'
// Type only, and the one thing this store borrows from the other. A ruler
// belongs to the tool store -- measuring is not an edit -- but the gesture that
// drags one of its ends is dispatched from `Drag` like every other, and naming
// which end is the tool store's word to define.
import type { RulerEnd } from './toolStore'

/** Depth the Extrude button gives a flat sketch, so the slider has somewhere
 *  to start from. Every other way in writes a depth of its own.
 *
 *  15 mm, against the 10 cm span a fresh solid lands at: enough that the first
 *  press reads as a boss standing off a face, not as a second solid. */
export const DEFAULT_FEATURE_DEPTH = 0.15

/** A template's position before the drop decides one. */
const ZERO: Vec3 = [0, 0, 0]

/** Daylight between a pasted copy and the object it came from -- a fifth of a
 *  default solid's span, which is wide enough to read as two objects and narrow
 *  enough that the copy lands where you were already looking. */
const PASTE_GAP = 0.2

export type Drag =
  | { kind: 'idle' }
  /**
   * Dragging a solid in from the console; position is null while it has nowhere
   * valid to land.
   *
   * Carries a whole `SceneObject` rather than a `BaseSolid` because the two
   * sources of this gesture are the palette, whose templates are bare
   * primitives, and the clipboard, whose templates are things the user built --
   * features, cuts, merged parts and a rotation of their own. Reducing the
   * second to its host primitive on the way in would drop everything that made
   * it worth saving.
   */
  | { kind: 'placing-solid'; template: SceneObject; position: Vec3 | null }
  /** Dragging a fresh sketch from the console; objectId/anchor are null while
   *  the pointer is off every object. */
  | { kind: 'placing'; shape: Shape2D; objectId: string | null; anchor: SurfaceAnchor | null }
  /**
   * Sliding an existing sketch across its surface. `snapshot` records whether
   * this gesture has already pushed a history entry, so undo rewinds the whole
   * drag -- and a click that never moved anything costs no undo step at all.
   */
  | { kind: 'moving'; objectId: string; id: string; snapshot: boolean }
  /** Sliding a whole object through the scene. Same snapshot rule. */
  | { kind: 'moving-object'; objectId: string; snapshot: boolean }
  /** Dragging the created end face of a feature sideways. Same snapshot rule. */
  | { kind: 'moving-face'; objectId: string; id: string; snapshot: boolean }
  /**
   * Dragging one handle of an object's gizmo: an arrow to slide it along that
   * axis, the same arrow with the right button to resize along it, or the ring
   * to scale the whole solid. Same snapshot rule.
   */
  | { kind: 'gizmo'; objectId: string; handle: GizmoHandle; snapshot: boolean }
  /**
   * Sliding a sketch along ONE of its host surface's tangents, from that
   * sketch's own gizmo. `axis` is 0 for the surface's U direction and 1 for V;
   * there is no third, because leaving the face is not a slide across it.
   */
  | {
      kind: 'sketch-gizmo'
      objectId: string
      id: string
      /**
       * The same handle type as the object gizmo, because it is the same gizmo.
       * Only axes 0 and 1 are ever drawn -- a sketch has two directions, the
       * surface's U and V -- and the ring both sizes and turns it.
       */
      handle: GizmoHandle
      snapshot: boolean
    }
  /**
   * The same handles on the cut plane's gizmo.
   *
   * A separate kind, and one carrying NO snapshot flag, because the plane lives
   * in the tool store: aiming it is not an edit to the document and must not
   * land in undo history. What it shares with the object gizmo is the gesture,
   * which is why the handle type is the same one.
   */
  | { kind: 'cut-gizmo'; handle: GizmoHandle }
  /**
   * One end of a ruler being dragged, by the gizmo standing on it.
   *
   * Here, alongside the cut plane's, although a ruler lives in the tool store
   * too: this union is the single dispatch table the viewport's frame loop
   * switches on, and a gesture missing from it is a gesture that never gets a
   * frame. Like the cut plane's, it carries no snapshot flag -- measuring a
   * scene is not an edit to it, and must not land in undo history.
   *
   * Only `move` handles are ever drawn on a ruler: an end is a point, so there
   * is nothing to resize along an axis and nothing to turn. See `Rulers.tsx`.
   */
  | { kind: 'ruler-gizmo'; rulerId: string; end: RulerEnd; handle: GizmoHandle }

/** Which arrow of a gizmo, in the gizmo's own frame. */
export type GizmoAxis = 0 | 1 | 2

/**
 * One grabbable part of a gizmo.
 *
 * `move` slides along the axis and `size` resizes along it -- the left and
 * right buttons on the same arrow. The ring is a `size` with no axis, because
 * scaling everything at once is the one operation that has no direction.
 *
 * `plane` is the ring's understudy: hold Control and the ring gives way to
 * three quads, and dragging one slides the target within that plane. It is a
 * `move` in every way that matters -- the same gesture, the same snapping, the
 * same history semantics -- and a mode of its own only because what the pointer
 * is measured against is a plane rather than a line.
 */
export type GizmoHandle =
  | { mode: 'move'; axis: GizmoAxis }
  /**
   * One of the three plane handles, named by the axis it is NORMAL to: 0 is the
   * YZ plane, 1 is XZ, 2 is XY.
   *
   * Named by the normal rather than by the pair it spans because that is the
   * one axis the drag does NOT move along, which is the whole of what the
   * handle promises -- and because it makes the plane an ordinary `GizmoAxis`,
   * so it colours itself from the same three values the arrows do and needs no
   * second vocabulary anywhere downstream.
   */
  | { mode: 'plane'; axis: GizmoAxis }
  | { mode: 'size'; axis: GizmoAxis }
  | { mode: 'size'; axis: 'all' }
  /**
   * The ring's right-drag. No axis of its own: the axis is chosen at grab time
   * as whichever of the target's three best faces the viewer, so the turn reads
   * as a twist of the screen rather than a tumble in some direction the gesture
   * never suggested.
   */
  | { mode: 'rotate'; axis: 'all' }

/** The drag kinds that carry a history snapshot flag. */
type MovingDrag = Extract<Drag, { snapshot: boolean }>

/**
 * The app opens on the gesture everything else is built around: drag a solid in
 * from the palette. A seeded object would also be the one solid in the scene
 * that does NOT rest on the grid, since only the drop path lifts a primitive by
 * its own -bounds().min.y.
 */
const DEFAULT_DOC: Doc = { objects: [] }

type State = {
  doc: Doc
  /**
   * Everything selected, PRIMARY FIRST.
   *
   * A list rather than a single id because merging needs to name more than one
   * object, and a second selection concept alongside the first would be two
   * things to keep in step. Every consumer that only cares about one object
   * reads the `selectedObjectId` selector, which is the head of this -- so
   * there is exactly one place the two ideas can ever disagree, and it is a
   * derivation rather than a second copy.
   *
   * Primary first, not last, so "merge into the first thing you picked" is a
   * rule the user can hold.
   */
  selectedObjectIds: string[]
  selectedFeatureId: string | null
  drag: Drag
  past: Doc[]
  future: Doc[]

  selectObject: (id: string | null) => void
  /**
   * Replace the whole selection at once, PRIMARY FIRST.
   *
   * What a marquee produces: a click can only ever name one object, and
   * toggling ids one at a time would re-render the scene once per object the
   * box happened to sweep over.
   */
  selectObjects: (ids: string[]) => void
  /** Add or remove one object without disturbing the rest of the selection. */
  toggleObjectSelection: (id: string) => void
  selectFeature: (objectId: string | null, featureId: string | null) => void
  /**
   * Weld every object after the first into the first, as merged parts.
   * Returns how many were absorbed.
   */
  mergeObjects: (ids: string[]) => number

  /**
   * Begin dragging a primitive in from the Solids list.
   *
   * `erase` makes it an ERASER: the same solid, aimed the same way, drawn as a
   * translucent red ghost and taking nothing away until it is confirmed. It is
   * a flag on the object rather than a separate gesture because everything
   * after the drop -- moving, turning, resizing, snapping -- is identical, and
   * a second placement path would be a second set of bugs.
   */
  startPlacingSolid: (base: BaseSolid, erase?: boolean) => void
  updatePlacingSolid: (position: Vec3 | null) => void
  commitPlacingSolid: () => void

  /** `erase` drops it as an eraser rather than as a solid. See
   *  `startPlacingSolid`; this is the keyboard's way in. */
  addObject: (base: BaseSolid, position: Vec3, erase?: boolean) => string
  /**
   * Drop a copy of an object into the scene, clear of whatever it was copied
   * from. Returns the new object's id.
   */
  pasteObject: (object: SceneObject) => string
  removeObject: (id: string) => void
  /**
   * Move an object up or down the scene list -- `-1` toward the top, `+1`
   * toward the bottom -- and with it, its rendering priority.
   *
   * The list has always been an order; this is what makes the order MEAN
   * something. Where two solids present the very same surface -- the commonest
   * case being two overlapping objects severed by one cut plane, whose caps are
   * then coplanar and overlapping -- the depth buffer has no tiebreak and the
   * shared face tears into a stipple of both colours. Which of them ought to
   * win is not a question geometry can answer, so it is put to the user as the
   * one control that can: position in the tree. Higher wins. See `depthBias`.
   *
   * A delta rather than a target index because the control is a pair of arrows
   * on a row, and clamping "already at the top" to a no-op here keeps the
   * button from spending an undo step on nothing.
   */
  moveObject: (id: string, delta: number) => void
  setObjectTransform: (id: string, transform: ObjectTransform) => void
  patchObject: (id: string, patch: Partial<SceneObject>) => void
  /**
   * Paint every named object one colour.
   *
   * Takes the whole list rather than being called once per id because an Apply
   * aimed at five selected solids is ONE thing the user did, and five
   * `patchObject` calls would be five undo steps to walk back out of -- the
   * same reason `mergeObjects` takes a list. It is also why this does not go
   * through `commitCoalesced`: colouring is a button press, not a slider being
   * dragged, so there is no run of near-identical edits to fold and no window
   * in which a second, deliberate Apply should disappear into the first.
   */
  setObjectColor: (ids: string[], color: string) => void

  /**
   * Begin dragging a solid in. The template's own position is ignored -- the
   * drop decides that -- but its rotation and everything hanging off it come
   * along.
   */
  startPlacingSolidTemplate: (template: SceneObject) => void

  /** Takes a full shape, so the palette can vary polygon side counts. */
  startPlacing: (shape: Shape2D) => void
  updatePlacing: (objectId: string | null, anchor: SurfaceAnchor | null) => void
  commitPlacing: () => void

  startMoving: (objectId: string, featureId: string) => void
  moveTo: (anchor: SurfaceAnchor) => void
  endDrag: () => void

  startMovingObject: (objectId: string) => void
  moveObjectTo: (position: Vec3) => void

  startMovingFace: (objectId: string, featureId: string) => void
  moveFaceTo: (faceOffset: Vec2) => void

  startGizmo: (objectId: string, handle: GizmoHandle) => void
  startSketchGizmo: (objectId: string, featureId: string, handle: GizmoHandle) => void
  /** The continuous part of a sketch ring drag: one history entry per gesture. */
  resizeShapeTo: (shape: Shape2D) => void
  /** The sketch's spin within its own tangent frame, in radians. */
  rotateShapeTo: (rotation: number) => void
  startCutGizmo: (handle: GizmoHandle) => void
  startRulerGizmo: (rulerId: string, end: RulerEnd, handle: GizmoHandle) => void
  /**
   * The continuous part of a gizmo resize: one history entry per gesture.
   *
   * Writes the object's OWN primitive, which is all a per-axis drag can mean --
   * a merged object has no single width to write, so its arrows scale it
   * through `scaleObjectTo` instead.
   */
  resizeObjectTo: (base: BaseSolid) => void
  /**
   * Scale the whole object -- every solid merged into it -- about its centre.
   *
   * Its own action rather than a `patchObject` call because a scale touches the
   * base, the parts, their offsets and the transform at once, and because it is
   * relative: the panel reads the size back out of the object to work out what
   * factor to ask for.
   */
  scaleObject: (id: string, factor: number) => void
  /**
   * The continuous part of a gizmo scale, measured from the object as it stood
   * when the gesture began.
   *
   * Takes that snapshot rather than reading the live object for the reason
   * `gizmoDrag.ts` gives at length: a factor applied to the result of the last
   * factor accumulates, and once the scale clamps at a limit an accumulating
   * drag keeps swallowing travel the pointer then has to give back.
   */
  scaleObjectTo: (snapshot: SceneObject, factor: number) => void

  patchFeature: (objectId: string, featureId: string, patch: Partial<Feature>) => void
  /**
   * Set a feature's SIGNED depth, held inside what its surface allows each way.
   *
   * Its own action rather than a `patchFeature` call because the clamp is not
   * optional and there are now three ways to change a depth -- the slider, the
   * Extrude button, and the gizmo's normal arrow. A limit only two of them
   * honoured would let one build a feature the other two then refused to show.
   */
  setDepth: (objectId: string, featureId: string, depth: number) => void
  /** The continuous part of a depth drag: one history entry per gesture. */
  depthTo: (depth: number) => void
  removeFeature: (objectId: string, featureId: string) => void
  toggleFeature: (objectId: string, featureId: string) => void

  /** Returns how many objects the plane genuinely severed. */
  applyCut: (originWorld: Vec3, normalWorld: Vec3, targetObjectIds: string[]) => number

  /**
   * Subtract an eraser from the objects it overlaps, and consume it.
   *
   * ONE WAY. The eraser leaves the scene and each object it cut keeps the hole
   * as a negative solid it can no longer reach -- see `SceneObject.erased`. Undo
   * puts the whole thing back in a single step, which is the only way back.
   *
   * `targetObjectIds` is the candidate list, so the caller decides whether that
   * means every object in the scene or only the ones selected alongside the
   * eraser. Whatever the list, an object the eraser does not actually take
   * material out of is left alone rather than made to carry a hole that removes
   * nothing and costs a boolean on every evaluation for ever.
   *
   * Returns how many objects genuinely lost material.
   */
  applyErase: (eraserId: string, targetObjectIds: string[]) => number

  undo: () => void
  redo: () => void
  reset: () => void
}

const HISTORY_LIMIT = 50

const mapObject =
  (id: string, fn: (o: SceneObject) => SceneObject) =>
  (doc: Doc): Doc => ({
    objects: doc.objects.map((o) => (o.id === id ? fn(o) : o)),
  })

const mapFeature = (
  objectId: string,
  featureId: string,
  fn: (f: Feature) => Feature
) =>
  mapObject(objectId, (o) => ({
    ...o,
    features: o.features.map((f) => (f.id === featureId ? fn(f) : f)),
  }))

/**
 * Below this, a "move" is pointer jitter rather than an edit. Real drags move
 * by pixels, which is orders of magnitude more, so the only thing this rejects
 * is a value that was recomputed to the same place.
 */
const MOVE_EPS = 1e-9

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) <= MOVE_EPS)

/** An anchor's parameters in a fixed order, so two can be compared numerically. */
const anchorParams = (a: SurfaceAnchor): number[] => {
  switch (a.on) {
    case 'box-face':
      return [a.face, a.u, a.v]
    case 'planar-face':
      return [a.face, a.u, a.v]
    case 'sphere':
      return [a.theta, a.phi]
    case 'capsule':
      return [a.theta, a.phi]
    case 'cylinder':
      return [a.theta, a.y]
    case 'cone':
      return [a.theta, a.t]
    case 'derived':
      return [...a.point, ...a.normal]
  }
}

const sameAnchor = (a: SurfaceAnchor, b: SurfaceAnchor): boolean =>
  a.on === b.on && sameNumbers(anchorParams(a), anchorParams(b))

/** Same kind and same numbers. A resize that clamped to where it already was is
 *  not an edit, and must not cost an undo step. */
const sameBase = (a: BaseSolid, b: BaseSolid): boolean =>
  a.kind === b.kind && sameNumbers(baseParams(a), baseParams(b))

/** A shape's numbers in a fixed order, so two can be compared. */
const shapeParams = (s: Shape2D): number[] =>
  s.type === 'rect' ? [s.w, s.h] : s.type === 'ngon' ? [s.r, s.sides] : [s.r]

const sameShape = (a: Shape2D, b: Shape2D): boolean =>
  a.type === b.type && sameNumbers(shapeParams(a), shapeParams(b))

/** Two selections that name the same objects in the same order. */
const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

/** Selection survives an edit only while the thing it names still exists. */
const prune = (
  doc: Doc,
  objectIds: string[],
  featureId: string | null
): { selectedObjectIds: string[]; selectedFeatureId: string | null } => {
  const live = objectIds.filter((id) => doc.objects.some((o) => o.id === id))
  const primary = live.length === 0 ? undefined : doc.objects.find((o) => o.id === live[0])
  if (!primary) return { selectedObjectIds: [], selectedFeatureId: null }
  const keepFeature = featureId !== null && primary.features.some((f) => f.id === featureId)
  return { selectedObjectIds: live, selectedFeatureId: keepFeature ? featureId : null }
}

export const useDoc = create<State>((set, get) => {
  /** Mutate the document and record a history entry. */
  const commit = (fn: (doc: Doc) => Doc) =>
    set((s) => ({
      doc: fn(s.doc),
      past: [...s.past, s.doc].slice(-HISTORY_LIMIT),
      future: [],
    }))

  /**
   * Mutate without touching history. Used for the continuous part of a drag:
   * one history entry is recorded when the drag first MOVES, so undo rewinds
   * the whole gesture rather than one mouse-move of it.
   */
  const silent = (fn: (doc: Doc) => Doc) => set((s) => ({ doc: fn(s.doc) }))

  // Dragging a slider fires a change per pixel. Without coalescing, one size
  // tweak buries the undo stack under fifty near-identical entries.
  let lastKey = ''
  let lastAt = 0
  // The document this coalescing run last produced. Folding is only sound while
  // the run is UNBROKEN: an undo, a drag, or any other commit in between leaves
  // the previous history entry describing a state that is no longer the one
  // before this edit, so folding into it would make a single undo revert two
  // separate operations. Every doc-producing path builds a fresh object, so
  // identity is an exact test for "nothing happened in between" -- and it
  // invalidates itself, rather than relying on every future action to remember.
  let lastDoc: Doc | null = null
  const COALESCE_MS = 600

  /** Commit, folding into the previous entry if it was the same edit just now. */
  const commitCoalesced = (key: string, fn: (doc: Doc) => Doc) =>
    set((s) => {
      const now = Date.now()
      const next = fn(s.doc)
      const fold = key === lastKey && now - lastAt < COALESCE_MS && s.doc === lastDoc
      lastKey = key
      lastAt = now
      lastDoc = next
      return {
        doc: next,
        past: fold ? s.past : [...s.past, s.doc].slice(-HISTORY_LIMIT),
        future: [],
      }
    })

  /**
   * History is recorded on the first real movement of a drag, not on
   * pointer-down: selecting a sketch or an object should not leave an undo step
   * that does nothing.
   */
  const snapshotOnce = () =>
    set((s) => {
      const drag = s.drag
      if (!('snapshot' in drag) || drag.snapshot) return {}
      const moved: MovingDrag = { ...drag, snapshot: true }
      return {
        past: [...s.past, s.doc].slice(-HISTORY_LIMIT),
        future: [],
        drag: moved,
      }
    })

  return {
    doc: DEFAULT_DOC,
    selectedObjectIds: [],
    selectedFeatureId: null,
    drag: { kind: 'idle' },
    past: [],
    future: [],

    selectObject: (id) =>
      set((s) => ({
        // Replaces the whole selection: a plain click is how you say "just this
        // one", and it has to be able to undo a multi-select.
        selectedObjectIds: id === null ? [] : [id],
        // A feature id only means something alongside its object.
        selectedFeatureId: id === s.selectedObjectIds[0] ? s.selectedFeatureId : null,
      })),

    selectObjects: (ids) =>
      set((s) => {
        // A marquee re-decides this on every pointer move, and almost every one
        // of those moves lands on the same set. Handing back a fresh array
        // anyway would re-render every object in the scene at pointer rate,
        // since the selection is compared by identity like all zustand state.
        if (sameIds(ids, s.selectedObjectIds)) return {}
        return {
          selectedObjectIds: ids,
          // The feature belonged to the primary, and this may have replaced it.
          selectedFeatureId: ids[0] === s.selectedObjectIds[0] ? s.selectedFeatureId : null,
        }
      }),

    toggleObjectSelection: (id) =>
      set((s) => {
        const has = s.selectedObjectIds.includes(id)
        const next = has
          ? s.selectedObjectIds.filter((other) => other !== id)
          : [...s.selectedObjectIds, id]
        return {
          selectedObjectIds: next,
          // The feature belonged to the primary. Anything that changes which
          // object leads takes the sketch selection with it.
          selectedFeatureId: next[0] === s.selectedObjectIds[0] ? s.selectedFeatureId : null,
        }
      }),

    selectFeature: (objectId, featureId) =>
      set({
        selectedObjectIds: objectId === null ? [] : [objectId],
        selectedFeatureId: featureId,
      }),

    mergeObjects: (ids) => {
      const { doc } = get()
      const chosen = ids
        .map((id) => doc.objects.find((o) => o.id === id))
        // An eraser is a tool, not a part. Skipped rather than refused: a
        // selection holding an eraser and two solids is a selection where the
        // two solids are what the user meant to weld together.
        .filter((o): o is SceneObject => o !== undefined && !o.erase)
      if (chosen.length < 2) return 0

      const [host, ...rest] = chosen
      // Each absorbed object keeps everything it had -- base, features, cuts,
      // its own parts -- and only its transform is rewritten, from world space
      // into the host's. So it does not move a millimetre, and an unmerge would
      // have everything it needs to put it back.
      const parts = rest.map((other) => ({
        ...other,
        transform: relativeTransform(host.transform, other.transform),
      }))
      const absorbed = new Set(rest.map((o) => o.id))

      commit((d) => ({
        objects: d.objects
          .filter((o) => !absorbed.has(o.id))
          .map((o) => (o.id === host.id ? { ...o, parts: [...o.parts, ...parts] } : o)),
      }))
      // The merged object is one object, so it is one selection. The feature
      // goes with it: a sketch on an absorbed object is inside a part now, and
      // nothing in the console is pointed at those yet.
      set({ selectedObjectIds: [host.id], selectedFeatureId: null })
      return rest.length
    },

    startPlacingSolid: (base, erase = false) =>
      set({
        drag: {
          kind: 'placing-solid',
          template: erase
            ? { ...makeObject(base, ZERO), name: `${solidLabel(base)} eraser`, erase: true }
            : makeObject(base, ZERO),
          position: null,
        },
      }),

    startPlacingSolidTemplate: (template) =>
      set({
        drag: {
          kind: 'placing-solid',
          // Reminted here rather than on release: the ghost, the drop snap and
          // the object that lands are then all the same object, and a gesture
          // abandoned off-canvas costs nothing but the ids it minted.
          template: { ...cloneObject(template), transform: { ...template.transform, position: ZERO } },
          position: null,
        },
      }),

    updatePlacingSolid: (position) =>
      set((s) => (s.drag.kind === 'placing-solid' ? { drag: { ...s.drag, position } } : {})),

    commitPlacingSolid: () => {
      const { drag } = get()
      if (drag.kind !== 'placing-solid') return
      if (!drag.position) {
        // Released with nowhere to land: cancel cleanly, leaving no stray object.
        set({ drag: { kind: 'idle' } })
        return
      }
      const object = {
        ...drag.template,
        transform: { ...drag.template.transform, position: drag.position },
      }
      commit((d) => ({ objects: [...d.objects, object] }))
      set({ drag: { kind: 'idle' }, selectedObjectIds: [object.id], selectedFeatureId: null })
    },

    addObject: (base, position, erase = false) => {
      const plain = makeObject(base, position)
      const object = erase
        ? { ...plain, name: `${solidLabel(base)} eraser`, erase: true }
        : plain
      commit((d) => ({ objects: [...d.objects, object] }))
      set({ selectedObjectIds: [object.id], selectedFeatureId: null })
      return object.id
    },

    pasteObject: (object) => {
      const copy = cloneObject(object)
      // Set down beside the original rather than exactly on top of it: pasted
      // in place, a copy is invisible, and the user's next move is to drag one
      // off the other without being able to tell which one they have hold of.
      // Cleared by the object's OWN width, so the gap reads the same whether
      // the thing copied is a bead or a wall.
      const bounds = assemblyBounds(copy)
      const width = Math.max(0, bounds.max.x - bounds.min.x)
      const [x, y, z] = copy.transform.position
      const placed: SceneObject = {
        ...copy,
        transform: { ...copy.transform, position: [x + width + PASTE_GAP, y, z] },
      }
      commit((d) => ({ objects: [...d.objects, placed] }))
      set({ selectedObjectIds: [placed.id], selectedFeatureId: null })
      return placed.id
    },

    moveObject: (id, delta) => {
      const { doc } = get()
      const from = doc.objects.findIndex((o) => o.id === id)
      if (from < 0 || delta === 0) return
      const to = Math.min(doc.objects.length - 1, Math.max(0, from + delta))
      // Already at the end it was asked to move toward. Not an edit, and an
      // undo step for it would bury the edit before it -- the same rule Apply
      // follows in `setObjectColor`.
      if (to === from) return

      commit((d) => {
        const objects = [...d.objects]
        const [moved] = objects.splice(from, 1)
        objects.splice(to, 0, moved)
        return { objects }
      })
    },

    removeObject: (id) => {
      commit((d) => ({ objects: d.objects.filter((o) => o.id !== id) }))
      set((s) => ({
        ...prune(s.doc, s.selectedObjectIds, s.selectedFeatureId),
        // A drag pointing at a deleted object has nothing left to move.
        drag: 'objectId' in s.drag && s.drag.objectId === id ? { kind: 'idle' } : s.drag,
      }))
    },

    setObjectTransform: (id, transform) => {
      const { drag, doc } = get()
      // Two live gestures write here: the body drag, and the gizmo ring's turn.
      // Both are the continuous part of one gesture, so both take a single
      // snapshot and then write silently.
      const live =
        (drag.kind === 'moving-object' || drag.kind === 'gizmo') && drag.objectId === id
      if (live) {
        const object = doc.objects.find((o) => o.id === id)
        // A frame that resolved to the transform the object already has is not
        // an edit, and must not cost an undo step.
        if (
          object &&
          sameNumbers(object.transform.position, transform.position) &&
          sameNumbers(object.transform.rotation, transform.rotation)
        ) {
          return
        }
        snapshotOnce()
        silent(mapObject(id, (o) => ({ ...o, transform })))
        return
      }
      // Outside a drag this is a typed-in or nudged value, which deserves its
      // own undo step -- coalesced, because arrow keys repeat.
      commitCoalesced(`transform:${id}`, mapObject(id, (o) => ({ ...o, transform })))
    },

    patchObject: (id, patch) =>
      commitCoalesced(
        `object:${id}:${Object.keys(patch).join(',')}`,
        mapObject(id, (o) => {
          const next = { ...o, ...patch }
          if (patch.base === undefined) return next
          // Anchors live in their surface's own parameter space, so they only
          // survive a base edit that keeps the same KIND of surface: a box
          // growing, not a box turning into a sphere. Stranded sketches would
          // otherwise float beside the solid with no way to grab them.
          const kept =
            surfaceFor(o.base).kind === surfaceFor(next.base).kind ? next.features : []
          return { ...next, features: kept.map((f) => conform(next.base, f)) }
        })
      ),

    setObjectColor: (ids, color) => {
      const targets = new Set(ids)
      if (targets.size === 0) return

      // Right the way down. A merged object draws each solid in it in that
      // solid's own colour -- which is what keeps the colours of the things
      // that went into a merge -- so painting only the host would leave every
      // part it absorbed wearing what it came in with, and Apply on an assembly
      // would repaint a fraction of what the user had selected.
      const repaint = (o: SceneObject): SceneObject => ({
        ...o,
        color,
        parts: o.parts.map(repaint),
      })
      // An Apply that repaints objects the colour they already wear changed
      // nothing, and must not cost an undo step -- the button is easy to press
      // twice, and the second press would otherwise bury the edit before it.
      const wears = (o: SceneObject): boolean =>
        o.color === color && o.parts.every(wears)
      const painted = (o: SceneObject) => !targets.has(o.id) || wears(o)
      if (get().doc.objects.every(painted)) return
      commit((d) => ({
        objects: d.objects.map((o) => (targets.has(o.id) ? repaint(o) : o)),
      }))
    },

    startPlacing: (shape) =>
      set({ drag: { kind: 'placing', shape, objectId: null, anchor: null } }),

    updatePlacing: (objectId, anchor) =>
      set((s) => (s.drag.kind === 'placing' ? { drag: { ...s.drag, objectId, anchor } } : {})),

    commitPlacing: () => {
      const { drag, doc } = get()
      if (drag.kind !== 'placing') return
      const object =
        drag.objectId === null ? undefined : doc.objects.find((o) => o.id === drag.objectId)
      if (!object || !drag.anchor) {
        // Released off every object: cancel cleanly, leaving no stray feature.
        set({ drag: { kind: 'idle' } })
        return
      }
      const host = hostSurfaceFor(object.base, drag.anchor)
      const feature = defaultFeature(host.clampAnchor(drag.anchor, drag.shape), drag.shape)
      commit(mapObject(object.id, (o) => ({ ...o, features: [...o.features, feature] })))
      set({
        drag: { kind: 'idle' },
        selectedObjectIds: [object.id],
        selectedFeatureId: feature.id,
      })
    },

    startMoving: (objectId, featureId) =>
      set({
        drag: { kind: 'moving', objectId, id: featureId, snapshot: false },
        selectedObjectIds: [objectId],
        selectedFeatureId: featureId,
      }),

    moveTo: (anchor) => {
      const { drag, doc } = get()
      // TWO gestures move a sketch: dragging it freely across its host, and
      // dragging one arrow of its gizmo along a single tangent. They differ
      // only in how the anchor was arrived at -- the edit, the clamp and the
      // history semantics are identical -- so both land here rather than the
      // second growing a parallel action to keep in step with this one.
      if (drag.kind !== 'moving' && drag.kind !== 'sketch-gizmo') return
      const object = doc.objects.find((o) => o.id === drag.objectId)
      const feature = object?.features.find((f) => f.id === drag.id)
      if (!object || !feature) return

      // Clamp BEFORE deciding anything: a pointer pushed past the edge of a face
      // resolves to the anchor the sketch already has, and that is not a move.
      const next = hostSurfaceFor(object.base, anchor).clampAnchor(anchor, feature.shape)
      if (sameAnchor(next, feature.anchor)) return

      snapshotOnce()
      silent(mapFeature(drag.objectId, drag.id, (f) => ({ ...f, anchor: next })))
    },

    endDrag: () => set({ drag: { kind: 'idle' } }),

    startMovingObject: (objectId) =>
      set((s) => ({
        drag: { kind: 'moving-object', objectId, snapshot: false },
        selectedObjectIds: [objectId],
        selectedFeatureId: s.selectedObjectIds[0] === objectId ? s.selectedFeatureId : null,
      })),

    moveObjectTo: (position) => {
      const { drag, doc } = get()
      // TWO gestures move an object: dragging its body across the ground, and
      // dragging one arrow of its gizmo along an axis. They differ only in how
      // the position was arrived at -- the edit, and its history semantics, are
      // the same -- so both land here rather than the second one growing a
      // parallel action that would have to be kept in step with this one.
      if (drag.kind !== 'moving-object' && drag.kind !== 'gizmo') return
      const object = doc.objects.find((o) => o.id === drag.objectId)
      if (!object) return
      // A click that snapped straight back to where the object already was is
      // not an edit, and must not cost an undo step.
      if (sameNumbers(object.transform.position, position)) return

      snapshotOnce()
      silent(
        mapObject(drag.objectId, (o) => ({ ...o, transform: { ...o.transform, position } }))
      )
    },

    startGizmo: (objectId, handle) =>
      set((s) => ({
        drag: { kind: 'gizmo', objectId, handle, snapshot: false },
        selectedObjectIds: [objectId],
        selectedFeatureId: s.selectedObjectIds[0] === objectId ? s.selectedFeatureId : null,
      })),

    startSketchGizmo: (objectId, featureId, handle) =>
      set({
        drag: { kind: 'sketch-gizmo', objectId, id: featureId, handle, snapshot: false },
        selectedObjectIds: [objectId],
        selectedFeatureId: featureId,
      }),

    resizeShapeTo: (shape) => {
      const { drag, doc } = get()
      if (drag.kind !== 'sketch-gizmo') return
      const object = doc.objects.find((o) => o.id === drag.objectId)
      const feature = object?.features.find((f) => f.id === drag.id)
      if (!object || !feature) return
      // A frame that clamped back to the size it already had is not an edit,
      // and must not cost an undo step.
      if (sameShape(feature.shape, shape)) return

      snapshotOnce()
      // `reseat` for the same reason `patchFeature` uses it: a sketch that just
      // grew can overhang the face it sits on, and the clamp pulls it back on
      // rather than leaving an outline hanging off the edge.
      silent(
        mapObject(drag.objectId, (o) => ({
          ...o,
          features: o.features.map((f) =>
            f.id === drag.id ? reseat(o.base, { ...f, shape }) : f
          ),
        }))
      )
    },

    rotateShapeTo: (rotation) => {
      const { drag, doc } = get()
      if (drag.kind !== 'sketch-gizmo') return
      const feature = doc.objects
        .find((o) => o.id === drag.objectId)
        ?.features.find((f) => f.id === drag.id)
      if (!feature) return
      if (Math.abs(feature.rotation - rotation) <= MOVE_EPS) return

      snapshotOnce()
      // No reseat: spinning an outline about its own centre cannot push it off
      // a face its bounding circle already fits inside.
      silent(mapFeature(drag.objectId, drag.id, (f) => ({ ...f, rotation })))
    },

    startCutGizmo: (handle) => set({ drag: { kind: 'cut-gizmo', handle } }),

    // No selection written alongside it, unlike the object and sketch gizmos:
    // a ruler's gizmo only exists on the ruler that is already selected, so
    // there is nothing here for the press to pick.
    startRulerGizmo: (rulerId, end, handle) =>
      set({ drag: { kind: 'ruler-gizmo', rulerId, end, handle } }),

    scaleObject: (id, factor) =>
      commitCoalesced(
        `scale:${id}`,
        mapObject(id, (o) => scaleAssembly(o, factor))
      ),

    scaleObjectTo: (snapshot, factor) => {
      const { drag, doc } = get()
      if (drag.kind !== 'gizmo') return
      const object = doc.objects.find((o) => o.id === drag.objectId)
      if (!object) return

      const next = scaleAssembly(snapshot, factor)
      // A frame that resolved to the size the object already has is not an
      // edit, and must not cost an undo step -- which is exactly what every
      // frame is once a runaway drag has pinned the scale at its limit. The
      // position is compared too, because scaling about the centre moves it.
      if (
        sameNumbers(assemblyParams(object), assemblyParams(next)) &&
        sameNumbers(object.transform.position, next.transform.position)
      ) {
        return
      }

      snapshotOnce()
      silent(mapObject(drag.objectId, () => next))
    },

    resizeObjectTo: (base) => {
      const { drag, doc } = get()
      if (drag.kind !== 'gizmo') return
      const object = doc.objects.find((o) => o.id === drag.objectId)
      if (!object) return

      // Resizing runs through the same conform pass `patchObject` uses, so a
      // sketch on a shrinking face is pulled back onto it and a pocket deeper
      // than the solid now is stands down -- rather than the drag quietly
      // leaving the feature list describing geometry that is no longer there.
      // The base KIND never changes here, so the features always survive.
      const next = { ...object, base, features: object.features.map((f) => conform(base, f)) }
      if (sameBase(object.base, base)) return

      snapshotOnce()
      silent(mapObject(drag.objectId, () => next))
    },

    startMovingFace: (objectId, featureId) =>
      set({
        drag: { kind: 'moving-face', objectId, id: featureId, snapshot: false },
        selectedObjectIds: [objectId],
        selectedFeatureId: featureId,
      }),

    moveFaceTo: (faceOffset) => {
      const { drag, doc } = get()
      if (drag.kind !== 'moving-face') return
      const feature = doc.objects
        .find((o) => o.id === drag.objectId)
        ?.features.find((f) => f.id === drag.id)
      if (!feature) return
      if (sameNumbers(feature.faceOffset, faceOffset)) return

      snapshotOnce()
      silent(mapFeature(drag.objectId, drag.id, (f) => ({ ...f, faceOffset })))
    },

    patchFeature: (objectId, featureId, patch) =>
      commitCoalesced(
        `feature:${objectId}:${featureId}:${Object.keys(patch).join(',')}`,
        mapObject(objectId, (o) => ({
          ...o,
          features: o.features.map((f) =>
            f.id === featureId ? reseat(o.base, { ...f, ...patch }) : f
          ),
        }))
      ),

    setDepth: (objectId, featureId, depth) =>
      commitCoalesced(
        `depth:${objectId}:${featureId}`,
        mapObject(objectId, (o) => ({
          ...o,
          features: o.features.map((f) =>
            f.id === featureId
              ? { ...f, depth: clampDepth(hostSurfaceFor(o.base, f.anchor), f.anchor, depth) }
              : f
          ),
        }))
      ),

    depthTo: (depth) => {
      const { drag, doc } = get()
      if (drag.kind !== 'sketch-gizmo') return
      const object = doc.objects.find((o) => o.id === drag.objectId)
      const feature = object?.features.find((f) => f.id === drag.id)
      if (!object || !feature) return

      const next = clampDepth(
        hostSurfaceFor(object.base, feature.anchor),
        feature.anchor,
        depth
      )
      // A frame that clamped back to the depth it already had is not an edit,
      // and must not cost an undo step -- which is what a drag pinned against
      // its limit produces, sixty times a second.
      if (Math.abs(next - feature.depth) < MOVE_EPS) return

      snapshotOnce()
      silent(mapFeature(drag.objectId, drag.id, (f) => ({ ...f, depth: next })))
    },

    removeFeature: (objectId, featureId) => {
      commit(
        mapObject(objectId, (o) => ({
          ...o,
          features: o.features.filter((f) => f.id !== featureId),
        }))
      )
      set((s) => ({
        selectedFeatureId: s.selectedFeatureId === featureId ? null : s.selectedFeatureId,
      }))
    },

    toggleFeature: (objectId, featureId) =>
      commit(mapFeature(objectId, featureId, (f) => ({ ...f, enabled: !f.enabled }))),

    /**
     * Sever every targeted object the plane genuinely passes through, replacing
     * each with two objects that keep the same base, transform and features and
     * differ only in which half-space they retain. The halves stay parametric,
     * so a feature edited afterwards still rebuilds on both.
     *
     * The plane arrives in world space because it is a scene-level gizmo, but a
     * cut has to be stored per object in LOCAL space -- otherwise moving a half
     * afterwards would drag its own cut plane along with it and the piece would
     * dissolve.
     */
    applyCut: (originWorld, normalWorld, targetObjectIds) => {
      const normal = new Vector3(normalWorld[0], normalWorld[1], normalWorld[2])
      if (normal.lengthSq() === 0) return 0
      normal.normalize()
      const origin = new Vector3(originWorld[0], originWorld[1], originWorld[2])
      const targets = new Set(targetObjectIds)

      const { doc } = get()
      const objects: SceneObject[] = []
      const renamed = new Map<string, string>()
      let split = 0

      for (const object of doc.objects) {
        if (!targets.has(object.id)) {
          objects.push(object)
          continue
        }

        const localOrigin = toLocalPoint(object.transform, origin)
        const localNormal = toLocalDir(object.transform, normal).normalize()

        let separates = false
        // `evaluateObject` hands over an uncached geometry that nobody else
        // holds, so this call owns it. Without the dispose every rejected cut
        // strands a mesh -- and a user hunting for the right plane makes a lot
        // of rejected cuts. The handle is hoisted so that a throw from the probe
        // itself, after the geometry exists, still frees it.
        let geometry: BufferGeometry | null = null
        try {
          geometry = evaluateObject(object).geometry
          separates = planeSeparates(geometry, localOrigin, localNormal)
        } catch {
          // An object the evaluator cannot build cannot be reasoned about
          // either; leave it whole rather than shattering it on a guess.
          separates = false
        } finally {
          geometry?.dispose()
        }
        if (!separates) {
          objects.push(object)
          continue
        }

        const [keepA, keepB] = splitPlanes(
          [localOrigin.x, localOrigin.y, localOrigin.z],
          [localNormal.x, localNormal.y, localNormal.z]
        )
        // Half A keeps the original feature ids because it is the selection
        // heir: a sketch selected before the cut stays selected after it. Half B
        // must be re-idded, because `EvalResult.failed` is a FLAT list of feature
        // ids -- duplicates across the two halves would report a feature that
        // failed on one half as failed on the other too.
        const halfA: SceneObject = {
          ...object,
          id: nextObjectId(),
          name: `${object.name} (A)`,
          features: object.features.map((f) => ({ ...f })),
          cuts: [...object.cuts, keepA],
        }
        const halfB: SceneObject = {
          ...object,
          id: nextObjectId(),
          name: `${object.name} (B)`,
          features: object.features.map((f) => ({ ...f, id: nextFeatureId() })),
          cuts: [...object.cuts, keepB],
        }
        objects.push(halfA, halfB)
        renamed.set(object.id, halfA.id)
        split += 1
      }

      if (split === 0) return 0

      // One history entry for the whole operation: undo puts the scene back
      // together in a single step, however many objects the plane crossed.
      commit(() => ({ objects }))
      // A selected object that was severed lives on as its first half, so the
      // inspector keeps showing something the user recognises.
      set((s) => ({
        selectedObjectIds: s.selectedObjectIds.map((id) => renamed.get(id) ?? id),
      }))
      return split
    },

    applyErase: (eraserId, targetObjectIds) => {
      const { doc } = get()
      const eraser = doc.objects.find((o) => o.id === eraserId)
      if (!eraser || !eraser.erase) return 0

      // Cheap reject first. Evaluating an object is a full replay of its
      // features and cuts, and a scene of a dozen solids where the eraser sits
      // inside one of them should not pay for the other eleven twice over.
      const reach = worldBounds(eraser)
      const candidates = new Set(targetObjectIds)
      const cut = new Map<string, SceneObject>()

      for (const target of doc.objects) {
        if (target.id === eraserId || target.erase || !candidates.has(target.id)) continue
        if (!reach.intersectsBox(worldBounds(target))) continue

        // Into the TARGET's own space, so the hole stays where it was aimed
        // however the object is moved or turned afterwards. Reminted on the way
        // in: the eraser is about to be deleted, and an id living on inside the
        // object it cut would collide with nothing today and with everything
        // the first time an unmerge or a paste went looking for it.
        const hole: SceneObject = {
          ...cloneObject(eraser),
          erase: undefined,
          transform: relativeTransform(target.transform, eraser.transform),
        }
        const holed: SceneObject = { ...target, erased: [...(target.erased ?? []), hole] }

        // The exact question, asked of the geometry rather than of the boxes:
        // did this actually take anything away? A box overlap is not an
        // intersection, and an eraser that grazes a corner without touching the
        // solid must not leave a hole behind that removes nothing.
        try {
          if (!removesMaterial(target, holed)) continue
        } catch {
          // An object the evaluator cannot build cannot be reasoned about
          // either; leave it whole rather than cutting it on a guess.
          continue
        }
        cut.set(target.id, holed)
      }

      if (cut.size === 0) return 0

      // One history entry for the whole act: the holes AND the eraser leaving,
      // so a single undo puts the eraser back exactly where it was aimed.
      commit((d) => ({
        objects: d.objects
          .filter((o) => o.id !== eraserId)
          .map((o) => cut.get(o.id) ?? o),
      }))
      set((s) => ({
        ...prune(s.doc, s.selectedObjectIds, s.selectedFeatureId),
        // A drag pointing at the eraser has nothing left to move.
        drag: 'objectId' in s.drag && s.drag.objectId === eraserId ? { kind: 'idle' } : s.drag,
      }))
      return cut.size
    },

    undo: () =>
      set((s) => {
        if (s.past.length === 0) return {}
        const doc = s.past[s.past.length - 1]
        return {
          doc,
          past: s.past.slice(0, -1),
          future: [s.doc, ...s.future].slice(0, HISTORY_LIMIT),
          drag: { kind: 'idle' },
          ...prune(doc, s.selectedObjectIds, s.selectedFeatureId),
        }
      }),

    redo: () =>
      set((s) => {
        if (s.future.length === 0) return {}
        const doc = s.future[0]
        return {
          doc,
          past: [...s.past, s.doc].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
          drag: { kind: 'idle' },
          ...prune(doc, s.selectedObjectIds, s.selectedFeatureId),
        }
      }),

    reset: () =>
      set({
        doc: DEFAULT_DOC,
        selectedObjectIds: [],
        selectedFeatureId: null,
        past: [],
        future: [],
        drag: { kind: 'idle' },
      }),
  }
})

/**
 * The one object every single-selection consumer means.
 *
 * A selector rather than a stored field, so the list is the only place a
 * selection lives and the two can never drift apart.
 */
export const selectedObjectId = (s: State): string | null => s.selectedObjectIds[0] ?? null

export const selectedObject = (s: State): SceneObject | null =>
  s.doc.objects.find((o) => o.id === selectedObjectId(s)) ?? null

export const selectedFeature = (s: State): Feature | null =>
  selectedObject(s)?.features.find((f) => f.id === s.selectedFeatureId) ?? null
