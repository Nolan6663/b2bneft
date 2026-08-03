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
    if (storedName.startsWith('video-')) return 'videos';
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

/* Видео весит сотни мегабайт, поэтому оно не проходит через память процесса:
   multer кладёт его во временный файл на диске, а отсюда файл уходит в
   хранилище потоком. Одиночный PUT с известной длиной, без multipart —
   ради этого не тянем ещё одну зависимость. */
async function saveStreamFile({ tmpPath, originalName, mimetype }, prefix) {
    const ext = path.extname(originalName || '').toLowerCase();
    const prefixName = prefix === 'videos' ? 'video-' : prefix === 'kp' ? 'kp-' : prefix === 'photos' ? 'photo-' : '';
    const storedName = prefixName + uniqueName(ext);
    const key = objectKey(prefix, storedName);
    const size = fs.statSync(tmpPath).size;

    if (USE_S3) {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: fs.createReadStream(tmpPath),
            ContentLength: size,
            ContentType: mimetype || 'application/octet-stream',
        }));
        fs.unlink(tmpPath, () => {});
    } else {
        const dir = prefix === 'photos' ? LOCAL_PHOTOS : LOCAL_DIR;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(tmpPath, path.join(dir, storedName));
    }

    return { originalName, storedName, key, size };
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
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.m4v': 'video/x-m4v',
    };
    return map[ext] || null;
}

async function streamToResponse(storedName, res, downloadName, options = {}) {
    const inline = Boolean(options.inline);
    const prefix = resolvePrefix(storedName);
    const key = objectKey(prefix, storedName);
    const label = downloadName || storedName;
    /* Range нужен видео: без него плеер не мотает и на длинном ролике
       вынужден скачивать всё с начала. Заголовок приходит от браузера и
       просто прокидывается в хранилище. */
    const range = options.range || null;

    if (USE_S3) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        try {
            const result = await s3Client.send(new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: key,
                ...(range ? { Range: range } : {}),
            }));
            if (range && result.ContentRange) {
                res.status(206);
                res.setHeader('Content-Range', result.ContentRange);
                res.setHeader('Accept-Ranges', 'bytes');
                if (result.ContentLength != null) res.setHeader('Content-Length', String(result.ContentLength));
            } else if (result.ContentLength != null) {
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Length', String(result.ContentLength));
            }
            const mime = result.ContentType || mimeFromName(label);
            if (mime) res.setHeader('Content-Type', mime);
            if (downloadName) {
                const disp = inline ? 'inline' : 'attachment';
                res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(downloadName)}"`);
            }
            result.Body.pipe(res);
        } catch (e) {
            const code = e?.name || e?.Code || '';
            if (code === 'NoSuchKey' || code === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
                res.status(404).json({ error: 'Файл не найден' });
                return;
            }
            throw e;
        }
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

/**
 * Байты файла в память — для разбора чертежа моделью. Отдельно от
 * streamToResponse: там поток уходит клиенту, здесь он нужен серверу.
 * Лимит обязателен: в хранилище лежат сборочные чертежи в десятки мегабайт,
 * а тянуть их целиком в память ради разбора незачем.
 */
async function readFileBuffer(storedName, { maxBytes = 15 * 1024 * 1024 } = {}) {
    const prefix = resolvePrefix(storedName);
    const key = objectKey(prefix, storedName);

    if (USE_S3) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const result = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
        }));
        const chunks = [];
        let size = 0;
        for await (const chunk of result.Body) {
            size += chunk.length;
            if (size > maxBytes) {
                const err = new Error('Файл слишком большой для разбора');
                err.code = 'FILE_TOO_BIG';
                throw err;
            }
            chunks.push(chunk);
        }
        return { buffer: Buffer.concat(chunks), mime: result.ContentType || mimeFromName(storedName) };
    }

    const dir = prefix === 'photos' ? LOCAL_PHOTOS : LOCAL_DIR;
    const filepath = path.join(dir, storedName);
    if (!fs.existsSync(filepath)) {
        const err = new Error('Файл не найден');
        err.code = 'FILE_NOT_FOUND';
        throw err;
    }
    const stat = fs.statSync(filepath);
    if (stat.size > maxBytes) {
        const err = new Error('Файл слишком большой для разбора');
        err.code = 'FILE_TOO_BIG';
        throw err;
    }
    return { buffer: fs.readFileSync(filepath), mime: mimeFromName(storedName) };
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
    saveStreamFile,
    deleteStored,
    streamToResponse,
    readFileBuffer,
    existsLocally,
    photoPublicUrl,
    LOCAL_DIR,
    LOCAL_PHOTOS,
};
