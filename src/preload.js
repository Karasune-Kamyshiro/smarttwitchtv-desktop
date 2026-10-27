// Minimal, explicit bridge between the page and the main process.
// The page-side "Android" object (src/renderer/android-shim.js) is built on top of this.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only the bundled app gets the bridge — never the Twitch login pages that load in the same window.
if (location.protocol === 'app:') contextBridge.exposeInMainWorld('__stvDesktop', {
    httpSync: (req) => ipcRenderer.sendSync('http-sync', req),
    http: (req) => ipcRenderer.invoke('http', req),
    info: () => ipcRenderer.sendSync('info-sync'),
    key: (keyCode, repeat) => ipcRenderer.send('key', String(keyCode), !!repeat),
    close: (quit) => ipcRenderer.send('close', !!quit),
    openExternal: (url) => ipcRenderer.send('open-external', String(url)),
    keepAwake: (on) => ipcRenderer.send('keep-awake', !!on),
    clearCookies: () => ipcRenderer.send('clear-cookies'),
    reload: () => ipcRenderer.send('reload')
});
