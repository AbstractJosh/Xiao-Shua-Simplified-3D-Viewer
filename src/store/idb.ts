/**
 * The one shelf in the browser that is big enough for what this app keeps.
 *
 * `localStorage` holds about five megabytes of TEXT, and both of the things
 * stored through here blow past that on their own: a reference picture is a PNG
 * data URL, and an imported model behind a saved custom is a hundred thousand
 * vertices. IndexedDB has no such ceiling worth naming, and -- the reason that
 * matters more than the size -- it stores STRUCTURED CLONES, so a Float32Array
 * goes in as itself and comes back as itself rather than as a JSON array of
 * numbers three times the size and slower at both ends.
 *
 * What it costs is that every read is asynchronous, which is exactly why the
 * preferences do NOT come through here: a theme read a frame late is a window
 * that paints in the wrong colours and then flips. See `persist.ts`, which
 * splits what it keeps between the two shelves for that one reason.
 *
 * NOTHING HERE THROWS AT IMPORT TIME AND NOTHING ASSUMES A BROWSER. The check
 * suite runs these stores headlessly under `tsx`, where `indexedDB` does not
 * exist at all; every function below answers "no shelf" and the app -- or the
 * check -- carries on with whatever it had.
 */

const DB_NAME = 'xiao-shua-3d'
const DB_VERSION = 1
/** One store, keyed by a string of our own choosing. See `persist.ts`. */
const STORE = 'kept'

/**
 * Whether there is a shelf at all.
 *
 * A function rather than a constant computed at import time, because that is
 * the difference between a module that can be imported in Node and one that
 * cannot: the check suite imports `persist.ts` to test its pure halves, and a
 * top-level `indexedDB.open` would throw before a single check had run.
 */
function available(): boolean {
  return typeof indexedDB !== 'undefined'
}

let open: Promise<IDBDatabase> | null = null

/**
 * The database, opened once and reused.
 *
 * Cached as the PROMISE rather than as the database, so ten calls racing on
 * first load open one connection between them instead of ten.
 *
 * A failed open is not cached: a browser in private mode may refuse today and
 * allow tomorrow, and a permanent null would mean one refusal disabled the
 * shelf for the life of the tab.
 */
function db(): Promise<IDBDatabase> {
  if (open) return open
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
    // Another tab holding an older version open. Rejecting rather than hanging:
    // the caller's answer is "nothing kept", which is the same answer a first
    // run gives and is handled everywhere already.
    request.onblocked = () => reject(new Error('indexedDB blocked'))
  })
  opening.catch(() => {
    if (open === opening) open = null
  })
  open = opening
  return opening
}

/** One request, as a promise. Every operation below is one of these. */
function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const tx = database.transaction(STORE, mode)
        const request = work(tx.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'))
      })
  )
}

/** What is under a key, or undefined for a key nobody has written -- and for
 *  every key at all where there is no shelf to read. */
export function idbGet<T>(key: string): Promise<T | undefined> {
  if (!available()) return Promise.resolve(undefined)
  return run<T | undefined>('readonly', (store) => store.get(key) as IDBRequest<T | undefined>)
}

/**
 * Writes a value, replacing whatever was there.
 *
 * REJECTS ON A FULL DISK rather than swallowing it, because the caller has a
 * genuine second move to make: see `keepShelf`, which sheds the heavy half of
 * what it was storing and tries again. A quota error swallowed here would look
 * exactly like a successful save.
 */
export function idbPut(key: string, value: unknown): Promise<void> {
  if (!available()) return Promise.resolve()
  return run('readwrite', (store) => store.put(value, key)).then(() => undefined)
}

/**
 * Every key in the store.
 *
 * For finding the models nothing points at any more: a custom deleted off the
 * shelf leaves its imported model behind, and without a way to enumerate what
 * is stored there is no way to tell an orphan from a model in use. See
 * `pruneMeshes` in `persist.ts`.
 */
export function idbKeys(): Promise<string[]> {
  if (!available()) return Promise.resolve([])
  return run<IDBValidKey[]>('readonly', (store) => store.getAllKeys()).then((keys) =>
    keys.filter((key): key is string => typeof key === 'string')
  )
}

export function idbDelete(key: string): Promise<void> {
  if (!available()) return Promise.resolve()
  return run('readwrite', (store) => store.delete(key)).then(() => undefined)
}
