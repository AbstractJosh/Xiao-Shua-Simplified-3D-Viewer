import { useState } from 'react'
import { evaluateDoc } from '../geometry/evaluate'
import { FORMAT_INFO, exportSolid } from '../geometry/exporters'
import type { ExportFormat } from '../geometry/exporters'
import { useDoc } from '../store/docStore'
import { APP_SLUG } from '../appInfo'
import { Section } from './Field'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function ExportPanel() {
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (format: ExportFormat) => {
    setBusy(format)
    setError(null)
    setStatus(null)
    try {
      const doc = useDoc.getState().doc
      // Re-evaluating is free: the prefix cache returns the geometry already on
      // screen, so the file always matches exactly what the user is looking at.
      const { geometry } = evaluateDoc(doc)
      const baseName = `${APP_SLUG}-${doc.base.kind}${doc.features.length ? `-${doc.features.length}f` : ''}`
      const r = await exportSolid(geometry, format, baseName)
      setStatus(
        `${r.filename} · ${formatBytes(r.bytes)} · ${r.triangles.toLocaleString()} tris` +
          (r.welded ? '' : ' · unwelded')
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Export" hint="downloads the solid">
      <div className="export-row">
        {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((format) => (
          <button
            key={format}
            type="button"
            className="export-btn"
            disabled={busy !== null}
            onClick={() => void run(format)}
          >
            {busy === format ? 'Exporting…' : `.${FORMAT_INFO[format].label.toLowerCase()}`}
          </button>
        ))}
      </div>
      {status && <p className="export-status">{status}</p>}
      {error && <p className="export-error">{error}</p>}
      <p className="export-note">
        Sketch overlays are not included — only the solid, welded and ready to open.
      </p>
    </Section>
  )
}
