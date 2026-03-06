// @refresh reload

import { iife } from "@opencode-ai/util/iife"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { HashRouter } from "@solidjs/router"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

// Import web-components to register <diffs-container> custom element
import "@opencode-ai/ui/pierre/web-components"

// Debug: Check if custom elements are supported
if (typeof customElements !== "undefined") {
  console.log("[OpenCode] customElements supported")
  console.log("[OpenCode] diffs-container defined:", customElements.get("diffs-container") !== undefined)
} else {
  console.error("[OpenCode] customElements NOT supported")
}

// Debug: Check CSSStyleSheet support
if (typeof CSSStyleSheet !== "undefined") {
  console.log("[OpenCode] CSSStyleSheet supported")
} else {
  console.error("[OpenCode] CSSStyleSheet NOT supported")
}

// Debug: Check diff library availability and expose to window
console.log("[OpenCode] About to load diff library...")
import("diff").then((diff) => {
  console.log("[OpenCode] diff library loaded:", Object.keys(diff))
  console.log("[OpenCode] createTwoFilesPatch:", typeof diff.createTwoFilesPatch)
  // Expose diff to window for SimpleDiffViewer
  ;(window as any).diff = diff
  console.log("[OpenCode] window.diff set:", !!(window as any).diff)
}).catch((err) => {
  console.error("[OpenCode] Failed to load diff library:", err)
})

// Preload highlighter for SimpleDiffViewer
console.log("[OpenCode] About to load highlighter...")
import("@opencode-ai/ui/pierre").then((mod) => {
  console.log("[OpenCode] @opencode-ai/ui/pierre module loaded")
  // The highlighter will be loaded by SimpleDiffViewer when needed
}).catch((err) => {
  console.error("[OpenCode] Failed to load pierre module:", err)
})

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

// In-memory fallback for file:// protocol where localStorage doesn't work
let memoryServerUrl: string | null = null

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => {
  // For file:// protocol, use in-memory storage
  if (location.protocol === "file:") {
    return memoryServerUrl
  }
  return getStorage(DEFAULT_SERVER_URL_KEY)
}

const writeDefaultServerUrl = (url: string | null) => {
  // For file:// protocol, use in-memory storage
  if (location.protocol === "file:") {
    memoryServerUrl = url
    return
  }
  setStorage(DEFAULT_SERVER_URL_KEY, url)
}

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServerUrl: async () => readDefaultServerUrl(),
  setDefaultServerUrl: writeDefaultServerUrl,
}

// Default server URL for Cordova/WebView - can be overridden at build time
const CORDOVA_DEFAULT_SERVER = "http://192.168.31.110:4096"

const defaultUrl = iife(() => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  // For file:// protocol (Cordova/WebView), use configured default
  if (location.protocol === "file:") return CORDOVA_DEFAULT_SERVER
  return location.origin
})

if (root instanceof HTMLElement) {
  const server: ServerConnection.Http = { type: "http", http: { url: defaultUrl } }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} router={HashRouter} />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
