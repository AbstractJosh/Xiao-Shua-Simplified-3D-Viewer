import { ClipboardPanel } from './ClipboardPanel'
import { ReferencePanel } from './ReferencePanel'

/**
 * The console beside the laser cutter: the shelf, and nothing else yet.
 *
 * THE CLIPBOARD IS THE PANEL EVERY CONSOLE CARRIES, and it is here for the
 * reason it is next door on the lathe: what you have saved is YOURS rather than
 * the scene's. It survives the document being replaced, it lives outside `Doc`
 * for exactly that reason, and it is therefore the one panel that makes sense
 * wherever you happen to be working. It keeps the top slot it has on both other
 * screens, so the console reads the same on arrival whichever tab you came
 * from.
 *
 * WHAT IS NOT HERE, and why the console is short. The modelling console's other
 * four -- Solids, Shapes, Colour, Scene -- are all readouts of a document this
 * screen does not draw. And the one control this screen does have, the size of
 * the block, is in the corner over the scene rather than in here: it is a
 * number you type while watching the block change, which is the argument that
 * put the lathe's stock in the same corner. See `BlockPanel`.
 *
 * Its own component rather than `LatheConsole` with a flag, for the reason
 * those two are separate: they are different consoles that happen to share a
 * panel today, and they will share less as each screen grows.
 */
export function LaserConsole() {
  return (
    <aside className="console">
      <ClipboardPanel />
      <ReferencePanel />
    </aside>
  )
}
