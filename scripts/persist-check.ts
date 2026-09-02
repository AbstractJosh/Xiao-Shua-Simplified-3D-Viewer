/**
 * Headless verification of what survives a refresh, and what must not.
 *
 * The app keeps two kinds of thing between visits -- preferences and the shelf
 * -- and both are stored by writing live state out and reading strangers' JSON
 * back in. That shape has three failure modes worth a suite of its own, and
 * none of them is visible by looking at the code:
 *
 *  - A FIELD THAT DOES NOT COME BACK. The table in `persist.ts` is the only
 *    thing deciding what is remembered, so this walks it and states, key by
 *    key, what is in it and what is deliberately left out.
 *  - A VALUE THAT COMES BACK WRONG. Everything read is validated, and a
 *    validator that is too strict silently loses a setting while one that is
 *    too loose puts a NaN into a brush radius. Both are checked here against
 *    junk written on purpose.
 *  - A RESTORE THAT IS NOT WHOLE. A saved custom may stand on an imported
 *    model, which lives outside the document in the mesh library; if the model
 *    does not come back with it, the custom must be dropped rather than
 *    restored as a ticket to nothing.
 *
 * The storage itself is not exercised -- there is no IndexedDB in Node, and it
 * is not what breaks. What is exercised is every pure function between the
 * stores and the shelf, with `structuredClone` standing in for the round trip,
 * which is exactly the transformation IndexedDB performs.
 *
 * Run: npx tsx scripts/persist-check.ts
 */
import { BufferAttribute, BufferGeometry } from 'three'
import {
  forgetMeshes,
  meshEntry,
  meshRecord,
  registerMesh,
  restoreMesh,
} from '../src/geometry/meshLibrary'
import type { MeshRecord } from '../src/geometry/meshLibrary'
import { makeObject } from '../src/geometry/types'
import { seedCustomIds, useLibrary } from '../src/store/libraryStore'
import { applyPrefs, applyShelf, prefsFrom, prefsOf, shelfFrom, shelfOf } from '../src/store/persist'
import { freshClay } from '../src/geometry/clay'
import { useDoc } from '../src/store/docStore'
import { useLathe } from '../src/store/latheStore'
import { useLaser } from '../src/store/laserStore'
import {
  applyProject,
  blankBenches,
  captureProject,
  projectFrom,
  summaryOf,
} from '../src/store/projectRecord'
import type { Prefs } from '../src/store/persist'
import { seedReferenceIds, useReference } from '../src/store/referenceStore'
import { BRUSH_RADIUS_MAX, useTools } from '../src/store/toolStore'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}

const tools = () => useTools.getState()
const library = () => useLibrary.getState()
const reference = () => useReference.getState()

/** The stores as a fresh page has them, so a restore is tested against the
 *  state it will actually meet rather than against its own leftovers. */
function blank(): void {
  useLibrary.setState({ customs: [], clipboard: null })
  useReference.setState({
    presets: [{ id: 'p0', name: 'Preset 1', slots: [null, null, null] }],
    activePresetId: 'p0',
    placements: [],
    highlightId: null,
    editingId: null,
  })
}

console.log('\nPreferences\n')

const DEFAULTS = prefsOf(tools())
const KEYS = Object.keys(DEFAULTS)

// What the user asked for by name, stated one key at a time rather than as a
// count: a table that loses the theme and gains a dial still has the same
// length.
for (const key of [
  'displayUnit',
  'theme',
  'showOutlines',
  'motion',
  'gameControls',
  'flightSpeed',
  'snap',
  'snapDistance',
  'erodeRadius',
  'erodeHeat',
  'sculptRadius',
  'sculptStrength',
  'smootherRadius',
  'pushReach',
  'pullReach',
  'smoothReach',
  'recentColors',
]) {
  check(`${key} is remembered`, KEYS.includes(key))
}

// And the omissions, which are decisions rather than oversights -- see the
// note on `PREFS`. A tool that came back armed would melt the first solid the
// pointer crossed.
for (const key of [
  'brushTool',
  'latheTool',
  'laserTool',
  'cutActive',
  'cutPlane',
  'screen',
  'openPanel',
  'helpSection',
  'rulers',
  'latheRulers',
  'mirrors',
  'latheZoom',
  'lathePan',
]) {
  check(`${key} is deliberately forgotten`, !KEYS.includes(key))
}

/**
 * Every preference, moved off its default.
 *
 * Written out by hand rather than generated, because a generated value cannot
 * fail the way this is meant to catch: a field that is stored but never read
 * back comes out of a generator looking identical to its default. Each of these
 * is a value a user could have chosen and none is what the app starts on.
 */
const MOVED: Prefs = {
  openTo: 'recent',
  displayUnit: 'in',
  theme: 'light',
  showOutlines: false,
  motion: 'off',
  gameControls: true,
  flightSpeed: 9,
  snap: false,
  snapDistance: 0.5,
  laserSnapDistance: 22,
  latheSnapDistance: 15,
  mirrorSnapAngle: 12,
  gizmoHidden: true,
  islandCollapsed: true,
  islandPlacement: { hx: 'right', hy: 'bottom', x: 40, y: 24 },
  stockOpen: false,
  mirrorAxis: 2,
  eraseScope: 'selected',
  brushScope: 'selected',
  recentColors: ['#ff0000', '#00ff80'],
  erodeRadius: 0.4,
  erodeSizeUnit: 'cm',
  erodeHeat: 0.8,
  erodeSmooth: 0.35,
  sculptRadius: 0.6,
  sculptSizeUnit: 'in',
  sculptStrength: 0.25,
  sculptSmooth: 0.9,
  smootherRadius: 0.05,
  smootherSizeUnit: 'cm',
  smootherStrength: 0.75,
  pushReach: 0.3,
  pushSizeUnit: 'cm',
  pushStrength: 0.9,
  pullReach: 0.35,
  pullSizeUnit: 'in',
  pullStrength: 0.15,
  smoothReach: 0.45,
  smoothSizeUnit: 'cm',
  smoothStrength: 0.05,
  hollowSizeUnit: 'in',
  freehandSmoothing: 0.9,
  fitCurve: true,
  sculptFit: false,
}

const shown = (value: unknown): string => JSON.stringify(value) ?? 'undefined'
const defaultsAt = DEFAULTS as unknown as Record<string, unknown>
const movedAt = MOVED as unknown as Record<string, unknown>

// The one line that keeps this file honest as the table grows: a preference
// added to `PREFS` and not to `MOVED` fails here rather than going untested.
const uncovered = KEYS.filter((key) => !(key in movedAt))
check('every remembered preference is covered here', uncovered.length === 0, uncovered.join(', '))
check(
  'and the check knows of none the table has dropped',
  Object.keys(movedAt).every((key) => KEYS.includes(key)),
  Object.keys(movedAt).filter((key) => !KEYS.includes(key)).join(', ')
)
const unmoved = KEYS.filter((key) => shown(movedAt[key]) === shown(defaultsAt[key]))
check('and each is genuinely off its default', unmoved.length === 0, unmoved.join(', '))

useTools.setState(MOVED)
// JSON both ways, which is what `localStorage` does to it.
const storedPrefs: unknown = JSON.parse(JSON.stringify(prefsOf(tools())))
useTools.setState(DEFAULTS)
check('the store is back to a fresh app', shown(prefsOf(tools())) === shown(DEFAULTS))

applyPrefs(prefsFrom(storedPrefs))
const restored = prefsOf(tools()) as unknown as Record<string, unknown>
const lost = KEYS.filter((key) => shown(restored[key]) !== shown(movedAt[key]))
check('every preference survives the round trip', lost.length === 0, lost.join(', '))

console.log('\nPreferences that should not be trusted\n')

const junk = prefsFrom({
  theme: 'banana',
  displayUnit: 'furlong',
  snap: 1,
  erodeRadius: 'wide',
  islandPlacement: { hx: 'middle', hy: 'top', x: 0, y: 0 },
  recentColors: ['not a colour'],
})
check('nothing unrecognisable gets in', Object.keys(junk).length === 0, Object.keys(junk).join(', '))

const mixed = prefsFrom({ theme: 'banana', showOutlines: false })
check(
  'and one bad field costs only itself',
  mixed.showOutlines === false && !('theme' in mixed),
  shown(mixed)
)

check(
  'a blob that is not even an object is refused',
  [null, 42, 'prefs', [1, 2]].every((raw) => Object.keys(prefsFrom(raw)).length === 0)
)

check(
  'a value past the range is clamped rather than thrown away',
  prefsFrom({ erodeRadius: 999 }).erodeRadius === BRUSH_RADIUS_MAX,
  shown(prefsFrom({ erodeRadius: 999 }).erodeRadius)
)

check(
  'a NaN is refused outright, since it would poison every sum after it',
  !('erodeRadius' in prefsFrom({ erodeRadius: NaN })) &&
    !('flightSpeed' in prefsFrom({ flightSpeed: Infinity }))
)

console.log('\nThe shelf\n')

blank()
const cube = makeObject({ kind: 'box', size: [1, 1, 1] }, [0, 0, 0])
library().saveCustom(cube)
library().copyObject(cube)
reference().putImage(0, {
  name: 'plan.png',
  src: 'data:image/png;base64,AAAA',
  width: 400,
  height: 200,
})

// `structuredClone` is not decoration here: it is precisely what IndexedDB does
// to a value on the way in and out, so a shelf holding something unclonable
// would fail on this line rather than in a browser.
const storedShelf = structuredClone(shelfOf())

blank()
const shelf = shelfFrom(storedShelf)
check('a stored shelf is recognised', shelf !== null)
// No models: a box stands on nothing, so the list of ids is empty and there is
// nothing for the reader to fetch.
check('a shelf of plain solids names no models', storedShelf.meshIds.length === 0)
if (shelf) applyShelf(shelf)

check('the saved custom is back', library().customs.length === 1, `${library().customs.length}`)
check('under the name it was given', library().customs[0]?.name === 'Custom 1')
check('as the solid it was saved as', library().customs[0]?.object.base.kind === 'box')
check('the clipboard is back too', library().clipboard?.base.kind === 'box')
check(
  'and the picture is back in its slot',
  reference().presets[0]?.slots[0]?.name === 'plan.png',
  shown(reference().presets[0]?.slots[0]?.name)
)
check(
  'with the bytes it was uploaded as',
  reference().presets[0]?.slots[0]?.src === 'data:image/png;base64,AAAA'
)

// The counters that mint ids start at zero on every page load, so this is the
// one thing standing between a restored shelf and two rows under one id.
seedCustomIds(['k9000'])
check(
  'a custom saved after a restore cannot be handed a restored id',
  library().saveCustom(cube) === 'k9001',
  library().customs[library().customs.length - 1]?.id
)
seedReferenceIds(['i9000'])
reference().putImage(1, { name: 'side.png', src: 'data:,', width: 10, height: 10 })
check(
  'and neither can a picture uploaded after one',
  reference().presets[0]?.slots[1]?.id === 'i9001',
  shown(reference().presets[0]?.slots[1]?.id)
)

console.log('\nA custom standing on an imported model\n')

blank()
forgetMeshes()
const triangle = new BufferGeometry()
triangle.setAttribute(
  'position',
  new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
)
const entry = registerMesh(triangle, 'widget.stl')
library().saveCustom(makeObject({ kind: 'mesh', meshId: entry.id, label: 'widget', size: [1, 1, 1] }, [0, 0, 0]))

const withModel = structuredClone(shelfOf())
// The models the shelf names, taken off the library the way the mesh vault
// takes them and put through the same clone the disk performs. The vault itself
// is not driven here -- it is all IndexedDB, which Node has none of -- but what
// it stores is exactly this, so the restore below is the real one.
const itsModels = structuredClone(
  withModel.meshIds
    .map((id) => meshRecord(id))
    .filter((record): record is MeshRecord => record !== undefined)
)
check(
  'the shelf names the model the custom stands on',
  withModel.meshIds.includes(entry.id),
  withModel.meshIds.join(', ')
)
check(
  'and the model itself is stored beside it, as triangles',
  itsModels[0]?.attributes.some((a) => a.name === 'position' && a.array.length === 9),
  shown(itsModels[0]?.attributes.map((a) => `${a.name}:${a.array.length}`))
)

// A fresh page: nothing has been imported this session.
blank()
forgetMeshes()
check('the mesh library starts empty', meshEntry(entry.id) === undefined)

const restoredShelf = shelfFrom(withModel)
// THE MODELS GO BACK FIRST, which is now the caller's job rather than
// `applyShelf`'s: in the app the vault does it, because a project's scene may
// be standing on the very same model and only one thing may own that library.
// The order is what is being checked here as much as the outcome.
for (const record of itsModels) restoreMesh(record)
if (restoredShelf) applyShelf(restoredShelf)
check('the model is put back under the id the custom holds', meshEntry(entry.id) !== undefined)
check('and the custom survived with it', library().customs.length === 1)

// The same shelf, with the model missing -- a write that ran out of room, or a
// record that failed its check.
blank()
forgetMeshes()
// The record still names the model; the model's own key is gone.
const orphaned = shelfFrom(structuredClone(withModel))
if (orphaned) applyShelf(orphaned)
check(
  'a custom whose model did not come back is dropped rather than restored broken',
  library().customs.length === 0,
  `${library().customs.length}`
)

console.log('\nWhat the shelf refuses\n')

check(
  'a shelf written by another version is not read at all',
  shelfFrom({ ...structuredClone(storedShelf), version: 1 }) === null &&
    shelfFrom({ ...structuredClone(storedShelf), version: 3 }) === null
)
check(
  'and neither is a blob that is not one',
  [null, 42, 'shelf', []].every((raw) => shelfFrom(raw) === null)
)

const hostile = structuredClone(storedShelf)
const picture = hostile.presets[0]?.slots[0]
if (picture) picture.src = 'http://example.com/tracker.png'
check(
  'a picture that is not its own bytes is refused, not handed to an img tag',
  shelfFrom(hostile)?.presets[0]?.slots[0] === null
)

const bent = structuredClone(storedShelf)
const base = bent.customs[0]?.object.base as { size?: unknown } | undefined
if (base) base.size = 'wide'
check(
  'a solid whose base lost its numbers is dropped',
  shelfFrom(bent)?.customs.length === 0,
  `${shelfFrom(bent)?.customs.length}`
)

/*
 * PROJECTS: the other half of what survives a refresh, and the half that is
 * WORK rather than preferences.
 *
 * What is exercised here is every pure function between the three benches and
 * the disk -- capture, read back, put back -- with `structuredClone` standing
 * in for the round trip, exactly as the shelf is checked above. The storage
 * itself is not driven, because there is no IndexedDB in Node and it is not
 * what breaks.
 *
 * The failure this section exists to catch is the one that cannot be seen by
 * reading the code: a bench that goes out and does not come back. A project is
 * three unrelated shapes of data stored together, so it is entirely possible
 * for the scene to round-trip perfectly while the lathe's wall quietly returns
 * as a fresh lump -- and nobody would notice until they opened a week-old vase
 * and found a cylinder.
 */
console.log('\nA project: the three benches under one name\n')

blank()
forgetMeshes()
blankBenches()

// A workshop with something on all three benches. Built the way a user builds
// one -- through the stores' own actions where there are any -- so what is
// captured is a state the app can really be in.
const solid = useDoc.getState().addObject({ kind: 'box', size: [1, 1, 1] }, [0, 0.5, 0])
useDoc.getState().setObjectColor([solid], '#ff8800')
// And locked, which is the newest optional key on a solid and the one a
// week-old project would silently lose if `objectFrom` forgot to read it.
useDoc.getState().setObjectLocked(solid, true)
const turned = freshClay()
// A waist: the wall pulled in around the middle, which is the whole of what
// makes a lump a piece.
turned.wall = turned.wall.map((r, i) => (i > 40 && i < 56 ? r * 0.5 : r))
useLathe.setState({ clay: turned })
useLaser.getState().setDim(0, 2)

const captured = structuredClone(
  captureProject({ id: 'pj-1', name: 'Vase', created: 1000, edited: 2000 })
)

check('a project carries the scene', captured.doc.objects.length === 1)
check(
  'with what was done to the solid in it',
  captured.doc.objects[0]?.color === '#ff8800',
  shown(captured.doc.objects[0]?.color)
)
check(
  'it carries the wall off the lathe',
  captured.clay.wall.some((r) => Math.abs(r - captured.clay.radius) > 1e-9)
)
check('and the bed, at the size it was set to', captured.bed.dims[0] === 2)
check(
  'the block goes down as triangles rather than as a promise of them',
  captured.bed.pieces[0]?.geometry.attributes.some(
    (a) => a.name === 'position' && a.array.length > 0
  ),
  shown(captured.bed.pieces[0]?.geometry.attributes.map((a) => a.name))
)
check(
  'no undo history goes with it',
  !Object.keys(captured).includes('past') && !Object.keys(captured).includes('future'),
  Object.keys(captured).join(', ')
)

// A fresh page: three empty benches, and a stranger's copy of the project.
blankBenches()
check('the benches start empty', useDoc.getState().doc.objects.length === 0)

const reopened = projectFrom(captured)
check('a stored project is recognised', reopened !== null)
if (reopened) applyProject(reopened)

check(
  'the scene comes back',
  useDoc.getState().doc.objects.length === 1,
  `${useDoc.getState().doc.objects.length}`
)
check('painted as it was left', useDoc.getState().doc.objects[0]?.color === '#ff8800')
check(
  'and still locked, the key having gone out with the solid',
  captured.doc.objects[0]?.locked === true && useDoc.getState().doc.objects[0]?.locked === true,
  `${shown(captured.doc.objects[0]?.locked)} out, ${shown(useDoc.getState().doc.objects[0]?.locked)} back`
)
check(
  'the lathe comes back turned rather than as a fresh lump',
  useLathe.getState().clay.wall.some((r) => Math.abs(r - useLathe.getState().clay.radius) > 1e-9)
)
check('the bed comes back at the size it was cut at', useLaser.getState().dims[0] === 2)
check(
  'and its geometry is geometry, not a record of one',
  useLaser.getState().pieces[0]?.geometry.getAttribute('position') !== undefined
)
check(
  'nothing arrives with a history to walk back into the last project',
  useDoc.getState().past.length === 0 &&
    useLathe.getState().past.length === 0 &&
    useLaser.getState().past.length === 0
)
check(
  'and nothing arrives selected',
  useDoc.getState().selectedObjectIds.length === 0,
  `${useDoc.getState().selectedObjectIds.length}`
)

// THE COLLISION THIS WOULD OTHERWISE CAUSE. A restored scene brings back the
// ids it was saved with, against counters a fresh page has at zero -- so the
// next solid off the palette would be handed an id that is already in the
// scene, and every edit aimed at one of them would reach both.
blankBenches()
const numbered = structuredClone(captured)
numbered.doc.objects[0].id = 'o9000'
const renumbered = projectFrom(numbered)
if (renumbered) applyProject(renumbered)
const after = useDoc.getState().addObject({ kind: 'sphere', radius: 0.5 }, [2, 0, 0])
check(
  'a solid added after a project is opened cannot be handed a restored id',
  after === 'o9001',
  after
)

console.log('\nWhat a project says about itself, and what it refuses\n')

const card = summaryOf(captured)
check('the card counts the solids', card.objects === 1, `${card.objects}`)
check('and says the lathe holds work', card.turned)
check('and that the block is still uncut', !card.cut)
check('it keeps the name and the moment', card.name === 'Vase' && card.edited === 2000)

check(
  'a project written by another version is not read at all',
  projectFrom({ ...structuredClone(captured), version: 2 }) === null
)
check('and neither is a blob that is not one', projectFrom({ nope: true }) === null)
check(
  'a project with no id is refused rather than given one',
  projectFrom({ ...structuredClone(captured), id: undefined }) === null
)

// ONE BENCH FAILING MUST NOT COST THE OTHERS, which is the difference between a
// project and the shelf: the three benches refer to nothing in each other, so
// refusing the whole project over an unreadable lump would throw away a scene
// somebody spent an afternoon on.
const brokenLathe = structuredClone(captured)
;(brokenLathe.clay as { wall: unknown }).wall = 'flat'
const survived = projectFrom(brokenLathe)
check(
  'a lathe that cannot be read comes back empty, and the scene still opens',
  survived !== null && survived.doc.objects.length === 1,
  `${survived?.doc.objects.length}`
)
check(
  'with a fresh lump on it rather than a broken one',
  survived !== null && survived.clay.wall.every((r) => Math.abs(r - survived.clay.radius) < 1e-9)
)

const brokenBed = structuredClone(captured)
;(brokenBed.bed as { pieces: unknown }).pieces = []
const bedless = projectFrom(brokenBed)
check(
  'a bed with nothing on it comes back as an uncut block rather than a black window',
  bedless !== null && bedless.bed.pieces.length === 1,
  `${bedless?.bed.pieces.length}`
)

// One bad solid costs that solid, not the scene around it -- the same bargain
// struck everywhere else in this file.
const bentScene = structuredClone(captured)
;(bentScene.doc.objects[0].base as { size?: unknown }).size = 'wide'
check(
  'a solid whose base lost its numbers is dropped and the project still opens',
  projectFrom(bentScene)?.doc.objects.length === 0,
  `${projectFrom(bentScene)?.doc.objects.length}`
)

console.log(
  failures === 0
    ? '\nAll persistence checks passed.\n'
    : `\n${failures} persistence check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
