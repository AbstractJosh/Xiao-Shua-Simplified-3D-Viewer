import { useEffect, useState } from 'react'

/**
 * What a finished act on the whole document says for itself afterwards.
 *
 * Export and Import both do the same thing here: run something slow, then put
 * one line on screen saying what came of it -- a filename and a size, or a
 * model and a triangle count -- and take it away again a few seconds later. The
 * hook and the bubble live together because the two halves have to agree about
 * WHEN: a flyout left up past its welcome becomes a claim about a file the user
 * exported minutes ago and has already opened.
 *
 * Shared rather than written twice. It was the same eight lines of state, the
 * same timeout and the same literal in both files, kept in step by hand -- and
 * a receipt that cleared after eight seconds on one side and stayed forever on
 * the other would be a bug nobody would think to look for.
 */

/** How long a finished act keeps its receipt on screen. */
export const RECEIPT_MS = 8000

export type Receipt = {
  status: string | null
  error: string | null
  /** It worked, and this is what it produced. */
  report: (text: string) => void
  /** It did not. Anything thrown is acceptable; the message is dug out here. */
  fail: (err: unknown, fallback: string) => void
}

export function useReceipt(): Receipt {
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status === null && error === null) return
    const timer = setTimeout(() => {
      setStatus(null)
      setError(null)
    }, RECEIPT_MS)
    return () => clearTimeout(timer)
  }, [status, error])

  return {
    status,
    error,
    // Each clears the other: the two are one line on screen, and a failure
    // showing under the receipt of the last thing that worked reads as though
    // that one failed too.
    report: (text) => {
      setError(null)
      setStatus(text)
    },
    fail: (err, fallback) => {
      setStatus(null)
      setError(err instanceof Error ? err.message : fallback)
    },
  }
}

/**
 * The bubble itself, hanging below whatever tool produced it.
 *
 * `align` is which edge it hangs from, and it is not decoration: a tool docked
 * at the right of the bar has to open leftwards or a long filename lands off
 * the edge of the window.
 */
export function ReceiptFlyout({
  receipt,
  align = 'left',
}: {
  receipt: Receipt
  align?: 'left' | 'right'
}) {
  const { status, error } = receipt
  if (status === null && error === null) return null
  return (
    <div
      className={
        `nav-flyout${align === 'right' ? ' nav-flyout-right' : ''}` +
        (error !== null ? ' nav-flyout-bad' : '')
      }
      role="status"
    >
      {status ?? error}
    </div>
  )
}
