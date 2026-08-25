import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { Mesh, Raycaster } from 'three'
import { useDoc } from '../store/docStore'
import { SolidMesh } from './SolidMesh'
import { PlacingPreview, SketchOverlays } from './SketchLayer'
import { pickAnchorOnBase, pickAnchorOnSolid, pointerNdc } from './picking'

type Controls = { enabled: boolean } | null

/**
 * Drives both drag gestures from a single per-frame raycast.
 *
 * Reads the store imperatively rather than by subscription: this runs every
 * frame during a drag, and re-subscribing on each document change would remount
 * the whole loop mid-gesture.
 */
function Interaction({ solidRef }: { solidRef: React.RefObject<Mesh | null> }) {
  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new Raycaster(), [])

  useFrame(() => {
    const s = useDoc.getState()
    // Hoisted to a const so the narrowing below survives into the callback;
    // TypeScript discards it for a mutable property reference.
    const drag = s.drag
    if (drag.kind === 'idle') return

    const ndc = pointerNdc(gl.domElement)
    if (!ndc) {
      // Off-canvas: show the placement as invalid rather than sticking to the
      // last good spot, so releasing here reads as a cancel.
      if (drag.kind === 'placing') s.updatePlacing(null)
      return
    }
    raycaster.setFromCamera(ndc, camera)

    if (drag.kind === 'placing') {
      s.updatePlacing(pickAnchorOnSolid(raycaster, s.doc.base, solidRef.current))
      return
    }

    const feature = s.doc.features.find((f) => f.id === drag.id)
    if (!feature) return
    // A sketch on the base glides over the original primitive; one on derived
    // geometry has no analytic surface, so it follows the evaluated mesh.
    const anchor =
      feature.anchor.on === 'derived'
        ? pickAnchorOnSolid(raycaster, s.doc.base, solidRef.current)
        : pickAnchorOnBase(raycaster, s.doc.base)
    if (anchor) s.moveTo(anchor)
  })

  return null
}

function Scene({ controlsRef }: { controlsRef: React.RefObject<Controls> }) {
  const solidRef = useRef<Mesh | null>(null)
  const base = useDoc((s) => s.doc.base)
  const dragging = useDoc((s) => s.drag.kind !== 'idle')

  const groundY = (base.kind === 'box' ? base.size[1] / 2 : base.radius) + 0.002

  return (
    <>
      <color attach="background" args={['#0e1013']} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 9, 5]} intensity={2.1} />
      <directionalLight position={[-6, 3, -5]} intensity={0.7} color="#8fb4ff" />

      {/* Grid colours are lifted well clear of the #0e1013 background: at the
          original values the ground read as empty space. Major lines carry a
          cool cast so they separate from the warm-grey solid, and the fade is
          gentler so the plane still reads out toward the horizon. */}
      <Grid
        position={[0, -groundY, 0]}
        args={[24, 24]}
        cellSize={0.5}
        cellThickness={0.7}
        cellColor="#394454"
        sectionSize={2.5}
        sectionThickness={1.4}
        sectionColor="#6d829b"
        fadeDistance={34}
        fadeStrength={0.8}
        infiniteGrid
      />

      <SolidMesh meshRef={solidRef} />
      <SketchOverlays controlsRef={controlsRef} />
      <PlacingPreview />
      <Interaction solidRef={solidRef} />

      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enabled={!dragging}
        enableDamping
        dampingFactor={0.12}
        minDistance={1.5}
        maxDistance={24}
      />
    </>
  )
}

/** Tells the user what the current gesture will do when released. */
function DragHint() {
  const drag = useDoc((s) => s.drag)
  if (drag.kind !== 'placing') return null
  const valid = drag.anchor !== null
  return (
    <div className={`viewport-hint${valid ? '' : ' viewport-hint-bad'}`}>
      {valid ? 'Release to place the sketch' : 'Move over the object to place'}
    </div>
  )
}

export function Viewport() {
  const controlsRef = useRef<Controls>(null)
  const select = useDoc((s) => s.select)

  // The gesture ends wherever the pointer happens to be -- including outside
  // the window -- so completion is owned by a global listener, not the canvas.
  useEffect(() => {
    const finish = () => {
      const s = useDoc.getState()
      if (s.drag.kind === 'placing') s.commitPlacing()
      else if (s.drag.kind === 'moving') s.endDrag()
      if (controlsRef.current) controlsRef.current.enabled = true
    }

    const onKey = (e: KeyboardEvent) => {
      const s = useDoc.getState()
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return

      if (e.key === 'Escape') {
        s.endDrag()
        s.select(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId) {
        s.removeFeature(s.selectedId)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      }
    }

    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="viewport">
      <Canvas
        camera={{ position: [3.6, 2.9, 3.6], fov: 45, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        onPointerMissed={() => select(null)}
      >
        <Scene controlsRef={controlsRef} />
      </Canvas>
      <DragHint />
    </div>
  )
}
