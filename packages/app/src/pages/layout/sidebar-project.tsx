import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createSortable } from "@thisbeyond/solid-dnd"
import { type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { ProjectIcon, type SessionItemProps } from "./sidebar-items"
import { displayName } from "./helpers"

export type ProjectSidebarContext = {
  currentDir: Accessor<string>
  currentProject: Accessor<LocalProject | undefined>
  sidebarOpened: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  hoverProject: Accessor<string | undefined>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  onHoverOpenChanged: (worktree: string, hovered: boolean) => void
  navigateToProject: (directory: string) => void
  toggleProjectExpanded: (project: LocalProject) => void
  navigateToNewSession: (directory: string) => void
  openProjectDirectory: (project: LocalProject) => void
  archiveProjectSessions: (project: LocalProject) => Promise<void>
  pinned: (project: LocalProject) => boolean
  setPinned: (project: LocalProject, value: boolean) => void
  openSidebar: () => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  sessionProps: Omit<SessionItemProps, "session" | "list" | "slug" | "mobile" | "dense">
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="bg-background-base rounded-xl p-1">
          <ProjectIcon project={p()} />
        </div>
      )}
    </Show>
  )
}

const ProjectTile = (props: {
  project: LocalProject
  mobile?: boolean
  sidebarOpened: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  selected: Accessor<boolean>
  active: Accessor<boolean>
  isWorking: Accessor<boolean>
  overlay: Accessor<boolean>
  suppressHover: Accessor<boolean>
  dirs: Accessor<string[]>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  navigateToProject: (directory: string) => void
  toggleProjectExpanded: (project: LocalProject) => void
  navigateToNewSession: (directory: string) => void
  openProjectDirectory: (project: LocalProject) => void
  archiveProjectSessions: (project: LocalProject) => Promise<void>
  pinned: (project: LocalProject) => boolean
  setPinned: (project: LocalProject, value: boolean) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  closeProject: (directory: string) => void
  setMenu: (value: boolean) => void
  setOpen: (value: boolean) => void
  setSuppressHover: (value: boolean) => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const notification = useNotification()
  const expanded = createMemo(() => props.mobile || props.sidebarOpened())
  const pinned = createMemo(() => props.pinned(props.project))
  const unseenCount = createMemo(() =>
    props.dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )

  const clear = () =>
    props
      .dirs()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))

  const menuItem = (icon: Parameters<typeof Icon>[0]["name"], label: string) => (
    <div class="flex min-w-0 items-center gap-2">
      <Icon name={icon} size="small" class="shrink-0 text-icon-base" />
      <DropdownMenu.ItemLabel>{label}</DropdownMenu.ItemLabel>
    </div>
  )

  return (
    <div
      data-project={base64Encode(props.project.worktree)}
      classList={{
        "group flex min-w-0 rounded-lg overflow-hidden transition-colors cursor-default": true,
        "h-9 w-full items-center gap-1 px-1": expanded(),
        "size-10 items-center justify-center p-1": !expanded(),
        "bg-surface-base-active border border-transparent": expanded() && props.selected(),
        "bg-surface-base-active border border-transparent hover:bg-surface-base-hover":
          !expanded() && props.selected(),
        "bg-transparent border border-transparent hover:bg-surface-base-hover":
          !props.selected() && !props.active(),
        "bg-surface-base-hover border border-transparent": !props.selected() && props.active(),
      }}
      onMouseEnter={(event: MouseEvent) => {
        if (!props.overlay()) return
        if (props.suppressHover()) return
        props.onProjectMouseEnter(props.project.worktree, event)
      }}
      onMouseLeave={() => {
        if (props.suppressHover()) props.setSuppressHover(false)
        if (!props.overlay()) return
        props.onProjectMouseLeave(props.project.worktree)
      }}
    >
      <Show when={expanded()}>
        <button
          type="button"
          aria-label={displayName(props.project)}
          data-action="project-switch"
          data-project={base64Encode(props.project.worktree)}
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus:outline-none"
          onPointerDown={(event) => {
            if (event.button !== 0 || event.ctrlKey) return
            props.setOpen(false)
            props.setSuppressHover(true)
          }}
          onFocus={() => {
            if (!props.overlay()) return
            if (props.suppressHover()) return
            props.onProjectFocus(props.project.worktree)
          }}
          onClick={() => {
            props.setOpen(false)
            props.toggleProjectExpanded(props.project)
          }}
          onBlur={() => props.setOpen(false)}
          aria-expanded={props.project.expanded}
        >
          <Icon
            name={props.project.expanded ? "folder-open" : "folder"}
            size="small"
            class="shrink-0 text-icon-base"
          />
          <span
            class="min-w-0 flex-1 truncate text-14-regular text-text-base"
          >
            {displayName(props.project)}
          </span>
        </button>

        <div
          classList={{
            "flex shrink-0 items-center gap-0.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100": true,
            "opacity-100": props.selected() || props.active(),
            "opacity-0": !props.selected() && !props.active(),
          }}
        >
          <DropdownMenu
            modal={!props.sidebarHovering()}
            onOpenChange={(value) => {
              props.setMenu(value)
              props.setSuppressHover(value)
              if (value) props.setOpen(false)
            }}
          >
            <DropdownMenu.Trigger
              as={IconButton}
              icon="dot-grid"
              variant="ghost"
              class="size-6 rounded-md"
              data-action="project-menu"
              data-project={base64Encode(props.project.worktree)}
              aria-label={props.language.t("common.moreOptions")}
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="min-w-48">
                <DropdownMenu.Item onSelect={() => props.setPinned(props.project, !pinned())}>
                  {menuItem("pin", props.language.t(pinned() ? "sidebar.project.unpin" : "sidebar.project.pin"))}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => props.openProjectDirectory(props.project)}>
                  {menuItem("folder", props.language.t("sidebar.project.openInExplorer"))}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
                  {menuItem("edit", props.language.t("sidebar.project.rename"))}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={props.dirs().length === 0}
                  onSelect={() => {
                    void props.archiveProjectSessions(props.project)
                  }}
                >
                  {menuItem("archive", props.language.t("sidebar.project.archiveConversations"))}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  data-action="project-remove-menu"
                  data-project={base64Encode(props.project.worktree)}
                  onSelect={() => props.closeProject(props.project.worktree)}
                >
                  {menuItem("close", props.language.t("common.remove"))}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>

          <Tooltip value={props.language.t("command.session.new")} placement="top">
            <IconButton
              icon="new-session"
              variant="ghost"
              class="size-6 rounded-md"
              data-action="project-new-session"
              data-project={base64Encode(props.project.worktree)}
              aria-label={props.language.t("command.session.new")}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                props.navigateToNewSession(props.project.worktree)
              }}
            />
          </Tooltip>
        </div>
      </Show>
      <Show when={!expanded()}>
        <ProjectIcon project={props.project} notify working={props.isWorking()} />
      </Show>
    </div>
  )
}

export const SortableProject = (props: {
  project: LocalProject
  mobile?: boolean
  ctx: ProjectSidebarContext
  sortNow: Accessor<number>
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.ctx.currentProject()?.worktree === props.project.worktree)
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const [state, setState] = createStore({
    menu: false,
    suppressHover: false,
  })

  const isHoverProject = () => props.ctx.hoverProject() === props.project.worktree
  const overlay = createMemo(() => !props.mobile && !props.ctx.sidebarOpened())
  const active = createMemo(() => state.menu || (overlay() && isHoverProject()))

  const isWorking = createMemo(() =>
    dirs().some((directory) => {
      const [store] = serverSync.child(directory, { bootstrap: false })
      return Object.keys(store.session_status).some((id) => store.session_working(id))
    }),
  )

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <ProjectTile
        project={props.project}
        mobile={props.mobile}
        sidebarOpened={props.ctx.sidebarOpened}
        sidebarHovering={props.ctx.sidebarHovering}
        selected={selected}
        active={active}
        isWorking={isWorking}
        overlay={overlay}
        suppressHover={() => state.suppressHover}
        dirs={dirs}
        onProjectMouseEnter={props.ctx.onProjectMouseEnter}
        onProjectMouseLeave={props.ctx.onProjectMouseLeave}
        onProjectFocus={props.ctx.onProjectFocus}
        navigateToProject={props.ctx.navigateToProject}
        toggleProjectExpanded={props.ctx.toggleProjectExpanded}
        navigateToNewSession={props.ctx.navigateToNewSession}
        openProjectDirectory={props.ctx.openProjectDirectory}
        archiveProjectSessions={props.ctx.archiveProjectSessions}
        pinned={props.ctx.pinned}
        setPinned={props.ctx.setPinned}
        showEditProjectDialog={props.ctx.showEditProjectDialog}
        toggleProjectWorkspaces={props.ctx.toggleProjectWorkspaces}
        workspacesEnabled={props.ctx.workspacesEnabled}
        closeProject={props.ctx.closeProject}
        setMenu={(value) => setState("menu", value)}
        setOpen={(value) => props.ctx.onHoverOpenChanged(props.project.worktree, value)}
        setSuppressHover={(value) => setState("suppressHover", value)}
        language={language}
      />
    </div>
  )
}
