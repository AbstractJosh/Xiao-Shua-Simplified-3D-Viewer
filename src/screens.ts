/**
 * The SCREENS the app can be showing: one viewport, and the console that drives
 * it.
 *
 * A screen is a whole working surface rather than a mode. Each one owns its own
 * viewport and its own console, and the two consoles are not obliged to hold
 * the same panels -- the Clipboard is on all three, because what you have saved
 * is yours wherever you are working, and everything else in the modelling
 * console describes a scene the other two do not draw.
 *
 * Plain data, and no React in it, for the reason `theme.ts` and `helpTopics.tsx`
 * have none: the tool store holds which screen is up, the check suite reads
 * this table headlessly, and neither may drag a canvas along to do it. WHICH
 * COMPONENTS a screen mounts is the one thing not written here -- that lives in
 * `App.tsx`, the file that mounts them, keyed off `ScreenId` so a screen added
 * here cannot be forgotten there.
 */

export type ScreenId = 'modelling' | 'lathe' | 'laser'

/** In the order the bar offers them, left to right. */
export const SCREENS: readonly ScreenId[] = ['modelling', 'lathe', 'laser']

/**
 * What each tab says.
 *
 * Two words for the laser cutter where the others take one, because it is the
 * name of a MACHINE rather than of an activity: "Laser" alone is the beam, and
 * the screen is the whole bench it is mounted over. The bar can carry it -- the
 * tabs are the one part of the left-hand side that never has to make room for
 * anything -- and shortening the name of a thing to fit a control is how a
 * control ends up naming something that does not exist.
 */
export const SCREEN_LABELS: Record<ScreenId, string> = {
  modelling: 'Modelling',
  lathe: 'Lathe',
  laser: 'Laser Cutter',
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
 * day a third screen arrived it answered for that one too -- which is exactly
 * what happened when the laser cutter turned up, and not one of the six
 * controls had to be touched.
 */
export const SCREEN_HAS_DOCUMENT: Record<ScreenId, boolean> = {
  modelling: true,
  lathe: false,
  // A block of stock is not a document: there is nothing to select, nothing to
  // import into and nothing an export would have to say. It reaches the
  // modelling screen the way the lathe's piece does, through the Clipboard.
  laser: false,
}

/**
 * Whether anything on this screen SNAPS.
 *
 * A second table rather than a second reading of the first, because the two
 * questions came apart. Snap used to be one of the six controls that meant
 * nothing without a document, and it was dimmed on the strength of that -- but
 * what Snap governs is a DRAG landing on something worth landing on, and a
 * drag does not need a document to be worth aiming. The laser cutter has one:
 * the knots of a Point Cut, which line up with each other.
 *
 * WHAT IS SHARED IS THE SWITCH AND NOT THE DISTANCE. Whether you are working
 * with snapping on is one preference and follows you between screens; how near
 * is near is a fact about what is being aimed at, and the three screens are not
 * aiming at the same kind of thing at all -- one catches the corner of a solid
 * somewhere in a room, at a length in the world, and the other two line a mark
 * up with something on the same flat drawing, at a distance on the screen. One
 * number for all of them would be a number that could only ever suit one. See
 * `snapDistance`, `laserSnapDistance` and `latheSnapDistance` in `toolStore`.
 */
export const SCREEN_SNAPS: Record<ScreenId, boolean> = {
  modelling: true,
  // THE LATHE USED TO ANSWER NO, on the reasoning that the profile is a wall
  // pushed about by a brush and there are no two marks to line up. That was
  // true of the tools that SHAPE the piece and stayed true when a tool arrived
  // that measures it: a ruler's end catches the wall, the axis, the rim and the
  // plate, and every one of those is an edge worth landing exactly on rather
  // than a pixel away from. See `latheRuler.ts`.
  lathe: true,
  laser: true,
}

