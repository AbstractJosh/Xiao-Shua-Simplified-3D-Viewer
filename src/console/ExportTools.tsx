import { useEffect, useState } from 'react'
import { evaluateDoc, mergedGeometry } from '../geometry/evaluate'
import { FORMAT_INFO, exportSolid } from '../geometry/exporters'
import type { ExportFormat } from '../geometry/exporters'
import { useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'
import { APP_SLUG } from '../appInfo'
import { ExportIcon } from './navIcons'
import { NavTool } from './NavTool'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** How long a finished export keeps its receipt on screen. */
const RECEIPT_MS = 8000

/**
 * What each format is for, on hover. The buttons are down to their extensions
 * to fit the bar, and ".glb" alone does not tell anyone which one to pick.
 */
const FORMAT_BLURB: Record<ExportFormat, string> = {
  glb: 'One binary file. Opens in Blender, Windows 3D Viewer, and most engines.',
  obj: 'Plain text geometry. Universally readable, larger, no materials.',
  stl: 'The 3D printing standard. Binary, triangles only, no units and no colour.',
  step: 'CAD interchange. A real solid -- flat faces, shared edges -- that SolidWorks, Fusion or FreeCAD can measure and cut. Curves arrive faceted, and one scene unit is one millimetre.',
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
 * Export, docked at the right of the bar beside undo and redo, with its formats
 * behind a menu.
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
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A receipt is worth reading once. Left up, it becomes a claim about a file
  // the user exported minutes ago and has probably already opened.
  useEffect(() => {
    if (status === null && error === null) return
    const timer = setTimeout(() => {
      setStatus(null)
      setError(null)
    }, RECEIPT_MS)
    return () => clearTimeout(timer)
  }, [status, error])

  const run = async (format: ExportFormat) => {
    setBusy(format)
    setError(null)
    setStatus(null)
    try {
      const doc = useDoc.getState().doc
      // Re-evaluating is free: the prefix cache returns the geometry already on
      // screen, so the file always matches exactly what the user is looking at.
      const result = evaluateDoc(doc)
      // The per-object geometries inside `result` belong to that cache and the
      // viewport is still drawing them; only this merged world-space copy is
      // ours, and it has to be released whether the export succeeded or threw.
      const geometry = mergedGeometry(doc, result)
      const features = doc.objects.reduce((n, o) => n + o.features.length, 0)
      const baseName = `${APP_SLUG}-${doc.objects.length}obj${features ? `-${features}f` : ''}`
      try {
        const r = await exportSolid(geometry, format, baseName)
        setStatus(
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
      setError(err instanceof Error ? err.message : 'Export failed.')
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
        align="right"
        panelTitle="Export scene"
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

      {(status !== null || error !== null) && (
        <div
          className={`nav-flyout nav-flyout-right${error !== null ? ' nav-flyout-bad' : ''}`}
          role="status"
        >
          {status ?? error}
        </div>
      )}
    </div>
  )
}
