import { NumberField } from '../console/Field'
import { Tip } from '../console/Tip'
import { DETENT } from '../geometry/faceMirror'
import type { MirrorMode } from '../geometry/faceMirror'
import type { FaceAxis } from '../geometry/laserCut'
import { mirrorOn, useTools } from '../store/toolStore'

/**
 * What the mirror is doing: one line or a cross, and at what angle. Standing in
 * the bottom-left corner of the laser cutter for as long as an axis is standing
 * on the face.
 *
 * WHY IT IS NOT IN THE TOOL'S OWN PANEL, which is where a caret on the island
 * would put it. It is the same reason `CutPanel` gives, and here it is even
 * sharper: an island panel shuts on any pointerdown outside the island, and
 * EVERY gesture this tool has is a press on the scene -- swinging the line,
 * picking a part. A flyout would be shut by the first thing you did with the
 * tool it belongs to, every time. So Symmetry has no island panel at all and
 * these two controls stand on their own out here.
 *
 * IT OUTLIVES THE TOOL, and that is the difference from `CutPanel` below it.
 * That one comes and goes with a cutter in hand, because with empty hands there
 * is no line to apply. The axis is not in anybody's hand -- it stands on the
 * face and goes on reflecting cuts while a cutter is held -- so what this panel
 * follows is the AXIS. Switch a mirror to a cross halfway through a run of cuts
 * without putting the cutter down: that is the point of it being here.
 *
 * IT DOES NOT SAY WHICH PART IS LIT, and it should not. That is written on the
 * face, in the one place it means anything: three quarters washed out and one
 * left clear. A row of four buttons named "second quadrant" over here would be
 * a worse copy of something already on screen.
 */

/** The two kinds of mirror, in the app's own idiom for a two-way choice: both
 *  named, one lit, so the alternative says what it is rather than being left to
 *  be inferred from an empty box. */
const KINDS: ReadonlyArray<{ mode: MirrorMode; label: string }> = [
  { mode: 'line', label: 'Line' },
  { mode: 'cross', label: 'Cross' },
]

const KIND_TIP =
  'A line cuts the face in two and reflects what you draw across it. A cross is two lines at a right angle, cutting the face into four, and what you draw appears in all four -- reflected either way about and turned half round. Switching between them keeps the angle you have set.'

const ANGLE_TIP = `Which way the mirror lies, in degrees, measured across the face. It holds at every ${DETENT} degrees while Snap is on in the bar -- how near it has to come before it holds is the angle under Snap there -- and goes anywhere you put it otherwise. The part you are working in turns with it.`

export function SymmetryPanel({ face }: { face: FaceAxis }) {
  const mirror = useTools(mirrorOn(face))
  const aimMirror = useTools((s) => s.aimMirror)

  // No axis, no panel: the corner goes back to being scene, exactly as it does
  // when the cutter is put down.
  if (!mirror) return null

  return (
    <div className="cut-panel">
      {/* Named the way its neighbours are, because the three are one shelf: the
          mirror, the cut you are taking out of the block, and the block. */}
      <div className="stock-head">Symmetry</div>

      <div className="tool-group">
        <div className="field">
          <div className="field-head">
            <span className="field-label">Mirror</span>
            <Tip>{KIND_TIP}</Tip>
          </div>
          <div className="seg" role="group" aria-label="Mirror kind">
            {KINDS.map((kind) => (
              <button
                key={kind.mode}
                type="button"
                className={`seg-btn${mirror.mode === kind.mode ? ' seg-active' : ''}`}
                aria-pressed={mirror.mode === kind.mode}
                onClick={() => aimMirror(face, { mode: kind.mode })}
              >
                {kind.label}
              </button>
            ))}
          </div>
        </div>

        {/* THE ANGLE IS HERE AS WELL AS ON THE FACE, which is not a duplicate:
            the line is how you aim it and this is how you READ it. Swinging by
            hand cannot tell you that you landed on 45 rather than 44, and a
            piece that has to match a drawing needs the number. It is also the
            only way to reach an angle with the tool put down. */}
        <NumberField
          label="Angle"
          value={mirror.angle}
          min={0}
          max={180}
          step={1}
          decimals={0}
          tip={ANGLE_TIP}
          onChange={(angle) => aimMirror(face, { angle })}
        />
      </div>
    </div>
  )
}
