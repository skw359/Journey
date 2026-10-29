function formatDuration(seconds) {
    if (isNaN(seconds) || seconds < 0) return "0h 0m";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

// Same units as the client's formatBytes and pg_size_pretty: 2960802541 -> "2.8 GB".
function formatBytes(bytes) {
    const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, Number(bytes) || 0);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

module.exports = { formatDuration, formatBytes };
