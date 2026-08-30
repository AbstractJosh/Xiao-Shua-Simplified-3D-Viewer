import { NumberField } from '../console/Field'
import {
  CLAY_HEIGHT_MAX,
  CLAY_HEIGHT_MIN,
  CLAY_RADIUS_MAX,
  CLAY_RADIUS_MIN,
  DEFAULT_CLAY_HEIGHT,
  DEFAULT_CLAY_RADIUS,
  isFresh,
} from '../geometry/clay'
import { useLathe } from '../store/latheStore'
import { useTools } from '../store/toolStore'

/**
 * The lump you are turning: how tall it stands and how wide it is, in the
 * bottom-left corner of the lathe.
 *
 * OVER THE PIECE, NOT IN THE BAR, and it started in the bar so the difference
 * is worth writing down. The bar holds what is true of the whole app -- the
 * unit every length is read in, the snap rule every drag obeys -- and it is at
 * the top edge of the window, which is the wrong end of the screen from the
 * thing these two numbers describe. Typing a height and watching the piece grow
 * is one act, and it was being done with the hand and the eye a window apart.
 * In the corner, the number and the shape it changes are inches from each
 * other, which is the same argument that moved the gizmo tools out of the bar
 * and onto the scene.
 *
 * BOTTOM-LEFT, the corner the modelling screen keeps for the brush's scope
 * panel: the island opens top-left, the readout sits bottom-right, and the copy
 * button has the top-right. Same corner, same surface, same size of thing --
 * one small panel of settings over an otherwise empty stretch of viewport.
 *
 * IT SHUTS to its title strip, and the strip is what reopens it. The lathe is a
 * screen you look at as much as work on, and a panel that cannot be got out of
 * the way is one more thing standing in front of the piece -- but it is also
 * the only place the size of the lump can be set, so it opens by default rather
 * than hiding behind a corner nobody would think to press. The caret is the
 * app's own collapse idiom, the one every console section and the tool island
 * already wear, and which way it points is decided by CSS off `aria-expanded`.
 */
export function StockPanel() {
  const clay = useLathe((s) => s.clay)
  const setHeight = useLathe((s) => s.setHeight)
  const setRadius = useLathe((s) => s.setRadius)
  const centreFresh = useLathe((s) => s.centreFresh)
  const open = useTools((s) => s.stockOpen)
  const setOpen = useTools((s) => s.setStockOpen)

  return (
    <div className={`stock-panel${open ? '' : ' stock-panel-shut'}`}>
      <div className="stock-head">
        <button
          type="button"
          className="collapse-btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {/* Points right at rest and is turned by CSS, so the open state is
              written down in exactly one place. */}
          <svg className="collapse-caret" viewBox="0 0 10 10" aria-hidden>
            <path
              d="M3.2 1.6 L6.8 5 L3.2 8.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          The lump
        </button>
      </div>

      {open && (
        <div className="stock-body">
          {/* HEIGHT AND WIDTH, which is what the drawing shows: a rectangle,
              standing on the faceplate. The wall is stored as a radius, because
              that is what a solid of revolution is made of and what every
              cylinder in this app is described by -- but a radius is half of
              something you cannot see on this screen, and asking for it here
              would be asking the reader to double a number to check their own
              work. So the field is the rectangle's own width, and the halving
              happens on the way in. The same trade the unit fields make: scene
              units under the hood, the reader's own measure on the face of it. */}
          <NumberField
            unit
            label="Height"
            value={clay.height}
            min={CLAY_HEIGHT_MIN}
            max={CLAY_HEIGHT_MAX}
            step={0.01}
            resetTo={DEFAULT_CLAY_HEIGHT}
            onChange={setHeight}
          />
          <NumberField
            unit
            label="Width"
            value={clay.radius * 2}
            min={CLAY_RADIUS_MIN * 2}
            max={CLAY_RADIUS_MAX * 2}
            step={0.02}
            resetTo={DEFAULT_CLAY_RADIUS * 2}
            onChange={(width) => setRadius(width / 2)}
            tip="The wall works in to a twentieth of this, and out to twice it."
          />

          {/* The way out of a piece that has gone wrong, and the one thing on
              this screen that throws work away -- there is no undo on the
              lathe. Dead while the lump is untouched rather than hidden: a
              control that appears the first time you push the clay is one
              nobody knows is there for the one press they will want it for.

              ONE WORD. It said `Centre a fresh lump`, which described the
              mechanism -- the stock is kept and re-centred, the shaping is not
              -- and made the panel's one action the longest string in it. What
              a user is looking for at that moment is the way back, and the way
              back is called Reset everywhere else they have ever met one.

              Sentence case in the markup and uppercased by CSS, the way the
              panel's own title strip is: a screen reader says "Reset" rather
              than spelling it, and the caps stay a fact about how this app sets
              a heading rather than about what the button is named. */}
          <button
            type="button"
            className="btn stock-fresh"
            disabled={isFresh(clay)}
            onClick={centreFresh}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  )
}
