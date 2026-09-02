/**
 * THE PROJECTS: which ones exist, which one is open, and the disk underneath
 * them.
 *
 * WHY WORK IS STORED HERE AND NOT IN `persist.ts`, which is the file that
 * stores everything else. That file restores what it holds SILENTLY, on every
 * load, over whatever is on screen -- which is the right way to hand back a
 * theme and a brush size and the wrong way to hand back a half-finished model.
 * Work has to be asked for by name, off a screen that shows what is being asked
 * for, and has to be nameable, copyable and deletable. That is a different
 * contract, so it is a different file. What the two share is the heaviest thing
 * either of them keeps -- the imported models -- and neither may delete one on
 * its own. See `meshVault.ts`.
 *
 * SAVING IS AUTOMATIC AND A COPY IS NOT, which is the whole shape of the thing.
 * The open project is written whenever the workshop changes, debounced, the way
 * the shelf is: there is no Save button, nothing to forget, and a refresh in
 * the middle of an afternoon loses nothing. What is manual is the SNAPSHOT --
 * `copy`, on the Welcome screen -- because forking a project is a decision
 * about a moment, and no amount of autosaving can guess which moment somebody
 * wanted to keep.
 *
 * TWO SHELVES AGAIN, AND FOR A NEW REASON. The summaries live together under
 * one key; each project's record lives under a key of its own. The front door
 * lists every project the user has, and if listing them meant reading them,
 * opening the app would drag every cut bed and every imported model in the
 * workshop off the disk to print a few names and dates. Nothing heavy is read
 * until somebody asks for one project by name.
 */
import { create } from 'zustand'
import { meshEntry } from '../geometry/meshLibrary'
import { DEFAULT_SCREEN } from '../screens'
import { meshTickets } from './checked'
import { idbDelete, idbGet, idbPut } from './idb'
import { claimMeshes, expectClaim, keepMeshes, loadMeshes, sweepMeshes } from './meshVault'
import {
  applyProject,
  blankBenches,
  captureProject,
  projectFrom,
  summaryFrom,
  summaryOf,
} from './projectRecord'
import type { Project, ProjectSummary } from './projectRecord'
import { useDoc } from './docStore'
import { useLathe } from './latheStore'
import { useLaser } from './laserStore'
import { useTools } from './toolStore'

/**
 * The keys, both versioned for the reason everything stored by this app is: the
 * shapes under them are still changing, and yesterday's read as today's is the
 * one failure that must never happen. The index and the records carry the same
 * number and move together -- an index that survived a bump would list projects
 * whose records had all just been retired.
 */
const INDEX_KEY = 'projects.1'
const RECORD_PREFIX = 'project.1.'
const recordKey = (id: string): string => RECORD_PREFIX + id

/**
 * This file's name at the mesh vault. Announced at import time, before any load
 * can finish, so a shelf that loads quickly cannot sweep away a model that only
 * a project -- still loading -- is standing on. See `meshVault.ts`.
 */
const PROJECT_CLAIM = 'projects'
expectClaim(PROJECT_CLAIM)

/**
 * How long the workshop has to go quiet before it is written.
 *
 * LONGER THAN THE SHELF'S 300ms, because what is being written is bigger by
 * orders of magnitude -- a cut bed is every triangle on it -- and because the
 * things that dirty it come in storms: a brush stroke is a hundred store
 * updates in a second and means one save, not a hundred. Short enough that a
 * user who edits and immediately closes the tab is covered by the flush on
 * `pagehide` rather than by luck.
 */
const SAVE_DELAY = 700

let counter = 0
const nextProjectId = (): string => `pj-${Date.now().toString(36)}-${(counter += 1).toString(36)}`

/**
 * A name for a project nobody has named.
 *
 * NUMBERED FROM WHAT IS FREE rather than from how many there are: delete
 * Project 2 of three and the next one is Project 2 again, which is what
 * somebody looking at the list expects, where "Project 4" beside a list of two
 * is a number that has to be explained.
 */
function freshName(existing: readonly ProjectSummary[]): string {
  const taken = new Set(existing.map((p) => p.name))
  for (let n = 1; ; n += 1) {
    const name = `Project ${n}`
    if (!taken.has(name)) return name
  }
}

/** Newest work first. What the navigator shows, and the order it is stored in,
 *  so the two cannot disagree about which project is the recent one. */
function byRecent(summaries: ProjectSummary[]): ProjectSummary[] {
  return [...summaries].sort((a, b) => b.edited - a.edited)
}

export type ProjectState = {
  /** Every project the user has, most recently edited first. */
  projects: ProjectSummary[]
  /**
   * Which project the three benches are currently holding, or null for none.
   *
   * NULL IS A REAL STATE and not a transient one: a first-ever visit has no
   * projects, and the front door is where the app stays until one is made. It
   * is also what the bar reads to know there is nothing to go back to -- the
   * screen tabs have nowhere to send anybody with no project open.
   */
  openId: string | null
  /**
   * Whether the index has been read off the disk yet.
   *
   * The navigator draws nothing until it has. An empty list and a list that has
   * not arrived look identical and mean opposite things, and drawing "no
   * projects" over somebody's twelve projects for two frames is the kind of
   * lie that makes a person close the tab.
   */
  loaded: boolean
  /**
   * True while a project is being opened or made.
   *
   * Two jobs, and the second is the load-bearing one. It dims the navigator, so
   * a second press during a slow read cannot start a second open on top of the
   * first -- and it SUPPRESSES THE AUTOSAVE, so the store writes that put a
   * project onto the benches are not mistaken for edits and written straight
   * back out. Without it, opening project A would schedule a save of project A
   * over itself, which is harmless, and opening B while A's save was still in
   * flight would not be.
   */
  busy: boolean

  /** Make a project, blank the benches, and open it. */
  create: (name?: string) => void
  /** Put a stored project back on the benches. */
  open: (id: string) => void
  /** Leave the benches as they are and go to the front door. */
  goHome: () => void
  /** Come back to the bench the open project was last worked at. */
  resumeWork: () => void
  rename: (id: string, name: string) => void
  /** Fork a project under a new name: the manual snapshot. */
  copy: (id: string) => void
  remove: (id: string) => void
}

export const useProjects = create<ProjectState>((set, get) => ({
  projects: [],
  openId: null,
  loaded: false,
  busy: false,

  create: (name) => {
    if (get().busy) return
    // THE LAST EDIT TO THE PROJECT YOU ARE LEAVING, first. A save waits 700ms
    // for the hand to stop, so an edit made and then abandoned for the New
    // Project button inside that window had a timer still pending -- and by the
    // time it fired, `openId` was the NEW project and the benches were blank,
    // so it wrote an empty workshop into the wrong record and the edit was
    // gone. Flushing here spends the pending timer while the old project is
    // still the open one and its work is still on the benches.
    save.flush()
    set({ busy: true })

    // BLANKED, THEN AIMED, THEN PHOTOGRAPHED, in that order. What is stored has
    // to be an empty workshop rather than whatever the last project left lying
    // about -- and the bench is set before the capture because a project
    // remembers which bench it was at, and a new one has been at exactly one:
    // the modelling screen, which is where the app puts you to start.
    blankBenches()
    useTools.setState({ screen: DEFAULT_SCREEN, atWelcome: false, openPanel: null })

    const now = Date.now()
    const project = captureProject({
      id: nextProjectId(),
      name: name?.trim() || freshName(get().projects),
      created: now,
      edited: now,
    })

    set({
      projects: byRecent([...get().projects, summaryOf(project)]),
      openId: project.id,
      busy: false,
    })

    void (async () => {
      // Written straight away rather than left to the autosave: a project that
      // existed only in memory would be gone on a refresh, which is the one
      // thing this whole file exists to prevent.
      await store(project)
      await writeIndex(get().projects)
    })()
  },

  open: (id) => {
    const { busy, openId, projects } = get()
    if (busy) return
    // Already on the benches: this is the card of the project you are in, and
    // pressing it means "take me back to it" rather than "read it again". Going
    // back to the disk here would throw away everything done since the last
    // save landed.
    if (openId === id) {
      get().resumeWork()
      return
    }
    if (!projects.some((p) => p.id === id)) return

    // Whatever is still pending for the project being left. See `create`.
    save.flush()
    set({ busy: true })
    void (async () => {
      let project: Project | null = null
      try {
        project = projectFrom(await idbGet<unknown>(recordKey(id)))
      } catch {
        project = null
      }
      if (!project) {
        // The index says it exists and the disk says otherwise. The row is the
        // thing that is wrong, so the row goes -- a card that does nothing when
        // pressed is worse than one that is not there.
        set({ busy: false })
        forget(set, get, id)
        return
      }

      // THE MODELS FIRST, then the objects that ticket them, then whatever
      // could not be made whole is dropped. Same order and same bargain as the
      // shelf: a solid standing on a model that did not come back is left out
      // rather than restored as a ticket to nothing, because one is a scene
      // with a gap in it and the other is a scene that throws when it is drawn.
      await loadMeshes(project.meshIds)
      const whole = project.doc.objects.filter((object) => {
        const tickets = new Set<string>()
        meshTickets(object, tickets)
        for (const ticket of tickets) if (!meshEntry(ticket)) return false
        return true
      })
      const opened: Project = { ...project, doc: { objects: whole } }

      // The id goes down BEFORE the benches are written, so that the store
      // updates `applyProject` causes are already attributable to this project.
      // `busy` is what stops them being written back out; it is cleared last.
      set({ openId: id })
      applyProject(opened)
      useTools.setState({ screen: opened.screen, atWelcome: false, openPanel: null })
      set({ busy: false })
    })()
  },

  goHome: () => useTools.getState().setAtWelcome(true),

  resumeWork: () => {
    if (get().openId === null) return
    useTools.getState().setAtWelcome(false)
  },

  rename: (id, name) => {
    const clean = name.trim()
    if (clean === '') return
    const edited = Date.now()
    set((s) => ({
      projects: byRecent(
        s.projects.map((p) => (p.id === id ? { ...p, name: clean, edited } : p))
      ),
    }))
    void writeIndex(get().projects)
    // The record carries the name too -- it is what a project IS called, and
    // the index is a picture of the records rather than the other way round. A
    // rename that only touched the index would be undone the next time the
    // project was opened and saved.
    void restamp(id, (project) => ({ ...project, name: clean, edited }))
  },

  copy: (id) => {
    const { busy, openId, projects } = get()
    if (busy) return
    const from = projects.find((p) => p.id === id)
    if (!from) return

    set({ busy: true })
    void (async () => {
      const now = Date.now()
      const identity = {
        id: nextProjectId(),
        name: copyName(from.name, projects),
        created: now,
        edited: now,
      }

      // THE OPEN PROJECT IS COPIED FROM THE BENCHES, not from the disk, and
      // that is the whole point of the snapshot. What is on the disk is
      // whatever the last debounced save wrote, which may be most of a second
      // behind the hand; "save a copy" has to mean the workshop as it stands at
      // the moment of the press, or it is a copy of a slightly earlier project.
      let project: Project | null =
        openId === id ? captureProject(identity) : null

      if (!project) {
        try {
          const stored = projectFrom(await idbGet<unknown>(recordKey(id)))
          project = stored ? { ...stored, ...identity } : null
        } catch {
          project = null
        }
      }
      if (!project) {
        set({ busy: false })
        return
      }

      const forked = project
      await store(forked)
      set((s) => ({ projects: byRecent([...s.projects, summaryOf(forked)]), busy: false }))
      await writeIndex(get().projects)
      await reclaim(get().projects)
    })()
  },

  remove: (id) => {
    const wasOpen = get().openId === id
    // NOT FLUSHED, unlike `create` and `open`, and the difference is the point.
    // Spending the pending save here would write the record a moment before
    // deleting it, and the two writes are on different chains -- so the delete
    // could land first and leave the project on the disk after all. Letting the
    // timer fire is safe instead, because `openId` goes null on the very next
    // line: a save that wakes to find no project open writes nothing.
    // Let go of it BEFORE the benches are cleared. Clearing them is a store
    // write like any other, so an autosave scheduled by it would otherwise find
    // a project still open and write an empty workshop into the record that is
    // being deleted -- a race the user would never see and could never explain.
    if (wasOpen) set({ openId: null })
    forget(set, get, id)
    if (!wasOpen) return
    // The project that was on the benches has gone, so the benches go with it.
    // Left as they were, the app would be holding a workshop that belongs to
    // nothing.
    blankBenches()
    useTools.setState({ atWelcome: true, openPanel: null })
  },
}))

/**
 * What a fork is called: the name it came from, with a number if that is taken.
 *
 * "Vase copy", then "Vase copy 2". Not "Copy of Vase", because a list sorted or
 * scanned by eye reads down its first few characters, and a shelf of things all
 * beginning "Copy of" tells you nothing until the fourth word.
 */
function copyName(from: string, existing: readonly ProjectSummary[]): string {
  const taken = new Set(existing.map((p) => p.name))
  const base = `${from} copy`
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`
    if (!taken.has(name)) return name
  }
}

// --- The disk ----------------------------------------------------------------

/** Writes serialised behind one promise, so two quick saves cannot interleave
 *  and leave the earlier one on top. The shelf does the same. */
let writing: Promise<void> = Promise.resolve()

/**
 * Stores one project, models first.
 *
 * IF A MODEL WILL NOT FIT, THE SOLIDS STANDING ON IT ARE DROPPED -- never one
 * without the other, or the next open would restore a ticket to nothing. What
 * is kept is the rest of the scene, the lathe and the bed, which is most of
 * what most projects hold. It is the same bargain the shelf strikes, made here
 * against a scene rather than against a row of saved customs.
 */
async function store(project: Project): Promise<void> {
  const heavy = await keepMeshes(project.meshIds)
  const record: Project = heavy
    ? project
    : {
        ...project,
        meshIds: [],
        doc: {
          objects: project.doc.objects.filter((object) => {
            const tickets = new Set<string>()
            meshTickets(object, tickets)
            return tickets.size === 0
          }),
        },
      }
  try {
    await idbPut(recordKey(record.id), record)
  } catch {
    // Nothing further to try: the light record is already the light one, and a
    // project that will not fit at all is a project the user still has on the
    // benches in front of them. Leaving whatever was stored before in place is
    // the least wrong answer -- it is older work, not wrong work.
  }
}

/** The index, rewritten whole. It is a few dozen short strings and numbers, so
 *  there is nothing to be gained by patching it in place and a whole class of
 *  disagreement to be avoided by not trying. */
async function writeIndex(projects: ProjectSummary[]): Promise<void> {
  try {
    await idbPut(INDEX_KEY, { version: 1, projects })
  } catch {
    /* A full disk. The projects themselves are down; the list of them will be
       rebuilt from this same call the next time anything changes. */
  }
}

/** Reads one stored project, edits it, and writes it back. For the changes that
 *  are about a project rather than about the work in it -- a rename -- where
 *  reading the whole record is still cheaper than keeping a second copy of the
 *  name that could drift from the first. */
async function restamp(id: string, edit: (project: Project) => Project): Promise<void> {
  try {
    const project = projectFrom(await idbGet<unknown>(recordKey(id)))
    if (!project) return
    await idbPut(recordKey(id), edit(project))
  } catch {
    /* The index still carries the new name, and the next save of an open
       project writes the record whole. */
  }
}

/** Tells the vault what every project between them is standing on. Called after
 *  anything that changes the set of projects or what one of them holds. */
async function reclaim(projects: readonly ProjectSummary[]): Promise<void> {
  const wanted = new Set<string>()
  for (const project of projects) for (const id of project.meshIds) wanted.add(id)
  claimMeshes(PROJECT_CLAIM, [...wanted])
  await sweepMeshes().catch(() => undefined)
}

/** Drops a project from the list and from the disk. Used both by the Delete
 *  button and by an open that found the record gone. */
function forget(
  set: (partial: Partial<ProjectState>) => void,
  get: () => ProjectState,
  id: string
): void {
  set({ projects: get().projects.filter((p) => p.id !== id) })
  void (async () => {
    await idbDelete(recordKey(id)).catch(() => undefined)
    await writeIndex(get().projects)
    // Now that nothing points at them, whatever models this project alone was
    // standing on can go. The vault is what knows whether "alone" is true.
    await reclaim(get().projects)
  })()
}

// --- Autosave ----------------------------------------------------------------

/**
 * A save that waits for the hand to stop moving. The shelf's own, written again
 * rather than shared, because the two lanes must not be able to cancel each
 * other's timers.
 */
function debounced(ms: number, run: () => void): { poke: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    poke: () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        run()
      }, ms)
    },
    flush: () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      run()
    },
  }
}

/** Writes the open project, if there is one and the app is not in the middle of
 *  putting one on the benches. */
function saveOpen(): void {
  const { openId, busy, projects } = useProjects.getState()
  if (openId === null || busy) return
  const summary = projects.find((p) => p.id === openId)
  if (!summary) return

  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const project = captureProject({
        id: summary.id,
        name: summary.name,
        created: summary.created,
        edited: Date.now(),
      })
      await store(project)
      // The index follows the record, so a crash between the two leaves a
      // project whose card is a moment stale rather than a card describing
      // something that was never written.
      const next = byRecent(
        useProjects.getState().projects.map((p) => (p.id === project.id ? summaryOf(project) : p))
      )
      useProjects.setState({ projects: next })
      await writeIndex(next)
      await reclaim(next)
    })
}

let started = false

/**
 * Reads the projects back and decides where the app opens. ONE CALL, from
 * `main.tsx`, after `remember`.
 *
 * AFTER, deliberately. The preferences half of `remember` is synchronous and
 * carries `openTo`, which is the very question this function exists to answer;
 * reading the projects first would mean deciding where to open before knowing
 * where the user asked to open.
 *
 * NOTHING HERE BLOCKS THE FIRST PAINT. The app comes up at the front door
 * because that is the store's own initial state -- see `atWelcome` -- so a slow
 * disk shows an empty navigator that fills in, rather than a blank window. The
 * one visible consequence is that `openTo: 'recent'` walks through to the bench
 * a moment after the window appears, which is the honest picture of what is
 * happening.
 */
export function resume(): void {
  if (started) return
  started = true

  if (typeof window !== 'undefined') {
    // A refresh does not wait for a timer, and this is the lane where that
    // matters most: what is pending here is the user's work, not a brush size.
    window.addEventListener('pagehide', () => save.flush())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save.flush()
    })
  }

  void idbGet<unknown>(INDEX_KEY)
    .then((raw) => {
      const stored = raw as { version?: unknown; projects?: unknown } | undefined
      const projects =
        stored && stored.version === 1 && Array.isArray(stored.projects)
          ? byRecent(
              stored.projects
                .map(summaryFrom)
                .filter((p): p is ProjectSummary => p !== undefined)
            )
          : []
      useProjects.setState({ projects, loaded: true })
      return projects
    })
    .catch(() => {
      useProjects.setState({ loaded: true })
      return [] as ProjectSummary[]
    })
    .then(async (projects) => {
      // The claim goes in whether or not anything was found: an empty claim is
      // still a claim, and the vault sweeps nothing until every claimant has
      // made one. See `meshVault.ts`.
      await reclaim(projects)

      // WHERE THE APP OPENS. `recent` walks straight through to the most
      // recently edited project; with none stored there is nothing to walk to,
      // so it stays at the front door, which is also what a first-ever visit
      // sees. `open` does the rest -- including putting the user back at the
      // bench that project was last worked at.
      if (useTools.getState().openTo === 'recent' && projects.length > 0) {
        useProjects.getState().open(projects[0].id)
      }
    })
    .then(() => {
      // SUBSCRIBED LAST, once the decision above has been made. Subscribing
      // earlier would have the restore's own store writes looking exactly like
      // edits, and the first thing the app did on every load would be to save
      // what it had just read.
      useDoc.subscribe(poke)
      useLathe.subscribe(poke)
      useLaser.subscribe(poke)
      // The tool store too, for the one field of it a project keeps. It fires
      // far more often than the other three put together -- every slider, every
      // panel -- and every one of those comparisons ends in "nothing a project
      // holds has changed" and writes nothing. See `signature`.
      useTools.subscribe(poke)
    })
}

const save = debounced(SAVE_DELAY, saveOpen)

/**
 * WHAT COUNTS AS AN EDIT, stated as seven values.
 *
 * Subscribing to these stores outright would save on things no project holds:
 * `drag` changes on every pointer move of a gizmo, `stroke` on every dab of a
 * brush, and the tool store changes on every pixel of a dragged slider. Each of
 * those would schedule a write of a workshop that has not changed. Comparing
 * what is actually STORED -- by identity, which is exact because every one of
 * these is replaced rather than mutated -- means a drag across the scene writes
 * once, when it lands, instead of sixty times on the way.
 *
 * The laser's `dims` is in the list for a reason worth naming: resizing the
 * block leaves every piece on it untouched, so a bed compared by its pieces
 * alone would call a resized block unchanged and the new size would be lost on
 * the next load.
 *
 * AND `screen`, WHICH IS THE ONE ENTRY THAT IS NOT WORK. A project remembers
 * which bench it was last at, and until this was here that was only true by
 * accident: switching to the Lathe is not an edit to anything, so nothing
 * scheduled a save, and the bench was recorded only if you happened to change
 * some geometry afterwards. Open a project, cross to the Lathe, refresh, and
 * you came back to Modelling -- the one thing the app had promised to remember
 * about where you were. It is `screen` alone and not the tool store, so the
 * hundred other things in there still write nothing.
 */
function signature(): unknown[] {
  const laser = useLaser.getState()
  return [
    useDoc.getState().doc,
    useLathe.getState().clay,
    laser.pieces,
    laser.dims,
    laser.offcut,
    laser.choices,
    useTools.getState().screen,
  ]
}

let last = signature()

function poke(): void {
  const now = signature()
  const changed = now.some((value, i) => value !== last[i])
  last = now
  if (changed) save.poke()
}
