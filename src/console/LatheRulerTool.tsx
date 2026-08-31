import { useLathe } from '../store/latheStore'
import { useTools } from '../store/toolStore'
import { latheRulerLength } from '../viewport/latheRuler'
import { formatLength } from '../units'
import { NavTool } from './NavTool'
import { RulerIcon } from './navIcons'

/**
 * MEASURE: how far it is from there to there, on the piece in front of you.
 *
 * The modelling screen's Ruler, on the island over the clay. It is the same
 * tool in every sense a user cares about -- the same icon, the same button that
 * both engages it and lays the first one down, the same list behind the caret
 * saying what each one reads with a cross to take it away -- and none of the
 * machinery underneath survived the crossing. See `LatheRulers` for what
 * replaced the gizmo and `latheRuler.ts` for what an end catches.
 *
 * WHY A LATHE NEEDS ONE AT ALL, given the readout in the corner already says
 * how tall the piece is and how wide. Because those are the piece's OUTSIDE
 * dimensions and nothing else: they cannot tell you how wide the neck came out,
 * how far the foot stands proud of the waist, how thick the wall is where you
 * bored it, or how high up the belly is. Every one of those is two points on a
 * section, which is exactly what this tool is for and what the drawing has been
 * showing all along without a way to interrogate it.
 *
 * BELOW THE RULE, with Hollow, and it belongs there for a plainer reason than
 * Hollow does: it is the one thing on this island that does not touch the clay
 * at all. Push, Pull and Smooth move material and Hollow decides how much is
 * left; this changes nothing whatever about the piece, which is also why it is
 * out of the undo history -- see `Ruler` in the tool store, where the modelling
 * ruler makes the same argument.
 */
export function LatheRulerTool() {
  const active = useTools((s) => s.latheRulerActive)
  const rulers = useTools((s) => s.latheRulers)
  const selected = useTools((s) => s.selectedLatheRuler)
  const displayUnit = useTools((s) => s.displayUnit)
  const setActive = useTools((s) => s.setLatheRulerActive)
  const addRuler = useTools((s) => s.addLatheRuler)
  const removeRuler = useTools((s) => s.removeLatheRuler)
  const selectRuler = useTools((s) => s.selectLatheRuler)

  // Read at the press rather than subscribed to, exactly as the modelling
  // ruler reads the camera: where a ruler lands is only ever a question at the
  // instant one is laid down, and a hook on the clay would re-render this
  // button on every frame of every stroke to answer it.
  const clay = () => useLathe.getState().clay

  return (
    <NavTool
      id="lathe-ruler"
      label="Ruler"
      icon={<RulerIcon />}
      active={active}
      onToggle={(on) => setActive(on, clay())}
      panelTitle="Rulers"
    >
      <div className="tool-group">
        <button type="button" className="nav-action" onClick={() => addRuler(clay())}>
          Add ruler
        </button>

        {rulers.length === 0 ? (
          // Said out loud rather than left as an empty box: the list is also
          // the answer to "where did my ruler go", and a blank panel does not
          // distinguish "none" from "not loaded".
          <p className="nav-note ruler-empty">No rulers yet.</p>
        ) : (
          <ul className="ruler-list">
            {rulers.map((ruler, i) => {
              const chosen = selected === ruler.id
              return (
                <li key={ruler.id} className={`ruler-row${chosen ? ' ruler-row-on' : ''}`}>
                  {/* Pressing a row lights the ruler rather than moving
                      anything, which is the whole of what a selection does on
                      this screen: both ends are grabbed by pressing them, so
                      there is no handle for a row to fetch back. What it gets
                      you is the stripes -- and the Delete key. */}
                  <button
                    type="button"
                    className="ruler-pick"
                    aria-pressed={chosen}
                    onClick={() => selectRuler(chosen ? null : ruler.id)}
                  >
                    <span className="ruler-name">{`Ruler ${i + 1}`}</span>
                    <span className="ruler-reading">
                      {formatLength(latheRulerLength(ruler), displayUnit)}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="ruler-remove"
                    title={`Delete ruler ${i + 1}`}
                    aria-label={`Delete ruler ${i + 1}`}
                    onClick={() => removeRuler(ruler.id)}
                  >
                    <svg viewBox="0 0 10 10" aria-hidden>
                      <path
                        d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </NavTool>
  )
}
