'use strict';

const fs = require('fs');
const path = require('path');

const USE_S3 = Boolean(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
);

const LOCAL_DIR = path.join(__dirname, 'uploads');
const LOCAL_PHOTOS = path.join(LOCAL_DIR, 'photos');

let s3Client = null;
if (USE_S3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined,
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
} else {
    if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
    if (!fs.existsSync(LOCAL_PHOTOS)) fs.mkdirSync(LOCAL_PHOTOS, { recursive: true });
}

function uniqueName(ext) {
    return Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
}

function objectKey(prefix, storedName) {
    return `${prefix}/${storedName}`;
}

function resolvePrefix(storedName) {
    if (storedName.startsWith('photo-')) return 'photos';
    if (storedName.startsWith('kp-')) return 'kp';
    return 'drawings';
}

function isRemote() {
    return USE_S3;
}

async function saveFile(file, prefix) {
    const ext = path.extname(file.originalname).toLowerCase();
    const prefixName = prefix === 'kp' ? 'kp-' : prefix === 'photos' ? 'photo-' : '';
    const storedName = prefixName + uniqueName(ext);
    const key = objectKey(prefix, storedName);

    if (USE_S3) {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype || 'application/octet-stream',
        }));
    } else {
        const dir = prefix === 'photos' ? LOCAL_PHOTOS : LOCAL_DIR;
        fs.writeFileSync(path.join(dir, storedName), file.buffer);
    }

    return { originalName: file.originalname, storedName, key };
}

async function deleteStored(storedName) {
    if (!storedName) return;
    const prefix = resolvePrefix(storedName);
    const key = objectKey(prefix, storedName);

    if (USE_S3) {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
        }));
    } else {
        const dir = prefix === 'photos' ? LOCAL_PHOTOS : LOCAL_DIR;
        const filepath = path.join(dir, storedName);
        if (fs.existsSync(filepath)) fs.unlink(filepath, () => {});
    }
}

function mimeFromName(name) {
    const ext = path.extname(String(name || '')).toLowerCase();
    const map = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
    };
    return map[ext] || null;
}

async function streamToResponse(storedName, res, downloadName, options = {}) {
    const inline = Boolean(options.inline);
    const prefix = resolvePrefix(storedName);
    const key = objectKey(prefix, storedName);
    const label = downloadName || storedName;

    if (USE_S3) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const result = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
        }));
        const mime = result.ContentType || mimeFromName(label);
        if (mime) res.setHeader('Content-Type', mime);
        if (downloadName) {
            const disp = inline ? 'inline' : 'attachment';
            res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(downloadName)}"`);
        }
        result.Body.pipe(res);
        return;
    }

    const dir = prefix === 'photos' ? LOCAL_PHOTOS : LOCAL_DIR;
    const filepath = path.join(dir, storedName);
    if (!fs.existsSync(filepath)) {
        res.status(404).json({ error: 'Файл не найден' });
        return;
    }
    const mime = mimeFromName(label);
    if (mime) res.setHeader('Content-Type', mime);
    if (downloadName) {
        const disp = inline ? 'inline' : 'attachment';
        res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(downloadName)}"`);
        res.sendFile(filepath);
        return;
    }
    res.sendFile(filepath);
}

function existsLocally(storedName) {
    const prefix = resolvePrefix(storedName);
    const dir = prefix === 'photos' ? LOCAL_PHOTOS : LOCAL_DIR;
    return fs.existsSync(path.join(dir, storedName));
}

function photoPublicUrl(storedName) {
    const publicBase = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
    if (USE_S3 && publicBase) {
        return `${publicBase}/photos/${encodeURIComponent(storedName)}`;
    }
    return `/api/company-photos/${encodeURIComponent(storedName)}`;
}

module.exports = {
    isRemote,
    saveFile,
    deleteStored,
    streamToResponse,
    existsLocally,
    photoPublicUrl,
    LOCAL_DIR,
    LOCAL_PHOTOS,
};
