'use strict';

/**
 * Preload for the main SPA window. The web client is unmodified and does not depend on
 * anything here; this only (a) exposes a small, optional native bridge under
 * window.journeyDesktop for diagnostics, and (b) hardens a couple of desktop-shell edge
 * cases the web app never had to think about.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('journeyDesktop', {
    isDesktop: true,
    getInfo: () => ipcRenderer.invoke('journey:get-info'),
    getDataStatus: () => ipcRenderer.invoke('journey:data-status'),
    onDataStatus: (cb) => {
        const listener = (_e, status) => { try { cb(status); } catch { /* noop */ } };
        ipcRenderer.on('journey:data-status', listener);
        return () => ipcRenderer.removeListener('journey:data-status', listener);
    },
    openExternal: (url) => ipcRenderer.invoke('journey:open-external', url),
    changeServer: () => ipcRenderer.invoke('journey:reload'), // handled by menu; kept for parity
    reload: () => ipcRenderer.invoke('journey:reload'),
    openLogs: () => ipcRenderer.invoke('journey:open-logs'),
    setPrefs: (prefs) => ipcRenderer.invoke('journey:set-prefs', prefs),
});

// The first-run / "Change Server" page is served into this same window at
// journey://app/__setup, so it shares this preload.
contextBridge.exposeInMainWorld('journeySetup', {
    getInfo: () => ipcRenderer.invoke('journey:get-info'),
    test: (url) => ipcRenderer.invoke('journey:test-server', url),
    save: (url) => ipcRenderer.invoke('journey:save-server', url),
    setPrefs: (prefs) => ipcRenderer.invoke('journey:set-prefs', prefs),
    openExternal: (url) => ipcRenderer.invoke('journey:open-external', url),
});

// A file dropped outside the app's own photo dropzone would otherwise make the window
// navigate to file://… and blow away the SPA. Prevent the *default* (navigation) at the
// document level; the app's own dropzone handlers run first during bubbling and still
// read the files, so photo drag-and-drop keeps working.
window.addEventListener('dragover', (e) => { e.preventDefault(); }, false);
window.addEventListener('drop', (e) => { e.preventDefault(); }, false);
