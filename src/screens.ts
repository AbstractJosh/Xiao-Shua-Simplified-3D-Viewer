/**
 * The SCREENS the app can be showing: one viewport, and the console that drives
 * it.
 *
 * A screen is a whole working surface rather than a mode. Each one owns its own
 * viewport and its own console, and the two consoles are not obliged to hold
 * the same panels -- Lathe's carries the Clipboard and nothing else, because
 * what you have saved is yours wherever you are working, and everything else in
 * the modelling console describes a scene Lathe does not draw.
 *
 * Plain data, and no React in it, for the reason `theme.ts` and `helpTopics.tsx`
 * have none: the tool store holds which screen is up, the check suite reads
 * this table headlessly, and neither may drag a canvas along to do it. WHICH
 * COMPONENTS a screen mounts is the one thing not written here -- that lives in
 * `App.tsx`, the file that mounts them, keyed off `ScreenId` so a screen added
 * here cannot be forgotten there.
 */

export type ScreenId = 'modelling' | 'lathe'

/** In the order the bar offers them, left to right. */
export const SCREENS: readonly ScreenId[] = ['modelling', 'lathe']

export const SCREEN_LABELS: Record<ScreenId, string> = {
  modelling: 'Modelling',
  lathe: 'Lathe',
}

/**
 * What the app opens in, and the one screen that has ever existed.
 *
 * It is called MODELLING rather than "Default", which is what it was first
 * named: "default" says where the app starts and nothing whatever about what
 * the screen is for, and the moment there is a second screen the interesting
 * question is which of them does what. Every other screen will be named for its
 * job, and this one is no exception just because it happens to be first.
 */
export const DEFAULT_SCREEN: ScreenId = 'modelling'

/**
 * Whether this screen works on the DOCUMENT.
 *
 * The bar keeps everything that acts on the document open at all times --
 * Import, Export, Snap, undo, redo, the counts -- and on a screen that draws no
 * document not one of them means anything. They are dimmed rather than taken
 * away, so the bar keeps its shape between screens and a control that is
 * momentarily inapplicable does not read as a feature that has gone missing.
 *
 * A flag here rather than `screen === 'lathe'` written into six controls: the
 * question each of them is asking is "is there a document on screen", and the
 * day a third screen arrives it answers for that one too.
 */
export const SCREEN_HAS_DOCUMENT: Record<ScreenId, boolean> = {
  modelling: true,
  lathe: false,
}

