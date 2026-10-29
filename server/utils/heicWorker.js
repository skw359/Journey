const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

// Runs in a worker thread (see heic.js): libheif is WebAssembly and blocks whatever thread runs it.
(async () => {
    const { sourcePath, jpegQuality } = workerData;
    const buffer = await fs.promises.readFile(sourcePath);

    if (jpegQuality) {
        // Only used when sharp is unavailable: heic-convert's pure-JS encoder is several times slower.
        const jpeg = await require('heic-convert')({ buffer, format: 'JPEG', quality: jpegQuality });
        parentPort.postMessage({ jpeg });
        return;
    }

    // heic-decode is installed with heic-convert.
    const { width, height, data } = await require('heic-decode')({ buffer });
    parentPort.postMessage({ width, height, data }, [data.buffer]);
})();
