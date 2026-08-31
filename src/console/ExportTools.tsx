import { useState } from 'react'
import { evaluateDoc, mergedGeometry } from '../geometry/evaluate'
import { FORMAT_INFO, exportSolid } from '../geometry/exporters'
import type { ExportFormat } from '../geometry/exporters'
import type { Doc } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { onDocument, useTools } from '../store/toolStore'
import { APP_SLUG } from '../appInfo'
import { ExportIcon } from './navIcons'
import { NavTool } from './NavTool'
import { ReceiptFlyout, useReceipt } from './Receipt'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * What each format is for, on hover. The buttons are down to their extensions
 * to fit the bar, and ".glb" alone does not tell anyone which one to pick.
 */
const FORMAT_BLURB: Record<ExportFormat, string> = {
  glb: 'One binary file. Opens in Blender, Windows 3D Viewer, and most engines.',
  obj: 'Plain text geometry. Universally readable, larger, no materials.',
  stl: 'The 3D printing standard. Binary, triangles only, no units and no colour.',
  step: 'CAD interchange. A real solid -- flat faces, shared edges -- that SolidWorks, Fusion or FreeCAD can measure and cut. Curves arrive faceted, and the body measures in millimetres.',
}

/**
 * What a format is in four words: the first sentence of its blurb.
 *
 * A menu row has room to say which file to pick, where a 46px button in the bar
 * had room for an extension and nothing else -- and ".step" tells nobody which
 * of the four to reach for. Taken from the blurb rather than written out again
 * beside it, so a format's description stays one string: change the sentence
 * and the row changes with it, and there is no second copy to fall out of step.
 * The whole blurb is still there, on the row's own hover.
 */
const gist = (blurb: string): string => blurb.split('. ')[0]

/**
 * What the box starts out saying.
 *
 * A REAL VALUE RATHER THAN A PLACEHOLDER, which the automatic name below is
 * not. The two are doing different jobs: this is a name, already written, that
 * a press of Export would use as it stands -- so the panel answers "what will
 * this file be called" before anything is typed, and answers it with a word
 * rather than with a description of the scene.
 *
 * A box that starts full is normally a box you have to clear before you can use
 * it, which is the objection this used to lose to. What settles it is the
 * length: `Untitled` is one short word that a focus selects whole, so typing
 * over it costs the same gesture as typing into an empty box. The automatic
 * name never could be -- nobody reads `xiao-shuas-3d-editor-2obj-5f` to the end
 * to decide whether to keep it, let alone edits it.
 */
const DEFAULT_NAME = 'Untitled'

/**
 * What the file is called when nobody has said otherwise: the app, then what is
 * in the document.
 *
 * It is a DESCRIPTION rather than a name, which is the point of it -- three
 * exports taken while a shape is being worked on land as three different files
 * instead of three copies of one, and the counts say which is which. It is a
 * poor name for anything you meant to keep, which is what the box beside it is
 * for.
 *
 * One function because it is wanted in two places now, and they must agree: the
 * placeholder promises this name and the export has to write it.
 */
function autoBaseName(doc: Doc): string {
  const features = doc.objects.reduce((n, o) => n + o.features.length, 0)
  return `${APP_SLUG}-${doc.objects.length}obj${features ? `-${features}f` : ''}`
}

/**
 * Everything a filename may not contain, on the three platforms this app runs
 * on taken together: the Windows reserved set, the separator every system uses
 * to mean a directory, and the control codes.
 *
 * THE SEPARATORS ARE THE ONES THAT MATTER. The rest are a courtesy -- a colon
 * in a name gives an unopenable file on Windows and a fine one elsewhere -- but
 * a slash is a browser being told to write somewhere other than where the user
 * thinks, and it is the one character a text box invites by habit from anyone
 * who has ever typed a path.
 */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]+/g

/**
 * The name to write, from what was typed.
 *
 * EMPTY FALLS BACK rather than refusing, which is what makes the box optional:
 * somebody who wants a file and does not care what it is called presses a
 * format and gets one, exactly as they did before the box existed. A name that
 * is nothing but punctuation cleans down to nothing and falls back the same
 * way, so there is no way to press Export and get a file called `-`.
 *
 * EXPORTED FOR THE CHECKS, and it is the one thing in this file worth checking
 * on its own: what a text box does with a slash in it cannot be read back out
 * of the panel's markup, and the answer matters more than anything else here.
 *
 * The extension is NOT the caller's business and is not accepted here: it is
 * added by `exportSolid` from the format that was pressed, so a name typed as
 * `bracket.stl` and sent to .glb cannot come out as `bracket.stl.glb`.
 */
export function fileBase(typed: string, auto: string): string {
  const clean = typed
    .replace(UNSAFE, '-')
    // Leading dots hide a file on the Unixes; trailing dots and spaces are
    // silently dropped by Windows, which turns a name into a different one.
    // AND THE DASH THE LINE ABOVE JUST PUT THERE: a name that was nothing but
    // separators cleans down to a single `-`, and a file called `-.glb` is not
    // the fallback anyone wanted -- it is the fallback failing to happen.
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 64)
  return clean || auto
}

/**
 * Export, docked at the right of the bar beside the unit selector, undo and
 * redo, with its formats behind a menu.
 *
 * It sits there because of what it is: an act on the whole document, like the
 * two beside it, rather than a mode aimed at whatever is selected the way Snap
 * and Cut are. The formats went into a menu at the same time, and the count is
 * the reason -- two extensions fit in a bar, and four is a row of jargon
 * charging permanent width for a choice made once a session.
 *
 * The menu is an ordinary tool panel, so it closes on Escape, on a click
 * outside, and on the same store field every other panel in the bar uses. What
 * it does NOT do is close the moment a format is clicked: a STEP file takes a
 * moment to build, and the row that is busy says so where the pointer already
 * is. The panel closes when the export lands, and the receipt takes over.
 */
export function ExportTools() {
  const setOpenPanel = useTools((s) => s.setOpenPanel)
  const live = useTools(onDocument)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const receipt = useReceipt()

  /**
   * What the user has typed the file should be called, and nothing more.
   *
   * LOCAL RATHER THAN IN THE DOCUMENT, and deliberately: a name is a fact about
   * one export and not about the scene. Putting it in the document would make
   * typing it an edit -- undoable, redoable, and dirtying a file that has not
   * changed -- to say something that stops being true the moment the format
   * changes.
   *
   * It survives the panel closing and reopening, which is what a user who
   * exported a .glb and came back for the .step needs, and it does not survive a
   * reload, which is what somebody starting a new session wants. The component
   * outlives the panel because the receipt hangs off it; see the wrapper below.
   *
   * It starts at `Untitled` rather than empty -- see `DEFAULT_NAME` -- and may
   * be cleared back to empty, which is not the same state it began in: an empty
   * box exports under the automatic name, and that is what the placeholder
   * standing in it then promises.
   */
  const [name, setName] = useState(DEFAULT_NAME)

  /** Subscribed rather than read on the press, because the PLACEHOLDER shows
   *  it: a name that went stale as objects were added would promise a filename
   *  the export does not write. */
  const auto = useDoc((s) => autoBaseName(s.doc))

  const run = async (format: ExportFormat) => {
    setBusy(format)
    try {
      const doc = useDoc.getState().doc
      // Re-evaluating is free: the prefix cache returns the geometry already on
      // screen, so the file always matches exactly what the user is looking at.
      const result = evaluateDoc(doc)
      // The per-object geometries inside `result` belong to that cache and the
      // viewport is still drawing them; only this merged world-space copy is
      // ours, and it has to be released whether the export succeeded or threw.
      const geometry = mergedGeometry(doc, result)
      try {
        const r = await exportSolid(geometry, format, fileBase(name, autoBaseName(doc)))
        receipt.report(
          `${r.filename} · ${formatBytes(r.bytes)} · ` +
            // A STEP file has no triangles in it -- it has faces -- so it says
            // what it actually built instead of a count that is not in the file.
            (r.detail ?? `${r.triangles.toLocaleString()} tris`) +
            (r.welded ? '' : ' · unwelded')
        )
      } finally {
        geometry.dispose()
      }
    } catch (err) {
      receipt.fail(err, 'Export failed.')
    } finally {
      setBusy(null)
      // Whatever came of it, the choice has been made and the menu has nothing
      // left to offer. The receipt below it is the answer now.
      setOpenPanel(null)
    }
  }

  return (
    // The wrapper is what the receipt hangs from. It cannot hang from the menu,
    // which is only in the document while the menu is open, and by then the
    // export it would be reporting on has closed it.
    <div className="nav-export">
      <NavTool
        id="export"
        label="Export"
        icon={<ExportIcon />}
        // Dimmed on a screen that draws no document: a menu of four formats
        // for a scene that is not on show is four ways to write the same
        // empty file.
        disabled={!live}
        align="right"
        // Kept as the panel's name for a screen reader, and taken off the panel:
        // this one is reached by pressing a button labelled Export, so drawing
        // the word again at the top is a line of chrome saying where you already
        // knew you were. The row it stood on does not go with it -- the name box
        // below inherits it. See `bare`.
        panelTitle="Export scene"
        bare
        // ON THE HEAD ROW, not above the list, and that is the whole of why it
        // costs the panel nothing: the row exists either way to carry the close
        // cross, and with the heading gone it was empty. A field in a row of its
        // own would have made the panel taller to say the same thing.
        panelRight={
          <input
            className="export-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            // What an EMPTY box would write, which is a state this one has to
            // be cleared into rather than the state it starts in -- see
            // `DEFAULT_NAME`. Shown as what will happen rather than typed in as
            // a value, because it is a description of the scene and not a name:
            // nobody reads `xiao-shuas-3d-editor-2obj-5f` to the end to decide
            // whether to keep it. `fileBase` is the other half of the promise.
            placeholder={auto}
            aria-label="File name"
            // Taking the box means meaning to rename, so the default arrives
            // selected and the first keystroke replaces it. This is the whole
            // of what makes a pre-filled name cost no more than an empty one.
            onFocus={(event) => event.target.select()}
            spellCheck={false}
            autoComplete="off"
            // Every other press in this panel exports. Enter in a text field
            // would submit nothing and do nothing, and a key that looks like it
            // should fire the thing you just named has to either fire it or be
            // stopped from looking like it did -- there are four formats and no
            // default among them, so it cannot fire one.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
          />
        }
      >
        <ul className="export-menu">
          {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((format) => (
            <li key={format}>
              <button
                type="button"
                className="export-item"
                disabled={busy !== null}
                title={FORMAT_BLURB[format]}
                onClick={() => void run(format)}
              >
                <span className="export-ext">.{FORMAT_INFO[format].ext}</span>
                <span className="export-gist">{gist(FORMAT_BLURB[format])}</span>
                {busy === format && (
                  <span className="export-busy" aria-hidden>
                    …
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </NavTool>

      <ReceiptFlyout receipt={receipt} align="right" />
    </div>
  )
}
