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
  onAskShown: (cb: () => void) => { ipcRenderer.on("ns:ask-shown", cb); return () => ipcRenderer.removeListener("ns:ask-shown", cb); },
  onAskBlur: (cb: () => void) => { ipcRenderer.on("ns:ask-blur", cb); return () => ipcRenderer.removeListener("ns:ask-blur", cb); },
  // Maximize: open the main window on a given screen
  openMain: (screen: string) => ipcRenderer.send("ns:open-main", screen),
  onNavigate: (cb: (screen: string) => void) => {
    const h = (_e: unknown, s: string) => cb(s);
    ipcRenderer.on("ns:navigate", h); return () => ipcRenderer.removeListener("ns:navigate", h);
  },
};

contextBridge.exposeInMainWorld("northstar", api);
export type NorthstarBridge = typeof api;
