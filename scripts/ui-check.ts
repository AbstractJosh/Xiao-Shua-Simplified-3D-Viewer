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

import { ExportPanel } from '../src/console/ExportPanel'
import { Inspector } from '../src/console/Inspector'
import { ObjectPanel } from '../src/console/ObjectPanel'
import { SceneTree } from '../src/console/SceneTree'
import { ShapePalette } from '../src/console/ShapePalette'
import { SolidPalette } from '../src/console/SolidPalette'
import { SOLID_TEMPLATES } from '../src/console/solidIcons'
import { ToolsPanel } from '../src/console/ToolsPanel'
import { evaluateDoc, resetEvaluator } from '../src/geometry/evaluate'
import { surfaceFor } from '../src/geometry/surfaces'
import { defaultBaseFor, defaultShape } from '../src/geometry/types'
import type { BaseSolid, Shape2D, SurfaceAnchor } from '../src/geometry/types'
import { signedVolume } from '../src/geometry/volume'
import { useDoc } from '../src/store/docStore'
import { useEvalStatus } from '../src/store/evalStore'
import { cutPlaneNormal, useTools } from '../src/store/toolStore'

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
function occurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1
}

const doc = () => useDoc.getState()
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
  return doc().selectedObjectId ?? ''
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
  check('the last one placed is the one selected', doc().selectedObjectId === sphereId)

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
  shows('Position is shown', panel, '>Position<')
  shows('the X box carries the drop position', panel, 'min="-8" max="8" step="0.05" value="2.5"')
  shows('and the Z box the other axis', panel, 'min="-8" max="8" step="0.05" value="-1.25"')
  shows('Rotation is shown', panel, '>Rotation<')
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
  const panel = markupOf('ToolsPanel', ToolsPanel)
  shows('it has a Snapping group', panel, '>Snapping<')
  shows('snap is on by default', panel, 'aria-checked="true"')
  shows('with a distance field', panel, '>Distance<')
  shows('it has a Cut group', panel, '>Cut<')
  shows('with the plane toggle', panel, '>Cut plane<')
  hides('and no plane controls until it is armed', panel, '>Guide size<')
}

{
  const panel = markupOf('SolidPalette', SolidPalette)
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
}

{
  const panel = markupOf('ShapePalette', ShapePalette)
  shows('it offers a circle', panel, '>Circle<')
  shows('it offers a rectangle', panel, '>Rectangle<')
  shows('and the polygon chip rests on its default', panel, '>Hexagon<')
}

{
  const panel = markupOf('ExportPanel', ExportPanel)
  shows('GLB is offered', panel, '>.glb<')
  shows('OBJ is offered', panel, '>.obj<')
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
check('the sketch landed on the cube', doc().selectedObjectId === cubeId)
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
  shows('the tree nests the sketch under its object', tree, 'Circle r0.30 - projection')
  shows('and counts it', tree, '>1f<')
}

doc().setOp(cubeId, featureId, 'extrude')
const docAfterExtrude = doc().doc
{
  const feature = doc().doc.objects.find((o) => o.id === cubeId)?.features[0]
  check('choosing Extrude gives the sketch a depth', (feature?.depth ?? 0) > 0, `${feature?.depth}`)

  const panel = markupOf('Inspector (extruded)', Inspector)
  hides('the inert notice is gone', panel, 'Projection only')
  shows('the End face group appears', panel, 'End face')
  shows('with an XYZ tilt', panel, '>Tilt<')
  shows('and an in-plane slide', panel, '>Slide<')
  shows('the slide axes are labelled U and V', panel, '>U<')
  shows('with a way back to square', panel, 'Reset face')
  shows('and the hint that the face is draggable too', panel, 'drag the end face itself')

  const tree = markupOf('SceneTree (extruded)', SceneTree)
  shows('the tree says extrude now', tree, 'Circle r0.30 - extrude 0.30')
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
  const panel = markupOf('ToolsPanel (armed)', ToolsPanel)
  shows('arming the tool reveals the plane controls', panel, '>Guide size<')
  // The size control sizes the drawn square, not the cut. `applyCut` uses an
  // unbounded plane, so a panel that let this read as an aiming control would
  // be promising a limit the geometry never honours.
  shows('and says the square does not limit the cut', panel, 'cut plane itself is unbounded')
  shows('with a position', panel, 'min="-6" max="6" step="0.05" value="-3"')
  shows('and a tilt', panel, '>Tilt<')
  shows('it says what it will cut', panel, 'Cuts the selected object')
  shows('and offers the button', panel, '>Cut</button>')
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

  const panel = markupOf('ToolsPanel (snap off)', ToolsPanel)
  shows('the panel shows snap off', panel, 'aria-checked="false"')
  shows('and greys out its distance field', panel, 'class="tool-group" disabled=""')
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

// --- 7. Every solid, every anchor -----------------------------------------
console.log('\n7. The two data-driven panels across every solid and anchor')

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
  { label: 'tetrahedron', base: defaultBaseFor('platonic', undefined, 'tetrahedron'), expect: '>Solid<' },
  { label: 'octahedron', base: defaultBaseFor('platonic', undefined, 'octahedron'), expect: '>Solid<' },
  { label: 'dodecahedron', base: defaultBaseFor('platonic', undefined, 'dodecahedron'), expect: '>Solid<' },
]

for (const { label, base, expect } of SOLIDS) {
  const id = doc().addObject(base, [0, 0, 0])
  doc().selectObject(id)
  const panel = markupOf(`ObjectPanel (${label})`, ObjectPanel)
  hides(`${label} is not the empty branch`, panel, 'Nothing selected')
  shows(`${label} offers its own dimensions`, panel, expect)
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

    doc().setOp(id, fid, 'extrude')
    const solid = markupOf(`Inspector (${label} / ${shape.label}, extruded)`, Inspector)
    shows(`extruding on a ${label} reveals the End face group`, solid, 'End face')
    shows(`with a tilt for the ${shape.label}`, solid, '>Tilt<')
    shows('and a slide', solid, '>Slide<')

    doc().removeObject(id)
  }
}

console.log(
  failures === 0
    ? '\nAll console checks passed.\n'
    : `\n${failures} console check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
