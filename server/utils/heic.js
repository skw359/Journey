const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

let sharp = null;
try {
    sharp = require('sharp');
} catch {
    // The worker encodes the JPEG itself instead (see heicWorker.js).
}

const JPEG_QUALITY = 90;
const WORKER_PATH = path.join(__dirname, 'heicWorker.js');

function runWorker(workerData, onWorker) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_PATH, { workerData });
        onWorker?.(worker);
        worker.once('message', resolve);
        worker.once('error', reject);
        // Only reached without a result when the worker is terminated or dies.
        worker.once('exit', (code) => reject(new Error(`HEIC decoder exited with code ${code}`)));
    });
}

// Writes a JPEG of the HEIC/HEIF at `sourcePath` to `outputPath`. Decoding a 48 MP iPhone photo
// takes seconds, so it happens in a worker thread; sharp then encodes off the event loop.
// `onWorker` receives the Worker so a caller can terminate it to cancel.
async function heicToJpeg(sourcePath, outputPath, onWorker) {
    const result = await runWorker({ sourcePath, jpegQuality: sharp ? null : JPEG_QUALITY / 100 }, onWorker);
    if (result.jpeg) {
        await fs.promises.writeFile(outputPath, result.jpeg);
        return;
    }

    const { width, height, data } = result;
    await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
        .removeAlpha()
        // sharp's default 4:2:0 chroma matches the HEVC source, so it costs no detail
        .jpeg({ quality: JPEG_QUALITY })
        .toFile(outputPath);
}

module.exports = { heicToJpeg };
