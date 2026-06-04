import { Show, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useLanguage } from "@/context/language"

export function SessionMenuItems(props: {
  onRename: () => void
  onShare?: () => void
  onArchive: () => void
  onDelete: () => void
}): JSX.Element {
  const language = useLanguage()
  const run = (fn: () => void) => () => fn()

  return (
    <>
      <DropdownMenu.Item onClick={run(props.onRename)}>
        <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
      </DropdownMenu.Item>
      <Show when={props.onShare}>
        {(share) => (
          <DropdownMenu.Item onClick={run(share())}>
            <DropdownMenu.ItemLabel>{language.t("session.share.action.share")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        )}
      </Show>
      <DropdownMenu.Item onClick={run(props.onArchive)}>
        <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item onClick={run(props.onDelete)}>
        <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
      </DropdownMenu.Item>
    </>
  )
}
