/**
 * WHAT THE APP REMEMBERS ABOUT YOU BETWEEN VISITS, and what it deliberately
 * does not.
 *
 * The rule this file is built on: IT KEEPS PREFERENCES AND POSSESSIONS, NOT
 * WORK. A preference is how you like to work -- the theme, the unit, how wide
 * the torch is, how near a snap catches. A possession is something you put
 * somewhere on purpose and expected to find again -- a solid saved to the
 * shelf, a drawing uploaded to a slot. Work is the scene itself: the document,
 * the lump on the lathe, the block on the cutter. None of the third kind is
 * stored HERE, so nothing this file restores can be a half-finished model that
 * no longer matches what the user remembers making.
 *
 * WORK IS KEPT NOW, and it is kept somewhere else on purpose. A project is the
 * three benches given a name and a place to live -- see `projectStore.ts` --
 * and the reason it is not in this file is the reason this file could state its
 * rule so plainly: what is here is restored SILENTLY, over whatever the user is
 * looking at, every single time the app loads. Work cannot be restored on those
 * terms. It is restored because somebody asked for it by name, off a screen
 * that shows them what they are asking for, which is a different act needing
 * different machinery. The two do share one thing, and it is the heaviest:
 * the imported models both stand on. See `meshVault.ts`.
 *
 * That line is also what keeps this file HONEST ABOUT FAILURE. Everything it
 * restores is either correct or absent -- a preference that does not validate
 * falls back to the app's own default, a custom whose imported model did not
 * come back with it is dropped rather than restored broken. There is no state
 * in which a user is looking at something they did not build.
 *
 * TWO SHELVES, AND THE SPLIT IS NOT ARBITRARY.
 *
 * Preferences go to `localStorage`, which is small and SYNCHRONOUS. That second
 * word is the whole reason: the theme has to be applied before the first paint,
 * and a theme read one frame late is a window that comes up dark and flips to
 * light in front of the user -- the exact flash `index.html` carries a
 * `data-theme` attribute to prevent. Forty-odd numbers and short strings fit in
 * a few kilobytes with room to spare.
 *
 * The shelf -- saved customs, the clipboard, uploaded pictures and the imported
 * models any of them stand on -- goes to IndexedDB, which is asynchronous and
 * effectively unbounded. It has to: one reference picture is a PNG data URL and
 * one imported model is a hundred thousand vertices, either of which alone can
 * exceed everything `localStorage` will hold. Nothing on that shelf is on
 * screen at first paint, so arriving a tick later costs nothing.
 *
 * NOTHING HERE RUNS ON IMPORT AND NOTHING ASSUMES A BROWSER. `remember()` is
 * the one call that starts any of it, and every storage access is guarded --
 * the check suite drives these same functions in Node, where neither shelf
 * exists.
 */
import { parseHex } from '../color'
import { MIRROR_SNAP_MAX, MIRROR_SNAP_MIN } from '../geometry/faceMirror'
import { BRUSH_SMOOTH_MIN, ROUND_MIN } from '../geometry/erode'
import { meshEntry } from '../geometry/meshLibrary'
import type { SceneObject } from '../geometry/types'
import { OPEN_TO } from '../screens'
import { THEMES, THEME_ATTRIBUTE } from '../theme'
import { UNITS } from '../units'
import { FLIGHT_SPEED_MAX, FLIGHT_SPEED_MIN } from '../viewport/gameCamera'
import { LATHE_SNAP_MAX, LATHE_SNAP_MIN } from '../viewport/latheRuler'
import { LASER_SNAP_MAX, LASER_SNAP_MIN } from '../viewport/pointSnap'
// The vocabulary this file used to hold. It moved out when projects needed the
// same reader for the same `SceneObject`s -- see the note at the top of
// `checked.ts`, which is also where the argument for each check now lives.
import { bool, fields, list, meshTickets, num, objectFrom, oneOf, text } from './checked'
import type { Check } from './checked'
import { idbDelete, idbGet, idbPut } from './idb'
// The models are not this file's to store any more: a project's scene stands on
// the same library a saved custom does, so the one thing that may delete a
// model is the one thing that can see every claim on it. See `meshVault.ts`.
import { claimMeshes, expectClaim, keepMeshes, loadMeshes, sweepMeshes } from './meshVault'
import { seedCustomIds, useLibrary } from './libraryStore'
import type { CustomObject } from './libraryStore'
import {
  DEFAULT_REFERENCE_OPACITY,
  MAX_PRESETS,
  SLOTS_PER_PRESET,
  seedReferenceIds,
  useReference,
} from './referenceStore'
import type { Preset, RefEdit, RefImage } from './referenceStore'
import { BRUSH_RADIUS_MAX, BRUSH_RADIUS_MIN, RECENT_COLOR_SLOTS, useTools } from './toolStore'
import type { IslandPlacement, ToolState } from './toolStore'

/**
 * The keys, both carrying a VERSION.
 *
 * Not decoration. What is stored is a picture of types that live in this
 * codebase and are still changing, and the one failure this file must never
 * allow is yesterday's shape being read as today's -- a `Preset` that grew a
 * fourth slot, a brush dial that changed range. Bumping the number retires
 * every stored copy at a stroke, and the app comes up on its own defaults,
 * which is exactly what a first run does and is therefore known to work.
 */
const PREFS_KEY = 'xiao-shua-3d.prefs.1'
const SHELF_KEY = 'shelf.2'

/**
 * This file's name at the mesh vault, where the imported models live.
 *
 * The vault will not delete a model until every claimant has said what it
 * wants, so announcing the name at import time -- before any load can finish --
 * is what stops a shelf that loads quickly from sweeping away a model that only
 * a project, still loading, is standing on. See `meshVault.ts`.
 */
const SHELF_CLAIM = 'shelf'
expectClaim(SHELF_CLAIM)

// --- The preferences ---------------------------------------------------------

const placement: Check<IslandPlacement> = (raw) => {
  const stored = fields(raw)
  if (!stored) return undefined
  const hx = oneOf(['left', 'right'] as const)(stored.hx)
  const hy = oneOf(['top', 'bottom'] as const)(stored.hy)
  // A generous cap rather than the window's own width, which this file has no
  // business reading: the island re-solves its corner against the viewport the
  // moment it mounts, so a placement saved on a wider monitor slides back into
  // view on its own. See the ResizeObserver in `ToolIsland`.
  const x = num(0, 1e5)(stored.x)
  const y = num(0, 1e5)(stored.y)
  if (hx === undefined || hy === undefined || x === undefined || y === undefined) return undefined
  return { hx, hy, x, y }
}

/**
 * Hex the picker would accept, and no more of them than it shows.
 *
 * An array that survived NOTHING is refused rather than reduced to an empty
 * one, so the rule the rest of this file follows holds here too: a field is
 * either recognisable or absent, and an absent one leaves the store on its own
 * default. A list where only some entries are junk keeps the rest -- those are
 * colours the user really did use.
 */
const colors: Check<string[]> = (raw) => {
  if (!Array.isArray(raw)) return undefined
  const kept = list(raw, RECENT_COLOR_SLOTS, (c) =>
    typeof c === 'string' && parseHex(c) ? c : undefined
  )
  return raw.length > 0 && kept.length === 0 ? undefined : kept
}

/**
 * EVERY PREFERENCE THE APP KEEPS, and the check that lets each one back in.
 *
 * One table rather than a save function and a load function that have to agree:
 * a field added here is written, read and validated by the same line, so the
 * two halves cannot drift. The check suite walks this table too, which is what
 * makes "everything in it survives a round trip" a claim about the app rather
 * than about a list somebody kept up to date by hand.
 *
 * WHAT IS DELIBERATELY ABSENT, because the omissions are the real decisions:
 *
 * - THE ARMED TOOLS -- `brushTool`, `laserTool`, `cutActive`. Coming back to a
 *   torch already in hand means the first drag across a solid melts it. What
 *   the dials are set to is a preference; what is held is not.
 * - `screen`, `openPanel`, `helpSection`, `atWelcome`. Where you were, not how
 *   you work -- and Help says outright that it opens at the beginning rather
 *   than wherever the last reader left off.
 *
 *   `screen` is the interesting one, because the argument for leaving it out
 *   has since been answered rather than dropped. It was "returning to the Lathe
 *   screen is no kindness when the lump that was on it is not restored", and
 *   the lump IS restored now -- by a project. So which screen you were on is
 *   remembered, in the project, beside the work it was showing; what has no
 *   business being a preference is which screen the LAST project was open at
 *   when the next one opens on a different bench. `openTo` below is the
 *   preference that survived the split: not where you were, but where you want
 *   to start. See `projectStore.ts`.
 * - THE RULERS, THE MIRRORS, THE CUT PLANE, THE LATHE'S ZOOM AND PAN. All four
 *   are aimed at work this file does not keep: a ruler measures a document, a
 *   mirror stands on a block, a zoom frames a lump. Restoring the aim without
 *   the thing aimed at is furniture in an empty room.
 * - THE DOCUMENT, and the lathe's and the cutter's contents with it. See the
 *   rule at the top of this file.
 */
const PREFS = {
  // The Settings screen's own five, which are what most people mean by "it
  // forgot my settings".
  displayUnit: oneOf(UNITS),
  theme: oneOf(THEMES),
  showOutlines: bool,
  gameControls: bool,
  flightSpeed: num(FLIGHT_SPEED_MIN, FLIGHT_SPEED_MAX),
  // Where the app starts: the front door, or straight back into the project you
  // had open. A preference and not a place -- see the note above about
  // `screen`, which is the distinction this one exists to hold.
  openTo: oneOf(OPEN_TO),

  // Snapping: the switch, and the three different ideas of "near" it governs.
  snap: bool,
  // The range the Snap panel's own field offers. There is no exported constant
  // for this pair the way there is for the other two, so the numbers are
  // written where they can be compared with `NavTools`.
  snapDistance: num(0.005, 2),
  laserSnapDistance: num(LASER_SNAP_MIN, LASER_SNAP_MAX),
  latheSnapDistance: num(LATHE_SNAP_MIN, LATHE_SNAP_MAX),
  mirrorSnapAngle: num(MIRROR_SNAP_MIN, MIRROR_SNAP_MAX),

  // How the app is laid out and driven, all of which the store already calls
  // preferences in so many words.
  gizmoHidden: bool,
  islandCollapsed: bool,
  islandPlacement: placement,
  stockOpen: bool,
  mirrorAxis: oneOf([0, 1, 2] as const),
  eraseScope: oneOf(['all', 'selected'] as const),
  brushScope: oneOf(['all', 'selected'] as const),
  recentColors: colors,

  // THE BRUSH DIALS, all three modelling brushes and all three lathe tools.
  // Each keeps its own size and its own unit on purpose -- see `sculptRadius`
  // for the argument -- so each is kept separately here rather than collapsed
  // into one remembered brush.
  erodeRadius: num(BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX),
  erodeSizeUnit: oneOf(UNITS),
  erodeHeat: num(0, 1),
  erodeSmooth: num(BRUSH_SMOOTH_MIN, 1),
  sculptRadius: num(BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX),
  sculptSizeUnit: oneOf(UNITS),
  sculptStrength: num(0, 1),
  sculptSmooth: num(BRUSH_SMOOTH_MIN, 1),
  smootherRadius: num(BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX),
  smootherSizeUnit: oneOf(UNITS),
  smootherStrength: num(ROUND_MIN, 1),
  pushReach: num(BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX),
  pushSizeUnit: oneOf(UNITS),
  pushStrength: num(0, 1),
  pullReach: num(BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX),
  pullSizeUnit: oneOf(UNITS),
  pullStrength: num(0, 1),
  smoothReach: num(BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX),
  smoothSizeUnit: oneOf(UNITS),
  smoothStrength: num(0, 1),
  hollowSizeUnit: oneOf(UNITS),

  // How the two drawing tools read what the hand puts down. Both are settings
  // about a line rather than a line, which is why they keep while the points
  // themselves do not.
  freehandSmoothing: num(0, 1),
  fitCurve: bool,
  sculptFit: bool,
} satisfies { [K in keyof ToolState]?: Check<ToolState[K]> }

type PrefKey = keyof typeof PREFS

export type Prefs = { [K in PrefKey]: ToolState[K] }

const PREF_KEYS = Object.keys(PREFS) as PrefKey[]

/** The preferences as they stand. */
export function prefsOf(state: ToolState): Prefs {
  const out: Record<string, unknown> = {}
  for (const key of PREF_KEYS) out[key] = state[key]
  return out as Prefs
}

/**
 * Whatever of a stored blob is still recognisable, FIELD BY FIELD.
 *
 * A partial rather than all-or-nothing, and that is the point of validating one
 * field at a time: a single dial written by a version whose range has since
 * moved costs that dial and nothing else. Anything missing simply never lands
 * in the patch, so the store keeps the default it was created with.
 */
export function prefsFrom(raw: unknown): Partial<Prefs> {
  const stored = fields(raw)
  if (!stored) return {}
  const out: Record<string, unknown> = {}
  for (const key of PREF_KEYS) {
    const value = (PREFS[key] as Check<unknown>)(stored[key])
    if (value !== undefined) out[key] = value
  }
  return out as Partial<Prefs>
}

/**
 * Puts them into the store, and the theme onto the document with them.
 *
 * The attribute is written HERE as well as by `useTheme` in `App`, and the
 * duplication is deliberate: that one runs in an effect, which is after the
 * first paint, so leaving the job to it would show one frame of the default
 * theme and then flip. This runs before React has mounted at all -- see
 * `remember()` -- which is the whole reason the preferences are on the
 * synchronous shelf. `App`'s effect goes on owning every LATER change.
 *
 * Written straight to the state rather than through the setters, because
 * `setDisplayUnit` deliberately writes through to every control that keeps a
 * unit of its own -- see `PINNED_UNITS` -- and would overwrite the very brush
 * units being restored alongside it.
 */
export function applyPrefs(prefs: Partial<Prefs>): void {
  if (Object.keys(prefs).length === 0) return
  useTools.setState(prefs)
  if (prefs.theme && typeof document !== 'undefined') {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, prefs.theme)
  }
}

// --- The shelf ---------------------------------------------------------------

/**
 * Everything the second lane keeps, in one value.
 *
 * ONE RECORD RATHER THAN FIVE KEYS, because these things depend on each other
 * and a half-written set is worse than none: a preset points at pictures, a
 * custom may stand on an imported model, and the active preset must be one of
 * the presets stored beside it. Written and read as a unit, they cannot come
 * back disagreeing.
 */
export type Shelf = {
  version: 2
  customs: CustomObject[]
  clipboard: SceneObject | null
  presets: Preset[]
  activePresetId: string
  opacity: number
  /**
   * The imported models any of the above stand on, BY ID -- and only those. The
   * mesh library never evicts, so it accumulates every file opened this
   * session; storing all of it would keep a hundred megabytes of models nothing
   * points at any more. See `meshTickets`.
   *
   * Ids rather than the models themselves: see `meshVault.ts`. Each one is a
   * key this record's own reader will go and fetch.
   */
  meshIds: string[]
}

const editFrom: Check<RefEdit> = (raw) => {
  const stored = fields(raw)
  if (!stored) return undefined
  const flipX = bool(stored.flipX)
  const flipY = bool(stored.flipY)
  const turns = oneOf([0, 1, 2, 3] as const)(stored.turns)
  if (flipX === undefined || flipY === undefined || turns === undefined) return undefined
  let crop: RefEdit['crop'] = null
  const box = fields(stored.crop)
  if (box) {
    // Fractions of the picture, so every one of them is between nothing and
    // all of it. A crop keeping a negative width is a rectangle the editor
    // cannot draw and the decal cannot sample.
    const x = num(0, 1)(box.x)
    const y = num(0, 1)(box.y)
    const w = num(0, 1)(box.w)
    const h = num(0, 1)(box.h)
    if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
    if (w <= 0 || h <= 0) return undefined
    crop = { x, y, w, h }
  }
  return { flipX, flipY, turns, crop }
}

const imageFrom: Check<RefImage> = (raw) => {
  const stored = fields(raw)
  if (!stored) return undefined
  const id = text(stored.id)
  const name = text(stored.name)
  const src = text(stored.src)
  const width = num(1, 1e6)(stored.width)
  const height = num(1, 1e6)(stored.height)
  const edit = editFrom(stored.edit)
  if (id === undefined || name === undefined || src === undefined) return undefined
  if (width === undefined || height === undefined || edit === undefined) return undefined
  // A DATA URL AND NOTHING ELSE. It is what `rasterise` promises -- every
  // picture is redrawn onto a canvas on the way in, whatever the file was --
  // so anything else here is not a picture this app produced. It is also the
  // one check in this file that is about safety rather than shape: what comes
  // off this shelf is handed to an `<img>`, and a stored `src` pointing
  // anywhere but at its own bytes would be this app fetching a stranger's URL
  // because something once wrote it to disk.
  if (!src.startsWith('data:')) return undefined
  return { id, name, src, width, height, edit }
}

const presetFrom: Check<Preset> = (raw) => {
  const stored = fields(raw)
  if (!stored) return undefined
  const id = text(stored.id)
  const name = text(stored.name)
  if (id === undefined || name === undefined) return undefined
  // Rebuilt to the length the app expects rather than taken as stored: a null
  // is an empty slot and not a gap, so a preset saved when there were two slots
  // comes back with three, the third empty. See `emptySlots`.
  const held = Array.isArray(stored.slots) ? stored.slots : []
  const slots = Array.from({ length: SLOTS_PER_PRESET }, (_, i) => imageFrom(held[i]) ?? null)
  return { id, name, slots }
}

/** The shelf as it stands, with the models it depends on gathered up beside it. */
export function shelfOf(): Shelf {
  const library = useLibrary.getState()
  const reference = useReference.getState()

  const tickets = new Set<string>()
  for (const custom of library.customs) meshTickets(custom.object, tickets)
  if (library.clipboard) meshTickets(library.clipboard, tickets)

  return {
    version: 2,
    customs: library.customs,
    clipboard: library.clipboard,
    presets: reference.presets,
    activePresetId: reference.activePresetId,
    opacity: reference.opacity,
    // Sorted, so two snapshots of the same shelf compare equal and the writer
    // can tell "a model was added" from "a name was edited". See `writeShelf`.
    meshIds: [...tickets].sort(),
  }
}

/**
 * A stored blob, or null if it is not one of ours.
 *
 * ALL OR NOTHING HERE, unlike the preferences, and the difference is that these
 * things refer to each other: a half-read shelf is presets pointing at pictures
 * that did not survive the read. The version is checked first for the same
 * reason -- see `SHELF_KEY`.
 */
export function shelfFrom(raw: unknown): Shelf | null {
  const stored = fields(raw)
  if (!stored || stored.version !== 2) return null

  const customs = list(stored.customs, 500, (item): CustomObject | undefined => {
    const entry = fields(item)
    const id = text(entry?.id)
    const name = text(entry?.name)
    const object = objectFrom(entry?.object)
    return id === undefined || name === undefined || !object ? undefined : { id, name, object }
  })
  const clipboard = objectFrom(stored.clipboard) ?? null
  const presets = list(stored.presets, MAX_PRESETS, presetFrom)
  const opacity = num(0, 1)(stored.opacity)
  const meshIds = list(stored.meshIds, 200, text)

  // The active preset has to be one of the presets that survived; an id
  // pointing nowhere is a panel with no slots and no way to get any.
  const named = text(stored.activePresetId)
  const activePresetId =
    named !== undefined && presets.some((p) => p.id === named) ? named : (presets[0]?.id ?? '')

  return {
    version: 2,
    customs,
    clipboard,
    presets,
    activePresetId,
    opacity: opacity ?? DEFAULT_REFERENCE_OPACITY,
    meshIds,
  }
}

/**
 * Puts a stored shelf back, ONCE THE MODELS IT STANDS ON ARE BACK.
 *
 * THAT ORDER IS THE CALLER'S JOB and it is not negotiable: a custom standing on
 * an import is a ticket, so the library has to be repopulated before the
 * objects that point into it or the panel draws a thumbnail of a solid whose
 * base throws. `remember` does it by asking the vault for the record's models
 * before it gets here.
 *
 * WHAT CANNOT BE MADE WHOLE IS DROPPED. If a model did not come back -- the
 * write that stored it hit a full disk, the record failed its check -- the
 * customs standing on it are left out entirely rather than restored as tickets
 * to nothing. A shelf with one row missing is a disappointment; a shelf with a
 * row that throws when you look at it is a broken app.
 */
export function applyShelf(shelf: Shelf): void {
  // Before anything is put back, so the counters are past every id arriving and
  // the next thing saved cannot be handed one of them. See `seedCustomIds`.
  seedCustomIds(shelf.customs.map((c) => c.id))
  seedReferenceIds([
    ...shelf.presets.map((p) => p.id),
    ...shelf.presets.flatMap((p) => p.slots.map((slot) => slot?.id ?? '')),
  ])

  const whole = (object: SceneObject): boolean => {
    const tickets = new Set<string>()
    meshTickets(object, tickets)
    for (const id of tickets) if (!meshEntry(id)) return false
    return true
  }

  useLibrary.setState({
    customs: shelf.customs.filter((c) => whole(c.object)),
    clipboard: shelf.clipboard && whole(shelf.clipboard) ? shelf.clipboard : null,
  })

  useReference.setState({
    // An empty list is not a state this store allows -- the panel has nowhere
    // to put a picture without a preset -- so a shelf that stored none leaves
    // the one the store made for itself alone.
    ...(shelf.presets.length > 0
      ? { presets: shelf.presets, activePresetId: shelf.activePresetId }
      : {}),
    opacity: shelf.opacity,
  })
}

// --- Wiring the two lanes ----------------------------------------------------

/**
 * A save that waits for the hand to stop moving.
 *
 * Dragging a brush-size slider writes the store on every pointer move, and a
 * save on every one of those is a hundred writes for one decision. `flush` is
 * for the one moment that cannot wait -- see `remember`.
 */
function debounced(ms: number, run: () => void): { poke: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    poke: () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        run()
      }, ms)
    },
    flush: () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      run()
    },
  }
}

const PREFS_DELAY = 400
const SHELF_DELAY = 300

function writePrefs(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefsOf(useTools.getState())))
  } catch {
    // A full or forbidden store -- private browsing refuses outright. Losing a
    // preference is not worth an error in front of somebody who is modelling.
  }
}

function readPrefs(): void {
  if (typeof localStorage === 'undefined') return
  let stored: string | null = null
  try {
    stored = localStorage.getItem(PREFS_KEY)
  } catch {
    return
  }
  if (stored === null) return
  try {
    applyPrefs(prefsFrom(JSON.parse(stored)))
  } catch {
    // Not JSON at all. Nothing this app can use, and leaving it there would
    // mean parsing the same wreck on every load for the life of the browser.
    try {
      localStorage.removeItem(PREFS_KEY)
    } catch {
      /* Nothing further to try. */
    }
  }
}

/**
 * Whether the user has already put something on the shelf this session.
 *
 * THE ANSWER TO A RACE. The shelf is read asynchronously, and somebody quick --
 * or somebody on a slow disk -- can copy a solid or drop in a picture before it
 * lands. Applying the stored shelf over that would delete something the user
 * did seconds ago, which is the one outcome worse than not restoring at all. So
 * a shelf already touched keeps what is on it, and the stored one is left where
 * it is to be read again next time.
 */
function untouched(): boolean {
  const library = useLibrary.getState()
  const reference = useReference.getState()
  return (
    library.customs.length === 0 &&
    library.clipboard === null &&
    reference.placements.length === 0 &&
    reference.presets.length === 1 &&
    reference.presets[0].slots.every((slot) => slot === null)
  )
}

/** Solids that stand on no imported model, and can therefore be stored without
 *  one. See `writeShelf`, the only caller, for when that becomes the question. */
function standsAlone(object: SceneObject): boolean {
  const tickets = new Set<string>()
  meshTickets(object, tickets)
  return tickets.size === 0
}

let writing: Promise<void> = Promise.resolve()

/**
 * Stores the shelf, and if the disk says no, stores the light half of it.
 *
 * THE MODELS GO DOWN FIRST AND ONLY ONCE, through the vault, which is the one
 * thing that knows whether a model is already there and the one thing allowed
 * to take one away -- see `meshVault.ts`. What that buys here is that a rename
 * or an opacity nudge copies no triangles at all. The record naming them
 * follows, so it never names a model that is not there yet.
 *
 * If a model will not fit, the fallback drops it AND the customs that stand on
 * it -- never one without the other, or the next load would restore a ticket to
 * nothing -- and keeps the pictures and the plain solids, which is most of what
 * most shelves hold.
 *
 * Serialised behind one promise so two quick edits cannot interleave their
 * writes and leave the earlier one on top.
 */
function writeShelf(): void {
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const shelf = shelfOf()
      const heavy = await keepMeshes(shelf.meshIds)

      const light: Shelf = {
        ...shelf,
        meshIds: [],
        customs: shelf.customs.filter((c) => standsAlone(c.object)),
        clipboard: shelf.clipboard && standsAlone(shelf.clipboard) ? shelf.clipboard : null,
      }
      const record = heavy ? shelf : light

      try {
        await idbPut(SHELF_KEY, record)
      } catch {
        try {
          await idbPut(SHELF_KEY, light)
        } catch {
          // And if even that will not fit, the stored shelf is REMOVED rather
          // than left as it was. What is on disk would otherwise be a shelf
          // from some earlier minute, which comes back next time as work the
          // user undid -- a deleted custom returning from the dead.
          await idbDelete(SHELF_KEY).catch(() => undefined)
          return
        }
      }

      // What the shelf wants, restated after every write: a custom deleted off
      // it releases the model it was standing on, and this is what says so. The
      // sweep that follows takes away whatever nothing wants any more -- and it
      // is the vault, not this file, that decides what "nothing" means, because
      // a saved project's scene may be standing on the very same model.
      claimMeshes(SHELF_CLAIM, record.meshIds)
      await sweepMeshes().catch(() => undefined)
    })
}

let started = false

/**
 * Start remembering. ONE CALL, from `main.tsx`, BEFORE React mounts.
 *
 * Before, because the preferences half of this is synchronous precisely so the
 * theme is on the document element for the first paint. Everything after that
 * first line may take as long as it likes.
 */
export function remember(): void {
  if (started) return
  started = true

  readPrefs()
  const prefs = debounced(PREFS_DELAY, writePrefs)
  useTools.subscribe(prefs.poke)

  if (typeof window !== 'undefined') {
    // A refresh does not wait for a timer. `pagehide` fires on every way out of
    // a page -- reload, navigation, closing the tab -- and `visibilitychange`
    // catches the mobile case, where a tab switched away from may never come
    // back and may never fire anything else.
    window.addEventListener('pagehide', prefs.flush)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') prefs.flush()
    })
  }

  void idbGet<unknown>(SHELF_KEY)
    .then(async (raw) => {
      const shelf = raw === undefined ? null : shelfFrom(raw)
      if (!shelf) return false

      // The models the record names, put back on the library shelf before
      // anything that tickets them is applied -- a custom whose model is
      // missing is dropped rather than restored broken, and that judgement
      // needs the library already populated. The vault notes every one that
      // came back as being on disk, which is what stops the next save
      // rewriting bytes that are already there.
      await loadMeshes(shelf.meshIds)

      // Checked HERE rather than before the reads: the user may well have
      // copied something while the disk was busy, and applying over that would
      // delete work they did seconds ago.
      if (!untouched()) return false
      applyShelf(shelf)
      return true
    })
    .catch(() => false)
    .then((restored) => {
      // THE SHELF HAS NOW SAID WHAT IT WANTS, whether or not it restored
      // anything -- an empty claim from a first run is still a claim, and the
      // vault sweeps nothing until every claimant has made one. Leaving this
      // out would not delete a model; it would quietly stop any model from ever
      // being deleted, which is the safe half of getting it wrong.
      claimMeshes(SHELF_CLAIM, shelfOf().meshIds)

      const shelf = debounced(SHELF_DELAY, writeShelf)

      // WHAT A SAVE IS FOR, stated as five values.
      //
      // Subscribing to these two stores outright would save on things that are
      // not stored at all: `placements` changes on every pointer move of a
      // decal drag, and each of those would schedule a write of a shelf that
      // has not changed. Comparing what is actually kept -- by identity, which
      // is exact because every one of these is replaced rather than mutated --
      // means a drag across the block writes nothing.
      const signature = (): unknown[] => {
        const library = useLibrary.getState()
        const reference = useReference.getState()
        return [
          library.customs,
          library.clipboard,
          reference.presets,
          reference.activePresetId,
          reference.opacity,
        ]
      }
      let last = signature()
      const poke = () => {
        const now = signature()
        const changed = now.some((value, i) => value !== last[i])
        last = now
        if (changed) shelf.poke()
      }
      useLibrary.subscribe(poke)
      useReference.subscribe(poke)

      // AND ONE WRITE FOR WHOEVER GOT HERE FIRST. Everything above is
      // asynchronous, so a quick hand -- or a slow disk -- can copy a solid
      // before any of it has run, and that change fired no subscription because
      // there was none to fire. Skipped when this load restored something,
      // which would only be writing back what was just read.
      if (!restored && !untouched()) shelf.poke()
    })
}
