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
import { Box3, Matrix4, PlaneGeometry, Quaternion, ShaderChunk, ShaderLib, Vector3 } from 'three'
import type { BufferAttribute, BufferGeometry, WebGLProgramParametersWithUniforms } from 'three'
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

import { ExportTools, fileBase } from '../src/console/ExportTools'
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
  SmootherTool,
  SnapTool,
  cutPlaneSpawn,
  rulerFrame,
} from '../src/console/NavTools'
import { ClipboardPanel, liveTiles, marqueeOffset } from '../src/console/ClipboardPanel'
import { VIEW, framingDistance } from '../src/console/ObjectThumbnail'
import { ObjectPanel } from '../src/console/ObjectPanel'
import { PlacementPanel } from '../src/console/PlacementPanel'
import { MergeButton, SceneTree } from '../src/console/SceneTree'
import { ShapePalette } from '../src/console/ShapePalette'
import { Console } from '../src/console/Console'
import { LaserConsole } from '../src/console/LaserConsole'
import { LatheConsole } from '../src/console/LatheConsole'
import { BasePanel } from '../src/console/BasePanel'
import { HollowTool } from '../src/console/HollowTool'
import { LatheRulerTool } from '../src/console/LatheRulerTool'
import { latheRulerLength, latheRulerRide, latheRulerSlide } from '../src/viewport/latheRuler'
import { PointSculptTool, PullTool, PushTool, SmoothTool } from '../src/console/LatheTools'
import { CopyPieceButton, PIECE_NAME, pieceName } from '../src/viewport/CopyPieceButton'
import { LatheViewport } from '../src/viewport/LatheViewport'
import { StockPanel } from '../src/viewport/StockPanel'
import { BlockPanel } from '../src/viewport/BlockPanel'
import { FreehandTool, MoveRefTool, PointCutTool } from '../src/console/LaserTools'
import { ReferencePanel, slotsFor } from '../src/console/ReferencePanel'
import { ReferenceEditor } from '../src/console/ReferenceEditor'
import {
  MAX_PLACEMENTS,
  MAX_PRESETS,
  SLOTS_PER_PRESET,
  activePreset,
  flipCrop,
  turnCrop,
  useReference,
  visiblePlacements,
} from '../src/store/referenceStore'
import type { Placement } from '../src/store/referenceStore'
import {
  CROP_RATIOS,
  aspectOf,
  clampCrop,
  fitCrop,
  fractionRatio,
  isReferenceFile,
  moveCrop,
  resizeCrop,
  turnedSize,
} from '../src/console/referenceImage'
import {
  CORNERS,
  FACES,
  MIN_DECAL,
  clampCentre,
  coversPoint,
  dropSize,
  faceFrame,
  faceOffset,
  faceOfNormal,
  placementRect,
  pointUv,
  resizeFromCorner,
} from '../src/viewport/decalPlacement'
import { useCutDraft, draftLine, draftReady } from '../src/viewport/cutDraft'
import { BLOCK_MAX, BLOCK_MIN, DEFAULT_BLOCK, bedIsUncut, useLaser } from '../src/store/laserStore'
import { bedGeometry } from '../src/geometry/laserCut'
import { BLOCK_NAME, CopyBlockButton, bedName, sizeIn } from '../src/viewport/CopyBlockButton'
import { ZoomControl } from '../src/viewport/ZoomControl'
import { ViewResetButton } from '../src/viewport/ViewResetButton'
import { fitToEnvelope } from '../src/geometry/importers'
import { registerMesh } from '../src/geometry/meshLibrary'
import { revolveClay } from '../src/geometry/revolve'
import {
  CLAY_FLARE,
  CLAY_HEIGHT_MAX,
  CLAY_HEIGHT_MIN,
  CLAY_RADIUS_MAX,
  CLAY_RADIUS_MIN,
  CLAY_RINGS,
  CLAY_SIDES,
  DEFAULT_CLAY_HEIGHT,
  DEFAULT_CLAY_RADIUS,
  bore,
  flatFactor,
  freshClay,
  isFresh,
  mold,
  wallAt,
  widestRadius,
} from '../src/geometry/clay'
import { ISLAND_PANELS, armedBrush, armedLatheTool } from '../src/store/toolStore'
import { SculptPanel } from '../src/viewport/SculptPanel'
import { useSculptDraft } from '../src/viewport/sculptDraft'
import { useLathe } from '../src/store/latheStore'
import {
  NO_PAN,
  PAN_LIMIT,
  ZOOM_MAX,
  ZOOM_MIN,
  clampPan,
  clampZoom,
  clayFrame,
  fitZoom,
  flatsProfile,
  pointerToClay,
  sectionPath,
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
import {
  BLOCK_STANDOFF,
  CLOSEST_FRAME,
  OPENING_FRAME,
  OPENING_SHARE,
  WIDEST_FRAME,
} from '../src/viewport/LaserViewport'
import { STAGE_CAMERA, groundPlan } from '../src/viewport/Stage'
import { perspectiveFrame } from '../src/viewport/orthoFrame'
import { DEFAULT_LASER_SNAP, LASER_SNAP_MAX } from '../src/viewport/pointSnap'
import { LATHE_SNAP_MAX } from '../src/viewport/latheRuler'
import { CutPanel } from '../src/viewport/CutPanel'
import { MarqueeRect } from '../src/viewport/SelectionMarquee'
import { MARQUEE_SLOP, useMarquee } from '../src/viewport/marquee'
import { SolidList, SolidPalette } from '../src/console/SolidPalette'
import { NGON_LABEL } from '../src/console/ngon'
import { SOLID_TEMPLATES, restingSides } from '../src/console/solidIcons'
import { SOLID_SIDES } from '../src/console/solidMorph'
import { UNIT_MODES, fromDisplay, resolveUnit, stepIn, suffixOf, toDisplay } from '../src/units'
import {
  MAX_FACE_OFFSET,
  MAX_SIZE,
  MIN_DIMENSION,
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
import { hostSurfaceFor, maxShapeSize, slideAnchor, surfaceFor } from '../src/geometry/surfaces'
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
import { templateOf, useLibrary } from '../src/store/libraryStore'
import { ObjectMenu, useObjectMenu } from '../src/viewport/ObjectMenu'
import {
  CUT_POSITION_LIMIT,
  CUT_SIZE_MAX,
  DEFAULT_CUT_PLANE,
  DEFAULT_BRUSH_FORCE,
  DEFAULT_BRUSH_RADIUS,
  DEFAULT_BRUSH_ROUND,
  DEFAULT_SMOOTHER_RADIUS,
  DEFAULT_BRUSH_SMOOTH,
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  BRUSH_SMOOTH_MIN,
  ROUND_MIN,
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

/**
 * Whether the button carrying a given `aria-label` is disabled.
 *
 * By the button it belongs to rather than by the attribute order around it,
 * which is the trap `resetIsDown` above documents: React emits attributes in the
 * order the JSX writes them, so a needle that pins `disabled` next to a
 * neighbour is a needle that breaks the day somebody reorders two props.
 */
function buttonIsDown(markup: string, name: string): boolean {
  const tag = markup
    .split('<button')
    .find((part) => part.includes(`aria-label="${name}"`))
  return tag !== undefined && tag.slice(0, tag.indexOf('>')).includes('disabled=""')
}

function occurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1
}

const doc = () => useDoc.getState()
const library = () => useLibrary.getState()
const tools = () => useTools.getState()
const lathe = () => useLathe.getState()
const laser = () => useLaser.getState()
const draft = () => useCutDraft.getState()
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
  // DISARMED IT IS A BARE SWITCH. The caret comes with the panel, and the
  // panel is the two things you do to a plane that exists -- so there is
  // nothing behind it until one does.
  hides('and carries no caret while it is disarmed', cut, 'nav-caret')
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
      // A heading with nothing under it is the failure mode a help screen
      // actually has -- and now that an entry can say what it is in a summary
      // OR show how it works in steps, "nothing under it" means neither.
      check(
        `${section.id}: ${entry.title} says something under it`,
        Boolean(entry.summary) || (entry.steps?.length ?? 0) > 0,
        `summary: ${Boolean(entry.summary)}, steps: ${entry.steps?.length ?? 0}`
      )
      // Both halves of a gesture row, or the grid draws a term with an empty
      // column beside it -- which reads as a missing line rather than a short
      // one. Notes are the field verbosity would creep back into, so they are
      // held to being present-or-absent rather than long.
      for (const step of entry.steps ?? []) {
        check(
          `${section.id}: ${entry.title} pairs a gesture with what it does`,
          Boolean(step.action) && Boolean(step.result),
          String(step.action)
        )
      }
    }
  }

  // --- THE SHORTCUTS PAGE IS A TABLE OF EVERY KEY --------------------------
  //
  // A page that lists SOME of the shortcuts is worse than no page at all: it is
  // read as the whole set, so a key missing from it is a key nobody finds. Two
  // things are held to that here, and both are the kind of drift a reader would
  // never notice.
  //
  // FIRST, EVERY KEY CHIP ELSEWHERE IN HELP IS IN THE TABLE. A topic that shows
  // a shortcut beside its title is documenting one, and this page has to carry
  // it too -- otherwise the two halves of Help disagree about what the app
  // answers, and the table is the half that looks complete.
  {
    const shortcuts = HELP_SECTIONS.find((s) => s.id === 'shortcuts')
    check('there is a shortcuts page', Boolean(shortcuts), HELP_SECTIONS.map((s) => s.id).join(', '))
    /** Every key named in the left-hand column, split on the commas it uses to
     *  offer two keys for one act. */
    const listed = new Set(
      (shortcuts?.entries ?? [])
        .flatMap((entry) => entry.steps ?? [])
        .flatMap((step) => String(step.action).split(',').map((k) => k.trim().toLowerCase()))
    )
    /** What the table calls a key, against what the source calls it. */
    const asListed = (key: string) => (key.toLowerCase() === 'escape' ? 'esc' : key.toLowerCase())

    // EVERY BARE KEY THE VIEWPORTS LISTEN FOR, read out of their source rather
    // than from a list kept here -- a list would drift the first time a screen
    // learned a key, which is the whole failure this page exists to prevent.
    // The chords are checked by name below: `Ctrl+Z` is written in the source
    // as a `toLowerCase()` against a modifier and is not a literal to scrape.
    const heard = new Map<string, string>()
    for (const file of ['Viewport', 'LatheViewport', 'LaserViewport']) {
      const source = readFileSync(new URL(`../src/viewport/${file}.tsx`, import.meta.url), 'utf8')
      // The lathe answers only a chord, so it contributes nothing here and that
      // is not a fault: what would be a fault is the scrape finding nothing
      // ANYWHERE, which is why the guard is on the total.
      for (const [, key] of source.matchAll(/e\.key === '([^']+)'/g)) heard.set(key, file)
    }
    check('the viewports were read for the keys they answer', heard.size > 0, [...heard.keys()].join(', '))
    for (const [key, file] of heard) {
      check(
        `the table names ${key}, which ${file} answers`,
        listed.has(asListed(key)),
        [...listed].join(' | ')
      )
    }

    // And the three bare letters, read off the very map the handler switches
    // on, so a fourth gizmo key would have to be documented to pass.
    const modeKeys = [
      ...readFileSync(new URL('../src/viewport/Viewport.tsx', import.meta.url), 'utf8')
        .split('export const MODE_KEYS')[1]
        .split('}')[0]
        .matchAll(/(\w+): '/g),
    ].map((m) => m[1])
    check('the gizmo keys were found to check against', modeKeys.length === 3, modeKeys.join(', '))
    for (const key of modeKeys) {
      check(`the table names ${key}, which picks a gizmo`, listed.has(key.toLowerCase()), [...listed].join(' | '))
    }

    const chips = HELP_SECTIONS.filter((s) => s.id !== 'shortcuts')
      .flatMap((s) => s.entries)
      .map((e) => e.key)
      .filter((key): key is string => Boolean(key))
    check('and Help has key chips to be held against it', chips.length > 0, `${chips.length}`)
    for (const chip of chips) {
      check(
        `the table carries ${chip}, which a topic shows as a shortcut`,
        listed.has(chip.toLowerCase()),
        [...listed].join(' | ')
      )
    }

    // SECOND, EVERY SCREEN THAT ANSWERS A KEY HAS A ROW HERE. Named rather than
    // counted, because the failure this guards is a whole screen's worth of
    // keys going undocumented when one is added -- which is exactly what
    // happened to this page's own subject before it existed.
    const pages = (shortcuts?.entries ?? []).map((e) => e.title)
    for (const where of ['Anywhere', 'Modelling', 'The lathe', 'The laser cutter']) {
      check(`the table covers ${where}`, pages.includes(where), pages.join(', '))
    }

    // And the keys the source actually listens for, spot-checked against the
    // table: the three chords, the two destructive keys and the three bare
    // gizmo letters. A key handled in a viewport and absent here is the drift
    // this whole page exists to stop.
    for (const key of ['esc', 'ctrl+z', 'ctrl+shift+z', 'ctrl+c', 'ctrl+v', 'delete', 'backspace', 'm', 'r', 's', 'enter']) {
      check(`the table names ${key}`, listed.has(key), [...listed].join(' | '))
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
  shows('and that the brushes are exclusive', toolsPage, 'puts the others down')
  // And the third, whose surprise is the opposite of the other two's: it stops.
  // A user who has learned "go over it again" from the torch will try it here
  // first, so the page has to say plainly that it does nothing.
  shows('Help explains the Smoother', toolsPage, 'Smoother')
  shows('says it arrives at a radius and stops', toolsPage, 'It arrives and stops.')
  shows('and that it leaves flat faces alone', toolsPage, 'It leaves flat faces alone.')

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
      bodyCanBeDragged({ mode: 'move', hidden: false, brushArmed: false }),
      'draggable'
    )
    check(
      'putting the handles down stops that too',
      !bodyCanBeDragged({ mode: 'move', hidden: true, brushArmed: false }),
      'fixed'
    )
    check(
      'and so does arming a brush',
      !bodyCanBeDragged({ mode: 'move', hidden: false, brushArmed: true }),
      'fixed'
    )

    // AND THE MODE. The body offers exactly one gesture -- a slide across the
    // ground -- so in the two modes that are not about sliding it is a handle
    // for something the tool does not do. Pressing a solid in Rotate and having
    // it slide is the same lie as pressing one under a dark picker and having
    // it move: the gizmo says one thing and the object does another.
    check(
      'Rotate does not slide a solid by its body',
      !bodyCanBeDragged({ mode: 'rotate', hidden: false, brushArmed: false }),
      'fixed'
    )
    check(
      'nor does Scale',
      !bodyCanBeDragged({ mode: 'scale', hidden: false, brushArmed: false }),
      'fixed'
    )
    check(
      'and Move still does',
      bodyCanBeDragged({ mode: 'move', hidden: false, brushArmed: false }),
      'draggable'
    )

    // The two rules have to agree in the direction that matters: a body that
    // can be dragged must be wearing handles, or the solid would move on a
    // press with nothing on screen to say it could. The converse is NOT
    // claimed, and stopped being true when the mode joined the rule -- Rotate
    // wears three rings and refuses the body, which is the whole point of it.
    for (const mode of ['move', 'rotate', 'scale'] as const) {
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
          const draggable = bodyCanBeDragged({ mode, hidden, brushArmed })
          check(
            `${mode} hidden=${hidden} brush=${brushArmed}: a draggable body wears handles`,
            !draggable || wearing,
            `${wearing ? 'arrows' : 'none'} / ${draggable ? 'draggable' : 'fixed'}`
          )
        }
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

  // NO HEADING ON IT. The panel is reached by pressing a button that says
  // Export, so a line at the top saying Export again tells you where you knew
  // you were -- and that line is worth more as somewhere to type the filename.
  // The panel keeps the words as its accessible name either way.
  hides('the panel draws no heading of its own', panel, 'nav-panel-title')
  shows('but it is still named for a screen reader', panel, 'aria-label="Export scene"')

  // THE NAME BOX STANDS ON THE ROW THE HEADING LEFT, which is why it costs the
  // panel no height. It arrives already called `Untitled` -- a name a press of
  // Export would use as it stands, so the panel says what the file will be
  // called before anything is typed. It is short enough that a focus selects it
  // whole and the first keystroke replaces it, which is the only reason a box
  // that starts full is not a box you have to clear.
  //
  // The AUTOMATIC name is the other thing it could write, and it stays a
  // placeholder: it is a description of the scene rather than a name, and it
  // shows only once the box has been cleared into a state it did not start in.
  shows('the head row carries a name box instead', panel, 'class="export-name"')
  shows('and it is labelled for a screen reader', panel, 'aria-label="File name"')
  shows('and it arrives already named', panel, 'value="Untitled"')
  shows('with the automatic name offered as the hint', panel, 'placeholder="xiao-shuas-3d-editor-')
  hides('which is never the value', panel, 'value="xiao-shuas')

  // WHAT THE FILE IS ACTUALLY CALLED. Empty falls back to the automatic name,
  // so the box is optional and pressing a format still just writes a file; a
  // typed name is used as typed; and the separators a filename may not contain
  // are taken out, because a slash in a download name is a browser being told
  // to write somewhere other than where the user thinks. The extension is never
  // the caller's business -- `exportSolid` adds it from the format pressed.
  check('an empty box falls back to the automatic name', fileBase('', 'auto-name') === 'auto-name', fileBase('', 'auto-name'))
  check('a typed name is what the file is called', fileBase('bracket', 'auto-name') === 'bracket', fileBase('bracket', 'auto-name'))
  check('a path separator cannot get through', !fileBase('..\\etc\\bracket', 'auto').includes('\\'), fileBase('..\\etc\\bracket', 'auto'))
  check('nor a forward slash', !fileBase('../bracket', 'auto').includes('/'), fileBase('../bracket', 'auto'))
  check('a leading dot does not hide the file', !fileBase('.bracket', 'auto').startsWith('.'), fileBase('.bracket', 'auto'))
  check('a trailing dot is dropped, not left to Windows', !fileBase('bracket.', 'auto').endsWith('.'), fileBase('bracket.', 'auto'))
  check('a name of nothing but punctuation falls back too', fileBase('///', 'auto-name') === 'auto-name', fileBase('///', 'auto-name'))
  check('and a name cannot run away with the path', fileBase('x'.repeat(400), 'auto').length <= 64, `${fileBase('x'.repeat(400), 'auto').length}`)

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
  // Arming puts the two ACTIONS behind the tool's own caret, a short travel
  // from the gizmo that just aimed the plane. The plane's numbers stay in the
  // console.
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

  // AND THEY ARE A DROPDOWN OFF THE CUT BUTTON, like every other tool's
  // controls on this island -- not two rows hanging under the whole of it,
  // which is what made arming the tool shove the column about.
  const armedTool = markupOf('CutTool (armed)', CutTool)
  shows('an armed cut grows a caret of its own', armedTool, 'nav-caret')
  check(
    'and arming opened its panel, so the button that fires it is up',
    tools().openPanel === 'cut',
    `${tools().openPanel}`
  )
  shows('which is where Apply cut lives', armedTool, '>Apply cut</button>')
  shows('in a panel of its own', armedTool, 'class="nav-panel"')
  // Nothing hangs under the island any more, so it is the same height armed or
  // not and the brushes below Cut stay where the hand left them.
  hides(
    'and nothing hangs under the island',
    markupOf('ToolIsland (cut armed)', ToolIsland),
    'class="nav-cut"'
  )

  // PUTTING THE TOOL DOWN TAKES THE PANEL WITH IT, and it is the STORE that
  // says so rather than the button -- the same rule `setIslandCollapsed`
  // states in the same place, and for the same reason: the invariant is about
  // the state, and the button is only one of the ways in.
  tools().setCutActive(false)
  check('disarming shuts the panel', tools().openPanel === null, `${tools().openPanel}`)
  // But only its OWN. A tool that closed whatever happened to be open would be
  // reaching outside itself.
  tools().setOpenPanel('snap')
  tools().setCutActive(false)
  check('and leaves another panel alone', tools().openPanel === 'snap', `${tools().openPanel}`)
  tools().setOpenPanel(null)
  tools().setCutActive(true)
  tools().setCutPlane({ position: [-3, 0.45, 0], rotation: [0, 0, 0] })

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
  // The whole name is on the tile for a reader who cannot wait out a lap of it
  // walking past, or who has asked for no walking at all.
  shows('with its full name reachable without hovering', panel, 'title="Bracket"')

  // TWO DRAG SOURCES PER TILE, one at each top corner, the way a Solids row
  // carries a body and a grip. The body adds the object; the grip drops the
  // same object as an ERASER, so the shelf of things the user built is also the
  // shelf of the holes their shapes make.
  shows('and a grip that places it as an eraser', panel, 'custom-erase')
  check(
    'one per tile, not one for the shelf',
    occurrences(panel, 'class="custom-erase"') === library().customs.length,
    `${occurrences(panel, 'class="custom-erase"')} grips for ${library().customs.length} tiles`
  )
  shows('saying what it places', panel, 'Bracket eraser, drag into the scene')
  shows('and that nothing happens until it is confirmed', panel, 'until you confirm')

  {
    const saved = library().customs[0].object
    const wasSelected = primarySelection(doc())

    doc().startPlacingSolidTemplate(saved, true)
    const armed = doc().drag
    check(
      'the grip arms an eraser',
      armed.kind === 'placing-solid' && armed.template.erase === true,
      armed.kind,
    )
    check(
      'named for what it takes away',
      armed.kind === 'placing-solid' && armed.template.name.endsWith(' eraser'),
      armed.kind === 'placing-solid' ? armed.template.name : armed.kind
    )
    // THE WHOLE SHAPE ERASES, not the primitive it was grown from. A hole is
    // evaluated the way a merged part is, so everything the thumbnail shows is
    // what comes out of whatever this is aimed at -- which is the entire reason
    // the grip is here rather than on the Solids rows alone.
    check(
      'and erasing with everything the tile shows, not the primitive under it',
      armed.kind === 'placing-solid' &&
        saved.features.length + saved.parts.length > 0 &&
        armed.template.features.length === saved.features.length &&
        armed.template.parts.length === saved.parts.length,
      armed.kind === 'placing-solid'
        ? `${armed.template.features.length}/${armed.template.parts.length} against ${saved.features.length}/${saved.parts.length}`
        : armed.kind
    )
    // Released off the canvas: the gesture cost nothing but the ids it minted.
    doc().commitPlacingSolid()

    // THE FLAG DECIDES, NOT THE TEMPLATE. An eraser can be right-clicked and
    // saved while it is still being aimed, so the shelf can hold an object that
    // is one already -- and a drag from the tile's BODY has to add material
    // anyway, or that one tile would erase from both of its corners.
    doc().startPlacingSolidTemplate({ ...saved, erase: true })
    const body = doc().drag
    check(
      'while the body still adds material, even from a tile saved mid-aim',
      body.kind === 'placing-solid' && !body.template.erase,
      body.kind
    )
    doc().commitPlacingSolid()

    // ACTIVATING A TILE FROM THE KEYBOARD LANDS THE WHOLE OBJECT. There is no
    // pointer to follow and no release to end the gesture, so the placement is
    // armed and committed in one go -- and it goes through that path rather
    // than through `addObject`, which builds from a BASE. It used to land the
    // bare primitive the object was built on, pockets and merged parts gone:
    // the one shape on the shelf the thumbnail beside it was not a picture of.
    const before = doc().doc.objects.length
    const template = templateOf(saved)
    doc().startPlacingSolidTemplate(template)
    doc().updatePlacingSolid([0, 0, 0])
    doc().commitPlacingSolid()
    const dropped = doc().doc.objects[doc().doc.objects.length - 1]
    check(
      'activating a tile drops the object whole',
      dropped.features.length === saved.features.length &&
        dropped.parts.length === saved.parts.length,
      `${dropped.features.length} sketches, ${dropped.parts.length} parts`
    )
    check('as one object', doc().doc.objects.length === before + 1, `${doc().doc.objects.length}`)
    doc().undo()
    check('and one undo takes it back', doc().doc.objects.length === before, `${doc().doc.objects.length}`)
    doc().selectObject(wasSelected)
  }

  {
    // WHICH CORNER IS WHICH lives only in the stylesheet. The markup says
    // nothing about where either control is drawn, so the one thing the eye
    // actually reads -- the cross on the left, the grip on the right -- would
    // otherwise be free to swap the first time somebody tidies these rules.
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const ruleOf = (selector: string): string => css.split(`\n${selector} {`)[1]?.split('}')[0] ?? ''
    const pxOf = (rule: string, prop: string): number =>
      Number(new RegExp(`\\n\\s*${prop}:\\s*(-?\\d+)px`).exec(rule)?.[1] ?? NaN)

    const remove = ruleOf('.custom-remove')
    const erase = ruleOf('.custom-erase')
    check(
      'the remove cross hangs off the top left',
      Number.isFinite(pxOf(remove, 'left')) && !Number.isFinite(pxOf(remove, 'right')),
      remove.replace(/\s+/g, ' ').trim().slice(0, 60)
    )
    check(
      'and the eraser grip off the top right, opposite it',
      Number.isFinite(pxOf(erase, 'right')) && !Number.isFinite(pxOf(erase, 'left')),
      erase.replace(/\s+/g, ' ').trim().slice(0, 60)
    )
    // Not peers. One is a grip to go looking for and drag out of; the other
    // throws the tile away, and the corner caught by accident should be the
    // harmless one.
    check(
      'the grip being the bigger of the two',
      pxOf(erase, 'width') > pxOf(remove, 'width'),
      `${pxOf(erase, 'width')}px against ${pxOf(remove, 'width')}px`
    )
    // Both out of sight until the tile is pointed at: a shelf of corner chrome
    // reads as a panel about deleting and erasing, which is not what it is for.
    check(
      'and both waiting for the pointer',
      erase.includes('opacity: 0') &&
        remove.includes('opacity: 0') &&
        css.includes('.custom-tile:hover .custom-erase'),
      ''
    )
    // The name is centred on the SQUARE, so it insets by the deeper of the two
    // corners on both sides rather than by one each -- see `.custom-name`.
    const name = ruleOf('.custom-name')
    check(
      'with the name clearing them both without leaving centre',
      pxOf(name, 'left') === pxOf(name, 'right') &&
        pxOf(name, 'left') >= pxOf(erase, 'width') + pxOf(erase, 'right'),
      `${pxOf(name, 'left')}px inset against a grip reaching ${pxOf(erase, 'width') + pxOf(erase, 'right')}px`
    )
  }

  // A NAME TOO LONG FOR ITS TILE WALKS PAST WHILE THE POINTER IS ON IT, and the
  // walk is a function of the clock rather than a position nudged along each
  // frame -- so this is checkable without a DOM, which is the reason it was
  // written that way. A tile is about a hundred pixels wide and the names people
  // give things are longer than that; the alternative to walking was clicking
  // into the field and arrowing across, which is an edit gesture done in order
  // to read.
  {
    const travel = 60
    // 30 px a second over 60 px is two seconds of walking, with an 800 ms rest
    // at each end: 5600 ms the lap.
    const walk = (travel / 30) * 1000
    const lap = 2 * (800 + walk)
    check('it starts at the beginning of the name', marqueeOffset(travel, 0) === 0, '')
    check(
      'and rests there before setting off',
      marqueeOffset(travel, 799) === 0,
      `${marqueeOffset(travel, 799)}`
    )
    near('half way through the walk it is half way along', marqueeOffset(travel, 800 + walk / 2), travel / 2, 1e-9)
    near('it reaches the end', marqueeOffset(travel, 800 + walk), travel, 1e-9)
    near('and rests at the end too', marqueeOffset(travel, 1500 + walk), travel, 1e-9)
    near('then walks back', marqueeOffset(travel, 1600 + 1.5 * walk), travel / 2, 1e-9)
    // A LAP, not a one-way trip: the tile is still hovered, and the beginning of
    // a name is the part that identifies it.
    near('and the lap comes round to where it started', marqueeOffset(travel, lap), 0, 1e-9)
    near('however many laps have gone by', marqueeOffset(travel, lap * 7 + 800 + walk), travel, 1e-9)
    // NEVER PAST EITHER END, at any moment of any lap: a scroller handed an
    // offset past its own travel simply clamps, and the name would sit still at
    // one end for however long the arithmetic was wrong.
    let worst = 0
    for (let t = 0; t < lap * 3; t += 13) {
      const at = marqueeOffset(travel, t)
      worst = Math.max(worst, Math.max(-at, at - travel))
    }
    check('and never past either end of the name', worst <= 1e-9, `overshoot ${worst}`)
    // A name that FITS does not move at all, which is what keeps a shelf of
    // short names still.
    check(
      'a name that fits its tile never moves',
      marqueeOffset(0, 1234) === 0 && marqueeOffset(-5, 1234) === 0,
      ''
    )
    check('and a clock that reports nonsense moves nothing', marqueeOffset(travel, Number.NaN) === 0, '')
  }

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
  //
  // Matched as a PREFIX rather than as the whole condition, because there is
  // now a third term after it: a triangle ceiling above which a solid goes
  // without its outline. What this check is for is that the switch reaches the
  // viewport at all, and that survives another `&&` being added; pinning the
  // exact text would make it a check on the shape of one line instead.
  const sceneObjects = readFileSync(
    new URL('../src/viewport/SceneObjects.tsx', import.meta.url),
    'utf8'
  )
  check(
    'and the scene actually gates its edge lines on the switch',
    sceneObjects.includes('{showOutlines && !dragging &&'),
    'the switch would hold a state nothing in the viewport reads'
  )
  // The ceiling is the other half of that gate and costs the most when it is
  // quietly dropped: without it a laser-cut piece draws about one outline
  // segment per triangle, which is a second of the main thread per edit and
  // twice the solid's own triangles on the GPU, to draw its triangulation.
  check(
    'and drops them entirely on a solid too dense for them to describe',
    sceneObjects.includes('OUTLINE_TRIANGLE_LIMIT'),
    'a dense import would outline its triangulation'
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

    doc().startErode(torched, 'torch')
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

    doc().startErode(clay, 'sculpt')
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
    doc().startErode(clay, 'torch')
    doc().erodeAt([0, 1, 0], DEFAULT_BRUSH_RADIUS, 0.6, 0.7)
    doc().endDrag()
    const marks = marksOf()
    check('both brushes write one list', marks.length === 5, `${marks.length}`)
    check('in the order they were used', marks[4].raise === undefined && marks[0].raise === true, JSON.stringify(marks[4]))

    // The direction is the GESTURE's. Nothing the panel does mid-stroke can
    // turn a bead being drawn into a groove being cut.
    doc().startErode(clay, 'sculpt')
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

// --- The Smoother -----------------------------------------------------------
console.log('\nThe Smoother is the brush that arrives somewhere and stops')
{
  const smoother = markupOf('SmootherTool', SmootherTool)
  shows('the Smoother is in the island', smoother, 'Smoother')
  shows('and rests disarmed', smoother, 'aria-pressed="false"')
  // NO HOVER BUBBLE, which is the island's rule rather than this tool's
  // preference -- every button here is aimed at the scene and pressed
  // constantly, so a paragraph that appears whenever the pointer crosses one
  // lands on top of the model it is about to work. Checked against the two
  // brushes beside it, so the claim is "the same as its neighbours" rather than
  // a string that happens to be absent today. See `ModeTool`.
  hides('it carries no hover bubble', smoother, 'nav-tip')
  hides('nor does the blowtorch', markupOf('ErodeTool (bubble)', ErodeTool), 'nav-tip')
  hides('nor the sculpt tool', markupOf('SculptTool (bubble)', SculptTool), 'nav-tip')

  // TWO DIALS, NOT THREE. The missing one is Smoothing, which on this tool
  // would be its own name written on a control inside it: there is nothing here
  // for smoothing to be a share OF.
  tools().setOpenPanel('smoother')
  const panel = markupOf('SmootherTool (open)', SmootherTool)
  shows('its panel offers a brush size', panel, '>Brush size<')
  shows('and a strength', panel, '>Strength<')
  hides('and no smoothing, which would be its own name', panel, '>Smoothing<')
  hides('nor heat, which is the torch\'s metaphor', panel, '>Heat<')
  shows('the size owns its unit, as the other brushes\' do', panel, 'aria-label="Brush size unit"')
  hides('and never offers auto', panel, '>auto<')

  // ITS OWN PANEL ID, and this is the check that says why it could not simply
  // be called `smooth`: that name belongs to the Lathe's rib, on another screen
  // with another panel behind it, and one id for two panels would have opened
  // whichever happened to be mounted.
  check('the Smoother owns its own panel id', tools().openPanel === 'smoother', `${tools().openPanel}`)
  check('which is not the lathe rib\'s', ISLAND_PANELS.includes('smooth') && ISLAND_PANELS.includes('smoother'), '')

  // Its panel hangs off a button inside the island, so the island shutting has
  // to shut it -- the bug `ISLAND_PANELS` exists to prevent. See the torch's.
  tools().setIslandCollapsed(true)
  check('collapsing the island shuts the Smoother panel', tools().openPanel === null, `${tools().openPanel}`)
  tools().setIslandCollapsed(false)
  check('and it does not spring back', tools().openPanel === null, `${tools().openPanel}`)
  tools().setOpenPanel(null)

  // ONE BRUSH AT A TIME, now three of them. Nothing enforces it: the store
  // holds a single mode, so arming any is choosing against the others.
  tools().setBrushTool('torch')
  tools().setBrushTool('smoother')
  check('arming the Smoother puts the torch down', tools().brushTool === 'smoother', `${tools().brushTool}`)
  tools().setBrushTool('sculpt')
  check('and arming the sculpt tool puts the Smoother down', tools().brushTool === 'sculpt', `${tools().brushTool}`)
  shows(
    'the island shows the Smoother unlit while another brush is up',
    markupOf('SmootherTool (sculpt armed)', SmootherTool),
    'aria-pressed="false"'
  )
  tools().setBrushTool(null)

  // ITS OWN DIALS, held to the brush's bounds rather than the tool's -- the
  // same bargain the sculpt tool strikes.
  tools().setSmootherRadius(999)
  check('the Smoother size is held to the same ceiling', tools().smootherRadius === BRUSH_RADIUS_MAX, `${tools().smootherRadius}`)
  tools().setSmootherRadius(-4)
  check('and the same floor', tools().smootherRadius === BRUSH_RADIUS_MIN, `${tools().smootherRadius}`)
  tools().setSmootherStrength(5)
  check('strength is a ratio', tools().smootherStrength === 1, `${tools().smootherStrength}`)
  // The floor is geometry rather than taste: a round finer than the triangles
  // under it cannot be shown, and asking for one spends the whole vertex budget
  // arriving at nothing. The answer to wanting a finer round is a finer brush.
  tools().setSmootherStrength(0)
  check('and it bottoms out above zero', tools().smootherStrength === ROUND_MIN, `${tools().smootherStrength}`)
  tools().setSmootherRadius(0.9)
  check('the torch keeps its own size through all of that', tools().erodeRadius === DEFAULT_BRUSH_RADIUS, `${tools().erodeRadius}`)
  check('and the sculpt tool keeps its own', tools().sculptRadius === DEFAULT_BRUSH_RADIUS, `${tools().sculptRadius}`)
  tools().setSmootherRadius(DEFAULT_SMOOTHER_RADIUS)
  tools().setSmootherStrength(DEFAULT_BRUSH_ROUND)

  // AND IT OPENS FINER THAN THE OTHER TWO, which is the one place the three
  // brushes' defaults are deliberately not the same number. The torch and the
  // sculpt tool are how a shape is arrived at and open wide enough to move a
  // face; this one is aimed at an edge, and an edge is a thin thing. Pinned
  // rather than left to drift, because the bounds and the clamps are shared and
  // nothing else in the code would notice this going back to 3 cm.
  check('the Smoother opens at a centimetre', DEFAULT_SMOOTHER_RADIUS === 0.1, `${DEFAULT_SMOOTHER_RADIUS}`)
  check(
    'which is finer than the brushes that move the surface',
    DEFAULT_SMOOTHER_RADIUS < DEFAULT_BRUSH_RADIUS,
    `${DEFAULT_SMOOTHER_RADIUS} against ${DEFAULT_BRUSH_RADIUS}`
  )

  // WHAT THE ARMED BRUSH HANDS THE STROKE. One place knows which dials to read,
  // and the Smoother is the entry that could most easily be wrong: it must send
  // no bite and no flow, or the dab would melt as well as round.
  tools().setBrushTool('smoother')
  const armed = armedBrush(tools())
  check('the armed Smoother reports its own radius', armed?.radius === DEFAULT_SMOOTHER_RADIUS, `${armed?.radius}`)
  check('with no bite', armed?.force === 0, `${armed?.force}`)
  check('and no flow', armed?.smooth === 0, `${armed?.smooth}`)
  check('and the round it is driving at', armed?.round === DEFAULT_BRUSH_ROUND, `${armed?.round}`)
  check('while the torch reports no round at all', (tools().setBrushTool('torch'), armedBrush(tools())?.round) === null, '')
  tools().setBrushTool(null)

  // THE STROKE AS THE DOCUMENT SEES IT. The third brush writes the SAME list as
  // the other two, in the order the marks were made -- a groove melted across a
  // rounded edge and an edge rounded across a groove are different surfaces.
  {
    const edge = doc().addObject({ kind: 'box', size: [2, 2, 2] }, [0, 1.5, 0])
    const marksOf = () => doc().doc.objects.find((o) => o.id === edge)?.erosion ?? []
    const entries = doc().past.length

    doc().startErode(edge, 'smoother')
    check('a Smoother stroke takes the same drag kind', doc().drag.kind === 'erode', doc().drag.kind)
    for (let i = 0; i < 4; i++) {
      doc().erodeAt([-0.3 + i * 0.2, 1, 1], DEFAULT_SMOOTHER_RADIUS, 0, 0, 0.5)
    }
    doc().endDrag()
    check('it lays a dab per step', marksOf().length === 4, `${marksOf().length}`)
    check(
      'and costs one undo entry, like every other drag',
      doc().past.length === entries + 1,
      `${doc().past.length - entries}`
    )
    check('every dab of it carries a round', marksOf().every((d) => d.round === 0.5), JSON.stringify(marksOf()[0]))
    // Zero heat and zero smoothing are not placeholders: this brush neither
    // bites nor pours, so zero is the honest reading of both.
    check('and neither bites nor pours', marksOf().every((d) => d.heat === 0 && d.smooth === 0), JSON.stringify(marksOf()[0]))
    check('and none of them raises', marksOf().every((d) => d.raise === undefined), JSON.stringify(marksOf()[0]))

    // A torch stroke over the top goes in the same list, after them.
    doc().startErode(edge, 'torch')
    doc().erodeAt([0, 1, 1], DEFAULT_BRUSH_RADIUS, 0.6, 0.7)
    doc().endDrag()
    const marks = marksOf()
    check('all three brushes write one list', marks.length === 5, `${marks.length}`)
    // ABSENT RATHER THAN ZERO on a dab from another brush, which is what keeps
    // the evaluator's cache key -- this array, stringified -- from being
    // invalidated on every torched object by this tool merely existing.
    check(
      'and a torch dab carries no round field at all',
      marks[4].round === undefined,
      JSON.stringify(marks[4])
    )

    // WHICH BRUSH IS THE GESTURE'S. Nothing the panel does mid-stroke can turn
    // a corner being rounded into a groove being cut.
    doc().startErode(edge, 'smoother')
    tools().setBrushTool('torch')
    doc().erodeAt([0.4, 1, 1], DEFAULT_SMOOTHER_RADIUS, 0.9, 0.9, 0.5)
    doc().endDrag()
    tools().setBrushTool(null)
    check(
      'a stroke keeps the brush it started with',
      marksOf()[5].round === 0.5 && marksOf()[5].heat === 0,
      JSON.stringify(marksOf()[5])
    )

    doc().removeObject(edge)
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
  // And it has one of its own now, which is what a console per screen was for:
  // the section the lump is turned on describes the piece rather than the
  // document, so it could never have lived in the other console at all.
  shows('and it carries a Base of its own', lathe, '>Base<')
  // Under the shelf, not over it: the Clipboard is the panel both consoles
  // carry, so it keeps the top slot it has next door and the two screens agree
  // about where the one thing they share lives.
  check(
    'below the clipboard, which is the panel both consoles carry',
    lathe.indexOf('>Clipboard<') < lathe.indexOf('>Base<'),
    `clipboard ${lathe.indexOf('>Clipboard<')}, base ${lathe.indexOf('>Base<')}`
  )

  // On a screen with no document, everything that acts on one stands down --
  // dimmed and still in place, so the bar keeps its shape between screens.
  tools().setScreen('lathe')
  {
    const idle = markupOf('NavBar (lathe)', NavBar)
    shows('switching screens lights the other tab', idle, 'aria-current="page">Lathe<')
    hides('and puts Modelling out', idle, 'aria-current="page">Modelling<')

    // Counted rather than named one at a time: what matters is that the
    // controls acting on the document all stand down together.
    //
    // FOUR, NOT SIX. Undo and redo used to be in this list and are not any
    // more: the lathe has a history of its own now, so the bar's two buttons
    // walk whichever screen is up and are dead only when there is nothing to
    // step. On an untouched lump that is still dead -- which is why the count
    // below is a floor rather than an equality -- but it is dead for a reason
    // that has nothing to do with which screen this is. See `NavBar`.
    const down = (idle.match(/disabled=""/g) ?? []).length
    check(
      'the document controls stand down together',
      down >= 4,
      `${down} disabled: Import, Export, Snap and its caret`
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

  // THE ISLAND HOLDS A SHORT LIST, and it is worth a check that would fail the
  // day it stopped being one. It held two for its whole first life -- push and
  // pull, the whole promise of the easy screen -- and now holds those two, a
  // rib under a rule, and a switch for hollowing. What the rule is there to say
  // is that the pair above it are the ones that MOVE MATERIAL and the rest are
  // not; see `LatheViewport`, which lays them out.
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

  // PUSH IS IN HAND ON ARRIVAL, so the first press anybody makes on the clay
  // does something. Read off the store's own initial state rather than the
  // live one, which every check above this has been arming and disarming.
  check(
    'the lathe opens with Push in hand',
    useTools.getInitialState().latheTool === 'push',
    `${useTools.getInitialState().latheTool}`
  )

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

  // POINT SCULPT: the fourth tool, and the only one on this screen that is not
  // held against anything. It shares the field with the three brushes -- taking
  // it up puts a brush down -- because they all claim the same press on the
  // clay.
  {
    tools().setLatheTool('push')
    tools().setLatheTool('points')
    check('taking up Point Sculpt puts the brush down', tools().latheTool === 'points', `${tools().latheTool}`)
    check(
      'and it is not a brush, so nothing is armed to work the wall',
      armedLatheTool(useTools.getState()) === null,
      `${armedLatheTool(useTools.getState())}`
    )
    tools().setLatheTool('push')
    check('and taking a brush back up puts it down', tools().latheTool === 'push', `${tools().latheTool}`)

    tools().setLatheTool('points')
    tools().setOpenPanel('points')
    const panel = markupOf('PointSculptTool', PointSculptTool)
    shows('its panel offers the curve switch', panel, 'Fit to line')
    // NO SIZE AND NO STRENGTH, which is the whole shape of the tool said in
    // what is absent: a brush has to be told how much wall it covers and how
    // fast the clay comes to it, and this one is told by where the points were
    // put and answers "all of it" to the second.
    hides('and no brush size, which the points already say', panel, '>Tool size<')
    hides('nor a strength, since nothing is held', panel, '>Strength<')

    // IT OPENS CURVED where the cutter's opens straight, and the two are their
    // own switches: a turned profile is a curve almost by definition, and a cut
    // through a block is not. Setting one must not move the other.
    check('the lathe opens with the curve on', useTools.getInitialState().sculptFit === true, `${useTools.getInitialState().sculptFit}`)
    check('where the cutter opens straight', useTools.getInitialState().fitCurve === false, `${useTools.getInitialState().fitCurve}`)
    const cutterWas = tools().fitCurve
    tools().setSculptFit(false)
    check("turning the lathe's curve off leaves the cutter's alone", tools().fitCurve === cutterWas, `${tools().fitCurve}`)
    tools().setSculptFit(true)
  }

  // AND ITS APPLY IS STANDING CHROME, not a flyout. An island panel shuts on
  // any press that lands outside the island, and placing a point IS such a
  // press -- so a button living under the tool's caret would be shut by the
  // very act of drawing the line it applies. The cutting bench learned this
  // first; the panel wears its class so `NavBar`'s one exemption list covers
  // both rather than growing a second entry to drift from.
  {
    tools().setLatheTool('points')
    useSculptDraft.getState().clear()
    const empty = markupOf('SculptPanel (nothing drawn)', SculptPanel)
    shows('the profile panel names what it is about', empty, 'The profile')
    // TWO BUTTONS AND NOTHING ELSE. The panel used to carry a line of standing
    // prose -- what to click, how many points, where the handles had gone --
    // and standing is the word that made it wrong: it was on screen for the
    // whole sitting, saying what the user knew after the first point, and it
    // pushed the buttons down the corner to say it. What the tool is and how it
    // is aimed live in Help, read once rather than glanced past a hundred
    // times.
    hides('and asks for nothing in standing prose', empty, 'place a point')
    check(
      'so an empty panel is its heading and its two buttons',
      (empty.match(/<p/g) ?? []).length === 0,
      `${(empty.match(/<p/g) ?? []).length} paragraphs`
    )

    useSculptDraft.getState().addPoint([0.3, 0.2])
    hides('one point adds no commentary either', markupOf('SculptPanel (one point)', SculptPanel), 'One more point')

    useSculptDraft.getState().addPoint([0.9, 0.3])
    const ready = markupOf('SculptPanel (a line)', SculptPanel)
    shows('two points make a line to apply', ready, 'Apply profile')
    hides('and still nothing about where the handles went', ready, 'Click another to adjust it')
    const applyTag = ready.split('<button').find((part) => part.includes('>Apply profile</button>'))
    check(
      'and the button is live',
      applyTag !== undefined && !applyTag.slice(0, applyTag.indexOf('>')).includes('disabled'),
      'a line of two points is enough to cut with'
    )

    // IT COMES AND GOES WITH THE TOOL. With a brush in hand there is no line to
    // apply and nothing to say, so the corner goes back to being the stock
    // panel on its own.
    tools().setLatheTool('push')
    check('with a brush in hand the profile panel renders nothing', renderToStaticMarkup(createElement(SculptPanel)) === '', 'the corner goes back to being scene')
    tools().setLatheTool(null)
    check('and with empty hands too', renderToStaticMarkup(createElement(SculptPanel)) === '', '')

    useSculptDraft.getState().clear()
  }

  // THE DRAFT IS NOT THE PIECE, which is the line `sculptDraft` is drawn on:
  // points are placed, dragged and thrown away without the history hearing
  // about any of it, and only Apply is an act.
  {
    const draft = useSculptDraft.getState()
    draft.clear()
    draft.addPoint([0.3, 0.2])
    draft.addPoint([0.9, 0.3])
    check('a placed point takes the curve\'s own tangent', useSculptDraft.getState().handles.every((h) => h === null), '')
    draft.moveHandle(0, [0.4, 0.25], 1)
    check('and aiming one keeps it', useSculptDraft.getState().handles[0] !== null, '')
    check('while its neighbour goes on being fitted', useSculptDraft.getState().handles[1] === null, '')
    draft.refitHandle(0)
    check('handing it back to the curve is the way out', useSculptDraft.getState().handles[0] === null, '')
    draft.movePoint(1, [1.1, 0.35])
    check('moving a point moves it', useSculptDraft.getState().points[1][0] === 1.1, `${useSculptDraft.getState().points[1]}`)
    draft.clear()
  }

  // ONE TANGENT AT A TIME, and the drawing says which. Six points drawn with
  // six tangents out is eighteen marks over a line made of six, every bar
  // across the curve it is bending and every grip the same size as the rest --
  // so the thing under the pointer is whichever mark is nearest rather than the
  // one being worked on. Placing selects, and pressing an earlier knot selects
  // it back; nothing is lost either way, since the handle a point was aimed to
  // is a property of the point. See `selected` in `sculptDraft`.
  {
    const draft = useSculptDraft.getState()
    draft.clear()
    check('an empty drawing has nothing in hand', useSculptDraft.getState().selected === null, `${useSculptDraft.getState().selected}`)
    draft.addPoint([0.3, 0.2])
    check('the first point is the live one', useSculptDraft.getState().selected === 0, `${useSculptDraft.getState().selected}`)
    draft.addPoint([0.9, 0.3])
    check('and the newest point takes the handles off it', useSculptDraft.getState().selected === 1, `${useSculptDraft.getState().selected}`)

    draft.moveHandle(1, [1.0, 0.4], 1)
    draft.selectPoint(0)
    check('an earlier point can be taken back up', useSculptDraft.getState().selected === 0, `${useSculptDraft.getState().selected}`)
    check('and the one put down keeps what it was aimed to', useSculptDraft.getState().handles[1] !== null, 'a tangent is a property of the point, not of the selection')

    draft.selectPoint(7)
    check('a point that is not there cannot be taken up', useSculptDraft.getState().selected === 0, `${useSculptDraft.getState().selected}`)
    draft.selectPoint(-1)
    check('nor can one before the first', useSculptDraft.getState().selected === 0, `${useSculptDraft.getState().selected}`)

    draft.movePoint(0, [0.35, 0.25])
    check('dragging the live point leaves it live', useSculptDraft.getState().selected === 0, `${useSculptDraft.getState().selected}`)

    draft.clear()
    check('and Reset leaves nothing in hand', useSculptDraft.getState().selected === null, `${useSculptDraft.getState().selected}`)
  }

  // EVERY STROKED MARK ON THE LATHE IS NON-SCALING, and this is a source check
  // because nothing else can catch it. The lathe svg is measured in SCENE
  // UNITS, so a `stroke-width: 1.5px` in the stylesheet is read as 1.5 UNITS --
  // about 340 pixels at the opening zoom. A mark that forgets the attribute
  // renders as a ring the size of the window with the piece somewhere inside
  // it, and it passes every check that reads geometry or counts elements,
  // because the markup is right and only the paint is wrong. One grip shipped
  // that way and was found by looking at the screen.
  {
    const layer = readFileSync(new URL('../src/viewport/SculptLayer.tsx', import.meta.url), 'utf8')
    // The hyphen matters: it takes the MARKS and not the group they sit in,
    // which carries the bare class and strokes nothing.
    const marks = layer.split('className="lathe-sculpt-').slice(1)
    const bare = marks.filter((m) => !m.slice(0, m.indexOf('/>') + 2).includes('non-scaling-stroke'))
    check(
      'every mark Point Sculpt draws holds its stroke to the screen',
      bare.length === 0,
      bare.length === 0
        ? `${marks.length} marks, all non-scaling`
        : `${bare.length} of ${marks.length} would paint in scene units`
    )
  }

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
    // ONE WORD, and it is the word every other app in the world uses for the
    // way back. The caps are the stylesheet's, so what is checked here is the
    // name rather than the shouting.
    shows('and it offers a reset', panel, '>Reset<')
    hides('without a paragraph under it explaining itself', panel, 'stock-note')
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
    lathe().work({ y: 0.75, radius: 0.2, reach: 0.3, bite: 1, tool: 'push' })
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
      tool: 'push',
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
    const frame = clayFrame(1)
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
    // SQUARE, and it is the squareness that keeps the drawing still: `meet`
    // re-fits on the frame's ASPECT, so a frame whose aspect tracked the stock
    // would redraw the whole picture -- plate included -- narrower every time
    // somebody asked for a taller lump.
    check(
      'and the frame is square, so `meet` fits it the same way whatever is in it',
      frame.width === frame.height,
      `${frame.width.toFixed(3)} by ${frame.height.toFixed(3)}`
    )

    // A landscape element, so the square frame fits by HEIGHT and is letterboxed
    // left and right. That is the case a hand-written inverse gets wrong, so it
    // is the one to check.
    const square = { left: 0, top: 0, width: 900, height: 600 }
    const scale = square.height / frame.height
    const middle = pointerToClay(frame, square, 450, 300)
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
    const right = pointerToClay(frame, square, 450 + scale * 0.3, 300)
    near('a point right of the axis reads as that far out', right.x, 0.3, 1e-9)
    const left = pointerToClay(frame, square, 450 - scale * 0.3, 300)
    near('and the same point on the left is the same distance', left.radius, right.radius, 1e-9)
    check('with the sign kept for the drawing', left.x < 0 && right.x > 0, '')

    // Up the screen is up the piece, which is the flip this module exists to
    // own -- SVG counts y downward and a lathe counts it up off the faceplate.
    const higher = pointerToClay(frame, square, 450, 200)
    check('higher on screen is higher up the piece', higher.y > middle.y, '')
    near('by exactly the pixels it moved', higher.y - middle.y, 100 / scale, 1e-9)

    // And the faceplate itself: the y the frame calls the clay's zero.
    const onPlate = pointerToClay(frame, square, 450, (frame.base / frame.height) * 600)
    near('the faceplate is the clay zero', onPlate.y, 0, 1e-9)

    // A zero-sized element is not a thing anyone can point at, but a layout can
    // produce one for a frame, and it must not divide by nothing.
    const nothing = pointerToClay(frame, { left: 0, top: 0, width: 0, height: 0 }, 10, 10)
    check('and a zero-sized viewport reads as the origin', nothing.y === 0, `${nothing.y}`)
  }

  // A LUMP THAT GROWS HAS TO LOOK LIKE ONE, which is a fact about the frame
  // rather than about the clay. Cut to the stock, the frame grew with the piece
  // and `meet` scaled the difference straight back out again: a taller lump was
  // drawn at the same height as a short one and merely narrower, so the Height
  // field read as a width field. Rounded onto a ladder it stopped doing that and
  // started doing something else instead -- rescaling in steps, unasked, mid-drag.
  //
  // What replaced both is a frame the clay cannot reach. `clayFrame` takes a
  // ZOOM and no `Clay` at all, so these checks are really one check made several
  // ways: nothing about the piece moves the view.
  {
    const frame = clayFrame(1)
    check(
      'the frame is square, so `meet` fits it the same way whatever is in it',
      frame.width === frame.height,
      `${frame.width} by ${frame.height}`
    )
    // Every lump the app can make, against ONE frame. A stock 5000 times another
    // gets the same viewBox, the same plate and the same rules -- which is what
    // there being no `Clay` in the signature buys, stated out loud.
    for (const [height, radius] of [
      [CLAY_HEIGHT_MIN, CLAY_RADIUS_MIN],
      [CLAY_HEIGHT_MAX, CLAY_RADIUS_MIN],
      [CLAY_HEIGHT_MIN, CLAY_RADIUS_MAX],
      [CLAY_HEIGHT_MAX, CLAY_RADIUS_MAX],
      [DEFAULT_CLAY_HEIGHT, DEFAULT_CLAY_RADIUS],
    ]) {
      // Worked, not just centred, so a wall pulled right out to its flare limit
      // is in the sample too -- that is the case the OLD frame rescaled on.
      const lump = mold(freshClay(height, radius), {
        y: height * 0.5,
        radius: radius * CLAY_FLARE,
        reach: height * 0.3,
        bite: 1,
        tool: 'pull',
      })
      const box = clayFrame(1)
      check(
        `a ${height}x${radius} lump leaves the frame exactly where it was`,
        box.width === frame.width &&
          box.height === frame.height &&
          box.base === frame.base &&
          box.rule === frame.rule,
        `${box.width} against ${frame.width}, widest ${widestRadius(lump).toPrecision(3)}`
      )
    }

    // The piece has somewhere to grow INTO, so growing is something the eye can
    // see rather than something only the readout knows about.
    check(
      'so a taller lump fills more of the frame',
      1.5 / frame.height > 1.1 / frame.height,
      `${((1.5 / frame.height) * 100).toFixed(0)}% against ${((1.1 / frame.height) * 100).toFixed(0)}%`
    )

    // The rules are a MEASURE, so the ones two pieces share are at the same
    // heights, and the taller piece simply reaches more of them. That is the
    // "reveal more guidelines" half of it, and it is the half a ring count
    // spread evenly over the piece can never do.
    const few = turningRings(freshClay(1.1, 0.4), frame)
    const many = turningRings(freshClay(1.5, 0.4), frame)
    check(
      'a taller lump reveals more rings rather than the same rings further apart',
      many.length > few.length,
      `${few.length} then ${many.length}`
    )
    check(
      'and the rings they share are in the same places',
      few.every((ring, i) => Math.abs(ring.y - many[i].y) < 1e-9),
      few.map((r) => r.y.toFixed(2)).join(' ')
    )
    check(
      'one rule apart, all the way up',
      many.every((ring, i) => Math.abs(frame.base - ring.y - (i + 1) * frame.rule) < 1e-9),
      `rule ${frame.rule}`
    )
    // A lump taller than the view is clipped by the top of it, and rings drawn
    // past that edge are rings drawn on nothing.
    const giant = turningRings(freshClay(CLAY_HEIGHT_MAX, 0.4), frame)
    check(
      'and a lump taller than the frame is ruled only as far as the frame goes',
      giant.length > 0 && giant.every((ring) => ring.y > frame.y),
      `${giant.length} rings, highest at ${Math.min(...giant.map((r) => r.y)).toFixed(3)}`
    )
  }

  // ZOOM: the only thing that moves this view, and the way back from a piece
  // that has run off the edge of it.
  {
    const wide = clayFrame(0.5)
    const close = clayFrame(2)
    check(
      'zooming out shows more of the world',
      wide.width > clayFrame(1).width && close.width < clayFrame(1).width,
      `${wide.width} / ${clayFrame(1).width} / ${close.width}`
    )
    // The plate is at a fixed FRACTION of the frame, so it does not move on
    // screen as the view zooms -- the piece stands on it, so it is the right
    // thing to hold still while you go looking for the rim.
    check(
      'and the faceplate stays put on screen through all of it',
      Math.abs(wide.base / wide.height - close.base / close.height) < 1e-12,
      `${(wide.base / wide.height).toFixed(6)} against ${(close.base / close.height).toFixed(6)}`
    )
    // The rules stay a round measure at every zoom rather than becoming some
    // arbitrary fraction of the frame -- that is what the ladder is for now.
    check(
      'the rules are a round length at every zoom',
      [0.02, 0.1, 0.35, 1, 1.7, 8, 50].every((z) => {
        const r = clayFrame(z).rule
        const decade = Math.pow(10, Math.floor(Math.log10(r)))
        return [1, 2, 3, 5, 7].some((rung) => Math.abs(rung * decade - r) < r * 1e-9)
      }),
      [0.1, 1, 8].map((z) => clayFrame(z).rule.toPrecision(2)).join(' ')
    )
    check(
      'and the frame carries between six and twelve of them',
      [0.02, 0.1, 0.35, 1, 1.7, 8, 50].every((z) => {
        const f = clayFrame(z)
        return f.width / f.rule >= 6 - 1e-9 && f.width / f.rule <= 12 + 1e-9
      }),
      [0.1, 1, 8]
        .map((z) => (clayFrame(z).width / clayFrame(z).rule).toFixed(1))
        .join(' ')
    )

    // Out of range in either direction is pulled back rather than honoured, so a
    // wheel held down cannot leave the view somewhere it takes fifty notches to
    // return from.
    check(
      'zoom is clamped at both ends and survives nonsense',
      clampZoom(1e9) === ZOOM_MAX &&
        clampZoom(0) === ZOOM_MIN &&
        clampZoom(-3) === ZOOM_MIN &&
        clampZoom(Number.NaN) === 1,
      `${ZOOM_MIN} .. ${ZOOM_MAX}`
    )

    // FIT is the one re-framing left, and it happens on a press. It has to work
    // at both ends of the stock range, which is the whole reason it exists.
    for (const [height, radius] of [
      [DEFAULT_CLAY_HEIGHT, DEFAULT_CLAY_RADIUS],
      [CLAY_HEIGHT_MAX, CLAY_RADIUS_MIN],
      [0.4, CLAY_RADIUS_MAX],
      [CLAY_HEIGHT_MIN, CLAY_RADIUS_MIN],
    ]) {
      const lump = freshClay(height, radius)
      const fitted = clayFrame(fitZoom(lump))
      check(
        `fitting a ${height}x${radius} lump puts it inside the frame`,
        lump.height <= fitted.base + 1e-9 &&
          widestRadius(lump) * 2 <= fitted.width + 1e-9,
        `${height} tall in ${fitted.base.toPrecision(3)}, ` +
          `${(widestRadius(lump) * 2).toPrecision(3)} across in ${fitted.width.toPrecision(3)}`
      )
    }
    // And it is a real fit rather than a retreat to the far end of the range:
    // the piece comes back filling most of the frame it is put in.
    const fitted = clayFrame(fitZoom(freshClay(4, 0.4)))
    check(
      'and fills it, rather than merely fitting somewhere inside it',
      4 / fitted.height > 0.7,
      `${((4 / fitted.height) * 100).toFixed(0)}%`
    )
  }

  // PAN: the other half of the same answer. Zoom says how much of the world the
  // frame covers; the pan says WHICH part, and without it a zoomed-in view can
  // only ever look at the one place the frame happens to start -- which on a
  // tall piece is the foot, forever.
  {
    const rest = clayFrame(1)
    const slid = clayFrame(1, { x: 0.3, y: -0.2 })

    // IT MOVES THE WINDOW, NOT THE DRAWING, which is the whole of the design:
    // every number the clay is placed against has to come out unchanged, or a
    // pan would be sliding the piece off its own lathe.
    check(
      'a pan moves the frame and nothing else about it',
      slid.x === rest.x + 0.3 &&
        slid.y === rest.y - 0.2 &&
        slid.width === rest.width &&
        slid.height === rest.height,
      `${slid.x} , ${slid.y}`
    )
    check(
      'the clay is drawn at exactly the same place either way',
      slid.base === rest.base && slid.rule === rest.rule,
      `${slid.base} against ${rest.base}`
    )
    check('and no pan is the frame as it always was', clayFrame(1).x === clayFrame(1, NO_PAN).x, '')

    // A LENGTH IN THE WORLD rather than a fraction of the frame, which is what
    // makes zoom anchor on a fixed point of the SCREEN: two centimetres off the
    // axis stays two centimetres, so zooming in magnifies the offset exactly as
    // it magnifies the piece.
    const near = clayFrame(4, { x: 0.3, y: 0 })
    check(
      'a slid view is slid by the same length at every zoom',
      Math.abs(near.x - -near.width / 2 - 0.3) < 1e-12,
      `${near.x - -near.width / 2}`
    )

    // Bounded, because a view can be dragged a long way by accident and empty
    // space looks the same everywhere. The bound is the tallest lump this app
    // will make -- anything tighter would be unusable on the pieces that most
    // need panning, since at the far end of the zoom range one is hundreds of
    // frames tall.
    check(
      'the pan is clamped at both ends and survives nonsense',
      clampPan({ x: 1e9, y: -1e9 }).x === PAN_LIMIT &&
        clampPan({ x: 1e9, y: -1e9 }).y === -PAN_LIMIT &&
        clampPan({ x: Number.NaN, y: 3 }).x === 0,
      `+/- ${PAN_LIMIT}`
    )
    check(
      'and it reaches past the tallest piece there can be',
      PAN_LIMIT >= CLAY_HEIGHT_MAX,
      `${PAN_LIMIT} against ${CLAY_HEIGHT_MAX}`
    )
  }

  // THE CONTROL IN THE CORNER. The frame no longer moves on its own, so this is
  // the only way to move it -- which makes "is it there, does it read right, and
  // does Fit stand down when there is nothing to fit" the whole of what has to
  // hold.
  {
    tools().setLatheZoom(1)
    lathe().centreFresh()

    const at100 = markupOf('ZoomControl', ZoomControl)
    shows('the corner says how far the view is zoomed', at100, '100%')
    shows('and offers a way in', at100, 'Zoom in')
    shows('and a way out', at100, 'Zoom out')
    // The default lump does not fill the default frame, so there IS something
    // for Fit to do the moment the screen opens -- an offer, not a warning.
    shows('with Fit live on the opening view', at100, 'Fit the piece to the frame')

    // Stepping is geometric, so two presses of the same button is a clean
    // halving or doubling however far out you already are.
    tools().zoomLathe(Math.SQRT2)
    tools().zoomLathe(Math.SQRT2)
    near('two presses in doubles the zoom', tools().latheZoom, 2, 1e-9)
    shows('and the readout follows', markupOf('ZoomControl (in)', ZoomControl), '200%')

    // Wound to the stops rather than past them: the ends are where the range
    // says, and the button that cannot go further stands down.
    tools().zoomLathe(1e9)
    check('winding in stops at the ceiling', tools().latheZoom === ZOOM_MAX, `${tools().latheZoom}`)
    check(
      'and the button that can go no further stands down',
      buttonIsDown(markupOf('ZoomControl (at the ceiling)', ZoomControl), 'Zoom in'),
      ''
    )
    tools().zoomLathe(1e-9)
    check('winding out stops at the floor', tools().latheZoom === ZOOM_MIN, `${tools().latheZoom}`)

    // And Fit: pressed, it puts the piece in the frame, and then has nothing
    // left to do -- so it stands down rather than sitting there live and inert.
    tools().setLatheZoom(fitZoom(lathe().clay))
    const atFit = markupOf('ZoomControl (fitted)', ZoomControl)
    shows('once fitted, Fit stands down', atFit, 'The piece already fits the frame')
    shows('rather than disappearing out of the corner', atFit, 'lathe-zoom-fit')

    // Far out, whole percents would read as a readout that had stuck: three of
    // the wheel's own steps down there all round to the same number.
    tools().setLatheZoom(ZOOM_MIN)
    shows(
      'and a zoom under ten percent keeps a decimal',
      markupOf('ZoomControl (far out)', ZoomControl),
      '1.6%'
    )

    tools().setLatheZoom(1)

    // A SLID VIEW IS NEVER A FITTED ONE. Fit's promise is "the piece, on the
    // screen", and a view dragged two metres off the axis does not keep that
    // promise however well its zoom is chosen -- so the pan counts toward the
    // question, and pressing Fit puts the view back over the middle on the way.
    tools().setLatheZoom(fitZoom(lathe().clay))
    tools().panLathe(0.9, -0.4)
    shows(
      'a view slid off the piece brings Fit back to life',
      markupOf('ZoomControl (slid)', ZoomControl),
      'Fit the piece to the frame'
    )
    tools().setLatheZoom(1)
    tools().panLathe(-tools().lathePan.x, -tools().lathePan.y)
  }

  // THE VIEW RESET, at the top of the corner column: the way back to the view
  // the screen opened with, which is a different question from Fit's. Fit says
  // "show me the piece"; this says "show me what I started with", and the two
  // part company the moment the view can be slid.
  {
    tools().setLatheZoom(1)
    tools().panLathe(-tools().lathePan.x, -tools().lathePan.y)

    // Found by the words on its face rather than by an `aria-label`, because it
    // has none and should not: the label would be the same string as the text
    // under it, which tells a screen reader nothing it was not already going to
    // say. The stock panel's own Reset is named the same way.
    const cameraDown = (markup: string) => {
      const tag = markup.split('<button').find((part) => part.includes('>Reset camera</button>'))
      return tag !== undefined && tag.slice(0, tag.indexOf('>')).includes('disabled=""')
    }

    const rested = markupOf('ViewResetButton (at rest)', ViewResetButton)
    shows('the corner offers a camera reset', rested, 'Reset camera')
    // Dead rather than hidden, the rule both its neighbours and the zoom
    // control follow: a control that appears the first time you need it is one
    // nobody knows is there for the one press they will want it for.
    check('dead while the view is already where it started', cameraDown(rested), '')

    tools().panLathe(0.5, 0.25)
    check('a pan slides the view', tools().lathePan.x === 0.5 && tools().lathePan.y === 0.25, JSON.stringify(tools().lathePan))
    check(
      'and wakes the reset',
      !cameraDown(markupOf('ViewResetButton (slid)', ViewResetButton)),
      ''
    )

    // Deltas accumulate, because a drag is a series of them.
    tools().panLathe(-0.2, 0.1)
    near('deltas accumulate', tools().lathePan.x, 0.3, 1e-12)
    near('on both axes', tools().lathePan.y, 0.35, 1e-12)

    // ONE ACTION FOR BOTH NUMBERS: "I have lost the piece" is one complaint
    // however it happened, and a button that fixed half of it would leave the
    // user hunting for the other half.
    tools().setLatheZoom(16)
    tools().resetLatheView()
    check(
      'and the reset puts the zoom and the pan back together',
      tools().latheZoom === 1 && tools().lathePan.x === 0 && tools().lathePan.y === 0,
      `${tools().latheZoom} at ${JSON.stringify(tools().lathePan)}`
    )
    check(
      'leaving it dead again',
      cameraDown(markupOf('ViewResetButton (reset)', ViewResetButton)),
      ''
    )

    // The zoom alone wakes it too -- the view is not where it started either way.
    tools().setLatheZoom(4)
    check(
      'a zoom on its own wakes it as well',
      !cameraDown(markupOf('ViewResetButton (zoomed)', ViewResetButton)),
      ''
    )
    tools().resetLatheView()
  }

  // The silhouette is one path, mirrored from one row of radii: both walls are
  // the same wall, so the drawing cannot disagree with itself about the shape.
  {
    const worked = mold(freshClay(1.5, 0.4), {
      y: 0.75,
      radius: 0.2,
      reach: 0.3,
      bite: 1,
      tool: 'push',
    })
    const frame = clayFrame(1)
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
    const rings = turningRings(worked, frame)
    check(
      'a ring for every rule the piece stands past, and one more would clear it',
      rings.length > 0 && (rings.length + 1) * frame.rule >= worked.height,
      `${rings.length} rings of ${frame.rule} over ${worked.height}`
    )
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

  // THE BASE THE PIECE STANDS ON, which is the one control on this screen that
  // is in the console rather than over the clay -- and it is there because it
  // is the one fact about the lump the drawing cannot show. `engine-check`
  // proves what a base does to the triangles; this proves the panel is wired to
  // it, and that picking one costs the piece nothing.
  {
    lathe().setSides(null)
    const round = markupOf('BasePanel', BasePanel)
    shows('the panel names itself', round, '>Base<')
    shows('and says which base the piece is on', round, '>Circle<')
    shows('it offers the round answer', round, '>Circle<')
    shows('and the family beside it', round, '>Polygon<')
    // Not merely dimmed: eight tiles a round piece has no use for would be the
    // biggest thing in this console, standing under a question already answered.
    hides('with no side tiles while the piece is round', round, 'base-side')

    lathe().setSides(6)
    const poly = markupOf('BasePanel (hexagon)', BasePanel)
    // The class ends there or carries the chosen flag; the grid around them is
    // `base-sides` and the marks inside them are `base-side-icon`, and a looser
    // pattern counts all three.
    const tiles = (poly.match(/class="base-side[" ]/g) ?? []).length
    check(
      'Polygon opens the whole run from a triangle to a decagon',
      tiles === CLAY_SIDES.length && tiles === 8,
      `${tiles} tiles`
    )
    shows('one of them chosen', poly, 'base-side base-side-on')
    shows('and the header says which', poly, '>Hexagon<')
    // The seg is the app's own segmented pair, and the pressed half is the one
    // the piece is actually on -- read off the store rather than off a second
    // copy of the answer kept in the panel.
    check(
      'exactly one of Circle and Polygon is pressed',
      (poly.match(/aria-pressed="true"/g) ?? []).length === 2,
      `${(poly.match(/aria-pressed="true"/g) ?? []).length} pressed, counting the chosen tile`
    )

    // A BASE IS NOT A RESIZE. This is what makes the selector safe to press
    // after an hour's work -- and it is the whole reason the section can live
    // outside the wall at all. See `Clay.sides`.
    lathe().setSides(null)
    lathe().work({ y: 0.75, radius: 0.2, reach: 0.3, bite: 1, tool: 'push' })
    const shaped = lathe().clay.wall.slice()
    lathe().setSides(8)
    check(
      'turning a worked piece octagonal moves no part of the wall',
      lathe().clay.wall.every((r, i) => r === shaped[i]),
      ''
    )
    check('and it stays worked', !isFresh(lathe().clay), '')
    // Out of range on the way in, because the store is what a panel writes to.
    lathe().setSides(99)
    check('a base past the family lands on the last of it', lathe().clay.sides === 10, `${lathe().clay.sides}`)

    // The stock fields and the fresh lump carry the base, for the same reason
    // they carry the shape: somebody who set a decagonal lump wants a decagonal
    // lump back.
    lathe().setRadius(0.5)
    check('resizing keeps the base', lathe().clay.sides === 10, `${lathe().clay.sides}`)
    lathe().centreFresh()
    check('and a fresh lump is centred on the same one', lathe().clay.sides === 10, `${lathe().clay.sides}`)
    check('unworked, as a fresh lump always is', isFresh(lathe().clay), '')

    // WHAT THE DRAWING DOES ABOUT IT. Nothing to the silhouette -- every base
    // has the same profile, which is the premise the whole screen rests on --
    // and one line inside it, at the apothem, so the choice is visible on the
    // piece rather than only on the clipboard.
    const frame = clayFrame(1)
    const decagon = lathe().clay
    const cylinder = { ...decagon, sides: null }
    check(
      'the profile is the same on every base',
      silhouette(decagon, frame) === silhouette(cylinder, frame),
      ''
    )
    check('a round piece draws no flats line', flatsProfile(cylinder, frame) === null, '')
    const flats = flatsProfile(decagon, frame)
    check('a faceted one does', flats !== null && flats.startsWith('M '), `${flats?.slice(0, 12)}`)
    // Inside the wall, by exactly the apothem: the line is the same curve
    // scaled, so one number tells the whole story.
    const widthOf = (path: string) =>
      Math.max(...path.replace(/[MLZ]/g, '').trim().split(/\s+/).filter((_, i) => i % 2 === 0).map(Number))
    near(
      'and it runs at the apothem, inside the corners the tools work',
      widthOf(flats ?? '0 0') / widthOf(silhouette(decagon, frame)),
      flatFactor(10),
      0.002
    )

    // Said out loud in the corner as well, since a reader who cannot see the
    // drawing gets the base from the same place they get the two sizes.
    const view = markupOf('LatheViewport (decagon)', LatheViewport)
    shows('the readout names the base', view, 'decagon')
    shows('and the label says it too', view, 'decagon based')
    lathe().setSides(null)
    shows(
      'a round piece says so in the same place',
      markupOf('LatheViewport (round)', LatheViewport),
      'circle'
    )

    // AND IT REACHES THE SHELF. The one thing a thumbnail may not show is the
    // section -- a hexagonal piece and the round one it was copied from are the
    // same picture from the front -- so the name has to carry it.
    check('a round piece is named for what it is', pieceName(null) === PIECE_NAME, pieceName(null))
    check(
      'and a faceted one for the polygon it stands on',
      pieceName(6) === 'Hexagonal turned piece',
      pieceName(6)
    )
    check(
      'in the same word the palette names a prism with',
      pieceName(9) === 'Nonagonal turned piece',
      pieceName(9)
    )
  }

  // THE RIB, THE HISTORY, THE PALETTE AND THE BORE -- the four things the
  // lathe grew after its two tools. What each one DOES is proved in
  // `engine-check`, which can work a lump without a window; this is about the
  // controls being wired to it, and about the one promise a screen with no
  // document can now make: that the obvious keystroke does something.
  {
    // A THIRD TOOL ON THE ISLAND, and a fourth button under a rule. The old
    // check here said two and nothing else; the promise it was guarding was
    // that the island stays a short list, and four with a break in it still is.
    const smooth = markupOf('SmoothTool', SmoothTool)
    shows('the island offers Smooth', smooth, '>Smooth<')
    tools().setOpenPanel('smooth')
    const smoothOpen = markupOf('SmoothTool (panel open)', SmoothTool)
    shows('with a size of its own', smoothOpen, '>Tool size<')
    shows('and a strength', smoothOpen, '>Strength<')
    check(
      'and the same two dials as the pair above it, no more',
      (smoothOpen.match(/field-label/g) ?? []).length === 2,
      `${(smoothOpen.match(/field-label/g) ?? []).length} fields`
    )
    tools().setOpenPanel(null)

    // Each tool keeps its own dials -- see `pushReach`. The rib opens WIDER
    // than the two that cut, because fairing a side is a different gesture from
    // aiming at a spot.
    check(
      'the rib is a wider tool than the pair that cut',
      tools().smoothReach > tools().pushReach,
      `${tools().smoothReach} against ${tools().pushReach}`
    )
    tools().setLatheTool('smooth')
    check('and arming it puts the other two down', tools().latheTool === 'smooth', `${tools().latheTool}`)
    const armed = armedLatheTool(tools())
    check(
      'the armed tool reports the rib and its own dials',
      armed?.tool === 'smooth' && armed.reach === tools().smoothReach,
      `${armed?.tool} at ${armed?.reach}`
    )
    tools().setLatheTool(null)

    // UNDO, which this screen did without for its whole first life. One entry
    // per stroke, and the bar's own buttons walk it.
    // A known screen: an unworked lump with an empty history. Emptied through
    // `setState` rather than by pressing undo until it stops, which would walk
    // back through the strokes the checks above made and leave the lump shaped.
    lathe().centreFresh()
    useLathe.setState({ past: [], future: [] })
    check('a fresh lathe has nothing to undo', lathe().past.length === 0, `${lathe().past.length}`)

    lathe().beginStroke()
    lathe().work({ y: 0.75, radius: 0.2, reach: 0.3, bite: 1, tool: 'push' })
    lathe().endStroke()
    const cut = lathe().clay.wall.slice()
    check('taking hold of the clay remembers the wall', lathe().past.length === 1, `${lathe().past.length}`)
    check('and the stroke moved it', !isFresh(lathe().clay), '')
    lathe().undo()
    check('undo puts the wall back', isFresh(lathe().clay), '')
    check('and offers it forward again', lathe().future.length === 1, `${lathe().future.length}`)
    lathe().redo()
    check(
      'redo takes the stroke back off the shelf',
      lathe().clay.wall.every((r, i) => r === cut[i]),
      ''
    )

    // ONE ENTRY FOR ONE STROKE, however many frames the hand holds for. Sixty
    // dabs between one press and one release is one act, and undoing it must
    // not take sixty presses.
    const depth = lathe().past.length
    lathe().beginStroke()
    for (let i = 0; i < 40; i += 1) {
      lathe().work({ y: 0.4, radius: 0.3, reach: 0.3, bite: 0.5, tool: 'push' })
    }
    lathe().endStroke()
    check('a whole stroke is one entry, not one per frame', lathe().past.length === depth + 1, `${lathe().past.length - depth}`)

    // THE WALL, NOT THE LUMP. A width typed after the stroke stays typed --
    // otherwise nobody would trust the button. See `past`.
    lathe().setRadius(0.6)
    lathe().undo()
    check('undo leaves a size set afterwards alone', lathe().clay.radius === 0.6, `${lathe().clay.radius}`)
    lathe().setRadius(0.4)

    // The bar drives whichever screen is up, which is the one place in the app
    // where the same button means two things -- and the right two.
    tools().setScreen('lathe')
    const bar = markupOf('NavBar (lathe, with history)', NavBar)
    const undoBtn = bar.slice(bar.indexOf('Undo (Ctrl+Z)') - 200, bar.indexOf('Undo (Ctrl+Z)'))
    check('undo is live on the lathe once there is a stroke to walk back', !undoBtn.includes('disabled'), undoBtn.slice(-90))

    // THE BORE. A toggle with two settings and a note that says what actually
    // came of them.
    lathe().setHollow(null)
    const solidPanel = markupOf('HollowTool', HollowTool)
    shows('the island offers Hollow', solidPanel, '>Hollow<')
    check('and a solid piece has no cavity', bore(lathe().clay) === null, '')

    tools().setOpenPanel('hollow')
    lathe().setHollow({ thickness: 0.06, capTop: false, capBottom: true })
    const cup = markupOf('HollowTool (a cup)', HollowTool)
    shows('the panel sets a wall thickness', cup, '>Wall<')
    shows('and each end independently', cup, 'aria-label="Bottom end"')
    shows('both of them', cup, 'aria-label="Top end"')
    shows('with a unit of its own at the top right', cup, 'nav-panel-setting')
    check('read in millimetres to start with', tools().hollowSizeUnit === 'mm', tools().hollowSizeUnit)
    shows('and the wall field wears it', cup, '>mm<')
    // WHAT CAME OF IT, which is the only thing on this screen that can say so.
    shows('the panel says what the piece became', cup, 'Open at the top, standing on a floor.')

    lathe().setHollow({ thickness: 0.06, capTop: false, capBottom: false })
    shows(
      'a pipe says it goes all the way through',
      markupOf('HollowTool (a pipe)', HollowTool),
      'Open all the way through.'
    )
    lathe().setHollow({ thickness: 0.06, capTop: true, capBottom: true })
    shows(
      'and a sealed one says it shows only when cut',
      markupOf('HollowTool (sealed)', HollowTool),
      'A sealed void'
    )
    // ASKING IS NOT GETTING, and the panel is where that is said out loud.
    lathe().setHollow({ thickness: 3, capTop: false, capBottom: true })
    shows(
      'a wall thicker than the piece says there is nothing to bore',
      markupOf('HollowTool (too thick)', HollowTool),
      'Nothing to bore'
    )
    tools().setOpenPanel(null)

    // AND THE DRAWING SHOWS IT, which is the whole reason the section exists:
    // a hollow piece cut down the middle is two walls and a void, and the
    // silhouette cannot say that.
    lathe().setHollow({ thickness: 0.06, capTop: false, capBottom: true })
    const hollowClay = lathe().clay
    const frame = clayFrame(1)
    const section = sectionPath(hollowClay, frame)
    check(
      'a hollow piece is drawn as a section rather than an outline',
      section !== silhouette(hollowClay, frame),
      ''
    )
    check('and a solid one is still the plain silhouette', sectionPath({ ...hollowClay, hollow: null }, frame) === silhouette(hollowClay, frame), '')
    // A cup is ONE loop -- up the outside, in across the rim, down the inside
    // and back -- because the mouth is where the two walls meet rather than a
    // line drawn across the opening. A sealed void is two.
    check(
      'a cup is one closed loop, with the mouth left open',
      (section.match(/M /g) ?? []).length === 1,
      `${(section.match(/M /g) ?? []).length} subpaths`
    )
    lathe().setHollow({ thickness: 0.06, capTop: true, capBottom: true })
    const sealed = sectionPath(lathe().clay, frame)
    check(
      'a sealed void is the piece and a hole in it',
      (sealed.match(/M /g) ?? []).length === 2,
      `${(sealed.match(/M /g) ?? []).length} subpaths`
    )
    lathe().setHollow({ thickness: 0.06, capTop: false, capBottom: false })
    const pipe = sectionPath(lathe().clay, frame)
    check(
      'and a pipe is two bands with the gap between them',
      (pipe.match(/M /g) ?? []).length === 2,
      `${(pipe.match(/M /g) ?? []).length} subpaths`
    )

    // Said out loud for a reader who cannot see any of that.
    shows(
      'the viewport says the piece is hollow where a reader can hear it',
      markupOf('LatheViewport (hollow)', LatheViewport),
      'hollow and open at both ends'
    )
    lathe().setHollow(null)
    lathe().centreFresh()
  }

  // THE RULER, which is the modelling screen's tool on a screen with no camera
  // in it. What is pinned here is the half a headless render can see: that the
  // button both engages the tool and lays a ruler down, that the list says what
  // each one reads, and -- the part that matters most -- that the two screens'
  // rulers are two lists rather than one. What an END catches is arithmetic and
  // lives in `interaction-check`, which can answer it without a DOM.
  {
    tools().setScreen('lathe')
    lathe().centreFresh()

    const idle = markupOf('LatheRulerTool', LatheRulerTool)
    shows('the island offers a Ruler', idle, '>Ruler<')

    check('and nothing is measured until it is asked for', tools().latheRulers.length === 0, '')

    // TAKING IT UP EMPTIES THE HAND. A tool in hand puts a ghost under the
    // pointer and a crosshair over the viewport, both aimed at the very knob
    // being reached for -- so the screen goes on saying "you are about to cut"
    // right through a gesture that cuts nothing. `latheTool` is one field, so
    // whichever of the four was held goes down.
    tools().setLatheTool('push')
    tools().setLatheRulerActive(true, lathe().clay)
    check('arming the Ruler puts down the tool that was in hand', tools().latheTool === null, `${tools().latheTool}`)
    check('arming it lays the first one down', tools().latheRulers.length === 1, `${tools().latheRulers.length}`)
    check('selected as it lands', tools().selectedLatheRuler === tools().latheRulers[0].id, `${tools().selectedLatheRuler}`)

    // Point Sculpt goes with the brushes and has to: its press places a knot on
    // the same drawing a ruler end is grabbed from, and it stands a second
    // panel in the corner while it is up.
    tools().setLatheTool('points')
    tools().setLatheRulerActive(true, lathe().clay)
    check('Point Sculpt goes down with them', tools().latheTool === null, `${tools().latheTool}`)

    // NOT THE REVERSE: shaping against what you have just measured is the whole
    // reason the two share a screen, so a tool taken back up leaves every ruler
    // exactly where it is.
    tools().setLatheTool('pull')
    check('but taking a tool back up leaves the rulers alone', tools().latheRulers.length === 1 && tools().latheRulerActive, `${tools().latheRulers.length}`)
    // And an empty hand means something else while measuring, so the viewport
    // does not ask for a tool to be taken up.
    tools().setLatheTool(null)
    hides(
      'and with the Ruler up the viewport stops asking for a tool',
      markupOf('LatheViewport (measuring)', LatheViewport),
      'then hold the pointer against the clay'
    )
    tools().setLatheRulerActive(false, lathe().clay)
    shows(
      'while an idle hand with no ruler still gets the hint',
      markupOf('LatheViewport (idle)', LatheViewport),
      'then hold the pointer against the clay'
    )
    tools().setLatheRulerActive(true, lathe().clay)

    // ACROSS THE PIECE, with an end on each wall, so it arrives measuring
    // something rather than asking for two placements before it says anything.
    {
      const [a, b] = tools().latheRulers[0].ends
      near('a fresh ruler lies level', a[1], b[1], 1e-12)
      near('with an end on each wall', a[0], -b[0], 1e-12)
      near(
        'so it reads the diameter where it landed',
        latheRulerLength(tools().latheRulers[0]),
        wallAt(lathe().clay, a[1]) * 2,
        1e-9
      )
    }

    // AND IT WEARS A HANDLE IN ITS MIDDLE, which is what says the second
    // gesture is there at all: the band is drawn only while both ends have a
    // line to ride, and that is the same question the press asks of the same
    // function. See `latheRulerRide`.
    shows(
      'a ruler with both ends on the wall wears a handle in its middle',
      markupOf('LatheViewport (ruler across the piece)', LatheViewport),
      'lathe-ruler-hold'
    )
    {
      // Out of level there is no one height for the pair to be moved to, so
      // there is nothing to take hold of -- and the press that would have moved
      // it goes to the clay, like every other press on this screen.
      const only = tools().latheRulers[0]
      tools().setLatheRulerEnd(only.id, 1, [only.ends[1][0], only.ends[1][1] + 0.1])
      hides(
        'while one pulled out of level has none',
        markupOf('LatheViewport (ruler out of level)', LatheViewport),
        'lathe-ruler-hold'
      )
      // Laid straight again, which is the two-ended write doing what it is for.
      tools().setLatheRulerEnds(only.id, only.ends)
      check('and laid level again it is back', latheRulerRide(tools().latheRulers[0], lathe().clay) !== null, '')
    }

    tools().setOpenPanel('lathe-ruler')
    const list = markupOf('LatheRulerTool (panel open)', LatheRulerTool)
    shows('the panel lists what is on the piece', list, '>Ruler 1<')
    shows('with the reading beside it', list, 'ruler-reading')
    shows('and a way to lay down another', list, 'Add ruler')

    // TWO LISTS, NOT ONE. The two screens measure different things in different
    // spaces, and a ruler laid across a solid in a room has no meaning on a
    // section of clay -- so neither list may leak into the other.
    const onBench = tools().rulers.length
    tools().addLatheRuler(lathe().clay)
    check('a second lands beside the first', tools().latheRulers.length === 2, `${tools().latheRulers.length}`)
    check("and the bench's rulers are untouched", tools().rulers.length === onBench, `${tools().rulers.length}`)
    check(
      'the two lists cannot even share an id',
      tools().latheRulers.every((r) => !tools().rulers.some((other) => other.id === r.id)),
      ''
    )
    // Lanes: consecutive rulers step up the piece rather than landing on each
    // other, where the second would look like it never appeared.
    check(
      'and the second is at a height of its own',
      tools().latheRulers[0].ends[0][1] !== tools().latheRulers[1].ends[0][1],
      ''
    )

    // PUSHED BY ITS MIDDLE, which is the store's half of the gesture: one
    // write, both ends, so a level ruler is never a diagonal for a frame. What
    // the ends land on is `interaction-check`'s business; what matters here is
    // that the ruler in the list is the one that moved.
    {
      const first = tools().latheRulers[0]
      const ride = latheRulerRide(first, lathe().clay)
      check('a ruler across the piece can be taken by its middle', ride !== null, '')
      if (ride !== null) {
        const up = Math.min(ride.hi, first.ends[0][1] + 0.2)
        tools().setLatheRulerEnds(first.id, latheRulerSlide(ride, lathe().clay, up, 0).ends)
        const moved = tools().latheRulers[0]
        near('both of its ends go to the new height', moved.ends[0][1], up, 1e-9)
        near('exactly level with each other', moved.ends[1][1], moved.ends[0][1], 1e-12)
        near(
          'and it reads the piece where it now lies',
          latheRulerLength(moved),
          wallAt(lathe().clay, up) * 2,
          1e-9
        )
        check(
          'while the ruler beside it stays where it was left',
          tools().latheRulers[1].ends[0][1] !== moved.ends[0][1],
          ''
        )

        // AND IT FOLLOWS THE CURVE, which is the whole of what the gesture is
        // for. A groove cut into the wall above the ruler, well clear of the
        // height it is lying at, and then the ruler pushed over it: the ends
        // have to come in with the wall rather than carry the width they were
        // laid down at.
        const groove = Math.min(ride.hi - 0.05, up + 0.2)
        check('there is room above the ruler to cut one', groove > up + 0.05, `${groove} over ${up}`)
        lathe().work({ y: groove, radius: 0.2, reach: 0.1, bite: 1, tool: 'push' })
        const wide = latheRulerLength(tools().latheRulers[0])
        const over = latheRulerRide(tools().latheRulers[0], lathe().clay)
        check('the ruler is still on a wall it can ride', over !== null, '')
        if (over !== null) {
          tools().setLatheRulerEnds(
            first.id,
            latheRulerSlide(over, lathe().clay, groove, 0).ends
          )
          const inside = tools().latheRulers[0]
          near(
            'pushed over the groove, its ends come in with the wall',
            latheRulerLength(inside),
            wallAt(lathe().clay, groove) * 2,
            1e-9
          )
          check(
            'which is a narrower reading than it had below',
            latheRulerLength(inside) < wide - 0.1,
            `${latheRulerLength(inside).toFixed(3)} against ${wide.toFixed(3)}`
          )
          near('and it is still exactly level', inside.ends[0][1], inside.ends[1][1], 1e-12)
          near('with one end either side of the axis', inside.ends[0][0], -inside.ends[1][0], 1e-12)
        }
      }
    }

    // Disarming KEEPS them -- they are measurements of a piece that has not
    // changed -- and drops only the selection.
    tools().setLatheRulerActive(false, lathe().clay)
    check('putting the tool down keeps the rulers', tools().latheRulers.length === 2, `${tools().latheRulers.length}`)
    check('and drops the selection', tools().selectedLatheRuler === null, `${tools().selectedLatheRuler}`)

    // Deleting one takes the selection with it, or the panel would go on
    // striping a ruler nothing draws.
    const doomed = tools().latheRulers[1].id
    tools().selectLatheRuler(doomed)
    tools().removeLatheRuler(doomed)
    check('deleting one takes it off the list', tools().latheRulers.length === 1, `${tools().latheRulers.length}`)
    check('and takes the selection with it', tools().selectedLatheRuler === null, `${tools().selectedLatheRuler}`)

    tools().setOpenPanel(null)
    useTools.setState({ latheRulers: [], latheRulerActive: false, selectedLatheRuler: null })
  }

  tools().setScreen('modelling')
  tools().setLatheTool(null)
}

// --- the laser cutter screen -------------------------------------------------
//
// The third screen. Nothing is cut on it yet, so what is worth pinning is the
// SHAPE of it: one block of stock, a console carrying the shelf and nothing
// else, the island standing empty in the corner the cutting tools will arrive
// in, and the bar's two history buttons keeping their hands off a screen with
// no history. How the camera settles onto a face is arithmetic and lives in
// `interaction-check`, which can answer it without a renderer -- and so is what
// a projection buys over a lens. What is pinned HERE is the screen's own choice
// of frame, which is a choice rather than a theorem.
console.log('\nThe laser cutter: one block, one console, and a camera that only rests on a face')
{
  tools().setScreen('laser')

  // THE CONSOLE IS THE SHELF AND NOTHING ELSE. The Clipboard crosses every
  // screen because what you have saved is yours rather than the scene's; the
  // modelling console's other four all describe a document this screen does not
  // draw, and Base belongs to the lathe's piece.
  {
    const console_ = markupOf('LaserConsole', LaserConsole)
    shows('the laser console keeps the clipboard', console_, '>Clipboard<')
    for (const panel of ['Solids', 'Shapes', 'Color', 'Scene', 'Base']) {
      hides(`and not ${panel}`, console_, `>${panel}<`)
    }
  }

  // THE CAMERA IS A PROJECTION, and a projection has to be told how much world
  // to show: there is no field of view to hold the scale, so the three numbers
  // below are what hold it instead. Two of the three are read off the room --
  // the frames its lens would have thrown at either end of its own dolly -- and
  // the one it opens on is this screen's own choice, stated as a share of the
  // block rather than as a distance. What is checked is that all three still
  // land where the app's own block range needs them to.
  {
    near(
      'the screen opens with the default block across three fifths of the window',
      DEFAULT_BLOCK / OPENING_FRAME,
      OPENING_SHARE,
      1e-12
    )
    // The share is the choice; that it is a good deal nearer than the third of
    // the window this screen used to open on is the point of it.
    check(
      'which is nearer than the shot the room would have framed',
      OPENING_FRAME < perspectiveFrame(BLOCK_STANDOFF, STAGE_CAMERA.fov),
      `${OPENING_FRAME.toFixed(3)} against ${perspectiveFrame(BLOCK_STANDOFF, STAGE_CAMERA.fov).toFixed(3)}`
    )
    check(
      'the wheel can nearly fill the window with the smallest block there is',
      CLOSEST_FRAME > BLOCK_MIN && CLOSEST_FRAME < BLOCK_MIN * 2,
      `${((BLOCK_MIN / CLOSEST_FRAME) * 100).toFixed(0)}% of the window`
    )
    check(
      'and stand the largest one off with ground all round it',
      WIDEST_FRAME > BLOCK_MAX * 2 && WIDEST_FRAME < BLOCK_MAX * 10,
      `${((BLOCK_MAX / WIDEST_FRAME) * 100).toFixed(0)}% of the window`
    )
    check(
      'with the frame it opens on between the two ends',
      CLOSEST_FRAME < OPENING_FRAME && OPENING_FRAME < WIDEST_FRAME,
      `${CLOSEST_FRAME.toFixed(3)} < ${OPENING_FRAME.toFixed(3)} < ${WIDEST_FRAME.toFixed(1)}`
    )
    // The standoff no longer frames anything, so the one thing left to ask of it
    // is that the camera is set down OUTSIDE the block it opens on -- past the
    // corner, not merely past the face.
    check(
      'and the camera set down clear of the corner of the block it opens on',
      BLOCK_STANDOFF > DEFAULT_BLOCK * Math.sqrt(3) / 2,
      `${BLOCK_STANDOFF} against ${((DEFAULT_BLOCK * Math.sqrt(3)) / 2).toFixed(3)}`
    )

    // And that the canvas actually asks for the projection these numbers are
    // for. A line of its own, so a comment mentioning the word cannot pass for
    // the prop.
    const source = readFileSync(new URL('../src/viewport/LaserViewport.tsx', import.meta.url), 'utf8')
    check('the laser canvas asks for a projection', /\n\s+orthographic\r?\n/.test(source))
    hides('and asks for no log depth buffer', source, 'logarithmicDepthBuffer')

    // WHICH IS NOT AN OVERSIGHT: three stands its own log depth down for any
    // camera that is not a lens, so on this screen the flag would buy a
    // `gl_FragDepth` write per fragment and nothing else. Read from three's own
    // chunks, the same bargain drei's grid strikes below -- a three that stopped
    // asking the question would leave that reasoning quietly false, and the one
    // screen without the flag would be the one paying for it.
    check(
      'three still asks which kind of camera it is drawing for',
      ShaderChunk.logdepthbuf_vertex.includes('isPerspectiveMatrix( projectionMatrix )')
    )
    check(
      'and still writes the hardware depth when the answer is no lens',
      ShaderChunk.logdepthbuf_fragment.includes('vIsPerspective == 0.0 ? gl_FragCoord.z')
    )

    // THE GROUND IS CUT DOWN TO THE BED, which is the other thing a projection
    // forces. Nothing dims with distance under one, so an endless grid arrives
    // at the edge of the window at very nearly the brightness it has under the
    // block -- and level with the block it is edge-on, which makes that one
    // hard line clean across the screen. This screen asks the room for a reach
    // instead, and it is the only screen that does.
    shows('the laser screen bounds its own ground', source, '<Stage reach={')

    // AND THAT THE WAY OFF THE SCREEN IS ACTUALLY ON IT. The button renders on
    // its own -- checked below -- which proves nothing about whether anything
    // mounts it, and a copy button nobody can reach is the same as no copy
    // button. Beside the compass, which is the corner it shares: the lathe's
    // twin has that corner to itself because the lathe has no compass wanting
    // it. See `CopyBlockButton`.
    shows('and mounts the way off it', source, '<CopyBlockButton />')
    shows('next to the compass it makes room for', source, '<AxisCompass />')

    // AND THE OTHER HALF OF THE WHEEL. A projection cannot be walked closer, so
    // a zoom carries the edges of the face -- where a cut is aimed -- outside
    // the window, and the only way back to them is to slide the view. The right
    // button is the one this screen had spare: the left draws and the middle
    // orbits. What the pan is BOUNDED by is arithmetic and lives in
    // `interaction-check`; what is pinned here is that the screen wires it.
    shows('the right button pans', source, 'RIGHT: MOUSE.PAN')
    hides('and the pan is not switched off under it', source, 'enablePan={false}')
    shows('with the clamp that keeps it on the face mounted', source, '<PanAcrossFace')
    // In the plane of the FACE rather than of the ground, which is the whole of
    // what the clamp assumes: up on a side view has to be up the block.
    shows('and panning in the plane of the screen', source, 'screenSpacePanning')

    // A RIGHT-DRAG THAT BEGAN OVER A PICTURE MUST NOT ALSO MOVE THE PICTURE.
    // Three's controls listen on the canvas itself, so a decal handler that
    // took every button would slide the view and the reference at once --
    // `stopPropagation` is fiber's own traversal and does not reach them.
    const decals = readFileSync(new URL('../src/viewport/ReferenceDecals.tsx', import.meta.url), 'utf8')
    check(
      'and every grab on a reference is left-button only',
      (decals.match(/startGrab\(/g) ?? []).length ===
        (decals.match(/e\.button !== 0/g) ?? []).length,
      `${(decals.match(/startGrab\(/g) ?? []).length} grabs, ${(decals.match(/e\.button !== 0/g) ?? []).length} guards`
    )
    const modelling = readFileSync(new URL('../src/viewport/Viewport.tsx', import.meta.url), 'utf8')
    shows(
      'and the modelling screen, which travels, does not',
      modelling,
      '<Stage />'
    )
  }

  // WHAT A REACH DOES TO THE TWO GRIDS. Arithmetic, so it is asked of the
  // function rather than of a canvas -- see `groundPlan`.
  {
    const endless = groundPlan()
    check('left alone the ground never ends', endless.endless)
    near('with the fine grid giving out at a metre and a half', endless.fineFade, 14, 1e-12)
    near('and the coarse one at thirty', endless.coarseFade, 300, 1e-12)
    // A floor with no middle dims around whoever is standing on it.
    near('and both of them dimming around the camera', endless.fadeFrom, 1, 1e-12)

    // The bed the laser screen opens on: three default blocks.
    const bed = groundPlan(DEFAULT_BLOCK * 3)
    check('a reach ends it', !bed.endless)
    near('the fine grid fades out at the reach', bed.fineFade, 3, 1e-12)
    near('and so does the coarse one', bed.coarseFade, 3, 1e-12)
    // A bed HAS a middle, and it is the same patch of ground from every side --
    // faded from the camera it would be bright in front of the block and dark
    // behind it, and would slide as the view came round.
    near('and the patch is centred on the bed rather than on the camera', bed.fadeFrom, 0, 1e-12)

    // WHICH IS THE WHOLE POINT OF A REACH: a fade that completes INSIDE the
    // quad it is ruled on is a ground with no edge to it. The fade is measured
    // from the camera projected onto the plane rather than from the middle of
    // it, so half the quad has to clear the reach by a margin rather than
    // exactly.
    for (const span of [BLOCK_MIN, DEFAULT_BLOCK, BLOCK_MAX]) {
      const plan = groundPlan(span * 3)
      check(
        `the ground under a ${span} block fades out well inside its own quad`,
        plan.plane[0] / 2 > Math.max(plan.fineFade, plan.coarseFade) * 1.2,
        `${(plan.plane[0] / 2).toFixed(2)} against ${Math.max(plan.fineFade, plan.coarseFade).toFixed(2)}`
      )
      // And the cap holds at the top end, where three blocks is 150 units and
      // a centimetre grid ruled that far is moire rather than ground.
      check(
        `and its centimetre cells stop before they turn to moire -- ${span}`,
        plan.fineFade <= 14,
        `${plan.fineFade.toFixed(2)} units`
      )
    }
  }

  // THE BLOCK IS THE LATHE'S CORNER PANEL, worn by a second screen: same
  // classes, same corner, same collapse idiom. A second stylesheet block
  // describing the same 232px panel is how two corners quietly stop matching.
  {
    const panel = markupOf('BlockPanel', BlockPanel)
    shows('the corner panel names what it is about', panel, 'The block')
    shows('and it is the stock panel, not a second one like it', panel, 'stock-panel')
    // THREE FIELDS, ONE PER AXIS. It was one -- a cube's Side -- and that was
    // the wrong shape for a bed: stock is a sheet, a bar or a block, and which
    // of those it is is the first decision of the job. A cube is three equal
    // numbers, typed.
    for (const field of ['Width', 'Height', 'Depth']) {
      shows(`it sets ${field}`, panel, `>${field}<`)
    }
    hides('and no longer offers one Side for all three', panel, '>Side<')

    // TWO WAYS BACK, BECAUSE THE SCREEN CARRIES TWO THINGS: a block that gets
    // cut, and drawings stuck to it that were never part of it. One button
    // answering both would mean throwing away an hour of cuts to clear a
    // drawing, or losing the drawings to get a fresh block -- each the wrong
    // half of what was asked for. So each names what it takes, and neither
    // touches the other's.
    {
      const ref = () => useReference.getState()
      /** Whether a button carrying this word is greyed. */
      const isDown = (markup: string, word: string): boolean => {
        const tag = markup.split('<button').find((part) => part.includes(`>${word}<`))
        return tag !== undefined && tag.slice(0, tag.indexOf('>')).includes('disabled=""')
      }

      shows('it offers a way back for the block', panel, '>Reset block<')
      shows('and one for the references', panel, '>Reset references<')

      // DEAD WITH NOTHING TO DO, rather than hidden: a control that appears
      // only once you have made a mess is one nobody knows about until after
      // the press they wanted it for.
      laser().resetBlock()
      ref().clearPlacements()
      const asFound = markupOf('BlockPanel (as found)', BlockPanel)
      check('the block reset is dead on a screen as it was found', isDown(asFound, 'Reset block'), 'should be disabled')
      check('and so is the reference one with a bare block', isDown(asFound, 'Reset references'), 'should be disabled')

      // A cut and a resize, which are the two things "reset block" undoes.
      laser().setDim(0, 0.35)
      laser().cut([[0.3, -0.3], [0.3, 0.3]], { axis: 2, sign: 1 })
      check('a cut leaves more than one piece on the bed', laser().pieces.length > 1, `${laser().pieces.length}`)
      const dirty = markupOf('BlockPanel (cut and resized)', BlockPanel)
      check('and the block reset comes alive', !isDown(dirty, 'Reset block'), 'should be enabled')

      laser().resetBlock()
      check('which puts one whole block back', laser().pieces.length === 1, `${laser().pieces.length}`)
      check(
        'at the size it arrived at',
        laser().dims.every((d) => d === DEFAULT_BLOCK),
        laser().dims.join(' x ')
      )

      // AND IT IS UNDOABLE, WITH THE SIZE. It is the most destructive button on
      // the screen, so Ctrl+Z has to give back everything it took -- the cuts
      // and the stock they were made in. The size is in that one step and in no
      // other, so an ordinary resize is still not something undo walks.
      laser().undo()
      check('undo gives the cut pieces back', laser().pieces.length > 1, `${laser().pieces.length}`)
      near('and the stock they were cut from', laser().dims[0], 0.35, 1e-12)
      laser().redo()
      check('redo takes them away again', laser().pieces.length === 1, `${laser().pieces.length}`)
      near('and puts the default stock back', laser().dims[0], DEFAULT_BLOCK, 1e-12)

      // An ordinary resize is NOT in the history, which is the rule the one
      // exception above is an exception to: the reset carries a size because it
      // CHANGES one, and typing in a field never does.
      const steps = laser().past.length
      laser().setDim(1, 0.2)
      check('a resize on its own puts no step in the history', laser().past.length === steps, `${laser().past.length - steps}`)
      laser().setDim(1, DEFAULT_BLOCK)

      // THE REFERENCES COME OFF THE BLOCK AND STAY ON THE SHELF, which is the
      // whole difference between this button and the bin on a tile.
      ref().putImage(0, { name: 'plan.png', src: 'data:,', width: 400, height: 200 })
      const drawing = activePreset(ref()).slots[0]!
      ref().startDrag(drawing.id)
      ref().dragOver({ face: '+z', u: 0, v: 0 })
      ref().dropDrag({ w: 0.4, h: 0.2 })
      // A second preset with a decal of its own, standing for every drawing the
      // eye cannot see: a reset that cleared only the visible ones would leave
      // a block that goes bare and then wears drawings again when the dropdown
      // moves.
      const held = ref().activePresetId
      ref().addPreset()
      ref().putImage(0, { name: 'detail.png', src: 'data:,', width: 200, height: 200 })
      const second = activePreset(ref()).slots[0]!
      ref().startDrag(second.id)
      ref().dragOver({ face: '-x', u: 0, v: 0 })
      ref().dropDrag({ w: 0.3, h: 0.3 })
      ref().choosePreset(held)
      check('two presets, each with a drawing on the block', ref().placements.length === 2, `${ref().placements.length}`)

      const wearing = markupOf('BlockPanel (references on the block)', BlockPanel)
      check('the reference reset comes alive', !isDown(wearing, 'Reset references'), 'should be enabled')

      ref().clearPlacements()
      check('and it takes every drawing off, in every preset', ref().placements.length === 0, `${ref().placements.length}`)
      check(
        'while the pictures stay on the shelf to be dropped again',
        ref().presets.flatMap((p) => p.slots).filter(Boolean).length === 2,
        `${ref().presets.flatMap((p) => p.slots).filter(Boolean).length}`
      )
      check('and the block it was clearing is untouched', laser().pieces.length === 1, `${laser().pieces.length}`)

      // Left exactly as it was found, for everything below: the shelf empty,
      // the bed whole, and the history with nothing in it -- a step left here
      // would light Undo in the bar and be read downstream as this screen
      // having work to walk back.
      while (ref().presets.length > 1) ref().removePreset(ref().presets[1].id)
      for (const slot of [0, 1, 2]) {
        const image = activePreset(ref()).slots[slot]
        if (image) ref().removeImage(image.id)
      }
      laser().resetBlock()
      laser().past.length = 0
      laser().future.length = 0
    }

    // It shuts to its title strip, and it shares that with the lathe's -- one
    // flag, because only one of them is ever mounted and what is remembered is
    // whether this user works with the corner open. See `stockOpen`.
    shows('the panel can be shut', panel, 'collapse-btn')
    shows('and says so where a reader can hear it', panel, 'aria-expanded="true"')
    tools().setStockOpen(false)
    const shut = markupOf('BlockPanel (shut)', BlockPanel)
    shows('shut, it is the strip and nothing else', shut, 'stock-panel-shut')
    hides('with the fields gone', shut, '>Width<')
    tools().setStockOpen(true)
  }

  // THREE NUMBERS, EACH CLAMPED, and clamped to the range a box in a DOCUMENT
  // lives in -- a millimetre to five metres. A block that could be cut here and
  // not built next door would be a block the clipboard could not carry across.
  {
    check(
      'the block starts a cube of one span',
      laser().dims.every((d) => d === DEFAULT_BLOCK),
      `${laser().dims.join(' x ')}`
    )
    check(
      'which is the size the palette drops a cube at',
      DEFAULT_BLOCK === 1,
      `${DEFAULT_BLOCK}`
    )
    check(
      'and it is the range a box in the document has',
      BLOCK_MIN === MIN_DIMENSION && BLOCK_MAX === MAX_SIZE,
      `${BLOCK_MIN}..${BLOCK_MAX}`
    )
    // EACH AXIS ON ITS OWN, which is the whole of what three fields buy: a
    // sheet is a block whose depth was set and whose other two were not.
    laser().setDim(0, 2)
    check(
      'width is set without touching the others',
      laser().dims[0] === 2 && laser().dims[1] === DEFAULT_BLOCK && laser().dims[2] === DEFAULT_BLOCK,
      `${laser().dims.join(' x ')}`
    )
    laser().setDim(1, 0.3)
    laser().setDim(2, 1.5)
    check(
      'and so are height and depth',
      laser().dims[1] === 0.3 && laser().dims[2] === 1.5,
      `${laser().dims.join(' x ')}`
    )
    laser().setDim(0, BLOCK_MAX * 10)
    check('a side past the ceiling is held at it', laser().dims[0] === BLOCK_MAX, `${laser().dims[0]}`)
    laser().setDim(0, 0)
    check('and one under the floor at that', laser().dims[0] === BLOCK_MIN, `${laser().dims[0]}`)
    // Handing back the very state it holds when nothing changes, so a clamped
    // value that lands where it already was does not redraw the scene.
    const held = laser()
    laser().setDim(0, BLOCK_MIN)
    check('setting a side it already has changes nothing', laser() === held, '')
    for (const axis of [0, 1, 2] as const) laser().setDim(axis, DEFAULT_BLOCK)
  }

  // --- reference images ------------------------------------------------------
  //
  // Drawings stuck to the block to cut along. Three things are worth holding to
  // account here, and they are the three that cannot be seen from a screenshot:
  // the SHELF (three slots, up to five presets, and a preset that hides its own
  // decals when you switch away), the PICTURE ARITHMETIC (a crop that survives
  // being turned, an aspect that survives a crop), and the PROJECTION -- which
  // is the whole reason a cut cuts the drawing too, and the one part of a
  // shader a headless check can actually hold to account, because the rule it
  // applies is written twice on purpose: once in GLSL and once in TypeScript.
  console.log('\nReference images: a shelf, a crop, and a picture that is ON the surface')
  {
    const reference = () => useReference.getState()

    // THE PANEL IS ON THE LASER CONSOLE AND NOWHERE ELSE. A reference is a
    // thing you follow with a tool: the lathe has no face to lay one on, and
    // the modelling screen has a document full of surfaces that would each need
    // their own answer to what a cut does to a picture.
    {
      const laserSide = markupOf('LaserConsole (with references)', LaserConsole)
      shows('the laser console carries the reference shelf', laserSide, '>Reference<')
      hides('the modelling console does not', markupOf('Console', Console), '>Reference<')
      hides('nor does the lathe', markupOf('LatheConsole', LatheConsole), '>Reference<')
    }

    // EMPTY, IT IS STILL THE SHELF: three slots standing where the pictures
    // will go, the same bargain the Clipboard strikes one panel up.
    {
      const panel = markupOf('ReferencePanel (empty)', ReferencePanel)
      const slots = panel.split('ref-slot').length - 1
      check(`it stands ${SLOTS_PER_PRESET} empty slots`, slots === SLOTS_PER_PRESET, `${slots}`)
      // AND FILLS THEM IN ONE GO. The shelf holds three, so the picker takes
      // three: without this the dialog keeps the first file of a selection and
      // says nothing, which is a panel you have to use three times to learn.
      shows('and its picker takes a whole selection at once', panel, 'multiple=""')
      shows('with a preset to put them in', panel, 'aria-label="Preset"')
      shows('one that can be renamed', panel, 'aria-label="Rename this preset"')
      shows('one that can be added to', panel, 'aria-label="Add a preset"')
      shows('and one opacity for all of them', panel, '>Opacity<')
      check(
        'the last preset cannot be deleted',
        panel.includes('aria-label="Delete this preset"') && /Delete this preset"[^>]*disabled/.test(panel),
        'the delete button should be disabled with one preset left'
      )
    }

    // FIVE PRESETS, AND THE FIFTH IS THE LAST. The plus is disabled at the cap
    // rather than hidden, so the ceiling can be seen before it is hit -- and
    // the store refuses past it too, which is the half a stale render cannot
    // get round.
    {
      for (let i = reference().presets.length; i < MAX_PRESETS; i++) reference().addPreset()
      check(
        `five presets is the most there can be`,
        reference().presets.length === MAX_PRESETS,
        `${reference().presets.length}`
      )
      reference().addPreset()
      check(
        'and asking for a sixth does nothing',
        reference().presets.length === MAX_PRESETS,
        `${reference().presets.length}`
      )
      const full = markupOf('ReferencePanel (five presets)', ReferencePanel)
      check(
        'the plus says so rather than lying',
        /Add a preset"[^>]*disabled/.test(full),
        'the add button should be disabled at the cap'
      )
      // Named lowest-unused, so deleting one frees its name rather than leaving
      // a hole and offering "Preset 6" next.
      const names = reference().presets.map((p) => p.name)
      check('each preset arrives named', names.every(Boolean) && new Set(names).size === names.length, names.join(', '))
      while (reference().presets.length > 1) reference().removePreset(reference().presets[1].id)
      reference().removePreset(reference().presets[0].id)
      check(
        'the last one stays whatever is asked',
        reference().presets.length === 1,
        `${reference().presets.length}`
      )
    }

    // --- THREE AT ONCE, AND WHERE THEY LAND ---------------------------------
    //
    // A plan, an elevation and a detail are chosen in one breath, so the picker
    // takes them in one breath. Which slot each ends up in is the part with an
    // off-by-one in it -- the batch starts at whichever plus was pressed and
    // wraps round the end of a shelf of three -- so it is arithmetic in a pure
    // function rather than a loop buried in a handler. See `slotsFor`.
    {
      check(
        'one picture goes where it was asked for',
        slotsFor(1, 1).join() === '1',
        slotsFor(1, 1).join()
      )
      check(
        'three from the first slot fill the shelf in order',
        slotsFor(0, 3).join() === '0,1,2',
        slotsFor(0, 3).join()
      )
      // THE WRAP, which is the whole reason this is not just `from + i`: three
      // pictures fill three slots whichever plus was pressed, rather than the
      // answer depending on which of three identical buttons was nearest.
      check(
        'and three from the last one wrap round to the front',
        slotsFor(2, 3).join() === '2,0,1',
        slotsFor(2, 3).join()
      )
      check('two from the middle take the middle and the end', slotsFor(1, 2).join() === '1,2', slotsFor(1, 2).join())
      // Never more than the shelf holds: a fourth would land back on the first
      // and replace a picture that arrived in the same gesture.
      check(
        `never more than the ${SLOTS_PER_PRESET} there are`,
        slotsFor(0, 9).length === SLOTS_PER_PRESET,
        `${slotsFor(0, 9).length}`
      )
      check('and nothing at all for nothing chosen', slotsFor(2, 0).length === 0, `${slotsFor(2, 0).length}`)
      // Every slot exactly once, from every starting point: the shelf can never
      // be filled with the same picture twice by one batch.
      for (let from = 0; from < SLOTS_PER_PRESET; from++) {
        const filled = slotsFor(from, SLOTS_PER_PRESET)
        check(
          `a full batch from slot ${from + 1} touches every slot once`,
          new Set(filled).size === SLOTS_PER_PRESET,
          filled.join()
        )
      }
    }

    // A picture, without a browser to decode one: the store takes the numbers
    // an upload produces, and nothing below this line needs the pixels.
    const picture = { name: 'plan.png', src: 'data:,', width: 400, height: 200 }

    // WHAT A PRESET SWITCH DOES TO THE BLOCK. It is a whole set-up, not a
    // folder: its decals go with it and come back with it. Anything else and a
    // preset would be a way to lose work by pressing a dropdown.
    {
      reference().putImage(0, picture)
      const image = activePreset(reference()).slots[0]
      check('a picture lands in the slot it was put in', Boolean(image), `${image?.name}`)

      reference().startDrag(image!.id)
      reference().dragOver({ face: '+z', u: 0, v: 0 })
      reference().dropDrag({ w: 0.4, h: 0.2 })
      check('and drops onto the face it was dragged to', reference().placements.length === 1, `${reference().placements.length}`)
      check('where it is drawn', visiblePlacements(reference()).length === 1, '')

      const first = reference().activePresetId
      reference().addPreset()
      check(
        'switching preset takes it off the block',
        visiblePlacements(reference()).length === 0 && reference().placements.length === 1,
        `${visiblePlacements(reference()).length} of ${reference().placements.length}`
      )
      reference().choosePreset(first)
      check('and switching back brings it out again', visiblePlacements(reference()).length === 1, '')

      // A DRAG RELEASED OFF THE BLOCK IS A DRAG ABANDONED, not a drop at the
      // last place the pointer was over one.
      reference().startDrag(image!.id)
      reference().dragOver(null)
      reference().dropDrag({ w: 0.4, h: 0.2 })
      check('a release off the block places nothing', reference().placements.length === 1, `${reference().placements.length}`)

      // A GRAB IS A GRAB, whichever gesture it is, and both kinds name the same
      // decal. The corner comes with the size grab because the arithmetic below
      // cannot anchor anything without knowing which corner is in hand.
      const decal = reference().placements[0]
      reference().startGrab({ id: decal.id, mode: 'move' })
      check('a reference can be picked up to slide', reference().grab?.mode === 'move', `${reference().grab?.mode}`)
      reference().endGrab()
      reference().startGrab({ id: decal.id, mode: 'size', corner: { su: -1, sv: 1 } })
      check(
        'and by any of its corners to size',
        reference().grab?.mode === 'size',
        `${reference().grab?.mode}`
      )
      reference().endGrab()
      // The id comes off a handle, and a handle can outlive its picture by one
      // render: a grab on a decal that has gone is refused rather than kept.
      reference().startGrab({ id: 'gone', mode: 'move' })
      check('a grab on a decal that is not there is refused', reference().grab === null, `${reference().grab?.id}`)
      tools().setLaserTool(null)

      // Emptying a slot takes what it put on the block with it: a decal whose
      // picture is gone is a rectangle nobody can see or reach.
      reference().removeImage(image!.id)
      check('deleting a picture takes its decals too', reference().placements.length === 0, `${reference().placements.length}`)
    }

    // THE CEILING THE SHADER CAN PAINT. Refused at the store rather than
    // dropped silently by the GPU, which is the failure that would have
    // somebody cutting to a drawing that is not there.
    {
      reference().putImage(0, picture)
      const image = activePreset(reference()).slots[0]!
      for (let i = 0; i < MAX_PLACEMENTS + 3; i++) {
        reference().startDrag(image.id)
        reference().dragOver({ face: FACES[i % 6], u: 0, v: 0 })
        reference().dropDrag({ w: 0.2, h: 0.1 })
      }
      check(
        'a preset holds no more decals than can be painted',
        reference().placements.length === MAX_PLACEMENTS,
        `${reference().placements.length} of ${MAX_PLACEMENTS}`
      )
      reference().removeImage(image.id)
    }

    // --- A LIT SLOT, AND THE WAY OFF THE BLOCK ------------------------------
    //
    // TWO THINGS THAT ARE ONE THING. The panel had no way to say WHICH picture
    // you meant -- Move armed every decal on the block at once -- and no way to
    // take one off a face at all: the only exit was deleting the file and
    // uploading it again. Lighting a slot answers both. It is what the handles
    // hang on, and it is what Delete acts on.
    {
      reference().putImage(0, picture)
      const image = activePreset(reference()).slots[0]!
      // The same drawing on two faces, which is the case the light exists for:
      // one slot, several decals, one thing to say about all of them.
      for (const face of ['+z', '-x'] as const) {
        reference().startDrag(image.id)
        reference().dragOver({ face, u: 0, v: 0 })
        reference().dropDrag({ w: 0.4, h: 0.2 })
      }
      check('one picture can be on two faces at once', reference().placements.length === 2, `${reference().placements.length}`)

      check('nothing is lit to begin with', reference().highlightId === null, `${reference().highlightId}`)
      reference().highlight(image.id)
      check('pressing a tile lights its slot', reference().highlightId === image.id, `${reference().highlightId}`)
      // The light points at a picture, so a picture that is not on the shelf
      // cannot be lit: it would arm handles on nothing and aim Delete at
      // nothing.
      reference().highlight('gone')
      check('a slot that holds nothing cannot be lit', reference().highlightId === image.id, `${reference().highlightId}`)

      // DELETE TAKES IT OFF THE BLOCK, ALL OF IT, AND LEAVES IT ON THE SHELF.
      // The bin on the tile is the other verb and still throws the file away;
      // this is the one that was missing.
      reference().clearPlacementsOf(image.id)
      check(
        'the lit picture comes off every face at once',
        reference().placements.length === 0,
        `${reference().placements.length}`
      )
      check(
        'and stays in the panel to be dropped again',
        activePreset(reference()).slots[0]?.id === image.id,
        `${activePreset(reference()).slots[0]?.name}`
      )
      check('with the light still on it', reference().highlightId === image.id, `${reference().highlightId}`)

      // A grab is a hand on a rectangle. Taking the rectangle away has to take
      // the hand with it, or the next pointer move writes to a decal that is
      // not there.
      reference().startDrag(image.id)
      reference().dragOver({ face: '+z', u: 0, v: 0 })
      reference().dropDrag({ w: 0.4, h: 0.2 })
      reference().startGrab({ id: reference().placements[0].id, mode: 'move' })
      reference().clearPlacementsOf(image.id)
      check('and the hand that was holding it lets go', reference().grab === null, `${reference().grab?.id}`)

      // THE PANEL SAYS WHICH ONE IS LIT. A light that only the block can see is
      // one you cannot find on a face you have turned away from.
      reference().startDrag(image.id)
      reference().dragOver({ face: '+z', u: 0, v: 0 })
      reference().dropDrag({ w: 0.4, h: 0.2 })
      reference().highlight(image.id)
      const litPanel = markupOf('ReferencePanel (a lit slot)', ReferencePanel)
      shows('the lit tile says so', litPanel, 'ref-tile-lit')
      shows('and says it to a screen reader too', litPanel, 'aria-pressed="true"')
      reference().highlight(null)
      hides('and an unlit one does not', markupOf('ReferencePanel (nothing lit)', ReferencePanel), 'ref-tile-lit')

      // A SWITCH PUTS THE LIGHT OUT. The pictures of a preset you are not
      // holding are neither on the block nor in the panel, so a light left on
      // one would arm Delete against nothing.
      reference().highlight(image.id)
      const held = reference().activePresetId
      reference().addPreset()
      check('switching preset puts the light out', reference().highlightId === null, `${reference().highlightId}`)
      reference().choosePreset(held)
      reference().removePreset(reference().presets[1].id)

      // And so does throwing the picture away, which is the other way its slot
      // can stop holding what the light is on.
      reference().highlight(image.id)
      reference().removeImage(image.id)
      check('deleting the picture puts it out as well', reference().highlightId === null, `${reference().highlightId}`)
    }

    // WHERE THE LIGHT IS READ, and it is read in two places a headless check
    // cannot render: the handles are three.js objects and the key handler is a
    // window listener inside a canvas component. So the source is held to the
    // rule instead, the way the shader is below.
    {
      const decals = readFileSync(new URL('../src/viewport/ReferenceDecals.tsx', import.meta.url), 'utf8')
      check(
        'the handles need BOTH the tool and the lit slot',
        decals.includes('const armed = moving && lit'),
        'Move in hand used to arm every decal on the block at once'
      )
      const viewport = readFileSync(new URL('../src/viewport/LaserViewport.tsx', import.meta.url), 'utf8')
      check(
        'Delete takes the lit picture off the block before it throws the offcut away',
        viewport.includes('clearPlacementsOf(lit)') && viewport.includes('discardOffcut()'),
        'the thing wearing the highlight is the thing the key acts on'
      )
      check(
        'and taking up a cutter puts the light out',
        /isCutTool\(tool\)\)\s*useReference\.getState\(\)\.highlight\(null\)/.test(viewport),
        'grips on a face are holes where a cut cannot be started'
      )
    }

    // THE EDITOR is nothing at all until a picture is opened in it, the way the
    // help screen is: it covers the app, so it must not exist unasked.
    {
      check(
        'the editor renders nothing until a picture is opened',
        renderToStaticMarkup(createElement(ReferenceEditor)) === '',
        renderToStaticMarkup(createElement(ReferenceEditor)).slice(0, 40)
      )
      reference().putImage(0, picture)
      const image = activePreset(reference()).slots[0]!
      reference().openEditor(image.id)
      const editor = markupOf('ReferenceEditor (open)', ReferenceEditor)
      shows('opened, it is a modal dialog', editor, 'role="dialog"')
      shows('named for the picture in it', editor, 'plan.png')
      shows('with the two flips', editor, 'Flip H')
      shows('the turn', editor, 'Rotate')
      shows('a crop to drag', editor, 'ref-editor-crop')
      shows('and a way to take the crop off again', editor, 'Whole picture')
      // The ratio switch, and it is the app's own segmented control rather than
      // a second thing that looks like one.
      shows('a shape to hold the crop to', editor, 'aria-label="Crop ratio"')
      shows('offered as the switch every other choice-of-one uses', editor, 'class="seg"')
      for (const { label } of CROP_RATIOS) {
        shows(`${label} is one of them`, editor, `>${label}</button>`)
      }
      check(
        'and it opens on Free, a picture having arrived with no shape asked of it',
        /seg-btn seg-active[\s\S]{0,200}?>Free<\/button>/.test(editor) &&
          editor.split('seg-active').length - 1 === 1,
        'exactly one ratio should be armed, and it should be Free'
      )
      reference().openEditor(null)
      reference().removeImage(image.id)
    }

    // --- the picture arithmetic ---------------------------------------------
    //
    // The crop is stored in the frame the picture is SHOWN in, which is the
    // frame it was dragged in -- so a turn afterwards has to carry it round or
    // the rectangle lands somewhere nobody pointed at.
    {
      const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }
      const round = turnCrop(crop, 4)
      check(
        'four quarter turns put a crop back where it started',
        Math.abs(round.x - crop.x) < 1e-9 && Math.abs(round.y - crop.y) < 1e-9,
        `${round.x}, ${round.y}`
      )
      const quarter = turnCrop(crop, 1)
      check(
        'and one turn swaps its sides',
        quarter.w === crop.h && quarter.h === crop.w,
        `${quarter.w} x ${quarter.h}`
      )
      const flipped = flipCrop(flipCrop(crop, 'x'), 'x')
      check('two flips are none', Math.abs(flipped.x - crop.x) < 1e-9, `${flipped.x}`)

      // A corner drag rebuilds the rectangle from the corner that did NOT move,
      // so dragging past the far side flips it through rather than collapsing
      // it to nothing.
      const pulled = resizeCrop({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'se', 0.9, 0.8)
      check(
        'a corner drag anchors the opposite corner',
        Math.abs(pulled.x - 0.2) < 1e-9 && Math.abs(pulled.w - 0.7) < 1e-9,
        `${pulled.x} + ${pulled.w}`
      )
      const past = resizeCrop({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 'se', 0.1, 0.1)
      check(
        'and dragged past it, the rectangle flips through',
        past.x < 0.4 && past.w > 0,
        `${past.x} + ${past.w}`
      )
      const shoved = moveCrop({ x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, 0.9, 0.9)
      check(
        'a crop cannot be slid off the picture',
        shoved.x <= 0.7 + 1e-9 && shoved.y <= 0.7 + 1e-9,
        `${shoved.x}, ${shoved.y}`
      )
      const thin = clampCrop({ x: 0.5, y: 0.5, w: 0, h: 0 })
      check('nor cropped to nothing', thin.w > 0 && thin.h > 0, `${thin.w} x ${thin.h}`)

      const turned = turnedSize(400, 200, 1)
      check('a quarter turn swaps the pixels too', turned.width === 200 && turned.height === 400, `${turned.width} x ${turned.height}`)
      check(
        'and the aspect follows the crop, since the block lays it out by shape',
        Math.abs(
          aspectOf({ width: 400, height: 200, edit: { flipX: false, flipY: false, turns: 1, crop: null } }) - 0.5
        ) < 1e-9,
        ''
      )
    }

    // --- holding the crop to a shape ----------------------------------------
    //
    // THE WHOLE POINT IS PIXELS, NOT FRACTIONS. A crop is stored as a fraction
    // of a picture that has a shape of its own, so half by half of a 400 x 200
    // drawing is 200 x 100 -- and a control that set w = h would offer a
    // "square" that is nothing of the kind. `fractionRatio` is the conversion,
    // and it is the one thing here that a wrong answer would make invisible:
    // the crop would look plausible and the picture would land on the block the
    // wrong shape.
    {
      const shownAspect = 400 / 200
      const square = fractionRatio(1, shownAspect)
      check('a square of pixels is not a square of fractions', square === 0.5, `${square}`)

      const fitted = fitCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, square)
      check(
        'and a crop fitted to it comes out square in pixels',
        Math.abs(fitted.w * 400 - fitted.h * 200) < 1e-9,
        `${fitted.w * 400} x ${fitted.h * 200}`
      )
      check(
        'fitting SHRINKS rather than grows, so nothing cropped out comes back',
        fitted.w <= 0.8 + 1e-9 && fitted.h <= 0.8 + 1e-9,
        `${fitted.w} x ${fitted.h}`
      )
      check(
        'and keeps the middle it was aimed at',
        Math.abs(fitted.x + fitted.w / 2 - 0.5) < 1e-9 && Math.abs(fitted.y + fitted.h / 2 - 0.5) < 1e-9,
        `${fitted.x + fitted.w / 2}, ${fitted.y + fitted.h / 2}`
      )
      // Pressed with nothing cropped, the button crops: that is the gesture it
      // exists for -- open a picture, press 1:1, nudge the square about.
      const fromWhole = fitCrop({ x: 0, y: 0, w: 1, h: 1 }, square)
      check(
        'pressed on an uncropped picture it makes the crop',
        fromWhole.w < 1 && Math.abs(fromWhole.w * 400 - fromWhole.h * 200) < 1e-9,
        `${fromWhole.w} x ${fromWhole.h}`
      )
      const wide = fitCrop({ x: 0, y: 0, w: 1, h: 1 }, 4)
      check(
        'a ratio wider than the picture is capped by the picture',
        wide.w <= 1 && wide.h <= 1,
        `${wide.w} x ${wide.h}`
      )

      // A LOCKED CORNER DRAG. The anchor holds, the shape holds, and the
      // rectangle stops at the edge of the picture rather than going over it.
      const held = resizeCrop({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, 'se', 0.9, 0.25, square)
      check(
        'a locked drag keeps the shape it was given',
        Math.abs(held.w / held.h - square) < 1e-9,
        `${held.w / held.h} vs ${square}`
      )
      check(
        'and the corner that was not dragged stays put',
        Math.abs(held.x - 0.2) < 1e-9 && Math.abs(held.y - 0.2) < 1e-9,
        `${held.x}, ${held.y}`
      )
      check(
        'while the far side follows whichever way was pulled further',
        held.w > 0.2,
        `${held.w}`
      )
      const stopped = resizeCrop({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, 'se', 1, 1, square)
      check(
        'a locked drag past the edge stops at it',
        stopped.x + stopped.w <= 1 + 1e-9 && stopped.y + stopped.h <= 1 + 1e-9,
        `${stopped.x + stopped.w}, ${stopped.y + stopped.h}`
      )
      check(
        'still holding its shape',
        Math.abs(stopped.w / stopped.h - square) < 1e-9,
        `${stopped.w / stopped.h}`
      )
      // Free is still free: the ratio is optional and its absence is the old
      // behaviour exactly.
      const free = resizeCrop({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, 'se', 0.9, 0.25)
      check(
        'and with no ratio the corner goes where it was put',
        Math.abs(free.w - 0.7) < 1e-9 && Math.abs(free.h - 0.05) < 1e-9,
        `${free.w} x ${free.h}`
      )
    }

    // WHAT THE PANEL TAKES. By type where the browser gives one and by
    // extension where it does not -- a file dragged from some desktops arrives
    // with an empty type, and refusing a .png because of that is a rejection
    // nobody can act on.
    {
      check('a PNG is taken', isReferenceFile({ name: 'a.png', type: 'image/png' }), '')
      check('an SVG is taken', isReferenceFile({ name: 'a.svg', type: 'image/svg+xml' }), '')
      check('a typeless .jpeg is taken on its name', isReferenceFile({ name: 'a.jpeg', type: '' }), '')
      check('a PDF is not', !isReferenceFile({ name: 'a.pdf', type: 'application/pdf' }), '')
      check('nor a model', !isReferenceFile({ name: 'a.stl', type: '' }), '')
    }

    // --- where the picture actually is --------------------------------------
    //
    // The block is a box standing ON the bed, so every face frame is derived
    // from three sides and a footprint centred on the origin. These are the
    // numbers the shader is handed; if they are wrong the picture is somewhere
    // else, and no screenshot of one face would say which.
    {
      const dims: [number, number, number] = [1.6, 0.8, 0.4]
      for (const face of FACES) {
        const frame = faceFrame(face, dims)
        // A RIGHT-HANDED FRAME on every face, or the picture arrives mirrored
        // on half of them -- which is the bug you only notice after cutting.
        const cross: [number, number, number] = [
          frame.u[1] * frame.v[2] - frame.u[2] * frame.v[1],
          frame.u[2] * frame.v[0] - frame.u[0] * frame.v[2],
          frame.u[0] * frame.v[1] - frame.u[1] * frame.v[0],
        ]
        const dot = cross[0] * frame.normal[0] + cross[1] * frame.normal[1] + cross[2] * frame.normal[2]
        check(`${face}: right and up cross to its own normal`, Math.abs(dot - 1) < 1e-9, `${dot}`)
        const depth =
          frame.centre[0] * frame.normal[0] +
          frame.centre[1] * frame.normal[1] +
          frame.centre[2] * frame.normal[2]
        check(`${face}: its plane is where its middle is`, Math.abs(depth - frame.depth) < 1e-9, `${depth} vs ${frame.depth}`)
        check(
          `${face}: a normal off the block finds it again`,
          faceOfNormal(frame.normal) === face,
          `${faceOfNormal(frame.normal)}`
        )
      }
      check('and a slanted surface is no face at all', faceOfNormal([0.7, 0.7, 0]) === null, '')

      // A DROP FITS THE FACE AND KEEPS ITS SHAPE. A reference stretched out of
      // aspect is a drawing that would be cut wrong.
      const drop = dropSize('+z', dims, 2)
      check('a dropped picture keeps its aspect', Math.abs(drop.w / drop.h - 2) < 1e-9, `${drop.w / drop.h}`)
      check(
        'and lands inside the face it was dropped on',
        drop.w <= dims[0] && drop.h <= dims[1],
        `${drop.w} x ${drop.h} on ${dims[0]} x ${dims[1]}`
      )
      const held = clampCentre(99, 99, drop.w, drop.h, '+z', dims)
      check(
        'a picture cannot be dragged off the edge',
        held.u + drop.w / 2 <= dims[0] / 2 && held.v + drop.h / 2 <= dims[1] / 2,
        `${held.u}, ${held.v}`
      )

      // Where the pointer lands on a face, and back again.
      const there = faceOffset([0.3, 0.5, dims[2] / 2], '+z', dims)
      check(
        'a point on a face reads as an offset from its middle',
        Math.abs(there.u - 0.3) < 1e-9 && Math.abs(there.v - (0.5 - dims[1] / 2)) < 1e-9,
        `${there.u}, ${there.v}`
      )

      // A CORNER PULL, WITH THE OPPOSITE CORNER NAILED DOWN. This is the whole
      // of what "size it from any corner" means, and it is four claims: the
      // anchor holds, the shape holds, the picture stays on the face, and
      // dragging past the anchor never turns it inside out. None of them are
      // things an eye catches on a screenshot of one frame.
      {
        const start: Placement = {
          id: 'd', presetId: 'p', imageId: 'i', face: '+z',
          u: 0, v: 0, w: 0.4, h: 0.2,
        }
        const aspect = 2
        // Every corner, so none of the four is the one that was never tried.
        for (const corner of CORNERS) {
          const anchorU = start.u - (corner.su * start.w) / 2
          const anchorV = start.v - (corner.sv * start.h) / 2
          // Pulled a little way further out along the corner's own diagonal.
          const out = resizeFromCorner(
            start,
            corner,
            { u: anchorU + corner.su * 0.6, v: anchorV + corner.sv * 0.3 },
            aspect,
            dims
          )
          const name = `${corner.su > 0 ? 'right' : 'left'} ${corner.sv > 0 ? 'top' : 'bottom'}`
          check(
            `pulling the ${name} corner leaves the opposite one where it was`,
            Math.abs(out.u - (corner.su * out.w) / 2 - anchorU) < 1e-9 &&
              Math.abs(out.v - (corner.sv * out.h) / 2 - anchorV) < 1e-9,
            `${out.u - (corner.su * out.w) / 2}, ${out.v - (corner.sv * out.h) / 2}`
          )
          check(
            `and the ${name} pull keeps the picture's own shape`,
            Math.abs(out.w / out.h - aspect) < 1e-9,
            `${out.w / out.h}`
          )
          check(`and grows it`, out.w > start.w, `${out.w} from ${start.w}`)

          // PAST THE ANCHOR AND OUT THE OTHER SIDE. The picture goes small and
          // stays on the side it started; it does not flip through the anchor.
          const through = resizeFromCorner(
            start,
            corner,
            { u: anchorU - corner.su * 0.5, v: anchorV - corner.sv * 0.25 },
            aspect,
            dims
          )
          check(
            `dragging the ${name} corner past its anchor never flips the picture`,
            through.w >= MIN_DECAL &&
              Math.sign(through.u - anchorU || corner.su) === corner.su &&
              Math.sign(through.v - anchorV || corner.sv) === corner.sv,
            `${through.u - anchorU}, ${through.v - anchorV}`
          )

          // AND IT STOPS AT THE EDGE, measured from the anchor rather than from
          // the middle: the room to grow into is what lies between the nailed
          // corner and the far side.
          const far = resizeFromCorner(start, corner, { u: corner.su * 99, v: corner.sv * 99 }, aspect, dims)
          check(
            `a ${name} pull off the edge of the world stops at the face`,
            Math.abs(far.u) + far.w / 2 <= dims[0] / 2 + 1e-9 &&
              Math.abs(far.v) + far.h / 2 <= dims[1] / 2 + 1e-9,
            `${Math.abs(far.u) + far.w / 2} of ${dims[0] / 2}`
          )
        }

        // A picture already against the edge can still be grown INWARD, which
        // is the case one corner alone could never serve: nailed at the right
        // edge, only the left-hand corners have anywhere to go.
        const flush: Placement = { ...start, u: dims[0] / 2 - 0.2 - 0.01 }
        const inward = resizeFromCorner(flush, { su: -1, sv: -1 }, { u: -0.5, v: -0.3 }, aspect, dims)
        check(
          'a picture against one edge can still be grown from a corner facing the other way',
          inward.w > flush.w,
          `${inward.w} from ${flush.w}`
        )
      }
    }

    // --- THE PICTURE IS ON THE SURFACE, AND STAYS WHERE IT WAS PUT ----------
    //
    // The claim the whole feature rests on, and the reason the decal is painted
    // by the block's own material rather than drawn as a quad on the face: the
    // question is asked of the SURFACE, so material that survives a cut still
    // carries its part of the picture, on the surface, where it can be cut
    // along.
    //
    // WHAT A CUT NO LONGER DOES IS TAKE THE DRAWING AWAY. A face cut off from
    // another axis used to take its reference with it -- the picture can only
    // be painted where the block is -- which left somebody who had just squared
    // a drawing up with nothing to cut the rest of it by. A reference is what
    // you are working FROM rather than part of the piece, so the same picture
    // is also drawn as a quad on its own plane, sunk a hair into the block so
    // that the block hides it wherever the block still exists. See
    // `DecalGhosts`. The projection rule below is unchanged: it is what decides
    // where the picture is ON the material, and the ghost is what carries it
    // across the gap.
    //
    // `coversPoint` is that question in TypeScript, and the shader asks it in
    // GLSL a few lines apart -- so this is a check of the rule rather than of
    // the pixels, and the source assertion below is what keeps the two honest.
    {
      const dims: [number, number, number] = [1, 1, 1]
      const rect = placementRect(
        { id: 'd', presetId: 'p', imageId: 'i', face: '+z', u: 0, v: 0, w: 0.4, h: 0.2 },
        dims
      )
      const front: [number, number, number] = [0, 0.5, 0.5]
      check('a point under the picture is covered', coversPoint(rect, front, [0, 0, 1]), '')
      check(
        'a point beside it on the same face is not',
        !coversPoint(rect, [0.45, 0.5, 0.5], [0, 0, 1]),
        ''
      )
      // The face a cut leaves INSIDE the block: parallel to the picture, square
      // on to it, and bare. Without the plane test the projection would print
      // the drawing on it like a slide projector shining through a hole.
      check(
        'a parallel face a cut opened up inside the block is bare',
        !coversPoint(rect, [0, 0.5, 0.1], [0, 0, 1]),
        ''
      )
      check(
        'and a face at right angles to it is bare',
        !coversPoint(rect, [0.5, 0.5, 0.5], [1, 0, 0]),
        ''
      )
      // Which way up the picture goes: v counts DOWN the image, the way a
      // texture and a canvas are both indexed.
      const topLeft = pointUv(rect, [-0.2, 0.6, 0.5])
      check(
        'the top left of the rectangle is the top left of the picture',
        Math.abs(topLeft.x) < 1e-9 && Math.abs(topLeft.y) < 1e-9,
        `${topLeft.x}, ${topLeft.y}`
      )

      const shader = readFileSync(new URL('../src/viewport/decalMaterial.ts', import.meta.url), 'utf8')
      check(
        'the shader asks the same three questions the check just did',
        shader.includes('dot(refN, uDecalNormal[i]) < 0.999') &&
          shader.includes('PLANE_EPSILON') &&
          shader.includes('uv.x < 0.0 || uv.x > 1.0'),
        'the projection rule has to be the one written down in decalPlacement'
      )
      check(
        'and it paints into the diffuse colour, so a reference takes the light',
        shader.includes('diffuseColor.rgb = mix('),
        'painted after the lighting it would glow in the shadows'
      )
      const decals = readFileSync(new URL('../src/viewport/ReferenceDecals.tsx', import.meta.url), 'utf8')
      check(
        'the texture is not flipped, since the projection reads v down the picture',
        decals.includes('flipY = false'),
        'left flipped, every reference lands upside down'
      )
      // THE GHOST, and the three things that make it read as one drawing rather
      // than as a second copy of it. It sits BELOW the surface, so the block
      // hides it wherever the block is left; it writes no depth, so what is
      // behind it is still drawn; and it faces outward only, so a hole cut in
      // the face in front does not show it back to front.
      check(
        'the ghost is sunk into the block, which is what lets the surface hide it',
        decals.includes('const SINK = PLANE_EPSILON * 2') &&
          decals.includes('rect.centre[0] - rect.normal[0] * SINK'),
        'standing it proud would draw it over the painted picture instead of behind'
      )
      check(
        'and it is a picture rather than a wall',
        decals.includes('depthWrite={false}') && decals.includes('side={FrontSide}') &&
          decals.includes('raycast={noRaycast}'),
        'a drawing in mid-air must not take a pointer or hide what is behind it'
      )
      check(
        'and its quad reads v down the picture, like the projection',
        decals.includes('uv.setY(i, 1 - uv.getY(i))'),
        "planeGeometry's own v runs up it, so the ghost would land upside down"
      )

      // AND THE SAME PICTURE, THE SAME WAY UP -- which is the claim the two
      // string matches above cannot make on their own. The ghost is built here
      // exactly as the component builds it, and every corner of it is asked
      // where the SHADER would read the picture at that point: agreement means
      // one drawing carrying on across the gap rather than a second copy of it
      // arriving mirrored or upside down. On all six faces, because the frames
      // differ and three of them are the ones a hand-written rotation gets
      // wrong.
      const quad = new PlaneGeometry(1, 1)
      const quadUv = quad.attributes.uv
      for (let i = 0; i < quadUv.count; i++) quadUv.setY(i, 1 - quadUv.getY(i))
      let worst = 0
      for (const face of FACES) {
        const rect = placementRect(
          { id: 'g', presetId: 'p', imageId: 'i', face, u: 0.05, v: -0.02, w: 0.4, h: 0.2 },
          [1, 2, 3]
        )
        const turn = new Quaternion().setFromRotationMatrix(
          new Matrix4().makeBasis(
            new Vector3(...rect.u),
            new Vector3(...rect.v),
            new Vector3(...rect.normal)
          )
        )
        const corners = quad.attributes.position
        for (let i = 0; i < corners.count; i++) {
          const at = new Vector3(corners.getX(i) * rect.w, corners.getY(i) * rect.h, 0)
            .applyQuaternion(turn)
            .add(new Vector3(...rect.centre))
          const read = pointUv(rect, [at.x, at.y, at.z])
          worst = Math.max(worst, Math.abs(read.x - quadUv.getX(i)), Math.abs(read.y - quadUv.getY(i)))
        }
      }
      check(
        'so the ghost and the painted picture are the same picture, on every face',
        worst < 1e-9,
        `worst corner disagreement ${worst}`
      )
      check(
        'and it is turned by the face own axes, which is what makes that true',
        decals.includes('makeBasis(') && decals.includes('geometry={GHOST_QUAD}'),
        'no ordering of Euler angles is right for all six faces'
      )
    }
  }

  // UNDO AND REDO KEEP THEIR HANDS OFF. They walk whichever screen is up -- see
  // `NavBar` -- and this screen has no history, so they are dead. The failure
  // this guards is the one the old `live ? doc : lathe` had waiting: a third
  // screen silently stepping the lump of clay it is not showing.
  {
    // A lathe with something on its stack, so a pair of buttons wired to the
    // wrong screen would be visibly live rather than merely wrong.
    lathe().beginStroke()
    lathe().work({ y: 0.75, radius: 0.2, reach: 0.3, bite: 1, tool: 'push' })
    lathe().endStroke()
    check('the lathe has a stroke to walk back', lathe().past.length > 0, `${lathe().past.length}`)

    const bar = markupOf('NavBar (laser)', NavBar)
    shows('the bar lights the laser tab', bar, 'aria-current="page">Laser Cutter<')
    for (const label of ['Import', 'Export', 'Snap', 'Undo', 'Redo']) {
      shows(`${label} is still in the bar`, bar, `>${label}<`)
    }
    // Counted the way the lathe's are: what matters is that everything acting
    // on something this screen has not got stands down together.
    const down = (bar.match(/disabled=""/g) ?? []).length
    check(
      'and the controls with nothing to act on stand down together',
      down >= 4,
      `${down} disabled: Import, Export, undo and redo`
    )

    // SNAP IS NO LONGER ONE OF THEM, and that is the change rather than an
    // accident of counting. It used to stand down here on the strength of being
    // one of the six controls that mean nothing without a document -- but what
    // Snap governs is a DRAG landing on something worth landing on, and this
    // screen has one: a Point Cut's knots line up with the knots already
    // placed. The question is `snapsHere`, not `onDocument`, and the lathe --
    // which really has nothing to catch -- still answers no.
    {
      // Restored at the end: this block leaves the laser screen and comes back,
      // and `setScreen` shuts whatever panel was open on the way -- which the
      // cut-tool checks further down are relying on being up.
      const wasOpen = tools().openPanel
      tools().setOpenPanel('snap')
      const here = markupOf('SnapTool (laser)', SnapTool)
      hides('Snap is live on the laser screen', here, 'class="nav-btn" disabled')
      // AND ITS OWN NUMBER, which is the other half of it. The modelling
      // screen's distance is a length in the world -- right for catching the
      // corner of a solid standing somewhere in a room. This one lines a mark
      // up with a mark on the same flat face under a camera that zooms twenty
      // times over, so it is a distance on screen, and one number could not
      // have suited both.
      shows('with a sensitivity of its own', here, '>Sensitivity<')
      hides("and not the modelling screen's distance", here, '>Distance<')

      tools().setScreen('lathe')
      tools().setOpenPanel('snap')
      const away = markupOf('SnapTool (lathe)', SnapTool)
      // THE LATHE NOW ANSWERS YES TOO, and it is the same question that changed
      // its answer: it has a drag worth aiming. A ruler's end catches the wall
      // of the section, the axis, the rim and the plate -- every one of them an
      // edge worth landing exactly on rather than a pixel away from.
      hides('and the lathe, which now has a ruler to aim, is live as well', away, 'class="nav-btn" disabled')
      // Its own number, and in pixels: this view zooms four thousand to one, so
      // a length in the world would be a third of the frame at one end of that
      // range and finer than a pixel at the other.
      shows('with a sensitivity of its own', away, '>Sensitivity<')
      hides("and not the modelling screen's distance", away, '>Distance<')

      tools().setScreen('modelling')
      tools().setOpenPanel('snap')
      shows(
        'and the modelling screen still reads a length in the world',
        markupOf('SnapTool (modelling)', SnapTool),
        '>Distance<'
      )

      // ONE SWITCH, THREE NUMBERS: setting one screen's reach leaves the other
      // two exactly where they were, which is the whole of what "independent"
      // buys.
      const world = tools().snapDistance
      const onLathe = tools().latheSnapDistance
      tools().setLaserSnapDistance(24)
      check('the laser reach is its own number', tools().laserSnapDistance === 24, `${tools().laserSnapDistance}`)
      check("and does not touch the world's", tools().snapDistance === world, `${tools().snapDistance}`)
      check("nor the lathe's", tools().latheSnapDistance === onLathe, `${tools().latheSnapDistance}`)
      tools().setSnapDistance(0.5)
      check('nor the other way about', tools().laserSnapDistance === 24, `${tools().laserSnapDistance}`)
      tools().setLatheSnapDistance(31)
      check('the lathe keeps a third reach of its own', tools().latheSnapDistance === 31, `${tools().latheSnapDistance}`)
      check('leaving the laser where it stood', tools().laserSnapDistance === 24, `${tools().laserSnapDistance}`)
      // Clamped to the range the panel offers: a snap reaching half the window
      // is a knot that can never be placed anywhere.
      tools().setLaserSnapDistance(9999)
      check('and it is held inside the range on offer', tools().laserSnapDistance === LASER_SNAP_MAX, `${tools().laserSnapDistance}`)
      tools().setLatheSnapDistance(9999)
      check('the lathe likewise', tools().latheSnapDistance === LATHE_SNAP_MAX, `${tools().latheSnapDistance}`)
      tools().setLaserSnapDistance(DEFAULT_LASER_SNAP)
      tools().setLatheSnapDistance(onLathe)
      tools().setSnapDistance(world)

      tools().setScreen('laser')
      tools().setOpenPanel(wasOpen)
    }
    lathe().undo()
    lathe().centreFresh()
    lathe().past.length = 0
    lathe().future.length = 0
  }

  // The screen is a TOOL setting like every other: switching to it must not
  // land in the document's history.
  {
    const entries = doc().past.length
    tools().setScreen('modelling')
    tools().setScreen('laser')
    check('arriving costs no undo entries', doc().past.length === entries, `${doc().past.length - entries}`)
  }

  // --- the laser cutter's tools ---------------------------------------------
  //
  // TWO WAYS OF PUTTING ONE LINE ON ONE FACE, and everything after the line
  // exists is shared between them -- how it is carried to the border, how it is
  // swept, what a cut leaves behind. So what is worth pinning here is the shape
  // of the pair: that each is a tool on the island with a panel of its own, that
  // the panel carries the same three acts, and that the one setting that is
  // about the CUT rather than about the drawing is one flag both of them read.
  // The arithmetic is `engine-check`'s, which can cut a block without a window.
  //
  // AND MOVE, which is a third tool in the same field and cuts nothing. What is
  // worth pinning about it is precisely that it is in the same field: the whole
  // reason the padlock could be taken off every decal is that holding one tool
  // means not holding the other, so a cutter in hand cannot shift a drawing and
  // Move in hand cannot burn one.
  console.log('\nThe laser cutter tools: one line two ways, and one that cuts nothing')
  {
    tools().setScreen('laser')
    tools().setLaserTool(null)
    draft().clear()

    const free = markupOf('FreehandTool', FreehandTool)
    const point = markupOf('PointCutTool', PointCutTool)
    shows('the island offers Freehand', free, '>Freehand<')
    shows('and Point Cut', point, '>Point Cut<')

    // EMPTY-HANDED ON ARRIVAL, unlike the lathe. A press with a tool in hand
    // starts a line that has to be finished, aimed and applied; arriving armed
    // would mean the first press meant for the compass left a stroke on the face.
    check('and neither is in hand on arrival', tools().laserTool === null, `${tools().laserTool}`)
    hides('so neither button is lit', free + point, 'nav-group nav-group-active')

    // NO HOVER BUBBLE ON ANY OF THE THREE, the bargain Snap and Cut already
    // strike next door: this island has three buttons and every one of them is
    // reached for constantly, so a paragraph that appears each time the pointer
    // crosses one is noise. Checked rather than trusted, because a `tip` prop is
    // one word to add back and nothing on screen would object.
    hides('Freehand carries no hover bubble', free, 'nav-tip')
    hides('nor does Point Cut', point, 'nav-tip')

    // Taking one up opens its panel, the way arming the cut plane does: the
    // tool's own Apply lives in there, and a cut you could draw but not fire
    // would be the panel nobody found.
    tools().setLaserTool('freehand')
    check('taking one up opens its panel', tools().openPanel === 'freehand', `${tools().openPanel}`)
    tools().setLaserTool('points')
    check('and taking the other up moves the panel with it', tools().openPanel === 'points', `${tools().openPanel}`)
    check('one tool at a time, because the store holds one', tools().laserTool === 'points', `${tools().laserTool}`)
    tools().setLaserTool(null)
    check('putting it down shuts the panel', tools().openPanel === null, `${tools().openPanel}`)

    // MOVE, the third tool, and every claim about it is about the field it
    // shares with the other two.
    {
      const reference = () => useReference.getState()
      /** Whether the island's Move button is greyed. By the button carrying the
       *  word rather than by attribute order -- see `buttonIsDown`, which does
       *  the same thing for a button that has an `aria-label` to go on. */
      const moveIsDown = (markup: string): boolean => {
        const tag = markup.split('<button').find((part) => part.includes('>Move<'))
        return tag !== undefined && tag.slice(0, tag.indexOf('>')).includes('disabled=""')
      }

      // Dimmed with nothing on the block: the button is what says the gesture
      // exists, so it stays on the island rather than appearing once you have
      // already worked out how to place a reference.
      for (const placement of [...reference().placements]) reference().removePlacement(placement.id)
      const bare = markupOf('MoveRefTool (nothing on the block)', MoveRefTool)
      shows('the island offers Move', bare, '>Move<')
      check('dimmed while no reference is on the block', moveIsDown(bare), 'should be disabled')

      reference().putImage(0, { name: 'plan.png', src: 'data:,', width: 400, height: 200 })
      const drawing = activePreset(reference()).slots[0]!
      reference().startDrag(drawing.id)
      reference().dragOver({ face: '+z', u: 0, v: 0 })
      reference().dropDrag({ w: 0.4, h: 0.2 })
      const live = markupOf('MoveRefTool (a reference on the block)', MoveRefTool)
      check('and live once there is one', !moveIsDown(live), 'should be enabled')
      hides('and it carries no hover bubble either', bare + live, 'nav-tip')

      // ONE FIELD, so taking Move up puts the cutter down -- which is the whole
      // of what the padlock used to be for.
      tools().setLaserTool('freehand')
      tools().setLaserTool('move')
      check('taking Move up puts the cutter down', tools().laserTool === 'move', `${tools().laserTool}`)
      check('and shuts the panel that cutter had open', tools().openPanel === null, `${tools().openPanel}`)
      tools().setLaserTool('points')
      check('and taking a cutter up puts Move down', tools().laserTool === 'points', `${tools().laserTool}`)

      // NO PANEL, and it is the only tool on this island without one: there is
      // nothing to aim, so there is no caret and nothing for the island to shut.
      tools().setLaserTool('move')
      hides('Move carries no caret', markupOf('MoveRefTool (armed)', MoveRefTool), 'nav-caret')
      shows('but it is lit while in hand', markupOf('MoveRefTool (lit)', MoveRefTool), 'nav-group nav-group-active')

      reference().removeImage(drawing.id)
      tools().setLaserTool(null)
    }

    // Both panels are on the ISLAND's list, or the island cannot shut them --
    // the button goes off screen with the body and the panel springs back open
    // from a click nobody made. See `ISLAND_PANELS`.
    for (const id of ['freehand', 'points'] as const) {
      check(
        `the island can shut the ${id} panel`,
        ISLAND_PANELS.includes(id),
        ISLAND_PANELS.includes(id) ? 'on the list' : 'MISSING from ISLAND_PANELS'
      )
    }

    tools().setLaserTool('freehand')
    const armed = markupOf('FreehandTool (armed)', FreehandTool)
    shows('the armed tool is lit', armed, 'nav-group nav-group-active')

    // ONE DIAL, and it is the one thing Freehand has that Point Cut does not.
    shows('Freehand carries a smoothing dial', armed, '>Smoothing<')
    hides('and Point Cut does not', markupOf('PointCutTool (armed)', PointCutTool), '>Smoothing<')

    // FIT TO LINE IS A SWITCH, and it was three named modes: Straight, Fit to
    // line, Manual. The third was never a third way of joining points -- it was
    // the fitted curve with its tangents handed over to be aimed, so it and Fit
    // differed by who owned the handles rather than by what the line was. What
    // that bundling cost is the trap the switch undoes: the one mode named for
    // hand-editing was the one you could not reach from a straight line.
    //
    // Both states named, in the app's own yes-or-no idiom -- the same one
    // Outlines and the hollow ends use. `On | Off` with one lit says what the
    // alternative IS, which an empty tickbox leaves you to infer.
    tools().setLaserTool('points')
    const modes = markupOf('PointCutTool (fit)', PointCutTool)
    shows('Point Cut asks whether the line is fitted', modes, '>Fit to line<')
    for (const label of ['On', 'Off']) {
      shows(`and names the ${label} state`, modes, `>${label}<`)
    }
    hides('with no third mode left to pick', modes, '>Manual<')
    check('it rests with the curve off', tools().fitCurve === false, `${tools().fitCurve}`)
    shows('and that state is the lit one', modes, 'seg-btn seg-active" aria-pressed="true')

    // THE SAME THREE ACTS FOR BOTH TOOLS, written once and shown once -- in a
    // panel of their own over the scene rather than inside either tool's
    // flyout. See below for why that had to move.
    const panelOf = (tool: 'freehand' | 'points') => {
      tools().setLaserTool(tool)
      return tool === 'freehand'
        ? markupOf('FreehandTool (acts)', FreehandTool)
        : markupOf('PointCutTool (acts)', PointCutTool)
    }
    for (const [name, markup] of [
      ['Freehand', panelOf('freehand')],
      ['Point Cut', panelOf('points')],
    ] as const) {
      hides(`${name} does not carry Apply itself`, markup, '>Apply cut<')
      hides(`nor Reset -- ${name}`, markup, '>Reset line<')
      // AUTO DISCARD IS GONE, and its absence is worth a check rather than a
      // deletion: it binned a piece before the user had looked at which one the
      // cut had picked, and the cut's pick is a guess now rather than a
      // verdict. See the note where the flag used to be in `toolStore`, and
      // `choices` in `laserStore` for what replaced it.
      hides(`${name} offers no auto discard`, markup, 'Auto discard')
      hides(`nor any switch at all -- ${name}`, markup, 'nav-action-switch')
    }

    // A TOOL YOU AIM BY DRAWING CANNOT KEEP ITS ACTIONS IN A FLYOUT, which is
    // the whole reason this panel exists. `NavBar`'s outside-press listener
    // closes an open island panel on any pointerdown that is not inside the
    // island -- that is what makes every flyout in the app dismiss by clicking
    // away -- and drawing a cut IS a pointerdown on the canvas. So the button
    // that applied the line was shut by the act of drawing the line, every
    // time, with nothing on screen saying why. See `CutPanel`.
    for (const cutter of ['freehand', 'points'] as const) {
      tools().setLaserTool(cutter)
      const panel = markupOf(`CutPanel (${cutter})`, CutPanel)
      shows(`with ${cutter} in hand the cut panel can fire a cut`, panel, '>Apply cut<')
      shows(`and throw the drawing away -- ${cutter}`, panel, '>Reset line<')
    }

    // AND IT GOES WITH THE TOOL, which is what makes it a popup rather than a
    // fourth permanent panel: with no line to apply the corner is scene again.
    tools().setLaserTool(null)
    check(
      'with empty hands the cut panel renders nothing',
      renderToStaticMarkup(createElement(CutPanel)) === '',
      'the corner goes back to being scene'
    )
    // MOVE IS IN THE SAME FIELD AS THE CUTTERS but is not one: it takes hold of
    // a reference rather than the block, and there is no line in hand to burn.
    tools().setLaserTool('move')
    check(
      'nor with Move in hand, which cuts nothing',
      renderToStaticMarkup(createElement(CutPanel)) === '',
      'Move holds a picture, not a line'
    )

    // AND A PRESS ON IT MUST NOT SHUT THE DIAL THAT AIMED THE LINE. It is
    // chrome, not scene -- so it joins the bar, the island and the help card on
    // the one list of places a press does not dismiss a flyout.
    {
      const navbar = readFileSync(new URL('../src/console/NavBar.tsx', import.meta.url), 'utf8')
      shows('a press on the cut panel leaves an open flyout alone', navbar, '.cut-panel')
    }

    // MOUNTED IN THE BOTTOM-LEFT COLUMN, above the block. A panel nothing
    // renders is the same as no panel, and the column is what lets the two
    // stack without either measuring the other -- the block panel collapses,
    // so a fixed offset above it would gap when shut and overlap when open.
    {
      const laserView = readFileSync(
        new URL('../src/viewport/LaserViewport.tsx', import.meta.url),
        'utf8'
      )
      const sheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
      shows('the screen mounts the cut panel', laserView, '<CutPanel />')
      shows('in a column with the block', laserView, 'className="laser-corner"')
      check(
        'anchored to the bottom left corner',
        /\.laser-corner[^{]*{[^}]*left: 12px[^}]*bottom: 12px/.test(sheet),
        'left 12, bottom 12'
      )
      check(
        'with the block placed by the column rather than by its own corner',
        /\.laser-corner \.stock-panel[^{]*{[^}]*position: static/.test(sheet),
        'both screens stack now, so the column is the override and the corner is the default'
      )
      check(
        'and the cut panel sized to what is in it',
        /.cut-panel {[^}]*width: max-content/.test(sheet),
        'a stack of short buttons, not a 232px box'
      )
    }

    // AND POINT CUT'S PANEL HANGS UNDER ITS BUTTON, where every other island
    // panel opens out to the side. The side is right for a tool with buttons
    // beneath it in the column -- a dropped panel would cover them, which is
    // why the island opens sideways at all -- and Point Cut is the LAST tool in
    // that column, so there is nothing under it but scene. Below is where a
    // dropdown belongs, and it keeps the deeper of the two cut panels out of
    // the middle of the window, which is the face being drawn on.
    shows(
      'Point Cut drops its panel under the button',
      panelOf('points'),
      'nav-panel nav-panel-below'
    )
    hides('while Freehand keeps to the side', panelOf('freehand'), 'nav-panel-below')

    // With the rules to place it, and the two flips a corner needs: no room
    // under the button in a bottom corner, and measured from the near edge
    // against a right-hand one.
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    check(
      'and the island has somewhere to put it',
      css.includes('.tool-island .nav-panel-below') &&
        css.includes('.tool-island-bottom .nav-panel-below') &&
        css.includes('.tool-island-right .nav-panel-below'),
      'placed, flipped up in a bottom corner, and anchored to a right-hand edge'
    )

    // APPLY IS DEAD WITH NOTHING DRAWN, which is the honest reading of a button
    // that would otherwise fire a cut with no line in it.
    draft().clear()
    tools().setLaserTool('points')
    shows('Apply is dead with nothing drawn', markupOf('CutPanel (empty)', CutPanel), '>Apply cut</button>')
    check('because the draft is not ready', !draftReady(draft(), false), '')

    // TWO POINTS IS THE WHOLE REQUIREMENT, and the panel says so while it is
    // waiting -- an empty face does not.
    draft().begin({ axis: 2, sign: 1 }, 'points')
    shows(
      'and the panel asks for the first point',
      markupOf('PointCutTool (none)', PointCutTool),
      'Click the face to place the first point.'
    )
    draft().addPoint([-0.2, -0.2])
    shows('then for one more', markupOf('PointCutTool (one)', PointCutTool), 'One more point.')
    draft().addPoint([0.2, 0.2])
    check('with two, there is a line to cut with', draftReady(draft(), true), '')

    // THE PREVIEW AND THE CUT ARE ONE FUNCTION, so the tool cannot burn
    // something other than what it drew. What that buys is checked here: the
    // switch is two readings of the SAME points, and the points survive it.
    {
      const straight = draftLine(draft(), false)
      const curved = draftLine(draft(), true)
      check('with the curve off the line is the points themselves', straight.length === 2, `${straight.length}`)
      check('and with it on, a curve sampled through them', curved.length > 8, `${curved.length}`)
      check('the points survive the switch', draft().points.length === 2, `${draft().points.length}`)
    }

    // AIMING A HANDLE IS PER POINT, which is the whole of what replaced the
    // third mode. A point holds a null until its handle is aimed, so an untouched
    // run is exactly the fit and one aimed tangent does not cost the fit on
    // every other point -- a sentence the three modes had nowhere to put.
    {
      draft().clear()
      draft().begin({ axis: 2, sign: 1 }, 'points')
      for (const at of [[-0.3, -0.3], [0, 0.1], [0.3, -0.3]] as [number, number][]) {
        draft().addPoint(at)
      }
      check('a placed point takes the curve own tangent', draft().handles.every((h) => h === null), JSON.stringify(draft().handles))
      const fitted = draftLine(draft(), true)

      // Aim the middle one, and only the middle one.
      draft().moveHandle(1, [0.2, 0.4], 1)
      check('aiming one hands that tangent over', draft().handles[1] !== null, JSON.stringify(draft().handles[1]))
      check('and leaves its neighbours to the fit', draft().handles[0] === null && draft().handles[2] === null, '')
      const aimed = draftLine(draft(), true)
      check(
        'which changes the line it draws',
        aimed.some((q, i) => Math.hypot(q[0] - fitted[i][0], q[1] - fitted[i][1]) > 1e-6),
        ''
      )

      // MOVING A POINT DOES NOT UNDO THE AIM, and that is the difference the old
      // Fit mode could not express: there, a drag refitted every handle and threw
      // the shaping away.
      const kept = draft().handles[1]
      draft().movePoint(0, [-0.35, -0.25])
      check('and a drag elsewhere leaves it exactly alone', JSON.stringify(draft().handles[1]) === JSON.stringify(kept), '')
      check('while the unaimed ones follow the points', draft().handles[0] === null, '')

      // AND THERE IS A ROAD BACK, or aiming a handle would be a trap: the only
      // other way to a fitted tangent would be to delete the point.
      draft().refitHandle(1)
      check('a handle can be given back to the curve', draft().handles[1] === null, '')

      // The aim survives the switch being thrown, so turning the curve off to
      // reposition something and on again does not throw the shaping away.
      draft().moveHandle(1, [0.2, 0.4], 1)
      const through = draftLine(draft(), true)
      check('and the switch does not lose one', draftLine(draft(), false).length === 3, '')
      check(
        'nor change the curve it comes back to',
        draftLine(draft(), true).every((q, i) => Math.hypot(q[0] - through[i][0], q[1] - through[i][1]) < 1e-12),
        ''
      )
      draft().clear()
      draft().begin({ axis: 2, sign: 1 }, 'points')
      draft().addPoint([-0.2, -0.2])
      draft().addPoint([0.2, 0.2])
    }

    // A DRAFT BELONGS TO ONE FACE. Turning the compass elsewhere has to drop it:
    // a line the user can no longer see, with Apply still willing to burn it, is
    // the one failure here that destroys work rather than merely surprising.
    check('and it knows which face it is on', draft().face?.axis === 2, `${draft().face?.axis}`)
    draft().begin({ axis: 0, sign: 1 }, 'points')
    check('starting on another face clears it', draft().points.length === 0, `${draft().points.length}`)

    // THE OFFCUT ROW appears only after a cut that left one, and it is the
    // Delete key's twin -- see `LaserViewport` for the key.
    laser().freshStock()
    tools().setLaserTool('freehand')
    {
      const clean = markupOf('CutPanel (clean)', CutPanel)
      hides('no offcut, no row', clean, '>Discard piece<')
      hides('and nothing to step between', clean, '>Other piece<')
    }
    // A cut a third of the way across, so the two pieces are plainly different
    // sizes and "the smaller one" means something.
    laser().cut([[0.3, -0.3], [0.3, 0.3]], { axis: 2, sign: 1 })
    check('a cut leaves a piece lit', laser().offcut !== null, laser().offcut ?? 'nothing lit')
    {
      const after = markupOf('CutPanel (offcut)', CutPanel)
      shows('and the panel offers to throw it away', after, '>Discard piece<')
      shows('and to light the other one instead', after, '>Other piece<')
    }

    // WHICH PIECE IS THE USER'S TO SAY, and this is the whole of what changed.
    // The cut still guesses -- the smallest, which is right for most cuts --
    // but a cut that frees the part you want from the stock around it makes the
    // KEEPER the small one, and a screen that only ever lit the sliver would be
    // offering to bin the thing you came for.
    {
      check('both pieces are on offer', laser().choices.length === 2, `${laser().choices.length}`)
      const byId = (id: string | null) => laser().pieces.find((p) => p.id === id)
      const opened = byId(laser().offcut)
      const other = laser().pieces.find((p) => p.id !== laser().offcut)
      check(
        'the choice opens on the smaller of them',
        opened !== undefined && other !== undefined && opened.volume < other.volume,
        `${opened?.volume.toFixed(4)} against ${other?.volume.toFixed(4)}`
      )
      // Biggest first, so stepping is stepping down in size and wraps back to
      // the top.
      laser().nextOffcut()
      check(
        'and steps onto the bigger one',
        laser().offcut === other?.id,
        `${byId(laser().offcut)?.volume.toFixed(4)}`
      )
      laser().nextOffcut()
      check('wrapping back round', laser().offcut === opened?.id, '')

      // The direct way to say it, which is what a click on a piece calls.
      laser().markOffcut(other!.id)
      check('a piece can be named outright', laser().offcut === other?.id, '')
      // And a piece this cut did not make is not on offer -- the press that
      // lands on an older sliver does nothing rather than something surprising.
      laser().markOffcut('piece-does-not-exist')
      check('while a piece that is not on offer is refused', laser().offcut === other?.id, '')

      // NOT AN UNDO STEP, either way of saying it: nothing has been destroyed,
      // both pieces are still on the bed, and a history that stepped through
      // every change of mind would bury the cut under them.
      const steps = laser().past.length
      laser().nextOffcut()
      laser().markOffcut(other!.id)
      check('and changing your mind is not an act to walk back', laser().past.length === steps, `${laser().past.length - steps}`)

      // Put it back on the smaller one for what follows.
      laser().markOffcut(opened!.id)
    }

    const before = laser().pieces.length
    laser().discardOffcut()
    check('which it does', laser().pieces.length === before - 1, `${laser().pieces.length}`)
    check('and nothing is left lit', laser().offcut === null, '')
    // And the offer is spent with it: the pair it was a choice between is
    // broken, and what is left is one piece rather than a decision.
    check('nor anything left to choose between', laser().choices.length === 0, `${laser().choices.length}`)

    // BAKED, so the way back is the history rather than a list of cuts. One cut
    // is one step, and so is throwing an offcut away -- it destroys work too.
    laser().undo()
    check('undo puts the offcut back', laser().pieces.length === before, `${laser().pieces.length}`)
    laser().undo()
    check('and again gives back the whole block', laser().pieces.length === 1, `${laser().pieces.length}`)
    check('which is a whole block', laser().pieces[0].volume > 0.99, laser().pieces[0].volume.toFixed(4))
    laser().redo()
    check('redo cuts it again', laser().pieces.length === 2, `${laser().pieces.length}`)

    // A MISS COSTS NOTHING, not even an undo step: an entry for an act that did
    // nothing is an undo press that appears to do nothing too.
    {
      const steps = laser().past.length
      const pieces = laser().pieces.length
      const split = laser().cut([[3, -0.3], [3, 0.3]], { axis: 2, sign: 1 })
      check('a line clear of the bed reports no split', split === 0, `${split}`)
      check('and leaves the pieces alone', laser().pieces.length === pieces, `${laser().pieces.length}`)
      check('and the history alone', laser().past.length === steps, `${laser().past.length - steps}`)
    }

    // THE BAR'S TWO BUTTONS WALK THIS SCREEN NOW, which is the fix the third
    // screen forced: `live ? doc : lathe` meant "not modelling" was "the lathe"
    // for exactly as long as there were two screens.
    {
      const bar = markupOf('NavBar (laser, cut)', NavBar)
      check(
        'undo is live on the laser screen once there is a cut to walk back',
        !/>Undo<[\s\S]{0,60}disabled/.test(bar) && laser().past.length > 0,
        `${laser().past.length} steps`
      )
    }

    laser().freshStock()
    laser().past.length = 0
    laser().future.length = 0
    tools().setLaserTool(null)
    draft().clear()
  }

  // THE WAY OFF THE LASER CUTTER, which is the lathe's door in the same words:
  // what is on the bed becomes a solid on the clipboard. What is worth pinning
  // is the three things a screenshot cannot show -- that an uncut block arrives
  // as a BOX rather than as twelve triangles pretending to be one, that a cut
  // bed arrives at the size the block was set to rather than as the unit cube
  // it is stored as, and that the pictures stuck to the block are left behind.
  console.log('\nCopying off the laser cutter: the bed, at its own size, without the pictures')
  {
    const corner = markupOf('CopyBlockButton', CopyBlockButton)
    shows('the corner offers the copy', corner, 'Copy to clipboard')
    check(
      'in the same words the lathe uses',
      corner.includes('Copy to clipboard') &&
        markupOf('CopyPieceButton', CopyPieceButton).includes('Copy to clipboard'),
      'one control on two screens'
    )
    check(
      'docked against the compass rather than in its corner',
      corner.includes('copy-piece-aside'),
      'the lathe has no compass to make room for'
    )
    check(
      'and says nothing until it has something to report',
      !corner.includes('copy-piece-note'),
      'no receipt before the first press'
    )

    // AN UNCUT BLOCK IS A BOX. Pressed for real, through the same calls the
    // button makes.
    {
      laser().freshStock()
      for (const [axis, side] of ([[0, 2], [1, 0.5], [2, 1.5]] as const)) {
        laser().setDim(axis, side)
      }
      check('the bed reads as uncut', bedIsUncut(laser().pieces), `${laser().pieces.length} pieces`)

      const { dims, pieces } = laser()
      const solid = {
        ...makeObject({ kind: 'box', size: [dims[0], dims[1], dims[2]] }, [0, dims[1] / 2, 0]),
        // Over `makeObject`'s own answer, which for a box is the shape's name
        // and would lose where the thing came from. See `CopyBlockButton`.
        name: bedName(1, true),
      }
      library().copyObject(solid)
      library().renameCustom(library().saveCustom(solid), bedName(pieces.length, true))
      const copied = library().clipboard
      check(
        'an uncut block crosses as a box, not as a mesh of one',
        copied?.base.kind === 'box',
        `${copied?.base.kind}`
      )
      const size = copied?.base.kind === 'box' ? copied.base.size : [0, 0, 0]
      check(
        'at the three sides the block was set to',
        size[0] === 2 && size[1] === 0.5 && size[2] === 1.5,
        size.join(' x ')
      )
      check(
        'standing on the ground',
        copied !== null && Math.abs(copied.transform.position[1] - 0.25) < 1e-9,
        `${copied?.transform.position.join(', ')}`
      )
      check('named for what it is', copied?.name === BLOCK_NAME, `${copied?.name}`)
      check(
        'and it lands on the shelf as well as in the paste buffer',
        library().customs.some((c) => c.name === BLOCK_NAME),
        library().customs.map((c) => c.name).join(', ') || 'nothing on the shelf'
      )

      // THE RECEIPT SAYS ONE UNIT, not three. `formatLength` resolves a unit
      // per value, so in auto a 20 cm side beside a 5 mm one would print two
      // different units inside one size -- and even where they agreed, the
      // suffix would be said three times over.
      const mixed: Vec3 = [2, 0.005, 1.5]
      const said = sizeIn(mixed, resolveUnit(Math.max(...mixed), 'auto'))
      // Three numbers and ONE word: anything else means a unit crept in beside
      // a side rather than standing once at the end of all three.
      check(
        'the receipt gives the three sides one unit between them',
        /^[0-9. ]+ x [0-9. ]+ x [0-9. ]+ [a-z]+$/.test(said),
        said
      )
      check(
        'which is the one the longest side asked for',
        said.endsWith(suffixOf(resolveUnit(2, 'auto'))),
        said
      )
    }

    // A CUT BED IS A MESH, at the size the block was set to. The pieces are
    // stored in block space -- a unit cube -- so this is the one place the
    // three sides are baked in, and getting it wrong would hand the document a
    // piece a tenth of the size it was cut at.
    {
      const split = laser().cut(
        [
          [-1, 0],
          [1, 0],
        ],
        { axis: 2, sign: 1 }
      )
      check('a line across the face cuts it', split === 1, `${split}`)
      check('the bed no longer reads as uncut', !bedIsUncut(laser().pieces), '')

      const { dims, pieces } = laser()
      const merged = bedGeometry(
        pieces.map((p) => p.geometry),
        dims
      )
      const box = new Box3().setFromBufferAttribute(
        merged.getAttribute('position') as BufferAttribute
      )
      const span = box.getSize(new Vector3())
      // The kerf is a slot burnt out of the MIDDLE, so the block's outline
      // survives it whole: both halves are still there and still where they
      // were. What the cut costs shows up in the volume, not in the extent.
      check(
        'the merged bed measures the block, not the unit cube it is stored as',
        Math.abs(span.x - dims[0]) < 1e-4 &&
          Math.abs(span.y - dims[1]) < 1e-4 &&
          Math.abs(span.z - dims[2]) < 1e-4,
        `${span.x.toFixed(3)} x ${span.y.toFixed(3)} x ${span.z.toFixed(3)}`
      )
      const left = pieces.reduce((sum, p) => sum + p.volume, 0)
      check(
        'with the kerf missing out of the middle of it',
        left < 1 && 1 - left < 0.05,
        `${(1 - left).toFixed(4)} of the block burnt away`
      )

      const entry = registerMesh(merged, bedName(pieces.length, false))
      const { size } = fitToEnvelope(entry.natural)
      const solid = makeObject(
        { kind: 'mesh', meshId: entry.id, label: entry.label, size },
        [0, size[1] / 2, 0]
      )
      library().copyObject(solid)
      const copied = library().clipboard
      check(
        'a cut bed crosses as a mesh, which is what the scene can already hold',
        copied?.base.kind === 'mesh',
        `${copied?.base.kind}`
      )
      // The envelope never has to shrink a block, because the block's own range
      // IS the document's -- which is what keeps this round trip exact and the
      // normals with it.
      check(
        'at the size it was cut, untouched by the envelope',
        Math.abs(size[0] - dims[0]) < 1e-4 && Math.abs(size[2] - dims[2]) < 1e-4,
        size.map((n) => n.toFixed(3)).join(' x ')
      )
      check(
        'and its name says how many pieces came across',
        bedName(2, false) === 'Cut pieces (2)' && bedName(1, false) === 'Cut piece',
        bedName(pieces.length, false)
      )
    }

    // THE PICTURES ARE LEFT BEHIND. A reference is a thing to cut TO, the way a
    // pencil line on stock is; a photograph welded to a face would be the one
    // part of the piece that could never be machined off. It is left behind by
    // construction -- decals are their own layer over the pieces rather than
    // part of them -- and this is what holds that to account: laying one on the
    // block must not change a single triangle of what the copy takes.
    {
      const { dims, pieces } = laser()
      const trisOf = () => {
        const geometry = bedGeometry(
          pieces.map((p) => p.geometry),
          dims
        )
        const count = geometry.getAttribute('position').count / 3
        geometry.dispose()
        return count
      }
      const bare = trisOf()

      useReference.getState().putImage(0, { name: 'plan.png', src: 'data:,', width: 400, height: 200 })
      const image = activePreset(useReference.getState()).slots[0]
      useReference.getState().startDrag(image!.id)
      useReference.getState().dragOver({ face: '+z', u: 0, v: 0 })
      useReference.getState().dropDrag({ w: 0.4, h: 0.2 })
      check(
        'a picture is on the block',
        visiblePlacements(useReference.getState()).length > 0,
        `${visiblePlacements(useReference.getState()).length}`
      )
      check(
        'and the copy is the same triangles it was without it',
        trisOf() === bare,
        `${trisOf()} against ${bare}`
      )
    }

    laser().freshStock()
    for (const axis of [0, 1, 2] as const) laser().setDim(axis, DEFAULT_BLOCK)
    laser().past.length = 0
    laser().future.length = 0
  }

  tools().setScreen('modelling')
}

console.log(
  failures === 0
    ? '\nAll console checks passed.\n'
    : `\n${failures} console check(s) FAILED.\n`
)
process.exit(failures === 0 ? 0 : 1)
