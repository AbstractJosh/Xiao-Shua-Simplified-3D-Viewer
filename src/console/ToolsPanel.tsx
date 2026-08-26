import { useEffect, useState } from 'react'
import type { Vec3 } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { cutPlaneNormal, useTools } from '../store/toolStore'
import { NumberField, Section, Toggle, Vec3Field } from './Field'

/** `applyCut` takes plain data; the shared solve hands back a three vector. */
function planeNormal(rotation: Vec3): Vec3 {
  const n = cutPlaneNormal(rotation)
  return [n.x, n.y, n.z]
}

function SnapTool() {
  const snap = useTools((s) => s.snap)
  const snapDistance = useTools((s) => s.snapDistance)
  const setSnap = useTools((s) => s.setSnap)
  const setSnapDistance = useTools((s) => s.setSnapDistance)

  return (
    <>
      <h3 className="subhead">Snapping</h3>

      <Toggle
        label="Snap"
        checked={snap}
        onChange={setSnap}
        hint="corners, edges and faces"
      />

      <fieldset className="tool-group" disabled={!snap}>
        <NumberField
          label="Distance"
          value={snapDistance}
          min={0.02}
          max={0.6}
          step={0.01}
          onChange={setSnapDistance}
        />
      </fieldset>

      <p className="hint">
        Catches objects as you drop and move them, sketches sliding over their own
        object, and extrusion faces you drag.
      </p>
    </>
  )
}

function CutTool() {
  const cutActive = useTools((s) => s.cutActive)
  const cutPlane = useTools((s) => s.cutPlane)
  const setCutActive = useTools((s) => s.setCutActive)
  const setCutPlane = useTools((s) => s.setCutPlane)
  const resetCutPlane = useTools((s) => s.resetCutPlane)

  // Only what the button's wording depends on: the doc itself is read at click
  // time, so building a solid never re-renders this panel.
  const selectedObjectId = useDoc((s) => s.selectedObjectId)
  const objectCount = useDoc((s) => s.doc.objects.length)

  const [status, setStatus] = useState<string | null>(null)

  const planeKey = `${cutPlane.position.join()}|${cutPlane.rotation.join()}|${cutPlane.size}`
  // The outcome describes one plane in one place. Once the gizmo moves it is a
  // claim about geometry that no longer exists, so it goes rather than lingers.
  useEffect(() => {
    setStatus(null)
  }, [planeKey])

  const cut = () => {
    const { doc, selectedObjectId: selected, applyCut } = useDoc.getState()
    const target = doc.objects.find((o) => o.id === selected)
    const targets = target ? [target.id] : doc.objects.map((o) => o.id)

    const split = applyCut(cutPlane.position, planeNormal(cutPlane.rotation), targets)
    setStatus(
      split === 0
        ? 'The plane does not pass all the way through'
        : `Split ${split} object${split === 1 ? '' : 's'}`
    )
  }

  return (
    <>
      <h3 className="subhead">Cut</h3>

      <Toggle
        label="Cut plane"
        checked={cutActive}
        onChange={(on) => {
          setStatus(null)
          setCutActive(on)
        }}
        hint="slice solids in two"
      />

      {!cutActive && (
        <p className="hint">
          Place a plane through the scene and everything it passes through is split
          into two separate objects.
        </p>
      )}

      {cutActive && (
        <>
          <Vec3Field
            label="Position"
            value={cutPlane.position}
            min={-6}
            max={6}
            step={0.05}
            onChange={(position) => setCutPlane({ position })}
          />

          {/* Radians in the store, degrees on screen: `degrees` reads min/max in
              the unit shown, so the caller converts nothing. */}
          <Vec3Field
            label="Tilt"
            value={cutPlane.rotation}
            min={-180}
            max={180}
            degrees
            onChange={(rotation) => setCutPlane({ rotation })}
          />

          {/* `applyCut` slices against an unbounded plane; the square in the
              viewport only shows where that plane lies. Naming this "Size"
              invited the reading that shrinking it would limit the cut, and it
              never did -- bounding the half-spaces instead is not an option,
              because the two halves would stop reconstructing the original. */}
          <NumberField
            label="Guide size"
            value={cutPlane.size}
            min={1}
            max={12}
            step={0.1}
            decimals={1}
            onChange={(size) => setCutPlane({ size })}
          />

          <p className="hint">
            The square is only a guide: the cut plane itself is unbounded, so it
            severs everything it passes through however small the square is.
          </p>

          <p className="hint">
            {selectedObjectId === null
              ? `Cuts every object in the scene (${objectCount}).`
              : 'Cuts the selected object. Deselect to cut the whole scene.'}
          </p>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={objectCount === 0}
              onClick={cut}
            >
              Cut
            </button>
            <button type="button" className="btn btn-ghost" onClick={resetCutPlane}>
              Reset plane
            </button>
          </div>

          {/* A plane that only grazes a solid is the common miss, and it looks
              exactly like a broken button unless the tool says so out loud. */}
          {status !== null && <p className="cut-status">{status}</p>}
        </>
      )}
    </>
  )
}

export function ToolsPanel() {
  return (
    <Section title="Tools" hint="how you work, not what you build">
      <SnapTool />
      <CutTool />
    </Section>
  )
}
