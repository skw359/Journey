#!/usr/bin/env node
/**
 * Builds the Journey web client into windows-app/build/renderer and bundles its web
 * fonts locally, so the desktop app renders pixel-identically with no network font
 * dependency. Never writes into ../client (uses an absolute Vite outDir).
 *
 *   node scripts/build-renderer.mjs
 *
 * Steps:
 *   1. `vite build` the client straight into build/renderer.
 *   2. Find every `@import url('https://fonts.googleapis.com/…')` in the built CSS,
 *      fetch it, download each referenced .woff2 into build/fonts, and inline the
 *      resolved @font-face rules with local journey://app/__fonts/ URLs.
 *   3. Ensure assets/icon.ico exists (via make-icon.py when Python is present).
 *   4. Write build/build-info.json (default server URL, version, timestamp).
 *
 * Font bundling is best-effort: if the network is unavailable the original Google
 * @import lines are left in place and simply load online at runtime.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');
const BUILD_DIR = path.join(APP_ROOT, 'build');
const RENDERER_DIR = path.join(BUILD_DIR, 'renderer');
const FONTS_DIR = path.join(BUILD_DIR, 'fonts');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function step(msg) { process.stdout.write(`\n▸ ${msg}\n`); }
function info(msg) { process.stdout.write(`  ${msg}\n`); }

/* ------------------------------- 1. vite build ------------------------------- */

function viteBuild() {
    step('Building web client (vite)…');
    if (!fs.existsSync(path.join(CLIENT_DIR, 'node_modules'))) {
        info('client/node_modules missing — running npm install in client/');
        const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: CLIENT_DIR, stdio: 'inherit', shell: true });
        if (install.status !== 0) throw new Error('client npm install failed');
    }
    fs.mkdirSync(RENDERER_DIR, { recursive: true });
    const res = spawnSync(
        'npx',
        ['vite', 'build', '--outDir', RENDERER_DIR, '--emptyOutDir'],
        { cwd: CLIENT_DIR, stdio: 'inherit', shell: true, env: { ...process.env } },
    );
    if (res.status !== 0) throw new Error('vite build failed');
    if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) throw new Error('vite build produced no index.html');
    info(`built → ${path.relative(APP_ROOT, RENDERER_DIR)}`);
}

/* ----------------------------- 2. bundle fonts ------------------------------ */

function listCssFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listCssFiles(p));
        else if (entry.name.endsWith('.css')) out.push(p);
    }
    return out;
}

async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
}

async function fetchBuffer(url) {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

async function bundleFonts() {
    step('Bundling web fonts locally…');
    const cssFiles = listCssFiles(RENDERER_DIR);
    // Matches both the source form `@import url('https://…');` and Vite's minified form
    // `@import"https://…";` (no url(), and the URL itself contains ';' from `wght@400;500`).
    const importRe = /@import\s*(?:url\(\s*)?(['"]?)(https:\/\/fonts\.googleapis\.com\/[^'")]+)\1\s*\)?\s*;?/g;

    // Collect the unique Google Fonts @import URLs across all built CSS.
    const importUrls = new Set();
    const fileText = new Map();
    for (const file of cssFiles) {
        const text = fs.readFileSync(file, 'utf8');
        fileText.set(file, text);
        for (const m of text.matchAll(importRe)) importUrls.add(m[2]);
    }
    if (importUrls.size === 0) { info('no Google Fonts @import found — nothing to bundle'); return; }

    fs.mkdirSync(FONTS_DIR, { recursive: true });
    const resolved = new Map(); // googleapis import URL -> inline @font-face css (local urls)
    const gstaticCache = new Map(); // remote woff2 url -> local filename

    for (const importUrl of importUrls) {
        try {
            let faceCss = await fetchText(importUrl);
            const urlRe = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g;
            const remoteUrls = [...faceCss.matchAll(urlRe)].map((m) => m[1]);
            for (const remote of remoteUrls) {
                let local = gstaticCache.get(remote);
                if (!local) {
                    const buf = await fetchBuffer(remote);
                    const ext = path.extname(new URL(remote).pathname) || '.woff2';
                    const name = createHash('sha1').update(remote).digest('hex').slice(0, 16) + ext;
                    fs.writeFileSync(path.join(FONTS_DIR, name), buf);
                    local = name;
                    gstaticCache.set(remote, local);
                }
                faceCss = faceCss.split(remote).join(`journey://app/__fonts/${local}`);
            }
            resolved.set(importUrl, faceCss);
        } catch (err) {
            info(`! could not bundle ${shortFont(importUrl)} — will load online (${err.message})`);
        }
    }

    if (gstaticCache.size > 0) info(`downloaded ${gstaticCache.size} font files → ${path.relative(APP_ROOT, FONTS_DIR)}`);

    // Rewrite the built CSS: replace each bundled @import with its inline @font-face css.
    let rewritten = 0;
    for (const [file, text] of fileText) {
        let changed = text.replace(importRe, (whole, _q, url) => {
            const css = resolved.get(url);
            if (css) { rewritten++; return `\n/* bundled: ${shortFont(url)} */\n${css}\n`; }
            return whole; // leave online import in place
        });
        if (changed !== text) fs.writeFileSync(file, changed);
    }
    info(`inlined ${rewritten} font import(s) across ${cssFiles.length} css file(s)`);
}

function shortFont(url) {
    try { return new URL(url).searchParams.get('family')?.split(':')[0] || url; } catch { return url; }
}

/* ------------------------------- 3. app icon -------------------------------- */

function ensureIcon() {
    step('Ensuring app icon…');
    const ico = path.join(APP_ROOT, 'assets', 'icon.ico');
    if (fs.existsSync(ico)) { info('assets/icon.ico present'); return; }
    for (const py of ['python', 'python3', 'py']) {
        const res = spawnSync(py, [path.join(APP_ROOT, 'scripts', 'make-icon.py')], { stdio: 'inherit', shell: true });
        if (res.status === 0 && fs.existsSync(ico)) { info('generated assets/icon.ico'); return; }
    }
    info('! could not generate icon.ico (Python/Pillow missing) — electron-builder will use a default');
}

/* ----------------------------- 4. build-info -------------------------------- */

function readEnvValue(file, key) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
    } catch { return ''; }
}

function writeBuildInfo() {
    step('Writing build-info.json…');
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    const publicUrl = process.env.JOURNEY_DEFAULT_SERVER
        || readEnvValue(path.join(REPO_ROOT, '.env'), 'PUBLIC_URL')
        || '';
    const info2 = {
        version: pkg.version,
        defaultServerUrl: (publicUrl || '').replace(/\/+$/, ''),
        builtAt: new Date().toISOString(),
    };
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUILD_DIR, 'build-info.json'), JSON.stringify(info2, null, 2));
    info(`default server: ${info2.defaultServerUrl || '(none — user picks on first run)'}`);
}

/* --------------------------------- main ------------------------------------ */

async function main() {
    viteBuild();
    await bundleFonts();
    ensureIcon();
    writeBuildInfo();
    step('Renderer build complete.');
}

main().catch((err) => { console.error('\nbuild-renderer failed:', err.message); process.exit(1); });
