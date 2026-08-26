import { create } from 'zustand'
import { Vector3, type BufferGeometry } from 'three'
import type {
  BaseSolid,
  Doc,
  Feature,
  FeatureOp,
  ObjectTransform,
  SceneObject,
  Shape2D,
  SurfaceAnchor,
  Vec2,
  Vec3,
} from '../geometry/types'
import { defaultFeature, makeObject, nextFeatureId, nextObjectId } from '../geometry/types'
import { hostSurfaceFor, surfaceFor } from '../geometry/surfaces'
import { planeSeparates, splitPlanes } from '../geometry/cut'
import { evaluateObject } from '../geometry/evaluate'
import { toLocalDir, toLocalPoint } from '../geometry/transform'

/** Depth applied the moment a user picks extrude or intrude on a flat sketch. */
export const DEFAULT_FEATURE_DEPTH = 0.3

export type Drag =
  | { kind: 'idle' }
  /** Dragging a fresh primitive off the palette; position is null while it has
   *  nowhere valid to land. */
  | { kind: 'placing-solid'; base: BaseSolid; position: Vec3 | null }
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
  selectedObjectId: string | null
  selectedFeatureId: string | null
  drag: Drag
  past: Doc[]
  future: Doc[]

  selectObject: (id: string | null) => void
  selectFeature: (objectId: string | null, featureId: string | null) => void

  startPlacingSolid: (base: BaseSolid) => void
  updatePlacingSolid: (position: Vec3 | null) => void
  commitPlacingSolid: () => void

  addObject: (base: BaseSolid, position: Vec3) => string
  removeObject: (id: string) => void
  setObjectTransform: (id: string, transform: ObjectTransform) => void
  patchObject: (id: string, patch: Partial<SceneObject>) => void

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

  patchFeature: (objectId: string, featureId: string, patch: Partial<Feature>) => void
  setOp: (objectId: string, featureId: string, op: FeatureOp) => void
  removeFeature: (objectId: string, featureId: string) => void
  toggleFeature: (objectId: string, featureId: string) => void

  /** Returns how many objects the plane genuinely severed. */
  applyCut: (originWorld: Vec3, normalWorld: Vec3, targetObjectIds: string[]) => number

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

/** Any edit that resizes a sketch can push it off its face; pull it back on. */
const reseat = (base: BaseSolid, f: Feature): Feature => ({
  ...f,
  anchor: hostSurfaceFor(base, f.anchor).clampAnchor(f.anchor, f.shape),
})

/** Reseating plus a depth clamp, for edits that shrink the solid underneath. */
const conform = (base: BaseSolid, f: Feature): Feature => {
  const next = reseat(base, f)
  const limit = hostSurfaceFor(base, next.anchor).maxDepth(next.op, next.anchor)
  return { ...next, depth: Math.min(next.depth, limit) }
}

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

/** Selection survives an edit only while the thing it names still exists. */
const prune = (
  doc: Doc,
  objectId: string | null,
  featureId: string | null
): { selectedObjectId: string | null; selectedFeatureId: string | null } => {
  const obj = objectId === null ? undefined : doc.objects.find((o) => o.id === objectId)
  if (!obj) return { selectedObjectId: null, selectedFeatureId: null }
  const keepFeature = featureId !== null && obj.features.some((f) => f.id === featureId)
  return { selectedObjectId: obj.id, selectedFeatureId: keepFeature ? featureId : null }
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
    selectedObjectId: null,
    selectedFeatureId: null,
    drag: { kind: 'idle' },
    past: [],
    future: [],

    selectObject: (id) =>
      set((s) => ({
        selectedObjectId: id,
        // A feature id only means something alongside its object.
        selectedFeatureId: id === s.selectedObjectId ? s.selectedFeatureId : null,
      })),

    selectFeature: (objectId, featureId) =>
      set({ selectedObjectId: objectId, selectedFeatureId: featureId }),

    startPlacingSolid: (base) => set({ drag: { kind: 'placing-solid', base, position: null } }),

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
      const object = makeObject(drag.base, drag.position)
      commit((d) => ({ objects: [...d.objects, object] }))
      set({ drag: { kind: 'idle' }, selectedObjectId: object.id, selectedFeatureId: null })
    },

    addObject: (base, position) => {
      const object = makeObject(base, position)
      commit((d) => ({ objects: [...d.objects, object] }))
      set({ selectedObjectId: object.id, selectedFeatureId: null })
      return object.id
    },

    removeObject: (id) => {
      commit((d) => ({ objects: d.objects.filter((o) => o.id !== id) }))
      set((s) => ({
        ...prune(s.doc, s.selectedObjectId, s.selectedFeatureId),
        // A drag pointing at a deleted object has nothing left to move.
        drag: 'objectId' in s.drag && s.drag.objectId === id ? { kind: 'idle' } : s.drag,
      }))
    },

    setObjectTransform: (id, transform) => {
      const { drag } = get()
      if (drag.kind === 'moving-object' && drag.objectId === id) {
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
        selectedObjectId: object.id,
        selectedFeatureId: feature.id,
      })
    },

    startMoving: (objectId, featureId) =>
      set({
        drag: { kind: 'moving', objectId, id: featureId, snapshot: false },
        selectedObjectId: objectId,
        selectedFeatureId: featureId,
      }),

    moveTo: (anchor) => {
      const { drag, doc } = get()
      if (drag.kind !== 'moving') return
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
        selectedObjectId: objectId,
        selectedFeatureId: s.selectedObjectId === objectId ? s.selectedFeatureId : null,
      })),

    moveObjectTo: (position) => {
      const { drag, doc } = get()
      if (drag.kind !== 'moving-object') return
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

    startMovingFace: (objectId, featureId) =>
      set({
        drag: { kind: 'moving-face', objectId, id: featureId, snapshot: false },
        selectedObjectId: objectId,
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

    setOp: (objectId, featureId, op) =>
      commit(
        mapObject(objectId, (o) => ({
          ...o,
          features: o.features.map((f) => {
            if (f.id !== featureId) return f
            const limit = hostSurfaceFor(o.base, f.anchor).maxDepth(op, f.anchor)
            // Choosing extrude or intrude on a flat projection is the moment it
            // becomes solid, so give it a usable depth in the same click.
            const depth =
              f.depth > 0
                ? Math.min(f.depth, limit)
                : Math.min(DEFAULT_FEATURE_DEPTH, limit)
            return { ...f, op, depth }
          }),
        }))
      ),

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
      set((s) => {
        const heir = s.selectedObjectId === null ? undefined : renamed.get(s.selectedObjectId)
        return heir === undefined ? {} : { selectedObjectId: heir }
      })
      return split
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
          ...prune(doc, s.selectedObjectId, s.selectedFeatureId),
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
          ...prune(doc, s.selectedObjectId, s.selectedFeatureId),
        }
      }),

    reset: () =>
      set({
        doc: DEFAULT_DOC,
        selectedObjectId: null,
        selectedFeatureId: null,
        past: [],
        future: [],
        drag: { kind: 'idle' },
      }),
  }
})

export const selectedObject = (s: State): SceneObject | null =>
  s.doc.objects.find((o) => o.id === s.selectedObjectId) ?? null

export const selectedFeature = (s: State): Feature | null =>
  selectedObject(s)?.features.find((f) => f.id === s.selectedFeatureId) ?? null
