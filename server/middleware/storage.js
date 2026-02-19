const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PHOTOS_DIR, UPLOADS_DIR } = require('../config');

const upload = multer({ dest: UPLOADS_DIR });

const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userSubdir = req.userId ? req.userId : 'unscoped';
        const userPhotoDir = path.join(PHOTOS_DIR, userSubdir);
        if (!fs.existsSync(userPhotoDir)) {
            fs.mkdirSync(userPhotoDir, { recursive: true });
        }
        cb(null, userPhotoDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const photoUpload = multer({
    storage: photoStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|heic|heif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype) ||
                        file.mimetype === 'image/heic' ||
                        file.mimetype === 'image/heif';

        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only HEIC and JPG images are allowed'));
        }
    }
});

module.exports = { upload, photoUpload };
