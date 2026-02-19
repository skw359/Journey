const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const convert = require('heic-convert');
const { withTenantClient, queryTenant } = require('../db');
const { photoUpload } = require('../middleware/storage');
const { PHOTOS_DIR } = require('../config');
const { requireAuth } = require('../middleware/auth');

function resolvePhotoPath(filename) {
    const root = path.resolve(PHOTOS_DIR);
    const fullPath = path.resolve(path.join(PHOTOS_DIR, filename));
    if (fullPath === root || fullPath.startsWith(`${root}${path.sep}`)) {
        return fullPath;
    }
    return null;
}

function toStoredPhotoName(absPath) {
    const root = path.resolve(PHOTOS_DIR);
    const fullPath = path.resolve(absPath);
    if (!(fullPath === root || fullPath.startsWith(`${root}${path.sep}`))) {
        throw new Error('Invalid photo path');
    }
    return path.relative(root, fullPath).split(path.sep).join('/');
}

router.get(/^\/photos\/(.+)$/, requireAuth, async (req, res) => {
    const filename = req.params[0];
    try {
        const { rows } = await queryTenant(
            req.userId,
            'SELECT 1 FROM photos WHERE filename = $1 LIMIT 1',
            [filename]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Photo not found' });
        }

        const photoPath = resolvePhotoPath(filename);
        if (!photoPath || !fs.existsSync(photoPath)) {
            return res.status(404).json({ error: 'Photo not found' });
        }

        res.sendFile(photoPath);
    } catch (error) {
        console.error('Photo fetch error:', error);
        res.status(500).json({ error: 'Failed to load photo' });
    }
});

// POST /api/routes/:id/photos
router.post('/api/routes/:id/photos', requireAuth, photoUpload.array('photos', 250), async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows: routeCheck } = await db.query('SELECT 1 FROM routes WHERE id = $1', [req.params.id]);
            if (routeCheck.length === 0) {
                req.files.forEach((file) => fs.unlinkSync(file.path));
                return res.status(404).json({ error: 'Journey not found' });
            }

            const { rows: countResult } = await db.query(
                'SELECT COUNT(*) AS cnt FROM photos WHERE route_id = $1', [req.params.id]
            );
            const currentCount = parseInt(countResult[0].cnt, 10);

            if (currentCount + req.files.length > 250) {
                req.files.forEach((file) => fs.unlinkSync(file.path));
                return res.status(400).json({
                    error: 'Maximum 250 photos per journey',
                    currentCount,
                });
            }

            const newPhotos = [];
            let convertedCount = 0;

            for (const file of req.files) {
                const originalExt = path.extname(file.originalname).toLowerCase();
                const isHeic = file.mimetype === 'image/heic'
                    || file.mimetype === 'image/heif'
                    || originalExt === '.heic'
                    || originalExt === '.heif';

                let finalPath = file.path;
                let finalSize = file.size;

                if (isHeic) {
                    try {
                        const inputBuffer = await fs.promises.readFile(file.path);
                        const outputBuffer = await convert({
                            buffer: inputBuffer,
                            format: 'JPEG',
                            quality: 0.9,
                        });

                        const newFilename = `${crypto.randomBytes(16).toString('hex')}.jpg`;
                        const newPath = path.join(path.dirname(file.path), newFilename);
                        await fs.promises.writeFile(newPath, outputBuffer);
                        fs.unlinkSync(file.path);

                        finalPath = newPath;
                        finalSize = outputBuffer.length;
                        convertedCount += 1;
                        console.log(`Converted HEIC to JPEG: ${file.originalname} -> ${newFilename}`);
                    } catch (conversionError) {
                        console.error('HEIC conversion failed:', conversionError);
                        if (fs.existsSync(file.path)) {
                            fs.unlinkSync(file.path);
                        }
                        continue;
                    }
                }

                const storedFilename = toStoredPhotoName(finalPath);
                const photoId = `photo-${crypto.randomBytes(8).toString('hex')}`;
                const uploadedAt = new Date().toISOString();
                const mimetype = isHeic ? 'image/jpeg' : file.mimetype;

                await db.query(`
                    INSERT INTO photos (id, route_id, filename, original_name, mimetype, size, uploaded_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [photoId, req.params.id, storedFilename, file.originalname, mimetype, finalSize, uploadedAt]);

                newPhotos.push({
                    id: photoId,
                    filename: storedFilename,
                    originalName: file.originalname,
                    size: finalSize,
                    uploadedAt,
                    mimetype,
                });
            }

            res.json({
                message: 'Photos uploaded successfully',
                photos: newPhotos,
                totalPhotos: currentCount + newPhotos.length,
                converted: convertedCount,
            });
        });
    } catch (error) {
        console.error('Photo upload error:', error);
        if (req.files) {
            req.files.forEach((file) => {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
        }
        res.status(500).json({ error: 'Failed to upload photos' });
    }
});

// DELETE /api/routes/:id/photos/:photoId
router.delete('/api/routes/:id/photos/:photoId', requireAuth, async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query(
                'DELETE FROM photos WHERE id = $1 AND route_id = $2 RETURNING filename',
                [req.params.photoId, req.params.id]
            );

            if (rows.length === 0) {
                const { rows: routeCheck } = await db.query('SELECT 1 FROM routes WHERE id = $1', [req.params.id]);
                if (routeCheck.length === 0) {
                    return res.status(404).json({ error: 'Journey not found' });
                }
                return res.status(404).json({ error: 'Photo not found' });
            }

            const photoPath = resolvePhotoPath(rows[0].filename);
            if (photoPath && fs.existsSync(photoPath)) {
                fs.unlinkSync(photoPath);
            }

            res.json({ message: 'Photo deleted successfully' });
        });
    } catch (error) {
        console.error('Photo deletion error:', error);
        res.status(500).json({ error: 'Failed to delete photo' });
    }
});

module.exports = router;
