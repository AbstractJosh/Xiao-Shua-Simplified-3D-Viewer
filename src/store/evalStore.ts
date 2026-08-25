import { create } from 'zustand'

/**
 * Read-out of the last geometry evaluation. Kept separate from the document so
 * publishing it never invalidates the document and triggers another evaluation.
 */
type EvalStatus = {
  failed: string[]
  millis: number
  triangles: number
  publish: (s: { failed: string[]; millis: number; triangles: number }) => void
}

export const useEvalStatus = create<EvalStatus>((set) => ({
  failed: [],
  millis: 0,
  triangles: 0,
  publish: (s) => set(s),
}))
