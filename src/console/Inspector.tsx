import { MIN_SHAPE, maxShapeSize } from '../geometry/dimensions'
import { depthLimits, hostSurfaceFor } from '../geometry/surfaces'
import { isCurvedAnchor, shapeRadius } from '../geometry/types'
import type { Feature, Shape2D, SurfaceAnchor } from '../geometry/types'
import { DEFAULT_FEATURE_DEPTH, selectedFeature, selectedObject, useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { NumberField, Section, Vec2Field, Vec3Field } from './Field'
import { Tip } from './Tip'

const FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z']

/**
 * Outer stop on the tilt slider, past which the control stops being a useful
 * way to lean a pillar whatever the geometry allows. It is NOT the constraint
 * that makes a tilt fail -- see `maxTiltDeg` for that -- so it can only ever
 * narrow the derived bound, never widen it.
 */
const MAX_TILT_DEG = 60

/**
 * Floor under the derived bound. A shallow feature on a wide sketch can push
 * the honest limit near zero, and a slider with no travel left is a worse
 * answer than a few degrees the user can undo.
 */
const MIN_TILT_DEG = 5

/** How far the created face may slide within its own plane, in object units. */
const MAX_SLIDE = 1.5

function anchorLabel(anchor: SurfaceAnchor): string {
  switch (anchor.on) {
    case 'box-face':
      return `Face ${FACE_NAMES[anchor.face]}`
    case 'planar-face':
      // Faces are counted from one here: the stored index is an array position
      // and nothing else in the UI exposes it, so nobody has to reconcile them.
      return `Face ${anchor.face + 1}`
    case 'sphere':
      return 'Sphere surface (curved)'
    case 'cylinder':
      return 'Cylinder wall (curved)'
    case 'cone':
      return 'Cone wall (curved)'
    case 'capsule':
      return 'Bean surface (curved)'
    case 'derived':
      return 'Feature surface'
  }
}

/**
 * Widest tilt this particular feature can be given and still build.
 *
 * The thing that breaks is not obliqueness. `buildSweptPrism` lands every ring
 * point on the tilted end plane along that point's own normal, and rejects the
 * whole tool the moment one of those travel distances stops being positive.
 * Tilting pivots the plane about the face centre, so the near side of the ring
 * gives up r*tan(tilt) of its depth and the sweep survives exactly while
 * tilt < atan(depth / shapeRadius). At the fixed 60 degrees the slider used to
 * offer, a freshly extruded feature -- depth equal to its own radius, so a real
 * limit of 45 -- had a quarter of its travel silently dropping the feature.
 *
 * Exact only for a flat host tilted about ONE axis. Two or three axes compose
 * into a larger off-normal angle this arithmetic cannot see (44 degrees on each
 * of three axes fails where 44 on one builds), which is why the `skipped` hint
 * below stays as the backstop rather than being retired in favour of this
 * number. A curved host is looser than the flat bound rather than tighter --
 * its ring normals fan out -- so it keeps the plain outer stop instead, or the
 * slider would take away reach the tool genuinely has.
 */
function maxTiltDeg(anchor: SurfaceAnchor, shape: Shape2D, depth: number): number {
  if (isCurvedAnchor(anchor)) return MAX_TILT_DEG
  const limit = (Math.atan(depth / Math.max(shapeRadius(shape), 1e-6)) * 180) / Math.PI
  // Floor, minus one: the bound has to be an angle that BUILDS, and the exact
  // limit is the angle at which travel reaches zero.
  return Math.max(MIN_TILT_DEG, Math.min(MAX_TILT_DEG, Math.floor(limit) - 1))
}

export function Inspector() {
  const object = useDoc(selectedObject)
  const feature = useDoc(selectedFeature)
  const patchFeature = useDoc((s) => s.patchFeature)
  const setDepth = useDoc((s) => s.setDepth)
  const removeFeature = useDoc((s) => s.removeFeature)
  const failed = useEvalStatus((s) => s.failed)

  if (!object || !feature) {
    return (
      <Section title="Sketch">
        <p className="empty">
          Drag a shape onto an object, then adjust it here.
        </p>
      </Section>
    )
  }

  const host = hostSurfaceFor(object.base, feature.anchor)
  // The anchor is not optional: a cylinder's cap and its wall allow different
  // depths, and without it the slider would let the cap overshoot the solid.
  // The two ends are different numbers -- a boss may stand further proud than a
  // pocket may sink -- so the slider is deliberately not symmetric about zero.
  const limit = depthLimits(host, feature.anchor)
  const depth = Math.max(-limit.in, Math.min(limit.out, feature.depth))
  // The tilt bound is about how far the pillar leans before the sweep gives
  // out, which is a question about its LENGTH; a pocket leans exactly as far as
  // a boss of the same depth.
  const tiltLimit = maxTiltDeg(feature.anchor, feature.shape, Math.abs(depth))
  const sizeLimit = maxShapeSize(object.base)
  const patch = (p: Partial<Feature>) => patchFeature(object.id, feature.id, p)
  const skipped = failed.includes(feature.id)

  return (
    <Section title="Sketch" hint={anchorLabel(feature.anchor)}>
      {feature.shape.type === 'circle' && (
        <NumberField
          label="Radius"
          value={feature.shape.r}
          min={MIN_SHAPE}
          max={sizeLimit}
          onChange={(r) => patch({ shape: { type: 'circle', r } })}
        />
      )}

      {feature.shape.type === 'rect' && (
        <>
          <NumberField
            label="Width"
            value={feature.shape.w}
            min={MIN_SHAPE}
            max={sizeLimit * 2}
            onChange={(w) =>
              patch({ shape: { ...feature.shape, type: 'rect', w } as Feature['shape'] })
            }
          />
          <NumberField
            label="Height"
            value={feature.shape.h}
            min={MIN_SHAPE}
            max={sizeLimit * 2}
            onChange={(h) =>
              patch({ shape: { ...feature.shape, type: 'rect', h } as Feature['shape'] })
            }
          />
        </>
      )}

      {feature.shape.type === 'ngon' && (
        <>
          <NumberField
            label="Radius"
            value={feature.shape.r}
            min={MIN_SHAPE}
            max={sizeLimit}
            onChange={(r) =>
              patch({ shape: { ...feature.shape, type: 'ngon', r } as Feature['shape'] })
            }
          />
          <NumberField
            label="Sides"
            value={feature.shape.sides}
            min={3}
            max={12}
            step={1}
            decimals={0}
            onChange={(sides) =>
              patch({
                shape: { ...feature.shape, type: 'ngon', sides: Math.round(sides) } as Feature['shape'],
              })
            }
          />
        </>
      )}

      <NumberField
        label="Rotation"
        value={(feature.rotation * 180) / Math.PI}
        min={0}
        max={360}
        step={1}
        decimals={0}
        resetTo={0}
        onChange={(deg) => patch({ rotation: (deg * Math.PI) / 180 })}
      />

      {/* ONE control, not two modes. Outward and inward were never two
          different operations -- they are the two ends of one sweep, and a
          feature that carried both a magnitude and a mode could say the same
          thing twice, in two ways that disagreed. The slider crosses zero,
          which is also where a pure projection sits, so the whole range from
          pocket to projection to boss is one drag. */}
      <NumberField
        label="Extrude"
        value={depth}
        min={-limit.in}
        max={limit.out}
        tip="Positive adds material, negative cuts it away, and zero leaves the sketch as a flat projection. The two ends are not the same reach: a boss may stand further proud of the surface than a pocket may sink into it. The gizmo's third arrow, the one facing away from the face, drags this same number."
        onChange={(next) => setDepth(object.id, feature.id, next)}
      />
      {feature.depth === 0 && (
        <>
          <p className="hint">
            Projection only. Move Extrude off zero -- either way -- or drag the
            arrow facing away from the surface.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setDepth(object.id, feature.id, DEFAULT_FEATURE_DEPTH)}
            >
              Extrude
            </button>
          </div>
        </>
      )}

      {/* Tilt and slide only mean anything once there is a pillar to lean, and
          a pocket has one as much as a boss does. */}
      {feature.depth !== 0 && (
        <>
          {/* Vec3Field spends .subhead on its own label, so a group heading has
              to sit a weight above it or "End face" reads as an empty field. */}
          <h3 className="section-title">
            End face
            <Tip>
              Or drag the end face itself in the viewport: the base of the
              extrusion stays put and the pillar leans to follow.
            </Tip>
          </h3>

          {/* The slider's own bound reads one axis at a time, so tilting two or
              three of them can still walk past what the sweep will accept. This
              is the backstop for exactly that case. */}
          {skipped && (
            <p className="hint">
              <span className="feature-error">skipped</span> This tilt leaves no
              room for the extrusion to sweep, so the feature is left out of the
              solid. Ease the tilt back, or raise the depth, until it returns.
            </p>
          )}

          <Vec3Field
            label="Tilt"
            resetTo={0}
            value={feature.tilt}
            min={-tiltLimit}
            max={tiltLimit}
            step={1}
            decimals={0}
            degrees
            onChange={(tilt) => patch({ tilt })}
          />

          <Vec2Field
            label="Slide"
            labels={['U', 'V']}
            value={feature.faceOffset}
            min={-MAX_SLIDE}
            max={MAX_SLIDE}
            onChange={(faceOffset) => patch({ faceOffset })}
          />

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => patch({ tilt: [0, 0, 0], faceOffset: [0, 0] })}
            >
              Reset face
            </button>
          </div>

        </>
      )}

      <button
        type="button"
        className="danger"
        onClick={() => removeFeature(object.id, feature.id)}
      >
        Delete sketch
      </button>
    </Section>
  )
}
