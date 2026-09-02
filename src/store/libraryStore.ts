import { create } from 'zustand'
import type { SceneObject } from '../geometry/types'
import { cloneObject } from '../geometry/types'

/**
 * What the user has put aside: one transient copy, and a shelf of saved solids.
 *
 * Deliberately NOT in the document. Neither is part of the scene, so neither
 * belongs in undo history -- copying something and then pressing undo has to
 * rewind the last edit, not the copy. Keeping them here also means the two
 * survive every `reset`, which is the whole point of a shelf.
 *
 * Both hold whole `SceneObject`s, features, cuts, merged parts and all, because
 * that is what "this thing I built" means. Ids are reminted when a copy comes
 * back OUT, not when it goes in, so what is stored stays a faithful record of
 * what was taken.
 */

export type CustomObject = {
  id: string
  name: string
  /** As it stood when it was saved. Its position is discarded on the way out. */
  object: SceneObject
}

let customCounter = 0

const nextCustomId = (): string => {
  customCounter += 1
  return `k${customCounter}`
}

/**
 * Moves the counter past a set of ids that already exist.
 *
 * FOR A SHELF COMING BACK FROM A PREVIOUS SESSION, and it is not optional. The
 * counter starts at zero every time the page loads, so a shelf restored with
 * `k1` and `k2` on it would hand `k1` to the very next thing saved -- two rows
 * under one id, where renaming one renames both and deleting one deletes both.
 * See `persist.ts`.
 */
export function seedCustomIds(ids: string[]): void {
  for (const id of ids) {
    const numbered = /^k([0-9]+)$/.exec(id)
    if (numbered) customCounter = Math.max(customCounter, Number(numbered[1]))
  }
}

/**
 * The lowest `Custom N` nobody is using.
 *
 * Lowest-unused rather than an ever-climbing counter so a shelf holding two
 * things is not offering to call the next one "Custom 9", and so that renaming
 * "Custom 1" to something meaningful frees the name again instead of leaving a
 * permanent hole in the numbering.
 */
function nextCustomName(customs: CustomObject[]): string {
  const taken = new Set(customs.map((c) => c.name))
  for (let n = 1; ; n++) {
    const name = `Custom ${n}`
    if (!taken.has(name)) return name
  }
}

type LibraryState = {
  /** The one object Ctrl+C put aside, or null before anything has been copied. */
  clipboard: SceneObject | null
  customs: CustomObject[]

  copyObject: (object: SceneObject) => void
  /** Returns the new entry's id, so the panel can focus the name it just made. */
  saveCustom: (object: SceneObject) => string
  renameCustom: (id: string, name: string) => void
  removeCustom: (id: string) => void
}

export const useLibrary = create<LibraryState>((set) => ({
  clipboard: null,
  customs: [],

  // Stored as it stands, not cloned: the document is immutable, so the object
  // handed in can never change underneath this, and holding the original means
  // a copy still pastes after the thing it came from has been deleted.
  copyObject: (object) => set({ clipboard: object }),

  saveCustom: (object) => {
    const id = nextCustomId()
    set((s) => ({
      customs: [...s.customs, { id, name: nextCustomName(s.customs), object }],
    }))
    return id
  },

  renameCustom: (id, name) =>
    set((s) => ({
      customs: s.customs.map((c) => (c.id === id ? { ...c, name } : c)),
    })),

  removeCustom: (id) =>
    set((s) => ({ customs: s.customs.filter((c) => c.id !== id) })),
}))

/**
 * A stored object ready to be dropped into the scene: fresh ids, and back at
 * the origin so the drop decides where it lands.
 *
 * The ROTATION is kept. A custom object saved lying on its side is that shape;
 * standing it upright on the way out would hand back something the user never
 * saved.
 */
export function templateOf(object: SceneObject): SceneObject {
  const copy = cloneObject(object)
  return {
    ...copy,
    // Stored as a SHAPE. What the shelf holds is what you built, and whether a
    // copy of it comes out as a solid or as an eraser is decided by the corner
    // of the tile it is dragged from -- see `startPlacingSolidTemplate`, which
    // writes the flag either way round. So an object that happened to be an
    // eraser when it was saved is still a shape here, and a tile whose body is
    // dragged still adds material.
    erase: undefined,
    transform: { ...copy.transform, position: [0, 0, 0] },
  }
}
