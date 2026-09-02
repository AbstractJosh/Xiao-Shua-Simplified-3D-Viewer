/**
 * THE IMPORTED MODELS, and the one question that had to be taken away from
 * whoever was storing them: who still wants this one?
 *
 * An imported model is the heaviest thing this app keeps -- a hundred thousand
 * vertices, more bytes than everything else on the shelf put together -- and it
 * is the only stored thing with more than one owner. A saved custom stands on
 * one. A saved project's scene stands on one. The SAME one, if you built the
 * custom out of the model you imported into the project, because both hold
 * nothing but a ticket and the library behind them is one library.
 *
 * THAT SHARING IS WHY THIS FILE EXISTS. The shelf used to store the models it
 * needed and sweep up every stored model it did not, which was correct for
 * exactly as long as it was the only claimant. The day projects arrived, a
 * shelf write would have deleted the model a saved project's scene was standing
 * on -- and the damage does not show up until that project is next opened, as a
 * solid whose base throws. A sweep is only ever safe when it is run against
 * EVERY claim, so the sweeping moved here, where every claim can be seen at
 * once.
 *
 * THE OTHER HALF: A MODEL GOES DOWN ONCE. Under its own key, never inside the
 * record that names it, because the record is rewritten on every change to it
 * -- a custom renamed, a project's cube nudged -- and IndexedDB stores a
 * STRUCTURED CLONE, which copies every byte handed to it. With the models
 * inside, a one-character rename copied every triangle: measured at 32 ms for a
 * single 300k-triangle model, which is a visible stutter on a keystroke. What
 * the records carry instead is a list of ids, which costs nothing to rewrite.
 *
 * The order of the writes is what keeps the two halves honest: models first,
 * then the record that names them. A crash between the two leaves a stored
 * model nothing points at -- which the sweep tidies up -- rather than a custom
 * or a scene pointing at a model that was never written.
 */
import { meshRecord, restoreMesh } from '../geometry/meshLibrary'
import type { MeshRecord } from '../geometry/meshLibrary'
import { idbDelete, idbGet, idbKeys, idbPut } from './idb'

const MESH_PREFIX = 'mesh.'
const meshKey = (id: string): string => MESH_PREFIX + id

/**
 * Models known to be on disk already, so the bytes are written once a session
 * rather than once an edit. Seeded by whatever a load finds.
 */
const onDisk = new Set<string>()

/**
 * Who wants which models, by claimant.
 *
 * A map rather than one set, because the sweep has to be able to tell "the
 * shelf no longer needs this" from "nobody needs this": a claimant replaces its
 * own entry wholesale each time it reports in, and the union of what is left is
 * what stays on disk.
 */
const claims = new Map<string, Set<string>>()

/**
 * Claimants that exist but have not yet said what they want.
 *
 * THE RACE THIS FILE WOULD OTHERWISE LOSE, and it is worth stating plainly
 * because the failure is silent and permanent. Both claimants load
 * asynchronously. If the shelf lands first, claims its models and a sweep runs
 * before the project index has been read, every model that only a project wants
 * is deleted -- and the project is quietly ruined before its owner has opened
 * it. So a claimant announces itself at import time, and NO SWEEP RUNS until
 * every announced claimant has reported. The cost of getting it wrong in the
 * other direction is a few orphaned models surviving one extra session.
 */
const awaited = new Set<string>()

/** "I am a claimant, and I have not spoken yet." Called at module scope by each
 *  claimant, so the set is complete before any load can finish. */
export function expectClaim(source: string): void {
  if (!claims.has(source)) awaited.add(source)
}

/** What this claimant wants, replacing whatever it wanted before. */
export function claimMeshes(source: string, ids: string[]): void {
  claims.set(source, new Set(ids))
  awaited.delete(source)
}

/** Note that a model is already down, without writing it: what a load reports
 *  about every model it successfully read back. */
export function markStored(id: string): void {
  onDisk.add(id)
}

/**
 * Writes any of these models that are not down yet.
 *
 * Answers whether ALL of them are now stored. False is not an error to report
 * to anybody -- it is the signal the caller needs to store the light half of
 * whatever it was saving, dropping the things that stand on a model that would
 * not fit. See `writeShelf` and `writeProject`, which both do exactly that.
 *
 * A ticket with no model behind it is skipped rather than failed: it is already
 * broken in the live app, and storing the fact would be storing a bug. The
 * thing holding it is dropped on the way back in.
 */
export async function keepMeshes(ids: string[]): Promise<boolean> {
  for (const id of ids) {
    if (onDisk.has(id)) continue
    const record: MeshRecord | undefined = meshRecord(id)
    if (!record) continue
    try {
      await idbPut(meshKey(id), record)
      onDisk.add(id)
    } catch {
      // A full disk. The caller has a genuine second move; see above.
      return false
    }
  }
  return true
}

/**
 * Puts these models back on the library shelf, and says which of them landed.
 *
 * The caller compares that against what it asked for: anything that did not
 * come back is a model whose write hit a full disk, or whose record failed its
 * check, and whatever was standing on it has to be dropped rather than restored
 * as a ticket to nothing.
 */
export async function loadMeshes(ids: string[]): Promise<string[]> {
  const landed: string[] = []
  for (const id of ids) {
    let raw: unknown
    try {
      raw = await idbGet<unknown>(meshKey(id))
    } catch {
      continue
    }
    const record = meshFrom(raw)
    if (!record) continue
    restoreMesh(record)
    onDisk.add(id)
    landed.push(id)
  }
  return landed
}

/**
 * Throws away stored models nothing claims any more.
 *
 * Run after the records that name them are safely down, so a sweep can never
 * delete a model a stored record still needs -- and never at all until every
 * claimant has reported, which is the race described at `awaited`.
 */
export async function sweepMeshes(): Promise<void> {
  if (awaited.size > 0) return
  const wanted = new Set<string>()
  for (const held of claims.values()) for (const id of held) wanted.add(meshKey(id))
  let keys: string[]
  try {
    keys = await idbKeys()
  } catch {
    return
  }
  for (const key of keys) {
    if (!key.startsWith(MESH_PREFIX) || wanted.has(key)) continue
    onDisk.delete(key.slice(MESH_PREFIX.length))
    await idbDelete(key).catch(() => undefined)
  }
}

/**
 * A stored model, or null if it is not one this app wrote.
 *
 * Strict, unlike most of what `checked.ts` does, and for a reason particular to
 * this one type: the arrays here are handed straight to a `BufferAttribute` and
 * on to the GPU. A `positions` array that came back as an ordinary array of
 * numbers rather than a `Float32Array` is not a model that draws badly, it is
 * a renderer that throws -- so the typed arrays are checked for being typed
 * arrays and anything else is refused whole.
 */
function meshFrom(raw: unknown): MeshRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const stored = raw as Record<string, unknown>
  const { id, label, natural, triangles, attributes, index } = stored
  if (typeof id !== 'string' || typeof label !== 'string') return null
  if (typeof triangles !== 'number' || !Number.isFinite(triangles)) return null
  if (
    !Array.isArray(natural) ||
    natural.length !== 3 ||
    !natural.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return null
  }
  if (!Array.isArray(attributes)) return null
  const kept: MeshRecord['attributes'] = []
  for (const item of attributes) {
    if (typeof item !== 'object' || item === null) return null
    const attr = item as Record<string, unknown>
    if (typeof attr.name !== 'string') return null
    if (typeof attr.itemSize !== 'number' || !Number.isInteger(attr.itemSize)) return null
    if (!(attr.array instanceof Float32Array)) return null
    kept.push({ name: attr.name, array: attr.array, itemSize: attr.itemSize })
  }
  // A model with no positions is not a model. Everything else -- normals, uvs --
  // the renderer can do without or derive.
  if (!kept.some((a) => a.name === 'position')) return null
  if (index !== null && index !== undefined && !(index instanceof Uint32Array)) return null
  return {
    id,
    label,
    natural: [natural[0], natural[1], natural[2]] as MeshRecord['natural'],
    triangles,
    attributes: kept,
    index: (index as Uint32Array | undefined) ?? null,
  }
}
