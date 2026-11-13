// Bridge between Electron main and the renderer. The "Shell" sub-agent owns this file.
import { contextBridge, ipcRenderer } from "electron";

const api = {
  onCommandBar: (cb: () => void) => { ipcRenderer.on("ns:command-bar", cb); return () => ipcRenderer.removeListener("ns:command-bar", cb); },
  onDraftHotkey: (cb: () => void) => { ipcRenderer.on("ns:draft", cb); return () => ipcRenderer.removeListener("ns:draft", cb); },
  setBadge: (n: number) => ipcRenderer.send("ns:badge", n),
  notify: (title: string, body: string) => ipcRenderer.send("ns:notify", { title, body }),
  openExternal: (url: string) => ipcRenderer.send("ns:open", url),
  onPopIn: (cb: () => void) => { ipcRenderer.on("ns:pop-in", cb); return () => ipcRenderer.removeListener("ns:pop-in", cb); },
  onPopOut: (cb: () => void) => { ipcRenderer.on("ns:pop-out", cb); return () => ipcRenderer.removeListener("ns:pop-out", cb); },
  // Floating bubble
  bubbleMove: (x: number, y: number) => ipcRenderer.send("ns:bubble-move", x, y),
  bubbleClick: () => ipcRenderer.send("ns:bubble-click"),
  bubbleCommand: () => ipcRenderer.send("ns:bubble-command"),
};

contextBridge.exposeInMainWorld("northstar", api);
export type NorthstarBridge = typeof api;
