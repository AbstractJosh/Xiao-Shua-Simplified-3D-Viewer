/**
 * Which palette the app wears.
 *
 * A theme is applied by writing its name to `data-theme` on the document
 * element; the stylesheet's ramps are read from there, and the scene's matching
 * palette is looked up by the same name in `sceneColors`. Adding another is a
 * name in `THEMES`, a label, a block of token overrides in `styles.css` and an
 * entry in `SCENE_THEMES` -- no component learns anything new, the selector in
 * Settings grows a button on its own, and `ui-check` starts guarding the new
 * one the moment it exists.
 *
 * A theme owns the VIEW and never the document. It repaints panels, edges, the
 * grid and the ground; it does not touch an object's own colour, which is
 * something the user set and the file records. Changing that would be editing
 * the model rather than the view of it.
 *
 * Dark is deliberately NOT written as an override block. It is what `:root`
 * already says, so the default costs nothing and the app renders correctly for
 * the instant before any script has run -- which is the flash a theme system is
 * usually bought to prevent and usually causes.
 */
export type Theme = 'dark' | 'light' | 'cyberpunk'

/** Every theme on offer, in the order the selector shows them. */
export const THEMES: Theme[] = ['dark', 'light', 'cyberpunk']

/** What each is called in the selector. */
export const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark',
  light: 'Light',
  cyberpunk: 'Cyberpunk',
}

/** The theme a first-time document opens in. */
export const DEFAULT_THEME: Theme = 'dark'

/**
 * The attribute the stylesheet keys off, named once so the component that
 * writes it and the markup that ships with it cannot disagree.
 *
 * `index.html` carries the default already, so the first paint is themed before
 * React has mounted.
 */
export const THEME_ATTRIBUTE = 'data-theme'
