import { create } from 'zustand'
import type {
  BaseSolid,
  Doc,
  Feature,
  FeatureOp,
  Shape2D,
  SurfaceAnchor,
} from '../geometry/types'
import { nextFeatureId } from '../geometry/types'
import { hostSurfaceFor } from '../geometry/surfaces'

/** Depth applied the moment a user picks extrude or intrude on a flat sketch. */
export const DEFAULT_FEATURE_DEPTH = 0.3

export type Drag =
  | { kind: 'idle' }
  /** Dragging a fresh shape from the console; anchor is null while off-object. */
  | { kind: 'placing'; shape: Shape2D; anchor: SurfaceAnchor | null }
  /**
   * Sliding an existing sketch across its surface. `snapshot` records whether
   * this gesture has already pushed a history entry, so undo rewinds the whole
   * drag -- and a click that never moved anything costs no undo step at all.
   */
  | { kind: 'moving'; id: string; snapshot: boolean }

const DEFAULT_DOC: Doc = {
  base: { kind: 'box', size: [2, 2, 2] },
  features: [],
}

type State = {
  doc: Doc
  selectedId: string | null
  drag: Drag
  past: Doc[]
  future: Doc[]

  setBase: (base: BaseSolid) => void
  select: (id: string | null) => void

  /** Takes a full shape, so the palette can vary polygon side counts. */
  startPlacing: (shape: Shape2D) => void
  updatePlacing: (anchor: SurfaceAnchor | null) => void
  commitPlacing: () => void

  startMoving: (id: string) => void
  moveTo: (anchor: SurfaceAnchor) => void
  endDrag: () => void

  patchFeature: (id: string, patch: Partial<Feature>) => void
  setOp: (id: string, op: FeatureOp) => void
  removeFeature: (id: string) => void
  toggleFeature: (id: string) => void

  undo: () => void
  redo: () => void
  reset: () => void
}

const HISTORY_LIMIT = 50

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
   * one history entry is recorded when the drag starts, so undo rewinds the
   * whole gesture rather than one mouse-move of it.
   */
  const silent = (fn: (doc: Doc) => Doc) => set((s) => ({ doc: fn(s.doc) }))

  // Dragging a slider fires a change per pixel. Without coalescing, one size
  // tweak buries the undo stack under fifty near-identical entries.
  let lastKey = ''
  let lastAt = 0
  const COALESCE_MS = 600

  /** Commit, folding into the previous entry if it was the same edit just now. */
  const commitCoalesced = (key: string, fn: (doc: Doc) => Doc) =>
    set((s) => {
      const now = Date.now()
      const fold = key === lastKey && now - lastAt < COALESCE_MS
      lastKey = key
      lastAt = now
      return {
        doc: fn(s.doc),
        past: fold ? s.past : [...s.past, s.doc].slice(-HISTORY_LIMIT),
        future: [],
      }
    })

  const mapFeature = (id: string, fn: (f: Feature) => Feature) => (doc: Doc): Doc => ({
    ...doc,
    features: doc.features.map((f) => (f.id === id ? fn(f) : f)),
  })

  return {
    doc: DEFAULT_DOC,
    selectedId: null,
    drag: { kind: 'idle' },
    past: [],
    future: [],

    setBase: (base) => {
      // Anchors live in each surface's own parameter space, so a box anchor is
      // meaningless on a sphere. Switching the base starts a fresh document
      // rather than leaving sketches stranded off-surface.
      commit(() => ({ base, features: [] }))
      set({ selectedId: null, drag: { kind: 'idle' } })
    },

    select: (id) => set({ selectedId: id }),

    startPlacing: (shape) => set({ drag: { kind: 'placing', shape, anchor: null } }),

    updatePlacing: (anchor) =>
      set((s) =>
        s.drag.kind === 'placing' ? { drag: { ...s.drag, anchor } } : {}
      ),

    commitPlacing: () => {
      const { drag, doc } = get()
      if (drag.kind !== 'placing') return
      if (!drag.anchor) {
        // Released off the object: cancel cleanly, leaving no stray feature.
        set({ drag: { kind: 'idle' } })
        return
      }
      const host = hostSurfaceFor(doc.base, drag.anchor)
      const feature: Feature = {
        id: nextFeatureId(),
        anchor: host.clampAnchor(drag.anchor, drag.shape),
        shape: drag.shape,
        rotation: 0,
        op: 'extrude',
        // Lands as a pure projection. Depth arrives when the user chooses
        // extrude or intrude, which is what makes those the same object.
        depth: 0,
        enabled: true,
      }
      commit((d) => ({ ...d, features: [...d.features, feature] }))
      set({ drag: { kind: 'idle' }, selectedId: feature.id })
    },

    startMoving: (id) => set({ drag: { kind: 'moving', id, snapshot: false }, selectedId: id }),

    moveTo: (anchor) => {
      const { drag, doc } = get()
      if (drag.kind !== 'moving') return
      if (!doc.features.some((f) => f.id === drag.id)) return

      // History is recorded on the first real movement, not on pointer-down:
      // selecting a sketch should not leave an undo step that does nothing.
      if (!drag.snapshot) {
        set((s) => ({
          past: [...s.past, s.doc].slice(-HISTORY_LIMIT),
          future: [],
          drag: { ...drag, snapshot: true },
        }))
      }

      const host = hostSurfaceFor(doc.base, anchor)
      silent(mapFeature(drag.id, (f) => ({
        ...f,
        anchor: host.clampAnchor(anchor, f.shape),
      })))
    },

    endDrag: () => set({ drag: { kind: 'idle' } }),

    patchFeature: (id, patch) =>
      commitCoalesced(`patch:${id}:${Object.keys(patch).join(',')}`, mapFeature(id, (f) => {
        const next = { ...f, ...patch }
        // Resizing can push a sketch off its face; pull it back on.
        const host = hostSurfaceFor(get().doc.base, next.anchor)
        return { ...next, anchor: host.clampAnchor(next.anchor, next.shape) }
      })),

    setOp: (id, op) =>
      commit(mapFeature(id, (f) => {
        const host = hostSurfaceFor(get().doc.base, f.anchor)
        const limit = host.maxDepth(op)
        // Choosing extrude or intrude on a flat projection is the moment it
        // becomes solid, so give it a usable depth in the same click.
        const depth = f.depth > 0 ? Math.min(f.depth, limit) : Math.min(DEFAULT_FEATURE_DEPTH, limit)
        return { ...f, op, depth }
      })),

    removeFeature: (id) => {
      commit((d) => ({ ...d, features: d.features.filter((f) => f.id !== id) }))
      set((s) => ({ selectedId: s.selectedId === id ? null : s.selectedId }))
    },

    toggleFeature: (id) => commit(mapFeature(id, (f) => ({ ...f, enabled: !f.enabled }))),

    undo: () =>
      set((s) => {
        if (s.past.length === 0) return {}
        return {
          doc: s.past[s.past.length - 1],
          past: s.past.slice(0, -1),
          future: [s.doc, ...s.future].slice(0, HISTORY_LIMIT),
          drag: { kind: 'idle' },
        }
      }),

    redo: () =>
      set((s) => {
        if (s.future.length === 0) return {}
        return {
          doc: s.future[0],
          past: [...s.past, s.doc].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
          drag: { kind: 'idle' },
        }
      }),

    reset: () => set({ doc: DEFAULT_DOC, selectedId: null, past: [], future: [], drag: { kind: 'idle' } }),
  }
})

export const selectedFeature = (s: State): Feature | null =>
  s.doc.features.find((f) => f.id === s.selectedId) ?? null
