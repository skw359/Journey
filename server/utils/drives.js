const { execFile } = require('child_process');

// Windows reports USB hard drives as "Fixed" disks, so external drives are told apart by the
// bus their disk is on. Keys are MSFT_Disk.BusType codes.
const EXTERNAL_BUSES = { 4: '1394', 7: 'USB', 12: 'SD', 13: 'MMC' };
const BUS_CODES = { 1394: 4, USB: 7, SD: 12, MMC: 13 };
const HEALTH_CODES = { Healthy: 0, Warning: 1, Unhealthy: 2 };
const OPERATIONAL_LABELS = { 53261: 'Scan needed', 53262: 'Spot fix needed', 53263: 'Repair needed' };
const OPERATIONAL_OK = 2;
const CACHE_MS = 10_000;

const SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ns = 'root/Microsoft/Windows/Storage'
@{
  disks = @(Get-CimInstance -Namespace $ns -ClassName MSFT_Disk | Select-Object Number, FriendlyName, BusType, IsBoot, IsSystem)
  parts = @(Get-CimInstance -Namespace $ns -ClassName MSFT_Partition | Where-Object { [int]$_.DriveLetter -ne 0 } | Select-Object DiskNumber, @{n='DriveLetter';e={[string]$_.DriveLetter}}, Guid)
  vols = @(Get-CimInstance -Namespace $ns -ClassName MSFT_Volume | Where-Object { [int]$_.DriveLetter -ne 0 } | Select-Object @{n='DriveLetter';e={[string]$_.DriveLetter}}, FileSystemLabel, FileSystem, Size, SizeRemaining, HealthStatus, OperationalStatus)
} | ConvertTo-Json -Compress -Depth 4
`;

const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

// A fresh powershell.exe returns enums as numbers, one with the Storage module loaded as names.
const busCode = (value) => (typeof value === 'number' ? value : BUS_CODES[value]);
const healthCode = (value) => (typeof value === 'number' ? value : HEALTH_CODES[value]);
const operationalCode = (value) => (typeof value === 'number' ? value : value === 'OK' ? OPERATIONAL_OK : null);

function parseDrives(json) {
    const data = JSON.parse(json);
    const disks = new Map(asList(data.disks).map((disk) => [Number(disk.Number), disk]));
    const parts = new Map(asList(data.parts).map((part) => [String(part.DriveLetter).toUpperCase(), part]));
    const drives = [];

    for (const vol of asList(data.vols)) {
        const letter = String(vol.DriveLetter || '').toUpperCase();
        const part = parts.get(letter);
        const disk = part && disks.get(Number(part.DiskNumber));
        const bus = disk && EXTERNAL_BUSES[busCode(disk.BusType)];
        if (!bus || disk.IsBoot || disk.IsSystem || !vol.FileSystem) continue;

        const operational = asList(vol.OperationalStatus).map(operationalCode);
        const healthy = healthCode(vol.HealthStatus) === 0 && operational.includes(OPERATIONAL_OK);
        const problem = operational.map((code) => OPERATIONAL_LABELS[code]).find(Boolean);
        drives.push({
            id: String(part.Guid || '').toLowerCase(),
            letter,
            label: vol.FileSystemLabel || `${letter}:`,
            fileSystem: vol.FileSystem,
            model: disk.FriendlyName || null,
            bus,
            totalBytes: Number(vol.Size) || 0,
            freeBytes: Number(vol.SizeRemaining) || 0,
            healthy,
            status: healthy ? 'OK' : (problem || 'Needs attention'),
        });
    }
    return drives.sort((a, b) => a.letter.localeCompare(b.letter));
}

function runPowerShell(script) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
        );
    });
}

let cache = null;
let inFlight = null;

// External volumes that have a drive letter. Takes ~2 s (PowerShell startup), so results are
// cached briefly and concurrent callers share one scan.
async function listExternalDrives({ refresh = false } = {}) {
    if (process.platform !== 'win32') return [];
    if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.drives;
    if (!inFlight) {
        inFlight = runPowerShell(SCRIPT)
            .then((stdout) => {
                cache = { at: Date.now(), drives: parseDrives(stdout) };
                return cache.drives;
            })
            .finally(() => { inFlight = null; });
    }
    return inFlight;
}

module.exports = { listExternalDrives, parseDrives };
