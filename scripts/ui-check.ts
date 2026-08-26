/**
 * Headless verification of the console panels against the REAL stores.
 *
 * Every other suite proves geometry. This one proves the other half: that the
 * panels a user actually clicks survive a populated document, and that the
 * numbers they show are the numbers the document holds. The branches worth
 * checking are exactly the ones that only exist once something is selected --
 * an object's dimension rows, a feature's End face controls, a scene tree with
 * two halves of a cut solid in it -- and those never run in an empty store.
 *
 * The document is built the way a user builds one: drag a solid off the
 * palette, drop a sketch on it, extrude, tilt, cut, undo. After each step the
 * panels are rendered with react-dom/server and the markup is read back, so a
 * panel that renders but shows the wrong thing fails here too.
 *
 * Run: npx tsx scripts/ui-check.ts
 */
import { Box3, Matrix4, Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * zustand v5 hands react-dom/server `getInitialState` as the server snapshot,
 * so a server render shows the store as it was CREATED no matter what the
 * document now contains -- which is precisely why the populated branches of
 * these panels have never executed. Collapsing the two snapshots makes a server
 * render report live state instead.
 *
 * This patches React's hook rather than the stores: the stores under test stay
 * untouched and real, and any store the panels reach is covered automatically.
 * `react` is CJS here, so the property is read off the exports object at call
 * time and this reassignment lands even though imports are hoisted above it.
 */
type SyncStore = <T>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T
) => T
const reactExports = createRequire(import.meta.url)('react') as {
  useSyncExternalStore: SyncStore
}
const realUseSyncExternalStore = reactExports.useSyncExternalStore
reactExports.useSyncExternalStore = ((subscribe, getSnapshot) =>
  realUseSyncExternalStore(subscribe, getSnapshot, getSnapshot)) as SyncStore

const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('maxLeafSize')) return
  realWarn(...args)
}

import { ExportTools } from '../src/console/ExportTools'
import { Inspector } from '../src/console/Inspector'
import { NavBar } from '../src/console/NavBar'
import { CutActions, CutTool, SnapTool } from '../src/console/NavTools'
import { ClipboardPanel, liveTiles } from '../src/console/ClipboardPanel'
import { VIEW, framingDistance } from '../src/console/ObjectThumbnail'
import { ObjectPanel } from '../src/console/ObjectPanel'
import { PlacementPanel } from '../src/console/PlacementPanel'
import { MergeButton, SceneTree } from '../src/console/SceneTree'
import { ShapePalette } from '../src/console/ShapePalette'
import { Console } from '../src/console/Console'
import { ColorPanel } from '../src/console/ColorPanel'
import type { Hsv } from '../src/color'
import { hexToHsv, hsvToHex, hueAt, lighten, parseHex, wheelHue } from '../src/color'
import { bodyPaint } from '../src/viewport/SceneObjects'
import { MarqueeRect } from '../src/viewport/SelectionMarquee'
import { MARQUEE_SLOP, useMarquee } from '../src/viewport/marquee'
import { SolidList, SolidPalette } from '../src/console/SolidPalette'
import { NGON_LABEL } from '../src/console/ngon'
import { SOLID_TEMPLATES } from '../src/console/solidIcons'
import {
  MAX_SIZE,
  maxShapeSize,
  resizeAlongAxis,
  scaleShape,
  scaleUniform,
} from '../src/geometry/dimensions'
import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { AXIS_COLORS, AXIS_CSS_VARS } from '../src/viewport/axisColors'
import { objectMatrix } from '../src/geometry/transform'
import {
  assemblyAnchor,
  assemblyCentre,
  assemblyExtent,
} from '../src/geometry/assembly'
import { turnedRotation } from '../src/viewport/gizmoDrag'
import type { TurnGrab } from '../src/viewport/gizmoDrag'
import { hostSurfaceFor, slideAnchor, surfaceFor } from '../src/geometry/surfaces'
import {
  DEFAULT_OBJECT_COLOR,
  cloneObject,
  defaultBaseFor,
  defaultShape,
  makeObject,
} from '../src/geometry/types'
import type { BaseSolid, SceneObject, Shape2D, SurfaceAnchor, Vec3 } from '../src/geometry/types'
import {
  releaseThumbnail,
  thumbnailCached,
  thumbnailFor,
} from '../src/console/thumbnailGeometry'
import { signedVolume } from '../src/geometry/volume'
import {
  DEFAULT_FEATURE_DEPTH,
  selectedObjectId as primarySelection,
  useDoc,
} from '../src/store/docStore'
import { useEvalStatus } from '../src/store/evalStore'
import { useLibrary } from '../src/store/libraryStore'
import { ObjectMenu, useObjectMenu } from '../src/viewport/ObjectMenu'
import {
  CUT_SIZE_MAX,
  RECENT_COLOR_SLOTS,
  cutPlaneNormal,
  useTools,
} from '../src/store/toolStore'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
}
function near(label: string, actual: number, expected: number, tol: number) {
  check(label, Math.abs(actual - expected) <= tol, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`)
}

/**
 * Render a panel, reporting a throw as a failed check rather than killing the
 * run: one panel crashing should still let the rest of the suite report.
 */
function markupOf(label: string, Panel: ComponentType): string {
  try {
    const html = renderToStaticMarkup(createElement(Panel))
    check(`${label} renders`, html.length > 0)
    return html
  } catch (err) {
    check(`${label} renders`, false, err instanceof Error ? err.message : String(err))
    return ''
  }
}

function shows(label: string, markup: string, needle: string) {
  const ok = markup.includes(needle)
  check(label, ok, ok ? '' : `missing ${JSON.stringify(needle)}`)
}
function hides(label: string, markup: string, needle: string) {
  const ok = !markup.includes(needle)
  check(label, ok, ok ? '' : `unexpectedly present: ${JSON.stringify(needle)}`)
}
/**
 * Whether a named reset control is standing down.
 *
 * Reads the rendered attribute order rather than guessing at it: React emits
 * `class`, then `title`, then `aria-label`, then the boolean -- and an earlier
 * version of this check looked for `class="reset-btn" disabled=""`, matched
 * nothing, and reported every button as live while the markup said otherwise.
 */
function resetIsDown(markup: string, name: string): boolean {
  return markup.includes(`aria-label="Reset ${name}" disabled=""`)
}

function occurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1
}

const doc = () => useDoc.getState()
const library = () => useLibrary.getState()
const tools = () => useTools.getState()
const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * The Inspector's own tilt bound, which is derived per feature rather than
 * fixed: the sweep survives only while the tilted end plane still leaves
 * positive travel at every ring point, which on a flat host works out at
 * tilt < atan(depth / shapeRadius).
 *
 * Nothing exports it, so it is mirrored here rather than imported -- the point
 * of the assertions below is to catch the panel's slider drifting away from the
 * angle the evaluator will actually accept, and importing the panel's own
 * arithmetic would make that impossible to see.
 */
const MAX_TILT_DEG = 60
function tiltBoundDeg(depth: number, radius: number): number {
  const limit = (Math.atan(depth / radius) * 180) / Math.PI
  return Math.max(5, Math.min(MAX_TILT_DEG, Math.floor(limit) - 1))
}

/**
 * Republish an evaluation readout the way the viewport does after a rebuild.
 * Only `failed` is populated: it is the sole field the console panels read, and
 * handing over the live geometries would invite a panel to hold on to buffers
 * the evaluator's cache owns.
 */
function publish(failed: string[]) {
  useEvalStatus.getState().publish({ objects: [], failed, millis: 0, triangles: 0 })
}

/** Primitives are centred on the origin, so this is the lift that rests one on the grid. */
function grounded(base: BaseSolid, x: number, z: number): [number, number, number] {
  return [x, -surfaceFor(base).bounds().min.y, z]
}

/** The palette gesture end to end: press, travel, release over the grid. */
function dragIn(base: BaseSolid, x: number, z: number): string {
  doc().startPlacingSolid(base)
  // The first move is still over the panel, where there is nowhere to land.
  doc().updatePlacingSolid(null)
  doc().updatePlacingSolid(grounded(base, x, z))
  doc().commitPlacingSolid()
  return primarySelection(useDoc.getState()) ?? ''
}

type Measured = { volume: number; min: number[]; max: number[]; failed: string[] }

/** Evaluate the live document and read one object's solid back out. */
function measure(id: string): Measured {
  const result = evaluateDoc(doc().doc)
  const entry = result.objects.find((o) => o.id === id)
  if (!entry) return { volume: 0, min: [], max: [], failed: result.failed }
  entry.geometry.computeBoundingBox()
  const box = entry.geometry.boundingBox
  return {
    volume: signedVolume(entry.geometry),
    min: box ? box.min.toArray() : [],
    max: box ? box.max.toArray() : [],
    failed: result.failed,
  }
}

/** Readers for the gizmo section: a `BaseSolid` is a union, and narrowing it
 *  inline at every call would bury the claim each assertion is making. */
function baseOf(objectId: string) {
  const object = doc().doc.objects.find((o) => o.id === objectId)
  if (!object) throw new Error(`no object ${objectId}`)
  return object.base
}
function sizeOf(objectId: string, axis: 0 | 1 | 2): number {
  const base = baseOf(objectId)
  return base.kind === 'box' ? base.size[axis] : NaN
}
function positionOf(objectId: string): Vec3 {
  const object = doc().doc.objects.find((o) => o.id === objectId)
  if (!object) throw new Error(`no object ${objectId}`)
  return object.transform.position
}
function shapeOf(objectId: string, featureId: string) {
  const feature = doc()
    .doc.objects.find((o) => o.id === objectId)
    ?.features.find((f) => f.id === featureId)
  if (!feature) throw new Error(`no feature ${featureId}`)
  return feature.shape
}
function rotationOf(objectId: string): Vec3 {
  const object = doc().doc.objects.find((o) => o.id === objectId)
  if (!object) throw new Error(`no object ${objectId}`)
  return object.transform.rotation
}
function depthOf(objectId: string): number {
  return doc().doc.objects.find((o) => o.id === objectId)?.features[0]?.depth ?? -1
}

// --- 1. Building a scene off the solid palette -----------------------------
console.log('\n1. Dragging solids in from the palette')

resetEvaluator()
doc().reset()
// The starter cube is not something the user placed; clearing it makes every
// assertion below about objects this run actually created.
for (const o of [...doc().doc.objects]) doc().removeObject(o.id)
check('the scene starts empty', doc().doc.objects.length === 0, `${doc().doc.objects.length} left`)

const cubeId = dragIn(defaultBaseFor('box'), 0, 0)
const pyramidId = dragIn(defaultBaseFor('pyramid', 3), 2.5, -1.25)
const prismId = dragIn(defaultBaseFor('prism', 8), -3, 0)
const sphereId = dragIn(defaultBaseFor('sphere'), 0, 3)

const historyAfterPlacing = doc().past.length
const docAfterPlacing = doc().doc

{
  const objects = doc().doc.objects
  check('four drags leave four objects', objects.length === 4, `${objects.length}`)
  check(
    'each is named for the solid it came from',
    objects.map((o) => o.name).join(' | ') ===
      'Cube | Triangular pyramid | Octagonal prism | Sphere',
    objects.map((o) => o.name).join(' | ')
  )
  check(
    'the side count chosen on the palette row survives the drop',
    objects[1].base.kind === 'pyramid' &&
      objects[1].base.sides === 3 &&
      objects[2].base.kind === 'prism' &&
      objects[2].base.sides === 8
  )
  check('the last one placed is the one selected', primarySelection(useDoc.getState()) === sphereId)

  // Every primitive is modelled centred on its own origin, so "rests on the
  // grid" is a claim about the drop position, not about the geometry.
  const result = evaluateDoc(doc().doc)
  check('the whole scene evaluates', result.failed.length === 0, result.failed.join(','))
  for (const o of doc().doc.objects) {
    const entry = result.objects.find((e) => e.id === o.id)
    if (!entry) {
      check(`${o.name} was evaluated`, false)
      continue
    }
    entry.geometry.computeBoundingBox()
    const minY = (entry.geometry.boundingBox?.min.y ?? NaN) + o.transform.position[1]
    near(`${o.name} rests on the grid`, minY, 0, 1e-6)
  }
}

{
  // Released with nowhere to land: no object, and nothing in history either,
  // or a cancelled drag would cost the user an undo step that does nothing.
  const before = doc().past.length
  doc().startPlacingSolid(defaultBaseFor('cone'))
  doc().updatePlacingSolid(null)
  doc().commitPlacingSolid()
  check('a drag released off the grid places nothing', doc().doc.objects.length === 4)
  check('and costs no undo step', doc().past.length === before, `${doc().past.length} vs ${before}`)
  check('and leaves no drag running', doc().drag.kind === 'idle', doc().drag.kind)
}

// --- 2. The panels with an object selected --------------------------------
console.log('\n2. Every console panel with an object selected')

doc().selectObject(pyramidId)
{
  const panel = markupOf('ObjectPanel', ObjectPanel)
  hides('it is past the "nothing selected" branch', panel, 'Nothing selected')
  shows('it names the selected solid', panel, 'Triangular pyramid')
  // The drop position, read back through the number boxes: 2.5 / 0.9 / -1.25.
  const placed = markupOf('PlacementPanel', PlacementPanel)
  shows('Position is shown', placed, '>Position<')
  shows('the X box carries the drop position', placed, 'min="-8" max="8" step="0.05" value="2.5"')
  shows('and the Z box the other axis', placed, 'min="-8" max="8" step="0.05" value="-1.25"')
  shows('Rotation is shown', placed, '>Rotation<')
  // Placement is ONE panel for both things that have one. With nothing armed it
  // is describing the object.
  shows('and it says what it is describing', placed, '>object<')
  shows('dimensions are shown', panel, '>Dimensions<')
  shows('a pyramid offers a side count', panel, '>Sides<')
  shows('and the current count is the active chip', panel, 'class="seg-btn seg-active">3<')
  shows('the object can be deleted from here', panel, 'Delete object')
}

{
  // Selecting an object is not selecting a sketch, so the Inspector must stay
  // on its empty branch rather than showing the last feature touched.
  const panel = markupOf('Inspector (no sketch)', Inspector)
  shows('it asks for a sketch', panel, 'Drag a shape onto an object')
  hides('and offers no End face controls', panel, 'End face')
}

{
  const tree = markupOf('SceneTree', SceneTree)
  hides('it is past the "empty scene" branch', tree, 'Empty scene')
  shows('it counts the objects', tree, '<span class="section-hint">4</span>')
  for (const name of ['Cube', 'Triangular pyramid', 'Octagonal prism', 'Sphere']) {
    shows(`it lists ${name}`, tree, `>${name}<`)
  }
  shows('the selected row is marked', tree, 'tree-object-head tree-selected')
  check(
    'and only that one row is',
    occurrences(tree, 'tree-object-head tree-selected') === 1,
    `${occurrences(tree, 'tree-object-head tree-selected')} selected rows`
  )
}

{
  // The tools live in the bar across the top, not in the console: they are how
  // you work rather than what you have built, and the two are kept apart.
  const bar = markupOf('NavBar', NavBar)
  shows('the bar carries the snap tool', bar, '>Snap<')
  shows('and the cut tool', bar, '>Cut<')
  shows('and the export buttons', bar, '>.glb<')
  shows('and the help button', bar, '>Help<')

  const snap = markupOf('SnapTool', SnapTool)
  shows('snapping is on by default', snap, 'aria-pressed="true"')
  // One click engages the tool; the parameter is the rare act and sits behind
  // the caret, so it must NOT be occupying the bar at rest.
  hides('its distance stays behind the caret', snap, '>Distance<')
  tools().setOpenPanel('snap')
  shows('which opens on demand', markupOf('SnapTool (open)', SnapTool), '>Distance<')
  tools().setOpenPanel(null)

  const cut = markupOf('CutTool', CutTool)
  shows('the cut tool rests disarmed', cut, 'aria-pressed="false"')
  // Snap and Cut carry no hover bubble. They are the two the user reaches for
  // constantly, and a tooltip that appears every time the pointer crosses them
  // is noise rather than help.
  hides('and no hover bubble', cut, 'nav-tip')
  hides('nor does snap', markupOf('SnapTool (no tip)', SnapTool), 'nav-tip')
  // The toolbar button is now nothing but a switch: no caret, no panel, and
  // therefore nothing of its own hanging over the viewport.
  hides('and carries no panel at all', cut, 'nav-caret')
  // Not `markupOf`, which counts an empty render as a failure: rendering
  // nothing at all is exactly the claim here, and it is a stronger one than
  // "the markup happens not to contain a button".
  check(
    'and the bar carries no cut actions until it is armed',
    renderToStaticMarkup(createElement(CutActions)) === '',
    'disarmed CutActions renders nothing'
  )
}

{
  // The palette rests closed, so the rows are checked on the list itself. The
  // header gets its own assertions below.
  const panel = markupOf('SolidList', SolidList)
  check(
    'it offers one row per template',
    occurrences(panel, 'solid-item-label') === SOLID_TEMPLATES.length,
    `${occurrences(panel, 'solid-item-label')} rows vs ${SOLID_TEMPLATES.length} templates`
  )
  shows('the most common solid is first', panel.slice(0, panel.indexOf('Sphere')), '>Cube<')
  shows('the bean is named for the user, not for the primitive', panel, '>Bean<')
  shows('the rarest solid is offered too', panel, '>Dodecahedron<')
  shows('a pyramid row carries side-count chips', panel, 'aria-label="Triangular pyramid"')
  shows('and a prism row carries its own', panel, 'aria-label="Octagonal prism"')

  const whole = markupOf('SolidPalette', SolidPalette)
  check(
    'the palette rests open, with every row in reach',
    occurrences(whole, 'solid-item-label') === SOLID_TEMPLATES.length,
    `${occurrences(whole, 'solid-item-label')} rows`
  )
  shows('and says so on its caret', whole, 'aria-expanded="true"')
  // Open, but four rows tall: the cap is what keeps ten rows from pushing the
  // scene tree and the selected object off the bottom of the console.
  shows('its header still says how many solids are in it', whole, `>${SOLID_TEMPLATES.length}<`)
}

{
  const panel = markupOf('ShapePalette', ShapePalette)
  shows('it offers a circle', panel, '>Circle<')
  shows('it offers a rectangle', panel, '>Rectangle<')
  // At rest the chip is cycling through every polygon it offers, so it is
  // named for the family. Naming it for one member made it read as a button
  // that places that one shape.
  shows('and the polygon chip is named for what it picks from', panel, `>${NGON_LABEL}<`)
  hides('rather than for whichever polygon it happens to be showing', panel, '>Hexagon<')
}

{
  const panel = markupOf('ExportTools', ExportTools)
  shows('GLB is offered', panel, '>.glb<')
  shows('OBJ is offered', panel, '>.obj<')
  // The caveat that used to be a permanent line under the buttons is now a
  // hover bubble, but it is still in the markup -- which is the point: hiding
  // it visually must not mean deleting it.
  shows('and it still says what an export leaves out', panel, 'Sketch overlays are not included')
}

// --- 3. A sketch, then an extrusion ---------------------------------------
console.log('\n3. A sketch on an object becomes an extrusion')

doc().startPlacing({ type: 'circle', r: 0.3 })
// Travelling over empty space first: the sketch has no host yet.
doc().updatePlacing(null, null)
doc().updatePlacing(cubeId, { on: 'box-face', face: 2, u: 0, v: 0 })
doc().commitPlacing()

const featureId = doc().selectedFeatureId ?? ''
const docAfterSketch = doc().doc
check('the sketch landed on the cube', primarySelection(useDoc.getState()) === cubeId)
check('and it is selected', featureId !== '', featureId)

{
  const panel = markupOf('Inspector (projection)', Inspector)
  shows('it names the face the sketch sits on', panel, 'Face +Y')
  shows('a circle offers a radius', panel, '>Radius<')
  shows('it says the sketch is inert', panel, 'Projection only')
  // Tilt and slide describe a pillar. With no pillar they would be controls
  // for nothing, so they must not be rendered at all.
  hides('no End face heading at depth 0', panel, 'End face')
  hides('no tilt control at depth 0', panel, '>Tilt<')
  hides('no slide control at depth 0', panel, '>Slide<')
  hides('and nothing to reset', panel, 'Reset face')

  const tree = markupOf('SceneTree (projection)', SceneTree)
  shows('the tree nests the sketch under its object', tree, 'Circle r0.30 - ')
  shows('and says it is still flat', tree, 'class="feature-action">projection<')
  shows('and counts it', tree, '>1f<')
}

doc().setDepth(cubeId, featureId, DEFAULT_FEATURE_DEPTH)
const docAfterExtrude = doc().doc
{
  const feature = doc().doc.objects.find((o) => o.id === cubeId)?.features[0]
  check('extruding gives the sketch a depth', (feature?.depth ?? 0) > 0, `${feature?.depth}`)

  const panel = markupOf('Inspector (extruded)', Inspector)
  hides('the inert notice is gone', panel, 'Projection only')
  shows('the End face group appears', panel, 'End face')
  shows('with an XYZ tilt', panel, '>Tilt<')
  shows('and an in-plane slide', panel, '>Slide<')
  shows('the slide axes are labelled U and V', panel, '>U<')
  shows('with a way back to square', panel, 'Reset face')
  shows('and the hint that the face is draggable too', panel, 'drag the end face itself')

  const tree = markupOf('SceneTree (extruded)', SceneTree)
  shows('the tree says extrude now', tree, 'feature-action feature-out">extrude 0.30<')
}

// --- 4. The End face panel reaches the geometry ---------------------------
console.log('\n4. Tilt and slide reach the solid')

const baseline = measure(cubeId)
{
  check('the extruded cube builds', baseline.failed.length === 0, baseline.failed.join(','))
  // Cube plus a 0.3-deep boss on the +Y face, which stands 0.3 proud of it.
  near('the boss stands proud of the face', baseline.max[1], 1.3, 1e-6)
  near('and the cube is otherwise untouched', baseline.max[0], 1, 1e-6)
}

// The boss is 0.3 deep on a 0.3 sketch radius, so the panel's slider should
// stop just short of atan(1) = 45 degrees.
const TILT_BOUND = tiltBoundDeg(0.3, 0.3)
const TILT_DEG = 20
doc().patchFeature(cubeId, featureId, { tilt: [rad(TILT_DEG), 0, 0] })
const tilted = measure(cubeId)
{
  check('a tilted feature still builds', tilted.failed.length === 0, tilted.failed.join(','))
  check('tilting moved the solid', tilted.max[1] > baseline.max[1], `${tilted.max[1].toFixed(4)}`)
  // The end plane pivots about the face centre, so the high side rises by
  // exactly r*tan(tilt) -- which is the panel's degrees arriving as geometry.
  near(
    'the high side rises by r*tan(tilt)',
    tilted.max[1] - baseline.max[1],
    0.3 * Math.tan(rad(TILT_DEG)),
    5e-3
  )
  // Pivoting about the centre takes as much off one side as it adds to the
  // other, so an unchanged volume here is the proof the pivot is centred --
  // and that the tilted tool is still closed.
  near('and the pivot is centred, so volume is unchanged', tilted.volume, baseline.volume, 1e-6)

  const panel = markupOf('Inspector (tilted)', Inspector)
  shows(
    'the panel reads back the tilt it applied',
    panel,
    `min="-${TILT_BOUND}" max="${TILT_BOUND}" step="1" value="${TILT_DEG}"`
  )
  check(
    'and its slider stops short of the old fixed 60 degrees',
    TILT_BOUND < MAX_TILT_DEG,
    `${TILT_BOUND}`
  )
}

const SLIDE_U = 0.8
doc().patchFeature(cubeId, featureId, { tilt: [0, 0, 0], faceOffset: [SLIDE_U, 0] })
const slid = measure(cubeId)
{
  check('a slid feature still builds', slid.failed.length === 0, slid.failed.join(','))
  // The base of the boss stays on the face and the top slides to u = 0.8, so
  // the pillar leans out past the side of the cube by the sketch radius.
  near('the leaning pillar overhangs the cube', slid.max[0], SLIDE_U + 0.3, 1e-3)
  near('but only along U', slid.max[2], 1, 1e-6)
  // A shear moves no material, which is what "the base stays put" means.
  near('sliding shears the pillar rather than growing it', slid.volume, baseline.volume, 1e-6)

  const panel = markupOf('Inspector (slid)', Inspector)
  shows('the panel reads back the slide it applied', panel, 'min="-1.5" max="1.5" step="0.01" value="0.8"')
}

{
  // A slider whose far end drops the feature is dead travel, so the derived
  // bound has to be an angle that BUILDS -- and a tight one, or it is giving
  // away reach. The real evaluator decides both, one degree apart.
  doc().patchFeature(cubeId, featureId, { tilt: [rad(TILT_BOUND), 0, 0] })
  const atBound = measure(cubeId)
  check(
    'the far end of the tilt slider still builds',
    atBound.failed.length === 0,
    `${TILT_BOUND} deg: ${atBound.failed.join(',')}`
  )
  doc().patchFeature(cubeId, featureId, { tilt: [rad(TILT_BOUND + 1), 0, 0] })
  check(
    'and one degree past it does not, so the bound is not over-cautious',
    measure(cubeId).failed.includes(featureId),
    `${TILT_BOUND + 1} deg built`
  )

  // The bound reads one axis at a time. Tilting all three composes into a
  // larger off-normal angle that it cannot see, so the sweep still refuses --
  // which is not a crash: the feature drops out and the solid survives without
  // it. Both panels have to SAY so, and the only honest way to test it is to
  // let the real evaluator decide, so the readout published here is the one the
  // viewport would publish.
  doc().patchFeature(cubeId, featureId, {
    tilt: [rad(TILT_BOUND), rad(TILT_BOUND), rad(TILT_BOUND)],
  })
  const extreme = measure(cubeId)
  check(
    'three axes at the bound compose past it, and are reported not thrown',
    extreme.failed.includes(featureId),
    extreme.failed.join(',') || 'nothing failed'
  )
  near('and the object still builds, minus the feature', extreme.volume, 8, 1e-6)

  publish(extreme.failed)
  const panel = markupOf('Inspector (skipped)', Inspector)
  shows('the Inspector explains why the feature vanished', panel, '>skipped<')
  shows('and says what to do about it', panel, 'Ease the tilt back')
  const tree = markupOf('SceneTree (skipped)', SceneTree)
  shows('the tree flags the failed row', tree, '>failed<')

  // Back to a tilt that builds, and the flags must clear with it.
  doc().patchFeature(cubeId, featureId, { tilt: [0, 0, 0] })
  const recovered = measure(cubeId)
  check('easing the tilt back rebuilds it', recovered.failed.length === 0, recovered.failed.join(','))
  publish(recovered.failed)
  hides('and the tree stops flagging it', markupOf('SceneTree (clean)', SceneTree), '>failed<')
  hides('as does the Inspector', markupOf('Inspector (clean)', Inspector), '>skipped<')
}

const docAfterSlide = doc().doc

// --- 5. Cutting an object in two ------------------------------------------
console.log('\n5. The cut tool splits an object in two')

{
  // Severing the CUBE first, because it is the object carrying a feature and
  // the prism below carries none. Both halves inherit the whole feature list,
  // so the ids have to be re-issued on one of them: `EvalResult.failed` is a
  // flat list of feature ids with no object beside them, and a duplicate would
  // make a feature that failed on one half light up red on the other too.
  const beforeCut = doc().doc
  const beforeSelection = doc().selectedFeatureId
  const split = doc().applyCut([0, 1, 0], [1, 0, 0], [cubeId])
  check('the plane severs the cube', split === 1, `${split}`)

  const halves = doc().doc.objects.filter((o) => o.name.startsWith('Cube ('))
  check('it left two halves', halves.length === 2, halves.map((o) => o.name).join(' | '))
  if (halves.length === 2) {
    const [a, b] = halves
    check(
      'each half kept the feature',
      a.features.length === 1 && b.features.length === 1,
      `${a.features.length} and ${b.features.length}`
    )
    const ids = [...a.features, ...b.features].map((f) => f.id)
    check('and the two halves carry distinct feature ids', new Set(ids).size === ids.length, ids.join(' | '))
    // Half A is the selection heir, so its ids are the ones that must survive
    // untouched -- a sketch selected before the cut stays selected after it.
    check('half A kept the original ids, so the selection still names one', a.features[0].id === beforeSelection, `${a.features[0].id} vs ${beforeSelection}`)
    check('and half B was the one re-issued', b.features[0].id !== beforeSelection, b.features[0].id)
  }

  doc().undo()
  check('undo puts the cube back together', doc().doc === beforeCut)
}

doc().selectObject(prismId)
tools().setCutActive(true)
// The prism is 1.8 tall and rests on the grid, so this plane is halfway up it.
tools().setCutPlane({ position: [-3, 0.9, 0], rotation: [0, 0, 0] })
{
  // Arming puts the two ACTIONS in the bar, a short travel from the gizmo that
  // just aimed the plane. The plane's numbers stay in the console.
  const panel = markupOf('CutActions (armed)', CutActions)
  hides('the actions carry no placement of their own', panel, '>Position<')
  // The guide square is sized by the gizmo's ring alone now; it was the last
  // reason the tool had a settings panel.
  hides('and no guide size slider', panel, '>Guide size<')

  // Placement follows the armed plane rather than the selection, the same way
  // the gizmo does -- the panel driving the arrows has to describe what they
  // are moving.
  const placed = markupOf('PlacementPanel (cut armed)', PlacementPanel)
  shows('the placement panel switches to the plane', placed, '>cut plane<')
  shows('offering its position', placed, '>Position<')
  shows('and its tilt, named as a tilt', placed, '>Tilt<')
  hides('rather than as a rotation', placed, '>Rotation<')
  // The plane's own range, not the object's: one panel, two sets of bounds.
  shows('with the plane range, not the object one', placed, 'min="-6" max="6" step="0.05" value="-3"')
  shows('it says what it will cut', panel, 'Cuts the selected object')
  shows('and offers the button', panel, '>Apply cut</button>')
  shows('and the one that re-aims the plane', panel, '>Reset plane</button>')

  // Deselect and the button says out loud that it is about to cut everything.
  // On a 46px bar the target sentence lives in a title; the COUNT does not,
  // because "this will cut all of them" is the half that must not be missed.
  doc().selectObject(null)
  const wide = markupOf('CutActions (nothing selected)', CutActions)
  shows('with nothing selected it warns it will cut the lot', wide, 'Apply cut · all ')
  shows('and says how many that is', wide, 'Cuts every object in the scene')
  doc().selectObject(prismId)
}

{
  const plane = tools().cutPlane
  const n = cutPlaneNormal(plane.rotation)
  const split = doc().applyCut(plane.position, [n.x, n.y, n.z], [prismId])
  check('the plane severs the prism', split === 1, `${split}`)
  check('the scene gains an object', doc().doc.objects.length === 5, `${doc().doc.objects.length}`)

  const tree = markupOf('SceneTree (cut)', SceneTree)
  shows('the first half is listed', tree, '>Octagonal prism (A)<')
  shows('and the second', tree, '>Octagonal prism (B)<')
  check(
    'both halves are marked as cut',
    occurrences(tree, 'class="section-hint tree-cut"') === 2,
    `${occurrences(tree, 'class="section-hint tree-cut"')} cut chips`
  )
  // A severed selection lives on as its first half, so the object panel keeps
  // showing something the user recognises rather than emptying out.
  const panel = markupOf('ObjectPanel (cut half)', ObjectPanel)
  shows('the object panel follows the surviving half', panel, 'Octagonal prism')
  hides('rather than falling back to nothing', panel, 'Nothing selected')
}

{
  // A plane nowhere near the solid is not a cut, and must leave the scene alone.
  const before = doc().doc
  const split = doc().applyCut([0, 40, 0], [0, 1, 0], [pyramidId])
  check('a plane that misses splits nothing', split === 0, `${split}`)
  check('and does not touch the document', doc().doc === before)
}

const docAfterCut = doc().doc
const historyAfterCut = doc().past.length

// --- 6. Undo, redo, and what stays out of history -------------------------
console.log('\n6. Undo, redo, and what stays out of history')

{
  // Tool state is how you are working, not what you have built. Toggling snap
  // or nudging the cut plane must leave the undo stack exactly where it was.
  const before = doc().past.length
  tools().setSnap(false)
  tools().setSnapDistance(0.25)
  tools().setCutPlane({ position: [-3, 1.2, 0] })
  check('snap really toggled', tools().snap === false)
  check('toggling snap adds no undo entry', doc().past.length === before, `${doc().past.length} vs ${before}`)
  check('and does not touch the document', doc().doc === docAfterCut)

  tools().setOpenPanel('snap')
  const panel = markupOf('SnapTool (snap off)', SnapTool)
  shows('the button shows snap off', panel, 'aria-pressed="false"')
  shows('and greys out its distance field', panel, 'class="tool-group" disabled=""')
  tools().setOpenPanel(null)
  tools().setSnap(true)
}

{
  doc().undo()
  check('undo puts the cut back together', doc().doc === docAfterSlide)
  const tree = markupOf('SceneTree (uncut)', SceneTree)
  hides('and the halves are gone from the tree', tree, 'Octagonal prism (A)')
  shows('leaving the whole prism', tree, '>Octagonal prism<')

  doc().redo()
  check('redo splits it again', doc().doc === docAfterCut)
  check('redo leaves nothing further forward', doc().future.length === 0, `${doc().future.length}`)
  doc().undo()
}

{
  // All the way back to the bare scene, one step at a time.
  let guard = 0
  while (doc().past.length > historyAfterPlacing && guard++ < 100) doc().undo()
  check('undo rewinds to the freshly placed scene', doc().doc === docAfterPlacing)
  check('the sketch is gone with it', doc().doc.objects.every((o) => o.features.length === 0))
  check('and the selected feature was pruned', doc().selectedFeatureId === null, `${doc().selectedFeatureId}`)

  const panel = markupOf('Inspector (rewound)', Inspector)
  shows('so the Inspector falls back to its empty branch', panel, 'Drag a shape onto an object')

  // Every intermediate state is still reachable going forward.
  doc().redo()
  check('the first redo brings the sketch back', doc().doc === docAfterSketch)
  doc().redo()
  check('the next one restores the extrusion', doc().doc === docAfterExtrude)

  guard = 0
  while (doc().future.length > 0 && guard++ < 100) doc().redo()
  check('redoing to the end returns the cut scene', doc().doc === docAfterCut)
  check('and history is the same depth it was', doc().past.length === historyAfterCut, `${doc().past.length} vs ${historyAfterCut}`)

  const tree = markupOf('SceneTree (redone)', SceneTree)
  shows('with both halves listed again', tree, '>Octagonal prism (B)<')
}

{
  // Slider coalescing folds a run of same-key edits into one undo step, which
  // is only sound while the run is UNBROKEN. An undo in the middle of it leaves
  // the previous history entry describing a state that is no longer the one
  // before the next edit -- fold into that and a single undo silently reverts
  // two separate operations, and the state it lands on never existed.
  //
  // No panel is rendered between these calls on purpose: the window is 600ms of
  // wall clock, and a render inside it would be testing the machine's speed.
  const before = doc().past.length
  const beforeDoc = doc().doc
  const depthOf = () =>
    doc().doc.objects.find((o) => o.id === cubeId)?.features[0]?.depth ?? -1
  const startDepth = depthOf()

  doc().patchFeature(cubeId, featureId, { depth: 0.42 })
  doc().patchFeature(cubeId, featureId, { depth: 0.44 })
  check('two quick slider edits fold into one undo step', doc().past.length === before + 1, `${doc().past.length} vs ${before + 1}`)

  doc().undo()
  near('undo returns the depth the slider started from', depthOf(), startDepth, 1e-9)

  doc().patchFeature(cubeId, featureId, { depth: 0.46 })
  check(
    'an edit right after an undo does not fold into the pre-undo entry',
    doc().past.length === before + 1,
    `${doc().past.length} vs ${before + 1}`
  )
  doc().undo()
  check('so one undo restores exactly the state that preceded it', doc().doc === beforeDoc)
  near('and the depth with it', depthOf(), startDepth, 1e-9)

  // Which also leaves history exactly as deep as section 6 found it, so the
  // sweep below starts from the scene the earlier checks described.
  check('leaving history the depth it was', doc().past.length === before, `${doc().past.length} vs ${before}`)
}

// --- 7. The gizmo, through the store it drives -----------------------------
console.log('\n7. The gizmo edits the document the same way the panel does')

/**
 * Its own scene rather than the one section 6 leaves behind: these assertions
 * are about exact dimensions and exact history depths, and inheriting a
 * document that earlier sections have cut, undone and replayed would make them
 * read as claims about that history instead of about the gizmo.
 */
resetEvaluator()
doc().reset()

const gizmoCube = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1, 0])

{
  const entries = doc().past.length

  doc().selectObject(gizmoCube)
  doc().startGizmo(gizmoCube, { mode: 'size', axis: 0 })
  check('grabbing an arrow starts a gizmo drag', doc().drag.kind === 'gizmo', doc().drag.kind)
  check('and pressing alone touches no history', doc().past.length === entries, `${doc().past.length}`)

  // Every frame recomputes from the GRAB, so the store is handed a fresh
  // ABSOLUTE base each time rather than an increment. Three frames of one
  // gesture must still cost exactly one undo step.
  const grabbed = baseOf(gizmoCube)
  for (const travel of [0.1, 0.25, 0.4]) {
    doc().resizeObjectTo(resizeAlongAxis(grabbed, 0, travel))
  }
  // travel 0.4 on a box side: the surface moves 0.4, the side grows by 0.8.
  near('the drag resized the solid', sizeOf(gizmoCube, 0), 2.8, 1e-9)
  check('and the other sides are untouched', sizeOf(gizmoCube, 1) === 2 && sizeOf(gizmoCube, 2) === 2, `${sizeOf(gizmoCube, 1)}, ${sizeOf(gizmoCube, 2)}`)
  check(
    'three frames cost one undo entry, not three',
    doc().past.length === entries + 1,
    `${doc().past.length - entries}`
  )

  doc().endDrag()
  doc().undo()
  near('so one undo puts the whole gesture back', sizeOf(gizmoCube, 0), 2, 1e-9)
}

{
  // The left-drag half of an arrow, which is a genuinely different code path
  // from the right-drag half: sizing goes through `resizeObjectTo`, moving goes
  // through `moveObjectTo` -- the same action the body drag uses. That action
  // guarded on the body-drag kind alone, so every arrow silently did nothing
  // while the ring and the right-drag worked, which is exactly the shape of bug
  // a suite that only exercised sizing could not see.
  const entries = doc().past.length
  const start = positionOf(gizmoCube)

  doc().startGizmo(gizmoCube, { mode: 'move', axis: 0 })
  doc().moveObjectTo([start[0] + 0.75, start[1], start[2]])
  near('dragging an arrow moves the object', positionOf(gizmoCube)[0], start[0] + 0.75, 1e-9)
  check(
    'along that axis and no other',
    positionOf(gizmoCube)[1] === start[1] && positionOf(gizmoCube)[2] === start[2],
    `${positionOf(gizmoCube)[1]}, ${positionOf(gizmoCube)[2]}`
  )
  check('costing one undo entry', doc().past.length === entries + 1, `${doc().past.length - entries}`)

  // A frame that resolves back to where the object already sits is not an edit.
  const held = doc().doc
  doc().moveObjectTo([start[0] + 0.75, start[1], start[2]])
  check('a frame that moves nothing writes nothing', doc().doc === held)

  doc().endDrag()
  doc().undo()
  near('and undo returns it', positionOf(gizmoCube)[0], start[0], 1e-9)

  // Outside a gizmo or body drag the action must still refuse: it is the live
  // half of a gesture, and the panel's typed values go through setObjectTransform.
  const idle = doc().doc
  doc().moveObjectTo([99, 99, 99])
  check('but it does nothing with no drag running', doc().doc === idle)
}

{
  // A resize pinned at the limit keeps arriving with the same numbers for as
  // long as the pointer keeps going. Those frames are not edits, and each one
  // that slipped through would be an undo step that reverts nothing.
  const grabbed = baseOf(gizmoCube)
  doc().startGizmo(gizmoCube, { mode: 'size', axis: 0 })
  doc().resizeObjectTo(resizeAlongAxis(grabbed, 0, 40))
  near('a runaway drag stops at the ceiling', sizeOf(gizmoCube, 0), MAX_SIZE, 1e-9)

  const pinned = doc().doc
  const entries = doc().past.length
  doc().resizeObjectTo(resizeAlongAxis(grabbed, 0, 60))
  doc().resizeObjectTo(resizeAlongAxis(grabbed, 0, 80))
  check('and then stops writing entirely', doc().doc === pinned)
  check('adding no further history', doc().past.length === entries, `${doc().past.length}`)

  doc().endDrag()
  doc().undo()

  // The ceiling the gizmo clamps to is the one the panel draws, because both
  // read it from geometry/dimensions rather than each keeping its own copy.
  doc().selectObject(gizmoCube)
  shows('the panel offers that same ceiling', markupOf('ObjectPanel (bounds)', ObjectPanel), `max="${MAX_SIZE}"`)
}

{
  // Resizing runs the same conform pass `patchObject` does, so a sketch on a
  // face that just shrank is pulled back onto it and a pocket deeper than the
  // solid now is stands down -- rather than the drag quietly leaving the
  // feature list describing geometry that is no longer there.
  doc().startPlacing({ type: 'circle', r: 0.3 })
  doc().updatePlacing(gizmoCube, { on: 'box-face', face: 2, u: 0, v: 0 })
  doc().commitPlacing()
  const feature = doc().doc.objects[0].features[0]
  // Negative, because depth is signed: a pocket is the same number as a boss
  // pointing the other way.
  doc().patchFeature(gizmoCube, feature.id, { depth: -0.9 })
  const deep = depthOf(gizmoCube)
  near('the pocket starts at the depth it was given', deep, -0.9, 1e-9)

  const grabbed = baseOf(gizmoCube)
  doc().startGizmo(gizmoCube, { mode: 'size', axis: 'all' })
  doc().resizeObjectTo(scaleUniform(grabbed, 0.25))
  check('scaling keeps the sketch', doc().doc.objects[0].features.length === 1, `${doc().doc.objects[0].features.length}`)
  // Compared as a REACH, not as a value: standing a pocket down makes the
  // signed number larger, since it is climbing back toward zero.
  check(
    'and stands its depth down to fit the smaller solid',
    Math.abs(depthOf(gizmoCube)) < Math.abs(deep),
    `${depthOf(gizmoCube).toFixed(4)} from ${deep.toFixed(4)}`
  )
  check(
    'without turning the pocket into a boss',
    depthOf(gizmoCube) < 0,
    `${depthOf(gizmoCube).toFixed(4)}`
  )
  doc().endDrag()
  doc().undo()
  near('undo restores the depth along with the size', depthOf(gizmoCube), deep, 1e-9)
}

{
  // The gizmo's arrow colours live in TypeScript, because a three material
  // cannot read a CSS custom property -- and the same three values tint the
  // X/Y/Z letters of the console's Vec3 rows, which can only come from the
  // stylesheet. That duplication is unavoidable; leaving it unguarded is not.
  // A user connects an arrow to the row that types its number by colour alone,
  // so the day these drift apart the gizmo stops being self-explanatory and
  // nothing else fails.
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  AXIS_CSS_VARS.forEach((name, axis) => {
    // Split rather than match: the declaration is `--axis-x: #ff1744;` and
    // the only other mention is `var(--axis-x)`, which carries no colon.
    const declared = css.split(`${name}:`)[1]?.split(';')[0]?.trim()
    check(
      `${name} matches the gizmo's own ${'XYZ'[axis]} colour`,
      declared?.toLowerCase() === AXIS_COLORS[axis].toLowerCase(),
      `${declared} vs ${AXIS_COLORS[axis]}`
    )
  })
}

{
  // The sketch gizmo's arrows go through `moveTo` -- the same action the free
  // sketch drag uses -- and that action guarded on the free-drag kind alone.
  // The object gizmo shipped with exactly this bug: every arrow silently did
  // nothing while the other handles worked. Pinned here so it cannot recur on
  // the sketch half too.
  doc().startPlacing({ type: 'circle', r: 0.3 })
  doc().updatePlacing(gizmoCube, { on: 'box-face', face: 2, u: 0, v: 0 })
  doc().commitPlacing()
  const sketch = doc().doc.objects[0].features.at(-1)
  check('a sketch is on the cube to drag', sketch !== undefined, `${doc().doc.objects[0].features.length}`)

  if (sketch) {
    const entries = doc().past.length
    doc().startSketchGizmo(gizmoCube, sketch.id, { mode: 'move', axis: 0 })
    check('grabbing a tangent arrow starts its own drag kind', doc().drag.kind === 'sketch-gizmo', doc().drag.kind)
    check('and pressing alone touches no history', doc().past.length === entries, `${doc().past.length}`)

    const host = hostSurfaceFor(baseOf(gizmoCube), sketch.anchor)
    const slid = slideAnchor(host, sketch.anchor, 0.3, 0)
    check('the surface offers a slid anchor', slid !== null, `${slid}`)
    if (slid) doc().moveTo(slid)

    const moved = doc().doc.objects[0].features.at(-1)?.anchor
    check(
      'dragging the arrow moves the sketch',
      moved?.on === 'box-face' && Math.abs(moved.u - 0.3) < 1e-9,
      moved?.on === 'box-face' ? `u ${moved.u}` : `${moved?.on}`
    )
    check(
      'along one tangent only',
      moved?.on === 'box-face' && moved.v === 0,
      moved?.on === 'box-face' ? `v ${moved.v}` : `${moved?.on}`
    )
    check('costing one undo entry', doc().past.length === entries + 1, `${doc().past.length - entries}`)

    // A frame that resolves to the anchor it already has is not an edit.
    const held = doc().doc
    if (slid) doc().moveTo(slid)
    check('and a frame that moves nothing writes nothing', doc().doc === held)

    doc().endDrag()
    doc().undo()
    const back = doc().doc.objects[0].features.at(-1)?.anchor
    check(
      'undo returns the sketch',
      back?.on === 'box-face' && back.u === 0,
      back?.on === 'box-face' ? `u ${back.u}` : `${back?.on}`
    )

    // Outside a drag the action must still refuse: it is the live half of a
    // gesture, and the panel's typed values go through patchFeature.
    const idle = doc().doc
    if (slid) doc().moveTo(slid)
    check('but it does nothing with no drag running', doc().doc === idle)

    // The ring is the third handle on a sketch, and it goes through a THIRD
    // action -- `resizeShapeTo`, not `moveTo` -- so it needs its own guard
    // check. Two handles on this gizmo have now shipped dead behind a guard
    // that named only one drag kind.
    const entries2 = doc().past.length
    doc().startSketchGizmo(gizmoCube, sketch.id, { mode: 'size', axis: 'all' })
    check('grabbing the ring starts the same drag kind', doc().drag.kind === 'sketch-gizmo', doc().drag.kind)

    const grown = scaleShape(shapeOf(gizmoCube, sketch.id), 1.5, maxShapeSize(baseOf(gizmoCube)))
    doc().resizeShapeTo(grown)
    const after = shapeOf(gizmoCube, sketch.id)
    check(
      'dragging the ring resizes the sketch',
      after.type === 'circle' && Math.abs(after.r - 0.45) < 1e-9,
      after.type === 'circle' ? `r ${after.r}` : after.type
    )
    check('costing one undo entry', doc().past.length === entries2 + 1, `${doc().past.length - entries2}`)

    const held2 = doc().doc
    doc().resizeShapeTo(grown)
    check('and a frame that resizes nothing writes nothing', doc().doc === held2)

    doc().endDrag()
    doc().undo()
    const restored = shapeOf(gizmoCube, sketch.id)
    check(
      'undo returns the original size',
      restored.type === 'circle' && Math.abs(restored.r - 0.3) < 1e-9,
      restored.type === 'circle' ? `r ${restored.r}` : restored.type
    )

    const idle2 = doc().doc
    doc().resizeShapeTo(grown)
    check('and it does nothing with no drag running', doc().doc === idle2)

    doc().removeFeature(gizmoCube, sketch.id)
    doc().undo()
  }
}

{
  // The ring's right-drag, on all three things that carry one. Each writes
  // somewhere different -- the object's transform, the plane's tilt, the
  // sketch's own spin -- and each goes through a guard that has to name the
  // right drag kind. Three handles on this gizmo have now shipped dead behind
  // one that named only some of them.
  const entries = doc().past.length
  doc().selectObject(gizmoCube)
  doc().startGizmo(gizmoCube, { mode: 'rotate', axis: 'all' })
  check('the ring turn starts a gizmo drag', doc().drag.kind === 'gizmo', doc().drag.kind)

  const grab: TurnGrab = {
    axis: new Vector3(0, 1, 0),
    rotation: rotationOf(gizmoCube),
    position: positionOf(gizmoCube),
    lastAngle: 0,
    total: 0,
  }
  doc().setObjectTransform(gizmoCube, {
    position: positionOf(gizmoCube),
    rotation: turnedRotation(grab, Math.PI / 2),
  })
  near('turning the ring rotates the object', rotationOf(gizmoCube)[1], Math.PI / 2, 1e-9)
  check('costing one undo entry', doc().past.length === entries + 1, `${doc().past.length - entries}`)

  // Frames keep arriving while the pointer is held still; none of them is an
  // edit, and each one that slipped through would be an undo step reverting
  // nothing.
  const held = doc().doc
  doc().setObjectTransform(gizmoCube, {
    position: positionOf(gizmoCube),
    rotation: turnedRotation(grab, Math.PI / 2),
  })
  check('and a frame that turns nothing writes nothing', doc().doc === held)

  doc().endDrag()
  doc().undo()
  near('undo returns the object upright', rotationOf(gizmoCube)[1], 0, 1e-9)
}

{
  // The sketch's spin is a single number -- its own tangent frame has one axis
  // -- and the ring drives the same value the Inspector's Rotation row does.
  doc().startPlacing({ type: 'rect', w: 0.5, h: 0.3 })
  doc().updatePlacing(gizmoCube, { on: 'box-face', face: 2, u: 0, v: 0 })
  doc().commitPlacing()
  const spun = doc().doc.objects[0].features.at(-1)
  check('a sketch is on the cube to turn', spun !== undefined, `${doc().doc.objects[0].features.length}`)

  if (spun) {
    const entries = doc().past.length
    doc().startSketchGizmo(gizmoCube, spun.id, { mode: 'rotate', axis: 'all' })
    doc().rotateShapeTo(Math.PI / 4)
    const feature = doc().doc.objects[0].features.at(-1)
    near('turning the ring spins the outline', feature?.rotation ?? -1, Math.PI / 4, 1e-9)
    check('costing one undo entry', doc().past.length === entries + 1, `${doc().past.length - entries}`)

    const held = doc().doc
    doc().rotateShapeTo(Math.PI / 4)
    check('and a frame that spins nothing writes nothing', doc().doc === held)

    doc().endDrag()
    doc().undo()
    near('undo returns the outline', doc().doc.objects[0].features.at(-1)?.rotation ?? -1, 0, 1e-9)

    const idle = doc().doc
    doc().rotateShapeTo(Math.PI / 3)
    check('and it does nothing with no drag running', doc().doc === idle)

    doc().removeFeature(gizmoCube, spun.id)
    doc().undo()
  }
}

{
  // The cut plane's turn IS its tilt, and like every other cut-plane edit it
  // must stay out of the document's history.
  const entries = doc().past.length
  const document = doc().doc
  tools().setCutActive(true)
  doc().startCutGizmo({ mode: 'rotate', axis: 'all' })

  const grab: TurnGrab = {
    axis: new Vector3(1, 0, 0),
    rotation: tools().cutPlane.rotation,
    position: tools().cutPlane.position,
    lastAngle: 0,
    total: 0,
  }
  tools().setCutPlane({ rotation: turnedRotation(grab, Math.PI / 6) })
  near('turning the ring tilts the plane', tools().cutPlane.rotation[0], Math.PI / 6, 1e-9)
  check('adding no undo entry', doc().past.length === entries, `${doc().past.length}`)
  check('and not touching the document', doc().doc === document)

  doc().endDrag()
  tools().setCutActive(false)
  near('leaving the tool rearms the tilt', tools().cutPlane.rotation[0], 0, 1e-9)
}

{
  // The reset controls. Four per rotation field -- one an axis, one the lot --
  // and each has to be LIVE only when there is something to undo: a button that
  // is always clickable costs an undo entry and changes nothing, which is worse
  // than no button at all.
  doc().selectObject(gizmoCube)
  doc().setObjectTransform(gizmoCube, { position: positionOf(gizmoCube), rotation: [0, 0, 0] })

  const upright = markupOf('PlacementPanel (upright)', PlacementPanel)
  shows('the rotation field offers a reset per axis', upright, 'aria-label="Reset X"')
  shows('and one for the whole rotation', upright, 'aria-label="Reset rotation"')
  check(
    'with one per axis plus the group',
    occurrences(upright, 'class="reset-btn"') === 4,
    `${occurrences(upright, 'class="reset-btn"')} buttons`
  )
  check(
    'all standing down while the object is upright',
    ['X', 'Y', 'Z', 'rotation'].every((name) => resetIsDown(upright, name)),
    ['X', 'Y', 'Z', 'rotation'].filter((n) => !resetIsDown(upright, n)).join(',') || 'all down'
  )

  // Turn one axis: that axis's button and the group's wake up, the other two
  // stay down.
  doc().setObjectTransform(gizmoCube, {
    position: positionOf(gizmoCube),
    rotation: [0, Math.PI / 4, 0],
  })
  const turned = markupOf('PlacementPanel (turned)', PlacementPanel)
  check('the turned axis wakes its own reset', !resetIsDown(turned, 'Y'))
  check('and the group reset with it', !resetIsDown(turned, 'rotation'))
  check(
    'while the two untouched axes stay down',
    resetIsDown(turned, 'X') && resetIsDown(turned, 'Z'),
    `X ${resetIsDown(turned, 'X')}, Z ${resetIsDown(turned, 'Z')}`
  )

  // Position has no reset: it is not a rotation, and the row keeps the layout
  // every other Vec3 field uses.
  const positionRows = occurrences(turned, 'class="vec3-row"')
  check('position rows keep the plain layout', positionRows >= 3, `${positionRows} plain rows`)

  doc().setObjectTransform(gizmoCube, { position: positionOf(gizmoCube), rotation: [0, 0, 0] })
}

{
  // The cut plane's tilt is the same value under another name, and the sketch's
  // spin is the single-number version. Both carry the control.
  tools().setCutActive(true)
  tools().setCutPlane({ rotation: [Math.PI / 6, 0, 0] })
  const cut = markupOf('PlacementPanel (tilted plane)', PlacementPanel)
  shows('the cut tilt offers a reset too', cut, 'aria-label="Reset tilt"')
  check(
    'live on the tilted axis, down on the other two',
    !resetIsDown(cut, 'X') && resetIsDown(cut, 'Y') && resetIsDown(cut, 'Z'),
    `X ${resetIsDown(cut, 'X')}, Y ${resetIsDown(cut, 'Y')}, Z ${resetIsDown(cut, 'Z')}`
  )
  tools().setCutActive(false)
}

{
  // The cut plane's gizmo writes TOOL state. Aiming a blade is not an edit to
  // the document, and a plane nudge that landed in undo history would make a
  // user walk back through their own aiming to reach the edit they wanted.
  const entries = doc().past.length
  const document = doc().doc

  tools().setCutActive(true)
  doc().startCutGizmo({ mode: 'move', axis: 1 })
  check('the cut gizmo starts its own drag kind', doc().drag.kind === 'cut-gizmo', doc().drag.kind)
  check(
    'which carries no snapshot flag at all',
    !('snapshot' in doc().drag),
    Object.keys(doc().drag).join(',')
  )

  tools().setCutPlane({ position: [0, 1.25, 0] })
  check('moving the plane adds no undo entry', doc().past.length === entries, `${doc().past.length}`)
  check('and does not touch the document', doc().doc === document)
  check('while the plane really moved', tools().cutPlane.position[1] === 1.25, `${tools().cutPlane.position[1]}`)

  // The ring sizes the guide square -- the plane's only dimension, which is why
  // its arrows are built with sizing switched off.
  doc().startCutGizmo({ mode: 'size', axis: 'all' })
  tools().setCutPlane({ size: CUT_SIZE_MAX })
  check('the ring can drive the guide to its limit', tools().cutPlane.size === CUT_SIZE_MAX, `${tools().cutPlane.size}`)
  // The ring is the only thing that sizes the guide now, so the limit is only
  // enforceable from the store side -- there is no slider left to read it off.
  check('which is the limit the store holds it to', tools().cutPlane.size <= CUT_SIZE_MAX, `${tools().cutPlane.size}`)

  doc().endDrag()
  tools().setCutActive(false)
  check('leaving the tool rearms the plane', tools().cutPlane.position[1] === 0, `${tools().cutPlane.position[1]}`)
}

// --- 8. Merging, and the selection that chooses it -------------------------
console.log('\n8. Merge welds the selection into one object')

resetEvaluator()
doc().reset()

{
  const a = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1, 0])
  const b = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [4, 1, 0])
  const c = doc().addObject({ kind: 'sphere', radius: 1 }, [8, 1, 0])

  // Selection is a set, and a plain click means "just this one".
  doc().selectObject(a)
  check('a click selects one object', doc().selectedObjectIds.length === 1, `${doc().selectedObjectIds.length}`)
  check('and the selector agrees with the head of it', primarySelection(doc()) === a, `${primarySelection(doc())}`)

  doc().toggleObjectSelection(b)
  check('shift adds to it', doc().selectedObjectIds.join() === `${a},${b}`, doc().selectedObjectIds.join())
  check('with the FIRST picked still leading', primarySelection(doc()) === a, `${primarySelection(doc())}`)
  doc().toggleObjectSelection(b)
  check('and shift takes it away again', doc().selectedObjectIds.join() === a, doc().selectedObjectIds.join())

  // Nothing to merge with one object picked.
  check('one object is not a merge', doc().mergeObjects([a]) === 0)
  check('nor is a selection of nothing', doc().mergeObjects([]) === 0)

  const before = doc().past.length
  doc().toggleObjectSelection(b)
  doc().toggleObjectSelection(c)
  const absorbed = doc().mergeObjects(doc().selectedObjectIds)

  check('merging takes everything after the first', absorbed === 2, `${absorbed}`)
  check('and the scene is one object', doc().doc.objects.length === 1, `${doc().doc.objects.length}`)
  check('costing one undo entry', doc().past.length === before + 1, `${doc().past.length - before}`)

  const host = doc().doc.objects[0]
  check('the host keeps its own id', host.id === a, `${host.id} vs ${a}`)
  check('and carries the other two as parts', host.parts.length === 2, `${host.parts.length}`)
  check(
    'each keeping the base it was merged with',
    host.parts[0].base.kind === 'box' && host.parts[1].base.kind === 'sphere',
    host.parts.map((p) => p.base.kind).join(',')
  )

  // Nothing moved. The parts' placements were rewritten into the host's space,
  // so composing the host back on has to land them where they stood.
  const world = (i: number) =>
    new Vector3(0, 0, 0)
      .applyMatrix4(objectMatrix(host.parts[i].transform))
      .applyMatrix4(objectMatrix(host.transform))
  near('the first part did not move', world(0).x, 4, 1e-9)
  near('nor the second', world(1).x, 8, 1e-9)

  // One object means one selection and one gizmo.
  check('the merged object is the whole selection', doc().selectedObjectIds.join() === a, doc().selectedObjectIds.join())

  const tree = markupOf('SceneTree (merged)', SceneTree)
  shows('the tree shows one row', tree, '>1<')
  shows('marked as a merge of three', tree, '3 merged')
  // Merged, there is nothing left to merge, so the button stands down.
  hides('and offers no further merge', tree, 'merge-btn')

  doc().undo()
  check('undo puts all three back', doc().doc.objects.length === 3, `${doc().doc.objects.length}`)
  check('with none of them carrying parts', doc().doc.objects.every((o) => o.parts.length === 0))
}

{
  // The button appears only when it would do something, and says how many.
  doc().selectObject(doc().doc.objects[0].id)
  check(
    'one object selected offers no merge',
    renderToStaticMarkup(createElement(MergeButton)) === '',
    'MergeButton renders nothing'
  )

  doc().toggleObjectSelection(doc().doc.objects[1].id)
  const bar = markupOf('MergeButton (two selected)', MergeButton)
  shows('two selected offers it', bar, 'Merge 2')
  // It belongs to the Scene section now, beside the rows it would fold
  // together -- not in the toolbar, a long way from the list saying what it
  // will take.
  shows('and it sits in the Scene section', markupOf('SceneTree (mergeable)', SceneTree), 'merge-btn')
  doc().toggleObjectSelection(doc().doc.objects[2].id)
  shows('and it counts them', markupOf('MergeButton (three)', MergeButton), 'Merge 3')

  doc().selectObject(null)
  check(
    'deselecting takes it away again',
    renderToStaticMarkup(createElement(MergeButton)) === '',
    'MergeButton renders nothing'
  )
}

{
  // A merged object is ONE object, and the two things that read it as one are
  // the gizmo and the Dimensions panel. Both used to read the host primitive
  // alone: the arrows sat on whichever solid happened to lead the merge, and a
  // Width field resized that solid and left the rest where they were.
  resetEvaluator()
  doc().reset()
  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)

  const a = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1, 0])
  const b = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [4, 1, 0])
  doc().selectObject(a)
  doc().toggleObjectSelection(b)
  doc().mergeObjects(doc().selectedObjectIds)

  const merged = () => doc().doc.objects[0]

  // Midway between the two origins, which is where the two gizmos were.
  const centre = assemblyCentre(merged())
  near('the merged centre sits between the two solids', centre[0], 2, 1e-9)
  check('and on the axes they share', centre[1] === 0 && centre[2] === 0, centre.join(','))

  const anchor = assemblyAnchor(merged())
  near('the gizmo carries that point into the world', anchor[0], 2, 1e-9)
  near('lifted by the host transform like everything else', anchor[1], 1, 1e-9)

  // A bare solid's anchor is its own origin, which is what lets the viewport
  // and the drag maths use the assembly anchor unconditionally.
  const lone = doc().addObject({ kind: 'sphere', radius: 1 }, [0, 3, 0])
  const loneAnchor = assemblyAnchor(doc().doc.objects.find((o) => o.id === lone)!)
  check('an unmerged object anchors on its own origin', loneAnchor.join() === '0,3,0', loneAnchor.join())
  doc().removeObject(lone)

  doc().selectObject(a)
  const panel = markupOf('ObjectPanel (merged)', ObjectPanel)
  shows('the panel offers one size for the whole thing', panel, '>Size<')
  hides("and not the host primitive's own width", panel, '>Width<')
  shows('saying how many solids it covers', panel, '2 merged')

  // The bug in one line: sizing a merge has to move every solid in it.
  const widthOf = (base: BaseSolid) => (base.kind === 'box' ? base.size[0] : NaN)
  near('the assembly measures its full reach', assemblyExtent(merged()), 6, 1e-9)
  doc().scaleObject(a, 2)
  near('scaling doubles the host', widthOf(merged().base), 4, 1e-9)
  near(
    'and the part with it, which is what merging promised',
    widthOf(merged().parts[0].base),
    4,
    1e-9
  )
  near('the gap between them scales too', merged().parts[0].transform.position[0], 8, 1e-9)
  near('so the whole object measures twice what it did', assemblyExtent(merged()), 12, 1e-9)

  // Scaled about its own centre, not about the host's origin -- so the gizmo
  // the user is dragging stays under the pointer instead of sliding away.
  const grown = assemblyAnchor(merged())
  near('and it grew about the gizmo, which has not moved', grown[0], 2, 1e-9)
  near('on every axis', grown[1], 1, 1e-9)

  doc().undo()
  near('undo puts the size back', assemblyExtent(merged()), 6, 1e-9)

  // The ring drag: measured from the snapshot the gesture pinned, and silent
  // once it clamps -- the same two rules `resizeObjectTo` follows.
  const snapshot = merged()
  doc().startGizmo(a, { mode: 'size', axis: 'all' })
  doc().scaleObjectTo(snapshot, 40)
  near('a runaway ring drag stops at the ceiling', assemblyExtent(merged()), 6 * (MAX_SIZE / 2), 1e-9)

  const pinned = doc().doc
  const entries = doc().past.length
  doc().scaleObjectTo(snapshot, 60)
  doc().scaleObjectTo(snapshot, 80)
  check('and then stops writing entirely', doc().doc === pinned)
  check('adding no further history', doc().past.length === entries, `${doc().past.length}`)

  doc().endDrag()
  doc().undo()
  near('one undo puts the whole gesture back', assemblyExtent(merged()), 6, 1e-9)
}


// --- 9. Copy, paste, and the clipboard shelf -------------------------------
console.log('\n9. What the user puts aside, and what comes back out')

resetEvaluator()
doc().reset()
for (const c of [...library().customs]) library().removeCustom(c.id)
useLibrary.setState({ clipboard: null })
for (const o of [...doc().doc.objects]) doc().removeObject(o.id)
publish([])

{
  // A copy has to stand beside its source and be edited apart from it, which
  // means every id in it -- down through merged parts -- is new. Two objects
  // sharing a feature id would collide in the evaluator's per-object cache and
  // edit each other's sketches.
  const source = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1, 0])
  doc().startPlacing({ type: 'circle', r: 0.3 })
  doc().updatePlacing(source, { on: 'box-face', face: 2, u: 0, v: 0 })
  doc().commitPlacing()
  const inner = doc().addObject({ kind: 'sphere', radius: 0.6 }, [1, 1, 0])
  doc().selectObject(source)
  doc().toggleObjectSelection(inner)
  doc().mergeObjects(doc().selectedObjectIds)

  const original = doc().doc.objects[0]
  const copy = cloneObject(original)
  check('a copy is a different object', copy.id !== original.id, `${copy.id} vs ${original.id}`)
  check(
    'its sketches are its own',
    copy.features[0].id !== original.features[0].id,
    `${copy.features[0].id} vs ${original.features[0].id}`
  )
  check(
    'and so are the parts merged into it',
    copy.parts[0].id !== original.parts[0].id,
    `${copy.parts[0].id} vs ${original.parts[0].id}`
  )
  check(
    'while everything else came along',
    copy.features.length === original.features.length &&
      copy.parts.length === original.parts.length,
    `${copy.features.length} sketches, ${copy.parts.length} parts`
  )
  // Deep, not shallow: the arrays are cloned too, so nothing done to the copy
  // can reach back into the original.
  check(
    'down to the arrays inside it',
    copy.transform.position !== original.transform.position
  )

  // Ctrl+C then Ctrl+V, as the viewport drives them.
  const before = doc().doc.objects.length
  library().copyObject(original)
  check('copying puts the object on the clipboard', library().clipboard?.id === original.id)
  check(
    'and changes the scene not at all',
    doc().doc.objects.length === before,
    `${doc().doc.objects.length}`
  )

  const held = library().clipboard
  const pasted = held ? doc().pasteObject(held) : ''
  check('pasting adds one object', doc().doc.objects.length === before + 1, `${doc().doc.objects.length}`)
  check('and selects it', primarySelection(doc()) === pasted, `${primarySelection(doc())}`)

  const landed = doc().doc.objects.find((o) => o.id === pasted)
  if (!landed) {
    check('the pasted object is in the scene', false)
  } else {
    // Clear of the original rather than exactly on top of it, where a copy is
    // invisible and the user cannot tell which of the two they have hold of.
    check(
      'set down clear of what it came from',
      landed.transform.position[0] > original.transform.position[0],
      `${landed.transform.position[0]} vs ${original.transform.position[0]}`
    )
    check(
      'at the same height, so it rests where the original did',
      landed.transform.position[1] === original.transform.position[1],
      `${landed.transform.position[1]}`
    )
    check('carrying the sketches with it', landed.features.length === 1, `${landed.features.length}`)
    check('and the merge', landed.parts.length === 1, `${landed.parts.length}`)
  }

  doc().undo()
  check('one undo takes the paste back', doc().doc.objects.length === before, `${doc().doc.objects.length}`)
  // The clipboard is not the document. Undo rewinds the last edit, never the
  // copy -- which is why neither it nor the shelf lives in the doc.
  check('and the clipboard still holds it', library().clipboard !== null)
}

{
  // The shelf. Names default to the lowest Custom N nobody is using, so a panel
  // holding two things never offers to call the next one "Custom 9".
  const object = doc().doc.objects[0]
  library().saveCustom(object)
  library().saveCustom(object)
  check(
    'saved objects are named in order',
    library().customs.map((c) => c.name).join() === 'Custom 1,Custom 2',
    library().customs.map((c) => c.name).join()
  )

  const first = library().customs[0].id
  library().renameCustom(first, 'Bracket')
  check('renaming takes', library().customs[0].name === 'Bracket', library().customs[0].name)
  // And frees the old name rather than leaving a hole in the numbering.
  library().saveCustom(object)
  check(
    'which frees the name it gave up',
    library().customs[2].name === 'Custom 1',
    library().customs[2].name
  )

  const panel = markupOf('ClipboardPanel', ClipboardPanel)
  shows('the panel lists them', panel, 'Bracket')
  shows('in a grid', panel, 'custom-grid')
  shows('each one renameable in place', panel, 'custom-name')
  shows('and draggable into the scene', panel, 'custom-grab')

  library().removeCustom(first)
  check('removing takes one away', library().customs.length === 2, `${library().customs.length}`)
}

{
  // Dragging a custom off the shelf is the palette's gesture carrying a whole
  // object rather than a bare primitive. Everything the user built has to
  // survive the round trip -- and arrive with ids that are not the shelf
  // copy's, or two drops of one tile would be the same object twice.
  const saved = library().customs[0].object
  doc().startPlacingSolidTemplate(saved)
  const drag = doc().drag
  check('the drag carries a template', drag.kind === 'placing-solid', drag.kind)
  if (drag.kind === 'placing-solid') {
    check('with the sketches on it', drag.template.features.length === 1, `${drag.template.features.length}`)
    check('and the solids merged into it', drag.template.parts.length === 1, `${drag.template.parts.length}`)
    check('minted fresh, not the shelf copy', drag.template.id !== saved.id, drag.template.id)
    check(
      'and parked at the origin, since the drop chooses where it lands',
      drag.template.transform.position.join() === '0,0,0',
      drag.template.transform.position.join()
    )
  }

  const count = doc().doc.objects.length
  doc().updatePlacingSolid([3, 1, -2])
  doc().commitPlacingSolid()
  check('releasing places it', doc().doc.objects.length === count + 1, `${doc().doc.objects.length}`)
  const placed = doc().doc.objects[doc().doc.objects.length - 1]
  check('where the drag left it', placed.transform.position.join() === '3,1,-2', placed.transform.position.join())
  check('with everything it was saved with', placed.features.length === 1 && placed.parts.length === 1)

  // Two drops of one tile are two objects, not one shared twice.
  doc().startPlacingSolidTemplate(saved)
  doc().updatePlacingSolid([6, 1, -2])
  doc().commitPlacingSolid()
  const again = doc().doc.objects[doc().doc.objects.length - 1]
  check('dropping the same tile twice makes two objects', again.id !== placed.id, `${again.id} vs ${placed.id}`)
  check(
    'with sketches of their own',
    again.features[0].id !== placed.features[0].id,
    `${again.features[0].id} vs ${placed.features[0].id}`
  )

  // A gesture released off the canvas cancels cleanly, leaving nothing behind.
  const settled = doc().doc.objects.length
  doc().startPlacingSolidTemplate(saved)
  doc().commitPlacingSolid()
  check('and releasing nowhere places nothing', doc().doc.objects.length === settled, `${doc().doc.objects.length}`)
  check('leaving no drag running', doc().drag.kind === 'idle', doc().drag.kind)
}

{
  // The menu hangs off one object and must not outlive it: the Delete key and
  // an undo can both take that object away while it is open.
  const id = doc().doc.objects[0].id
  useObjectMenu.getState().openMenu(120, 80, id)
  const menu = markupOf('ObjectMenu', ObjectMenu)
  shows('the menu names the object it was opened on', menu, 'menu-head')
  shows('offering copy', menu, '>Copy<')
  shows('and paste', menu, '>Paste<')
  shows('and the shelf', menu, 'Save as custom object')
  shows('with the shortcuts that do the same', menu, 'Ctrl+C')

  doc().removeObject(id)
  check(
    'and it renders nothing once that object is gone',
    renderToStaticMarkup(createElement(ObjectMenu)) === ''
  )
  useObjectMenu.getState().closeMenu()
  check(
    'nor when it is simply closed',
    renderToStaticMarkup(createElement(ObjectMenu)) === ''
  )
}

{
  // The three-live cap IS the optimization: every live model is a WebGL
  // context, and a fourth slipping through is not something to find out about
  // from a black viewport. Ranked by measured visibility, so a scroll caught
  // mid-way lights the three the user is looking at.
  const ids = ['a', 'b', 'c', 'd', 'e']
  const seeded = liveTiles(ids, {}, 3)
  check(
    'before anything is measured, the leading three are live',
    [...seeded].sort().join() === 'a,b,c',
    [...seeded].join()
  )

  const scrolled = liveTiles(ids, { a: 0, b: 0.1, c: 1, d: 1, e: 0.9 }, 3)
  check(
    'once measured, the most visible three are',
    [...scrolled].sort().join() === 'c,d,e',
    [...scrolled].join()
  )
  check('never a fourth', liveTiles(ids, { a: 1, b: 1, c: 1, d: 1, e: 1 }, 3).size === 3)
  check(
    'and a tile fully out of view is never live',
    !liveTiles(ids, { a: 0, b: 1, c: 1, d: 1, e: 0 }, 3).has('a')
  )
  check('an empty shelf lights nothing', liveTiles([], {}, 3).size === 0)
}

{
  // The panel before any model is built: a ring per tile, in a row that scrolls
  // sideways rather than a grid that wraps. A wrapping grid has no "next three"
  // to scroll to -- the fourth tile would sit below the first, permanently in
  // view and permanently unable to have a model.
  const rings = markupOf('ClipboardPanel (loading)', ClipboardPanel)
  // Counted on the role rather than the class, which appears three times per
  // ring -- the element and its two circles.
  check(
    'every saved object starts as a loading ring',
    occurrences(rings, 'role="progressbar"') === library().customs.length,
    `${occurrences(rings, 'role="progressbar"')} rings for ${library().customs.length} saved`
  )
  shows('drawn as a circular bar, not a spinner glyph', rings, 'thumb-ring-arc')
  shows('in the scrolling row', rings, 'custom-grid')
  shows('with each tile findable by the observer', rings, 'data-custom')
}

{
  // The model itself. Nothing here can be seen from a headless run, so what is
  // checked is what would be WRONG on screen: a model framed off its pivot
  // wobbles as it turns instead of spinning in place, and one too big for the
  // frame is cropped by it.
  // Read from the component, never copied: a second set of these would agree
  // with it exactly until the day one was tuned, and then quietly stop checking
  // the framing that actually ships.
  const { fov: FOV, elevation: ELEVATION } = VIEW

  /** The furthest any vertex reaches from the origin the model turns about. */
  const reachOf = (thumb: { geometry: BufferGeometry }) => {
    const position = thumb.geometry.getAttribute('position')
    const at = new Vector3()
    let reach = 0
    for (let i = 0; i < position.count; i++) {
      reach = Math.max(reach, at.fromBufferAttribute(position, i).length())
    }
    return reach
  }

  const framed = (object: SceneObject) => {
    const thumb = thumbnailFor(object)
    const distance = framingDistance(thumb.radius)
    return {
      thumb,
      // The full angle the model subtends from the camera. Past the fov, the
      // frame crops it.
      subtends: (Math.asin(Math.min(1, thumb.radius / distance)) * 360) / Math.PI,
      slack: thumb.radius - reachOf(thumb),
    }
  }

  // A bead, a wall and a merge of two solids: the framing is derived from each
  // object's own reach, so all three have to land the same way -- and so must a
  // sphere and a cube that reach equally far, which is what the exact radius
  // buys over a bounding box's diagonal.
  const shapes: { label: string; object: SceneObject }[] = [
    { label: 'a bead', object: makeObject({ kind: 'sphere', radius: 0.12 }, [0, 0, 0]) },
    { label: 'a wall', object: makeObject({ kind: 'box', size: [8, 6, 0.4] }, [0, 0, 0]) },
    {
      label: 'a merge',
      object: {
        ...makeObject({ kind: 'box', size: [2, 2, 2] }, [0, 0, 0]),
        parts: [
          {
            ...makeObject({ kind: 'sphere', radius: 0.3 }, [0, 0, 0]),
            transform: { position: [4, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
          },
        ],
      },
    },
  ]

  {
    // A bounding box's diagonal over-states a round object by up to the square
    // root of three, so a sphere used to be drawn a third the size of a cube
    // that reached exactly as far. Measured to the furthest vertex, the two are
    // framed identically.
    const ball = framed(makeObject({ kind: 'sphere', radius: 1 }, [0, 0, 0]))
    const block = framed(makeObject({ kind: 'box', size: [2, 2, 2] }, [0, 0, 0]))
    check(
      'a sphere and a cube of the same reach are drawn the same size',
      Math.abs(ball.subtends - block.subtends) < 1e-6,
      `${ball.subtends.toFixed(2)} vs ${block.subtends.toFixed(2)} degrees`
    )
  }

  for (const { label, object } of shapes) {
    const f = framed(object)
    // Exact, not a bounding box's diagonal: the radius IS the furthest vertex,
    // so nothing sticks out of the sphere the camera was framed on.
    near(`${label} is measured to its furthest point`, f.slack, 0, 1e-6)
    // Room to spare, not merely inside: a tile is an identifier at a glance,
    // and the sphere being measured is the worst frame of the whole turn.
    check(
      `${label} sits well inside the frame`,
      f.subtends < FOV * 0.55,
      `subtends ${f.subtends.toFixed(1)} of ${FOV} degrees`
    )
  }

  // Framed on the GIZMO, not on the middle of the bounding box. Here the two
  // are 0.35 apart: a 2-cube at the origin with a small bead welded on at x=4
  // has its gizmo midway between the two origins, at x=2, while its bounding
  // box runs -1..4.3 and is centred at 1.65.
  {
    const box = new Box3().setFromBufferAttribute(
      thumbnailFor(shapes[2].object).geometry.getAttribute('position') as never
    )
    near(
      'a merge is framed on its gizmo, not on the middle of its box',
      box.getCenter(new Vector3()).x,
      -0.35,
      0.02
    )
  }

  // The view from above is a TILT ON THE MODEL, not a raised camera: nothing has
  // to be aimed, so nothing can be left unaimed. What has to hold is that the
  // two are the same picture -- the camera, seen from the model's own frame,
  // stands ELEVATION degrees above its horizon.
  {
    const tilt = new Matrix4().makeRotationX((ELEVATION * Math.PI) / 180)
    const seenFrom = new Vector3(0, 0, 1).applyMatrix4(tilt.invert()).normalize()
    near(
      'tilting the model is the same as looking down on it at 30 degrees',
      (Math.asin(seenFrom.y) * 180) / Math.PI,
      ELEVATION,
      1e-9
    )
  }

  // The rotation it was saved at comes along: a cylinder put aside lying down
  // is that shape, and a thumbnail that stood it upright would advertise
  // something other than what the tile drops.
  const lying: SceneObject = {
    ...makeObject({ kind: 'cylinder', radius: 0.8, height: 3 }, [0, 0, 0]),
    transform: { position: [0, 0, 0], rotation: [Math.PI / 2, 0, 0] },
  }
  const laid = new Box3()
    .setFromBufferAttribute(thumbnailFor(lying).geometry.getAttribute('position') as never)
    .getSize(new Vector3())
  check(
    'a solid saved lying down is drawn lying down',
    laid.z > laid.y + 1,
    `y=${laid.y.toFixed(2)} z=${laid.z.toFixed(2)}`
  )

  // The cache in front of the solve, which is what stops a sweep back and forth
  // across the shelf from re-replaying every object it passes.
  const cube = makeObject({ kind: 'box', size: [2, 2, 2] }, [0, 0, 0])
  check('a mesh is built once and kept', thumbnailFor(cube) === thumbnailFor(cube))
  releaseThumbnail(cube)
  check('and given up when the shelf gives up the object', !thumbnailCached(cube))

  // Bounded, so a long session cannot accumulate GPU buffers without end.
  const many = Array.from({ length: 20 }, (_, i) =>
    makeObject({ kind: 'sphere', radius: 0.5 + i * 0.01 }, [0, 0, 0])
  )
  for (const o of many) thumbnailFor(o)
  check(
    'and it holds a bounded number of them',
    many.filter(thumbnailCached).length <= 12,
    `${many.filter(thumbnailCached).length} held`
  )

  for (const { object } of shapes) releaseThumbnail(object)
  releaseThumbnail(lying)
  for (const o of many) releaseThumbnail(o)
}

// --- 10. Every solid, every anchor ----------------------------------------
console.log('\n10. The two data-driven panels across every solid and anchor')

/**
 * Both panels switch on a union: ObjectPanel on `BaseSolid['kind']`, Inspector
 * on `SurfaceAnchor['on']` and `Shape2D['type']`. The sequence above walks one
 * path through each. This walks all of them, because a missing case in a switch
 * that returns JSX renders as nothing rather than as an error.
 */
resetEvaluator()
doc().reset()
for (const o of [...doc().doc.objects]) doc().removeObject(o.id)
publish([])

const SOLIDS: { label: string; base: BaseSolid; expect: string }[] = [
  { label: 'cube', base: defaultBaseFor('box'), expect: '>Width<' },
  { label: 'oblong box', base: { kind: 'box', size: [2, 1, 3] }, expect: '>Depth<' },
  { label: 'sphere', base: defaultBaseFor('sphere'), expect: '>Radius<' },
  { label: 'cylinder', base: defaultBaseFor('cylinder'), expect: '>Height<' },
  { label: 'cone', base: defaultBaseFor('cone'), expect: '>Height<' },
  { label: 'bean', base: defaultBaseFor('capsule'), expect: 'domed caps' },
  { label: 'pentagonal pyramid', base: defaultBaseFor('pyramid', 5), expect: '>Sides<' },
  { label: 'heptagonal prism', base: defaultBaseFor('prism', 7), expect: '>Sides<' },
  // A radius and nothing else. The Tetra/Octa/Dodeca switcher that used to sit
  // under these is gone: swapping one platonic for another is placing a
  // different solid, not resizing this one, and the palette already does it.
  { label: 'tetrahedron', base: defaultBaseFor('platonic', undefined, 'tetrahedron'), expect: '>Radius<' },
  { label: 'octahedron', base: defaultBaseFor('platonic', undefined, 'octahedron'), expect: '>Radius<' },
  { label: 'dodecahedron', base: defaultBaseFor('platonic', undefined, 'dodecahedron'), expect: '>Radius<' },
]

for (const { label, base, expect } of SOLIDS) {
  const id = doc().addObject(base, [0, 0, 0])
  doc().selectObject(id)
  const panel = markupOf(`ObjectPanel (${label})`, ObjectPanel)
  hides(`${label} is not the empty branch`, panel, 'Nothing selected')
  shows(`${label} offers its own dimensions`, panel, expect)
  if (base.kind === 'platonic') {
    hides(`${label} offers no kind switcher`, panel, '>Solid<')
    // Not the label text, which the section hint still carries: the chips
    // themselves. A platonic panel has no other segmented control.
    hides('nor the chips that drove it', panel, 'seg-btn')
  }
  shows(`${label} can be deleted`, panel, 'Delete object')
  doc().removeObject(id)
}

{
  // A side count the palette can drag in but the Object panel cannot show would
  // strand the user on a solid they are unable to switch back from. The panel
  // keeps its own copy of the list, so the two are compared rather than assumed.
  const offered = [...new Set(SOLID_TEMPLATES.flatMap((t) => t.sides ?? []))].sort((a, b) => a - b)
  check('the palette offers side counts at all', offered.length > 0, offered.join(','))

  const id = doc().addObject(defaultBaseFor('prism', 6), [0, 0, 0])
  doc().selectObject(id)
  const panel = markupOf('ObjectPanel (side chips)', ObjectPanel)
  const missing = offered.filter((n) => !panel.includes(`seg-btn${n === 6 ? ' seg-active' : ''}">${n}<`))
  check(
    'and the Object panel offers every one of them',
    missing.length === 0,
    missing.length ? `no chip for ${missing.join(',')}` : offered.join(',')
  )
  doc().removeObject(id)
}

const ANCHORS: { label: string; base: BaseSolid; anchor: SurfaceAnchor; expect: string }[] = [
  { label: 'box face', base: defaultBaseFor('box'), anchor: { on: 'box-face', face: 4, u: 0, v: 0 }, expect: 'Face +Z' },
  { label: 'prism wall', base: defaultBaseFor('prism', 6), anchor: { on: 'planar-face', face: 0, u: 0, v: 0 }, expect: 'Face 1' },
  { label: 'sphere', base: defaultBaseFor('sphere'), anchor: { on: 'sphere', theta: 0.4, phi: 1.1 }, expect: 'Sphere surface (curved)' },
  { label: 'cylinder wall', base: defaultBaseFor('cylinder'), anchor: { on: 'cylinder', theta: 0.3, y: 0.2 }, expect: 'Cylinder wall (curved)' },
  { label: 'cone wall', base: defaultBaseFor('cone'), anchor: { on: 'cone', theta: 0.3, t: 0.4 }, expect: 'Cone wall (curved)' },
  { label: 'bean', base: defaultBaseFor('capsule'), anchor: { on: 'capsule', theta: 0.3, phi: 1 }, expect: 'Bean surface (curved)' },
  { label: 'derived face', base: defaultBaseFor('box'), anchor: { on: 'derived', point: [0, 1, 0], normal: [0, 1, 0] }, expect: 'Feature surface' },
]

const SHAPES: { label: string; shape: Shape2D; expect: string }[] = [
  { label: 'circle', shape: defaultShape('circle'), expect: '>Radius<' },
  { label: 'rect', shape: defaultShape('rect'), expect: '>Width<' },
  { label: 'ngon', shape: defaultShape('ngon'), expect: '>Sides<' },
]

for (const { label, base, anchor, expect } of ANCHORS) {
  for (const shape of SHAPES) {
    const id = doc().addObject(base, [0, 0, 0])
    doc().startPlacing(shape.shape)
    doc().updatePlacing(id, anchor)
    doc().commitPlacing()
    const fid = doc().selectedFeatureId
    if (fid === null) {
      check(`a ${shape.label} lands on a ${label}`, false, 'no feature was created')
      doc().removeObject(id)
      continue
    }

    const flat = markupOf(`Inspector (${label} / ${shape.label})`, Inspector)
    shows(`${label} is named`, flat, expect)
    shows(`its ${shape.label} offers the right dimensions`, flat, shape.expect)
    hides(`and a flat ${shape.label} has no End face group`, flat, 'End face')

    doc().setDepth(id, fid, DEFAULT_FEATURE_DEPTH)
    const solid = markupOf(`Inspector (${label} / ${shape.label}, extruded)`, Inspector)
    shows(`extruding on a ${label} reveals the End face group`, solid, 'End face')
    shows(`with a tilt for the ${shape.label}`, solid, '>Tilt<')
    shows('and a slide', solid, '>Slide<')

    doc().removeObject(id)
  }
}

// --- the selection box ------------------------------------------------------
console.log('\nThe selection box only appears once it is one')
{
  const marquee = () => useMarquee.getState()
  // Rendered directly rather than through `markupOf`, which counts an empty
  // render as a failure -- and drawing nothing is half of what is under test.
  const drawnBox = () => renderToStaticMarkup(createElement(MarqueeRect))

  marquee().clear()
  check('with no gesture running there is no box', drawnBox() === '')

  // A press that has not travelled is still a click on empty space, and a
  // rectangle flashing up under every one of those would be noise.
  marquee().begin(100, 100, [])
  marquee().to(100 + MARQUEE_SLOP - 1, 100)
  check('a press that has barely moved draws nothing', drawnBox() === '')

  marquee().to(340, 260)
  const drawn = drawnBox()
  shows('once it is a box it is drawn', drawn, 'class="marquee"')
  shows('anchored at the press', drawn, 'left:100px')
  shows('and top:100px', drawn, 'top:100px')
  shows('240 wide', drawn, 'width:240px')
  shows('and 160 tall', drawn, 'height:160px')

  // Dragged up and to the left instead: the same rectangle, described from the
  // corner it now occupies rather than with negative width.
  marquee().begin(340, 260, [])
  marquee().to(100, 100)
  const back = drawnBox()
  shows('a box dragged backwards starts at the same corner', back, 'left:100px')
  shows('and top:100px', back, 'top:100px')
  shows('with the same width', back, 'width:240px')
  shows('and the same height', back, 'height:160px')

  marquee().clear()
}

// --- the console's two tabs -------------------------------------------------
console.log('\nThe console splits into View and Edit')
{
  // The split is by what a panel is FOR: View works with nothing selected, Edit
  // only means anything once something is. Both lists are checked whole, so a
  // panel that quietly lands in both tabs -- or in neither -- fails here.
  const VIEW = ['>Clipboard<', '>Solids<', '>Shapes<', '>Color<', '>Scene<']
  const EDIT = ['>Position &amp; Rotation<', '>Dimensions<', '>Sketch<']

  tools().setConsoleTab('view')
  const view = markupOf('Console (View)', Console)
  shows('both tabs are offered', view, '>View<')
  shows('and Edit is one of them', view, '>Edit<')
  shows('View is the one marked selected', view, 'aria-selected="true" class="console-tab console-tab-active">View')
  for (const panel of VIEW) shows(`View carries ${panel}`, view, panel)
  for (const panel of EDIT) hides(`and not ${panel}`, view, panel)

  tools().setConsoleTab('edit')
  const edit = markupOf('Console (Edit)', Console)
  shows('Edit is the one marked selected now', edit, 'aria-selected="true" class="console-tab console-tab-active">Edit')
  for (const panel of EDIT) shows(`Edit carries ${panel}`, edit, panel)
  for (const panel of VIEW) hides(`and not ${panel}`, edit, panel)

  // Selecting an object fills the Edit tab and changes nothing on View, so the
  // tab itself has to say so or the console reads as inert to the click.
  tools().setConsoleTab('view')
  doc().selectObject(null)
  hides(
    'with nothing selected the Edit tab is unmarked',
    markupOf('Console (nothing selected)', Console),
    'console-tab-dot'
  )
  const marked = doc().addObject(defaultBaseFor('box'), [0, 0, 0])
  doc().selectObject(marked)
  shows(
    'selecting an object marks it',
    markupOf('Console (object selected)', Console),
    'console-tab-dot'
  )
  doc().removeObject(marked)
}

// --- one Extrude, signed both ways ------------------------------------------
console.log('\nExtrude is one control that crosses zero')
{
  const id = doc().addObject(defaultBaseFor('box'), [0, 0, 0])
  doc().startPlacing(defaultShape('circle'))
  doc().updatePlacing(id, { on: 'box-face', face: 2, u: 0, v: 0 })
  doc().commitPlacing()
  const fid = doc().selectedFeatureId
  check('a sketch to work with', fid !== null)
  if (fid !== null) {
    const depth = () => doc().doc.objects.find((o) => o.id === id)?.features[0].depth ?? NaN

    const flat = markupOf('Inspector (flat)', Inspector)
    shows('the depth control is called Extrude', flat, '>Extrude<')
    hides('and there is no separate Intrude mode', flat, '>Intrude<')
    shows('a flat sketch says what it is', flat, 'Projection only')

    // The whole point of collapsing the two modes: one slider, and its range
    // straddles zero rather than starting there.
    shows('the slider reaches below zero', flat, 'type="range" min="-3"')
    shows('and above it, further', flat, 'max="4"')

    doc().setDepth(id, fid, 0.3)
    near('a positive depth is a boss', depth(), 0.3, 1e-12)
    const out = markupOf('Inspector (boss)', Inspector)
    hides('which is no longer a projection', out, 'Projection only')
    shows('and has an end face to lean', out, 'End face')

    // The half that used to need a mode switch, and now needs a minus sign.
    doc().setDepth(id, fid, -0.5)
    near('a negative one is a pocket', depth(), -0.5, 1e-12)
    const into = markupOf('Inspector (pocket)', Inspector)
    hides('a pocket is not a projection either', into, 'Projection only')
    shows('and leans exactly like a boss does', into, 'End face')

    // The clamp lives in the store, so the slider, the button and the gizmo's
    // normal arrow cannot disagree about how far a feature may reach.
    doc().setDepth(id, fid, 99)
    check('an overreach outward is clamped', depth() > 0 && depth() <= 4, `${depth()}`)
    doc().setDepth(id, fid, -99)
    check('and an overreach inward keeps its sign', depth() < 0 && depth() >= -3, `${depth()}`)

    doc().setDepth(id, fid, 0)
    shows('back at zero it is a projection again', markupOf('Inspector (flat again)', Inspector), 'Projection only')

    // The gizmo's third arrow writes the same number, and a whole drag of it
    // costs ONE undo step rather than one per frame.
    // Read as the top of the history rather than as its length: the stack is
    // capped, and by this point in the suite it has long since filled, so a
    // count would sit at the cap however many entries a drag pushed.
    const priorDoc = doc().doc
    doc().startSketchGizmo(id, fid, { mode: 'size', axis: 2 })
    doc().depthTo(0.2)
    doc().depthTo(0.4)
    doc().depthTo(0.55)
    doc().endDrag()
    near('the arrow drag lands on its last depth', depth(), 0.55, 1e-12)
    check(
      'and the whole gesture is one undo step, taken from where it started',
      doc().past[doc().past.length - 1] === priorDoc
    )
    doc().undo()
    near('so one undo rewinds the whole drag', depth(), 0, 1e-12)

    // Dragged back THROUGH the face in one gesture: the same arrow, past zero.
    doc().startSketchGizmo(id, fid, { mode: 'size', axis: 2 })
    doc().depthTo(-0.4)
    doc().endDrag()
    near('the same arrow cuts inward past zero', depth(), -0.4, 1e-12)
  }
  doc().removeObject(id)
}

// --- the colour picker ------------------------------------------------------
console.log('\nThe colour picker, and the selection it paints')
{
  // 1. The arithmetic. The wheel is a picture of these functions, so a bug here
  //    is a marker sitting somewhere other than the colour it claims.
  const SAMPLES: [string, Hsv][] = [
    ['#ff0000', { h: 0, s: 1, v: 1 }],
    ['#00ff00', { h: 120, s: 1, v: 1 }],
    ['#0000ff', { h: 240, s: 1, v: 1 }],
    ['#000000', { h: 0, s: 0, v: 0 }],
    ['#ffffff', { h: 0, s: 0, v: 1 }],
    ['#804000', { h: 30, s: 1, v: 0.502 }],
  ]
  for (const [hex, hsv] of SAMPLES) {
    check(`${hex} is the colour ${hsv.h}deg says it is`, hsvToHex(hsv) === hex, hsvToHex(hsv))
  }

  // Round-tripping every hue at a few strengths, rather than the six primaries
  // alone: the sextant walk in `hsvToHex` is one expression covering six cases,
  // and only a sweep exercises the boundaries between them.
  let worst = 0
  for (let h = 0; h < 360; h += 7) {
    for (const s of [0.35, 0.7, 1]) {
      for (const v of [0.4, 0.8, 1]) {
        const back = hexToHsv(hsvToHex({ h, s, v }))
        if (!back) {
          check(`hue ${h} round-trips`, false, 'unparsable')
          continue
        }
        // 8 bits per channel is the floor on precision here, so the tolerance
        // is what a single step of quantisation can move each axis by.
        const dh = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h))
        worst = Math.max(worst, dh / 360, Math.abs(back.s - s), Math.abs(back.v - v))
      }
    }
  }
  check(
    'every hue survives the trip through 8-bit hex',
    worst < 0.01,
    `worst drift ${worst.toFixed(4)}`
  )

  // The hex field is only usable if it is LOSSLESS: a colour typed in, held as
  // HSV, and written back out has to be the same colour, or the field would
  // rewrite what the user typed the moment they left it.
  let drifted = 0
  for (let r = 0; r < 256; r += 9) {
    for (let g = 0; g < 256; g += 11) {
      for (let b = 0; b < 256; b += 13) {
        const typed = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
        const parsed = hexToHsv(typed)
        if (!parsed || hsvToHex(parsed) !== typed) drifted += 1
      }
    }
  }
  check('a typed hex comes back out exactly as typed', drifted === 0, `${drifted} drifted`)

  check('a short hex is read the same as a long one', hexToHsv('#f00')?.h === 0)
  check('and a value that is not a colour is refused', hexToHsv('lilac') === null)
  check('rather than quietly becoming black', parseHex('#12345') === null)

  // 2. The ring's geometry. Twelve o'clock is hue 0 and it runs clockwise,
  //    which is what `conic-gradient(from 0deg, ...)` paints -- get this
  //    backwards and the knob walks the wrong way round its own picture.
  near('the top of the ring is red', wheelHue(0.5, 0) ?? NaN, 0, 1e-9)
  near('a quarter clockwise is the right edge', wheelHue(1, 0.5) ?? NaN, 90, 1e-9)
  near('half way round is the bottom', wheelHue(0.5, 1) ?? NaN, 180, 1e-9)
  near('three quarters is the left edge', wheelHue(0, 0.5) ?? NaN, 270, 1e-9)
  // Only the direction is read, never the distance -- which is what makes the
  // ring hollow rather than a disc. A drag that wanders into the hole or off
  // past the rim keeps reporting the hue it points at.
  near('a point inside the hole still reads its hue', wheelHue(0.5, 0.45) ?? NaN, 0, 1e-9)
  near('and so does one past the rim', wheelHue(1, 1) ?? NaN, 135, 1e-9)
  check('only the dead centre has no hue at all', wheelHue(0.5, 0.5) === null)

  // The knob is placed by the inverse, so the two have to agree exactly or it
  // sits somewhere other than the hue it is showing.
  let placement = 0
  for (let h = 0; h < 360; h += 11) {
    const at = hueAt(h, 0.82)
    const back = wheelHue(at.x, at.y)
    if (back === null) {
      check(`hue ${h} places somewhere`, false, 'landed dead centre')
      continue
    }
    placement = Math.max(placement, Math.min(Math.abs(back - h), 360 - Math.abs(back - h)) / 360)
  }
  check('the knob sits exactly where the hue says', placement < 1e-9, `${placement}`)
  // Radius is the caller's, not the function's: the panel derives it from the
  // band's thickness, and a knob at a different radius is still the same hue.
  for (const r of [0.5, 0.82, 1]) {
    near(`radius ${r} does not move the hue`, wheelHue(hueAt(210, r).x, hueAt(210, r).y) ?? NaN, 210, 1e-9)
  }

  // 3. The paint the viewport puts on a solid.
  const grey = bodyPaint(undefined, false)
  check('an uncoloured solid keeps the scene grey', grey.color === DEFAULT_OBJECT_COLOR, grey.color)
  check('and glows not at all until it is selected', grey.emissiveIntensity === 0)
  check(
    'selected, it takes the hand-picked shade',
    bodyPaint(undefined, true).color !== DEFAULT_OBJECT_COLOR
  )

  const red = bodyPaint('#cc2222', false)
  check('a coloured solid wears its own colour', red.color === '#cc2222')
  const redLit = bodyPaint('#cc2222', true)
  const litHsv = hexToHsv(redLit.color)
  const restHsv = hexToHsv('#cc2222')
  check('and selecting it does not repaint it grey', (litHsv?.s ?? 0) > 0.5, redLit.color)
  check('it is lifted, not hue-shifted', Math.abs(litHsv?.h ?? 99) < 6, `${litHsv?.h.toFixed(1)}deg`)
  check('and it is genuinely brighter than at rest', (litHsv?.v ?? 0) > (restHsv?.v ?? 1))
  check('its glow is its own colour, not the blue that lifts grey', redLit.emissive === '#cc2222')
  // The lift is the sRGB one on purpose. Three's linear-space `lerp` at the
  // same fraction lands on #d77f7f, which is a pink, and this is the check that
  // would go red if the viewport ever went back to it.
  check('the lift is done in sRGB', lighten('#cc2222', 0.24) === '#d85757', lighten('#cc2222', 0.24))
  check('and a colour it cannot read is handed back, not blackened', lighten('teal', 0.5) === 'teal')

  // 4. What Apply does to the document.
  const a = dragIn(defaultBaseFor('box'), -3, 0)
  const b = dragIn(defaultBaseFor('sphere'), 0, 0)
  const c = dragIn(defaultBaseFor('cone'), 3, 0)
  const colorOf = (id: string) => doc().doc.objects.find((o) => o.id === id)?.color

  doc().selectObjects([a, b])
  // Read as the TOP of the history rather than its length: the stack is capped
  // and long since full by this point in the suite, so a count would sit at the
  // cap however many entries an Apply pushed. One entry, and it describes the
  // document as it stood before the Apply.
  const priorDoc = doc().doc
  doc().setObjectColor(doc().selectedObjectIds, '#3366cc')
  check('Apply paints the first selected object', colorOf(a) === '#3366cc', String(colorOf(a)))
  check('and the second', colorOf(b) === '#3366cc', String(colorOf(b)))
  check('and nothing that was not selected', colorOf(c) === undefined, String(colorOf(c)))
  check(
    'painting two objects is ONE undo step',
    doc().past[doc().past.length - 1] === priorDoc
  )

  doc().undo()
  check('which puts both back the way they were', colorOf(a) === undefined && colorOf(b) === undefined)
  doc().redo()
  check('and redo brings the colour back', colorOf(a) === '#3366cc')

  // The button is easy to press twice, and the second press must not bury the
  // edit before it under a history entry that changed nothing.
  const settled = doc().past.length
  doc().setObjectColor([a, b], '#3366cc')
  check('re-applying the same colour costs no undo step', doc().past.length === settled)
  doc().setObjectColor([], '#ff0000')
  check('and an empty selection paints nothing at all', doc().past.length === settled)

  // 5. The shelf of colours already used. It lives in the tool store, not the
  //    document: it must survive the panel unmounting on a tab switch, and it
  //    must stay out of undo -- walking back an edit should not also forget the
  //    colour you were working in.
  tools().noteRecentColor('#111111')
  tools().noteRecentColor('#222222')
  check('the shelf remembers, most recent first', tools().recentColors[0] === '#222222')
  check('and keeps what came before it', tools().recentColors[1] === '#111111')
  tools().noteRecentColor('#111111')
  check('re-using a colour moves it to the front', tools().recentColors[0] === '#111111')
  check('rather than keeping two of it', tools().recentColors.length === 2)
  for (let i = 0; i < RECENT_COLOR_SLOTS + 4; i += 1) {
    tools().noteRecentColor(hsvToHex({ h: i * 21, s: 1, v: 1 }))
  }
  check(
    'and the shelf never outgrows its slots',
    tools().recentColors.length === RECENT_COLOR_SLOTS,
    `${tools().recentColors.length}`
  )

  // 6. The panel itself.
  tools().setConsoleTab('view')
  doc().selectObject(null)
  const idle = markupOf('ColorPanel (nothing selected)', ColorPanel)
  shows('with nothing selected Apply stands down', idle, 'disabled=""')
  // No inline note about it any more. An empty selection is the state this
  // panel opens in, so a paragraph explaining it was 50px of height charged
  // on every visit to say what the greyed-out button already says; the reason
  // rides Apply's own title, where it costs nothing.
  hides('without a note charging the panel height for it', idle, 'Nothing selected.')
  shows('the reason rides Apply instead', idle, 'Select an object first')

  doc().selectObject(a)
  const one = markupOf('ColorPanel (one selected)', ColorPanel)
  shows('the hex field reads back that colour', one, 'value="#3366cc"')
  shows('and it is a field, not a label', one, 'class="picker-hex-input"')
  shows('the ring is there to turn', one, 'aria-label="Hue, 220 degrees"')
  shows('and the slider to brighten', one, 'aria-orientation="vertical"')
  // Hollow: the hole is what makes it a ring rather than a disc, and the knob
  // rides the band at the radius ColorPanel derives from the band's thickness.
  shows('the ring is hollow', one, 'class="picker-ring-hole"')
  shows('with a knob on the band', one, 'class="picker-knob"')

  // The shelf is drawn full whether or not there are colours in it, so the
  // panel does not change height as it fills.
  check(
    'the shelf draws every slot',
    occurrences(one, 'class="picker-slot') === RECENT_COLOR_SLOTS,
    `${occurrences(one, 'class="picker-slot')}`
  )

  doc().selectObjects([a, b, c])
  const many = markupOf('ColorPanel (three selected)', ColorPanel)
  shows('three selected and the button says how many', many, 'Apply to 3')
  shows('as does the heading', many, '3 selected')

  // An empty shelf still draws its slots, and every one of them is inert.
  useTools.setState({ recentColors: [] })
  const bare = markupOf('ColorPanel (empty shelf)', ColorPanel)
  check(
    'an empty shelf is all empty slots',
    occurrences(bare, 'picker-slot picker-slot-empty') === RECENT_COLOR_SLOTS,
    `${occurrences(bare, 'picker-slot picker-slot-empty')}`
  )
  shows('and they say what they are for', bare, 'colours land here as you apply them')

  for (const id of [a, b, c]) doc().removeObject(id)
}

console.log(
  failures === 0
    ? '\nAll console checks passed.\n'
    : `\n${failures} console check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
