/**
 * WHAT A PROJECT IS: the three benches, taken together, given a name.
 *
 * THE UNIT IS THE WORKSHOP AND NOT THE DOCUMENT, which is the one decision in
 * this file everything else follows from. The obvious project is the modelling
 * scene -- it is what Import and Export already read and write, it is the thing
 * the app calls a `Doc`, and the other two screens are machines rather than
 * documents. What is wrong with it is what a user would find the morning after:
 * a vase turned on the lathe and a set of panels cut on the laser are not
 * scratch work, they are two thirds of the same object, and a project that
 * saved only the scene would put the bowl back and quietly throw away the lump
 * it was turned from. So a project holds all three. Opening one puts the whole
 * workshop back as it stood.
 *
 * THIS FILE IS THE RECORD, NOT THE STORAGE. Capture, put back, and read a
 * stranger's copy of one: pure functions over the three stores, with no
 * IndexedDB, no keys and no autosave anywhere in it. That is what lets the
 * check suite build a project, round-trip it through `structuredClone` -- which
 * is exactly the transformation IndexedDB performs -- and put it back, under
 * `tsx`, with no browser in sight. The shelf it actually lives on is
 * `projectStore.ts`.
 *
 * WHAT IS DELIBERATELY LEFT OUT, because the omissions are the decisions:
 *
 *  - THE UNDO STACKS, all three. A history is the record of a sitting, not of a
 *    thing; keeping it would mean a project opened cold offers to walk back
 *    edits made a week ago in a session the user does not remember, and the
 *    stacks are three deep copies of the whole workshop apiece. Opening a
 *    project is a fresh start on old work.
 *  - THE SELECTION, the armed tools, the drag in progress. Every one of them is
 *    something a hand was doing rather than something that was made, and the
 *    store that holds them says so at length already.
 *  - THE SHELF -- saved customs, the clipboard, the reference pictures. Those
 *    are POSSESSIONS and they follow the user rather than the project: a solid
 *    saved to the shelf is meant to be reachable from the next project too,
 *    which is exactly why it is stored where it is. See `persist.ts`.
 *  - THE PREFERENCES. A project that carried the theme would change the colour
 *    of the app when it opened.
 *
 * AND WHAT RIDES ALONG THAT IS NOT WORK: `screen`. Which bench you were at is
 * the one piece of "where you were" that belongs to a project rather than to
 * the app, and it only became storable when the benches themselves did -- see
 * the note in `persist.ts` about why the preferences deliberately drop it.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import {
  CLAY_HEIGHT_MAX,
  CLAY_HEIGHT_MIN,
  CLAY_RADIUS_MAX,
  CLAY_RADIUS_MIN,
  CLAY_RINGS,
  CLAY_SIDES_MAX,
  CLAY_SIDES_MIN,
  CLAY_WALL_MAX,
  CLAY_WALL_MIN,
  freshClay,
} from '../geometry/clay'
import type { Clay, Hollow } from '../geometry/clay'
import { seedIds } from '../geometry/types'
import type { Doc, SceneObject } from '../geometry/types'
import { SCREENS } from '../screens'
import type { ScreenId } from '../screens'
import { bool, fields, list, meshTickets, num, objectFrom, oneOf, text, whole } from './checked'
import { useDoc } from './docStore'
import { useLathe } from './latheStore'
import {
  BLOCK_MAX,
  BLOCK_MIN,
  DEFAULT_BLOCK,
  bedIsUncut,
  freshPieces,
  seedPieceIds,
  useLaser,
} from './laserStore'
import { useTools } from './toolStore'

/**
 * A piece of geometry as it goes to disk: the buffers themselves, and nothing
 * that can be worked out from them.
 *
 * WHY NOT `MeshRecord`, which already does this. That type carries a model's
 * IDENTITY as well as its triangles -- an id, the label a file gave it, the
 * natural size it was normalised from -- because it describes something in the
 * mesh LIBRARY that documents hold tickets to. A piece on the cutting bed is
 * none of that. It has no file behind it, no label, and nothing points at it
 * from anywhere else; it is a shape that came out of a boolean and lives on one
 * bed. Two types, because they answer two questions.
 *
 * TYPED ARRAYS, STORED AS THEMSELVES. IndexedDB keeps a structured clone, so a
 * `Float32Array` goes in and comes back as one rather than as a JSON array of
 * numbers three times the size and slower at both ends -- which is the whole
 * reason the heavy half of what this app keeps is on that shelf and not the
 * other one.
 */
export type StoredGeometry = {
  attributes: { name: string; array: Float32Array; itemSize: number }[]
  /** Null for the ordinary case: a cut hands back non-indexed triangles, and
   *  the block starts as six unindexed quads. Kept because an imported block
   *  need not be. */
  index: Uint32Array | null
}

/** One piece on the bed, with its geometry flattened for storage. `volume` is
 *  carried rather than remeasured: it was measured at the cut, in block space,
 *  and it is what decides which pieces are offcut. */
export type StoredPiece = {
  id: string
  volume: number
  geometry: StoredGeometry
}

/** The cutting bench, as one record. Exactly the four fields of `LaserState`
 *  that are the bed rather than the sitting. */
export type StoredBed = {
  dims: [number, number, number]
  pieces: StoredPiece[]
  offcut: string[]
  choices: string[][]
}

/**
 * A whole project.
 *
 * VERSIONED, like everything else this app stores, and for the same reason: the
 * types under it live in this codebase and are still changing, so the one
 * failure that must never happen is yesterday's shape being read as today's.
 * Bumping the number retires every stored project at a stroke -- which is a
 * heavier loss here than it is for a shelf of preferences, so the number will
 * be bumped only for a change that genuinely cannot be read forwards.
 */
export type Project = {
  version: 1
  id: string
  name: string
  /** Epoch milliseconds. `created` never moves; `edited` is set by every save,
   *  and it is what the navigator sorts on. */
  created: number
  edited: number
  /** Which bench this project was last worked at. See the note at the top. */
  screen: ScreenId
  doc: Doc
  clay: Clay
  bed: StoredBed
  /**
   * The imported models the scene stands on, by id.
   *
   * The same arrangement the shelf uses and for the same reason: a model is the
   * heaviest thing here and belongs under its own key, written once, rather
   * than copied into this record every time a cube is nudged. The vault holds
   * the bytes and decides when one may be deleted -- which it can only do
   * because both the shelf and every project declare what they are standing on.
   * See `meshVault.ts`.
   */
  meshIds: string[]
}

/**
 * What the navigator needs to draw one row, and no more than that.
 *
 * A SEPARATE, SMALL RECORD, and it is the difference between a front door that
 * opens instantly and one that does not. The Welcome screen lists every project
 * the user has; if listing them meant reading them, opening the app would mean
 * pulling every cut bed and every imported model in the workshop off the disk
 * to print a few names and dates. So the summaries live together under one key
 * and the projects live one per key, and nothing heavy is read until somebody
 * asks for a particular project by name.
 *
 * `meshIds` rides along for a second reason: it is what lets the vault know
 * what every project is standing on without opening any of them.
 */
export type ProjectSummary = {
  id: string
  name: string
  created: number
  edited: number
  screen: ScreenId
  /** How many solids are in the scene. */
  objects: number
  /** Whether the lathe holds a shaped piece rather than an untouched lump. */
  turned: boolean
  /** Whether the cutter's block has been cut. */
  cut: boolean
  meshIds: string[]
}

// --- Flattening geometry -----------------------------------------------------

/**
 * A geometry's buffers, COPIED.
 *
 * Copied rather than referenced because the stored record outlives this call
 * and may be handed to IndexedDB on another tick: a view onto the live geometry
 * would be a view onto something the renderer is free to have disposed by then.
 * `meshRecord` copies for the same reason.
 */
function storedGeometry(geometry: BufferGeometry): StoredGeometry {
  const attributes: StoredGeometry['attributes'] = []
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name) as BufferAttribute
    attributes.push({
      name,
      array: new Float32Array(attr.array as ArrayLike<number>),
      itemSize: attr.itemSize,
    })
  }
  const index = geometry.getIndex()
  return {
    attributes,
    index: index ? new Uint32Array(index.array as ArrayLike<number>) : null,
  }
}

/** And back again. Nothing is recomputed: normals were computed when the piece
 *  was cut and are stored beside the positions, so a restored bed draws
 *  identically to the one that was saved rather than merely similarly. */
function liveGeometry(stored: StoredGeometry): BufferGeometry {
  const geometry = new BufferGeometry()
  for (const attr of stored.attributes) {
    geometry.setAttribute(attr.name, new BufferAttribute(attr.array, attr.itemSize))
  }
  if (stored.index) geometry.setIndex(new BufferAttribute(stored.index, 1))
  return geometry
}

/**
 * A stored geometry, checked.
 *
 * STRICTER THAN MOST OF WHAT THIS APP READS BACK, and the reason is the same
 * one the mesh vault gives: these arrays are handed to a `BufferAttribute` and
 * on to the GPU. Positions that came back as an ordinary array of numbers are
 * not a piece that draws badly, they are a renderer that throws -- so a typed
 * array is required to be a typed array, and anything else fails the piece.
 */
function geometryFrom(raw: unknown): StoredGeometry | undefined {
  const stored = fields(raw)
  if (!stored || !Array.isArray(stored.attributes)) return undefined
  const attributes: StoredGeometry['attributes'] = []
  for (const item of stored.attributes) {
    const attr = fields(item)
    const name = text(attr?.name)
    const itemSize = num(1, 4)(attr?.itemSize)
    if (name === undefined || itemSize === undefined) return undefined
    if (!(attr?.array instanceof Float32Array)) return undefined
    attributes.push({ name, array: attr.array, itemSize: Math.round(itemSize) })
  }
  // A piece with no positions is not a piece. Everything else the renderer can
  // do without.
  if (!attributes.some((a) => a.name === 'position')) return undefined
  const index = stored.index
  if (index !== null && index !== undefined && !(index instanceof Uint32Array)) return undefined
  return { attributes, index: (index as Uint32Array | undefined) ?? null }
}

// --- Taking a picture of the workshop ----------------------------------------

/**
 * The three benches as they stand, under the identity handed in.
 *
 * The identity is a parameter rather than something read from anywhere, because
 * this same function serves two acts that differ ONLY in it: saving the open
 * project, and forking a copy of it under a new name and a new id. See
 * `duplicate` in `projectStore`.
 */
export function captureProject(identity: {
  id: string
  name: string
  created: number
  edited: number
}): Project {
  const doc = useDoc.getState().doc
  const clay = useLathe.getState().clay
  const laser = useLaser.getState()

  const tickets = new Set<string>()
  for (const object of doc.objects) meshTickets(object, tickets)

  return {
    version: 1,
    ...identity,
    // The bench that was last on show, which is what `screen` holds whether or
    // not the user is currently standing at the front door -- `atWelcome` is a
    // separate flag for exactly this reason. Somebody who goes home and renames
    // a project must not have its bench overwritten with a place that is not
    // one. See `toolStore`.
    screen: useTools.getState().screen,
    doc,
    clay,
    bed: {
      dims: [...laser.dims] as [number, number, number],
      pieces: laser.pieces.map((piece) => ({
        id: piece.id,
        volume: piece.volume,
        geometry: storedGeometry(piece.geometry),
      })),
      offcut: [...laser.offcut],
      choices: laser.choices.map((set) => [...set]),
    },
    // Sorted, so two pictures of the same workshop compare equal and the writer
    // can tell "a model arrived" from "a cube moved".
    meshIds: [...tickets].sort(),
  }
}

// --- Putting one back --------------------------------------------------------

/**
 * Opens a project onto the three benches, replacing whatever was on them.
 *
 * THE IDS ARE SEEDED FIRST, before a single store is written, and it is the
 * least obvious line in the file. A restored scene brings back the very ids it
 * was saved with -- `o1`..`o12` -- against counters a fresh page has at zero,
 * so the next solid off the palette would be handed an id that is already in
 * the scene. Two objects with one id is not cosmetic: every edit reaches both
 * of them. See `seedIds` and `seedPieceIds`.
 *
 * THE HISTORIES ARE CLEARED rather than carried, on all three benches. Nothing
 * was stored to carry -- see the note at the top -- and leaving the previous
 * project's stack in place would let one Ctrl+Z replace this project's scene
 * with the last one's.
 *
 * WHAT IS NOT MADE WHOLE HAS ALREADY BEEN DROPPED by the time this runs: the
 * caller restores the models the scene tickets first and hands over a project
 * whose objects it has checked can stand up. See `openProject`.
 */
export function applyProject(project: Project): void {
  seedIds(project.doc.objects)
  seedPieceIds(project.bed.pieces.map((piece) => piece.id))

  useDoc.setState({
    doc: project.doc,
    selectedObjectIds: [],
    selectedFeatureId: null,
    past: [],
    future: [],
    drag: { kind: 'idle' },
  })

  useLathe.setState({ clay: project.clay, stroke: null, past: [], future: [] })

  useLaser.setState({
    dims: [...project.bed.dims] as [number, number, number],
    pieces: project.bed.pieces.map((piece) => ({
      id: piece.id,
      volume: piece.volume,
      geometry: liveGeometry(piece.geometry),
    })),
    offcut: [...project.bed.offcut],
    choices: project.bed.choices.map((set) => [...set]),
    past: [],
    future: [],
  })
}

/**
 * Clears all three benches: what a NEW project starts from.
 *
 * Its own function rather than each store's own reset, because the three resets
 * that exist are not the same act. `docStore.reset` clears the scene but keeps
 * its history; the lathe's `centreFresh` deliberately keeps the stock size,
 * being a thing you do to a piece rather than a way of getting a new one; and
 * the laser has no single call that puts back both the block and its size.
 * Every one of them is right for the button it sits behind, and none of them is
 * "start again from nothing", which is what this is.
 */
export function blankBenches(): void {
  useDoc.setState({
    doc: { objects: [] },
    selectedObjectIds: [],
    selectedFeatureId: null,
    past: [],
    future: [],
    drag: { kind: 'idle' },
  })
  useLathe.setState({ clay: freshClay(), stroke: null, past: [], future: [] })
  useLaser.setState({
    dims: [DEFAULT_BLOCK, DEFAULT_BLOCK, DEFAULT_BLOCK],
    pieces: freshPieces(),
    offcut: [],
    choices: [],
    past: [],
    future: [],
  })
}

// --- Reading a stranger's copy -----------------------------------------------

/**
 * The lathe's lump, checked.
 *
 * ALL OR NOTHING, unlike a preference, because the parts of a clay depend on
 * each other: a wall is a row of radii measured against a height and clamped
 * against a stock radius, so a wall that came back the wrong length beside a
 * height that did not is not a piece anything here can go on turning.
 *
 * THE WALL IS REBUILT TO THE RIGHT LENGTH rather than taken as stored. Every
 * function on the lathe takes a whole wall and hands back a whole wall, so no
 * consumer asks whether a ring exists -- a wall one ring short would be an
 * `undefined` radius reaching the sweep. A piece saved when the app used a
 * coarser wall comes back resampled across the rings it has now, which is the
 * same shape drawn at a different resolution rather than a different shape.
 */
function clayFrom(raw: unknown): Clay | undefined {
  const stored = fields(raw)
  if (!stored) return undefined
  const height = num(CLAY_HEIGHT_MIN, CLAY_HEIGHT_MAX)(stored.height)
  const radius = num(CLAY_RADIUS_MIN, CLAY_RADIUS_MAX)(stored.radius)
  if (height === undefined || radius === undefined) return undefined

  // Null is a round piece and is not the same as a missing field, so the two
  // are told apart rather than both falling to the default.
  const sides =
    stored.sides === null ? null : num(CLAY_SIDES_MIN, CLAY_SIDES_MAX)(stored.sides)
  if (sides === undefined) return undefined

  const wall = Array.isArray(stored.wall) ? stored.wall : null
  if (!wall || wall.length === 0) return undefined
  const rings = wall.map((r) => num(0, CLAY_RADIUS_MAX)(r))
  if (rings.some((r) => r === undefined)) return undefined
  const resampled = Array.from({ length: CLAY_RINGS }, (_, i) => {
    const at = (i / (CLAY_RINGS - 1)) * (rings.length - 1)
    return rings[Math.round(at)] as number
  })

  let hollow: Hollow | null = null
  if (stored.hollow !== null && stored.hollow !== undefined) {
    const bore = fields(stored.hollow)
    const thickness = num(CLAY_WALL_MIN, CLAY_WALL_MAX)(bore?.thickness)
    const capTop = bool(bore?.capTop)
    const capBottom = bool(bore?.capBottom)
    if (thickness === undefined || capTop === undefined || capBottom === undefined) {
      return undefined
    }
    hollow = { thickness, capTop, capBottom }
  }

  return { height, radius, sides: sides ?? null, wall: resampled, hollow }
}

/**
 * The cutting bench, checked.
 *
 * A BED WITH NO PIECES IS REFUSED, which is the one case here that is not
 * merely malformed data: the screen draws what is on the bed, and a bed holding
 * nothing is a black window with a compass beside it and no way to get a block
 * back short of resizing one. An uncut block is what an empty bench looks like,
 * so a record that cannot produce even that is failed and the caller starts the
 * bench fresh.
 *
 * `offcut` and `choices` are FILTERED TO PIECES THAT EXIST rather than taken as
 * stored. They are lists of ids pointing into the list above them, and an id
 * pointing at nothing is a highlight nobody can clear and a Delete that throws
 * away less than it says it will.
 */
function bedFrom(raw: unknown): StoredBed | undefined {
  const stored = fields(raw)
  if (!stored) return undefined
  const dims = Array.isArray(stored.dims) ? stored.dims : null
  if (!dims || dims.length !== 3) return undefined
  const sized = dims.map((d) => num(BLOCK_MIN, BLOCK_MAX)(d))
  if (sized.some((d) => d === undefined)) return undefined

  const pieces = list(stored.pieces, 400, (item): StoredPiece | undefined => {
    const piece = fields(item)
    const id = text(piece?.id)
    const volume = num(0, 1e6)(piece?.volume)
    const geometry = geometryFrom(piece?.geometry)
    return id === undefined || volume === undefined || !geometry
      ? undefined
      : { id, volume, geometry }
  })
  if (pieces.length === 0) return undefined

  const known = new Set(pieces.map((piece) => piece.id))
  const offcut = list(stored.offcut, 400, text).filter((id) => known.has(id))
  const choices = list(stored.choices, 400, (item) =>
    Array.isArray(item) ? list(item, 400, text).filter((id) => known.has(id)) : undefined
  ).filter((set) => set.length > 0)

  return {
    dims: [sized[0] as number, sized[1] as number, sized[2] as number],
    pieces,
    offcut,
    choices,
  }
}

/**
 * A stored project, or null if it is not one this app wrote.
 *
 * THE THREE BENCHES FAIL SEPARATELY, and that is the difference between this
 * and the shelf. A shelf is refused whole because the things on it refer to
 * each other -- a preset points at pictures, a custom stands on a model -- so
 * half of one is presets pointing at nothing. The benches refer to NOTHING in
 * each other: a lathe whose wall came back the wrong shape says nothing
 * whatever about whether the scene is readable. Refusing the project over it
 * would throw away a scene somebody spent an afternoon on because a lump they
 * had forgotten about did not survive. So a bench that cannot be read comes
 * back EMPTY, and the rest of the project opens.
 *
 * WHAT IS NOT ALLOWED TO FAIL SOFTLY is the identity: no id, no name, no
 * project. Those are what the navigator draws and what the storage is keyed by,
 * and inventing either would put a row on the front door that is not the thing
 * it claims to be.
 */
export function projectFrom(raw: unknown): Project | null {
  const stored = fields(raw)
  if (!stored || stored.version !== 1) return null

  const id = text(stored.id)
  const name = text(stored.name)
  if (id === undefined || name === undefined) return null

  // A moment in time, and a missing one is NOW rather than the epoch: a project
  // dated 1970 sorts to the bottom of the navigator for ever, which is a worse
  // lie than a project that says it was touched today.
  const now = Date.now()
  const created = whole(0)(stored.created) ?? now
  const edited = whole(0)(stored.edited) ?? created

  const objects: SceneObject[] = []
  if (Array.isArray(stored.doc && (stored.doc as { objects?: unknown }).objects)) {
    for (const item of (stored.doc as { objects: unknown[] }).objects) {
      const object = objectFrom(item)
      // One bad solid costs that solid. The scene around it is whole, which is
      // the same bargain `list` strikes everywhere else in this app: a document
      // is not a set of mutual references the way a shelf is.
      if (object) objects.push(object)
    }
  }

  return {
    version: 1,
    id,
    name,
    created,
    edited,
    screen: oneOf(SCREENS)(stored.screen) ?? 'modelling',
    doc: { objects },
    clay: clayFrom(stored.clay) ?? freshClay(),
    bed: bedFrom(stored.bed) ?? blankBed(),
    meshIds: list(stored.meshIds, 200, text),
  }
}

/** An uncut block, as a record. What a project whose bench did not survive the
 *  read opens with -- see `projectFrom`. */
function blankBed(): StoredBed {
  return {
    dims: [DEFAULT_BLOCK, DEFAULT_BLOCK, DEFAULT_BLOCK],
    pieces: freshPieces().map((piece) => ({
      id: piece.id,
      volume: piece.volume,
      geometry: storedGeometry(piece.geometry),
    })),
    offcut: [],
    choices: [],
  }
}

/**
 * The row the navigator draws for a project.
 *
 * WHAT IT SAYS ABOUT THE TWO BENCHES IS A YES OR A NO, not a number. A count of
 * solids is a real measure of a scene -- twelve objects is meaningfully more
 * than two -- but there is no equivalent for a lathe: a piece is one piece
 * however much of it has been cut away, and "96 rings" is a number about this
 * app rather than about the work. So the card says whether there is anything on
 * those benches at all, which is the only question a chooser needs answered.
 */
export function summaryOf(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    created: project.created,
    edited: project.edited,
    screen: project.screen,
    objects: project.doc.objects.length,
    turned: isTurned(project.clay),
    // Asked of the bench's own function rather than answered again here: "has
    // this block been cut" is a question the cutter already knows how to read
    // off a volume, and a second reading of it here would be a second thing to
    // keep in step with the kerf.
    cut: !bedIsUncut(project.bed.pieces),
    meshIds: project.meshIds,
  }
}

/**
 * Whether the lathe holds work rather than a lump.
 *
 * READ OFF THE WALL rather than kept as a flag, the same way the cutter reads
 * "uncut" off a volume and for the same reason: a flag has to be remembered by
 * undo, by a fresh lump, by every tool, and the one that forgets is a card that
 * lies about what is inside a project. A wall standing at exactly the stock
 * radius all the way up is an untouched lump; a bore is work by itself, since
 * nothing hollows a piece by accident.
 */
function isTurned(clay: Clay): boolean {
  if (clay.hollow !== null) return true
  return clay.wall.some((r) => Math.abs(r - clay.radius) > 1e-9)
}

/** One stored summary, checked. A row that cannot be read is dropped from the
 *  navigator rather than drawn as a project with no name -- and the project's
 *  own record is left alone on the disk, since a bad index is not evidence that
 *  the thing it indexes is bad. */
export function summaryFrom(raw: unknown): ProjectSummary | undefined {
  const stored = fields(raw)
  if (!stored) return undefined
  const id = text(stored.id)
  const name = text(stored.name)
  if (id === undefined || name === undefined) return undefined
  const now = Date.now()
  const created = whole(0)(stored.created) ?? now
  return {
    id,
    name,
    created,
    edited: whole(0)(stored.edited) ?? created,
    screen: oneOf(SCREENS)(stored.screen) ?? 'modelling',
    objects: whole(0)(stored.objects) ?? 0,
    turned: bool(stored.turned) ?? false,
    cut: bool(stored.cut) ?? false,
    meshIds: list(stored.meshIds, 200, text),
  }
}
