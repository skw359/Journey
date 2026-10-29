const fs = require('fs');
const path = require('path');
const log = require('./logger').scope('thumbs');

// sharp is optional: without it, thumbnail requests are answered with the
// full-size photo, exactly as before thumbnails existed.
let sharp = null;
try {
    sharp = require('sharp');
    // sharp's cache keeps recently read files open, and Windows can't delete or move a file
    // that's open. Thumbnails are cached on disk anyway.
    sharp.cache({ files: 0 });
} catch {
    log.warn('sharp is not installed; photo thumbnails fall back to full-size photos (run npm install)');
}

// Each size keeps the whole photo; the page crops it to its slot.
const THUMB_SIZES = {
    // Journey list card backgrounds: shown dimmed under an overlay, so a
    // 480px box is plenty
    card: { resize: { width: 480, height: 480, fit: 'inside' }, quality: 60, suffix: '-480' },
    // Photo gallery tiles: sharp on a 2x screen
    gallery: { resize: { width: 720 }, quality: 72, suffix: '' },
};
const THUMB_DIRNAME = 'thumbs';
// sharp can't read HEIC; those uploads get thumbnails once converted to JPEG.
const UNREADABLE = /\.hei[cf]$/i;

// One resize per photo, however many requests arrive while it runs
const inFlight = new Map();

// photos/user-1/abc.jpg -> photos/user-1/thumbs/abc-480.jpg, so deleting
// a user's photo folder takes their thumbnails with it.
function thumbPathFor(photoPath, size) {
    const name = `${path.parse(photoPath).name}${THUMB_SIZES[size].suffix}.jpg`;
    return path.join(path.dirname(photoPath), THUMB_DIRNAME, name);
}

/**
 * Path to a reduced JPEG of the photo at `photoPath` in one of THUMB_SIZES,
 * made on first request and kept on disk after that. Resolves to null when
 * sharp isn't available or can't read the file.
 */
async function getThumbnail(photoPath, size) {
    if (!sharp || UNREADABLE.test(photoPath)) return null;
    const { resize, quality } = THUMB_SIZES[size];
    const thumbPath = thumbPathFor(photoPath, size);
    if (fs.existsSync(thumbPath)) return thumbPath;
    if (inFlight.has(thumbPath)) return inFlight.get(thumbPath);

    const job = (async () => {
        await fs.promises.mkdir(path.dirname(thumbPath), { recursive: true });
        // Written aside and renamed into place, so a half-written file is never served
        const tmpPath = `${thumbPath}.${process.pid}.tmp`;
        try {
            await sharp(photoPath)
                .rotate() // apply the EXIF orientation before metadata is dropped
                .resize({ ...resize, withoutEnlargement: true })
                .jpeg({ quality, mozjpeg: true })
                .toFile(tmpPath);
            await fs.promises.rename(tmpPath, thumbPath);
        } catch (err) {
            await fs.promises.rm(tmpPath, { force: true });
            throw err;
        }
        return thumbPath;
    })().finally(() => inFlight.delete(thumbPath));

    inFlight.set(thumbPath, job);
    return job;
}

function deleteThumbnail(photoPath) {
    if (!photoPath) return;
    for (const size of Object.keys(THUMB_SIZES)) {
        const thumbPath = thumbPathFor(photoPath, size);
        try {
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        } catch (err) {
            log.error('could not delete thumbnail', err);
        }
    }
}

module.exports = { getThumbnail, deleteThumbnail };
