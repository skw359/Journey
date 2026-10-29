'use strict';

/**
 * Journey desktop — Electron main process.
 *
 * The whole web client runs unmodified inside one BrowserWindow served from the
 * privileged `journey://app` origin. A single protocol handler (router.js) serves the
 * bundled SPA, answers the Atlas + detail endpoints from an in-memory store, and proxies
 * everything else to the real Journey server through the window's cookie jar.
 */

const path = require('path');
const { app, BrowserWindow, protocol, session, ipcMain, shell, nativeTheme, Menu } = require('electron');

const config = require('./config');
const logger = require('./log');
const { createStaticServer } = require('./static');
const { RouteStore } = require('./data/store');
const { Proxy } = require('./proxy');
const { MediaCache } = require('./media-cache');
const { DataService } = require('./data-service');
const { createRouter } = require('./router');

const APP_ROOT = config.APP_ROOT;
const SCHEME = 'journey';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;
const DEV = process.argv.includes('--dev') || !app.isPackaged;

const DIST_DIR = path.join(APP_ROOT, 'build', 'renderer');
const FONTS_DIR = path.join(APP_ROOT, 'build', 'fonts');
const SETUP_DIR = path.join(__dirname, '..', 'renderer-setup');

let log;
let mainWindow = null;
let proxy;
let dataService;
let store;
let mediaCache;
let router;

// Single instance — a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    main();
}

function main() {
    // Must run before app is ready.
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: {
            standard: true,        // real origin: history.pushState, localStorage, relative URLs
            secure: true,          // treated as a secure context (clipboard, etc.)
            supportFetchAPI: true, // fetch('/api/...') works
            corsEnabled: true,
            stream: true,          // streamed responses (Marco SSE, large payloads)
            codeCache: true,
        },
    }]);

    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(onReady).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('startup failed', err);
        app.quit();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });

    app.on('before-quit', () => {
        try { dataService?.dispose(); } catch { /* noop */ }
    });
}

async function onReady() {
    logger.init({ dir: path.join(app.getPath('userData'), 'logs'), dev: DEV });
    log = logger.scope('main');
    const cfg = config.load();
    log.info(`Journey desktop ${app.getVersion()} · server=${cfg.serverUrl || '(unset)'} · dev=${DEV}`);

    const ses = session.defaultSession;

    // Core singletons.
    store = new RouteStore();
    store.detailLimitBytes = Math.max(64, Number(cfg.detailCacheMB) || 768) * 1024 * 1024;
    mediaCache = new MediaCache({ limitBytes: Math.max(32, Number(cfg.mediaCacheMB) || 512) * 1024 * 1024 });
    proxy = new Proxy({ getServerUrl: () => config.load().serverUrl, session: ses, log: logger.scope('proxy') });
    dataService = new DataService({ proxy, store, log: logger.scope('data'), getConfig: () => config.load() });

    const staticApp = createStaticServer({ root: DIST_DIR, spa: true });
    const staticSetup = createStaticServer({ root: SETUP_DIR, spa: false });
    const staticFonts = createStaticServer({ root: FONTS_DIR, spa: false, prefix: '/__fonts' });

    router = createRouter({
        staticApp,
        staticFonts,
        store,
        proxy,
        dataService,
        mediaCache,
        log: logger.scope('router'),
        onAuthStatus: (body) => dataService.onAuthStatus(body),
    });

    // The one protocol handler. The setup page lives at /__setup/*.
    protocol.handle(SCHEME, async (request) => {
        try {
            const url = new URL(request.url);
            if (url.pathname.startsWith('/__setup')) {
                const rel = url.pathname === '/__setup' || url.pathname === '/__setup/'
                    ? '/setup.html'
                    : url.pathname.replace(/^\/__setup/, '');
                const res = await staticSetup.serve(rel);
                return res || new Response('not found', { status: 404 });
            }
            return await router.handle(request);
        } catch (err) {
            log.error('handler error', err);
            return new Response(JSON.stringify({ error: 'Internal error', detail: String(err && err.message) }), {
                status: 500, headers: { 'content-type': 'application/json' },
            });
        }
    });

    dataService.on('changed', (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('journey:data-status', status);
        }
    });

    registerIpc();
    Menu.setApplicationMenu(buildMenu());
    createMainWindow();
}

function createMainWindow() {
    const cfg = config.load();
    const bounds = cfg.windowState || {};
    mainWindow = new BrowserWindow({
        width: bounds.width || 1440,
        height: bounds.height || 900,
        x: bounds.x,
        y: bounds.y,
        minWidth: 940,
        minHeight: 600,
        backgroundColor: '#000000', // matches the app's true-black dark theme, no white flash
        show: false,
        autoHideMenuBar: true,
        title: 'Journey',
        icon: path.join(APP_ROOT, 'assets', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: true,
            backgroundThrottling: false, // keep animations/Marco typing alive when hidden
        },
    });

    if (bounds.maximized) mainWindow.maximize();

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', saveWindowState);

    // Diagnostic self-check: JOURNEY_SMOKE=<pngPath> renders the window headlessly, waits
    // for the SPA to paint, writes a screenshot and exits. Used by the build's launch test.
    if (process.env.JOURNEY_SMOKE) {
        mainWindow.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                try {
                    const img = await mainWindow.webContents.capturePage();
                    require('fs').writeFileSync(process.env.JOURNEY_SMOKE, img.toPNG());
                    log.info(`smoke screenshot → ${process.env.JOURNEY_SMOKE}`);
                } catch (err) {
                    log.error('smoke capture failed', err);
                    app.exit(1);
                    return;
                }
                app.exit(0);
            }, Number(process.env.JOURNEY_SMOKE_DELAY || 3500));
        });
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
    });

    // Keep the main window on the app origin; hand off external links.
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
        handleNavigation(event, targetUrl, mainWindow);
    });

    const startUrl = config.load().serverUrl ? `${ORIGIN}/` : `${ORIGIN}/__setup`;
    mainWindow.loadURL(startUrl);

    if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

/** Decide what to do with a top-level navigation the renderer initiated. */
function handleNavigation(event, targetUrl, win) {
    let u;
    try { u = new URL(targetUrl); } catch { return; }

    // Any other same-origin navigation (SPA routing uses pushState, not full nav) is fine.
    if (u.origin === ORIGIN) return;

    // External http(s) — e.g. the map attribution links — open in the default browser.
    event.preventDefault();
    openExternal(targetUrl);
}

function openExternal(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
            shell.openExternal(url);
        }
    } catch { /* ignore malformed */ }
}

function saveWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const b = maximized ? (mainWindow._restoreBounds || mainWindow.getBounds()) : mainWindow.getBounds();
    config.save({ windowState: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } });
}

/* -------------------------------- IPC bridge -------------------------------- */

function registerIpc() {
    ipcMain.handle('journey:get-info', () => ({
        version: app.getVersion(),
        serverUrl: config.load().serverUrl,
        defaultServerUrl: config.getBuildInfo().defaultServerUrl || '',
        prefetchDetails: config.load().prefetchDetails,
        detailCacheMB: config.load().detailCacheMB,
        mediaCacheMB: config.load().mediaCacheMB,
        platform: process.platform,
        dev: DEV,
        dataStatus: dataService ? dataService.status() : null,
    }));

    ipcMain.handle('journey:test-server', async (_e, rawUrl) => {
        const url = config.normalizeServerUrl(rawUrl);
        if (!url) return { ok: false, error: 'Enter a valid http(s) URL or host.' };
        try {
            const ping = await proxyProbe(url, '/ping');
            const okPing = ping.status === 200 && (await ping.text()).trim() === 'pong';
            if (!okPing) return { ok: false, url, error: `Server responded ${ping.status} (not a Journey server?)` };
            const statusRes = await proxyProbe(url, '/api/auth/status');
            let statusBody = null;
            try { statusBody = JSON.parse(await statusRes.text()); } catch { /* ignore */ }
            return { ok: true, url, isSetup: !!statusBody?.isSetup, isAuthenticated: !!statusBody?.isAuthenticated };
        } catch (err) {
            return { ok: false, url, error: err.message };
        }
    });

    ipcMain.handle('journey:save-server', async (_e, rawUrl) => {
        const url = config.normalizeServerUrl(rawUrl);
        if (!url) return { ok: false, error: 'Invalid URL' };
        config.save({ serverUrl: url });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(`${ORIGIN}/`);
        return { ok: true, url };
    });

    ipcMain.handle('journey:set-prefs', async (_e, prefs) => {
        const next = {};
        if (typeof prefs.prefetchDetails === 'boolean') next.prefetchDetails = prefs.prefetchDetails;
        if (Number.isFinite(prefs.detailCacheMB)) next.detailCacheMB = Math.max(64, prefs.detailCacheMB);
        if (Number.isFinite(prefs.mediaCacheMB)) next.mediaCacheMB = Math.max(32, prefs.mediaCacheMB);
        config.save(next);
        if (next.mediaCacheMB) mediaCache.setLimit(next.mediaCacheMB * 1024 * 1024);
        if (next.detailCacheMB) store.detailLimitBytes = next.detailCacheMB * 1024 * 1024;
        if (next.prefetchDetails && dataService.phase === 'ready') dataService.startPrefetch();
        return { ok: true, config: config.load() };
    });

    ipcMain.handle('journey:data-status', () => (dataService ? dataService.status() : null));

    ipcMain.handle('journey:open-external', (_e, url) => { openExternal(url); return true; });

    ipcMain.handle('journey:reload', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(`${ORIGIN}/`);
        return true;
    });

    ipcMain.handle('journey:open-logs', () => {
        if (logger.filePath) shell.showItemInFolder(logger.filePath);
        return true;
    });
}

/** One-off probe of a candidate server (used by the setup page before it's saved). */
async function proxyProbe(baseUrl, pathAndQuery) {
    const { net } = require('electron');
    return net.fetch(baseUrl + pathAndQuery, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*', 'accept-encoding': 'identity' },
        bypassCustomProtocolHandlers: true,
    });
}

function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                { label: 'Change Server…', click: () => mainWindow && mainWindow.loadURL(`${ORIGIN}/__setup`) },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { label: 'Home', accelerator: 'Alt+Home', click: () => mainWindow && mainWindow.loadURL(`${ORIGIN}/`) },
                { role: 'reload' },
                { role: 'forceReload' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { role: 'toggleDevTools' },
            ],
        },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                { label: 'Open Log Folder', click: () => logger.filePath && shell.showItemInFolder(logger.filePath) },
                { label: 'Journey Website', click: () => { const s = config.load().serverUrl; if (s) openExternal(s); } },
            ],
        },
    ];
    return Menu.buildFromTemplate(template);
}
