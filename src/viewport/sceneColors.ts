import type { Theme } from '../theme'

/**
 * The colours the scene draws with, one full set per theme.
 *
 * Its own module, with no three.js and no React in it, for the same two reasons
 * `axisColors` is one: the widgets that draw with these and the check suite that
 * guards them can both import it without dragging a renderer along, and there is
 * exactly one definition to change.
 *
 * WHY THIS EXISTS. A three material cannot read a CSS custom property, so every
 * colour that appears on both sides of the window has to be written down twice.
 * That much is unavoidable. What was avoidable was writing the second copy in
 * eight different files, none of them saying what it was a copy OF -- so this is
 * the one scene-side copy, each entry naming the property it mirrors, and
 * `ui-check` fails if any pair drifts apart, in any theme.
 *
 * WHY IT IS PER THEME. Because a theme that stops at the console is not a theme:
 * the viewport is most of the window. A light console around a near-black scene
 * does not read as a light app, it reads as a bug -- and the values here are not
 * merely tinted versions of each other, they are re-decided. The compass face is
 * near-white on dark and near-black on light. The gizmo's ring is the brightest
 * thing in the scene on dark and one of the darkest on light. Idle edges have to
 * sit BETWEEN the solid and the background, and which direction that is flips.
 */
export type SceneColors = {
  /** The scene's own ground. Mirrors --surface-0. */
  bg: string
  /** Mirrors --accent: selection, a snapped edge, the rotation dial. */
  accent: string
  /** Mirrors --out: material added, and a vertex snap. */
  out: string
  /** Mirrors --in: material taken away, and what an eraser wears. */
  in: string
  /**
   * Mirrors --round: the shape changed without material going either way.
   *
   * The Smoother's, and the third member of a pair that had only ever needed
   * two. `out` and `in` are a direction -- more material or less -- and that
   * vocabulary has no word for a tool that eases a corner over and leaves the
   * solid weighing very nearly what it did. So this is deliberately NEUTRAL in
   * each theme: cool, unsaturated, and readable against the ground without
   * claiming to be either of the other two. It is also deliberately not
   * `accent`, which already means selected everywhere else in the scene.
   */
  round: string
  /** Mirrors --danger: the armed cut plane. */
  danger: string
  /** Mirrors --ruler: a measurement laid across the scene. */
  ruler: string
  /**
   * The Laser Cutter's symmetry axis, and the one colour here that mirrors no
   * token in the stylesheet.
   *
   * IT HAS NO CSS TWIN because it has no counterpart in the console: the axis
   * is drawn on the block and nowhere else, so there is nothing for the two
   * halves of the window to agree about. Every colour above is in
   * `SCENE_CSS_VARS` for exactly the opposite reason.
   *
   * GREEN, AND NOT `out`'s GREEN. Material added is a green in two of these
   * palettes and an orange in the third, and the axis is neither adding nor
   * taking away -- it burns nothing at all, which is the one thing it has to
   * say at a glance against a face covered in the red of lines that do. So it
   * is a green of its own, cooler than `out` where the two could be seen
   * together and unmistakably not the erase red.
   */
  mirror: string

  /** The dark half of the stripes on a selected ruler. Never pure black: over
   *  the scene's own ground that reads as a gap, and the stripes as a dashed
   *  line -- the one reading that could be confused with the thin passive form. */
  rulerStripe: string
  /** The ruler knob under the pointer, lifted the way a hovered handle is. */
  rulerLit: string

  /** A sketch at rest, and the face snap that lands on one: a face snap should
   *  look like the sketch it is about to become. */
  sketchIdle: string
  /** A sketch whose feature is switched off. */
  sketchDisabled: string

  /** The outline of a solid nobody is pointing at. It has to sit BETWEEN the
   *  solid and the ground, which is why it cannot simply be darkened per theme. */
  edgeIdle: string
  /** The outline of the selected solid. */
  edgeSelected: string
  /** The outline of an eraser being aimed. */
  eraseEdge: string

  /** A selected solid brightens rather than turning the accent colour -- a
   *  coloured object must stay its own colour while it is selected. */
  selected: string
  /** The glow under that, and the only place the accent hue touches the solid. */
  selectedEmissive: string

  /** The ground grid: minor lines, then the major ones every metre. Both are
   *  lifted well clear of the ground, or the floor reads as empty space. */
  gridCell: string
  gridSection: string

  /** The corner compass: its face, the label on it, and the ink its lettered
   *  balls are cut out in -- which is the ground colour, so a letter is a hole
   *  rather than a white glyph on a fully saturated ball. */
  compassFace: string
  compassText: string
  compassInk: string
  /** The fill behind a negative direction's ring: the ground, mostly opaque. */
  compassDim: string

  /** The transform gizmo's ring. */
  gizmoRing: string

  /** The cool fill light opposite the key. Tinted, and the tint is the one place
   *  a theme's hue reaches the solids themselves. */
  fillLight: string
}

/**
 * Dark: the app as it was, and still the default.
 *
 * These are the values the whole thing was designed around -- warm grey solids
 * on near-black, fully saturated gizmo arrows over them -- so the other two are
 * best read as answers to what each of these was FOR.
 */
const DARK: SceneColors = {
  bg: '#0e1013',
  accent: '#59a5ff',
  out: '#5fd68a',
  in: '#ff7a66',
  // A cool steel, a long way round the wheel from both of the above and well
  // clear of the accent's #59a5ff: over near-black it reads as a tool rather
  // than as a highlight.
  round: '#9fc3d8',
  danger: '#e0574a',
  ruler: '#ffd60a',
  // A green with more blue in it than the addition green next door, so the two
  // never read as the same mark.
  mirror: '#3ddc84',
  rulerStripe: '#20252e',
  rulerLit: '#fff3a3',
  sketchIdle: '#f0a848',
  sketchDisabled: '#5a6172',
  edgeIdle: '#2b3442',
  edgeSelected: '#7cc0ff',
  eraseEdge: '#ff9d8e',
  selected: '#b9c9e6',
  selectedEmissive: '#2a5c96',
  gridCell: '#394454',
  gridSection: '#6d829b',
  compassFace: '#e6ecf5',
  compassText: '#11151b',
  compassInk: '#0e1013',
  compassDim: 'rgba(14, 16, 19, 0.72)',
  gizmoRing: '#eceff4',
  fillLight: '#8fb4ff',
}

/**
 * Light: a drafting sheet rather than an inverted photograph.
 *
 * Everything that was "lighter than the ground" becomes "darker than it", and a
 * few things change job entirely. The compass face flips from near-white to
 * near-black, because on a pale scene a pale cube is a smudge. The gizmo ring
 * goes from the brightest thing present to one of the darkest, for the same
 * reason. The accent darkens hard: #59a5ff is a fine blue on near-black and
 * illegible over a white floor, so the selection reads at #0b63ce instead.
 *
 * The ground is deliberately NOT white. A pure white viewport blows out against
 * the grey solids the app makes, leaves the grid nothing to sit on, and glares
 * next to a console that is merely off-white -- so it is a cool paper grey with
 * the panels sitting a step lighter, which keeps the same figure-and-ground
 * relationship the dark theme has, pointing the other way.
 */
const LIGHT: SceneColors = {
  bg: '#dfe3ea',
  accent: '#0b63ce',
  out: '#0f7a42',
  in: '#c2412c',
  // The same steel taken well down, because over a pale drafting sheet the
  // dark half of the range is where a mark has to sit to be seen at all.
  round: '#3f6a82',
  danger: '#b5352a',
  ruler: '#9a6b00',
  // Taken down for the pale ground, like everything else here.
  mirror: '#0f8f57',
  rulerStripe: '#f2f5f9',
  rulerLit: '#5c3f00',
  sketchIdle: '#a35d00',
  sketchDisabled: '#98a1b0',
  edgeIdle: '#98a3b4',
  edgeSelected: '#0b63ce',
  eraseEdge: '#a8331f',
  selected: '#f2f6fd',
  selectedEmissive: '#7fb0ee',
  gridCell: '#c2cad6',
  gridSection: '#93a0b2',
  compassFace: '#39414f',
  compassText: '#eef1f6',
  compassInk: '#eef1f6',
  compassDim: 'rgba(223, 227, 234, 0.72)',
  gizmoRing: '#39414f',
  fillLight: '#ffd9b0',
}

/**
 * Cyberpunk 2077, after flejz/hass-cyberpunk-2077-theme.
 *
 * That theme is six colours: cyan #5EF6FF, dark cyan #1D4E51, dark purple
 * #140C15, dark red #4A1D1F, orange #FFA500 and red #F44638 -- with cyan as the
 * accent and what is selected, red as the primary text and every icon, and
 * orange as the primary action. All six are here doing those jobs.
 *
 * It gives three usable bright hues and this app needs four: the accent, an
 * addition, a subtraction, and a measurement that must never be mistaken for
 * part of the model. So cyan is the accent, red is subtraction and danger, and
 * orange is addition -- which leaves the ruler, and the honest fourth is the
 * game's own signature yellow #FCEE0A. It is the one value here that is not in
 * the source theme, and it is the colour anybody would name if you said
 * Cyberpunk 2077 out loud.
 *
 * The ground goes a shade below the theme's #140C15 so that panels in that exact
 * colour read as sitting ON something. Solids keep their own warm grey -- an
 * object's colour is document data, not decoration, and a theme that repainted
 * the model would be changing the thing rather than the view of it.
 */
const CYBERPUNK: SceneColors = {
  bg: '#0d070e',
  accent: '#5ef6ff',
  out: '#ffa500',
  in: '#f44638',
  // Neutral is the one thing this palette has none of: its three bright hues
  // are all spoken for, and the fourth was already spent on the ruler. So the
  // Smoother wears the theme's own dark purple lifted into the light -- a grey
  // that belongs to #140C15 rather than a grey imported from somewhere else.
  round: '#b9a5c4',
  danger: '#f44638',
  ruler: '#fcee0a',
  // The one green this palette owns: nothing else in it is anywhere near, so a
  // guide line cannot be mistaken for the orange that means material.
  mirror: '#39ff88',
  rulerStripe: '#2a1016',
  rulerLit: '#fffbc9',
  sketchIdle: '#ffa500',
  sketchDisabled: '#6e3a3c',
  edgeIdle: '#4a1d1f',
  edgeSelected: '#5ef6ff',
  eraseEdge: '#ff8f84',
  selected: '#d8f7fb',
  selectedEmissive: '#1d4e51',
  gridCell: '#3a1719',
  gridSection: '#1d4e51',
  // The cube IS the theme's cyan, labelled in black -- the one widget in the
  // app that is a solid block of the accent rather than a dark surface with the
  // accent on it. The six face shades turn one cyan into a range of them, from
  // #5ef6ff on the lit face down to #3fabb1 on the darkest, which is the whole
  // cyan family the source theme carries.
  compassFace: '#5ef6ff',
  compassText: '#000000',
  compassInk: '#0d070e',
  // Not the accent, which IS the face here and would tint cyan with cyan. A
  // step down the same hue instead, so hovering darkens the face by about
  // 1.6:1 -- the same order of change the light theme's cube makes -- while the
  // black label stays at 4.8:1 on the darkest face it can land on.
  compassDim: 'rgba(13, 7, 14, 0.72)',
  gizmoRing: '#5ef6ff',
  fillLight: '#ff5fa8',
}

/**
 * The cube's faces, lit as the scene's own key light would light them -- from
 * above, in front, and to the right.
 *
 * Constant per face rather than computed from a lamp, because the cube turns
 * WITH the world: a fixed brightness per face is exactly what a fixed light in
 * the world looks like. It costs no lights, no normals and no second guess about
 * tone mapping. In `BoxGeometry`'s material order: +X, -X, +Y, -Y, +Z, -Z.
 *
 * Here rather than in `AxisCompass` so that `ui-check` can reach it without
 * importing a renderer: the DARKEST of these is the worst case for reading a
 * label off the cube, and that is the number worth pinning.
 */
export const COMPASS_FACE_SHADE = [0.8, 0.5, 1.0, 0.44, 0.72, 0.5] as const

/** Every palette, by the theme that wears it. */
export const SCENE_THEMES: Record<Theme, SceneColors> = {
  dark: DARK,
  light: LIGHT,
  cyberpunk: CYBERPUNK,
}

/**
 * The scene values that are also a CSS custom property, against the property
 * they mirror.
 *
 * The check suite walks this against every theme rather than a hand-written
 * list, so a colour added here is guarded the moment it is added, and a theme
 * added to `THEMES` is guarded the moment it exists -- it cannot ship with a
 * console and a viewport that disagree.
 *
 * Only the six that appear on BOTH sides are here. A grid colour and a compass
 * face have no console counterpart to drift from.
 */
export const SCENE_CSS_VARS: ReadonlyArray<readonly [string, keyof SceneColors]> = [
  ['--surface-0', 'bg'],
  ['--accent', 'accent'],
  ['--out', 'out'],
  ['--in', 'in'],
  ['--round', 'round'],
  ['--danger', 'danger'],
  ['--ruler', 'ruler'],
  // The sketch outline. It reached the stylesheet when the console grew a panel
  // ABOUT a sketch -- the confirm block wears the colour of the ring it retires,
  // and a second orange picked by eye would have drifted from the scene's on the
  // first theme that changed either.
  ['--sketch', 'sketchIdle'],
]
