#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const net = require('net');
const { pool, initSchema } = require('../db');
const { PORT, PHOTOS_DIR } = require('../config');
const mediaStorage = require('../utils/mediaStorage');
const mediaMove = require('../utils/mediaMove');
const { listExternalDrives } = require('../utils/drives');
const { formatBytes } = require('../utils/format');

const USAGE = `Moves every Journey photo and video to one place. Stop the Journey server first.

  node server/scripts/move-attachments.js --list
  node server/scripts/move-attachments.js --to "Drive 2" [--dry-run]
  node server/scripts/move-attachments.js --to E: [--dry-run]
  node server/scripts/move-attachments.js --to internal [--dry-run]

--to takes an external drive's label or letter, or "internal" for this PC. Files go in a
"journey" folder on the drive. Each one is copied, checked against the original (SHA-256),
and only then removed from its old place, so it's safe to stop and run again.`;

const INTERNAL_NAMES = new Set(['internal', 'this-pc', 'this pc', 'local']);

function parseArgs(argv) {
    const args = { list: false, dryRun: false, to: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--list') args.list = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--to') args.to = argv[++i] ?? null;
        else if (arg.startsWith('--to=')) args.to = arg.slice(5);
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    return args;
}

function serverIsRunning(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.setTimeout(1500);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(false));
    });
}

function findDrive(drives, wanted) {
    const value = wanted.trim().toLowerCase();
    const letter = value.replace(/:\\?$/, '');
    return drives.find((drive) => drive.label.toLowerCase() === value)
        || (letter.length === 1 ? drives.find((drive) => drive.letter.toLowerCase() === letter) : undefined);
}

function describeDrive(drive) {
    const health = drive.healthy ? '' : ` · ${drive.status}`;
    return `${drive.label} (${drive.letter}:)  ${drive.bus} · ${drive.fileSystem} · ` +
        `${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)}${health}`;
}

async function printOverview(drives) {
    const location = mediaStorage.currentLocation();
    console.log(`Attachments are stored on ${location.name}: ${location.path}${location.online ? '' : ' (not connected)'}`);
    for (const place of (await mediaStorage.inventory()).places) {
        const count = place.files == null ? 'unknown (not connected)' : `${place.files} files, ${formatBytes(place.bytes)}`;
        console.log(`  still on ${place.name}: ${count}`);
    }
    console.log('\nExternal drives:');
    if (drives.length === 0) console.log('  none detected');
    for (const drive of drives) console.log(`  ${describeDrive(drive)}`);
}

function progressPrinter() {
    let last = 0;
    return (status, force = false) => {
        const now = Date.now();
        if (!force && now - last < 1000) return;
        last = now;
        const done = status.bytesDone + (status.current?.bytesDone || 0);
        const pct = status.bytesTotal > 0 ? Math.min(100, (done / status.bytesTotal) * 100) : 100;
        const current = status.current ? `  ${status.current.step} ${status.current.name}` : '';
        const line = `${pct.toFixed(1).padStart(5)}%  ${status.filesDone}/${status.filesTotal} files  ` +
            `${formatBytes(done)} of ${formatBytes(status.bytesTotal)}${current}`;
        if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line.slice(0, (process.stdout.columns || 120) - 1)}`);
        else console.log(line);
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.list && !args.to)) {
        console.log(USAGE);
        return args.help ? 0 : 1;
    }
    if (await serverIsRunning(PORT)) {
        console.error(`Journey is running on port ${PORT}. Stop it first, or change the location in Settings > Attachment storage.`);
        return 1;
    }

    await initSchema();
    await mediaStorage.init();
    const drives = await listExternalDrives({ refresh: true });
    if (args.list) {
        await printOverview(drives);
        return 0;
    }

    let target;
    let targetDir;
    let targetName;
    if (INTERNAL_NAMES.has(args.to.trim().toLowerCase())) {
        target = { kind: 'internal' };
        targetDir = PHOTOS_DIR;
        targetName = 'This PC';
    } else {
        const drive = findDrive(drives, args.to);
        if (!drive) {
            console.error(`No external drive matches "${args.to}".\n`);
            await printOverview(drives);
            return 1;
        }
        if (!drive.healthy) {
            console.error(`${drive.label} (${drive.letter}:) reports "${drive.status}". Repair it in Windows first.`);
            return 1;
        }
        target = { kind: 'drive', volumeId: drive.id };
        targetDir = `${drive.letter}:\\journey`;
        targetName = `${drive.label} (${drive.letter}:)`;
    }

    const plan = await mediaStorage.planMove(targetDir);
    console.log(`Moving attachments to ${targetName}: ${targetDir}`);
    for (const source of plan.sources) {
        console.log(`  from ${source.path}: ${source.files} files, ${formatBytes(source.bytes)}`);
    }
    console.log(`  ${plan.files} files, ${formatBytes(plan.bytes)} in all; needs ${formatBytes(plan.neededBytes)} ` +
        `(cluster rounding + 1 GB headroom), ${formatBytes(plan.freeBytes)} free`);
    if (plan.freeBytes < plan.neededBytes) {
        console.error('Not enough free space.');
        return 1;
    }
    if (args.dryRun) {
        console.log('Dry run: nothing was changed.');
        return 0;
    }

    await mediaStorage.selectLocation(target);
    if (mediaStorage.isPaused()) await mediaStorage.setPaused(false);
    console.log(`New attachments now go to ${mediaStorage.currentLocation().name}. Moving existing files...`);
    const print = progressPrinter();
    const result = await mediaMove.drain({ onProgress: print });
    print(result, true);
    if (process.stdout.isTTY) process.stdout.write('\n');

    if (result.phase === 'idle' && result.failedCount === 0) {
        console.log(`Done: moved ${result.filesDone} files (${formatBytes(result.bytesDone)}), each checked against its original.`);
        return 0;
    }
    console.error(`Stopped: ${result.error || result.reason || result.phase}`);
    for (const failure of result.failed) console.error(`  ${failure.name}: ${failure.error}`);
    console.error('Run the same command again to retry; files already moved are skipped.');
    return 1;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
        console.error(`move-attachments failed: ${err.message || err}`);
        process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
