// Most mezi okny a hlavním procesem (bezpečně přes contextBridge).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("loopnoteDesktop", {
  // hlavní okno
  onImage: (cb) => ipcRenderer.on("circle-image", (_e, url) => cb(url)),
  onCaptureFailed: (cb) => ipcRenderer.on("capture-failed", () => cb()),
  capture: () => ipcRenderer.send("bubble-click"),
  // bublina
  bubbleMove: (dx, dy) => ipcRenderer.send("bubble-move", dx, dy),
  bubbleClick: () => ipcRenderer.send("bubble-click"),
  bubbleOff: () => ipcRenderer.send("bubble-off"),
  // kroužkování přes obrazovku
  onShot: (cb) => ipcRenderer.on("shot", (_e, url) => cb(url)),
  overlayDone: (url) => ipcRenderer.send("overlay-done", url),
});
