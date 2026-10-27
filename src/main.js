// SmartTwitchTV Desktop — Electron main process.
// Serves the bundled web app from app://stv/ and implements the few things the
// Android APK did natively that a web page can't: CORS-free HTTP, real key events,
// window control and keeping the screen awake.
'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, session, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_ID = 'io.github.smarttwitchtv.Desktop';
const WEB_ROOT = path.join(__dirname, '..', 'web');
const START_URL = 'app://stv/index.html';

app.setName('SmartTwitchTV');
if (process.env.STV_PROFILE) app.setPath('userData', path.resolve(process.env.STV_PROFILE));
app.setDesktopName(APP_ID + '.desktop');

const args = new Set(process.argv.slice(1));
const startWindowed = args.has('--windowed');
const devTools = args.has('--devtools');
// Dev-only helpers (offline mock, smoke-test driver) are not shipped in packaged builds.
const DEV = !app.isPackaged;
const MOCK = DEV && !!process.env.STV_MOCK;

// Hardware video decode on Linux where available (VA-API). Harmless when unsupported.
app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,VaapiVideoDecoder');
// The app is driven by remote/controller: don't require a click before audio may play.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
]);

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

let win = null;
let keepAwakeId = null;

// A plain Chrome UA: Twitch serves the same content it serves to the browser.
function chromeUserAgent() {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function upstreamVersion() {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'desktop', 'upstream.json'), 'utf8'));
        return `${v.VersionBase}.${v.publishVersionCode}`;
    } catch {
        return '3.0.0';
    }
}

// ---- HTTP (mirror of Tools.MethodUrlHeaders in the APK) -------------------------------
// Returns the same JSON the Java side returned: {status, responseText, checkResult}
async function httpRequest({ url, timeout, body, method, headers, checkResult }) {
    if (MOCK) return require('./dev/mock')({ url, body, checkResult });
    const init = {
        method: method || (body != null ? 'POST' : 'GET'),
        headers: {},
        signal: AbortSignal.timeout(Math.max(1000, timeout || 10000)),
        redirect: 'follow'
    };
    if (Array.isArray(headers)) for (const [k, v] of headers) if (k) init.headers[k] = v;
    if (body != null) init.body = body;

    try {
        const res = await net.fetch(url, init);
        const text = await res.text();
        if (process.env.STV_DEBUG_HTTP) console.log('[http]', res.status, init.method, url.slice(0, 120));
        return { status: res.status, responseText: text, checkResult: checkResult || 0 };
    } catch (e) {
        if (process.env.STV_DEBUG_HTTP) console.log('[http] FAIL', init.method, url.slice(0, 120), String(e));
        return { status: 0, responseText: '', checkResult: checkResult || 0 };
    }
}

ipcMain.handle('http', (_e, req) => httpRequest(req));
// Synchronous variant: the renderer stays blocked until returnValue is set.
ipcMain.on('http-sync', (e, req) => {
    httpRequest(req).then((r) => (e.returnValue = r));
});

// ---- Input --------------------------------------------------------------------------
const KEY_REPEAT_SAFE = new Set(['Up', 'Down', 'Left', 'Right']);
ipcMain.on('key', (_e, keyCode, repeat) => {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode, isAutoRepeat: !!repeat && KEY_REPEAT_SAFE.has(keyCode) });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
});

// ---- Window & system ----------------------------------------------------------------
ipcMain.on('info-sync', (e) => {
    e.returnValue = {
        version: upstreamVersion(),
        appVersion: app.getVersion(),
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        debug: devTools
    };
});

ipcMain.on('close', (_e, quit) => {
    if (!win) return;
    if (quit) app.quit();
    else win.minimize();
});

ipcMain.on('open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.on('keep-awake', (_e, on) => {
    if (on && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && keepAwakeId !== null) {
        powerSaveBlocker.stop(keepAwakeId);
        keepAwakeId = null;
    }
});

ipcMain.on('clear-cookies', () => session.defaultSession.clearStorageData({ storages: ['cookies'] }));

ipcMain.on('reload', () => win && win.loadURL(START_URL));

const LOGIN_REDIRECT = 'https://fgl27.github.io/SmartTwitchTV/release/index.html';

function parseLoginRedirect(url) {
    if (!url.startsWith(LOGIN_REDIRECT)) return null;
    const u = new URL(url);
    return START_URL + u.search;
}

function isTwitchLoginUrl(url) {
    try {
        const { protocol, hostname } = new URL(url);
        return protocol === 'https:' && (hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv'));
    } catch {
        return false;
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 960,
        minHeight: 540,
        fullscreen: !startWindowed,
        backgroundColor: '#0e0e10',
        autoHideMenuBar: true,
        title: 'SmartTwitchTV',
        icon: path.join(__dirname, '..', 'build', 'icon.png'),
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            backgroundThrottling: false
        }
    });
    win.removeMenu();
    win.once('ready-to-show', () => win.show());

    const wc = win.webContents;

    // Keyboard → what the Android side sent the web app:
    //   Esc / Back (remote) → KEY_RETURN (F2), F11 → toggle fullscreen.
    wc.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            event.preventDefault();
        } else if (input.key === 'Escape' || input.key === 'BrowserBack' || input.key === 'GoBack') {
            event.preventDefault();
            // Back out of the Twitch login page into the app.
            if (!wc.getURL().startsWith('app://stv/')) {
                win.loadURL(START_URL);
                return;
            }
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'F2' });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'F2' });
        } else if (input.key === 'F12' && devTools) {
            wc.toggleDevTools();
        }
    });

    // Links never open inside the app window.
    wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    // Twitch login runs inside the window (keyboard/mouse). Twitch then redirects to the
    // upstream GitHub Pages URL with ?code=…; we hand that code back to the local app.
    const onNavigate = (event, url) => {
        if (url.startsWith('app://stv/')) return;
        const redirect = parseLoginRedirect(url);
        if (redirect) {
            event.preventDefault();
            win.loadURL(redirect);
        } else if (!isTwitchLoginUrl(url)) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    };
    wc.on('will-navigate', onNavigate);
    wc.on('will-redirect', onNavigate);

    if (DEV && process.env.STV_SMOKE) require('./smoke')(win);
    win.loadURL(START_URL);
    if (devTools) wc.openDevTools({ mode: 'detach' });
}

app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
});

app.whenReady().then(() => {
    app.userAgentFallback = chromeUserAgent();

    // Serve the bundled web app.
    protocol.handle('app', (request) => {
        const { pathname } = new URL(request.url);
        let root = WEB_ROOT;
        let rel = decodeURIComponent(pathname);
        if (MOCK && rel.startsWith('/__test/')) {
            root = path.join(__dirname, '..', 'dev-assets');
            rel = rel.slice('/__test'.length);
        }
        const file = path.normalize(path.join(root, rel));
        if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            if (DEV) console.warn('[app://] not found:', rel);
            return new Response('not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(file).toString());
    });

    // hls.js runs in the page and fetches playlists/segments from Twitch's CDN.
    // Make sure those cross-origin responses are readable from app://stv.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders || {};
        const hasAcao = Object.keys(headers).some((k) => k.toLowerCase() === 'access-control-allow-origin');
        if (!hasAcao && /^https:\/\//.test(details.url)) {
            headers['Access-Control-Allow-Origin'] = ['*'];
        }
        callback({ responseHeaders: headers });
    });

    // The app never needs camera/mic/geolocation etc.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));

    createWindow();
});

app.on('window-all-closed', () => app.quit());
