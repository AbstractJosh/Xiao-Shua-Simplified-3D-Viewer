/**
 * Renders a standalone, interactive preview of the console's two palettes.
 *
 * It embeds the app's real stylesheet, calls the app's real `ngonPoints`, and
 * server-renders the app's real solid icons, so what it shows is what the
 * console shows -- no hand-drawn mockup that can drift from the components.
 *
 * Run: npx tsx scripts/palette-preview.ts [outputFile]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NGON_NAMES, NGON_SIDES, NGON_SIDES_TOP_DOWN, ngonPoints } from '../src/console/ngon'
import { SOLID_TEMPLATES } from '../src/console/solidIcons'
import { defaultBaseFor, solidLabel } from '../src/geometry/types'
import { APP_NAME } from '../src/appInfo'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8')
const outFile = resolve(process.argv[2] ?? join(process.cwd(), 'palette-preview.html'))
mkdirSync(dirname(outFile), { recursive: true })

const icon = (inner: string) =>
  `<svg viewBox="0 0 32 32" class="chip-icon" aria-hidden><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${inner}</g></svg>`

const simpleChip = (label: string, inner: string) => `
  <button type="button" class="chip">
    <div class="chip-face">${icon(inner)}<span>${label}</span></div>
  </button>`

/** Mirrors NgonChip's DOM exactly. */
const ngonChip = (id: string, initial: number) => `
  <div class="chip chip-ngon" id="${id}">
    <div class="chip-face">
      ${icon(`<polygon points="${ngonPoints(initial)}" />`)}
      <span>${NGON_NAMES[initial]}</span>
    </div>
    <div class="ngon-bands">
      ${NGON_SIDES_TOP_DOWN.map(
        (n) =>
          `<button type="button" class="ngon-band" data-sides="${n}" aria-label="${NGON_NAMES[n]}, ${n} sides"></button>`
      ).join('\n      ')}
    </div>
  </div>`

/**
 * One Solids row, matching SolidPalette's DOM. The icons come out of the real
 * component through the server renderer rather than being redrawn here, and the
 * row's name comes from `solidLabel` -- so a prism row says "Hexagonal prism"
 * because that is what the geometry layer would name the object it drops.
 */
const solidRows = SOLID_TEMPLATES.map((t) => {
  // The resting side count is read back out of the geometry layer, exactly as
  // SolidPalette's own `defaultSidesFor` does, so the lit chip is the one a
  // plain drag would actually produce.
  const plain = defaultBaseFor(t.kind)
  const sides = 'sides' in plain ? plain.sides : undefined
  const name = solidLabel(defaultBaseFor(t.kind, sides, t.platonic))
  const glyphs = renderToStaticMarkup(createElement('g', null, t.icon))
  const chips = t.sides
    ? `<span class="solid-item-sides">${t.sides
        .map(
          (n) =>
            `<button type="button" class="solid-side${n === sides ? ' solid-side-active' : ''}">${n}</button>`
        )
        .join('')}</span>`
    : ''
  return `
    <div class="solid-item" role="button" tabindex="0" title="Drag into the scene to place a ${name}">
      <svg viewBox="0 0 32 32" class="solid-item-icon" aria-hidden><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${glyphs}</g></svg>
      <span class="solid-item-label">${name}</span>
      ${chips}
    </div>`
}).join('')

const solidPalette = `<div class="solid-list">${solidRows}</div>`

const palette = `
  <div class="palette">
    ${simpleChip('Circle', '<circle cx="16" cy="16" r="12" />')}
    ${simpleChip('Rectangle', '<rect x="4" y="6" width="24" height="20" rx="1.5" />')}
    ${ngonChip('live', 6)}
  </div>`

// One chip per band, frozen in that state, annotated by position.
const states = NGON_SIDES.map((n, i) => {
  const fromBottom = i + 1
  return `
    <figure class="state">
      <div class="chip chip-ngon state-chip">
        <div class="chip-face">
          ${icon(`<polygon points="${ngonPoints(n)}" />`)}
          <span>${NGON_NAMES[n]}</span>
        </div>
        <div class="ngon-bands">
          ${NGON_SIDES_TOP_DOWN.map(
            (m) => `<div class="ngon-band${m === n ? ' band-lit' : ''}"></div>`
          ).join('')}
        </div>
      </div>
      <figcaption>band ${fromBottom} from bottom<br /><b>${n} sides</b></figcaption>
    </figure>`
}).join('')

const script = `
document.querySelectorAll('.chip-ngon:not(.state-chip)').forEach(function (chip) {
  var poly = chip.querySelector('polygon');
  var label = chip.querySelector('.chip-face span');
  var names = ${JSON.stringify(NGON_NAMES)};
  var pts = ${JSON.stringify(
    Object.fromEntries(NGON_SIDES.map((n) => [n, ngonPoints(n)]))
  )};
  var resting = 6;
  chip.querySelectorAll('.ngon-band').forEach(function (band) {
    var n = band.getAttribute('data-sides');
    band.addEventListener('mouseenter', function () {
      poly.setAttribute('points', pts[n]);
      label.textContent = names[n];
    });
    band.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      resting = n;
      chip.classList.add('picked');
      setTimeout(function () { chip.classList.remove('picked'); }, 220);
    });
  });
  chip.addEventListener('mouseleave', function () {
    poly.setAttribute('points', pts[resting]);
    label.textContent = names[resting];
  });
});`

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${APP_NAME} palette preview</title>
<style>
${css}

/* --- preview scaffolding, not part of the app --- */
body { overflow: auto; padding: 26px; }
.preview-h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; letter-spacing: .02em; }
.preview-sub { color: var(--muted); font-size: 12px; margin: 0 0 22px; line-height: 1.5; }
.preview-h2 {
  font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase;
  color: var(--muted); margin: 30px 0 12px;
}
.console-mock {
  width: 372px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 9px; overflow: hidden;
}
.console-mock .section { border-bottom: 0; }
.states { display: flex; gap: 14px; flex-wrap: wrap; }
.state { margin: 0; width: 108px; }
.state-chip { cursor: default; }
.state figcaption {
  margin-top: 8px; text-align: center; color: var(--muted);
  font-size: 10.5px; line-height: 1.5;
}
.state figcaption b { color: var(--text); font-weight: 600; }
/* Preview only: shows WHERE each band sits. Invisible in the real app. */
.band-lit { background: color-mix(in srgb, var(--accent) 20%, transparent); }
.chip-ngon.picked { border-color: var(--out); }
.legend {
  margin-top: 26px; padding: 11px 13px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 7px;
  color: var(--muted); font-size: 12px; line-height: 1.6; max-width: 640px;
}
.legend b { color: var(--text); }
</style>
</head>
<body>
  <p class="preview-h1">Console palettes</p>
  <p class="preview-sub">
    Live preview using the app's own stylesheet, solid icons and polygon
    geometry. Hover across the polygon chip to try the bands.
  </p>

  <p class="preview-h2">As it appears in the console</p>
  <div class="console-mock">
    <section class="section">
      <h2 class="section-title">Solids<span class="section-hint">drag into the scene</span></h2>
      ${solidPalette}
    </section>
    <section class="section">
      <h2 class="section-title">Shapes<span class="section-hint">drag onto any object</span></h2>
      ${palette}
    </section>
  </div>

  <p class="preview-h2">One state per band &mdash; 3 at the bottom, 10 at the top</p>
  <div class="states">${states}</div>

  <p class="legend">
    <b>Bands are invisible in the app.</b> The blue strip above only marks where each
    one sits. In use, the band under the pointer is felt through the icon and label
    changing &mdash; hover the live chip at the top to see it.
  </p>

  <script>${script}</script>
</body>
</html>`

writeFileSync(outFile, html, 'utf8')
console.log(`Wrote ${outFile}`)
console.log(
  `  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB - ${SOLID_TEMPLATES.length} solids - ` +
    `bands top-down: ${NGON_SIDES_TOP_DOWN.join(', ')}`
)
