import { sampledChecksum } from "@opencode-ai/util/encode"
import {
  DEFAULT_VIRTUAL_FILE_METRICS,
  type ExpansionDirections,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  File as PierreFile,
  type FileDiffOptions,
  FileDiff,
  type FileOptions,
  type LineAnnotation,
  type SelectedLineRange,
  type VirtualFileMetrics,
  VirtualizedFile,
  VirtualizedFileDiff,
  Virtualizer,
} from "@pierre/diffs"
import { type PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { createMediaQuery } from "@solid-primitives/media"
import { ComponentProps, createEffect, createMemo, createSignal, onCleanup, onMount, Show, splitProps } from "solid-js"
import { createDefaultOptions, styleVariables } from "../pierre"
import { markCommentedDiffLines, markCommentedFileLines } from "../pierre/commented-lines"
import { fixDiffSelection, findDiffSide, type DiffSelectionSide } from "../pierre/diff-selection"
import { createFileFind, type FileFindReveal } from "../pierre/file-find"
import {
  applyViewerScheme,
  clearReadyWatcher,
  createReadyWatcher,
  getViewerHost,
  getViewerRoot,
  notifyShadowReady,
  observeViewerScheme,
} from "../pierre/file-runtime"
import {
  findCodeSelectionSide,
  findDiffLineNumber,
  findElement,
  findFileLineNumber,
  readShadowLineSelection,
} from "../pierre/file-selection"
import { createLineNumberSelectionBridge, restoreShadowTextSelection } from "../pierre/selection-bridge"
import { acquireVirtualizer, virtualMetrics } from "../pierre/virtualizer"
import { getWorkerPool } from "../pierre/worker"
import { FileMedia, type FileMediaOptions } from "./file-media"
import { FileSearchBar } from "./file-search"
import { getSharedHighlighter } from "@pierre/diffs"

const VIRTUALIZE_BYTES = 500_000

const codeMetrics = {
  ...DEFAULT_VIRTUAL_FILE_METRICS,
  lineHeight: 24,
  fileGap: 0,
} satisfies Partial<VirtualFileMetrics>

type SharedProps<T> = {
  annotations?: LineAnnotation<T>[] | DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
  media?: FileMediaOptions
  search?: FileSearchControl
}

export type FileSearchReveal = FileFindReveal

export type FileSearchHandle = {
  focus: () => void
  setQuery: (value: string) => void
  clear: () => void
  reveal: (hit: FileSearchReveal) => boolean
  expand: (hit: FileSearchReveal) => boolean
  refresh: () => void
}

export type FileSearchControl = {
  shortcuts?: "global" | "disabled"
  showBar?: boolean
  disableVirtualization?: boolean
  register: (handle: FileSearchHandle | null) => void
}

export type TextFileProps<T = {}> = FileOptions<T> &
  SharedProps<T> & {
    mode: "text"
    file: FileContents
    annotations?: LineAnnotation<T>[]
    preloadedDiff?: PreloadMultiFileDiffResult<T>
  }

export type DiffFileProps<T = {}> = FileDiffOptions<T> &
  SharedProps<T> & {
    mode: "diff"
    before: FileContents
    after: FileContents
    annotations?: DiffLineAnnotation<T>[]
    preloadedDiff?: PreloadMultiFileDiffResult<T>
  }

export type FileProps<T = {}> = TextFileProps<T> | DiffFileProps<T>

const sharedKeys = [
  "mode",
  "media",
  "class",
  "classList",
  "annotations",
  "selectedLines",
  "commentedLines",
  "search",
  "onLineSelected",
  "onLineSelectionEnd",
  "onLineNumberSelectionEnd",
  "onRendered",
  "preloadedDiff",
] as const

const textKeys = ["file", ...sharedKeys] as const
const diffKeys = ["before", "after", ...sharedKeys] as const

function expansionForHit(diff: FileDiffMetadata, hit: FileSearchReveal) {
  if (diff.isPartial || diff.hunks.length === 0) return

  const side =
    hit.side === "deletions"
      ? {
          start: (hunk: FileDiffMetadata["hunks"][number]) => hunk.deletionStart,
          count: (hunk: FileDiffMetadata["hunks"][number]) => hunk.deletionCount,
        }
      : {
          start: (hunk: FileDiffMetadata["hunks"][number]) => hunk.additionStart,
          count: (hunk: FileDiffMetadata["hunks"][number]) => hunk.additionCount,
        }

  for (let i = 0; i < diff.hunks.length; i++) {
    const hunk = diff.hunks[i]
    const start = side.start(hunk)
    if (hit.line < start) {
      return {
        index: i,
        direction: i === 0 ? "down" : "both",
      } satisfies { index: number; direction: ExpansionDirections }
    }

    const end = start + Math.max(side.count(hunk) - 1, -1)
    if (hit.line <= end) return
  }

  return {
    index: diff.hunks.length,
    direction: "up",
  } satisfies { index: number; direction: ExpansionDirections }
}

// ---------------------------------------------------------------------------
// Shared viewer hook
// ---------------------------------------------------------------------------

type MouseHit = {
  line: number | undefined
  numberColumn: boolean
  side?: DiffSelectionSide
}

type ViewerConfig = {
  enableLineSelection: () => boolean
  search: () => FileSearchControl | undefined
  selectedLines: () => SelectedLineRange | null | undefined
  commentedLines: () => SelectedLineRange[]
  onLineSelectionEnd: (range: SelectedLineRange | null) => void

  // mode-specific callbacks
  lineFromMouseEvent: (event: MouseEvent) => MouseHit
  setSelectedLines: (range: SelectedLineRange | null, preserve?: { root: ShadowRoot; text: Range }) => void
  updateSelection: (preserveTextSelection: boolean) => void
  buildDragSelection: () => SelectedLineRange | undefined
  buildClickSelection: () => SelectedLineRange | undefined
  onDragStart: (hit: MouseHit) => void
  onDragMove: (hit: MouseHit) => void
  onDragReset: () => void
  markCommented: (root: ShadowRoot, ranges: SelectedLineRange[]) => void
}

function useFileViewer(config: ViewerConfig) {
  let wrapper!: HTMLDivElement
  let container!: HTMLDivElement
  let overlay!: HTMLDivElement
  let selectionFrame: number | undefined
  let dragFrame: number | undefined
  let dragStart: number | undefined
  let dragEnd: number | undefined
  let dragMoved = false
  let lastSelection: SelectedLineRange | null = null
  let pendingSelectionEnd = false

  const ready = createReadyWatcher()
  const bridge = createLineNumberSelectionBridge()
  const [rendered, setRendered] = createSignal(0)

  const getRoot = () => getViewerRoot(container)
  const getHost = () => getViewerHost(container)

  const find = createFileFind({
    wrapper: () => wrapper,
    overlay: () => overlay,
    getRoot,
    shortcuts: config.search()?.shortcuts,
  })

  // -- selection scheduling --

  const scheduleSelectionUpdate = () => {
    if (selectionFrame !== undefined) return
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = undefined
      const finishing = pendingSelectionEnd
      config.updateSelection(finishing)
      if (!pendingSelectionEnd) return
      pendingSelectionEnd = false
      config.onLineSelectionEnd(lastSelection)
    })
  }

  const scheduleDragUpdate = () => {
    if (dragFrame !== undefined) return
    dragFrame = requestAnimationFrame(() => {
      dragFrame = undefined
      const selected = config.buildDragSelection()
      if (selected) config.setSelectedLines(selected)
    })
  }

  // -- mouse handlers --

  const handleMouseDown = (event: MouseEvent) => {
    if (!config.enableLineSelection()) return
    if (event.button !== 0) return

    const hit = config.lineFromMouseEvent(event)
    if (hit.numberColumn) {
      bridge.begin(true, hit.line)
      return
    }
    if (hit.line === undefined) return

    bridge.begin(false, hit.line)
    dragStart = hit.line
    dragEnd = hit.line
    dragMoved = false
    config.onDragStart(hit)
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!config.enableLineSelection()) return

    const hit = config.lineFromMouseEvent(event)
    if (bridge.track(event.buttons, hit.line)) return
    if (dragStart === undefined) return

    if ((event.buttons & 1) === 0) {
      dragStart = undefined
      dragEnd = undefined
      dragMoved = false
      config.onDragReset()
      bridge.finish()
      return
    }

    if (hit.line === undefined) return
    dragEnd = hit.line
    dragMoved = true
    config.onDragMove(hit)
    scheduleDragUpdate()
  }

  const handleMouseUp = () => {
    if (!config.enableLineSelection()) return
    if (bridge.finish() === "numbers") return
    if (dragStart === undefined) return

    if (!dragMoved) {
      pendingSelectionEnd = false
      const selected = config.buildClickSelection()
      if (selected) config.setSelectedLines(selected)
      config.onLineSelectionEnd(lastSelection)
      dragStart = undefined
      dragEnd = undefined
      dragMoved = false
      config.onDragReset()
      return
    }

    pendingSelectionEnd = true
    scheduleDragUpdate()
    scheduleSelectionUpdate()

    dragStart = undefined
    dragEnd = undefined
    dragMoved = false
    config.onDragReset()
  }

  const handleSelectionChange = () => {
    if (!config.enableLineSelection()) return
    if (dragStart === undefined) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    scheduleSelectionUpdate()
  }

  // -- shared effects --

  onMount(() => {
    onCleanup(observeViewerScheme(getHost))
  })

  createEffect(() => {
    rendered()
    const ranges = config.commentedLines()
    requestAnimationFrame(() => {
      const root = getRoot()
      if (!root) return
      config.markCommented(root, ranges)
    })
  })

  createEffect(() => {
    config.setSelectedLines(config.selectedLines() ?? null)
  })

  createEffect(() => {
    if (!config.enableLineSelection()) return

    container.addEventListener("mousedown", handleMouseDown)
    container.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    document.addEventListener("selectionchange", handleSelectionChange)

    onCleanup(() => {
      container.removeEventListener("mousedown", handleMouseDown)
      container.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
      document.removeEventListener("selectionchange", handleSelectionChange)
    })
  })

  onCleanup(() => {
    clearReadyWatcher(ready)

    if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame)
    if (dragFrame !== undefined) cancelAnimationFrame(dragFrame)

    selectionFrame = undefined
    dragFrame = undefined
    dragStart = undefined
    dragEnd = undefined
    dragMoved = false
    bridge.reset()
    lastSelection = null
    pendingSelectionEnd = false
  })

  return {
    get wrapper() {
      return wrapper
    },
    set wrapper(v: HTMLDivElement) {
      wrapper = v
    },
    get container() {
      return container
    },
    set container(v: HTMLDivElement) {
      container = v
    },
    get overlay() {
      return overlay
    },
    set overlay(v: HTMLDivElement) {
      overlay = v
    },
    get dragStart() {
      return dragStart
    },
    get dragEnd() {
      return dragEnd
    },
    get lastSelection() {
      return lastSelection
    },
    set lastSelection(v: SelectedLineRange | null) {
      lastSelection = v
    },
    ready,
    bridge,
    rendered,
    setRendered,
    getRoot,
    getHost,
    find,
    scheduleSelectionUpdate,
  }
}

type Viewer = ReturnType<typeof useFileViewer>

type ModeAdapter = Omit<
  ViewerConfig,
  "enableLineSelection" | "search" | "selectedLines" | "commentedLines" | "onLineSelectionEnd"
>

type ModeConfig = {
  enableLineSelection: () => boolean
  search: () => FileSearchControl | undefined
  selectedLines: () => SelectedLineRange | null | undefined
  commentedLines: () => SelectedLineRange[] | undefined
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
}

type RenderTarget = {
  cleanUp: () => void
}

type AnnotationTarget<A> = {
  setLineAnnotations: (annotations: A[]) => void
  rerender: () => void
}

type VirtualStrategy = {
  get: () => Virtualizer | undefined
  cleanup: () => void
}

function useModeViewer(config: ModeConfig, adapter: ModeAdapter) {
  return useFileViewer({
    enableLineSelection: config.enableLineSelection,
    search: config.search,
    selectedLines: config.selectedLines,
    commentedLines: () => config.commentedLines() ?? [],
    onLineSelectionEnd: config.onLineSelectionEnd,
    ...adapter,
  })
}

function useSearchHandle(opts: {
  search: () => FileSearchControl | undefined
  find: ReturnType<typeof createFileFind>
  expand?: (hit: FileSearchReveal) => boolean
}) {
  createEffect(() => {
    const search = opts.search()
    if (!search) return

    const handle = {
      focus: () => {
        opts.find.focus()
      },
      setQuery: (value: string) => {
        opts.find.activate()
        opts.find.setQuery(value, { scroll: false })
      },
      clear: () => {
        opts.find.clear()
      },
      reveal: (hit: FileSearchReveal) => {
        opts.find.activate()
        return opts.find.reveal(hit)
      },
      expand: (hit: FileSearchReveal) => opts.expand?.(hit) ?? false,
      refresh: () => {
        opts.find.activate()
        opts.find.refresh()
      },
    } satisfies FileSearchHandle

    search.register(handle)
    onCleanup(() => search.register(null))
  })
}

function createLineCallbacks(opts: {
  viewer: Viewer
  normalize?: (range: SelectedLineRange | null) => SelectedLineRange | null | undefined
  onLineSelected?: (range: SelectedLineRange | null) => void
  onLineSelectionEnd?: (range: SelectedLineRange | null) => void
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
}) {
  const select = (range: SelectedLineRange | null) => {
    if (!opts.normalize) return range
    const next = opts.normalize(range)
    if (next !== undefined) return next
    return range
  }

  return {
    onLineSelected: (range: SelectedLineRange | null) => {
      const next = select(range)
      opts.viewer.lastSelection = next
      opts.onLineSelected?.(next)
    },
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      const next = select(range)
      opts.viewer.lastSelection = next
      opts.onLineSelectionEnd?.(next)
      if (!opts.viewer.bridge.consume(next)) return
      requestAnimationFrame(() => opts.onLineNumberSelectionEnd?.(next))
    },
  }
}

function useAnnotationRerender<A>(opts: {
  viewer: Viewer
  current: () => AnnotationTarget<A> | undefined
  annotations: () => A[]
}) {
  createEffect(() => {
    opts.viewer.rendered()
    const active = opts.current()
    if (!active) return
    active.setLineAnnotations(opts.annotations())
    active.rerender()
    requestAnimationFrame(() => opts.viewer.find.refresh({ reset: true }))
  })
}

function notifyRendered(opts: {
  viewer: Viewer
  isReady: (root: ShadowRoot) => boolean
  settleFrames?: number
  onReady: () => void
}) {
  notifyShadowReady({
    state: opts.viewer.ready,
    container: opts.viewer.container,
    getRoot: opts.viewer.getRoot,
    isReady: opts.isReady,
    settleFrames: opts.settleFrames,
    onReady: opts.onReady,
  })
}

function renderViewer<I extends RenderTarget>(opts: {
  viewer: Viewer
  current: I | undefined
  create: () => I
  assign: (value: I) => void
  draw: (value: I) => void
  onReady: () => void
}) {
  clearReadyWatcher(opts.viewer.ready)
  opts.current?.cleanUp()
  const next = opts.create()
  opts.assign(next)

  opts.viewer.container.innerHTML = ""
  opts.draw(next)

  applyViewerScheme(opts.viewer.getHost())
  opts.viewer.setRendered((value) => value + 1)
  opts.onReady()
}

function scrollParent(el: HTMLElement): HTMLElement | undefined {
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (style.overflowY === "auto" || style.overflowY === "scroll") return parent
    parent = parent.parentElement
  }
}

function createLocalVirtualStrategy(host: () => HTMLDivElement | undefined, enabled: () => boolean): VirtualStrategy {
  let virtualizer: Virtualizer | undefined
  let root: Document | HTMLElement | undefined

  const release = () => {
    virtualizer?.cleanUp()
    virtualizer = undefined
    root = undefined
  }

  return {
    get: () => {
      if (!enabled()) {
        release()
        return
      }
      if (typeof document === "undefined") return

      const wrapper = host()
      if (!wrapper) return

      const next = scrollParent(wrapper) ?? document
      if (virtualizer && root === next) return virtualizer

      release()
      virtualizer = new Virtualizer()
      root = next
      virtualizer.setup(next, next instanceof Document ? undefined : wrapper)
      return virtualizer
    },
    cleanup: release,
  }
}

function createSharedVirtualStrategy(host: () => HTMLDivElement | undefined, enabled: () => boolean): VirtualStrategy {
  let shared: NonNullable<ReturnType<typeof acquireVirtualizer>> | undefined

  const release = () => {
    shared?.release()
    shared = undefined
  }

  return {
    get: () => {
      if (!enabled()) {
        release()
        return
      }
      if (shared) return shared.virtualizer

      const container = host()
      if (!container) return

      const result = acquireVirtualizer(container)
      if (!result) return
      shared = result
      return result.virtualizer
    },
    cleanup: release,
  }
}

function parseLine(node: HTMLElement) {
  if (!node.dataset.line) return
  const value = parseInt(node.dataset.line, 10)
  if (Number.isNaN(value)) return
  return value
}

function mouseHit(
  event: MouseEvent,
  line: (node: HTMLElement) => number | undefined,
  side?: (node: HTMLElement) => DiffSelectionSide | undefined,
): MouseHit {
  const path = event.composedPath()
  let numberColumn = false
  let value: number | undefined
  let branch: DiffSelectionSide | undefined

  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue

    numberColumn = numberColumn || item.dataset.columnNumber != null
    if (value === undefined) value = line(item)
    if (branch === undefined && side) branch = side(item)

    if (numberColumn && value !== undefined && (side == null || branch !== undefined)) break
  }

  return {
    line: value,
    numberColumn,
    side: branch,
  }
}

function diffMouseSide(node: HTMLElement) {
  const type = node.dataset.lineType
  if (type === "change-deletion") return "deletions" satisfies DiffSelectionSide
  if (type === "change-addition" || type === "change-additions") return "additions" satisfies DiffSelectionSide
  if (node.dataset.code == null) return
  return node.hasAttribute("data-deletions") ? "deletions" : "additions"
}

function diffSelectionSide(node: Node | null) {
  const el = findElement(node)
  if (!el) return
  return findDiffSide(el)
}

// ---------------------------------------------------------------------------
// Shared JSX shell
// ---------------------------------------------------------------------------

function ViewerShell(props: {
  mode: "text" | "diff"
  viewer: ReturnType<typeof useFileViewer>
  search: FileSearchControl | undefined
  class: string | undefined
  classList: ComponentProps<"div">["classList"] | undefined
}) {
  return (
    <div
      data-component="file"
      data-mode={props.mode}
      style={styleVariables}
      class="relative outline-none"
      classList={{
        ...(props.classList || {}),
        [props.class ?? ""]: !!props.class,
      }}
      ref={(el) => (props.viewer.wrapper = el)}
      tabIndex={0}
      onPointerDown={props.viewer.find.onPointerDown}
      onFocus={props.viewer.find.onFocus}
    >
      <Show when={(props.search?.showBar ?? true) && props.viewer.find.open()}>
        <FileSearchBar
          pos={props.viewer.find.pos}
          query={props.viewer.find.query}
          count={props.viewer.find.count}
          index={props.viewer.find.index}
          setInput={props.viewer.find.setInput}
          onInput={props.viewer.find.setQuery}
          onKeyDown={props.viewer.find.onInputKeyDown}
          onClose={props.viewer.find.close}
          onPrev={() => props.viewer.find.next(-1)}
          onNext={() => props.viewer.find.next(1)}
        />
      </Show>
      <div ref={(el) => (props.viewer.container = el)} />
      <div ref={(el) => (props.viewer.overlay = el)} class="pointer-events-none absolute inset-0 z-0" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// TextViewer
// ---------------------------------------------------------------------------

function TextViewer<T>(props: TextFileProps<T>) {
  let instance: PierreFile<T> | VirtualizedFile<T> | undefined
  let viewer!: Viewer

  const [local, others] = splitProps(props, textKeys)

  const text = () => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.join("\n")
    if (value == null) return ""
    return String(value)
  }

  const lineCount = () => {
    const value = text()
    const total = value.split("\n").length - (value.endsWith("\n") ? 1 : 0)
    return Math.max(1, total)
  }

  const bytes = createMemo(() => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value.length
    if (Array.isArray(value)) {
      return value.reduce(
        (sum, part) => sum + (typeof part === "string" ? part.length + 1 : String(part).length + 1),
        0,
      )
    }
    if (value == null) return 0
    return String(value).length
  })

  const virtual = createMemo(() => bytes() > VIRTUALIZE_BYTES)

  const virtuals = createLocalVirtualStrategy(() => viewer.wrapper, virtual)

  const lineFromMouseEvent = (event: MouseEvent): MouseHit => mouseHit(event, parseLine)

  const applySelection = (range: SelectedLineRange | null) => {
    const current = instance
    if (!current) return false

    if (virtual()) {
      current.setSelectedLines(range)
      return true
    }

    const root = viewer.getRoot()
    if (!root) return false

    const total = lineCount()
    if (root.querySelectorAll("[data-line]").length < total) return false

    if (!range) {
      current.setSelectedLines(null)
      return true
    }

    const start = Math.min(range.start, range.end)
    const end = Math.max(range.start, range.end)
    if (start < 1 || end > total) {
      current.setSelectedLines(null)
      return true
    }

    if (!root.querySelector(`[data-line="${start}"]`) || !root.querySelector(`[data-line="${end}"]`)) {
      current.setSelectedLines(null)
      return true
    }

    const normalized = (() => {
      if (range.endSide != null) return { start: range.start, end: range.end }
      if (range.side !== "deletions") return range
      if (root.querySelector("[data-deletions]") != null) return range
      return { start: range.start, end: range.end }
    })()

    current.setSelectedLines(normalized)
    return true
  }

  const setSelectedLines = (range: SelectedLineRange | null) => {
    viewer.lastSelection = range
    applySelection(range)
  }

  const adapter: ModeAdapter = {
    lineFromMouseEvent,
    setSelectedLines,
    updateSelection: (preserveTextSelection) => {
      const root = viewer.getRoot()
      if (!root) return

      const selected = readShadowLineSelection({
        root,
        lineForNode: findFileLineNumber,
        sideForNode: findCodeSelectionSide,
        preserveTextSelection,
      })
      if (!selected) return

      setSelectedLines(selected.range)
      if (!preserveTextSelection || !selected.text) return
      restoreShadowTextSelection(root, selected.text)
    },
    buildDragSelection: () => {
      if (viewer.dragStart === undefined || viewer.dragEnd === undefined) return
      return { start: Math.min(viewer.dragStart, viewer.dragEnd), end: Math.max(viewer.dragStart, viewer.dragEnd) }
    },
    buildClickSelection: () => {
      if (viewer.dragStart === undefined) return
      return { start: viewer.dragStart, end: viewer.dragStart }
    },
    onDragStart: () => {},
    onDragMove: () => {},
    onDragReset: () => {},
    markCommented: markCommentedFileLines,
  }

  viewer = useModeViewer(
    {
      enableLineSelection: () => props.enableLineSelection === true,
      search: () => local.search,
      selectedLines: () => local.selectedLines,
      commentedLines: () => local.commentedLines,
      onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    },
    adapter,
  )

  const lineCallbacks = createLineCallbacks({
    viewer,
    onLineSelected: (range) => local.onLineSelected?.(range),
    onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    onLineNumberSelectionEnd: (range) => local.onLineNumberSelectionEnd?.(range),
  })

  const options = createMemo(() => ({
    ...createDefaultOptions<T>("unified"),
    ...others,
    ...lineCallbacks,
  }))

  const notify = () => {
    notifyRendered({
      viewer,
      isReady: (root) => {
        if (virtual()) return root.querySelector("[data-line]") != null
        return root.querySelectorAll("[data-line]").length >= lineCount()
      },
      onReady: () => {
        applySelection(viewer.lastSelection)
        viewer.find.refresh({ reset: true })
        local.onRendered?.()
      },
    })
  }

  useSearchHandle({
    search: () => local.search,
    find: viewer.find,
  })

  // -- render instance --

  createEffect(() => {
    const opts = options()
    const workerPool = getWorkerPool("unified")
    const isVirtual = virtual()

    const virtualizer = virtuals.get()

    renderViewer({
      viewer,
      current: instance,
      create: () =>
        isVirtual && virtualizer
          ? new VirtualizedFile<T>(opts, virtualizer, codeMetrics, workerPool)
          : new PierreFile<T>(opts, workerPool),
      assign: (value) => {
        instance = value
      },
      draw: (value) => {
        const contents = text()
        value.render({
          file: typeof local.file.contents === "string" ? local.file : { ...local.file, contents },
          lineAnnotations: [],
          containerWrapper: viewer.container,
        })
      },
      onReady: notify,
    })
  })

  useAnnotationRerender<LineAnnotation<T>>({
    viewer,
    current: () => instance,
    annotations: () => (local.annotations as LineAnnotation<T>[] | undefined) ?? [],
  })

  // -- cleanup --

  onCleanup(() => {
    instance?.cleanUp()
    instance = undefined
    virtuals.cleanup()
  })

  return (
    <ViewerShell mode="text" viewer={viewer} search={local.search} class={local.class} classList={local.classList} />
  )
}

// ---------------------------------------------------------------------------
// DiffViewer
// ---------------------------------------------------------------------------

function DiffViewer<T>(props: DiffFileProps<T>) {
  let instance: FileDiff<T> | undefined
  let dragSide: DiffSelectionSide | undefined
  let dragEndSide: DiffSelectionSide | undefined
  let viewer!: Viewer

  const [local, others] = splitProps(props, diffKeys)

  const mobile = createMediaQuery("(max-width: 640px)")

  const lineFromMouseEvent = (event: MouseEvent): MouseHit => mouseHit(event, findDiffLineNumber, diffMouseSide)

  const setSelectedLines = (range: SelectedLineRange | null, preserve?: { root: ShadowRoot; text: Range }) => {
    const active = instance
    if (!active) return

    const fixed = fixDiffSelection(viewer.getRoot(), range)
    if (fixed === undefined) {
      viewer.lastSelection = range
      return
    }

    viewer.lastSelection = fixed
    active.setSelectedLines(fixed)
    restoreShadowTextSelection(preserve?.root, preserve?.text)
  }

  const adapter: ModeAdapter = {
    lineFromMouseEvent,
    setSelectedLines,
    updateSelection: (preserveTextSelection) => {
      const root = viewer.getRoot()
      if (!root) return

      const selected = readShadowLineSelection({
        root,
        lineForNode: findDiffLineNumber,
        sideForNode: diffSelectionSide,
        preserveTextSelection,
      })
      if (!selected) return

      if (selected.text) {
        setSelectedLines(selected.range, { root, text: selected.text })
        return
      }

      setSelectedLines(selected.range)
    },
    buildDragSelection: () => {
      if (viewer.dragStart === undefined || viewer.dragEnd === undefined) return
      const selected: SelectedLineRange = { start: viewer.dragStart, end: viewer.dragEnd }
      if (dragSide) selected.side = dragSide
      if (dragEndSide && dragSide && dragEndSide !== dragSide) selected.endSide = dragEndSide
      return selected
    },
    buildClickSelection: () => {
      if (viewer.dragStart === undefined) return
      const selected: SelectedLineRange = { start: viewer.dragStart, end: viewer.dragStart }
      if (dragSide) selected.side = dragSide
      return selected
    },
    onDragStart: (hit) => {
      dragSide = hit.side
      dragEndSide = hit.side
    },
    onDragMove: (hit) => {
      dragEndSide = hit.side
    },
    onDragReset: () => {
      dragSide = undefined
      dragEndSide = undefined
    },
    markCommented: markCommentedDiffLines,
  }

  viewer = useModeViewer(
    {
      enableLineSelection: () => props.enableLineSelection === true,
      search: () => local.search,
      selectedLines: () => local.selectedLines,
      commentedLines: () => local.commentedLines,
      onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    },
    adapter,
  )

  const virtuals = createSharedVirtualStrategy(
    () => viewer.container,
    () => local.search?.disableVirtualization !== true,
  )

  const large = createMemo(() => {
    const before = typeof local.before?.contents === "string" ? local.before.contents : ""
    const after = typeof local.after?.contents === "string" ? local.after.contents : ""
    return Math.max(before.length, after.length) > 500_000
  })

  const largeOptions = {
    lineDiffType: "none",
    maxLineDiffLength: 0,
    tokenizeMaxLineLength: 1,
  } satisfies Pick<FileDiffOptions<T>, "lineDiffType" | "maxLineDiffLength" | "tokenizeMaxLineLength">

  const lineCallbacks = createLineCallbacks({
    viewer,
    normalize: (range) => fixDiffSelection(viewer.getRoot(), range),
    onLineSelected: (range) => local.onLineSelected?.(range),
    onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    onLineNumberSelectionEnd: (range) => local.onLineNumberSelectionEnd?.(range),
  })

  const options = createMemo<FileDiffOptions<T>>(() => {
    const base = {
      ...createDefaultOptions(props.diffStyle),
      ...others,
      ...lineCallbacks,
    }

    const perf = large() ? { ...base, ...largeOptions } : base
    if (!mobile()) return perf
    return { ...perf, disableLineNumbers: true }
  })

  const notify = () => {
    notifyRendered({
      viewer,
      isReady: (root) => root.querySelector("[data-line]") != null,
      settleFrames: 1,
      onReady: () => {
        setSelectedLines(viewer.lastSelection)
        viewer.find.refresh({ reset: true })
        local.onRendered?.()
      },
    })
  }

  useSearchHandle({
    search: () => local.search,
    find: viewer.find,
    expand: (hit) => {
      const active = instance as
        | ((FileDiff<T> | VirtualizedFileDiff<T>) & {
            fileDiff?: FileDiffMetadata
          })
        | undefined
      if (!active?.fileDiff) return false

      const next = expansionForHit(active.fileDiff, hit)
      if (!next) return false

      active.expandHunk(next.index, next.direction)
      return true
    },
  })

  // -- render instance --

  createEffect(() => {
    const opts = options()
    const workerPool = large() ? getWorkerPool("unified") : getWorkerPool(props.diffStyle)
    const virtualizer = virtuals.get()
    const beforeContents = typeof local.before?.contents === "string" ? local.before.contents : ""
    const afterContents = typeof local.after?.contents === "string" ? local.after.contents : ""

    const cacheKey = (contents: string) => {
      if (!large()) return sampledChecksum(contents, contents.length)
      return sampledChecksum(contents)
    }

    renderViewer({
      viewer,
      current: instance,
      create: () =>
        virtualizer
          ? new VirtualizedFileDiff<T>(opts, virtualizer, virtualMetrics, workerPool)
          : new FileDiff<T>(opts, workerPool),
      assign: (value) => {
        instance = value
      },
      draw: (value) => {
        value.render({
          oldFile: { ...local.before, contents: beforeContents, cacheKey: cacheKey(beforeContents) },
          newFile: { ...local.after, contents: afterContents, cacheKey: cacheKey(afterContents) },
          lineAnnotations: [],
          containerWrapper: viewer.container,
        })
      },
      onReady: notify,
    })
  })

  useAnnotationRerender<DiffLineAnnotation<T>>({
    viewer,
    current: () => instance,
    annotations: () => (local.annotations as DiffLineAnnotation<T>[] | undefined) ?? [],
  })

  // -- cleanup --

  onCleanup(() => {
    instance?.cleanUp()
    instance = undefined
    virtuals.cleanup()
    dragSide = undefined
    dragEndSide = undefined
  })

  return (
    <ViewerShell mode="diff" viewer={viewer} search={local.search} class={local.class} classList={local.classList} />
  )
}

// ---------------------------------------------------------------------------
// SimpleDiffViewer - Inline implementation for WebView environments
// This is inlined here to ensure it's included in the build
// ---------------------------------------------------------------------------

interface SimpleDiffViewerProps {
  before: { name: string; contents: string }
  after: { name: string; contents: string }
  diffStyle?: "split" | "unified"
}

interface LineInfo {
  text: string
  oldLineNum: number | null
  newLineNum: number | null
  type: "added" | "removed" | "unchanged"
}

function SimpleDiffViewer(props: SimpleDiffViewerProps) {
  let containerRef: HTMLDivElement | undefined
  const [diffModule, setDiffModule] = createSignal<any>(null)
  const [highlighter, setHighlighter] = createSignal<any>(null)

  onMount(() => {
    getSharedHighlighter({
      themes: ["dark-plus"],
      langs: ["typescript", "javascript", "tsx", "jsx", "json", "html", "css", "python", "rust", "go", "java", "c", "cpp", "markdown", "yaml", "bash", "text"],
      preferredHighlighter: "shiki-js"
    }).then((h) => setHighlighter(h)).catch(() => {})

    const checkDiff = () => {
      const diff = (window as any).diff
      if (diff) setDiffModule(diff)
      else setTimeout(checkDiff, 100)
    }
    checkDiff()
  })

  const lines = createMemo<LineInfo[]>(() => {
    const mod = diffModule()
    if (!mod) return []

    const before = props.before.contents || ""
    const after = props.after.contents || ""

    try {
      const changes = mod.diffLines(before, after)
      const result: LineInfo[] = []
      let oldLineNum = 1
      let newLineNum = 1

      changes.forEach((change: any) => {
        const changeLines = change.value.split("\n")
        if (changeLines[changeLines.length - 1] === "") changeLines.pop()

        changeLines.forEach((lineText: string) => {
          if (change.added) {
            result.push({ text: lineText, oldLineNum: null, newLineNum: newLineNum++, type: "added" })
          } else if (change.removed) {
            result.push({ text: lineText, oldLineNum: oldLineNum++, newLineNum: null, type: "removed" })
          } else {
            result.push({ text: lineText, oldLineNum: oldLineNum++, newLineNum: newLineNum++, type: "unchanged" })
          }
        })
      })

      return result
    } catch (e) {
      return []
    }
  })

  const escapeHtml = (text: string): string => {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  const getLanguageFromFilename = (filename: string): string => {
    const ext = filename.split(".").pop()?.toLowerCase() || ""
    const langMap: Record<string, string> = {
      ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", py: "python",
      rs: "rust", go: "go", java: "java", cpp: "cpp", c: "c", h: "c", hpp: "cpp",
      css: "css", scss: "scss", less: "less", html: "html", xml: "xml", json: "json",
      md: "markdown", yaml: "yaml", yml: "yaml", sql: "sql", sh: "bash", bash: "bash",
      zsh: "bash", vue: "vue", svelte: "svelte", php: "php", rb: "ruby", swift: "swift",
      kt: "kotlin", scala: "scala", r: "r", dart: "dart", lua: "lua"
    }
    return langMap[ext] || "text"
  }

  const highlightCode = async (code: string, lang: string): Promise<string> => {
    const h = highlighter()
    if (!h) return escapeHtml(code)
    try {
      const result = await h.codeToHtml(code, { lang: lang || "text", theme: "dark-plus" })
      const match = result.match(/<code[^>]*>([\s\S]*)<\/code>/)
      return match ? match[1] : escapeHtml(code)
    } catch (e) {
      return escapeHtml(code)
    }
  }

  const renderDiff = async () => {
    if (!containerRef) return
    const diffLines = lines()
    if (diffLines.length === 0) {
      containerRef.innerHTML = "<div style='padding: 20px; color: #666;'>Loading diff...</div>"
      return
    }

    containerRef.innerHTML = ""
    const diffContainer = document.createElement("div")
    diffContainer.className = "simple-diff"
    diffContainer.style.cssText = `font-family: var(--font-family-mono, monospace); font-size: var(--font-size-small, 13px); line-height: 1.5; overflow-x: auto; background: var(--color-bg, #1e1e1e); color: var(--color-fg, #d4d4d4);`

    const lang = getLanguageFromFilename(props.after.name || props.before.name || "")

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i]
      const lineEl = document.createElement("div")
      lineEl.className = "diff-line"
      lineEl.style.cssText = `display: flex; min-height: 24px; font-family: inherit;`

      const oldNumEl = document.createElement("span")
      oldNumEl.className = "old-line-num"
      oldNumEl.style.cssText = `width: 45px; padding: 0 8px; text-align: right; color: #666; user-select: none; flex-shrink: 0; font-family: inherit; border-right: 1px solid #333;`
      oldNumEl.textContent = line.oldLineNum?.toString() || ""

      const newNumEl = document.createElement("span")
      newNumEl.className = "new-line-num"
      newNumEl.style.cssText = `width: 45px; padding: 0 8px; text-align: right; color: #666; user-select: none; flex-shrink: 0; font-family: inherit; border-right: 1px solid #333;`
      newNumEl.textContent = line.newLineNum?.toString() || ""

      const indicatorEl = document.createElement("span")
      indicatorEl.className = "change-indicator"
      indicatorEl.style.cssText = `width: 20px; padding: 0 4px; text-align: center; user-select: none; flex-shrink: 0; font-family: inherit;`

      const contentEl = document.createElement("span")
      contentEl.className = "line-content"
      contentEl.style.cssText = `flex: 1; padding: 0 8px; white-space: pre; font-family: inherit;`

      if (line.type === "added") {
        lineEl.style.backgroundColor = "rgba(35, 197, 94, 0.1)"
        indicatorEl.textContent = "+"
        indicatorEl.style.color = "#23c55e"
        oldNumEl.style.backgroundColor = "rgba(35, 197, 94, 0.05)"
        newNumEl.style.backgroundColor = "rgba(35, 197, 94, 0.05)"
      } else if (line.type === "removed") {
        lineEl.style.backgroundColor = "rgba(239, 68, 68, 0.1)"
        indicatorEl.textContent = "-"
        indicatorEl.style.color = "#ef4444"
        oldNumEl.style.backgroundColor = "rgba(239, 68, 68, 0.05)"
        newNumEl.style.backgroundColor = "rgba(239, 68, 68, 0.05)"
      } else {
        indicatorEl.textContent = " "
      }

      const highlighted = await highlightCode(line.text, lang)
      contentEl.innerHTML = highlighted || " "

      lineEl.appendChild(oldNumEl)
      lineEl.appendChild(newNumEl)
      lineEl.appendChild(indicatorEl)
      lineEl.appendChild(contentEl)
      diffContainer.appendChild(lineEl)
    }

    containerRef.appendChild(diffContainer)
  }

  createEffect(() => {
    lines()
    highlighter()
    renderDiff()
  })

  return (
    <div
      ref={containerRef}
      class="simple-diff-viewer"
      style={{ width: "100%", height: "100%", overflow: "auto", "background-color": "var(--color-bg, #1e1e1e)", color: "var(--color-fg, #d4d4d4)" }}
    >
      <div style={{ padding: "20px", color: "#666" }}>Loading diff...</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Check if running in WebView/Cordova environment
const isWebView = () => {
  if (typeof window === "undefined") return false
  const protocol = window.location.protocol
  const hasCordova = !!(window as any).cordova
  const hasWebkit = !!(window as any).webkit?.messageHandlers
  const result = protocol === "file:" || hasCordova || hasWebkit
  console.log("[isWebView] check:", { protocol, hasCordova, hasWebkit, result })
  return result
}

export function File<T>(props: FileProps<T>) {
  if (props.mode === "text") {
    return <FileMedia media={props.media} fallback={() => TextViewer(props)} />
  }

  // Use SimpleDiffViewer in WebView environment to avoid Shadow DOM issues
  if (isWebView()) {
    console.log("[File] Using SimpleDiffViewer for WebView environment")
    return (
      <SimpleDiffViewer
        before={props.before}
        after={props.after}
        diffStyle={props.diffStyle}
      />
    )
  }

  return <FileMedia media={props.media} fallback={() => DiffViewer(props)} />
}
