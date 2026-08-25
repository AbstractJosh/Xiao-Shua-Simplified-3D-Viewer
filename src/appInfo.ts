/**
 * Single source of truth for the app's identity.
 *
 * Everything that names the app -- the wordmark, export filenames, the object
 * name written into exported models, console tags -- reads from here, so a
 * rename is one edit rather than a hunt through thirteen files.
 *
 * Two places necessarily repeat these strings and must be updated alongside:
 *   - index.html  <title>, which paints before any script runs
 *   - package.json "name", which must be a valid npm identifier
 */

export const APP_NAME = "Xiao Shua's 3D Viewer"

export const APP_TAGLINE = 'drop a shape, push or pull it'

/** Filename-safe form. Also the npm package name. */
export const APP_SLUG = 'xiao-shuas-3d-viewer'

/** Short prefix for console output. */
export const LOG_TAG = 'XiaoShua3D'

/** Object name written into exported GLB / OBJ files. */
export const EXPORT_MODEL_NAME = 'XiaoShua3D_Model'
