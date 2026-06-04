import { For, Show, type Accessor, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject } from "@/context/layout"
import { useSettings } from "@/context/settings"

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  aimMove: (event: MouseEvent) => void
  projects: Accessor<LocalProject[]>
  pinnedProjects: Accessor<LocalProject[]>
  openProjects: Accessor<LocalProject[]>
  renderProject: (project: LocalProject) => JSX.Element
  renderProjectPanel: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectActionLabel: JSX.Element
  pinnedProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  helpLabel: Accessor<string>
  onOpenHelp: () => void
}): JSX.Element => {
  const settings = useSettings()
  const codex = () => settings.general.codexLayout()
  const placement = () => (props.mobile ? "bottom" : "right")
  const group = (projects: Accessor<LocalProject[]>) => (
    <For each={projects()}>
      {(project) => (
        <div class="min-w-0">
          {props.renderProject(project)}
          <Show when={props.opened() && project.expanded}>
            <div class="pl-4">{props.renderProjectPanel(project)}</div>
          </Show>
        </div>
      )}
    </For>
  )

  return (
    <div
      classList={{
        "flex h-full w-full min-w-0 overflow-hidden": true,
        "bg-surface-raised-base": codex(),
        "bg-background-base": !codex(),
      }}
      onMouseMove={props.aimMove}
    >
      <div class="flex h-full w-full min-w-0 flex-col overflow-hidden">
        <div class="min-h-0 flex-1 overflow-y-auto no-scrollbar px-2 pb-3 pt-3">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div class="w-full flex flex-col gap-1">
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                <Show when={props.pinnedProjects().length > 0}>
                  <div class="mb-2 flex flex-col gap-1">
                    <div
                      class="flex h-7 items-center px-1 text-12-medium text-text-weak"
                    >
                      {props.pinnedProjectLabel}
                    </div>
                    {group(props.pinnedProjects)}
                  </div>
                </Show>
                <div class="flex flex-col gap-1">
                  <div class="flex h-7 items-center justify-between px-1">
                    <div
                      class="text-12-medium text-text-weak"
                    >
                      {props.openProjectLabel}
                    </div>
                    <Tooltip
                      placement={placement()}
                      value={
                        <div class="flex items-center gap-2">
                          <span>{props.openProjectActionLabel}</span>
                          <Show when={!props.mobile && !!props.openProjectKeybind()}>
                            <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                          </Show>
                        </div>
                      }
                    >
                      <IconButton
                        icon="plus"
                        variant="ghost"
                        class="size-6 rounded-md"
                        onClick={props.onOpenProject}
                        aria-label={
                          typeof props.openProjectActionLabel === "string" ? props.openProjectActionLabel : undefined
                        }
                      />
                    </Tooltip>
                  </div>
                  {group(props.openProjects)}
                </div>
              </SortableProvider>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>

        <div class="shrink-0 w-full px-2 pb-3 pt-2">
          <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
            <button
              type="button"
              classList={{
                "flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-14-regular transition-colors": true,
                "text-text-base hover:bg-surface-raised-base-hover": codex(),
                "text-text-base hover:bg-surface-base-hover": !codex(),
              }}
              onClick={props.onOpenSettings}
              aria-label={props.settingsLabel()}
            >
              <Icon name="settings-gear" size="small" class="text-icon-base" />
              <span class="min-w-0 flex-1 truncate">{props.settingsLabel()}</span>
            </button>
          </TooltipKeybind>
          <div class="sr-only">
            <Tooltip placement={placement()} value={props.helpLabel()}>
              <IconButton icon="help" variant="ghost" onClick={props.onOpenHelp} aria-label={props.helpLabel()} />
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}
