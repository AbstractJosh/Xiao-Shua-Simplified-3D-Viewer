import { NumberField } from '../console/Field'
import { BLOCK_MAX, BLOCK_MIN, DEFAULT_BLOCK, isDefaultBlock, useLaser } from '../store/laserStore'
import { useReference } from '../store/referenceStore'
import { useTools } from '../store/toolStore'

/**
 * How big the block is, in the bottom-left corner of the laser cutter.
 *
 * THE SAME PANEL THE LATHE PUTS ITS LUMP IN, down to the class names, and that
 * is the point rather than a shortcut. Both screens have exactly one piece of
 * stock, in exactly one corner, and it is set by typing a number while watching
 * the shape it changes -- so it is one control, worn by two screens, and a
 * second stylesheet block describing the same 232px panel is how the two
 * corners quietly stop matching. See `StockPanel`, which was here first.
 *
 * THREE FIELDS, because stock is not a cube. It started as one -- one Side,
 * with the argument that three numbers kept equal are three ways to stop a cube
 * being one -- and that argument was about the wrong thing: what is on the bed
 * of a cutter is a sheet, a bar or a block, and the shape of it is the first
 * decision of the job rather than a way of spoiling a cube. Each side is set on
 * its own, and a cube is what you get by typing the same number three times.
 *
 * TWO RESETS, WHERE THE LATHE HAS ONE, and the pair is the point. This screen
 * carries two things at once: a block that gets cut, and a set of drawings
 * stuck to it that are not part of it at all -- the thing you are working ON
 * and the thing you are working FROM. So "start again" is two questions, and
 * one button answering both would be a button nobody could press in confidence:
 * throwing away an hour of cuts to clear a drawing, or losing the drawings to
 * get a fresh block, are each the wrong half of what was wanted.
 *
 * Each says exactly what it takes, and neither touches the other's. The
 * references come off the block and stay in the panel, so the shelf is never
 * emptied by a button on this panel -- that is the bin on each tile, one panel
 * away, where a picture is thrown away deliberately.
 *
 * DEAD WHEN THERE IS NOTHING TO DO, rather than hidden: a control that appears
 * only once you have made a mess is one nobody knows about for the one press
 * they will want it for. The lathe's Reset strikes the same bargain.
 *
 * The field arrows are not the same thing and stay: one of them puts one SIDE
 * back to ten centimetres, which is a correction rather than a way out.
 */
export function BlockPanel() {
  const dims = useLaser((s) => s.dims)
  const setDim = useLaser((s) => s.setDim)
  const resetBlock = useLaser((s) => s.resetBlock)
  // Selected rather than computed from the pieces here, so the button and the
  // action that refuses agree by construction -- see `isDefaultBlock`.
  const blockIsDefault = useLaser(isDefaultBlock)
  const clearPlacements = useReference((s) => s.clearPlacements)
  // EVERY preset's, not just the one in hand: that is what the button clears,
  // so it is what decides whether there is anything to clear.
  const anyPlacements = useReference((s) => s.placements.length > 0)
  // Shared with the lathe's panel, and shared on purpose: see `stockOpen`.
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
          The block
        </button>
      </div>

      {open && (
        <div className="stock-body">
          {/* THREE ROWS, ONE PER AXIS, and named for the directions rather than
              for the axes: nobody buys stock in x. They are in the order a
              sheet is described in -- across, up, back -- which is also the
              order the axes run in, so the two readings agree.

              NO LINK BUTTON. A cube is three equal numbers and typing the same
              one three times is the cost of it; a chain that kept them equal
              would be a fourth control whose only job is to stop the other
              three doing what they say. */}
          <NumberField
            unit
            label="Width"
            value={dims[0]}
            min={BLOCK_MIN}
            max={BLOCK_MAX}
            step={0.01}
            resetTo={DEFAULT_BLOCK}
            onChange={(v) => setDim(0, v)}
            tip="Across the bed. The block grows about its own footprint, and the camera stays where it is -- so a bigger block really does look bigger."
          />
          <NumberField
            unit
            label="Height"
            value={dims[1]}
            min={BLOCK_MIN}
            max={BLOCK_MAX}
            step={0.01}
            resetTo={DEFAULT_BLOCK}
            onChange={(v) => setDim(1, v)}
            tip="Up from the bed. The block stands on the ground, so height is the one side that grows in one direction only."
          />
          <NumberField
            unit
            label="Depth"
            value={dims[2]}
            min={BLOCK_MIN}
            max={BLOCK_MAX}
            step={0.01}
            resetTo={DEFAULT_BLOCK}
            onChange={(v) => setDim(2, v)}
            tip="Back into the bed. Cuts already made are carried with it: the block is scaled, never re-cut."
          />

          {/* THE TWO WAYS BACK, and each one names what it takes. Sentence case
              in the markup and uppercased by CSS, the way the lathe's Reset and
              this panel's own title strip are: a reader says the words rather
              than spelling them out.

              The block's is undoable, because it throws away cutting and
              Ctrl+Z is what walks cuts on this screen -- it gives back the
              stock's size along with them. The references' is not: nothing
              about a reference has ever been in that history, and the way back
              is to drag the picture out of the panel again, which is the same
              gesture that put it there. */}
          <button
            type="button"
            className="btn stock-fresh"
            disabled={blockIsDefault}
            title="Puts the stock back to one uncut ten-centimetre block. Ctrl+Z gives back the cuts and the size together. References are left alone."
            onClick={resetBlock}
          >
            Reset block
          </button>
          <button
            type="button"
            className="btn stock-fresh"
            disabled={!anyPlacements}
            title="Takes every drawing off the block, in every preset. The pictures stay in the Reference panel to be dropped on again."
            onClick={clearPlacements}
          >
            Reset references
          </button>
        </div>
      )}
    </div>
  )
}
