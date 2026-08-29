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
import { Box3, Matrix4, Quaternion, ShaderLib, Vector3 } from 'three'
import type { BufferGeometry, WebGLProgramParametersWithUniforms } from 'three'
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
import {
  CutActions,
  CutTool,
  ErodeTool,
  HelpTool,
  MirrorTool,
  MoveTool,
  RotateTool,
  ScaleTool,
  SculptTool,
  SnapTool,
  cutPlaneSpawn,
  rulerFrame,
} from '../src/console/NavTools'
import { ClipboardPanel, liveTiles } from '../src/console/ClipboardPanel'
import { VIEW, framingDistance } from '../src/console/ObjectThumbnail'
import { ObjectPanel } from '../src/console/ObjectPanel'
import { PlacementPanel } from '../src/console/PlacementPanel'
import { MergeButton, SceneTree } from '../src/console/SceneTree'
import { ShapePalette } from '../src/console/ShapePalette'
import { Console } from '../src/console/Console'
import { LatheConsole } from '../src/console/LatheConsole'
import { PullTool, PushTool } from '../src/console/LatheTools'
import { CopyPieceButton, PIECE_NAME } from '../src/viewport/CopyPieceButton'
import { StockPanel } from '../src/viewport/StockPanel'
import { fitToEnvelope } from '../src/geometry/importers'
import { registerMesh } from '../src/geometry/meshLibrary'
import { revolveClay } from '../src/geometry/revolve'
import {
  CLAY_FLARE,
  CLAY_RINGS,
  freshClay,
  isFresh,
  mold,
  widestRadius,
} from '../src/geometry/clay'
import { useLathe } from '../src/store/latheStore'
import {
  clayFrame,
  pointerToClay,
  silhouette,
  turningRings,
} from '../src/viewport/latheView'
import { SCREENS, SCREEN_LABELS } from '../src/screens'
import { SelectionHud } from '../src/viewport/SelectionHud'
import { ToolIsland } from '../src/viewport/ToolIsland'
import {
  SCRUB_SLOP,
  SCRUB_SPAN,
  scrubRate,
  scrubTravel,
  scrubbed,
  trackWindow,
} from '../src/console/scrub'
import { ColorPanel } from '../src/console/ColorPanel'
import type { Hsv } from '../src/color'
import { hexToHsv, hsvToHex, hueAt, lighten, parseHex, wheelHue } from '../src/color'
import { assemblyColors } from '../src/geometry/assembly'
import { bodyPaint } from '../src/viewport/SceneObjects'
import {
  BIAS_ANCHOR,
  BIAS_STEP,
  BIAS_UNIFORM,
  BiasedStandardMaterial,
  depthBias,
  withDepthBias,
} from '../src/viewport/depthBias'
import { MarqueeRect } from '../src/viewport/SelectionMarquee'
import { MARQUEE_SLOP, useMarquee } from '../src/viewport/marquee'
import { SolidList, SolidPalette } from '../src/console/SolidPalette'
import { NGON_LABEL } from '../src/console/ngon'
import { SOLID_TEMPLATES, restingSides } from '../src/console/solidIcons'
import { SOLID_SIDES } from '../src/console/solidMorph'
import { UNIT_MODES, fromDisplay, resolveUnit, stepIn, toDisplay } from '../src/units'
import {
  MAX_FACE_OFFSET,
  MAX_SIZE,
  MIN_DIMENSION,
  maxShapeSize,
  resizeAlongAxis,
  scaleShape,
  scaleUniform,
} from '../src/geometry/dimensions'
import { evaluateDoc, evaluateObject, resetEvaluator } from '../src/geometry/evaluate'
import { AXIS_COLORS, AXIS_CSS_VARS } from '../src/viewport/axisColors'
import { COMPASS_FACE_SHADE, SCENE_CSS_VARS, SCENE_THEMES } from '../src/viewport/sceneColors'
import { DEFAULT_THEME, THEMES, THEME_LABELS } from '../src/theme'
import type { Theme } from '../src/theme'
import { HelpScreen } from '../src/console/HelpScreen'
import { DEFAULT_HELP_SECTION, HELP_SECTIONS } from '../src/helpTopics'
import { objectMatrix } from '../src/geometry/transform'
import {
  assemblyAnchor,
  assemblyCentre,
  assemblyExtent,
  objectBounds,
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
import type { BaseSolid, Doc, SceneObject, Shape2D, SurfaceAnchor, Vec3 } from '../src/geometry/types'
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
  CUT_POSITION_LIMIT,
  CUT_SIZE_MAX,
  DEFAULT_CUT_PLANE,
  DEFAULT_BRUSH_FORCE,
  DEFAULT_BRUSH_RADIUS,
  DEFAULT_BRUSH_SMOOTH,
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  BRUSH_SMOOTH_MIN,
  ISLAND_MARGIN,
  ISLAND_SNAP,
  RECENT_COLOR_SLOTS,
  RULER_LENGTH,
  cutPlaneNormal,
  dockIsland,
  rulerLength,
  rulerSpawn,
  useTools,
} from '../src/store/toolStore'
import { RulerReadouts, stripeFraction } from '../src/viewport/Rulers'
import { BrushScopePanel } from '../src/viewport/BrushScopePanel'
import { bodyCanBeDragged, selectionWearsGizmo } from '../src/viewport/SceneObjects'
import { brushAllows } from '../src/viewport/brushTarget'
import { viewQuaternion } from '../src/viewport/compassViews'
import {
  GRID_BODY,
  GRID_CLIP,
  GRID_MAIN,
  withLogDepth,
} from '../src/viewport/GuideGrid'
import { formatLength } from '../src/units'

/**
 * Panels render lengths in whatever unit the tool island is set to, so the
 * markup checks below pin one. `cm` rather than the shipped `auto`, because
 * `auto` picks per value and an assertion would have to re-derive the choice to
 * state its own expectation -- at which point it is testing the derivation
 * against itself. `auto` gets its own section, further down, where the choosing
 * IS the subject.
 */
useTools.setState({ displayUnit: 'cm' })
const SHOWN = 'cm' as const
const inShown = (u: number) => toDisplay(u, SHOWN)

/** The attribute run every position box renders. Built from the constant the
 *  panel itself reads and converted the way the panel converts, so these checks
 *  keep testing the real bound instead of a number the app stopped using. */
const posBounds = `min="-${inShown(MAX_SIZE)}" max="${inShown(MAX_SIZE)}" step="${stepIn(0.05, SHOWN)}"`

/** The attribute run a windowed TRACK renders for a value, in scene units in
 *  and display units out. Computed with the same function the component uses,
 *  so the check states the rule rather than a transcript of one result. */
function trackOf(value: number, limit = MAX_SIZE, sceneStep = 0.05): string {
  const step = stepIn(sceneStep, SHOWN)
  const w = trackWindow(inShown(value), inShown(-limit), inShown(limit), step)
  return `min="${w.lo}" max="${w.hi}" step="${step}" value="${inShown(value)}"`
}

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

/** The unit a rendered panel says it is written in, off its header badge. */
function badgeIn(markup: string): string {
  return markup.match(/class="section-unit"[^>]*>([^<]+)</)?.[1] ?? ''
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
const lathe = () => useLathe.getState()
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
  // Bounds INTERPOLATED, never spelled out: these are the panel's own limits,
  // and a literal here silently stops testing the thing it names the moment
  // the envelope moves.
  // The TRACK shows a window around the value now, not the whole range -- a
  // hundred units across 130 pixels was eight centimetres a pixel. The window
  // is what these pin; the box beside it still offers the full range, checked
  // just below.
  shows('the X track is windowed on the drop position', placed, trackOf(2.5))
  shows('and the Z track on the other axis', placed, trackOf(-1.25))
  shows('while the box still reaches the whole range', placed, `type="number" ${posBounds}`)
  shows('Rotation is shown', placed, '>Rotation<')
  // Placement is ONE panel for both things that have one. With nothing armed it
  // is describing the object.
  shows('and it says what it is describing', placed, '>object<')
  shows('dimensions are shown', panel, '>Dimensions<')
  shows('a pyramid offers a side count', panel, '>Sides<')
  shows('and the current count is the active chip', panel, 'class="seg-btn seg-active">3<')
  shows('the object can be deleted from here', panel, 'Delete object')

  // THE UNIT IS SAID ONCE, in the corner of the header, and no row repeats it.
  // Under every row it was the same word six times over -- and in the viewport
  // panel, where a row is one line of a grid and the suffix has no column of
  // its own, six extra lines of height for it.
  check('the placement panel wears its unit', badgeIn(placed) === SHOWN, badgeIn(placed))
  hides('and no axis row repeats it', placed, 'class="vec3-unit"')
  check('the dimensions panel wears its own', badgeIn(panel) === SHOWN, badgeIn(panel))
  hides('and no dimension row repeats it', panel, 'class="field-unit"')
  // A control that is not a length is untouched by any of this: a rotation is
  // degrees whatever the island is set to, and never wore a unit here anyway.
  shows('rotation is still in the panel beside them', placed, '>Rotation<')
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
  // The tools live outside the console: they are how you work rather than what
  // you have built. Which of the two surfaces a tool sits on is decided by what
  // it is aimed at -- the scene, or the whole document.
  const bar = markupOf('NavBar', NavBar)
  shows('the bar carries the export tool', bar, '>Export<')
  shows('and the import tool', bar, '>Import<')
  shows('and the help button', bar, '>Help<')
  // Snap is here, beside Units: it draws nothing and changes no handle, it is
  // a rule EVERY drag obeys, which is what this cluster has in common. Cut is
  // aimed at a solid you are looking at and went the other way, onto the scene.
  // Both asserted, because a control in two places is a control with two states
  // to keep in step.
  shows('and the snap tool', bar, '>Snap<')
  hides('but not the cut tool', bar, '>Cut<')
  hides('nor any of the gizmo tools', bar, '>Rotate<')
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
  // Snap is docked against Units, not merely somewhere in the bar: the two are
  // the switches that apply to everything rather than to a selection, and a
  // switch parked between Undo and Help would read as a fourth act on the
  // document.
  check(
    'and snap docks against the unit selector',
    right.indexOf('>Units<') < right.indexOf('>Snap<') &&
      right.indexOf('>Snap<') < right.indexOf('>Undo<'),
    `units ${right.indexOf('>Units<')}, snap ${right.indexOf('>Snap<')}, undo ${right.indexOf('>Undo<')}`
  )
  hides('with the formats behind its menu', bar, '>.glb<')

  // Import used to sit in the brand slot on the LEFT, where the tagline had
  // been. It is back with Export now: the left of the bar belongs to the screen
  // tabs, and the two file controls are one act in opposite directions.
  const left = bar.slice(0, bar.indexOf('topbar-right'))
  shows('the wordmark names the app', left, "Xiao Shua&#x27;s 3D Editor")
  hides('where the tagline no longer does', bar, 'brand-sub')
  // Import left the wordmark's side for Export's, which is where the pair of
  // doors belongs -- and it left because the screen tabs now claim the left of
  // the bar. Both halves are pinned: gone from one side, arrived on the other.
  hides('Import no longer stands beside the name', left, '>Import<')
  shows('it stands with the tools on the right', right, '>Import<')
  check(
    'immediately left of Export, which is the pair it belongs to',
    right.indexOf('>Import<') < right.indexOf('>Export<'),
    `import ${right.indexOf('>Import<')}, export ${right.indexOf('>Export<')}`
  )
  // It offers back exactly what Export writes, .stp included -- the same file
  // under its other extension.
  for (const ext of ['.glb', '.obj', '.stl', '.step', '.stp']) {
    shows(`it accepts ${ext}`, right, ext)
  }

  // Two invariants that markup cannot show and that both, when broken, look
  // to a user like the identical symptom: pick a file, nothing happens.
  {
    const source = readFileSync(
      new URL('../src/console/ImportTools.tsx', import.meta.url),
      'utf8'
    )
    // `e.target.files` is a LIVE view of the input's selection, not a snapshot.
    // Clearing the value empties it, so a read taken afterwards -- or a
    // reference held across the clear -- finds nothing to import and the whole
    // thing silently does not run.
    const copied = source.indexOf('Array.from(e.target.files')
    const cleared = source.indexOf("e.target.value = ''")
    check('the chosen files are copied out of the input', copied > 0, `at ${copied}`)
    check(
      'before its value is cleared, not after',
      copied > 0 && cleared > copied,
      `copy at ${copied}, clear at ${cleared}`
    )

    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    // The receipt is absolutely positioned BELOW the bar, so any clipping
    // ancestor eats it -- and an import that reports nothing reads exactly like
    // one that never happened.
    // Comments stripped first: the rule EXPLAINS why it must not clip, and the
    // explanation necessarily contains the declaration it is warning against.
    // Import moved into this cluster, so this is the box the receipt now hangs
    // out of; it used to be `.brand`.
    const holder = (css.split('.topbar-right {')[1]?.split('}')[0] ?? '').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    )
    check(
      'and nothing clips the receipt that reports them',
      holder.trim().length > 0 && !/overflow:\s*hidden/.test(holder),
      /overflow:\s*hidden/.test(holder) ? 'the tool cluster still clips' : 'clear'
    )
  }

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
    'and carries no cut actions until it is armed',
    renderToStaticMarkup(createElement(CutActions)) === '',
    'disarmed CutActions renders nothing'
  )

  // The island over the scene: the two tools, and the strip that shuts it.
  const island = markupOf('ToolIsland', ToolIsland)
  shows('the island carries the cut tool', island, '>Cut<')
  shows('the move tool', island, '>Move<')
  shows('the rotate tool', island, '>Rotate<')
  shows('and the scale tool', island, '>Scale<')
  // And not Snap, which moved to the bar. The pair of assertions is the point:
  // one control, one home.
  hides('but not the snap tool, which is in the bar now', island, '>Snap<')
  // The gizmo tools lead the island: they decide what every drag on a handle
  // does, which is a different order of thing from the two tools below them.
  check(
    'and the gizmo tools come first',
    island.indexOf('>Move<') < island.indexOf('>Ruler<') &&
      island.indexOf('>Scale<') < island.indexOf('>Ruler<'),
    `${island.indexOf('>Move<')}, ${island.indexOf('>Scale<')} vs ${island.indexOf('>Ruler<')}`
  )
  // With a rule drawn across the seam between them, which is where the two
  // kinds of control meet. Its POSITION is the whole of what it says, so that
  // is what is checked rather than merely that it is somewhere in there.
  check(
    'with a rule across the seam between the two groups',
    island.indexOf('island-rule') > island.indexOf('>Scale<') &&
      island.indexOf('island-rule') < island.indexOf('>Ruler<'),
    `scale ${island.indexOf('>Scale<')}, rule ${island.indexOf('island-rule')}, ruler ${island.indexOf('>Ruler<')}`
  )
  {
    // And the stylesheet actually draws it. A div whose whole substance is a
    // class is invisible if the rule behind it is missing or renamed, and
    // nothing at runtime would report that -- the markup would go on passing
    // the check above while the island showed no line at all.
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const rule = css.split('.island-rule {')[1]?.split('}')[0] ?? ''
    check('and the stylesheet draws it', rule.includes('background:'), rule.trim())
    check('as a hairline', rule.includes('height: 1px'), rule.trim())
    // And a BRIGHT one. It is the only line in the island not on --border,
    // which is the whole point of it: at #252b35 over a near-black island the
    // seam was a rule you had to know was there. Pinned as "not the border
    // token" as well as "the muted one", because reverting it would be a
    // one-word edit that nothing else would notice.
    check(
      'lit, rather than on the token every other line uses',
      rule.includes('--muted') && !rule.includes('--border'),
      rule.trim()
    )
    // Flat, and pinned as such: a gradient here was tried and rejected --
    // nothing else in the app draws one, so it read as decoration rather than
    // as one of its rules.
    check('and solid, not a gradient', !rule.includes('gradient'), rule.trim())
  }

  // The two that decide WHICH GIZMO is up. They are switches rather than a
  // three-way picker because Move is not a thing you choose -- it is where you
  // are when neither of these is on -- so there is no third button and no
  // state on screen for it.
  const rotate = markupOf('RotateTool', RotateTool)
  shows('the rotate tool rests off', rotate, 'aria-pressed="false"')
  // One of the three is ALWAYS on, and at rest it is Move -- so "which gizmo
  // am I in" is read off the panel rather than deduced from two dark buttons.
  shows('with move lit in its place', markupOf('MoveTool', MoveTool), 'aria-pressed="true"')
  // No hover bubble, the same rule Snap and Cut follow: these are pressed
  // constantly, and a paragraph on every pass of the pointer is noise. The keys
  // that reach them are named in Help instead, where the app's other shortcuts
  // already live.
  hides('and carries no hover bubble', rotate, 'nav-tip')
  hides('nor does scale', markupOf('ScaleTool', ScaleTool), 'nav-tip')
  // --- the help screen -------------------------------------------------------
  //
  // Help is no longer a panel hanging off its button: it is a screen over the
  // whole app, opened by the same `openPanel` field every other panel uses. So
  // the button must have stopped carrying a dropdown, and the screen must only
  // exist while that field says so.
  const helpBtn = markupOf('HelpTool', HelpTool)
  shows('the help button is in the bar', helpBtn, '<span class="nav-label">Help</span>')
  hides('and no longer drops a panel of its own', helpBtn, 'nav-panel')
  check(
    'the screen renders nothing until it is opened',
    renderToStaticMarkup(createElement(HelpScreen)) === '',
    renderToStaticMarkup(createElement(HelpScreen)).slice(0, 40)
  )

  tools().setOpenPanel('help')
  const screen = markupOf('HelpScreen (open)', HelpScreen)
  // A dialog rather than a region, and said so where a screen reader can hear
  // it: this covers the app and takes the interaction, which is the whole
  // difference between a modal and a big panel.
  shows('it opens as a modal dialog', screen, 'role="dialog"')
  shows('and says so', screen, 'aria-modal="true"')
  shows('over a backdrop that can be pressed to dismiss it', screen, 'help-backdrop')
  shows('with a way out that does not need the keyboard', screen, 'aria-label="Close help"')

  // IT HAS TO LEAVE THE WAY IT ARRIVED. The screen animates in, and for a while
  // it did not animate out at all -- `openPanel` went null and the card was
  // simply gone between two frames, which reads as a glitch rather than as
  // speed. The exit is two halves that only work together: React keeps the
  // element mounted for the length of the fade, and the stylesheet is told how
  // long that is. Either half alone is a bug you can see -- a card cut off
  // mid-fade, or one that has finished fading and is still there.
  {
    // Newlines normalised before matching. Line endings vary per file in this
    // tree, so a needle that spans one is a check that passes or fails on how
    // the file was last written rather than on what it says.
    const sheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(
      /\r\n/g,
      '\n'
    )
    const source = readFileSync(new URL('../src/console/HelpScreen.tsx', import.meta.url), 'utf8')
    check(
      'the stylesheet knows how to take the screen away',
      sheet.includes('.help-leaving') && sheet.includes('@keyframes help-screen-out'),
      'without it the card vanishes between two frames'
    )
    check(
      'the component holds it on screen long enough to be seen going',
      source.includes('HELP_EXIT_MS') && source.includes('help-leaving'),
      'CSS cannot animate a node React has already unmounted'
    )
    check(
      'and the two take their timing from ONE number',
      sheet.includes('var(--help-exit') && source.includes("'--help-exit'"),
      'a mirrored duration drifts, and the drift is visible'
    )
    // The setting asks for less MOVEMENT, not for jump cuts: the fade stays and
    // the 6px rise goes, which is the trade `.selection-hud` already makes.
    check(
      'a reduced-motion reader still gets the fade, without the movement',
      sheet.includes('.help-leaving .help-screen {\n    animation-name: help-fade-out;'),
      'the screen would appear and vanish between two frames'
    )
  }

  // The rail is the table of contents, and every section has to be reachable
  // from it -- a section not offered is a page nobody can open.
  for (const section of HELP_SECTIONS) {
    shows(`the rail offers ${section.id}`, screen, `>${section.title}</span>`)
  }
  check(
    'and it opens on the first one',
    tools().helpSection === DEFAULT_HELP_SECTION && DEFAULT_HELP_SECTION === HELP_SECTIONS[0].id,
    tools().helpSection
  )
  shows('with that page lit in the rail', screen, 'help-rail-btn help-rail-on')

  // WHAT EVERY PAGE OWES. Walked rather than spot-checked: the whole reason the
  // open section lives in the store is that a check can drive it, and an entry
  // that renders a heading with nothing under it is the failure mode a help
  // screen actually has.
  for (const section of HELP_SECTIONS) {
    tools().setHelpSection(section.id)
    const page = markupOf(`HelpScreen (${section.id})`, HelpScreen)
    shows(`${section.id} heads its page`, page, `<h3 class="help-pane-title">${section.title}</h3>`)
    shows(`${section.id} says what it covers`, page, section.blurb)
    check(`${section.id} has entries`, section.entries.length > 0, String(section.entries.length))
    for (const entry of section.entries) {
      shows(`${section.id}: ${entry.title} is titled`, page, `${entry.title}`)
      check(
        `${section.id}: ${entry.title} has a description under it`,
        entry.body.length > 0,
        String(entry.body.length)
      )
    }
  }

  // Section titles have to be distinct, or the rail shows two rows reading the
  // same word and one of them can never be told from the other.
  const sectionTitles = HELP_SECTIONS.map((s) => s.title)
  check(
    'no two sections share a name',
    new Set(sectionTitles).size === sectionTitles.length,
    sectionTitles.join(', ')
  )
  // And entry titles have to be distinct WITHIN a section: they are the React
  // key the list is built on, so a repeat is a dropped entry rather than a
  // cosmetic clash.
  for (const section of HELP_SECTIONS) {
    const titles = section.entries.map((e) => e.title)
    check(
      `${section.id}: no two entries share a title`,
      new Set(titles).size === titles.length,
      titles.join(', ')
    )
  }

  // --- and what the pages still have to SAY -----------------------------------
  //
  // The claims worth guarding are the ones a user cannot discover without doing
  // the thing and being surprised by it. They moved section when the list was
  // broken up, so each is asserted against the page it moved to -- which is
  // also what stops a reorganisation quietly losing one.
  tools().setHelpSection('tools')
  const toolsPage = markupOf('HelpScreen (tools)', HelpScreen)
  // The blade's landing place is a promise the tool makes, so Help states it:
  // it is the difference between "the button did nothing" and "the plane is on
  // the part I picked".
  shows(
    'Help says where an armed blade lands',
    toolsPage,
    'through the middle of the selected object'
  )
  // The torch's two surprises, both of which a user would otherwise find out by
  // doing them: a plain click no longer picks anything up, and a wall thinner
  // than the brush does not merely dish -- it opens.
  shows('Help explains the blowtorch', toolsPage, 'Blowtorch')
  shows('warns that clicking no longer selects', toolsPage, 'no longer picks anything up')
  shows('and says it burns through a thin wall', toolsPage, 'It burns through.')
  shows('and that a thick one only dishes', toolsPage, 'cannot be burnt')
  // And the other brush, whose two surprises are the same shape: it is the
  // torch backwards, and arming it puts the torch down.
  shows('Help explains the sculpt tool', toolsPage, 'Sculpt')
  shows('says which way it works', toolsPage, 'onto')
  shows('and that the two brushes are exclusive', toolsPage, 'puts the other down')

  // The three gizmo keys, now drawn as chips beside the names rather than
  // spelled into the sentence -- which is the point of the chip: it is the part
  // of an entry that is scanned for.
  tools().setHelpSection('gizmo')
  const gizmoPage = markupOf('HelpScreen (gizmo)', HelpScreen)
  shows('Help names the move key', gizmoPage, '<kbd class="help-key">M</kbd>')
  shows('and the rotate key', gizmoPage, '<kbd class="help-key">R</kbd>')
  shows('and the scale key', gizmoPage, '<kbd class="help-key">S</kbd>')

  // The outline switch is documented, which is the standing debt every new
  // preference takes on: a setting nobody can find is a setting nobody has.
  tools().setHelpSection('files')
  const filesPage = markupOf('HelpScreen (files)', HelpScreen)
  shows('Help documents the outline switch', filesPage, 'The edge lines drawn around every solid')

  tools().setHelpSection(DEFAULT_HELP_SECTION)
  tools().setOpenPanel(null)

  tools().setTransformMode('rotate')
  shows(
    'choosing rotate lights it',
    markupOf('RotateTool (on)', RotateTool),
    'aria-pressed="true"'
  )
  // ONE field holds the mode, so choosing either is choosing against the
  // other. There is no rule keeping the two apart because there is no state in
  // which both could be on.
  shows(
    'and puts scale out',
    markupOf('ScaleTool (rotate up)', ScaleTool),
    'aria-pressed="false"'
  )
  tools().setTransformMode('scale')
  shows(
    'and the same the other way round',
    markupOf('RotateTool (scale up)', RotateTool),
    'aria-pressed="false"'
  )
  // Choosing either puts Move out, which is the same one field saying so.
  shows(
    'and move goes out with it',
    markupOf('MoveTool (scale up)', MoveTool),
    'aria-pressed="false"'
  )
  tools().setTransformMode('move')
  shows(
    'and back on Move the other two are off',
    markupOf('RotateTool (move)', RotateTool),
    'aria-pressed="false"'
  )
  shows('with Move lit again', markupOf('MoveTool (move)', MoveTool), 'aria-pressed="true"')

  // THE PICKER CAN HOLD NOTHING, which is the state it could not show before.
  // A gizmo nobody asked for lies over the very surface the torch and the
  // sketch tools work on, and deselecting the solid is not an acceptable way to
  // put it down -- so pressing the lit Move button takes the handles off.
  {
    const pressed = (mode: 'move' | 'rotate' | 'scale') => tools().pressTransformMode(mode)

    tools().setTransformMode('move')
    tools().setGizmoHidden(false)
    pressed('move')
    check('pressing the lit Move button puts the handles down', tools().gizmoHidden, 'hidden')
    shows(
      'and the whole row goes dark',
      markupOf('MoveTool (handles down)', MoveTool),
      'aria-pressed="false"'
    )
    shows(
      'rotate included',
      markupOf('RotateTool (handles down)', RotateTool),
      'aria-pressed="false"'
    )
    shows(
      'and scale',
      markupOf('ScaleTool (handles down)', ScaleTool),
      'aria-pressed="false"'
    )
    // The MODE is untouched by hiding: it says what a drag would do, and the
    // cut plane and a selected sketch still read it for their own handles. A
    // fourth `none` mode would have disarmed those too.
    check('while the mode itself is remembered', tools().transformMode === 'move', tools().transformMode)

    // A hidden gizmo must never be a dead picker: reaching for any of the three
    // brings the handles back, in that mode.
    pressed('rotate')
    check('reaching for a tool brings them back', !tools().gizmoHidden, 'shown')
    check('in the tool that was reached for', tools().transformMode === 'rotate', tools().transformMode)

    // The ladder: your tool puts away to Move, and Move puts away to nothing.
    // Two presses from anywhere to a bare object.
    pressed('rotate')
    check('a lit tool still falls back to Move', tools().transformMode === 'move' && !tools().gizmoHidden, `${tools().transformMode}`)
    pressed('move')
    check('and Move then takes the handles off', tools().gizmoHidden, 'hidden')

    // Coming back from hidden straight into Move works too -- the branch above
    // it must not swallow the case where the wanted mode is the stored one.
    pressed('move')
    check('pressing Move while hidden shows it again', !tools().gizmoHidden, 'shown')
    check('still on Move', tools().transformMode === 'move', tools().transformMode)

    tools().setGizmoHidden(false)
    tools().setTransformMode('move')
  }

  // WHAT TAKES THE HANDLES OFF, all six stated one at a time. The rule decides
  // whether a set of arrows lies over the surface a brush is trying to work on,
  // and it is too long to be read correctly inline -- which is why it is a
  // function now rather than a boolean chain in the JSX.
  {
    const wearing = {
      selected: true,
      hidden: false,
      cutActive: false,
      brushArmed: false,
      rulerSelected: false,
      sketchSelected: false,
      marqueeing: false,
    }
    check('a selected object wears a gizmo', selectionWearsGizmo(wearing), 'shown')
    check(
      'and nothing selected wears nothing',
      !selectionWearsGizmo({ ...wearing, selected: false }),
      'hidden'
    )
    // Five other claims on the handles.
    for (const claim of [
      'cutActive',
      'brushArmed',
      'rulerSelected',
      'sketchSelected',
      'marqueeing',
    ] as const) {
      check(
        `${claim} stands the object's gizmo down`,
        !selectionWearsGizmo({ ...wearing, [claim]: true }),
        'hidden'
      )
    }
    // And the sixth, which is not a guess about what someone is doing but the
    // answer: the user pressed the lit Move button.
    check(
      'and so does the user saying so',
      !selectionWearsGizmo({ ...wearing, hidden: true }),
      'hidden'
    )
    // A brush in particular, since that is the tool the rule was extended
    // for: arming one must clear the handles without the user asking twice.
    check(
      'an armed brush alone is enough to clear them',
      !selectionWearsGizmo({ ...wearing, brushArmed: true }) &&
        selectionWearsGizmo({ ...wearing, brushArmed: false }),
      'cleared by the brush'
    )
  }

  // AND THE BODY GOES WITH THE HANDLES. Taking the arrows away is only half of
  // turning the tool off: the solid itself is draggable, invisibly, and an
  // object that still walks across the scene on the first press is the opposite
  // of what a dark picker says.
  {
    check(
      'an object wearing handles can be dragged by its body',
      bodyCanBeDragged({ hidden: false, brushArmed: false }),
      'draggable'
    )
    check(
      'putting the handles down stops that too',
      !bodyCanBeDragged({ hidden: true, brushArmed: false }),
      'fixed'
    )
    check(
      'and so does arming a brush',
      !bodyCanBeDragged({ hidden: false, brushArmed: true }),
      'fixed'
    )
    // The two rules have to agree in the direction that matters: anything that
    // stops the body being dragged must also have taken the handles away, or
    // there would be a state offering arrows on an object it refuses to move.
    for (const hidden of [false, true]) {
      for (const brushArmed of [false, true]) {
        const wearing = selectionWearsGizmo({
          selected: true,
          hidden,
          brushArmed,
          cutActive: false,
          rulerSelected: false,
          sketchSelected: false,
          marqueeing: false,
        })
        const draggable = bodyCanBeDragged({ hidden, brushArmed })
        check(
          `hidden=${hidden} brush=${brushArmed}: handles and body agree`,
          wearing === draggable,
          `${wearing ? 'arrows' : 'none'} / ${draggable ? 'draggable' : 'fixed'}`
        )
      }
    }
  }


  shows('under a title that names it', island, 'Tools</button>')
  shows('and it stands open at rest', island, 'aria-expanded="true"')

  tools().setIslandCollapsed(true)
  const shut = markupOf('ToolIsland (collapsed)', ToolIsland)
  // Collapsed is the strip and nothing else: the tools are not merely hidden
  // by CSS, they are off the page, so nothing in there is left in the tab order
  // over a scene that is now showing none of it.
  hides('collapsed, the tools go with the body', shut, '>Move<')
  hides('the cut tool with them', shut, '>Cut<')
  shows('leaving the strip that opens it again', shut, 'Tools</button>')
  shows('which says it is shut', shut, 'aria-expanded="false"')
  tools().setIslandCollapsed(false)

  // WHERE it sits is inline, from two of the four insets rather than a
  // left/top pair, and the corner it is on is a class the panels inside read to
  // decide which way to open.
  shows('it opens in the top-left corner', island, 'style="left:12px;top:12px"')
  shows('and says which corner that is', island, 'tool-island-left tool-island-top')

  // The drag itself is this one pure solve -- the component reads the pointer
  // and hands the answer to the store -- so it is checked as arithmetic.
  const size = { width: 176, height: 90 }
  const bounds = { width: 1000, height: 700 }
  const spanX = bounds.width - size.width
  const spanY = bounds.height - size.height
  const at = (x: number, y: number) => JSON.stringify(dockIsland(x, y, size, bounds))
  const placed = (hx: string, x: number, hy: string, y: number) =>
    JSON.stringify({ hx, x, hy, y })

  check('dropped mid-scene it stays where it was put', at(300, 200) === placed('left', 300, 'top', 200), at(300, 200))
  check('near an edge it snaps flush to it', at(5, 200) === placed('left', ISLAND_MARGIN, 'top', 200), at(5, 200))
  check(
    'and the gap is measured from the edge it is nearest',
    at(spanX - 6, 200) === placed('right', ISLAND_MARGIN, 'top', 200),
    at(spanX - 6, 200)
  )
  // A corner is not a case of its own: it is both axes snapping at once, which
  // is why edges and corners feel like one behaviour rather than two.
  check(
    'two edges at once is a corner',
    at(spanX - 8, spanY - 8) === placed('right', ISLAND_MARGIN, 'bottom', ISLAND_MARGIN),
    at(spanX - 8, spanY - 8)
  )
  // Dragged clean off the scene, it comes back to the corner it left by rather
  // than to wherever the pointer went.
  check('dragged past a corner it lands in it', at(-400, -400) === placed('left', ISLAND_MARGIN, 'top', ISLAND_MARGIN), at(-400, -400))
  check('and past the far one, in that one', at(4000, 4000) === placed('right', ISLAND_MARGIN, 'bottom', ISLAND_MARGIN), at(4000, 4000))
  // The catch has an outside, or the middle of the scene would be unreachable.
  const clear = ISLAND_MARGIN + ISLAND_SNAP + 1
  check(
    'outside the catch it keeps the gap it was given',
    at(clear, 200) === placed('left', clear, 'top', 200),
    at(clear, 200)
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

doc().startPlacing(defaultShape('circle'))
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
  shows('the tree nests the sketch under its object', tree, 'Circle r0.15 - ')
  shows('and says it is still flat', tree, 'class="feature-action">projection<')
  shows('and counts it', tree, '>1f<')

  // A flat sketch builds nothing, so there is nothing to sign off yet -- but
  // the button is SHOWN, greyed and saying why, rather than hidden. It is what
  // tells somebody who has just watched an orange ring appear that there will
  // be a way to put it away, which is the question this whole block answers.
  const aim = markupOf('PlacementPanel (sketch, flat)', PlacementPanel)
  shows('the sketch block is up while the sketch is flat', aim, 'sketch-actions')
  shows('and says there is nothing to confirm yet', aim, 'Nothing to confirm yet')
  shows('with the button out of reach', aim, 'sketch-confirm" disabled')
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
  shows('the tree says extrude now', tree, 'feature-action feature-out">extrude 0.15<')
}

// --- 3b. Signing the sketch off -------------------------------------------
console.log('\n3b. Confirming an extrusion retires its sketch')

// THE COMPLAINT THIS ANSWERS: the orange outline stayed on the surface for the
// life of the document -- over a boss that was finished, in the one colour in
// the scene that means "not settled yet" -- and the only way to be rid of it
// was to delete the feature, which takes the boss with it. So the app could
// build the shape and had no way to say the shape was done.
{
  const before = markupOf('PlacementPanel (sketch, extruded)', PlacementPanel)
  shows('an extruded sketch offers a confirm', before, 'sketch-confirm')
  // It names the direction the feature actually went, rather than a category:
  // the same word the row in the tree uses for it.
  shows('and names what it is confirming', before, 'Confirm extrusion')
  // Above the position rows, where the eraser's block is, so the panel reads in
  // the order the gesture runs: aim it, then commit it.
  check(
    'with the block above the rows it sits over',
    before.indexOf('sketch-actions') < before.indexOf('vec3-axis'),
    'the confirm has drifted below the fields'
  )

  const shaped = measure(cubeId)
  doc().confirmFeature(cubeId, featureId)
  const signed = measure(cubeId)

  // THE CLAIM THAT MATTERS. Confirming is about what is DRAWN. A document whose
  // SHAPE depended on whether somebody had ticked it off would be a different
  // document, and `evaluate.ts` must never learn this field exists.
  near('confirming leaves the boss exactly where it was', signed.max[1], shaped.max[1], 1e-9)
  near('and the solid it grew from', signed.min[1], shaped.min[1], 1e-9)
  check('and it still builds', signed.failed.length === 0, signed.failed.join(','))

  // Gone from both places a user could see it.
  const after = markupOf('SceneTree (confirmed)', SceneTree)
  hides('the tree drops the sketch row', after, 'Circle r0.15 - ')
  hides('and stops counting it against the object', after, '>1f<')
  hides(
    'the panel stops offering to confirm it again',
    markupOf('PlacementPanel (confirmed)', PlacementPanel),
    'sketch-actions'
  )
  check(
    'and nothing is left selected to aim',
    doc().selectedFeatureId === null,
    `${doc().selectedFeatureId}`
  )

  // The viewport half is a fibre tree and cannot be mounted here, so the guard
  // is on the source -- the same shape of guard the outline switch takes.
  check(
    'the viewport stops drawing the outline',
    readFileSync(new URL('../src/viewport/SketchLayer.tsx', import.meta.url), 'utf8').includes(
      'object.features.filter((f) => !f.confirmed)'
    ),
    'the ring would still be drawn over a finished boss'
  )

  // One way, and undone the one way the eraser is.
  doc().undo()
  shows(
    'undo hands the sketch back',
    markupOf('SceneTree (unconfirmed)', SceneTree),
    'Circle r0.15 - '
  )
  // And the sections below this one expect it selected, the way commitPlacing
  // left it: undo restores the document, not the selection.
  doc().selectFeature(cubeId, featureId)
  check(
    'still extruded after the round trip',
    (doc().doc.objects.find((o) => o.id === cubeId)?.features[0]?.depth ?? 0) > 0,
    `${doc().doc.objects.find((o) => o.id === cubeId)?.features[0]?.depth}`
  )
}

// --- 4. The End face panel reaches the geometry ---------------------------
console.log('\n4. Tilt and slide reach the solid')

const baseline = measure(cubeId)
{
  check('the extruded cube builds', baseline.failed.length === 0, baseline.failed.join(','))
  // A 10 cm cube plus a 15 mm boss on the +Y face, which stands that far proud
  // of it: half the cube's span, plus the depth.
  near('the boss stands proud of the face', baseline.max[1], 0.5 + DEFAULT_FEATURE_DEPTH, 1e-6)
  near('and the cube is otherwise untouched', baseline.max[0], 0.5, 1e-6)
}

// The boss is as deep as the sketch's radius -- both 15 mm -- so the panel's
// slider should stop just short of atan(1) = 45 degrees. Written as the two
// values rather than as 45, so it is the RATIO being pinned: halve the app's
// default scale and this number must not move.
const SKETCH_R = 0.15
const TILT_BOUND = tiltBoundDeg(DEFAULT_FEATURE_DEPTH, SKETCH_R)
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
    SKETCH_R * Math.tan(rad(TILT_DEG)),
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

const SLIDE_U = 0.4
doc().patchFeature(cubeId, featureId, { tilt: [0, 0, 0], faceOffset: [SLIDE_U, 0] })
const slid = measure(cubeId)
{
  check('a slid feature still builds', slid.failed.length === 0, slid.failed.join(','))
  // The base of the boss stays on the face and the top slides to u = 0.4, so
  // the pillar leans out past the side of the cube by the sketch radius.
  near('the leaning pillar overhangs the cube', slid.max[0], SLIDE_U + SKETCH_R, 1e-3)
  near('but only along U', slid.max[2], 0.5, 1e-6)
  // A shear moves no material, which is what "the base stays put" means.
  near('sliding shears the pillar rather than growing it', slid.volume, baseline.volume, 1e-6)

  const panel = markupOf('Inspector (slid)', Inspector)
  shows(
    'the panel reads back the slide it applied',
    panel,
    trackOf(SLIDE_U, MAX_FACE_OFFSET, 0.01)
  )
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
  // The bare 10 cm cube: one cubic unit, and the feature gone without taking
  // the solid with it.
  near('and the object still builds, minus the feature', extreme.volume, 1, 1e-6)

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
// The prism is 0.9 tall and rests on the grid, so this plane is halfway up it.
tools().setCutPlane({ position: [-3, 0.45, 0], rotation: [0, 0, 0] })
{
  // Arming puts the two ACTIONS on the island, a short travel from the gizmo
  // that just aimed the plane. The plane's numbers stay in the console.
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
  shows(
    'with the plane range, not the object one',
    placed,
    trackOf(-3, CUT_POSITION_LIMIT)
  )
  shows('it says what it will cut', panel, 'Cuts the selected object')
  shows('and offers the button', panel, '>Apply cut</button>')
  shows('and the one that re-aims the plane', panel, '>Reset plane</button>')

  // Deselect and the button says out loud that it is about to cut everything.
  // On a 176px island the target sentence lives in a title; the COUNT does not,
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
  shows(
    'the panel offers that same ceiling',
    markupOf('ObjectPanel (bounds)', ObjectPanel),
    `max="${inShown(MAX_SIZE)}"`
  )
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
  // The same guard, widened to every other colour the two halves of the window
  // share.
  //
  // The axis triad was the only mirrored pair anyone had written down. It was
  // not the only one that existed: the scene's background, the accent on a
  // selected sketch and a snapped edge, the green of an addition and the red of
  // a subtraction, the cut plane's red and the ruler's yellow were all typed out
  // again in the viewport, in eight files, none of them naming the token they
  // were a copy of. That is the difference between an app that HAS a design
  // language and one whose two halves merely happen to agree today.
  //
  // `sceneColors` is now the single scene-side copy, and this walks its own
  // table rather than a list repeated here -- so a colour added to the module is
  // guarded from the moment it is added, and cannot be forgotten into drift.
  //
  // Across EVERY theme, which is the half that matters now there is more than
  // one. A theme is two files agreeing: a block of token overrides in the
  // stylesheet and an entry in `SCENE_THEMES`. Nothing at runtime notices if
  // they disagree -- the console simply goes light while the viewport stays
  // black, which is not an error anywhere, just a broken-looking app. Walking
  // THEMES rather than a list written here means the day a fourth theme is
  // added it is guarded before it is finished.
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

  /**
   * The declarations inside one theme's block.
   *
   * Dark is `:root` itself rather than an override block -- that is deliberate
   * in the stylesheet, so that the default costs nothing and the app is themed
   * before any script runs -- so it is looked up by a different selector. The
   * others are matched with the `[` attached, which is what keeps `:root {` from
   * matching `:root[data-theme='light'] {`.
   */
  const themeBlock = (name: Theme): string | null => {
    const selector = name === DEFAULT_THEME ? ':root {' : `:root[data-theme='${name}'] {`
    const at = css.indexOf(selector)
    if (at < 0) return null
    const end = css.indexOf('\n}', at)
    return end < 0 ? null : css.slice(at + selector.length, end)
  }

  for (const name of THEMES) {
    const block = themeBlock(name)
    check(`the stylesheet has a block for ${name}`, block !== null)
    if (block === null) continue

    const palette = SCENE_THEMES[name]
    SCENE_CSS_VARS.forEach(([prop, key]) => {
      // Split rather than match, for the reason the axis check gives: a
      // declaration carries the colon and a `var(--x)` reference does not.
      const declared = block.split(`${prop}:`)[1]?.split(';')[0]?.trim()
      const scene = palette[key]
      check(
        `${name}: ${prop} matches what the scene draws with`,
        declared?.toLowerCase() === scene.toLowerCase(),
        `${declared} vs ${scene}`
      )
    })
  }

  // And a theme that is merely a copy of another is not a theme. Every palette
  // has to differ from every other in the ground it paints -- the one value that
  // decides whether the app reads as light or dark at a glance.
  const grounds = THEMES.map((name) => SCENE_THEMES[name].bg.toLowerCase())
  check(
    'and no two themes share a ground',
    new Set(grounds).size === THEMES.length,
    grounds.join(', ')
  )

  // --- and every theme's text is actually readable on it ---------------------
  //
  // The check this file most needed and did not have. The cyberpunk ramp shipped
  // as four steps of red at descending luminance, which looks like a ramp in a
  // swatch and is not one: red carries almost no luminance to spend, so the
  // muted rung -- which is what most of the LABELLING in this app is written in
  // -- landed at 2.6:1 against a raised control, and the dimmest at 1.6:1.
  //
  // Nothing failed. Nothing could fail. It rendered perfectly and could not be
  // read, and the only way anybody finds that is by looking at it in good light
  // and saying so. So it is arithmetic now, held against every theme at once,
  // and a fourth theme cannot ship the same way.
  //
  // WCAG 2.1 relative luminance, and the floor each rung is held to is the job
  // it does rather than one blanket number:
  //   text-1  7:1   values and figures, set at 10-13px and read one glyph at a
  //                 time -- the rung worth holding above the AA minimum
  //   text-2  4.5:1 the secondary voice: AA for normal text, and no higher.
  //                 Cyberpunk's cyan happens to reach 10.8 here, which is not a
  //                 reason to hold the other two to a number that is about that
  //                 one theme rather than about the job the rung does
  //   text-3  4.5:1 the muted rung: field labels, section headings
  //   text-4  3:1   carets, grips, dim icons -- marks, not prose
  //
  // Measured against the LIGHTEST surface a label can land on in a dark theme
  // and the darkest in a light one -- --surface-4, the pressed state -- because
  // the worst case is the only case worth pinning.
  {
    const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    /** A hex decoded to the three LINEAR channels, which is the space a three
     *  material scales a texture in -- see the compass block below. */
    const channels = (hex: string) => {
      const h = hex.replace('#', '')
      return [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255))
    }
    const lumOf = (lin: number[]) => 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    const luminance = (hex: string) => lumOf(channels(hex))
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m)
      return (hi + 0.05) / (lo + 0.05)
    }

    const FLOORS: ReadonlyArray<readonly [string, number]> = [
      ['--text-1', 7],
      ['--text-2', 4.5],
      ['--text-3', 4.5],
      ['--text-4', 3],
    ]
    const SURFACES = ['--surface-1', '--surface-2', '--surface-3', '--surface-4']

    for (const name of THEMES) {
      const block = themeBlock(name)
      if (block === null) continue
      const value = (prop: string) => block.split(`${prop}:`)[1]?.split(';')[0]?.trim()
      const surfaces = SURFACES.map(value).filter((v): v is string => v?.startsWith('#') ?? false)
      check(`${name}: every surface in the ramp is a literal to measure`, surfaces.length === SURFACES.length)

      for (const [prop, floor] of FLOORS) {
        const fg = value(prop)
        if (fg === undefined || !fg.startsWith('#')) {
          check(`${name}: ${prop} is a literal to measure`, false, `${fg}`)
          continue
        }
        const worst = Math.min(...surfaces.map((bg) => contrast(fg, bg)))
        check(
          `${name}: ${prop} reads at ${floor}:1 on every surface`,
          worst >= floor,
          `${worst.toFixed(2)}:1`
        )
      }
    }

    // --- and the label on the corner compass ---------------------------------
    //
    // The same arithmetic, one widget further out, because the compass is the
    // one surface in the app whose background is not a token: each face is the
    // theme's `compassFace` scaled by its own shade, so a face colour that reads
    // fine as a swatch can still put an unreadable label on the darkest of six.
    // The cyberpunk cube is a block of solid accent with black lettering, which
    // makes it the one most worth holding to a number.
    //
    // Three's own maths, exactly: `new Color(hex)` decodes sRGB to linear,
    // `multiplyScalar` scales there, and the canvas re-encodes on the way out --
    // so scaling the LINEAR value is what the user actually sees, and doing this
    // in sRGB would report a face several shades darker than it is.
    const darkest = Math.min(...COMPASS_FACE_SHADE)
    for (const name of THEMES) {
      const { compassFace, compassText } = SCENE_THEMES[name]
      const faceLin = channels(compassFace).map((c) => c * darkest)
      const textLum = luminance(compassText)
      const ratioTo = (lin: number[]) => {
        const [hi, lo] = [lumOf(lin), textLum].sort((m, n) => n - m)
        return (hi + 0.05) / (lo + 0.05)
      }

      const rest = ratioTo(faceLin)
      check(`${name}: the compass label reads on its darkest face`, rest >= 4.5, `${rest.toFixed(2)}:1`)
    }
  }
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

{
  // WHERE AN ARMED BLADE COMES UP. The plane used to appear at the world origin
  // whatever was selected, and the scene is five metres across -- so a part
  // built anywhere else got a blade that was off screen, and the tool could be
  // armed and fired without the plane ever being seen. It lands on the object
  // the Apply button is going to cut instead.
  const cutMe = doc().addObject({ kind: 'box', size: [2, 3, 4] }, [12, 6, -8])
  const object = doc().doc.objects.find((o) => o.id === cutMe)
  check('a solid to cut', object !== undefined)
  if (object) {
    const box = objectBounds(object)
    const centre = box.getCenter(new Vector3())
    const spawn = cutPlaneSpawn(object)

    near('the blade comes up through the middle of the object', spawn.position[0], centre.x, 1e-12)
    near('on every axis', spawn.position[1], centre.y, 1e-12)
    near('including the one it is normal to', spawn.position[2], centre.z, 1e-12)
    // Level, not turned to face anything: which way the blade lies is the one
    // thing the user aims by hand, and reset has always promised to put it back.
    check('and level', spawn.rotation.every((r) => r === 0), spawn.rotation.join())

    // The guide has to overhang the solid at ANY tilt, so it is sized off the
    // box's DIAGONAL -- one sized to the footprint disappears inside the part
    // the moment the ring is turned, and stops saying where the cut lands.
    const diagonal = box.getSize(new Vector3()).length()
    check(
      'the guide square overhangs the solid from every angle',
      spawn.size >= diagonal,
      `${spawn.size.toFixed(4)} vs a ${diagonal.toFixed(4)} diagonal`
    )
    check('within the size the ring can reach', spawn.size <= CUT_SIZE_MAX, `${spawn.size}`)

    // The point of all of it: Apply cut, pressed on a freshly armed tool with
    // nothing else touched, severs the thing you had selected.
    const before = doc().doc
    const n = cutPlaneNormal(spawn.rotation)
    const split = doc().applyCut(spawn.position, [n.x, n.y, n.z], [cutMe])
    check('so arming and firing splits the selected object', split === 1, `${split}`)
    doc().undo()
    check('and the undo puts it back', doc().doc === before)
  }

  // A blade sized to a 5 mm screw would be a guide you could not see, so the
  // default size is a floor rather than a starting point.
  const screw = makeObject({ kind: 'box', size: [0.05, 0.05, 0.05] }, [0, 0, 0])
  check(
    'a tiny object still gets a blade you can grab',
    cutPlaneSpawn(screw).size === DEFAULT_CUT_PLANE.size,
    `${cutPlaneSpawn(screw).size}`
  )

  // The scene envelope and the gizmo's drag bound are the same number, so an
  // object at the very edge of it must not spawn a plane the user then cannot
  // drag back. Built rather than added: the point is the arithmetic.
  const far = makeObject({ kind: 'box', size: [1, 1, 1] }, [CUT_POSITION_LIMIT + 20, 0, 0])
  check(
    'and one parked past the limit is clamped to it',
    cutPlaneSpawn(far).position[0] === CUT_POSITION_LIMIT,
    `${cutPlaneSpawn(far).position[0]}`
  )

  // Nothing selected: the middle of the scene, which is where the blade has
  // always come up and the only place it can go with no object to hang it off.
  check(
    'with nothing selected it is the default plane',
    JSON.stringify(cutPlaneSpawn(null)) === JSON.stringify(DEFAULT_CUT_PLANE),
    JSON.stringify(cutPlaneSpawn(null))
  )

  // And the store carries it through, which is the half a pure function cannot
  // state. Standing down goes back to the default rather than to the spawn: the
  // selection it described will have moved on by the next arming, and arming is
  // where it gets asked for again.
  if (object) {
    const spawn = cutPlaneSpawn(object)
    tools().setCutActive(true, spawn)
    check(
      'arming through the store lands the blade on the object',
      JSON.stringify(tools().cutPlane.position) === JSON.stringify(spawn.position),
      tools().cutPlane.position.join()
    )
    tools().setCutPlane({ position: [0, 0, 0] })
    tools().resetCutPlane(spawn)
    check(
      'and reset puts it back where arming would drop it now',
      JSON.stringify(tools().cutPlane.position) === JSON.stringify(spawn.position),
      tools().cutPlane.position.join()
    )
    tools().setCutActive(false)
    check(
      'while standing down still rearms to the default',
      JSON.stringify(tools().cutPlane) === JSON.stringify(DEFAULT_CUT_PLANE),
      JSON.stringify(tools().cutPlane)
    )
  }

  doc().removeObject(cutMe)
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

  // A row's icon is its base polygon projected, and it morphs between counts by
  // resampling every one of them onto a single ring of angles. That ring is
  // built from a fixed list of counts, so a row offering one that is not on it
  // would be drawn with its corners rounded off for as long as it sat still.
  const unsampled = offered.filter((n) => !SOLID_SIDES.includes(n))
  check(
    'and every one of them is sampled by the ring the icons morph on',
    unsampled.length === 0,
    unsampled.length ? `${unsampled.join(',')} missing from ${SOLID_SIDES.join(',')}` : 'all'
  )

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
    // Windowed like every other track, so what is pinned is that the window
    // sits inside the asymmetric depth limits rather than that it equals them.
    const depthWindow = trackWindow(inShown(depth()), inShown(-3), inShown(4), stepIn(0.01, SHOWN))
    shows('the depth slider is windowed inside its limits', flat, `type="range" min="${depthWindow.lo}"`)
    check(
      'and the window stays within the asymmetric bounds',
      depthWindow.lo >= inShown(-3) - 1e-9 && depthWindow.hi <= inShown(4) + 1e-9,
      `${depthWindow.lo} .. ${depthWindow.hi}`
    )

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
  //
  // Every claim below is theme-independent -- an uncoloured solid takes the
  // scene grey, a coloured one keeps its own hue when selected -- so each is
  // asserted in EVERY theme rather than in whichever one happens to be default.
  // That is the guard that matters here: a theme is allowed to change what
  // `selected` looks like, and is never allowed to repaint a solid the user
  // coloured. The palette is the thing being varied, so it is the loop variable.
  for (const name of THEMES) {
    const palette = SCENE_THEMES[name]
    const inTheme = (what: string) => `${what} (${name})`

    const grey = bodyPaint(undefined, false, palette)
    check(inTheme('an uncoloured solid keeps the scene grey'), grey.color === DEFAULT_OBJECT_COLOR, grey.color)
    check(inTheme('and glows not at all until it is selected'), grey.emissiveIntensity === 0)
    check(
      inTheme('selected, it takes the theme’s own shade'),
      bodyPaint(undefined, true, palette).color !== DEFAULT_OBJECT_COLOR
    )

    const own = bodyPaint('#cc2222', false, palette)
    check(inTheme('a coloured solid wears its own colour'), own.color === '#cc2222')
    const ownLit = bodyPaint('#cc2222', true, palette)
    const ownHsv = hexToHsv(ownLit.color)
    check(
      inTheme('and selecting it does not repaint it the theme colour'),
      (ownHsv?.s ?? 0) > 0.5,
      ownLit.color
    )
    check(inTheme('its glow stays its own colour'), ownLit.emissive === '#cc2222')
  }

  const dark = SCENE_THEMES[DEFAULT_THEME]
  const red = bodyPaint('#cc2222', false, dark)
  check('a coloured solid wears its own colour', red.color === '#cc2222')
  const redLit = bodyPaint('#cc2222', true, dark)
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
    top.depthBias > middle.depthBias && middle.depthBias > bottom.depthBias,
    `${top.depthBias}, ${middle.depthBias}, ${bottom.depthBias}`
  )
  // Subtracted from `gl_FragDepth`, so a POSITIVE bias is toward the camera --
  // the opposite sign from the polygon offset this replaces, which counted in
  // GL's offset units and was applied by the rasterizer.
  check('and the bias is positive -- toward the camera', top.depthBias > 0)
  check(
    'a step is well clear of the rounding it has to beat',
    BIAS_STEP > 16 / 2 ** 24,
    `${BIAS_STEP} vs a 24-bit step of ${1 / 2 ** 24}`
  )
  // At the distance the app opens at, a thousandth of this is still thicker
  // than the bias -- so an object lifted by it cannot swallow its own outline.
  check(
    'and far too small to see',
    BIAS_STEP < 1e-4,
    `${BIAS_STEP} of the window depth range`
  )
  check('the bottom row is left exactly alone', bottom.depthBias === 0)
  const only = depthBias(0, 1)
  check(
    'a scene of one object writes the depth it always did',
    only.depthBias === 0,
    `${only.depthBias}`
  )

  for (const id of [lower, upper, third]) doc().removeObject(id)
}

// --- dragging a number box --------------------------------------------------
console.log('\nA number box is dragged sideways, and typed into on a double click')
{
  // The FINE end: what the first pixel of a drag is worth. One step, always --
  // the smallest change the control can make, so a first pixel worth less would
  // move nothing and one worth more would put reachable values out of reach.
  near('a position starts at a step a pixel', scrubRate(-50, 50, 0.05), 0.05, 1e-12)
  near('and a rotation at a tenth of a degree', scrubRate(-180, 180, 0.1), 0.1, 1e-12)
  near('the first pixel of a drag is that step', scrubTravel(1, -50, 50, 0.05), 0.05, 1e-3)

  // The COARSE end: the same gesture, kept going, still crosses the whole range
  // in the span. This is what a flat rate could not do at both ends at once --
  // a position range of 100 in steps of 0.05 is 2000 steps, and a flat rate
  // fine enough for one step is 2000 pixels wide.
  near('and the span still crosses the range', scrubTravel(SCRUB_SPAN, -50, 50, 0.05), 100, 1e-9)
  near('however wide and fine the range is', scrubTravel(SCRUB_SPAN, 0.01, 50, 0.01), 49.99, 1e-9)

  // ODD in dx, which is what lets a drag run past a limit and come back to
  // exactly where it left rather than a little short.
  for (const d of [1, 37, 250, SCRUB_SPAN]) {
    near(`a drag of ${d} mirrors backwards`, scrubTravel(-d, -50, 50, 0.05), -scrubTravel(d, -50, 50, 0.05), 1e-12)
  }
  // And monotonic, so a pointer moving one way never sends the value the other.
  let climbing = true
  for (let d = 1; d <= SCRUB_SPAN; d += 7) {
    if (scrubTravel(d, -50, 50, 0.05) <= scrubTravel(d - 1, -50, 50, 0.05)) climbing = false
  }
  check('and never doubles back on itself', climbing)

  // A range narrow enough that a step a pixel already crosses it needs no ramp,
  // and must not get one: this is the flat behaviour it always had.
  near('a narrow range stays flat', scrubTravel(100, -180, 180, 1), 100, 1e-12)

  check('and the span is longer than the slider beside it', SCRUB_SPAN > 130, `${SCRUB_SPAN}`)
  check('while the slop is a few pixels at most', SCRUB_SLOP > 0 && SCRUB_SLOP <= 5, `${SCRUB_SLOP}`)

  // The reading itself.
  near('a press that goes nowhere changes nothing', scrubbed(1.25, 0, -8, 8, 0.05), 1.25, 1e-12)
  near('twenty pixels is a unit of position', scrubbed(1, 20, -8, 8, 0.05), 2, 1e-12)
  near('and it runs backwards too', scrubbed(1, -20, -8, 8, 0.05), 0, 1e-12)
  near('ninety pixels is a right angle', scrubbed(0, 90, -180, 180, 1), 90, 1e-12)

  // The track shows a window, and it never runs off either end of the range.
  for (const at of [-50, -12.5, 0, 3.7, 50]) {
    const w = trackWindow(at, -50, 50, 0.05)
    check(
      `the track window holds ${at} inside the range`,
      w.lo >= -50 - 1e-9 && w.hi <= 50 + 1e-9 && at >= w.lo - 1e-9 && at <= w.hi + 1e-9,
      `${w.lo} .. ${w.hi}`
    )
  }
  const mid = trackWindow(0, -50, 50, 0.05)
  check('and it is finer than the whole range', mid.hi - mid.lo < 100, `${mid.hi - mid.lo}`)
  const narrow = trackWindow(0, -1, 1, 0.5)
  check(
    'while a range small next to its step keeps the full track',
    narrow.lo === -1 && narrow.hi === 1
  )

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
  shows('while keeping the bounds it always carried', hud, posBounds)
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

  // A sided row places a FAMILY, so at rest it is named for one -- "Square
  // pyramid" read as a row that places square pyramids, which is the one thing
  // it does not do. The member's name is a hover away, on the band that
  // chooses it, and the accessible name stays specific throughout: it says
  // what a drag would place, which a plural cannot.
  shows('a sided row rests under the name of its family', pyramid, '>Pyramids<')
  shows('while still saying what a drag would place', pyramid, 'aria-label="Square pyramid, drag')
  shows('and an unsided one is simply itself', sphere, '>Sphere<')

  // The icon is not a picture of a pyramid, it is the pyramid the row would
  // place -- the base polygon projected, one edge to the apex per corner. That
  // is what lets it follow the sweep across the bands, and spin through the
  // family when the row is left alone.
  const iconOf = (row: string) => row.slice(0, row.indexOf('</svg>'))
  for (const [row, name, kind] of [
    [pyramid, 'pyramid', 'pyramid'],
    [rows.split('<div class="solid-item"').find((r) => r.includes('>Prisms<')) ?? '', 'prism', 'prism'],
  ] as const) {
    const corners = restingSides(kind) ?? 0
    check(
      `the ${name} row draws the solid it rests on, edge by edge`,
      occurrences(iconOf(row), '<line') === corners,
      `${occurrences(iconOf(row), '<line')} edges for ${corners} corners`
    )
  }

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

// --- units on screen --------------------------------------------------------
{
  // The conversion has to be exactly reversible, because every edit makes the
  // round trip: the panel shows a scene length in millimetres, the user drags
  // it, and what comes back has to be a scene length again. A conversion that
  // lost a hair each way would let a value drift every time it was looked at.
  for (const mode of ['mm', 'cm', 'm'] as const) {
    for (const v of [0, 0.005, 0.01, 2, 37.5, 50]) {
      const back = fromDisplay(toDisplay(v, mode), mode)
      near(`${mode} survives the round trip at ${v}`, back, v, 1e-12)
    }
  }

  // One unit is ten centimetres. Everything else in `units.ts` follows from it,
  // so it is worth one check that says so in plain numbers.
  near('one unit is 100 mm', toDisplay(1, 'mm'), 100, 1e-12)
  near('and 10 cm', toDisplay(1, 'cm'), 10, 1e-12)
  near('and a tenth of a metre', toDisplay(1, 'm'), 0.1, 1e-12)
  near('the smallest solid is a millimetre', toDisplay(MIN_DIMENSION, 'mm'), 1, 1e-12)
  near('and the largest is five metres', toDisplay(MAX_SIZE, 'm'), 5, 1e-12)

  // `auto` switches on round numbers in the unit it is LEAVING, so the figure
  // on screen stays readable rather than sliding into zeroes or long tails.
  check('auto shows a millimetre feature in mm', resolveUnit(0.01, 'auto') === 'mm')
  check('and holds mm right up to 10', resolveUnit(0.099, 'auto') === 'mm')
  check('then takes centimetres', resolveUnit(0.1, 'auto') === 'cm')
  check('and keeps them to a metre', resolveUnit(9.99, 'auto') === 'cm')
  check('then metres', resolveUnit(10, 'auto') === 'm')
  check('a five-metre solid reads in metres', resolveUnit(MAX_SIZE, 'auto') === 'm')
  check('zero stays in mm rather than 0.000 m', resolveUnit(0, 'auto') === 'mm')
  check('and sign does not change the choice', resolveUnit(-4, 'auto') === resolveUnit(4, 'auto'))
  check('a fixed mode ignores magnitude', resolveUnit(50, 'mm') === 'mm')

  // The whole point of converting bounds and step together: a pixel of drag
  // must be worth the same distance in the WORLD whichever unit is on screen,
  // or switching units would silently change how the controls feel.
  const perPixel = (['mm', 'cm', 'm'] as const).map((mode) =>
    fromDisplay(
      scrubTravel(1, toDisplay(-MAX_SIZE, mode), toDisplay(MAX_SIZE, mode), stepIn(0.05, mode)),
      mode
    )
  )
  near('a pixel is worth the same in cm as in mm', perPixel[1], perPixel[0], 1e-12)
  near('and the same again in metres', perPixel[2], perPixel[0], 1e-12)
  // The first pixel is the step plus the very start of the ramp, so this is
  // 'about a step' rather than exactly one. The equality that matters -- that
  // all three units agree -- is asserted exactly, just above.
  near('at about the step the control is written in', perPixel[0], 0.05, 1e-3)

  // And the selector itself, which lives in the BAR rather than on the island:
  // a unit is a reading of the whole document, not a mode aimed at the solid
  // under the pointer. It is inside Settings now -- the cog at the end of the
  // row -- because it shares that property with the theme and with nothing else
  // in the bar: neither touches the document.
  useTools.setState({ openPanel: 'settings' })
  const bar = markupOf('NavBar (settings)', NavBar)
  for (const mode of UNIT_MODES) shows(`the bar offers ${mode}`, bar, `>${mode}<`)
  shows('with the current one marked', bar, 'seg-btn seg-active')
  // The menu opens the way the rest of that cluster does -- downwards from the
  // button, right-aligned to it -- which is the class the CSS reads. It matters
  // more here than anywhere else: this is the LAST button in the bar, so a panel
  // opening rightwards would hang off the window entirely.
  shows('and its menu hangs off the button like Export', bar, 'nav-panel nav-panel-right')
  // The hook the width rule reads. Without the class the menu falls back to the
  // shared 268px, which for two rows of short buttons is mostly empty air.
  shows('the groups are marked so the panel can fit them', bar, 'settings-groups')
  shows('the unit row keeps its own hook', bar, 'tool-group units-modes')
  shows('and the theme row has one of its own', bar, 'tool-group theme-modes')
  shows('and so does the outline row', bar, 'tool-group outline-modes')
  // Both groups are captioned. With two unlabelled rows of short buttons in one
  // panel, `mm cm auto` over `Dark` is a puzzle rather than a menu -- and the
  // captions are the only thing naming what either row does now that neither
  // has a button in the bar carrying its name.
  shows('the unit group is captioned', bar, '<p class="subhead">Units</p>')
  shows('and so is the theme group', bar, '<p class="subhead">Theme</p>')
  shows('and the outline group', bar, '<p class="subhead">Outlines</p>')
  // Units no longer has a button of its own. The word survives as a caption
  // INSIDE the panel, so this asks after the thing that would prove a stray
  // second control -- a nav button carrying the old icon and label.
  hides('and no longer has a button of its own in the bar', bar, '<span class="nav-label">Units</span>')
  shows('while the cog does', bar, '<span class="nav-label">Settings</span>')
  hides(
    'the island no longer carries it',
    markupOf('ToolIsland (no units)', ToolIsland),
    '>Units<'
  )

  // The other half of the panel, and the reason the two are together. One theme
  // today: the row still has to render as a CHOOSER showing which is on, or the
  // second palette lands on a label nobody built a control for.
  for (const name of THEMES) {
    shows(`the theme row offers ${name}`, bar, `>${THEME_LABELS[name]}<`)
  }
  check(
    'and the app opens in the default one',
    useTools.getState().theme === DEFAULT_THEME,
    useTools.getState().theme
  )
  // Every theme must be selectable and must stick, so a name added to THEMES
  // cannot ship as a dead button.
  for (const name of THEMES) {
    useTools.getState().setTheme(name)
    check(`choosing ${name} holds`, useTools.getState().theme === name, useTools.getState().theme)
  }
  useTools.getState().setTheme(DEFAULT_THEME)

  // The third row. It is a yes-or-no, and the thing worth guarding is that it is
  // still drawn as a CHOOSER: both states named, one lit. A tickbox would leave
  // the off state as an empty square, and the panel would stop being one kind of
  // control -- which is the whole argument for it sitting in here.
  shows('the outline row offers On', bar, '>On<')
  shows('and Off', bar, '>Off<')
  check(
    'the app opens with the outlines drawn',
    useTools.getState().showOutlines === true,
    String(useTools.getState().showOutlines)
  )
  useTools.getState().setShowOutlines(false)
  check(
    'switching them off holds',
    useTools.getState().showOutlines === false,
    String(useTools.getState().showOutlines)
  )
  // And back, because everything after this reads a scene that is meant to be
  // in its default dress.
  useTools.getState().setShowOutlines(true)
  check('and back on again', useTools.getState().showOutlines === true)

  // A preference nothing reads is worse than no preference at all: the switch
  // would move, hold its state, and change nothing on screen. The edges are
  // drawn deep inside a fibre tree this headless check cannot mount, so the
  // guard is on the source -- the `<Edges>` block must be gated on the flag,
  // alongside the drag gate that was already there.
  check(
    'and the scene actually gates its edge lines on the switch',
    readFileSync(new URL('../src/viewport/SceneObjects.tsx', import.meta.url), 'utf8').includes(
      '{showOutlines && !dragging && ('
    ),
    'the switch would hold a state nothing in the viewport reads'
  )

  // It is not an island panel any more, so collapsing the island must leave it
  // alone. The invariant that DOES shut a panel with the island is asserted
  // where the panels it still owns are -- snap and ruler.
  useTools.getState().setIslandCollapsed(true)
  check(
    'collapsing the island leaves the settings menu open',
    useTools.getState().openPanel === 'settings'
  )
  // WHAT THE PANEL SAYS IT IS WRITTEN IN has to be what its rows are actually
  // written in, and under `auto` that is a fact about the object rather than
  // about the app. One panel, two solids, two answers -- and the rows move with
  // the badge, which is the whole reason it can be said once at the top.
  useTools.setState({ displayUnit: 'auto' })
  const measured = doc().addObject({ kind: 'box', size: [0.02, 0.02, 0.02] }, [0, 0, 0])
  doc().selectObject(measured)
  const inMm = markupOf('ObjectPanel (2 mm cube)', ObjectPanel)
  check('a two-millimetre solid reads in mm', badgeIn(inMm) === 'mm', badgeIn(inMm))
  shows('and its rows are the millimetres it named', inMm, 'value="2"')
  hides('with no row saying it again', inMm, 'class="field-unit"')

  doc().patchObject(measured, { base: { kind: 'box', size: [30, 30, 30] } })
  const inM = markupOf('ObjectPanel (3 m cube)', ObjectPanel)
  check('a three-metre one reads in metres', badgeIn(inM) === 'm', badgeIn(inM))
  shows('and its rows follow the header', inM, 'value="3"')

  // ONE unit for the whole panel, taken from the largest of its lengths -- the
  // rule `Vec3Field` already keeps across its three rows, one level up. A panel
  // whose rows each chose their own could not be labelled in one word.
  doc().patchObject(measured, { base: { kind: 'box', size: [30, 0.02, 0.02] } })
  const mixed = markupOf('ObjectPanel (mixed)', ObjectPanel)
  check('a panel with a wide range of lengths still says one', badgeIn(mixed) === 'm', badgeIn(mixed))
  shows('the largest reading in it', mixed, 'value="3"')
  shows('and the smallest in the same unit', mixed, 'value="0.002"')

  doc().removeObject(measured)
  useTools.setState({ islandCollapsed: false, openPanel: null, displayUnit: 'cm' })
}

console.log('\nThe ruler measures the scene without joining it')
{
  const tools = () => useTools.getState()

  // At rest the tool is a switch with nothing behind it, which is the state
  // every session opens in.
  check('no rulers until one is asked for', tools().rulers.length === 0)
  check('and the tool is disarmed', tools().rulerActive === false)

  // One press does the whole of what pressing it ever means: arm the tool AND
  // lay a ruler down. A switch that turns on and shows nothing reads as broken.
  tools().setRulerActive(true)
  check('arming lays exactly one ruler down', tools().rulers.length === 1)
  const first = tools().rulers[0]
  near('a fresh ruler is 50 mm', rulerLength(first), RULER_LENGTH, 1e-12)
  near('which is half a scene unit', RULER_LENGTH, 0.5, 1e-12)
  check(
    'and it lands selected, on its first end',
    tools().selectedRuler?.id === first.id && tools().selectedRuler?.end === 0
  )

  // Arming an already-populated tool must not keep breeding rulers: Add in the
  // panel is the way to a second one, and the button is a switch.
  tools().setRulerActive(false)
  tools().setRulerActive(true)
  check('re-arming does not add another', tools().rulers.length === 1)

  // Disarming HIDES. A ruler took two snapped ends to place, and a stray click
  // on the switch must not throw that away -- but the handles go with it, since
  // a gizmo over something nobody can see is a handle onto nothing.
  tools().setRulerActive(false)
  check('disarming keeps the rulers', tools().rulers.length === 1)
  check('and drops the selection with them', tools().selectedRuler === null)
  tools().setRulerActive(true)

  // A second one, from the panel. It lands selected, so the ruler just asked
  // for is the one carrying the handles.
  tools().addRuler()
  check('Add lays down another', tools().rulers.length === 2)
  const second = tools().rulers[1]
  check('and takes the selection', tools().selectedRuler?.id === second.id)
  check('leaving the first one alone', tools().rulers[0].id === first.id)

  // Consecutive rulers are stepped sideways rather than dropped on one line,
  // where the second would be hidden exactly by the first. Stated as the rule
  // rather than as a transcript of two positions.
  const lanes = [0, 1].map((n) => rulerSpawn(n))
  check(
    'each new ruler is stepped clear of the last',
    lanes[0][0][2] !== lanes[1][0][2],
    `${lanes[0][0][2]} vs ${lanes[1][0][2]}`
  )
  check(
    'and the step wraps, so the ninth is not a metre off screen',
    JSON.stringify(rulerSpawn(8)) === JSON.stringify(rulerSpawn(0))
  )
  for (const lane of [0, 3, 7]) {
    near(
      `lane ${lane} still measures 50 mm`,
      rulerLength({ id: 'probe', ends: rulerSpawn(lane) }),
      RULER_LENGTH,
      1e-12
    )
  }

  // And the lane runs from a FRAME, which is what makes a ruler land next to the
  // thing being measured AND in front of it. The scene is five metres across, so
  // a 50 mm line dropped at the origin while the work is in the corner is a
  // button that looks like it did nothing -- and one dropped behind the solid,
  // or laid end-on to the camera, looks exactly the same.
  //
  // `useDoc` rather than the `doc()` helper: this block declares a `doc` of its
  // own further down, for the check that measuring never touches the document.
  const measuredId = useDoc.getState().addObject({ kind: 'box', size: [2, 2, 2] }, [4, 1, -3])
  const measured = useDoc.getState().doc.objects.find((o) => o.id === measuredId)
  check('a solid to measure', measured !== undefined)
  if (measured) {
    const box = objectBounds(measured)
    const centre = box.getCenter(new Vector3())
    const corners: Vector3[] = []
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) corners.push(new Vector3(x, y, z))
      }
    }

    /** A camera standing at `from`, looking at `at`. Oriented the way the
     *  compass orients one, so the check and the app agree on what facing is. */
    const cameraAt = (from: Vec3, at: Vec3) => {
      const eye = new Vector3(...from)
      const focus = new Vector3(...at)
      return { facing: viewQuaternion(eye.clone().sub(focus)), eye, focus }
    }
    /** The direction a camera looks: its own -Z, in world terms. */
    const seen = (facing: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(facing)

    // Every side of it, including the two a fixed world axis gets wrong: from
    // behind, a ruler pushed along +Z is inside the solid, and from the right it
    // is end-on to a camera looking down the axis it lies along.
    const stations: Array<[string, Vec3]> = [
      ['from the front', [centre.x, centre.y, centre.z + 6]],
      ['from behind', [centre.x, centre.y, centre.z - 6]],
      ['from the right', [centre.x + 6, centre.y, centre.z]],
      ['from above', [centre.x, centre.y + 6, centre.z]],
      ['down the corner', [centre.x + 4, centre.y + 3, centre.z + 4]],
    ]

    for (const [where, from] of stations) {
      const camera = cameraAt(from, [centre.x, centre.y, centre.z])
      const view = seen(camera.facing)
      const depth = (p: Vec3) => new Vector3(...p).sub(camera.eye).dot(view)
      const frame = rulerFrame(measured, camera)
      const nearest = Math.min(...corners.map((c) => c.clone().sub(camera.eye).dot(view)))

      // The one that matters: the solid cannot hide it, wherever the eye is.
      // The last lane as well as the first, since the step must not spend the
      // clearance the push bought.
      for (const lane of [0, 7]) {
        const ends = rulerSpawn(lane, frame)
        check(
          `${where}, lane ${lane} stands nearer the eye than the whole solid`,
          depth(ends[0]) < nearest && depth(ends[1]) < nearest,
          `${Math.min(depth(ends[0]), depth(ends[1])).toFixed(4)} vs ${nearest.toFixed(4)}`
        )
        near(
          `${where}, lane ${lane} still measures 50 mm`,
          rulerLength({ id: 'probe', ends }),
          RULER_LENGTH,
          1e-12
        )
        // Both ends at one depth is "not end-on" said where it bites: a ruler
        // whose ends sit at different depths is one turned away from the
        // camera, and at the limit it is a dot.
        near(`${where}, lane ${lane} lies across the view`, depth(ends[0]), depth(ends[1]), 1e-12)
      }

      // Consecutive rulers step ACROSS the view, never into it: stepped along
      // the view axis they would stack in depth and read as one ruler.
      const first = rulerSpawn(0, frame)
      const second = rulerSpawn(1, frame)
      near(`${where}, the next lane keeps its distance`, depth(second[0]), depth(first[0]), 1e-12)
      check(
        `${where}, and is somewhere else on screen`,
        new Vector3(...second[0]).distanceTo(new Vector3(...first[0])) > 1e-6
      )

      // Sideways it stays over the object: the push is purely along the view,
      // so what moved is the depth and nothing else.
      const shift = new Vector3(...frame.anchor).sub(centre)
      near(
        `${where}, the ruler lands over the middle of the solid`,
        shift.clone().addScaledVector(view, -shift.dot(view)).length(),
        0,
        1e-12
      )
    }

    // Nothing selected: the point the camera orbits, which is the middle of the
    // viewport whatever the user has done to the view. The origin would be off
    // screen the moment anyone panned away from it.
    const panned = cameraAt([20, 20, 20], [12, 1, -3])
    const loose = rulerFrame(null, panned)
    check(
      'with nothing selected a ruler lands where the camera is looking',
      JSON.stringify(loose.anchor) === JSON.stringify([12, 1, -3]),
      loose.anchor.join()
    )

    // And the one case the push cannot satisfy: a camera standing INSIDE what it
    // is measuring wants the ruler behind its own head. It is held out in front
    // instead, which is the only place it could be seen from. Built rather than
    // added to the document -- a solid this size is not a scene anyone has, and
    // the point is the arithmetic.
    const giant = makeObject({ kind: 'box', size: [50, 50, 50] }, [0, 25, 0])
    const inside = cameraAt([0, 25, 1], [0, 25, 0])
    const held = rulerFrame(giant, inside)
    const ahead = new Vector3(...held.anchor).sub(inside.eye).dot(seen(inside.facing))
    check('a camera inside a solid still gets a ruler in front of it', ahead > 0, `${ahead}`)
    near('held out at the standoff', ahead, RULER_LENGTH, 1e-12)

    // The button carries the frame through to the store, which is the half of
    // this a pure spawn function cannot state. Which LANE the next ruler takes
    // is the id counter's business, so what is pinned is the frame: centred on
    // the anchor's lane line, running along the frame's own axis.
    const front = cameraAt([centre.x, centre.y, centre.z + 6], [centre.x, centre.y, centre.z])
    const frame = rulerFrame(measured, front)
    const along = new Vector3(...frame.along)
    const step = new Vector3(...frame.step)
    tools().addRuler(frame)
    const laid = tools().rulers[tools().rulers.length - 1]
    const ends = laid.ends.map((e) => new Vector3(...e))
    const mid = ends[0].clone().add(ends[1]).multiplyScalar(0.5)
    const off = mid.sub(new Vector3(...frame.anchor))
    near(
      'a ruler laid down through the store runs along the frame',
      ends[1].clone().sub(ends[0]).normalize().dot(along),
      1,
      1e-12
    )
    near(
      'and sits on the lane line through its anchor',
      off.clone().addScaledVector(step, -off.dot(step)).length(),
      0,
      1e-12
    )
    // Put the count back: the deletion checks below count what is here.
    tools().removeRuler(laid.id)
  }

  // Moving an end moves that end and nothing else -- the invariant behind
  // `setRulerEnd` rebuilding the pair rather than writing through it.
  const before = tools().rulers[0].ends[0]
  tools().setRulerEnd(first.id, 1, [0.5, 0, 0])
  const moved = tools().rulers.find((r) => r.id === first.id)
  check('the ruler survives the write', moved !== undefined)
  if (moved) {
    check('one end moves', JSON.stringify(moved.ends[1]) === JSON.stringify([0.5, 0, 0]))
    check('and the other stays', JSON.stringify(moved.ends[0]) === JSON.stringify(before))
    near(
      'so the reading follows the ends',
      rulerLength(moved),
      Math.hypot(0.5 - before[0], -before[1], -before[2]),
      1e-12
    )
  }

  // Deleting clears a selection pointing at what was deleted, and only that: a
  // selection left pointing at a ruler that is gone would leave the gizmo drawn
  // where it last stood, grabbable, writing to nothing.
  tools().selectRuler({ id: first.id, end: 0 })
  tools().removeRuler(second.id)
  check('deleting one leaves the rest', tools().rulers.length === 1)
  check('and does not disturb a selection elsewhere', tools().selectedRuler?.id === first.id)
  tools().removeRuler(first.id)
  check('deleting the selected one clears the selection', tools().selectedRuler === null)
  check('and the tool is left empty rather than switched off', tools().rulerActive === true)

  // Empty and armed is a reachable state, so arming out of it has to lay one
  // down again rather than leave a live switch over an empty scene.
  tools().setRulerActive(false)
  tools().setRulerActive(true)
  check('arming an emptied tool lays one down again', tools().rulers.length === 1)

  // The stripes are graduations first: one per centimetre, until there would be
  // too many to see, and evenly spaced from then on. Stated as the rule.
  const stripesIn = (length: number) => Math.round(0.5 / stripeFraction(length))
  check('a 50 mm ruler is ruled in centimetres', stripesIn(0.5) === 5, `${stripesIn(0.5)}`)
  check('and a 20 cm one likewise', stripesIn(2) === 20, `${stripesIn(2)}`)
  check('past the cap the count stops climbing', stripesIn(20) === 40, `${stripesIn(20)}`)
  check('and a ruler shorter than one stripe still gets one', stripesIn(0.01) === 1)

  // Nothing a ruler does is an edit. The whole reason it lives in the tool
  // store is that measuring must not land in undo history, so a user rewinding
  // an edit does not first have to walk back through their own measuring.
  const doc = useDoc.getState().doc
  tools().addRuler()
  tools().setRulerEnd(tools().rulers[0].id, 0, [1, 1, 1])
  check('measuring never touches the document', useDoc.getState().doc === doc)

  // And the panel that manages them. It hangs off the caret beside the switch,
  // which is what makes one ruler a single click and the rest a list.
  tools().setOpenPanel('ruler')
  const island = markupOf('ToolIsland (rulers)', ToolIsland)
  shows('the island carries the ruler tool', island, '>Ruler<')
  shows('with a way to add another', island, 'Add ruler')
  shows('every ruler is listed by name', island, '>Ruler 1<')
  shows('and the second one too', island, '>Ruler 2<')
  shows(
    'each row carries what it reads, in the island unit',
    island,
    formatLength(rulerLength(tools().rulers[0]), SHOWN)
  )
  shows('the selected row is marked', island, 'ruler-row ruler-row-on')
  shows('and every row carries a delete control', island, 'aria-label="Delete ruler 1"')

  // The readouts are DOM nodes outside the canvas -- one per ruler, marked so
  // the selected one's reading carries the weight its line does. Empty on the
  // way out of the server render, because where each one SITS is projected from
  // the camera and written in by a frame loop that never runs here; what is
  // being pinned is that there is a node per ruler at all, and that the tool
  // being off leaves none of them behind.
  const chips = markupOf('RulerReadouts', RulerReadouts)
  check(
    'a readout per ruler',
    (chips.match(/class="ruler-chip/g) ?? []).length === tools().rulers.length,
    `${(chips.match(/class="ruler-chip/g) ?? []).length} for ${tools().rulers.length}`
  )
  shows('with the selected one marked', chips, 'ruler-chip ruler-chip-on')
  shows('and each one hidden until it has been placed', chips, 'display:none')
  tools().setRulerActive(false)
  check(
    'and none at all with the tool off',
    renderToStaticMarkup(createElement(RulerReadouts)) === '',
    'a disarmed RulerReadouts renders nothing'
  )
  tools().setRulerActive(true)

  // The empty branch says so out loud: this list is also the answer to "where
  // did my ruler go", and a blank panel does not tell "none" from "not loaded".
  for (const ruler of [...tools().rulers]) tools().removeRuler(ruler.id)
  shows('an empty list says so', markupOf('ToolIsland (no rulers)', ToolIsland), 'No rulers yet.')

  // It is an island panel like the others, so shutting the island shuts it --
  // otherwise it springs back the next time the island opens, from a click
  // nobody made.
  tools().setIslandCollapsed(true)
  check('collapsing the island shuts the ruler panel', tools().openPanel === null)
  useTools.setState({
    islandCollapsed: false,
    rulerActive: false,
    rulers: [],
    selectedRuler: null,
  })
}

console.log('\nThe ground grid writes the same depth as everything it is tested against')
{
  // This canvas runs with a LOGARITHMIC depth buffer, which every built-in
  // material answers by writing `gl_FragDepth` itself. drei's Grid is a custom
  // ShaderMaterial and answers nothing, so its depth used to land on the
  // hardware's own curve -- not comparable with any solid's, and nowhere near
  // fine enough to separate two grids half a thousandth of a unit apart. The
  // patch that fixes it is string surgery on somebody else's shader, so the
  // first thing checked is that the strings are still there.
  //
  // Read from node_modules, the same bargain the axis colours strike with
  // styles.css: a drei upgrade that reworded any one of these would put the
  // shimmer back silently, and nothing else in the app would notice.
  const grid = readFileSync(
    createRequire(import.meta.url).resolve('@react-three/drei/core/Grid.js'),
    'utf8'
  )
  const occurrences = (needle: string) => grid.split(needle).length - 1

  check('drei still declares the grid shader here', grid.includes('shaderMaterial('))
  check(
    'the clip-position line the vertex patch hangs off is still there, once',
    occurrences(GRID_CLIP) === 1,
    `${occurrences(GRID_CLIP)} of ${JSON.stringify(GRID_CLIP)}`
  )
  check(
    'and the first line of the fragment body, once',
    occurrences(GRID_BODY) === 1,
    `${occurrences(GRID_BODY)} of ${JSON.stringify(GRID_BODY)}`
  )
  // Two: one per shader. More would mean the fragment patch could land on the
  // wrong function, since it takes the first.
  check(
    'and one main() in each of the two shaders',
    occurrences(GRID_MAIN) === 2,
    `${occurrences(GRID_MAIN)}`
  )
  // `getGrid` is declared above main and must not look like one, or the
  // fragment pars would be spliced into the middle of it.
  check(
    'the helper above main is not itself a main()',
    grid.includes('float getGrid(float size, float thickness) {')
  )
  // The whole reason the patch is needed: drei includes tone mapping and colour
  // space, and no log depth at all.
  check('drei resolves includes in that shader', grid.includes('#include <tonemapping_fragment>'))
  check('but includes no log depth of its own', !grid.includes('logdepthbuf'))

  // And that the patch does what it says on a shader carrying those anchors.
  const patched = {
    vertexShader: `varying vec4 worldPosition;\n${GRID_MAIN}\n  ${GRID_CLIP}\n}`,
    fragmentShader: `float getGrid(float s, float t) { return 0.0; }\n${GRID_MAIN}\n      ${GRID_BODY}\n}`,
  }
  withLogDepth(patched)

  shows('the vertex shader keeps the varyings', patched.vertexShader, 'varying float vFragDepth')
  shows('and fills them in after the clip position', patched.vertexShader, 'vFragDepth = 1.0 + gl_Position.w')
  // `logdepthbuf_vertex` calls `isPerspectiveMatrix`, which lives in <common>
  // -- and drei's vertex shader includes no chunks at all, so the patch has to
  // bring it. Without this the shader does not compile and the grid vanishes.
  shows('with <common> for isPerspectiveMatrix', patched.vertexShader, '#include <common>')
  check(
    'and the fill lands AFTER the clip position it reads',
    patched.vertexShader.indexOf('vFragDepth = 1.0 + gl_Position.w') >
      patched.vertexShader.indexOf(GRID_CLIP),
    'the chunk reads gl_Position.w, so it cannot run before it is set'
  )

  shows('the fragment shader takes the uniform', patched.fragmentShader, 'uniform float logDepthBufFC')
  shows('and writes the depth itself', patched.fragmentShader, 'gl_FragDepth =')
  check(
    'before the body it belongs to',
    patched.fragmentShader.indexOf('gl_FragDepth =') <
      patched.fragmentShader.indexOf(GRID_BODY),
    'three puts the chunk at the top of main'
  )
  // The declarations have to be OUTSIDE main, or they are locals and the
  // fragment stage never sees what the vertex stage wrote.
  check(
    'and the varyings are declared outside main, not in it',
    patched.fragmentShader.indexOf('varying float vFragDepth') <
      patched.fragmentShader.indexOf(GRID_MAIN)
  )

  // A shader with none of the anchors is left exactly as it was rather than
  // half-patched -- which is what lets the component notice and say so.
  const foreign = { vertexShader: 'void other() {}', fragmentShader: 'void other() {}' }
  const untouched = foreign.vertexShader + foreign.fragmentShader
  withLogDepth(foreign)
  check(
    'a shader it does not recognise comes back untouched',
    foreign.vertexShader + foreign.fragmentShader === untouched
  )
}

console.log('\nTwo objects sharing one surface are separated by a bias the log buffer can carry')
{
  // The tiebreak between coplanar faces of two DIFFERENT objects used to be a
  // polygon offset, and under this canvas that is dead weight: the log depth
  // buffer makes every material write `gl_FragDepth` itself, and polygon offset
  // is applied by the rasterizer to the depth that assignment discards. Merged
  // solids never showed it -- a union deletes the shared surface outright --
  // so the tearing only ever came back on objects left separate.
  //
  // The premise is checked first. If the canvas ever stops asking for the log
  // buffer, the bias below is the wrong mechanism and the offset was the right
  // one; either way that must not be discovered by eye.
  const source = (name: string) =>
    readFileSync(new URL(`../src/viewport/${name}`, import.meta.url), 'utf8')
  check(
    'the canvas still asks for a logarithmic depth buffer',
    source('Viewport.tsx').includes('logarithmicDepthBuffer: true'),
    'without it the tiebreak has to go back to being a polygon offset'
  )
  check(
    'and no solid still carries an offset that cannot reach the buffer',
    !source('SceneObjects.tsx').includes('polygonOffset')
  )

  // String surgery on three's own shader, so the anchor is read out of
  // node_modules the same way the grid's are read out of drei's.
  const standard = ShaderLib.standard.fragmentShader
  const occurrences = (needle: string) => standard.split(needle).length - 1
  check(
    'three still writes its log depth from that one chunk',
    occurrences(BIAS_ANCHOR) === 1,
    `${occurrences(BIAS_ANCHOR)} of ${JSON.stringify(BIAS_ANCHOR)}`
  )

  const patched = { fragmentShader: standard }
  withDepthBias(patched)
  shows('the patch declares its uniform', patched.fragmentShader, `uniform float ${BIAS_UNIFORM};`)
  shows(
    'and subtracts it from the depth',
    patched.fragmentShader,
    `gl_FragDepth -= ${BIAS_UNIFORM};`
  )
  // Outside main(), or it is a local the program has no uniform to upload to.
  check(
    'the declaration is outside main(), not in it',
    patched.fragmentShader.indexOf(`uniform float ${BIAS_UNIFORM};`) <
      patched.fragmentShader.indexOf('void main() {')
  )
  // The whole lesson of the bug: that chunk ASSIGNS gl_FragDepth, so anything
  // applied before it is thrown away -- which is exactly what happened to the
  // polygon offset.
  check(
    'and the subtraction lands after the chunk that assigns the depth',
    patched.fragmentShader.indexOf(`gl_FragDepth -= ${BIAS_UNIFORM};`) >
      patched.fragmentShader.indexOf(BIAS_ANCHOR)
  )
  // Guarded on the define the chunk itself is guarded on: with the log buffer
  // off nothing writes gl_FragDepth, and this must not be the one thing that
  // starts -- a shader that writes depth gives up early-Z for every solid.
  shows(
    'guarded on the define that turns the chunk on',
    patched.fragmentShader,
    '#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )'
  )

  const stranger = { fragmentShader: 'void main() {}' }
  withDepthBias(stranger)
  check(
    'a shader it does not recognise comes back untouched',
    stranger.fragmentShader === 'void main() {}'
  )

  // And the material carries the bias as a UNIFORM rather than as shader text:
  // one compiled program for the whole scene, and moving an object up the tree
  // changes a number the next frame uploads.
  const material = new BiasedStandardMaterial()
  const shader = {
    fragmentShader: standard,
    uniforms: {},
  } as unknown as WebGLProgramParametersWithUniforms
  material.onBeforeCompile(shader)
  // Set AFTER compiling, so this passes only if the program holds the same
  // object the setter writes through.
  material.depthBias = BIAS_STEP
  check(
    'the compiled program holds the bias the material writes through',
    (shader.uniforms[BIAS_UNIFORM] as { value: number } | undefined)?.value === BIAS_STEP,
    `${(shader.uniforms[BIAS_UNIFORM] as { value: number } | undefined)?.value}`
  )
  check('and the material reads it back', material.depthBias === BIAS_STEP)
  // Three keys programs by this string, and for a patched material it is the
  // source text of onBeforeCompile. A method on the prototype is one string for
  // every instance; a closure per material would recompile once per object.
  check(
    'every instance shares one program cache key',
    material.customProgramCacheKey() === new BiasedStandardMaterial().customProgramCacheKey()
  )
}


// --- The torch's controls ---------------------------------------------------
console.log('\nThe erode tool says what it will melt before it melts it')
{
  const erode = markupOf('ErodeTool', ErodeTool)
  shows('the blowtorch is in the island', erode, 'Blowtorch')
  shows('and rests disarmed', erode, 'aria-pressed="false"')

  // The three numbers. Size is a LENGTH and carries a unit; the other two are
  // ratios and must not, or the app would offer to set Heat in millimetres.
  tools().setOpenPanel('erode')
  const panel = markupOf('ErodeTool (open)', ErodeTool)
  shows('its panel offers a brush size', panel, '>Brush size<')
  shows('a heat', panel, '>Heat<')
  shows('and a smoothing', panel, '>Smoothing<')

  {
    // THE BRUSH SIZE OWNS ITS UNIT, and it is the only length in the app that
    // does. Under `auto` -- the app's own default -- one drag of this slider
    // crosses both of `resolveUnit`'s switching points, and the number under
    // the pointer goes 9.9, 1.00, 99.9, 1.00 while the hand travels one way.
    // That is correct for reading a length and wrong for setting one.
    tools().setDisplayUnit('auto')
    const auto = markupOf('ErodeTool (app on auto)', ErodeTool)
    shows('the brush size carries a unit picker', auto, 'aria-label="Brush size unit"')
    shows('offering millimetres', auto, '>mm<')
    shows('and centimetres', auto, '>cm<')
    // `auto` is a rule for choosing a unit, not a unit. Offered here it would be
    // the very thing this control exists to keep off the field.
    hides('and never auto, whatever the app is set to', auto, '>auto<')
    check(
      'it opens in centimetres',
      tools().erodeSizeUnit === 'cm',
      tools().erodeSizeUnit
    )
    // 0.3 scene units is 3 cm. The app-wide mode is `auto`, which at 0.3 units
    // would resolve to centimetres too -- so the field is driven to a unit auto
    // would NOT pick, and read back, or the pin proves nothing.
    tools().setDisplayUnit('mm')
    const pinned = markupOf('ErodeTool (app on mm)', ErodeTool)
    shows('and stays there when the app goes to millimetres', pinned, 'value="3"')

    // Picking one changes the SPELLING and not the brush: the radius is held in
    // scene units and never passes through the picker.
    const before = tools().erodeRadius
    tools().setErodeSizeUnit('mm')
    const asMm = markupOf('ErodeTool (in mm)', ErodeTool)
    shows('picking millimetres restates the same brush', asMm, 'value="30"')
    check('and does not resize it', tools().erodeRadius === before, `${tools().erodeRadius}`)
    tools().setErodeSizeUnit('cm')
    tools().setDisplayUnit('cm')
  }

  {
    // AND THE STYLESHEET LETS IT BE SEEN. The markup above passed for as long
    // as the panel has existed while nothing was drawn on screen: the island
    // was on the cut-corner list, and a clip-path clips an element's
    // DESCENDANTS to its own border box whatever its outline -- so at
    // `--notch: 0px`, where the polygon is the plain rectangle and the rule
    // looks inert, the island still cut away every panel that opens sideways
    // clear of its 176px. The panel measured 268 x 210 at full opacity and was
    // painted nowhere.
    //
    // Pinned as "the island itself is not on the list", because putting it back
    // is a one-word edit and no render check can see it: the island carries the
    // shape on `.tool-island::before` instead, which clips only itself.
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const notched = css.split(/^\.nav-panel,$/m)[1]?.split('{')[0] ?? ''
    check(
      'the cut corner is on the island backdrop',
      notched.includes('.tool-island::before'),
      notched.trim()
    )
    check(
      'and never on the island, which the panels open outside of',
      !/^\.tool-island,$/m.test(notched),
      notched.trim()
    )
    const island = css.split('.tool-island {')[1]?.split('}')[0] ?? ''
    check('so nothing clips the island itself', !island.includes('clip-path'), island.trim())
  }

  // It hangs off a button INSIDE the island, so shutting the island shuts it
  // too -- a panel left open behind a body that has gone off screen springs
  // back the next time the island does, from a click nobody made. The ruler
  // list has always done this; the torch's numbers arrived in the island after
  // `ISLAND_PANELS` was written and were missed.
  tools().setIslandCollapsed(true)
  check('collapsing the island shuts the erode panel', tools().openPanel === null, `${tools().openPanel}`)
  tools().setIslandCollapsed(false)
  check('and it does not spring back when the island reopens', tools().openPanel === null, `${tools().openPanel}`)

  tools().setOpenPanel(null)

  // The scope picker is NOT in that panel. It is over the scene, and only while
  // a brush is armed -- see `BrushScopePanel` for why a brush cannot afford to
  // keep its aim inside a popover.
  hides('the scope is not buried in the panel', panel, 'What the blowtorch melts')
  // Not `markupOf`, which counts an empty render as a failure: rendering
  // nothing at all is exactly the claim here, and it is stronger than "the
  // markup happens not to contain a panel".
  check(
    'and the corner is empty with both brushes down',
    renderToStaticMarkup(createElement(BrushScopePanel)) === '',
    'disarmed BrushScopePanel renders nothing'
  )

  tools().setBrushTool('torch')
  const scope = markupOf('BrushScopePanel (torch)', BrushScopePanel)
  shows('arming it puts the scope over the scene', scope, 'brush-scope-panel')
  shows('offering everything', scope, '>Everything<')
  shows('or the selection alone', scope, '>Selected only<')
  shows('with everything lit by default', scope, 'aria-pressed="true"')
  // The corner says WHICH brush it is aiming, in words and in the class the
  // stylesheet tints from -- the same red-and-green pair the ghost wears.
  shows('and names the torch', scope, 'Blowtorch melts')
  shows('wearing the torch tint', scope, 'brush-scope-torch')

  tools().setBrushTool('sculpt')
  const sculptScope = markupOf('BrushScopePanel (sculpt)', BrushScopePanel)
  shows('the sculpt tool gets the same corner', sculptScope, 'brush-scope-panel')
  shows('named for what it does', sculptScope, 'Sculpt raises')
  shows('and tinted apart from the torch', sculptScope, 'brush-scope-sculpt')
  hides('with no talk of melting', sculptScope, 'Blowtorch melts')
  tools().setBrushTool('torch')

  // "Selected only" with nothing selected is a brush that passes over every
  // solid in the scene, which from the outside is a broken tool. Said out loud.
  doc().selectObject(null)
  tools().setBrushScope('selected')
  shows(
    'selecting nothing to melt is called out',
    markupOf('BrushScopePanel (empty selection)', BrushScopePanel),
    'the torch will pass over everything'
  )

  const torchable = doc().addObject({ kind: 'box', size: [1, 1, 1] }, [0, 0, 0])
  doc().selectObject(torchable)
  hides(
    'and the warning goes once something is picked',
    markupOf('BrushScopePanel (with selection)', BrushScopePanel),
    'the torch will pass over everything'
  )

  // THE RULE ITSELF, which the ghost, the press and the stroke all read. Three
  // consumers, so it is stated once here rather than three times by accident.
  {
    const other = doc().addObject({ kind: 'sphere', radius: 0.4 }, [3, 0, 0])
    const scene = doc().doc
    const picked = [torchable]
    check(
      'with everything in scope the brush works what it points at',
      brushAllows(scene, picked, 'all', other),
      other
    )
    check(
      'with the selection in scope it works the selected one',
      brushAllows(scene, picked, 'selected', torchable),
      torchable
    )
    check(
      'and passes over the rest',
      !brushAllows(scene, picked, 'selected', other),
      other
    )
    // An eraser is a tool sitting in the scene, not a solid. Melting one would
    // be melting the knife rather than the bread. Built by hand: `erase` is a
    // document field the palette sets at creation, not a switch on an object.
    const eraser: Doc = {
      objects: [{ ...makeObject({ kind: 'box', size: [1, 1, 1] }, [6, 0, 0]), id: 'ghost', erase: true }],
    }
    check(
      'an eraser is never brushed, whatever the scope says',
      !brushAllows(eraser, ['ghost'], 'all', 'ghost'),
      'ghost'
    )
    doc().removeObject(other)
  }

  doc().removeObject(torchable)
  tools().setBrushScope('all')
  tools().setBrushTool(null)

  // The bounds are the store's, so a typed value and a scrubbed one cannot
  // disagree about the limit.
  tools().setErodeRadius(999)
  check('the brush size is held to its ceiling', tools().erodeRadius === BRUSH_RADIUS_MAX, `${tools().erodeRadius}`)
  tools().setErodeRadius(-4)
  check('and its floor', tools().erodeRadius === BRUSH_RADIUS_MIN, `${tools().erodeRadius}`)
  tools().setErodeRadius(DEFAULT_BRUSH_RADIUS)
  tools().setErodeHeat(5)
  tools().setErodeSmooth(-1)
  check('heat is a ratio', tools().erodeHeat === 1, `${tools().erodeHeat}`)
  // Smoothing does NOT bottom out at zero, and the floor is geometry rather
  // than taste: a point melted with no flow at all collapses the ring around it
  // and grows a spur where it should have flattened. See BRUSH_SMOOTH_MIN.
  check(
    'smoothing bottoms out above zero',
    tools().erodeSmooth === BRUSH_SMOOTH_MIN,
    `${tools().erodeSmooth}`
  )
  tools().setErodeSmooth(2)
  check('and tops out at one', tools().erodeSmooth === 1, `${tools().erodeSmooth}`)
  tools().setErodeHeat(DEFAULT_BRUSH_FORCE)
  tools().setErodeSmooth(DEFAULT_BRUSH_SMOOTH)

  // THE STROKE AS THE DOCUMENT SEES IT. A drag lays many dabs and must cost one
  // undo step, the same bargain every other drag in this app strikes -- a groove
  // that took eighty pointer moves to cut must not take eighty presses of undo
  // to remove.
  {
    const torched = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1.5, 0])
    const erosionOf = () => doc().doc.objects.find((o) => o.id === torched)?.erosion ?? []
    const entries = doc().past.length

    doc().startErode(torched, false)
    check('the torch takes its own drag kind', doc().drag.kind === 'erode', doc().drag.kind)
    for (let i = 0; i < 6; i++) {
      doc().erodeAt([-0.5 + i * 0.2, 1, 0], DEFAULT_BRUSH_RADIUS, 0.6, 0.7)
    }
    check('a stroke lays down a dab per step', erosionOf().length === 6, `${erosionOf().length}`)
    check(
      'and costs exactly one undo entry however long it is',
      doc().past.length === entries + 1,
      `${doc().past.length - entries}`
    )
    doc().endDrag()

    // The dab carries the settings that were live when it landed, so turning
    // the heat up afterwards does not retroactively deepen a groove already cut.
    const first = erosionOf()[0]
    check('a dab records the heat it was cut with', first.heat === 0.6, `${first.heat}`)
    check('and the smoothing', first.smooth === 0.7, `${first.smooth}`)
    check('and the brush size', first.radius === DEFAULT_BRUSH_RADIUS, `${first.radius}`)
    // A torch dab is the four fields it has always been. `raise` is written
    // only when it is true -- see `ErodeDab.raise` -- so every object anybody
    // has already melted keeps the evaluator cache key it had.
    check('a torch dab carries no direction flag', !('raise' in first), JSON.stringify(first))

    // One press of undo takes the whole stroke, not the last dab.
    doc().undo()
    check('one undo removes the whole stroke', erosionOf().length === 0, `${erosionOf().length}`)
    doc().redo()
    check('and redo brings all of it back', erosionOf().length === 6, `${erosionOf().length}`)

    // LOCAL SPACE, like every other coordinate in the document -- so a groove
    // stays where it was cut when the object is moved and turned afterwards.
    const before = JSON.stringify(erosionOf())
    doc().setObjectTransform(torched, { position: [4, 2, -3], rotation: [0.4, 0.8, 0] })
    check(
      'moving the object leaves the stroke exactly where it was cut',
      JSON.stringify(erosionOf()) === before,
      'unchanged'
    )

    // A stroke outside a drag writes nothing: the action is the drag's, and a
    // stray call must not edit a document nobody is holding a brush against.
    doc().endDrag()
    doc().erodeAt([0, 0, 0], DEFAULT_BRUSH_RADIUS, 1, 1)
    check('no dab lands without a stroke in flight', erosionOf().length === 6, `${erosionOf().length}`)

    // A RESIZE CARRIES THE MARKS, which is the one thing being in local space
    // does not do for them on its own: a dab is a place and a reach in object
    // units, not an anchor in a surface's parameter space, so a skin pulled out
    // from under one leaves it melting where the solid no longer is.
    {
      const cut = erosionOf()[0]
      doc().scaleObject(torched, 2)
      const scaled = erosionOf()[0]
      near('the scale ring carries the stroke out with the surface', scaled.at[0], cut.at[0] * 2, 1e-9)
      near('on every axis', scaled.at[1], cut.at[1] * 2, 1e-9)
      near('and the brush reach scales with it', scaled.radius, cut.radius * 2, 1e-9)
      check('every dab of the stroke, not just the first', erosionOf().length === 6, `${erosionOf().length}`)
      near('including the last', erosionOf()[5].at[0], 0.5 * 2, 1e-9)

      // One axis alone. The centre follows that axis and only that axis; the
      // reach takes the geometric mean, because a sphere brush has no way to
      // become an ellipsoid and nowhere to write one down if it had.
      const wide = erosionOf()[0]
      doc().patchObject(torched, { base: { kind: 'box', size: [8, 4, 4] } })
      const pulled = erosionOf()[0]
      near('a single-axis resize carries the mark along that axis', pulled.at[0], wide.at[0] * 2, 1e-9)
      near('and leaves the others where they were', pulled.at[1], wide.at[1], 1e-9)
      near('with the reach taking the geometric mean', pulled.radius, wide.radius * Math.cbrt(2), 1e-9)

      // A resize that changed no dimension must not creep the marks around.
      const held = JSON.stringify(erosionOf())
      doc().patchObject(torched, { base: { kind: 'box', size: [8, 4, 4] } })
      check('a resize to the size it already was moves nothing', JSON.stringify(erosionOf()) === held, 'unchanged')
    }

    doc().removeObject(torched)
  }
}

// --- The sculpt tool --------------------------------------------------------
console.log('\nThe sculpt tool is the torch backwards, and says so')
{
  const sculpt = markupOf('SculptTool', SculptTool)
  shows('the sculpt tool is in the island', sculpt, 'Sculpt')
  shows('and rests disarmed', sculpt, 'aria-pressed="false"')

  // The same three questions the torch asks, with the one word that would be a
  // lie changed. Heat is a metaphor from the tool next door; nothing here is
  // hot, and the number is the same number in the same range either way.
  tools().setOpenPanel('sculpt')
  const panel = markupOf('SculptTool (open)', SculptTool)
  shows('its panel offers a brush size', panel, '>Brush size<')
  shows('a strength', panel, '>Strength<')
  shows('and a smoothing', panel, '>Smoothing<')
  hides('and never calls it heat', panel, '>Heat<')
  shows('the size owns its unit, as the torch\'s does', panel, 'aria-label="Brush size unit"')
  hides('and never offers auto', panel, '>auto<')

  // Its panel hangs off a button INSIDE the island, so the island shutting has
  // to shut it -- a panel left open behind a body that has gone off screen
  // springs back the next time the island does, from a click nobody made. This
  // is exactly what the torch's own panel did before `ISLAND_PANELS` learned
  // about it, which is why the new one is checked rather than assumed.
  tools().setIslandCollapsed(true)
  check('collapsing the island shuts the sculpt panel', tools().openPanel === null, `${tools().openPanel}`)
  tools().setIslandCollapsed(false)
  check('and it does not spring back', tools().openPanel === null, `${tools().openPanel}`)
  tools().setOpenPanel(null)

  // ONE BRUSH AT A TIME, and no code enforces it -- the store holds a single
  // mode, so arming either is choosing against the other. Both claim the plain
  // left press on a solid, so "both armed" is a state neither could act on.
  tools().setBrushTool('torch')
  tools().setBrushTool('sculpt')
  check('arming the sculpt tool puts the torch down', tools().brushTool === 'sculpt', `${tools().brushTool}`)
  shows(
    'and the island shows only the sculpt tool lit',
    markupOf('ErodeTool (sculpt armed)', ErodeTool),
    'aria-pressed="false"'
  )
  tools().setBrushTool('torch')
  shows(
    'and back again',
    markupOf('SculptTool (torch armed)', SculptTool),
    'aria-pressed="false"'
  )
  tools().setBrushTool(null)

  // ITS OWN DIALS. Blocking a shape out and carving detail into it are
  // different brush sizes, and a user who alternates must not have to re-dial
  // one number back and forth. Same bounds, though: they are the brush's, not
  // the tool's.
  tools().setSculptRadius(999)
  check('the sculpt size is held to the same ceiling', tools().sculptRadius === BRUSH_RADIUS_MAX, `${tools().sculptRadius}`)
  tools().setSculptRadius(-4)
  check('and the same floor', tools().sculptRadius === BRUSH_RADIUS_MIN, `${tools().sculptRadius}`)
  tools().setSculptStrength(5)
  check('strength is a ratio', tools().sculptStrength === 1, `${tools().sculptStrength}`)
  tools().setSculptSmooth(-1)
  // The floor is geometry, not taste, and it is the torch's: a point worked
  // with no flow at all collapses the ring around it. See BRUSH_SMOOTH_MIN.
  check(
    'and smoothing bottoms out where the torch\'s does',
    tools().sculptSmooth === BRUSH_SMOOTH_MIN,
    `${tools().sculptSmooth}`
  )
  tools().setSculptRadius(0.9)
  tools().setSculptStrength(0.2)
  check('the torch keeps its own size through all of that', tools().erodeRadius === DEFAULT_BRUSH_RADIUS, `${tools().erodeRadius}`)
  check('and its own heat', tools().erodeHeat === DEFAULT_BRUSH_FORCE, `${tools().erodeHeat}`)
  tools().setSculptRadius(DEFAULT_BRUSH_RADIUS)
  tools().setSculptStrength(DEFAULT_BRUSH_FORCE)
  tools().setSculptSmooth(DEFAULT_BRUSH_SMOOTH)

  // THE STROKE AS THE DOCUMENT SEES IT. One list for both brushes, in the order
  // the marks were made, because a bead over a groove and a groove over a bead
  // are different surfaces -- see `SceneObject.erosion`.
  {
    const clay = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1.5, 0])
    const marksOf = () => doc().doc.objects.find((o) => o.id === clay)?.erosion ?? []
    const entries = doc().past.length

    doc().startErode(clay, true)
    check('a sculpt stroke takes the same drag kind', doc().drag.kind === 'erode', doc().drag.kind)
    for (let i = 0; i < 4; i++) {
      doc().erodeAt([-0.3 + i * 0.2, 1, 0], DEFAULT_BRUSH_RADIUS, 0.6, 0.7)
    }
    doc().endDrag()
    check('it lays a dab per step', marksOf().length === 4, `${marksOf().length}`)
    check(
      'and costs one undo entry, like every other drag',
      doc().past.length === entries + 1,
      `${doc().past.length - entries}`
    )
    check('every dab of it is marked as raising', marksOf().every((d) => d.raise === true), JSON.stringify(marksOf()[0]))

    // A torch stroke over the top goes in the SAME list, after them. Two lists
    // could not say which came first, and which came first is the surface.
    doc().startErode(clay, false)
    doc().erodeAt([0, 1, 0], DEFAULT_BRUSH_RADIUS, 0.6, 0.7)
    doc().endDrag()
    const marks = marksOf()
    check('both brushes write one list', marks.length === 5, `${marks.length}`)
    check('in the order they were used', marks[4].raise === undefined && marks[0].raise === true, JSON.stringify(marks[4]))

    // The direction is the GESTURE's. Nothing the panel does mid-stroke can
    // turn a bead being drawn into a groove being cut.
    doc().startErode(clay, true)
    tools().setBrushTool('torch')
    doc().erodeAt([0.4, 1, 0], DEFAULT_BRUSH_RADIUS, 0.6, 0.7)
    doc().endDrag()
    tools().setBrushTool(null)
    check(
      'a stroke keeps the direction it started with',
      marksOf()[5].raise === true,
      JSON.stringify(marksOf()[5])
    )

    doc().removeObject(clay)
  }
}

// --- the mirror tool --------------------------------------------------------
//
// One button that is also its own axis selector: three lettered buttons sharing
// its outline, each in the colour the gizmo draws that axis in. What is worth
// pinning is that the letters are IN the button rather than beside it, that the
// colours come from the one place axis colours are defined, and that a flip is
// a real edit of the document rather than a light on a button.
{
  const flipped = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1, 0])
  doc().patchObject(flipped, {
    // Off-centre on two axes of its face, so a mirror about any of the three
    // moves it somewhere a check can see.
    features: [
      {
        id: 'mirror-f',
        anchor: { on: 'box-face', face: 2, u: 0.5, v: 0.25 },
        shape: { type: 'rect', w: 0.4, h: 0.3 },
        rotation: 0.3,
        depth: 0.3,
        enabled: true,
        tilt: [0, 0, 0],
        faceOffset: [0, 0],
      },
    ],
  })

  /** Where the sketch actually sits on the solid, in the object's own space. */
  const sketchAt = () => {
    const o = doc().doc.objects.find((x) => x.id === flipped)
    if (!o || o.features.length === 0) throw new Error('the mirrored solid lost its sketch')
    return hostSurfaceFor(o.base, o.features[0].anchor).frame(o.features[0].anchor).origin
  }
  const started = sketchAt().clone()

  // Nothing selected: there is no "mirror everything" reading to fall back on
  // the way the cut tool has one, so the tool stands down rather than doing
  // something nobody asked for.
  doc().selectObject(null)
  shows(
    'the mirror tool is dark with nothing selected',
    markupOf('MirrorTool (nothing selected)', MirrorTool),
    'class="nav-btn" disabled=""'
  )

  doc().selectObject(flipped)
  const mirror = markupOf('MirrorTool', MirrorTool)
  hides('and live once a solid is', mirror, 'disabled=""')
  // The three letters live INSIDE the tool's own outline, in the slot the caret
  // takes on every other tool -- that is the whole design of this button, so it
  // is pinned as a position rather than merely as three buttons existing.
  // Nothing between the group and the picker is a div, so a picker that had
  // become a SIBLING of the button would put the group's own closing tag here.
  check(
    'its axis picker sits inside the button group',
    !mirror.slice(mirror.indexOf('nav-group'), mirror.indexOf('nav-axes')).includes('</div>'),
    `group ${mirror.indexOf('nav-group')}, axes ${mirror.indexOf('nav-axes')}`
  )
  for (const letter of ['x', 'y', 'z']) {
    shows(`with a ${letter.toUpperCase()} button`, mirror, `nav-axis nav-axis-${letter}`)
  }
  // Exactly one lit, and at rest it is X. A picker with none lit would be a
  // button that cannot say what it is about to do.
  check(
    'exactly one axis is lit',
    (mirror.match(/aria-pressed="true"/g) ?? []).length === 1,
    `${(mirror.match(/aria-pressed="true"/g) ?? []).length}`
  )
  shows('and it is X to start with', mirror, 'nav-axis-x" aria-pressed="true"')

  {
    // The colours are the GIZMO's, read out of the stylesheet: a user connects
    // the lit letter to the arrow it matches by colour before reading either,
    // so a letter tinted from anywhere else would quietly break that.
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    AXIS_CSS_VARS.forEach((name, axis) => {
      const letter = 'xyz'[axis]
      const rule = css.split(`.nav-axis-${letter} {`)[1]?.split('}')[0] ?? ''
      check(
        `the ${letter.toUpperCase()} button is tinted from ${name}`,
        rule.includes(`var(${name})`),
        rule.trim() || 'no rule'
      )
    })
  }

  // A flip is an EDIT. The sketch ends up at the mirror image of where it was,
  // in the object's own space: one axis negated, the other two untouched.
  const entries = doc().past.length
  for (const axis of [0, 1, 2] as const) {
    const before = sketchAt().clone()
    doc().mirrorObjects([flipped], axis)
    const after = sketchAt()
    const got = [after.x, after.y, after.z]
    const want = [before.x, before.y, before.z].map((v, i) => (i === axis ? -v : v))
    check(
      `mirroring about ${'XYZ'[axis]} reflects the sketch across that axis`,
      got.every((v, i) => Math.abs(v - want[i]) < 1e-9),
      `${got.map((v) => v.toFixed(3)).join(', ')} vs ${want.map((v) => v.toFixed(3)).join(', ')}`
    )
    // And back, so the next axis starts from the solid this one did.
    doc().mirrorObjects([flipped], axis)
  }
  check(
    'each press costs one undo entry, like every other edit',
    doc().past.length === entries + 6,
    `${doc().past.length - entries} for 6 presses`
  )
  {
    // Six flips, three axes, twice each: the solid is exactly as it was.
    const at = sketchAt()
    check(
      'mirroring twice along an axis leaves the solid where it started',
      at.distanceTo(started) < 1e-9,
      `${at.distanceTo(started).toExponential(2)} from where it began`
    )
  }
  // A selection of none is a press that changes nothing, and must not bury the
  // edit before it under an undo entry that does nothing.
  doc().mirrorObjects([], 0)
  check(
    'and a press with nothing selected costs none',
    doc().past.length === entries + 6,
    `${doc().past.length - entries}`
  )

  // Aiming it moves the light, and the wide button beside the letters is what
  // repeats the last axis -- so which one is lit has to be readable.
  tools().setMirrorAxis(2)
  const aimed = markupOf('MirrorTool (Z)', MirrorTool)
  shows('choosing Z lights the Z button', aimed, 'nav-axis-z" aria-pressed="true"')
  hides('and puts X out', aimed, 'nav-axis-x" aria-pressed="true"')
  tools().setMirrorAxis(0)

  // In the island, with the gizmo tools rather than with the tools below the
  // rule: all four act on the object you have selected.
  {
    const island = markupOf('ToolIsland (mirror)', ToolIsland)
    shows('the island carries the mirror tool', island, '>Mirror<')
    check(
      'above the rule, with the tools that act on the selected object',
      island.indexOf('>Mirror<') > island.indexOf('>Scale<') &&
        island.indexOf('>Mirror<') < island.indexOf('island-rule'),
      `scale ${island.indexOf('>Scale<')}, mirror ${island.indexOf('>Mirror<')}, rule ${island.indexOf('island-rule')}`
    )
  }

  doc().removeObject(flipped)
}

// --- screens ----------------------------------------------------------------
//
// The app is no longer one viewport with one console beside it: it is a set of
// SCREENS, each a viewport and the console that drives it, chosen by tabs at
// the left of the bar. What is worth pinning is that the two halves are chosen
// together, that a screen with no document dims the controls that act on one
// rather than dropping them, and that Lathe's console really is its own.
{
  const bar = markupOf('NavBar (screens)', NavBar)
  const left = bar.slice(0, bar.indexOf('topbar-right'))

  // The tabs, in the order the table gives them, at the left of the bar.
  for (const id of SCREENS) {
    shows(`the bar offers the ${SCREEN_LABELS[id]} screen`, left, `>${SCREEN_LABELS[id]}<`)
  }
  check(
    'in the order the table names them',
    left.indexOf('>Modelling<') < left.indexOf('>Lathe<'),
    `modelling ${left.indexOf('>Modelling<')}, lathe ${left.indexOf('>Lathe<')}`
  )
  // After the name, which keeps the corner it has always had: identity first,
  // then where you are inside it.
  check(
    'after the wordmark, not before it',
    left.indexOf('brand-mark') < left.indexOf('screen-tabs'),
    `mark ${left.indexOf('brand-mark')}, tabs ${left.indexOf('screen-tabs')}`
  )
  // Divided, and by RULES rather than by more buttons: the bar now holds three
  // kinds of thing at once and at one gap they read as one row of switches.
  check(
    'the bar is divided by rules',
    (bar.match(/topbar-rule/g) ?? []).length >= 3,
    `${(bar.match(/topbar-rule/g) ?? []).length} rules`
  )
  check(
    'with one between the name and the tabs',
    left.indexOf('topbar-rule') > left.indexOf('brand-mark') &&
      left.indexOf('topbar-rule') < left.indexOf('screen-tabs'),
    `mark ${left.indexOf('brand-mark')}, rule ${left.indexOf('topbar-rule')}, tabs ${left.indexOf('screen-tabs')}`
  )
  // THE BIG one, and it is the only place in the bar that gets it: everything
  // right of that line belongs to whichever screen is chosen left of it, which
  // is a bigger break than any between two groups of tools.
  shows('and it is the full-height one', left, 'topbar-rule topbar-rule-major')
  check(
    'used exactly once',
    (bar.match(/topbar-rule-major/g) ?? []).length === 1,
    `${(bar.match(/topbar-rule-major/g) ?? []).length}`
  )
  // And the smallest of the three, between one tab and its neighbour. One
  // fewer than there are tabs: it goes BETWEEN them, not around them.
  check(
    'with a smaller rule between the tabs themselves',
    (bar.match(/screen-tab-rule/g) ?? []).length === SCREENS.length - 1,
    `${(bar.match(/screen-tab-rule/g) ?? []).length} for ${SCREENS.length} tabs`
  )
  {
    // Three heights, one line each, and the height is the whole of what they
    // say -- so it is the heights that are pinned rather than merely that three
    // classes exist.
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const ruleFor = (name: string) => (css.split(`${name} {`)[1]?.split('}')[0] ?? '')
    check(
      'the group rule crosses the middle of the bar',
      /height:\s*20px/.test(ruleFor('.topbar-rule')),
      ruleFor('.topbar-rule').trim()
    )
    check(
      'the major one runs edge to edge',
      /align-self:\s*stretch/.test(ruleFor('.topbar-rule-major')),
      ruleFor('.topbar-rule-major').trim()
    )
    check(
      'and the one between tabs is the shortest',
      /height:\s*12px/.test(ruleFor('.screen-tab-rule')),
      ruleFor('.screen-tab-rule').trim()
    )
    // The labels are drawn in capitals rather than stored that way, so the
    // table stays reusable by anything that should not shout.
    check(
      'the tabs are set in capitals by the stylesheet',
      /text-transform:\s*uppercase/.test(ruleFor('.screen-tab')),
      ruleFor('.screen-tab').trim().slice(0, 60)
    )
    check(
      'and the labels themselves are not shouted',
      SCREENS.every((id) => SCREEN_LABELS[id] !== SCREEN_LABELS[id].toUpperCase()),
      SCREENS.map((id) => SCREEN_LABELS[id]).join(', ')
    )
  }
  // Inert. A rule that announced itself would have a screen reader reading out
  // the layout between every pair of buttons.
  shows('and the rules are hidden from the reader', bar, 'topbar-rule" aria-hidden="true"')

  // Exactly one tab is current, and it is `aria-current` rather than
  // `aria-pressed`: these are places, not switches.
  check(
    'exactly one screen is current',
    (bar.match(/aria-current="page"/g) ?? []).length === 1,
    `${(bar.match(/aria-current="page"/g) ?? []).length}`
  )
  shows('and at rest it is Modelling', left, 'aria-current="page">Modelling<')

  // The modelling console: five panels, all about the document.
  const full = markupOf('Console', Console)
  for (const panel of ['Clipboard', 'Solids', 'Shapes', 'Color', 'Scene']) {
    shows(`the modelling console carries ${panel}`, full, `>${panel}<`)
  }

  // Lathe's console is its OWN. The Clipboard crosses over because what you
  // have saved is yours rather than the scene's; the other four describe a
  // document this screen does not draw.
  const lathe = markupOf('LatheConsole', LatheConsole)
  shows("the lathe console keeps the clipboard", lathe, '>Clipboard<')
  for (const panel of ['Solids', 'Shapes', 'Color', 'Scene']) {
    hides(`and not ${panel}`, lathe, `>${panel}<`)
  }

  // On a screen with no document, everything that acts on one stands down --
  // dimmed and still in place, so the bar keeps its shape between screens.
  tools().setScreen('lathe')
  {
    const idle = markupOf('NavBar (lathe)', NavBar)
    shows('switching screens lights the other tab', idle, 'aria-current="page">Lathe<')
    hides('and puts Modelling out', idle, 'aria-current="page">Modelling<')

    // Counted rather than named one at a time: what matters is that the six
    // controls acting on the document all stand down together.
    const down = (idle.match(/disabled=""/g) ?? []).length
    check(
      'the document controls stand down together',
      down >= 6,
      `${down} disabled: Import, Export, Snap and its caret, Undo, Redo`
    )
    for (const label of ['Import', 'Export', 'Snap', 'Undo', 'Redo']) {
      shows(`${label} is still in the bar`, idle, `>${label}<`)
    }
    // Dimmed, and the stylesheet dims the whole CONTROL rather than the label
    // inside it: Snap is an engaged tool wearing an accent fill, and fading
    // only its text left the one button that could not be pressed as the
    // brightest thing in the bar.
    shows('and Snap is still lit as the rule it is', idle, 'nav-group nav-group-active')
    {
      const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
      const rule = css.split('.nav-group:has(> .nav-btn:disabled) {')[1]?.split('}')[0] ?? ''
      check('the dim goes on the whole group', rule.includes('opacity'), rule.trim() || 'no rule')
    }
    // Help and the cog survive every screen: one explains the app and the other
    // holds what stays true of the next document you open.
    check(
      'Help and Settings stay live',
      !/>Help<[\s\S]{0,40}disabled/.test(idle) && !/>Settings<[\s\S]{0,40}disabled/.test(idle),
      'neither is disabled'
    )
    // The counts are a readout of the same scene, so they dim with it.
    shows('and the counts read as inapplicable', idle, 'stats stats-idle')
  }

  // Switching closes any tool panel with it: every one of them hangs off a bar
  // or an island that is about to be replaced.
  tools().setScreen('modelling')
  tools().setOpenPanel('snap')
  tools().setScreen('lathe')
  check('switching screens closes an open panel', tools().openPanel === null, `${tools().openPanel}`)

  // And the screen is a TOOL setting, not a document one: switching must not
  // land in undo history.
  {
    const entries = doc().past.length
    tools().setScreen('modelling')
    tools().setScreen('lathe')
    tools().setScreen('modelling')
    check(
      'and costs no undo entries',
      doc().past.length === entries,
      `${doc().past.length - entries}`
    )
  }
  check('back on the modelling screen', tools().screen === 'modelling', tools().screen)
}

// --- the lathe screen --------------------------------------------------------
//
// The second screen, and the first one with tools of its own. What is worth
// pinning here is the shape of the thing rather than the arithmetic -- the clay
// itself is checked in `engine-check`, which can work a lump without a window.
// This is about the controls: two tools on the island and no more, the stock in
// the bar where it dims off this screen, and the one piece of geometry the
// SCREEN owns rather than the model -- the mapping from a pointer in pixels to
// a place on the wall, which every gesture on this screen rests on.
console.log('\nThe lathe screen: two tools, one lump, and a pointer that lands where it looks')
{
  tools().setScreen('lathe')

  // THE ISLAND HOLDS TWO TOOLS AND NOTHING ELSE. It is the whole promise of the
  // screen -- the easy one -- so it is worth a check that would fail the day a
  // third button is added without a second thought.
  const push = markupOf('PushTool', PushTool)
  const pull = markupOf('PullTool', PullTool)
  shows('the island offers Push', push, '>Push<')
  shows('and Pull', pull, '>Pull<')

  // Each carries its own two dials, and the pair is deliberately two rather
  // than the modelling brushes' three: there is no crease to allow for on a
  // wall that is relaxed after every dab. See `PushPullTool`.
  for (const [label, markup] of [
    ['Push', push],
    ['Pull', pull],
  ] as const) {
    tools().setOpenPanel(label.toLowerCase() as 'push' | 'pull')
    const open = markupOf(`${label} (panel open)`, label === 'Push' ? PushTool : PullTool)
    shows(`${label} sizes its tool`, open, '>Tool size<')
    shows(`${label} sets a strength`, open, '>Strength<')
    check(
      `and offers no third dial`,
      (open.match(/field-label/g) ?? []).length === 2,
      `${(open.match(/field-label/g) ?? []).length} fields`
    )
    hides(`${label} has no smoothing to set`, open, '>Smoothing<')
    // The size is pinned to a unit of its own, as the modelling brushes' are:
    // `auto` renumbers a scale mid-drag, and a control that SETS a length
    // cannot be aimed while it does. See `erodeSizeUnit`.
    shows(`${label}'s size is read in a unit it owns`, open, 'seg field-units')
    check('the closed one stayed closed', !markup.includes('>Strength<'), '')
  }
  tools().setOpenPanel(null)

  // ARMING ONE DISARMS THE OTHER, and nothing enforces it: the store holds ONE
  // tool. Pressing the lit tool puts it down, which is how a press on the clay
  // is made to do nothing.
  tools().setLatheTool('push')
  check('taking up Push arms it', tools().latheTool === 'push', `${tools().latheTool}`)
  tools().setLatheTool('pull')
  check('and taking up Pull puts Push down', tools().latheTool === 'pull', `${tools().latheTool}`)
  shows(
    'the armed tool is lit',
    markupOf('PullTool (armed)', PullTool),
    'nav-group nav-group-active'
  )
  tools().setLatheTool(null)

  // THE STOCK IS A CORNER PANEL over the piece, not a lid on a bar button. It
  // was in the bar to begin with, which put a number and the shape it changes
  // at opposite ends of the window; the corner is where the eye already is.
  {
    const bar = markupOf('NavBar (lathe)', NavBar)
    hides('the bar carries no lathe control at all', bar, '>Clay<')

    const panel = markupOf('StockPanel', StockPanel)
    shows('the corner panel names what it is about', panel, 'The lump')
    shows('it sets a height', panel, '>Height<')
    // HEIGHT AND WIDTH, which is what the drawing shows: a rectangle. The wall
    // is a radius underneath, and the halving happens on the way in -- asking
    // for a radius here would be asking the reader to double a number to check
    // their own work against a shape whose width is the thing on screen.
    shows('and a width', panel, '>Width<')
    hides('rather than the radius it keeps underneath', panel, '>Radius<')
    check(
      'the width field reads as the whole rectangle',
      /value="8"/.test(panel.slice(panel.indexOf('>Width<'))),
      'twice the 4 cm stock radius, in the centimetres the app is set to'
    )
    shows('and it offers a fresh lump', panel, 'Centre a fresh lump')
    // Dead while the lump is untouched rather than hidden: a control that
    // appears the first time you push the clay is one nobody knows is there.
    check(
      'which is dead while the lump is untouched',
      /stock-fresh"[\s\S]{0,40}disabled/.test(panel),
      'disabled on a fresh lump'
    )

    // It shuts to its title strip, and the strip is what reopens it: the same
    // collapse idiom every console section and the tool island already wear.
    shows('the panel can be shut', panel, 'collapse-btn')
    shows('and says so where a reader can hear it', panel, 'aria-expanded="true"')
    tools().setStockOpen(false)
    const shut = markupOf('StockPanel (shut)', StockPanel)
    shows('shut, it is the strip and nothing else', shut, 'stock-panel-shut')
    hides('with the fields gone', shut, '>Height<')
    shows('and the caret turned the other way', shut, 'aria-expanded="false"')
    tools().setStockOpen(true)

    // The fields read the clay, and writing them carries the shape rather than
    // throwing it away -- the whole reason they are safe to touch after an
    // hour's work. `engine-check` proves the scaling; this proves the panel is
    // wired to it.
    lathe().work({ y: 0.75, radius: 0.2, reach: 0.3, bite: 1, push: true })
    check('working the clay marks it as touched', !isFresh(lathe().clay), '')
    const before = lathe().clay.wall.slice()
    lathe().setRadius(lathe().clay.radius * 2)
    const carried = lathe().clay.wall.every((r, i) => Math.abs(r / before[i] - 2) < 1e-9)
    check('the panel doubles the piece rather than re-centring it', carried, '')
    lathe().centreFresh()
    check('and a fresh lump is a cylinder again', isFresh(lathe().clay), '')
    check('at the stock it was given', lathe().clay.radius === 0.8, `${lathe().clay.radius}`)
    lathe().setRadius(0.4)
  }

  // THE WAY OFF THE LATHE. The piece is swept into a solid and put on the
  // clipboard -- the one thing in this app that belongs to the user rather than
  // to a document, and the one panel this screen's console carries.
  {
    const corner = markupOf('CopyPieceButton', CopyPieceButton)
    shows('the corner offers the copy', corner, 'Copy to clipboard')
    check(
      'and says nothing until it has something to report',
      !corner.includes('copy-piece-note'),
      'no receipt before the first press'
    )

    // Pressed for real, through the same calls the button makes.
    const worked = mold(freshClay(1.5, 0.4), {
      y: 0.9,
      radius: 0.2,
      reach: 0.4,
      bite: 1,
      push: true,
    })
    const entry = registerMesh(revolveClay(worked), PIECE_NAME)
    const { size } = fitToEnvelope(entry.natural)
    const piece = makeObject(
      { kind: 'mesh', meshId: entry.id, label: entry.label, size },
      [0, size[1] / 2, 0]
    )
    library().copyObject(piece)
    library().renameCustom(library().saveCustom(piece), PIECE_NAME)
    const copied = library().clipboard
    check('a copy lands on the clipboard', copied !== null, '')
    check(
      'as a mesh, which is what the scene can already hold',
      copied?.base.kind === 'mesh',
      `${copied?.base.kind}`
    )
    check('named for what it is', copied?.name === PIECE_NAME, `${copied?.name}`)
    check(
      'the right way up and standing on the ground',
      copied !== null && Math.abs(copied.transform.position[1] - worked.height / 2) < 1e-9,
      `${copied?.transform.position.join(', ')}`
    )
    // Its size is the piece's own, not a unit cube: the triangles are
    // normalised into the mesh library and `size` is what puts them back.
    const turned = copied?.base.kind === 'mesh' ? copied.base.size : [0, 0, 0]
    check(
      'at the size it was turned',
      Math.abs(turned[1] - worked.height) < 1e-6 &&
        Math.abs(turned[0] - widestRadius(worked) * 2) < 1e-6,
      turned.map((n) => n.toFixed(3)).join(' x ')
    )
    check(
      'and as round as it went in',
      Math.abs(turned[0] - turned[2]) < 1e-6,
      `${turned[0].toFixed(3)} by ${turned[2].toFixed(3)}`
    )
    // BOTH HALVES OF "COPY". The panel called Clipboard is the shelf, so a
    // press that only filled the paste buffer would put the piece somewhere
    // the user cannot see; one that only filled the shelf would leave Ctrl+V
    // doing nothing. See `CopyPieceButton`.
    check(
      'it lands on the shelf as well as in the paste buffer',
      library().customs.some((c) => c.name === PIECE_NAME),
      library().customs.map((c) => c.name).join(', ') || 'nothing on the shelf'
    )
    shows(
      'so the console beside it has a tile to draw',
      markupOf('LatheConsole (copied)', LatheConsole),
      PIECE_NAME
    )
  }

  // WHERE A POINTER LANDS. The screen draws itself in scene units and lets the
  // browser fit that box into whatever shape the window leaves -- so the one
  // piece of arithmetic it has to own is the way back, and every press, drag
  // and ghost circle on this screen is wrong if this is.
  {
    const clay = freshClay(1.5, 0.4)
    const frame = clayFrame(clay)
    check(
      'the frame is centred on the axis',
      frame.x === -frame.width / 2,
      `${frame.x} of ${frame.width}`
    )
    check(
      'and leaves room for the widest the wall may be worked',
      frame.width / 2 > clay.radius * CLAY_FLARE,
      `${(frame.width / 2).toFixed(3)} against ${(clay.radius * CLAY_FLARE).toFixed(3)}`
    )
    check(
      'with the piece standing clear of both ends',
      frame.base < frame.height && frame.base > clay.height,
      `base ${frame.base.toFixed(3)} in 0..${frame.height.toFixed(3)}`
    )

    // A square element, so the frame -- which is taller than it is wide -- fits
    // by HEIGHT and is letterboxed left and right. That is the case a hand-
    // written inverse gets wrong, so it is the one to check.
    const square = { left: 0, top: 0, width: 600, height: 600 }
    const scale = square.height / frame.height
    const middle = pointerToClay(frame, square, 300, 300)
    near('the middle of the element is on the axis', middle.x, 0, 1e-9)
    near(
      'at half the frame up from the faceplate',
      middle.y,
      frame.base - frame.height / 2,
      1e-9
    )

    // A point one scene unit to the right of the axis is `scale` pixels right
    // of the middle, and reads back as one unit -- whichever side of the axis
    // it is on, because the wall is one row of radii and has no left or right.
    const right = pointerToClay(frame, square, 300 + scale * 0.3, 300)
    near('a point right of the axis reads as that far out', right.x, 0.3, 1e-9)
    const left = pointerToClay(frame, square, 300 - scale * 0.3, 300)
    near('and the same point on the left is the same distance', left.radius, right.radius, 1e-9)
    check('with the sign kept for the drawing', left.x < 0 && right.x > 0, '')

    // Up the screen is up the piece, which is the flip this module exists to
    // own -- SVG counts y downward and a lathe counts it up off the faceplate.
    const higher = pointerToClay(frame, square, 300, 200)
    check('higher on screen is higher up the piece', higher.y > middle.y, '')
    near('by exactly the pixels it moved', higher.y - middle.y, 100 / scale, 1e-9)

    // And the faceplate itself: the y the frame calls the clay's zero.
    const onPlate = pointerToClay(frame, square, 300, (frame.base / frame.height) * 600)
    near('the faceplate is the clay zero', onPlate.y, 0, 1e-9)

    // A zero-sized element is not a thing anyone can point at, but a layout can
    // produce one for a frame, and it must not divide by nothing.
    const nothing = pointerToClay(frame, { left: 0, top: 0, width: 0, height: 0 }, 10, 10)
    check('and a zero-sized viewport reads as the origin', nothing.y === 0, `${nothing.y}`)
  }

  // The silhouette is one path, mirrored from one row of radii: both walls are
  // the same wall, so the drawing cannot disagree with itself about the shape.
  {
    const worked = mold(freshClay(1.5, 0.4), {
      y: 0.75,
      radius: 0.2,
      reach: 0.3,
      bite: 1,
      push: true,
    })
    const frame = clayFrame(worked)
    const path = silhouette(worked, frame)
    check('the silhouette closes', path.startsWith('M ') && path.endsWith(' Z'), path.slice(-2))
    const points = path.replace(/[MLZ]/g, '').trim().split(/\s+/)
    check(
      'and holds both walls of every ring',
      points.length === CLAY_RINGS * 4,
      `${points.length / 2} points for ${CLAY_RINGS} rings`
    )

    // The turning rings live inside the wall they cross rather than at a width
    // of their own, so they follow every push and pull without being told.
    const rings = turningRings(worked, frame, 11)
    check('eleven rings are drawn', rings.length === 11, `${rings.length}`)
    check(
      'each inside the wall at its own height',
      rings.every((ring) => ring.r > 0 && ring.r < Math.max(...worked.wall)),
      ''
    )
    check(
      'and none of them on the base or the rim',
      rings.every((ring) => ring.y < frame.base && ring.y > frame.base - worked.height),
      ''
    )
  }

  tools().setScreen('modelling')
  tools().setLatheTool(null)
}

console.log(
  failures === 0
    ? '\nAll console checks passed.\n'
    : `\n${failures} console check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
