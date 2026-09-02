/**
 * READING STRANGERS' JSON: the vocabulary every restore in this app is written
 * in, and the document-shaped checks the heavier ones are built from.
 *
 * It is a strangers' problem rather than a versioning one. Everything this app
 * stores comes back through a browser shelf that anybody can open a console and
 * edit, from a build that may be months older than the one now reading it, or
 * from a disk that half-wrote it. None of those produces an ERROR -- they
 * produce an object of the right general shape with the wrong thing in one
 * field -- so the only defence is to check each field on the way in and say
 * what happens when it fails.
 *
 * TWO ANSWERS TO A BAD FIELD, and which one is right depends entirely on what
 * the field belongs to. A PREFERENCE is independent of its neighbours, so an
 * unreadable theme costs the theme and nothing else -- see `Check`, which
 * answers `undefined` and leaves the caller to keep its own default. A
 * DOCUMENT is not: `bounds()` reads `size` off a box without asking whether it
 * is there, so a box that came back without its three numbers is an object that
 * throws the first time anything measures it, and the honest answer is to lose
 * the whole object. Both kinds are here, and each says which it is.
 *
 * WHY A FILE OF ITS OWN. `persist.ts` wrote all of this for the shelf, and then
 * projects arrived needing exactly the same reader for exactly the same
 * `SceneObject`s -- a saved custom and a saved scene are the same shape of
 * thing stored for different reasons. A second copy of `objectFrom` would be a
 * second thing to keep in step with the document's types, and the day they
 * drifted the two halves of one app would disagree about what a solid is.
 *
 * NOTHING HERE TOUCHES A STORE OR A BROWSER. Pure functions over `unknown`, so
 * the check suite can drive every one of them under `tsx` with no shelf, no
 * IndexedDB and no window in sight.
 */
import { parseHex } from '../color'
import type { SceneObject, Vec3 } from '../geometry/types'

/**
 * A check answers with the value it accepts, or `undefined` for "no".
 *
 * `undefined` rather than a thrown error, because the caller's response to a
 * bad field is never to give up: it is to leave that ONE field at the app's
 * default and go on reading the rest. A stored theme nobody recognises must not
 * cost the user their brush sizes.
 */
export type Check<T> = (raw: unknown) => T | undefined

export const bool: Check<boolean> = (raw) => (typeof raw === 'boolean' ? raw : undefined)

export const text: Check<string> = (raw) => (typeof raw === 'string' ? raw : undefined)

/**
 * A number in a range, CLAMPED rather than rejected.
 *
 * The distinction matters and it is the same one the setters make: a dial that
 * comes back at 30 when the panel now stops at 12.5 is not corrupt data, it is
 * a number from a version whose range was wider, and the honest answer is the
 * nearest value this app can hold rather than throwing the user's setting away.
 * Only a non-number -- or a NaN, which is a number that would poison every
 * calculation downstream -- is refused outright.
 */
export const num =
  (lo: number, hi: number): Check<number> =>
  (raw) =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : undefined

export const oneOf =
  <T extends string | number | boolean>(values: readonly T[]): Check<T> =>
  (raw) =>
    values.includes(raw as T) ? (raw as T) : undefined

/** An object, and not an array or a null -- both of which `typeof` calls one. */
export function fields(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined
}

/** Every element that passes, up to a cap. A bad element is DROPPED, not fatal:
 *  one unreadable picture must not empty the shelf around it. */
export function list<T>(raw: unknown, cap: number, check: Check<T>): T[] {
  if (!Array.isArray(raw)) return []
  const kept: T[] = []
  for (const item of raw) {
    if (kept.length >= cap) break
    const value = check(item)
    if (value !== undefined) kept.push(value)
  }
  return kept
}

export const vec3: Check<[number, number, number]> = (raw) =>
  Array.isArray(raw) &&
  raw.length === 3 &&
  raw.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [raw[0] as number, raw[1] as number, raw[2] as number]
    : undefined

export const real: Check<number> = (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined

/** A whole number at or above a floor: a count, or a moment in time. */
export const whole =
  (lo: number): Check<number> =>
  (raw) =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= lo ? raw : undefined

/**
 * A base solid, one kind at a time.
 *
 * Written out rather than swept generically, because this is the layer where a
 * missing field is genuinely fatal: `bounds()` reads `size` off a box and
 * `radius` off a sphere without asking whether they are there, so a box that
 * came back without its three numbers is an object that throws the first time
 * anything measures it. Nine kinds is a short list and it changes rarely; the
 * compiler flags this switch the day a tenth arrives.
 */
export function baseFrom(raw: unknown): SceneObject['base'] | undefined {
  const stored = fields(raw)
  if (!stored) return undefined
  const radius = real(stored.radius)
  const height = real(stored.height)
  const sides = real(stored.sides)
  switch (stored.kind) {
    case 'box': {
      const size = vec3(stored.size)
      return size ? { kind: 'box', size } : undefined
    }
    case 'sphere':
      return radius === undefined ? undefined : { kind: 'sphere', radius }
    case 'cylinder':
      return radius === undefined || height === undefined
        ? undefined
        : { kind: 'cylinder', radius, height }
    case 'cone':
      return radius === undefined || height === undefined
        ? undefined
        : { kind: 'cone', radius, height }
    case 'capsule':
      return radius === undefined || height === undefined
        ? undefined
        : { kind: 'capsule', radius, height }
    case 'pyramid':
      return radius === undefined || height === undefined || sides === undefined
        ? undefined
        : { kind: 'pyramid', radius, height, sides }
    case 'prism':
      return radius === undefined || height === undefined || sides === undefined
        ? undefined
        : { kind: 'prism', radius, height, sides }
    case 'platonic': {
      const solid = oneOf(['tetrahedron', 'octahedron', 'dodecahedron'] as const)(stored.solid)
      return radius === undefined || solid === undefined
        ? undefined
        : { kind: 'platonic', solid, radius }
    }
    case 'mesh': {
      const meshId = text(stored.meshId)
      const label = text(stored.label)
      const size = vec3(stored.size)
      // The ticket is checked for SHAPE here and for a model it can actually
      // find later, once the stored library has been put back -- by whichever
      // caller is doing the restoring, since only it knows what it fetched.
      return meshId === undefined || label === undefined || size === undefined
        ? undefined
        : { kind: 'mesh', meshId, label, size }
    }
    default:
      return undefined
  }
}

/**
 * One saved solid, features and cuts and merged parts and all.
 *
 * HOW DEEP THIS GOES, and why it stops where it does. The base and the
 * transform are checked field by field because nothing downstream tolerates
 * their absence. A feature, a cut and a sketch are checked only for being
 * objects with an id -- and that is not laziness, it is the app's own contract:
 * the evaluator already applies each one in a try and reports the ones that
 * would not go on, by id, in `EvalReadout.failed`. A malformed feature
 * therefore lands in a state this app handles and draws every day, while a
 * malformed base lands in one nothing handles.
 *
 * Recursion is the real work here. `parts` and `erased` are whole solids in
 * their own right -- a merged assembly is a tree -- so each is put through this
 * same check, and one bad part fails the object it is inside rather than being
 * quietly dropped out of a shape the user saved.
 */
export function objectFrom(raw: unknown): SceneObject | undefined {
  const stored = fields(raw)
  if (!stored) return undefined

  const id = text(stored.id)
  const name = text(stored.name)
  const base = baseFrom(stored.base)
  const transform = fields(stored.transform)
  const position = vec3(transform?.position)
  const rotation = vec3(transform?.rotation)
  if (id === undefined || name === undefined || !base || !position || !rotation) return undefined

  // Identified but not otherwise inspected: see the note above.
  const identified = (item: unknown): unknown | undefined =>
    fields(item) && typeof (item as { id?: unknown }).id === 'string' ? item : undefined
  const some = (value: unknown): unknown[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const kept = value.map(identified)
    return kept.some((item) => item === undefined) ? undefined : (kept as unknown[])
  }

  const features = some(stored.features)
  const cuts = some(stored.cuts)
  if (!features || !cuts) return undefined

  const parts: SceneObject[] = []
  if (!Array.isArray(stored.parts)) return undefined
  for (const part of stored.parts) {
    const kept = objectFrom(part)
    if (!kept) return undefined
    parts.push(kept)
  }

  let erased: SceneObject[] | undefined
  if (stored.erased !== undefined) {
    if (!Array.isArray(stored.erased)) return undefined
    erased = []
    for (const hole of stored.erased) {
      const kept = objectFrom(hole)
      if (!kept) return undefined
      erased.push(kept)
    }
  }

  const color = text(stored.color)
  return {
    id,
    name,
    base,
    transform: { position: position as Vec3, rotation: rotation as Vec3 },
    features: features as SceneObject['features'],
    cuts: cuts as SceneObject['cuts'],
    parts,
    // Optional on the type and optional here: an object that never had one must
    // come back without one rather than with an undefined field, so what is
    // restored is the same document it was saved as. `erosion` rides along for
    // the same reason -- a saved custom may have been sculpted.
    ...(color !== undefined && parseHex(color) ? { color } : {}),
    ...(stored.erase === true ? { erase: true } : {}),
    // Read the way `erase` is: only a literal true locks, and a solid saved
    // without the key comes back without it.
    ...(stored.locked === true ? { locked: true } : {}),
    ...(erased ? { erased } : {}),
    ...(Array.isArray(stored.erosion) ? { erosion: stored.erosion as SceneObject['erosion'] } : {}),
  }
}

/**
 * Every imported model an object stands on, its merged parts and its holes
 * included -- a ticket anywhere in the tree is a model the store must carry.
 *
 * Here rather than beside either of its callers because both of them need it
 * and neither owns it: the shelf gathers tickets to decide what to store beside
 * a custom, and a project gathers them to decide what to store beside a scene.
 */
export function meshTickets(object: SceneObject, into: Set<string>): void {
  if (object.base.kind === 'mesh') into.add(object.base.meshId)
  for (const part of object.parts) meshTickets(part, into)
  for (const hole of object.erased ?? []) meshTickets(hole, into)
}
