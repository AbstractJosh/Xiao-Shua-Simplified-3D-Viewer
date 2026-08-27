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
import { SelectionHud } from '../src/viewport/SelectionHud'
import { SCRUB_SLOP, SCRUB_SPAN, scrubRate, scrubbed } from '../src/console/scrub'
import { ColorPanel } from '../src/console/ColorPanel'
import type { Hsv } from '../src/color'
import { hexToHsv, hsvToHex, hueAt, lighten, parseHex, wheelHue } from '../src/color'
import { assemblyColors } from '../src/geometry/assembly'
import { bodyPaint, depthBias } from '../src/viewport/SceneObjects'
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
import { evaluateDoc, evaluateObject, resetEvaluator } from '../src/geometry/evaluate'
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

  // The order is a control now, not a readout: every row carries a pair of
  // arrows, and the two at the ends of the list are disabled rather than
  // missing, so no row changes width as it travels.
  check(
    'every row can be reordered',
    occurrences(tree, 'aria-label="Move up"') === 4 &&
      occurrences(tree, 'aria-label="Move down"') === 4,
    `${occurrences(tree, 'aria-label="Move up"')} up, ${occurrences(tree, 'aria-label="Move down"')} down`
  )
  check(
    'the top row cannot go up',
    occurrences(tree, 'Already at the top') === 1,
    `${occurrences(tree, 'Already at the top')}`
  )
  check(
    'and the bottom row cannot go down',
    occurrences(tree, 'Already at the bottom') === 1,
    `${occurrences(tree, 'Already at the bottom')}`
  )
  check(
    'both ends are disabled, not hidden',
    occurrences(tree, 'disabled=""') === 2,
    `${occurrences(tree, 'disabled=""')} disabled`
  )
  shows('and the row number says what it is for', tree, 'title="Priority 1 of 4"')
}

{
  // The tools live in the bar across the top, not in the console: they are how
  // you work rather than what you have built, and the two are kept apart.
  const bar = markupOf('NavBar', NavBar)
  shows('the bar carries the snap tool', bar, '>Snap<')
  shows('and the cut tool', bar, '>Cut<')
  shows('and the export tool', bar, '>Export<')
  shows('and the help button', bar, '>Help<')
  // Export is docked at the right, with the two other acts on the whole
  // document -- and its formats are behind its menu rather than spread across
  // the bar. Checked on the bar itself, since where a control SITS is the half
  // of this that the tool's own markup cannot show.
  const right = bar.slice(bar.indexOf('topbar-right'))
  shows('docked on the right', right, '>Export<')
  check(
    'to the left of undo and redo',
    right.indexOf('>Export<') < right.indexOf('>Undo<'),
    `${right.indexOf('>Export<')} vs ${right.indexOf('>Undo<')}`
  )
  hides('with the formats behind its menu', bar, '>.glb<')

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
  // Export is docked at the right of the bar now, and its formats are behind a
  // menu: four extensions were a row of jargon charging permanent width for a
  // choice made once a session. Closed, the bar carries the tool and nothing
  // else -- which is the whole point of the change, so it is checked first.
  tools().setOpenPanel(null)
  const shut = markupOf('ExportTools (menu shut)', ExportTools)
  shows('the tool is in the bar', shut, '>Export<')
  for (const ext of ['>.glb<', '>.obj<', '>.stl<', '>.step<']) {
    hides(`and ${ext} is not spread across it`, shut, ext)
  }
  // The tool carries no hover bubble of its own. It had one -- the caveat that
  // was once a permanent line under the buttons -- and it was removed on
  // purpose: the panel it hung over already names every format on its own row,
  // so the bubble was prose in the way of the choice it described. Pinned as a
  // `hides` rather than left unsaid, because `tip` is a prop any nav tool can
  // take and nothing else would notice it coming back.
  hides('and no hover bubble hangs off it', shut, 'nav-tip')

  // Opened the way a click opens it: which panel is open is a store field, so a
  // headless render drives the menu exactly as a pointer does.
  tools().setOpenPanel('export')
  const panel = markupOf('ExportTools (menu open)', ExportTools)
  shows('GLB is offered', panel, '>.glb<')
  shows('OBJ is offered', panel, '>.obj<')
  shows('STL is offered', panel, '>.stl<')
  shows('STEP is offered', panel, '>.step<')
  // Every row has to say what it is FOR. An extension alone tells nobody which
  // of the four to reach for, and the row has the width the bar never had.
  shows('and STL says what it is for', panel, '3D printing standard')
  shows('as does STEP', panel, 'CAD interchange')
  // The gist is taken from the blurb rather than written out again beside it,
  // so a format has one description and the row cannot fall out of step with
  // the hover text. Both are in the markup, from the one string.
  shows('the row keeps the whole blurb on hover', panel, 'title="Plain text geometry. Universally readable')
  shows('and shows its first sentence in the row', panel, '>Plain text geometry<')
  tools().setOpenPanel(null)
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
  // An empty shelf is still the shelf. Three dashed slots stand where the tiles
  // will go, in the same row, so saving the first object FILLS one instead of
  // swapping a paragraph out for a panel -- and the panel has one shape rather
  // than two, only one of which anyone ever tunes.
  const saved = [...library().customs]
  for (const custom of saved) library().removeCustom(custom.id)

  const bare = markupOf('ClipboardPanel (empty)', ClipboardPanel)
  shows('an empty shelf is still a shelf', bare, 'custom-grid')
  check(
    'with a slot where each tile will go',
    occurrences(bare, 'custom-slot') === 3,
    `${occurrences(bare, 'custom-slot')} slots`
  )
  hides('and no paragraph standing in for it', bare, 'class="empty"')
  hides('nor a tile that is not there', bare, 'custom-grab')
  // A list that can be empty can say it is: the count reads zero rather than
  // vanishing, which is the same reading the slots give.
  shows('the count reads zero', bare, '>0<')
  // Nothing for a screen reader to trip over -- three unlabelled somethings
  // read out is worse than an empty shelf read out as empty.
  check(
    'and the slots are hidden from a reader',
    occurrences(bare, 'aria-hidden="true"') >= 3,
    `${occurrences(bare, 'aria-hidden="true"')}`
  )
  // What the dashed squares are for is under the pointer, as well as in the
  // panel's own tip.
  shows('while saying what would fill them', bare, 'Save as custom object')

  for (const custom of saved) library().saveCustom(custom.object)
  check('and the shelf comes back', library().customs.length === saved.length, `${library().customs.length}`)
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

// --- what the console holds, and what the viewport holds --------------------
console.log('\nThe console keeps the scene; the selection rides the viewport')
{
  // The split is by what a control is FOR. The console holds what is true of
  // the scene whatever is selected, and every one of those works with nothing
  // selected at all. What only means anything once something IS selected went
  // to the panel in the corner of the viewport, where the thing being described
  // can be watched while the number is dragged.
  //
  // Both lists are checked whole and against BOTH places, so a panel that
  // quietly lands on the wrong side -- or in neither -- fails here.
  const SCENE = ['>Clipboard<', '>Solids<', '>Shapes<', '>Color<', '>Scene<']
  const SELECTION = ['>Position &amp; Rotation<', '>Dimensions<', '>Sketch<']

  const id = doc().addObject(defaultBaseFor('box'), [0, 0, 0])
  doc().selectObject(id)

  const console_ = markupOf('Console', Console)
  for (const panel of SCENE) shows(`the console carries ${panel}`, console_, panel)
  for (const panel of SELECTION) hides(`and no longer ${panel}`, console_, panel)
  // The strip is gone with the tab it switched to. One column, all of it live.
  hides('and the tab strip went with them', console_, 'console-tab')

  const hud = markupOf('SelectionHud (object)', SelectionHud)
  shows('the viewport panel is in', hud, 'selection-hud-in')
  shows('carrying Position & Rotation', hud, '>Position &amp; Rotation<')
  shows('and Dimensions', hud, '>Dimensions<')
  // The rule the panel is built on: a sketch panel under every selection was
  // three quarters of its height saying nothing. Selecting the solid a sketch
  // sits on is not selecting the sketch.
  hides('but not the sketch controls, with no sketch selected', hud, '>Sketch<')
  hides('nor any panel apologising for an empty selection', hud, 'Nothing selected')

  doc().startPlacing(defaultShape('circle'))
  doc().updatePlacing(id, { on: 'box-face', face: 2, u: 0, v: 0 })
  doc().commitPlacing()
  const withSketch = markupOf('SelectionHud (sketch)', SelectionHud)
  shows('selecting a sketch brings the sketch controls in', withSketch, '>Sketch<')
  shows('beside the placement it still has', withSketch, '>Position &amp; Rotation<')

  // Nothing aimed, nothing shown -- and nothing mounted either, so the panel
  // slides out empty rather than carrying a stale reading off the screen.
  doc().selectObject(null)
  const empty = markupOf('SelectionHud (idle)', SelectionHud)
  hides('with nothing selected the panel is out', empty, 'selection-hud-in')
  for (const panel of SELECTION) hides(`and holds no ${panel}`, empty, panel)

  // An armed cut plane is a thing being aimed, so the panel answers it: the
  // plane has a placement like any other and no panel of its own.
  tools().setCutActive(true)
  const cut = markupOf('SelectionHud (cut armed)', SelectionHud)
  shows('arming the cut tool brings it back', cut, 'selection-hud-in')
  shows('for the plane', cut, '>cut plane<')
  // But a plane has no extent of its own to change.
  hides('without offering dimensions it does not have', cut, '>Dimensions<')
  tools().setCutActive(false)

  doc().removeObject(id)
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

  // 7. What a merge does to two colours.
  //
  // Nothing, is the answer -- and it always did keep both in the document. What
  // used to be lost was on the way to the screen: the union is one mesh, and
  // one mesh wore one colour. Now every solid in an assembly is drawn in its
  // own, so these two fields are the ones the viewport reads. See `ObjectEval`.
  //
  // Last, and on solids of its own, because it consumes one object into another
  // and repaints both -- run any earlier it would be quietly rewriting the
  // scene the checks above are reading.
  const host = dragIn(defaultBaseFor('box'), -6, 3)
  const guest = dragIn(defaultBaseFor('sphere'), -3, 3)
  doc().setObjectColor([host], '#cc2222')
  doc().setObjectColor([guest], '#2244cc')
  doc().selectObjects([host, guest])
  doc().mergeObjects([host, guest])
  const assembly = () => doc().doc.objects.find((o) => o.id === host)
  check('a merge keeps the host colour', assembly()?.color === '#cc2222', String(assembly()?.color))
  check(
    'and the solid it absorbed keeps its own',
    assembly()?.parts[0]?.color === '#2244cc',
    String(assembly()?.parts[0]?.color)
  )

  // The other half of the bargain: Apply aimed at an assembly has to reach all
  // the way down. Painting only the host would repaint a fraction of what the
  // user had selected, and the rest would sit there in the colour it came in.
  doc().setObjectColor([host], '#33aa66')
  check('Apply on an assembly paints the host', assembly()?.color === '#33aa66')
  check('and every part inside it', assembly()?.parts[0]?.color === '#33aa66')
  const whole = doc().past.length
  doc().setObjectColor([host], '#33aa66')
  check('re-applying it costs no undo step either', doc().past.length === whole)

  // What the viewport looks a paint key up in.
  const palette = assemblyColors(assembly() as SceneObject)
  check('every solid in the assembly has a colour to look up', palette.size === 2, `${palette.size}`)
  check(
    'and an id that is not one of theirs has none',
    !palette.has(c),
    [...palette.keys()].join(',')
  )

  for (const id of [a, b, c, host]) doc().removeObject(id)
}


{
  // 8. The scene tree is a priority order.
  //
  // Two objects that overlap and are then severed by ONE cut plane end up with
  // cut faces that are coplanar and overlapping. The depth buffer has no
  // tiebreak for that -- the shared face tears into a stipple of both colours,
  // deciding pixel by pixel on rounding alone. It was always so; it simply
  // could not be seen while every solid was the same grey. Geometry cannot say
  // which should win, because both are equally there, so the list says it.
  resetEvaluator()
  doc().reset()
  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)

  const lower = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1, 0])
  const upper = doc().addObject({ kind: 'sphere', radius: 1.2 }, [1, 1, 0])
  const order = () => doc().doc.objects.map((o) => o.id).join(',')

  check('a new object lands at the bottom', order() === `${lower},${upper}`, order())
  doc().moveObject(upper, -1)
  check('and an arrow lifts it over the one above', order() === `${upper},${lower}`, order())
  doc().undo()
  check('undo puts the order back', order() === `${lower},${upper}`, order())
  doc().redo()
  check('and redo lifts it again', order() === `${upper},${lower}`, order())

  // The button is easy to press at the end of the list, and a move that moves
  // nothing must not bury the edit before it under an empty history entry.
  const settled = doc().past.length
  doc().moveObject(upper, -1)
  check('moving past the top does nothing', order() === `${upper},${lower}`, order())
  check('and costs no undo step', doc().past.length === settled, `${doc().past.length - settled}`)
  doc().moveObject(lower, 1)
  check('nor does moving past the bottom', doc().past.length === settled)
  doc().moveObject('no-such-object', -1)
  check('nor does moving something that is not there', doc().past.length === settled)

  // A move is a move of ONE row, so the rest keep their order among themselves.
  const third = doc().addObject({ kind: 'box', size: [1, 1, 1] }, [4, 1, 0])
  doc().moveObject(third, -2)
  check('a two-step move lands two rows up', order() === `${third},${upper},${lower}`, order())
  doc().moveObject(third, 9)
  check('and an overshoot stops at the end rather than wrapping', order() === `${upper},${lower},${third}`, order())

  // 9. What the order does to the picture.
  //
  // A depth nudge, not a draw-order swap: `renderOrder` decides which mesh is
  // submitted first, and for opaque geometry the depth test then throws that
  // away and the tie comes straight back. Only an offset settles it.
  const top = depthBias(0, 3)
  const middle = depthBias(1, 3)
  const bottom = depthBias(2, 3)
  check(
    'the top row is pulled furthest forward',
    top.polygonOffsetUnits < middle.polygonOffsetUnits &&
      middle.polygonOffsetUnits < bottom.polygonOffsetUnits,
    `${top.polygonOffsetUnits}, ${middle.polygonOffsetUnits}, ${bottom.polygonOffsetUnits}`
  )
  check('and the offset is negative -- toward the camera', top.polygonOffsetUnits < 0)
  check(
    'units carries it, since coplanar faces share a slope',
    Math.abs(top.polygonOffsetUnits) >= 1,
    `${top.polygonOffsetUnits}`
  )
  check('the bottom row is left exactly alone', bottom.polygonOffsetUnits === 0)
  check('and does not even turn the offset on', bottom.polygonOffset === false)
  const only = depthBias(0, 1)
  check(
    'a scene of one object carries the material it always did',
    only.polygonOffset === false && only.polygonOffsetUnits === 0,
    `${only.polygonOffsetUnits}`
  )

  for (const id of [lower, upper, third]) doc().removeObject(id)
}

// --- dragging a number box --------------------------------------------------
console.log('\nA number box is dragged sideways, and typed into on a double click')
{
  // What a pixel is worth. Never less than one step -- the smallest change the
  // control can make at all -- and otherwise the range over the span, so a
  // finely-stepped field does not need a drag across two monitors.
  near('a position moves a step a pixel', scrubRate(-8, 8, 0.05), 0.05, 1e-12)
  near('and a rotation a degree', scrubRate(-180, 180, 1), 1, 1e-12)
  // A dimension is stepped in hundredths over eight units, which at a step a
  // pixel would be an 800px drag. Here the range decides instead.
  near('a wide, finely-stepped range spreads over the span', scrubRate(0.1, 8, 0.01), 7.9 / SCRUB_SPAN, 1e-12)
  check('and the span is longer than the slider beside it', SCRUB_SPAN > 130, `${SCRUB_SPAN}`)
  check('while the slop is a few pixels at most', SCRUB_SLOP > 0 && SCRUB_SLOP <= 5, `${SCRUB_SLOP}`)

  // The reading itself.
  near('a press that goes nowhere changes nothing', scrubbed(1.25, 0, -8, 8, 0.05), 1.25, 1e-12)
  near('twenty pixels is a unit of position', scrubbed(1, 20, -8, 8, 0.05), 2, 1e-12)
  near('and it runs backwards too', scrubbed(1, -20, -8, 8, 0.05), 0, 1e-12)
  near('ninety pixels is a right angle', scrubbed(0, 90, -180, 180, 1), 90, 1e-12)

  // Snapped to the step, so a dragged number is one that could have been typed.
  const landed = scrubbed(0, 7, -8, 8, 0.05)
  near('a drag lands on the step', Math.round(landed / 0.05) * 0.05, landed, 1e-12)
  check('with no floating-point tail on it', String(landed).length <= 5, String(landed))

  // Clamped at both ends...
  near('a drag past the top stops there', scrubbed(7, 400, -8, 8, 0.05), 8, 1e-12)
  near('and past the bottom likewise', scrubbed(-7, -400, -8, 8, 0.05), -8, 1e-12)

  // ...and this is the reason the value is measured from the PRESS rather than
  // folded into the running one. Dragging 400px past the ceiling and coming
  // back 100 must arrive 100 pixels below it. Accumulated instead, everything
  // the clamp swallowed would be lost and the value would come back short.
  // A press at 7 hits the ceiling twenty pixels out and stays there for the
  // next 280. Read again at ten pixels, it is 7.5 -- the travel from the press,
  // not the travel since the last frame. Accumulated instead, the 280 pixels
  // the clamp swallowed would have to be paid back before the value moved at
  // all, and the number would hang at its limit long after the pointer left.
  near('a long drag past the top holds at the top', scrubbed(7, 300, -8, 8, 0.05), 8, 1e-12)
  near('and coming back reads the travel, not what the clamp swallowed', scrubbed(7, 10, -8, 8, 0.05), 7.5, 1e-12)

  // And the box itself says which mode it is in. Read-only is the scrub: a
  // caret taken on every press would swallow the first drag of every gesture.
  const id = doc().addObject(defaultBaseFor('box'), [0, 0, 0])
  doc().selectObject(id)
  const hud = markupOf('SelectionHud (scrub boxes)', SelectionHud)
  // Lower-cased first: React 19 writes the attribute in the case the PROP has,
  // `readOnly=""`, and HTML parses attribute names case-insensitively -- so the
  // box is genuinely read-only in a browser, and a check spelling it the HTML
  // way would fail on markup that is perfectly correct.
  const boxes = hud.toLowerCase()
  check(
    'every number box is a scrub at rest',
    occurrences(boxes, 'readonly=""') === occurrences(boxes, 'type="number"'),
    `${occurrences(boxes, 'readonly=""')} of ${occurrences(boxes, 'type="number"')}`
  )
  shows('and says so on hover', hud, 'title="Drag to change, double-click to type"')
  // The attributes the sliders and the checks above both read are untouched by
  // any of it.
  shows('while keeping the bounds it always carried', hud, 'min="-8" max="8" step="0.05"')
  doc().removeObject(id)
}


{
  // 10. The eraser: a solid dragged in to take material away.
  //
  // It is a whole SceneObject and not a mode on some tool, so everything after
  // the drop -- moving, turning, resizing, snapping, the Position panel -- is
  // the code that was already there. What is new is the flag, the ghost, and
  // the one-way act that spends it.
  resetEvaluator()
  doc().reset()
  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)

  // The grip on a Solids row starts the same gesture as the row, with a flag.
  doc().startPlacingSolid({ kind: 'cylinder', radius: 0.4, height: 4 }, true)
  const dragged = doc().drag
  check(
    'the grip drags an eraser rather than a solid',
    dragged.kind === 'placing-solid' && dragged.template.erase === true,
    dragged.kind
  )
  check(
    'and it says so in its name',
    dragged.kind === 'placing-solid' && dragged.template.name.endsWith('eraser'),
    dragged.kind === 'placing-solid' ? dragged.template.name : ''
  )
  doc().updatePlacingSolid(null)
  doc().commitPlacingSolid()
  check('released off the canvas it lands nowhere', doc().doc.objects.length === 0)

  const block = dragIn(defaultBaseFor('box'), 0, 0)
  const clear = dragIn(defaultBaseFor('box'), 6, 0)
  doc().startPlacingSolid({ kind: 'cylinder', radius: 0.4, height: 6 }, true)
  doc().updatePlacingSolid(grounded({ kind: 'cylinder', radius: 0.4, height: 6 }, 0, 0))
  doc().commitPlacingSolid()
  const eraser = primarySelection(useDoc.getState()) ?? ''
  const objectOf = (id: string) => doc().doc.objects.find((o) => o.id === id)

  check('dropped, it is an object like any other', objectOf(eraser)?.erase === true)
  check('and it is the selection, so the panel is aimed at it', doc().selectedObjectIds[0] === eraser)
  // Moving it is the ordinary path, which is the whole point of it being an
  // object: no second set of controls to keep in step with the first.
  doc().setObjectTransform(eraser, { position: [0, 1, 0], rotation: [0, 0, 0] })
  check('it moves like anything else', objectOf(eraser)?.transform.position[1] === 1)

  const volumeOf = (id: string) => {
    const object = objectOf(id)
    if (!object) return 0
    const { geometry } = evaluateObject(object)
    const volume = signedVolume(geometry)
    geometry.dispose()
    return volume
  }
  const before = volumeOf(block)

  // Confirming is ONE step and one history entry: the holes and the eraser
  // leaving together, so a single undo puts it back where it was aimed.
  const settled = doc().past.length
  const cut = doc().applyErase(eraser, doc().doc.objects.map((o) => o.id))
  check('it erases from what it overlaps', cut === 1, `${cut}`)
  check('and only from that', objectOf(clear)?.erased === undefined)
  check('the eraser is spent', objectOf(eraser) === undefined)
  check('the block lost material', volumeOf(block) < before - 0.5, `${volumeOf(block).toFixed(3)}`)
  check('the hole is kept on the object it cut', objectOf(block)?.erased?.length === 1)
  check('one undo step for the whole act', doc().past.length === settled + 1)

  doc().undo()
  check('undo brings the eraser back', objectOf(eraser)?.erase === true)
  check('and the block whole with it', Math.abs(volumeOf(block) - before) < 1e-9)

  // Scope, as the switch drives it: the panel hands `applyErase` the candidate
  // list, so "selected only" is a shorter list rather than a second code path.
  const narrowed = doc().applyErase(eraser, [clear])
  check('a target list it does not overlap erases nothing', narrowed === 0, `${narrowed}`)
  check('and leaves the eraser standing', objectOf(eraser)?.erase === true)

  // An eraser is a tool, not a part: welding one into a solid would make the
  // hole permanent in the worst possible way, as material.
  doc().selectObject(block)
  doc().toggleObjectSelection(eraser)
  check('merging refuses to weld an eraser in', doc().mergeObjects(doc().selectedObjectIds) === 0)

  doc().removeObject(eraser)
  for (const id of [block, clear]) doc().removeObject(id)
}

{
  // 11. The two drag sources on a Solids row.
  const rows = markupOf('SolidList', SolidList)
  const pyramid = rows.split('<div class="solid-item"').find((r) => r.includes('Square pyramid')) ?? ''
  const sphere = rows.split('<div class="solid-item"').find((r) => r.includes('>Sphere<')) ?? ''

  // The side count is chosen by sweeping across the row now -- invisible bands,
  // the way the polygon chip in Shapes has always worked -- which is what freed
  // the right end of the row for the eraser grip.
  check(
    'a sided row splits into one band per count',
    occurrences(pyramid, 'class="solid-band"') === 5,
    `${occurrences(pyramid, 'class="solid-band"')} bands`
  )
  shows('and every band names its polygon', pyramid, 'aria-label="Pentagonal pyramid"')
  // Invisible is fine for the bands; a row that gave no sign at all that a
  // choice existed would not be. The ticks are that sign, and the readout.
  check(
    'with a tick per count to say the choice is there',
    occurrences(pyramid, 'class="solid-tick') === 5,
    `${occurrences(pyramid, 'class="solid-tick')} ticks`
  )
  check(
    'exactly one of them lit',
    occurrences(pyramid, 'solid-tick solid-tick-on') === 1,
    `${occurrences(pyramid, 'solid-tick solid-tick-on')} lit`
  )
  check(
    'a row with no side count has no bands',
    occurrences(sphere, 'class="solid-band"') === 0,
    `${occurrences(sphere, 'class="solid-band"')}`
  )

  // Every row carries the grip, sided or not -- a box eraser is the one you
  // reach for most.
  check(
    'every row carries an eraser grip',
    occurrences(rows, 'class="solid-erase"') === occurrences(rows, '<div class="solid-item"'),
    `${occurrences(rows, 'class="solid-erase"')} grips`
  )
  shows('and it says what it places', sphere, 'Sphere eraser, drag into the scene')
  shows('and that nothing happens until it is confirmed', sphere, 'until you confirm')
}

{
  // 12. Confirming, at the top of the panel that aims it.
  resetEvaluator()
  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)
  const solid = dragIn(defaultBaseFor('box'), 0, 0)

  doc().selectObject(solid)
  hides('an ordinary solid gets no subtract block', markupOf('PlacementPanel (solid)', PlacementPanel), 'Subtract mode')

  doc().startPlacingSolid(defaultBaseFor('sphere'), true)
  doc().updatePlacingSolid(grounded(defaultBaseFor('sphere'), 0, 0))
  doc().commitPlacingSolid()
  const eraser = primarySelection(useDoc.getState()) ?? ''

  const panel = markupOf('PlacementPanel (eraser)', PlacementPanel)
  shows('an eraser gets one', panel, 'Subtract mode')
  // Above the rows, so the panel reads in the order the gesture runs: aim it,
  // then take it.
  check(
    'above the position rows, not below them',
    panel.indexOf('Subtract mode') < panel.indexOf('vec3-axis'),
    ''
  )
  shows('with the switch the scope lives on', panel, 'aria-label="What this eraser cuts"')
  shows('offering every object', panel, '>Every object<')
  shows('and the selection alone', panel, '>Selected only<')
  check(
    'exactly one of the two engaged',
    occurrences(panel, 'seg-btn seg-active') === 1,
    `${occurrences(panel, 'seg-btn seg-active')}`
  )
  shows('a confirm', panel, 'erase-confirm')
  shows('and a way out that cuts nothing', panel, 'erase-discard')
  // The switch is a tool preference, not a document field: it must survive the
  // panel unmounting and stay out of undo, like the snap distance.
  tools().setEraseScope('selected')
  const narrowed = markupOf('PlacementPanel (selected only)', PlacementPanel)
  // Nothing is picked out alongside it yet, so there is nothing to subtract
  // from and the button says so rather than doing nothing when pressed.
  shows('narrowed with nothing picked, it stands down', narrowed, 'Shift-click the objects to erase from')
  shows('and names the count it would cut', narrowed, 'Subtract from 0')
  doc().toggleObjectSelection(solid)
  shows(
    'shift-clicking a solid gives it something to cut',
    markupOf('PlacementPanel (one picked)', PlacementPanel),
    'Subtract from 1'
  )
  tools().setEraseScope('all')

  // The tree says which row is the ghost.
  shows('the scene tree marks the eraser', markupOf('SceneTree (eraser)', SceneTree), '>erase<')

  for (const o of [...doc().doc.objects]) doc().removeObject(o.id)
  void eraser
}

console.log(
  failures === 0
    ? '\nAll console checks passed.\n'
    : `\n${failures} console check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
