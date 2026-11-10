const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

// Runs in a worker thread (see heic.js): libheif is WebAssembly and blocks whatever thread runs it.
(async () => {
    const { sourcePath, jpegQuality, maxPixels } = workerData;
    const buffer = await fs.promises.readFile(sourcePath);

    // heic-decode is installed with heic-convert. `all` reads the sizes without decoding.
    const decode = require('heic-decode');
    const images = await decode.all({ buffer });
    const image = images[0];
    try {
        if (image.width * image.height > maxPixels) {
            parentPort.postMessage({ error: `This photo is ${image.width} x ${image.height}, which is too large to convert` });
            return;
        }

        if (jpegQuality) {
            // Only used when sharp is unavailable: heic-convert's pure-JS encoder is several times slower.
            const jpeg = await require('heic-convert')({ buffer, format: 'JPEG', quality: jpegQuality });
            parentPort.postMessage({ jpeg });
            return;
        }

        const { width, height, data } = await image.decode();
        parentPort.postMessage({ width, height, data }, [data.buffer]);
    } finally {
        images.dispose?.();
    }
})();
