// Bridge between Electron main and the renderer. The "Shell" sub-agent owns this file.
import { contextBridge, ipcRenderer } from "electron";

const api = {
  onCommandBar: (cb: () => void) => { ipcRenderer.on("ns:command-bar", cb); return () => ipcRenderer.removeListener("ns:command-bar", cb); },
  onDraftHotkey: (cb: () => void) => { ipcRenderer.on("ns:draft", cb); return () => ipcRenderer.removeListener("ns:draft", cb); },
  setBadge: (n: number) => ipcRenderer.send("ns:badge", n),
  notify: (title: string, body: string) => ipcRenderer.send("ns:notify", { title, body }),
  openExternal: (url: string) => ipcRenderer.send("ns:open", url),
  onPopIn: (cb: (o: { x: number; y: number }) => void) => {
    const h = (_e: unknown, o: { x: number; y: number }) => cb(o);
    ipcRenderer.on("ns:pop-in", h); return () => ipcRenderer.removeListener("ns:pop-in", h);
  },
  onPopOut: (cb: (o: { x: number; y: number }) => void) => {
    const h = (_e: unknown, o: { x: number; y: number }) => cb(o);
    ipcRenderer.on("ns:pop-out", h); return () => ipcRenderer.removeListener("ns:pop-out", h);
  },
  poppedOut: () => ipcRenderer.send("ns:popped-out"),
  winClose: () => ipcRenderer.send("ns:win-close"),
  winMin: () => ipcRenderer.send("ns:win-min"),
  winMax: () => ipcRenderer.send("ns:win-max"),
  // Floating bubble
  bubbleMove: (x: number, y: number) => ipcRenderer.send("ns:bubble-move", x, y),
  bubbleClick: () => ipcRenderer.send("ns:bubble-click"),
  bubbleCommand: () => ipcRenderer.send("ns:bubble-command"),
  // Ask window (small text window under the bubble)
  askToggle: () => ipcRenderer.send("ns:ask-toggle"),
  askHide: () => ipcRenderer.send("ns:ask-hide"),
  askResize: (height: number) => ipcRenderer.send("ns:ask-resize", height),
  /** A running task needs an answer: bring the Ask window back (and flash a notification if it was hidden). */
  askShow: (title?: string) => ipcRenderer.send("ns:ask-show", title ?? ""),
  onAskShown: (cb: () => void) => { ipcRenderer.on("ns:ask-shown", cb); return () => ipcRenderer.removeListener("ns:ask-shown", cb); },
  onAskBlur: (cb: () => void) => { ipcRenderer.on("ns:ask-blur", cb); return () => ipcRenderer.removeListener("ns:ask-blur", cb); },
  // Maximize: open the main window on a given screen
  openMain: (screen: string) => ipcRenderer.send("ns:open-main", screen),
  // Camera notch widget
  notchExpand: () => ipcRenderer.send("ns:notch-expand"),
  notchCollapse: () => ipcRenderer.send("ns:notch-collapse"),
  /** Main process shrank the notch (cursor left it); the widget should reset to collapsed. */
  onNotchForceCollapse: (cb: () => void) => { ipcRenderer.on("ns:notch-force-collapse", cb); return () => ipcRenderer.removeListener("ns:notch-force-collapse", cb); },
  notchOpenMain: (screen: string) => ipcRenderer.send("ns:notch-open-main", screen),
  // Collapsed size, and whether the widget sits behind a real MacBook camera notch
  notchGeometry: (): { hardware: boolean; width: number; height: number; touch: boolean } => ipcRenderer.sendSync("ns:notch-geometry"),
  // Touch to open: asks macOS for the camera the first time; false when the user said no
  cameraAccess: (): Promise<boolean> => ipcRenderer.invoke("ns:camera-access"),
  onNotchGeometry: (cb: (g: { hardware: boolean; width: number; height: number; touch: boolean }) => void) => {
    const h = (_e: unknown, g: { hardware: boolean; width: number; height: number; touch: boolean }) => cb(g);
    ipcRenderer.on("ns:notch-geometry", h); return () => ipcRenderer.removeListener("ns:notch-geometry", h);
  },
  onNavigate: (cb: (screen: string) => void) => {
    const h = (_e: unknown, s: string) => cb(s);
    ipcRenderer.on("ns:navigate", h); return () => ipcRenderer.removeListener("ns:navigate", h);
  },
};

contextBridge.exposeInMainWorld("northstar", api);
export type NorthstarBridge = typeof api;
