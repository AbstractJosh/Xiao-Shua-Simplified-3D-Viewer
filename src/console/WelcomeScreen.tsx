import { useEffect, useRef, useState } from 'react'
import { APP_NAME } from '../appInfo'
import { useProjects } from '../store/projectStore'
import type { ProjectSummary } from '../store/projectRecord'

/**
 * THE FRONT DOOR: the app's name, and the projects you have.
 *
 * NOT AN OVERLAY, which is the first thing to know about it and the reason it
 * is not built on `ScreenOverlay` the way Help and Settings are. Those two are
 * things you open ON TOP of your work, read, and dismiss -- they have a
 * backdrop because there is something behind them worth still being able to
 * see. This is not on top of anything. When it is up there is no document, no
 * lump and no block on show, because a project has not been chosen yet; so it
 * takes the whole working area, in the same place a viewport and a console
 * would otherwise be, and the bar above it stays exactly where it was.
 *
 * WHAT THE BAR DOES WHILE IT IS UP is dim almost all of itself, and none of
 * that is written here. Export, Snap, undo, redo and the counts all ask
 * `onDocument` or `snapsHere`, and both of those now answer no at the front
 * door -- see `toolStore`. The screen tabs go quiet because there is no bench
 * to send anybody to. What stays live is Help, the cog, and Import, which is
 * the one door that makes sense to open when you have nothing yet: a file
 * arriving is how a project can begin.
 *
 * THE WAY BACK IS THE CARD, not the app's name a second time. Pressing the name
 * brings you here; the project you had open is lit in the list, and pressing it
 * puts you back at the very bench you left it at. One visible path in each
 * direction, and neither of them is a control that quietly means two things
 * depending on where you already are.
 *
 * NO PROSE ANYWHERE ON IT. No line under the title saying what a project is, no
 * sentence in the empty list explaining that you have not made one yet, no
 * `title` on a single control -- see `CLAUDE.md`. What a project holds belongs
 * in Help, which is a document; this is a chooser and is built to be used.
 */
export function WelcomeScreen() {
  const projects = useProjects((s) => s.projects)
  const loaded = useProjects((s) => s.loaded)
  const busy = useProjects((s) => s.busy)
  const openId = useProjects((s) => s.openId)
  const create = useProjects((s) => s.create)

  return (
    <div className="welcome">
      <div className="welcome-sheet">
        {/* The app's name, at the size a front door can carry it. It is the
            same wordmark as the one in the bar and deliberately not a second
            name for the app: what is being chosen below is a project, and the
            heading says whose workshop the projects are in. */}
        <h1 className="welcome-title">{APP_NAME}</h1>

        <div className="welcome-nav">
          <div className="welcome-nav-head">
            <p className="subhead">Projects</p>
            <button
              type="button"
              className="nav-btn welcome-new"
              disabled={busy}
              onClick={() => create()}
            >
              New Project
            </button>
          </div>

          {/* NOTHING IS DRAWN UNTIL THE DISK HAS ANSWERED. An empty list and a
              list that has not arrived look identical and mean opposite
              things, and telling somebody they have no projects for two frames
              -- over the twelve they actually have -- is the kind of lie that
              gets a tab closed. `loaded` is what tells them apart. */}
          {loaded && (
            <ul className="project-list">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} open={project.id === openId} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One project: what it is called, what is in it, and the four things you can do
 * to it.
 *
 * THE CARD ITSELF IS THE OPEN BUTTON, and the three small ones beside it are
 * the exceptions. That is the right way round for a chooser: opening is what
 * this list is for and it should be the whole target, while renaming, copying
 * and deleting are things you do to a row you are not choosing.
 */
function ProjectCard({ project, open }: { project: ProjectSummary; open: boolean }) {
  const busy = useProjects((s) => s.busy)
  const openProject = useProjects((s) => s.open)
  const rename = useProjects((s) => s.rename)
  const copy = useProjects((s) => s.copy)
  const remove = useProjects((s) => s.remove)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  /**
   * Whether Delete has been pressed once.
   *
   * A SECOND PRESS RATHER THAN A DIALOG, and it is the one place on this screen
   * that asks anything. Deleting a project is the only irreversible act in the
   * app -- there is no undo stack across projects and nothing to walk back to
   * -- so it cannot be a single press on a small button sitting an inch from
   * the one that opens it. A browser `confirm()` was the alternative and is
   * worse in every way that matters: it is a modal that blocks the page, it
   * cannot be styled, and it puts the app's own question in the browser's
   * voice.
   *
   * The button says `Delete?` while it is armed, so the state is visible in the
   * control rather than in a bubble somewhere, and it disarms the moment the
   * button loses focus -- an armed button nobody is looking at is a trap.
   */
  const [arming, setArming] = useState(false)

  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) return
    field.current?.select()
  }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft.trim() !== '' && draft.trim() !== project.name) rename(project.id, draft)
  }

  return (
    <li className={`project-card${open ? ' project-card-open' : ''}`}>
      {editing ? (
        <input
          ref={field}
          className="project-rename"
          value={draft}
          // The name of the field, since the row it replaces has no label of
          // its own -- the project's name IS the label everywhere else.
          aria-label="Project name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Stopped here, both of them. Escape is listened for at the window
            // in capture by the bar's panel handler, and Enter would otherwise
            // do nothing at all -- but the important one is Escape: it must
            // abandon the rename and not close something behind this screen.
            if (e.key === 'Enter') {
              e.stopPropagation()
              commit()
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(project.name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="project-choose"
          disabled={busy}
          // `aria-current`, not `aria-pressed`: a project is a place you are or
          // are not, which is the same thing the screen tabs say about benches.
          aria-current={open ? 'true' : undefined}
          onClick={() => openProject(project.id)}
        >
          <span className="project-name">{project.name}</span>
          <span className="project-meta">{describe(project, open)}</span>
        </button>
      )}

      <div className="project-actions">
        <button
          type="button"
          className="project-action"
          disabled={busy || editing}
          onClick={() => {
            setDraft(project.name)
            setEditing(true)
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="project-action"
          disabled={busy}
          onClick={() => copy(project.id)}
        >
          Copy
        </button>
        <button
          type="button"
          className={`project-action project-delete${arming ? ' project-delete-armed' : ''}`}
          disabled={busy}
          onBlur={() => setArming(false)}
          onClick={() => {
            if (!arming) {
              setArming(true)
              return
            }
            setArming(false)
            remove(project.id)
          }}
        >
          {arming ? 'Delete?' : 'Delete'}
        </button>
      </div>
    </li>
  )
}

/**
 * The line under a project's name: what is in it, and when it was last touched.
 *
 * A COUNT FOR THE SCENE AND A YES-OR-NO FOR THE OTHER TWO BENCHES, which is not
 * an inconsistency but the honest shape of the three. Twelve objects is
 * meaningfully more than two; there is no equivalent for a lathe, where a piece
 * is one piece however much has been cut away. Benches with nothing on them are
 * left out entirely rather than written as "not turned", so a card carries only
 * facts about what is there.
 */
function describe(project: ProjectSummary, open: boolean): string {
  const parts: string[] = []
  if (open) parts.push('open')
  parts.push(project.objects === 1 ? '1 object' : `${project.objects} objects`)
  if (project.turned) parts.push('turned')
  if (project.cut) parts.push('cut')
  parts.push(when(project.edited))
  return parts.join(' · ')
}

/**
 * When something happened, in the coarsest words that are still true.
 *
 * RELATIVE WHILE IT IS RECENT AND ABSOLUTE ONCE IT IS NOT. "3 minutes ago" is
 * what somebody wants to know about the project they were in this afternoon,
 * and it is useless for one they last opened in spring -- "104 days ago" is a
 * number nobody can place, where a date is. A week is where the two swap over,
 * because that is about as far back as a person counts in days.
 *
 * Rounded rather than truncated, so a project touched fifty-five seconds ago
 * does not read as having been touched no time ago at all.
 */
function when(at: number): string {
  const seconds = (Date.now() - at) / 1000
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days <= 7) return days === 1 ? 'yesterday' : `${days} days ago`
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
