import { useEffect, useState } from 'react'
import { evaluateDoc, mergedGeometry } from '../geometry/evaluate'
import { FORMAT_INFO, exportSolid } from '../geometry/exporters'
import type { ExportFormat } from '../geometry/exporters'
import { useDoc } from '../store/docStore'
import { APP_SLUG } from '../appInfo'
import { ExportIcon } from './navIcons'
import { Tip } from './Tip'

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
}

/**
 * Two small format buttons in the top bar. Export is a one-click act on the
 * whole scene, so it never needed the panel it used to have -- only somewhere
 * to report what it wrote, which it does in a flyout that clears itself rather
 * than in a line of text that sits there until the next export.
 */
export function ExportTools() {
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
          `${r.filename} · ${formatBytes(r.bytes)} · ${r.triangles.toLocaleString()} tris` +
            (r.welded ? '' : ' · unwelded')
        )
      } finally {
        geometry.dispose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="nav-export">
      <span className="nav-export-head">
        <span className="nav-icon" aria-hidden>
          <ExportIcon />
        </span>
        <span className="nav-label">Export</span>
        <Tip>
          Downloads every object in the scene, baked into world space, welded and
          ready to open. Sketch overlays are not included.
        </Tip>
      </span>

      {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((format) => (
        <button
          key={format}
          type="button"
          className="export-btn"
          disabled={busy !== null}
          title={FORMAT_BLURB[format]}
          onClick={() => void run(format)}
        >
          {busy === format ? '…' : `.${FORMAT_INFO[format].label.toLowerCase()}`}
        </button>
      ))}

      {(status !== null || error !== null) && (
        <div className={`nav-flyout${error !== null ? ' nav-flyout-bad' : ''}`} role="status">
          {status ?? error}
        </div>
      )}
    </div>
  )
}
