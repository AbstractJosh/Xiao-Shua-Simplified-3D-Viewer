import { useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'
import type { BrushScope, BrushTool } from '../store/toolStore'

/**
 * What the armed brush is allowed to touch, over the scene rather than in a
 * panel.
 *
 * ON SCREEN THE WHOLE TIME EITHER BRUSH IS ARMED, which is the one thing that
 * makes it different from the eraser's identical-looking control. An eraser is
 * aimed once and confirmed with a button, so its scope can live in the panel
 * beside that button. A brush is aimed by pointing it, and pointing it at the
 * wrong solid is a mistake made in the same instant as the stroke -- by the
 * time you have opened a panel to check, you have already melted something. So
 * the answer sits in the corner, readable without a click.
 *
 * ONE PANEL FOR ALL THREE TOOLS, wearing whichever one is up. The setting
 * behind it is shared -- see `BrushScope` -- and three corner panels that said
 * the same thing in different words would be three things to read where there
 * is one fact. What does change is the WORDING and the COLOUR, because those
 * are how the corner says which brush is in your hand: a torch melts and wears
 * the app's red for material going away, a sculpt tool raises and wears its
 * green for material arriving, and the Smoother -- which does neither -- wears
 * the cool neutral that means exactly that. Those are the same three the ghost
 * sphere over the model is drawn in, so the two halves of "what is armed"
 * agree.
 *
 * BOTTOM-LEFT: the last free corner over the viewport. Bottom-right is the
 * selection panel's, top-right the compass's, and the tool island opens
 * top-left. It is also the corner nearest the island the tool is armed from,
 * which is where the eye already is.
 *
 * Mounted only while a brush is armed. A scope picker for a tool that is not
 * running is a control with nothing to control, and the corner goes back to
 * being scene.
 */

/** What the corner calls each brush, and what it warns has been left out. */
const WORDING: Record<
  NonNullable<BrushTool>,
  { head: string; group: string; all: string; selected: string; warn: string }
> = {
  torch: {
    head: 'Blowtorch melts',
    group: 'What the blowtorch melts',
    all: 'The blowtorch melts whatever it is pointed at.',
    selected:
      'The blowtorch melts only the objects that are selected, and passes over everything else. Click a solid to select it before you start.',
    warn: 'Nothing selected -- the torch will pass over everything.',
  },
  sculpt: {
    head: 'Sculpt raises',
    group: 'What the sculpt tool raises',
    all: 'The sculpt tool draws material onto whatever it is pointed at.',
    selected:
      'The sculpt tool draws only on the objects that are selected, and passes over everything else. Click a solid to select it before you start.',
    warn: 'Nothing selected -- the brush will pass over everything.',
  },
  smoother: {
    head: 'Smoother rounds',
    group: 'What the Smoother rounds',
    all: 'The Smoother rounds the corners of whatever it is pointed at.',
    selected:
      'The Smoother rounds only the objects that are selected, and passes over everything else. Click a solid to select it before you start.',
    warn: 'Nothing selected -- the Smoother will pass over everything.',
  },
}

export function BrushScopePanel() {
  const brushTool = useTools((s) => s.brushTool)
  const scope = useTools((s) => s.brushScope)
  const setBrushScope = useTools((s) => s.setBrushScope)
  // Only what the wording depends on. The document itself is read at the moment
  // a dab lands, so building a solid never re-renders this.
  const selectedCount = useDoc((s) => s.selectedObjectIds.length)

  if (!brushTool) return null
  const words = WORDING[brushTool]

  const scopes: { value: BrushScope; label: string; title: string }[] = [
    { value: 'all', label: 'Everything', title: words.all },
    { value: 'selected', label: 'Selected only', title: words.selected },
  ]

  return (
    <div className={`brush-scope-panel brush-scope-${brushTool}`}>
      <div className="brush-scope-head">{words.head}</div>
      <div className="seg" role="group" aria-label={words.group}>
        {scopes.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`seg-btn${scope === option.value ? ' seg-active' : ''}`}
            aria-pressed={scope === option.value}
            title={option.title}
            onClick={() => setBrushScope(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {/* Said out loud rather than left to be discovered by the tool appearing
          to do nothing. "Selected only" with an empty selection is a brush that
          passes over every solid in the scene, which looks exactly like a
          broken tool from the outside. */}
      {scope === 'selected' && selectedCount === 0 && (
        <div className="brush-scope-warn" role="status">
          {words.warn}
        </div>
      )}
    </div>
  )
}
