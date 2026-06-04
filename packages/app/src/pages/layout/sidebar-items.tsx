import type { Session } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/core/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useSettings } from "@/context/settings"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { SessionMenuItems } from "@/components/session/session-menu-items"
import { childSessionOnPath, getProjectAvatarSource, hasProjectPermissions } from "./helpers"
import { useDialog } from "@opencode-ai/ui/context/dialog"

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  notify?: boolean
  working?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = serverSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
      <Show when={props.working}>
        <div class="absolute bottom-px right-px size-3 rounded-full bg-background-base z-10 flex items-center justify-center">
          <Spinner class="size-[9px]" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  sidebarOpened: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  renameSession: (session: Session, title: string) => Promise<void>
  archiveSession: (session: Session) => Promise<void>
  deleteSession: (session: Session) => void
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
}): JSX.Element => {
  const settings = useSettings()
  const codex = () => settings.general.codexLayout()
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={() => {
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <Show when={props.isWorking() || props.hasPermissions() || props.hasError() || props.unseenCount() > 0}>
        <div
          class="shrink-0 size-6 flex items-center justify-center"
          style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch>
            <Match when={props.isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={props.hasPermissions()}>
              <div class="size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={props.hasError()}>
              <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <span
        classList={{
          "text-14-regular min-w-0 flex-1 truncate": true,
          "text-text-base": codex(),
          "text-[#566274]": !codex(),
        }}
      >
        {title()}
      </span>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const language = useLanguage()
  const dialog = useDialog()
  const settings = useSettings()
  const codex = () => settings.general.codexLayout()
  const [open, setOpen] = createSignal(false)
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = serverSync.child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionStore.session_working(props.session.id)
  })

  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent))
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={props.sidebarOpened}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
    />
  )

  function DialogRename() {
    const [title, setTitle] = createSignal(sessionTitle(props.session.title))
    const [saving, setSaving] = createSignal(false)
    const rename = async () => {
      if (saving()) return
      setSaving(true)
      await props.renameSession(props.session, title()).then(() => dialog.close())
      setSaving(false)
    }

    return (
      <Dialog title={language.t("common.rename")} size="small" fit>
        <form
          class="flex flex-col gap-6 p-6 pt-0"
          onSubmit={(event) => {
            event.preventDefault()
            void rename()
          }}
        >
          <TextField
            autofocus
            label={language.t("common.rename")}
            value={title()}
            onChange={(value) => setTitle(value)}
          />
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" type="button" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" type="submit" disabled={saving()}>
              {language.t("common.rename")}
            </Button>
          </div>
        </form>
      </Dialog>
    )
  }

  return (
    <>
      <div
        data-session-id={props.session.id}
        classList={{
          "group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors": true,
          "hover:bg-surface-base-hover [&:has(:focus-visible)]:bg-surface-base-hover has-[[data-expanded]]:bg-surface-base-hover has-[.active]:bg-surface-base-active":
            true,
        }}
        style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
      >
        <div class="flex min-w-0 items-center gap-1">
          <div class="min-w-0 flex-1">
            <Show
              when={!tooltip()}
              fallback={
                <Tooltip
                  placement={props.mobile ? "bottom" : "right"}
                  value={sessionTitle(props.session.title)}
                  gutter={10}
                  class="min-w-0 w-full"
                >
                  {item}
                </Tooltip>
              }
            >
              {item}
            </Show>
          </div>

          <Show when={!props.level}>
            <div
              class="shrink-0 overflow-hidden transition-[width,opacity]"
              classList={{
                "w-6 opacity-100 pointer-events-auto": !!props.mobile,
                "w-0 opacity-0 pointer-events-none": !props.mobile,
                "group-hover/session:w-6 group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                "group-focus-within/session:w-6 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
              }}
            >
              <DropdownMenu modal={!props.sidebarOpened()} open={open()} onOpenChange={setOpen}>
                <DropdownMenu.Trigger
                  as={IconButton}
                  icon="dot-grid"
                  variant="ghost"
                  class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                  aria-label={language.t("common.moreOptions")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                />
                <DropdownMenu.Portal>
                  <DropdownMenu.Content style={{ "min-width": "104px" }}>
                    <SessionMenuItems
                      onRename={() => {
                        setOpen(false)
                        dialog.show(() => <DialogRename />)
                      }}
                      onArchive={() => void props.archiveSession(props.session)}
                      onDelete={() => {
                        setOpen(false)
                        setTimeout(() => props.deleteSession(props.session), 0)
                      }}
                    />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </Show>
        </div>
      </div>
      <Show when={currentChild()} keyed>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  sidebarOpened: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Icon
          name="new-session"
          size="small"
          class="text-icon-base"
        />
      </div>
      <span
        class="text-14-regular min-w-0 flex-1 truncate text-text-base"
      >
        {label}
      </span>
    </A>
  )

  return (
    <div
      classList={{
        "group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3": true,
        "hover:bg-surface-base-hover [&:has(:focus-visible)]:bg-surface-base-hover has-[.active]:bg-surface-base-active":
          true,
      }}
    >
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
