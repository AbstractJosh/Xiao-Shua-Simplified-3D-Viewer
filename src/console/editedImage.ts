import { useEffect, useState } from 'react'
import type { RefImage } from '../store/referenceStore'
import { drawEdited } from './referenceImage'

/**
 * One edited picture, drawn once and handed to everything that wants it.
 *
 * A reference is drawn in three places at once -- the tile in the panel, the
 * preview in the editor, and the decal on the block -- and all three want the
 * SAME pixels: the picture with its flip, its turn and its crop applied. Baking
 * it three times would be three canvases per image per keystroke in the editor,
 * and the two in the panel would be a frame behind the one on the block.
 *
 * So it is baked once, keyed by the picture AND the edit on it, and kept until
 * either changes. The key is what makes the cache correct rather than merely
 * fast: an edit is a new key, so nothing has to be invalidated by hand, and the
 * old entry falls out when its image is dropped.
 */

/** What the picture and its edit come to, as one string. */
export function editKey(image: RefImage): string {
  const { flipX, flipY, turns, crop } = image.edit
  const box = crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : 'full'
  return `${image.id}|${flipX ? 'x' : ''}${flipY ? 'y' : ''}|${turns}|${box}`
}

const baked = new Map<string, string>()
const baking = new Map<string, Promise<string>>()

/** The edited picture as a data URL, drawn if this is the first ask for it. */
export function editedUrl(image: RefImage): Promise<string> {
  const key = editKey(image)
  const done = baked.get(key)
  if (done) return Promise.resolve(done)
  const already = baking.get(key)
  if (already) return already

  const work = drawEdited(image)
    .then((canvas) => {
      const url = canvas.toDataURL('image/png')
      baked.set(key, url)
      baking.delete(key)
      return url
    })
    .catch((err) => {
      baking.delete(key)
      throw err
    })
  baking.set(key, work)
  return work
}

/**
 * Everything drawn for this picture, thrown away.
 *
 * Called when an image leaves a slot. Every edit of it is dropped, not just the
 * one showing: the picture is gone, so the crop it was wearing three edits ago
 * is not coming back either.
 */
export function releaseEdited(imageId: string) {
  for (const key of [...baked.keys()]) if (key.startsWith(`${imageId}|`)) baked.delete(key)
  for (const key of [...baking.keys()]) if (key.startsWith(`${imageId}|`)) baking.delete(key)
}

/**
 * The edited picture, for a component that wants to draw it.
 *
 * Null until it is ready, which is one frame for a cached bake and a beat for a
 * fresh one. Callers draw nothing in the meantime rather than drawing the
 * unedited picture: a tile that shows the whole photograph and then snaps to
 * the crop is a flash of the wrong answer.
 *
 * The cached value is read SYNCHRONOUSLY on the first render for a key that has
 * already been baked, so switching preset back and forth does not blink.
 */
export function useEditedUrl(image: RefImage | null): string | null {
  const key = image ? editKey(image) : null
  const [url, setUrl] = useState<string | null>(() => (key ? baked.get(key) ?? null : null))

  useEffect(() => {
    if (!image || !key) {
      setUrl(null)
      return
    }
    const cached = baked.get(key)
    if (cached) {
      setUrl(cached)
      return
    }
    let live = true
    setUrl(null)
    editedUrl(image)
      .then((next) => {
        if (live) setUrl(next)
      })
      .catch(() => {
        if (live) setUrl(null)
      })
    return () => {
      live = false
    }
    // The key IS the picture and its edit; the object identity changes on every
    // store write and would re-bake for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return url
}
