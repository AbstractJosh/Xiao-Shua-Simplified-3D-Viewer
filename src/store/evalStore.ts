import { create } from 'zustand'
import type { ObjectEval } from '../geometry/evaluate'

/**
 * Read-out of the last geometry evaluation. Kept separate from the document so
 * publishing it never invalidates the document and triggers another evaluation.
 */
export type EvalReadout = {
  /**
   * The per-object results of that same evaluation, so a panel can inspect one
   * object's mesh without re-running the booleans for the whole scene. These
   * geometries belong to the evaluator's prefix cache: read them, never dispose
   * them, or the next frame draws a freed buffer.
   */
  objects: ObjectEval[]
  /**
   * Ids of everything that failed to apply. Feature, cut and object ids all
   * land in here, so a consumer that expects feature ids has to tolerate an id
   * it cannot resolve rather than treating it as a bug.
   */
  failed: string[]
  millis: number
  triangles: number
}

type EvalStatus = EvalReadout & {
  publish: (readout: EvalReadout) => void
}

export const useEvalStatus = create<EvalStatus>((set) => ({
  objects: [],
  failed: [],
  millis: 0,
  triangles: 0,
  publish: (readout) => set(readout),
}))
