'use strict';
require('dotenv').config();
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
    });
}
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { pool, initDb } = require('./db');
const storage = require('./storage');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const cron      = require('node-cron');
const ExcelJS   = require('exceljs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

function htmlEscape(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const EMAIL_FROM = process.env.EMAIL_FROM || 'info.texzakaz@mail.ru';
const smtpTransport = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 465,
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
    : null;
const APP_URL = process.env.APP_URL || 'https://texzakaz.ru';
const ALLOWED_ORIGINS = new Set(
    [APP_URL, ...(process.env.CORS_ORIGIN || '').split(',')]
        .map(v => String(v || '').trim())
        .filter(Boolean)
);
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (!IS_PRODUCTION && DEV_ORIGIN_RE.test(origin)) return true;
    return ALLOWED_ORIGINS.has(origin);
}

async function sendEmail(to, subject, html) {
    if (!smtpTransport) { console.log(`[Email] No SMTP config — skipping: ${to} | ${subject}`); return; }
    try {
        const info = await smtpTransport.sendMail({ from: `ТехЗаказ <${EMAIL_FROM}>`, to, subject, html });
        console.log(`[Email] Sent to ${to} | id: ${info.messageId}`);
    } catch (e) {
        console.error(`[Email] FAILED to ${to} | ${e.message}`, e);
        throw e;
    }
}

if (IS_PRODUCTION && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-development';
const ACCESS_COOKIE = 'b2b_access';
const REFRESH_COOKIE = 'b2b_refresh';

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function getAccessToken(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[ACCESS_COOKIE]) return cookies[ACCESS_COOKIE];
    const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

function getRefreshToken(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[REFRESH_COOKIE]) return cookies[REFRESH_COOKIE];
    return req.body?.refreshToken || null;
}

function setAuthCookies(res, accessToken, refreshToken) {
    const base = { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/' };
    res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: 60 * 60 * 1000 });
    res.cookie(REFRESH_COOKIE, refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 * 1000 });
}

function clearAuthCookies(res) {
    const base = { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/' };
    res.clearCookie(ACCESS_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, base);
}

function generateTokens(user) {
    const payload = { userId: user.id, role: user.role, company: user.company };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = crypto.randomBytes(48).toString('hex');
    return { accessToken, refreshToken };
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(input, stored) {
    if (!stored || !stored.includes(':')) return input === stored;
    const [salt, hash] = stored.split(':');
    try {
        const derived = crypto.scryptSync(input, salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
    } catch { return false; }
}

// ===================== ROW MAPPERS =====================

function rowToOrder(r) {
    if (!r) return null;
    return {
        id: r.id, title: r.title, category: r.category, status: r.status,
        responses: r.responses, deadline: r.deadline, quantity: r.quantity,
        description: r.description, company: r.company,
        drawing: r.drawing ? JSON.parse(r.drawing) : null,
        createdAt: r.created_at
    };
}

function rowToProposal(r) {
    if (!r) return null;
    return {
        id: r.id, orderId: r.order_id, orderTitle: r.order_title,
        price: r.price, days: r.days, company: r.company, status: r.status,
        kpFile: r.kp_file ? JSON.parse(r.kp_file) : null,
        createdAt: r.created_at
    };
}

function rowToCompany(r) {
    if (!r) return null;
    return {
        id: r.id, company: r.company, inn: r.inn, role: r.role,
        specialization: r.specialization, status: r.status, city: r.city,
        yearsExperience: r.years_experience, about: r.about,
        equipment: JSON.parse(r.equipment || '[]'),
        phone: r.phone, website: r.website,
        ogrn: r.ogrn || '', director: r.director || '',
        foundingYear: r.founding_year || null,
        authorizedCapital: r.authorized_capital || '',
        employees: r.employees || null, revenue: r.revenue || '',
        machinesCount: r.machines_count || null,
        productionArea: r.production_area || null,
        videoUrl: r.video_url || '',
        isoCertificates: JSON.parse(r.iso_certificates || '[]'),
        qualityCertificates: JSON.parse(r.quality_certificates || '[]'),
        capabilities: JSON.parse(r.capabilities || '[]'),
        productionLoad: r.production_load ?? null,
        verifiedByPlatform: Boolean(r.verified_by_platform),
        freeCapacity: JSON.parse(r.free_capacity || '[]'),
        lat: r.lat ?? null,
        lng: r.lng ?? null,
    };
}

function rowToMessage(r) {
    if (!r) return null;
    return {
        id: r.id, orderId: r.order_id, company: r.company,
        sender: r.sender, text: r.text, createdAt: r.created_at,
        read: Boolean(r.read),
    };
}

function rowToNotification(r) {
    if (!r) return null;
    return {
        id: r.id, company: r.company, text: r.text,
        read: Boolean(r.read), createdAt: r.created_at
    };
}

// ===================== APP =====================

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: false,      // inline-скрипты в HTML-страницах
    crossOriginEmbedderPolicy: false,  // внешние ресурсы (Leaflet CDN, fonts)
}));
app.use(cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true,
}));
app.use(express.json());

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много попыток. Попробуйте через 15 минут.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// ===================== WEBSOCKET =====================
let Server = null;
try { Server = require('socket.io').Server; }
catch { console.warn('socket.io не установлен — работаем через поллинг.'); }

const httpServer = http.createServer(app);
const socketOrigin = IS_PRODUCTION
    ? Array.from(ALLOWED_ORIGINS)
    : [...Array.from(ALLOWED_ORIGINS), 'http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:5000'];
const io = Server ? new Server(httpServer, { cors: { origin: socketOrigin } }) : null;

if (io) {
    io.use(async (socket, next) => {
        try {
            const cookies = parseCookies(socket.handshake.headers.cookie);
            const raw = cookies[ACCESS_COOKIE]
                || socket.handshake.auth?.token
                || (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
            if (!raw) return next(new Error('Требуется авторизация'));
            const payload = jwt.verify(raw, JWT_SECRET);
            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
            if (!user) return next(new Error('Пользователь не найден'));
            socket.user = user;
            next();
        } catch {
            next(new Error('Неверный или истёкший токен'));
        }
    });

    io.on('connection', (socket) => {
        socket.on('join-company', (company) => {
            if (company && company === socket.user.company) socket.join(company);
        });
        socket.on('join-auction', (auctionId) => {
            if (auctionId) socket.join(`auction:${auctionId}`);
        });
        socket.on('leave-auction', (auctionId) => {
            if (auctionId) socket.leave(`auction:${auctionId}`);
        });
        socket.on('join-chat', async ({ orderId, company }, ack) => {
            try {
                if (orderId == null || !company) return;
                if (!(await canAccessOrderThread(socket.user, orderId, company))) return;
                socket.join(`chat:${orderId}:${company}`);
                if (typeof ack === 'function') ack({ ok: true });
            } catch {
                if (typeof ack === 'function') ack({ ok: false });
            }
        });
    });
}

// ===================== ЗАГРУЗКА ФАЙЛОВ =====================
const UPLOADS_DIR = storage.LOCAL_DIR;
const PHOTOS_DIR = storage.LOCAL_PHOTOS;

const ALLOWED_DRAWING_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.dxf', '.dwg', '.step', '.stp'];
const KP_ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];
const PHOTO_ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const BLOCKED_MIME = new Set([
    'text/html', 'text/javascript', 'application/javascript',
    'application/x-php', 'text/x-php', 'application/x-httpd-php',
    'application/x-sh', 'text/x-python',
]);

async function persistUpload(file, prefix) {
    if (!file) return null;
    const meta = await storage.saveFile(file, prefix);
    return JSON.stringify({ originalName: meta.originalName, storedName: meta.storedName });
}

const uploadDrawing = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_DRAWING_EXT.includes(ext)) return cb(new Error('Недопустимый тип файла. Разрешены: ' + ALLOWED_DRAWING_EXT.join(', ')));
        if (BLOCKED_MIME.has(file.mimetype)) return cb(new Error('Недопустимый MIME-тип файла'));
        cb(null, true);
    }
}).single('drawing');
const uploadKP = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!KP_ALLOWED_EXT.includes(ext)) return cb(new Error('Недопустимый тип файла. Разрешены: ' + KP_ALLOWED_EXT.join(', ')));
        if (BLOCKED_MIME.has(file.mimetype)) return cb(new Error('Недопустимый MIME-тип файла'));
        cb(null, true);
    }
}).single('kpFile');

function handleDrawingUpload(req, res, next) {
    uploadDrawing(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
        next();
    });
}
function handleKPUpload(req, res, next) {
    uploadKP(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
        next();
    });
}

const uploadPhoto = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!PHOTO_ALLOWED_EXT.includes(ext)) return cb(new Error('Разрешены только изображения: jpg, jpeg, png, webp'));
        cb(null, true);
    }
}).single('photo');

function handlePhotoUpload(req, res, next) {
    uploadPhoto(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить фото' });
        next();
    });
}

function deleteDrawingFile(drawing) {
    if (!drawing || !drawing.storedName) return;
    storage.deleteStored(drawing.storedName).catch(() => {});
}

// ===================== СТАТИКА =====================
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
    setHeaders(res, filePath) {
        if (/\.(woff2|woff|ttf|otf)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (/\.(png|jpg|jpeg|webp|gif|svg|ico)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        } else if (/\.(css|js)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));
app.get('/uploads/:filename', requireAuth, async (req, res, next) => {
    try {
        const filename = path.basename(req.params.filename);
        await storage.streamToResponse(filename, res);
    } catch (e) { next(e); }
});
app.get('/api/company-photos/:filename', async (req, res, next) => {
    try {
        const filename = path.basename(req.params.filename);
        await storage.streamToResponse(filename, res);
    } catch (e) { next(e); }
});
const PUBLIC_PAGES = [
    'landing.html', 'login.html', 'index.html', 'producer.html', 'proposals.html', 'partners.html',
    'analytics.html', 'company-profile.html', 'messages.html', 'favorites.html',
    'settings.html', 'admin.html', 'deals.html', 'tariff.html', '404.html', 'catalog.html', 'map.html', 'delivery.html', 'deliveries.html',
    'zakupki.html',
    'dlya-postavshchikov.html',
];
PUBLIC_PAGES.forEach(page => {
    const slug = '/' + page.replace('.html', '');
    app.get('/' + page, (req, res) => res.redirect(301, slug === '/landing' ? '/' : slug));
    app.get(slug === '/landing' ? '/' : slug, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(__dirname, page));
    });
});
const CAT_PAGES = [
    { slug: 'metall',   file: 'metall.html' },
    { slug: 'armatura', file: 'armatura.html' },
    { slug: 'elektro',  file: 'elektro.html' },
    { slug: 'rti',      file: 'rti.html' },
];
CAT_PAGES.forEach(({ slug, file }) => {
    app.get(`/zakupki/${slug}`, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(__dirname, 'zakupki', file));
    });
});

app.get('/favicon.ico', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/svg+xml');
    res.sendFile(path.join(__dirname, 'favicon.svg'));
});
app.get('/favicon.svg', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, 'favicon.svg'));
});
app.get('/landing-hero.png', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, 'landing-hero.png'));
});
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(
        'User-agent: *\n' +
        'Allow: /\n' +
        'Allow: /zakupki\n' +
        'Allow: /map\n' +
        'Allow: /dlya-postavshchikov\n' +
        'Disallow: /api/\n' +
        'Disallow: /admin\n' +
        'Disallow: /analytics\n' +
        'Disallow: /catalog\n' +
        'Disallow: /company-profile\n' +
        'Disallow: /deals\n' +
        'Disallow: /deliveries\n' +
        'Disallow: /delivery\n' +
        'Disallow: /favorites\n' +
        'Disallow: /login\n' +
        'Disallow: /messages\n' +
        'Disallow: /partners\n' +
        'Disallow: /proposals\n' +
        'Disallow: /settings\n' +
        'Disallow: /tariff\n' +
        `Sitemap: ${process.env.APP_URL || 'https://texzakaz.ru'}/sitemap.xml\n`
    );
});

app.get('/sitemap.xml', (req, res) => {
    const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
    const today = new Date().toISOString().slice(0, 10);
    const pages = [
        { url: '/',                    priority: '1.0', changefreq: 'weekly' },
        { url: '/zakupki',             priority: '0.9', changefreq: 'hourly' },
        { url: '/zakupki/metall',      priority: '0.8', changefreq: 'daily'  },
        { url: '/zakupki/armatura',    priority: '0.8', changefreq: 'daily'  },
        { url: '/zakupki/elektro',     priority: '0.8', changefreq: 'daily'  },
        { url: '/zakupki/rti',         priority: '0.8', changefreq: 'daily'  },
        { url: '/dlya-postavshchikov', priority: '0.8', changefreq: 'weekly' },
        { url: '/map',                 priority: '0.7', changefreq: 'weekly' },
    ];
    const urls = pages.map(p =>
        `  <url>\n    <loc>${base}${p.url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            ok: true,
            db: true,
            storage: storage.isRemote() ? 's3' : 'local',
            uptime: process.uptime(),
            env: process.env.NODE_ENV || 'development',
        });
    } catch (e) {
        res.status(503).json({
            ok: false,
            db: false,
            error: 'database_unavailable',
        });
    }
});

// ===================== УМНЫЙ МАТЧИНГ =====================
const CATEGORY_KEYWORDS = {
    'РТИ': ['рти', 'резин', 'уплотн', 'манжет', 'вулканиз', 'прокладк', 'эластом', 'кольц', 'полиур'],
    'Металл': [
        'металл', 'прокат', 'сварк', 'металлоконструкц', 'лазерн', 'гибочн', 'чпу', 'литье', 'нефтепромысл',
        'токар', 'фрезер', 'расточ', 'шлифов', 'штамп', 'ковк', 'нержав', 'алюмин', 'трубн', 'термообр'
    ],
    'Трубопроводная арматура': ['арматур', 'задвиж', 'клапан', 'кран', 'вентил', 'фланц', 'фитинг', 'трубопров', 'запорн', 'шаров'],
    'Электрооборудование': ['электр', 'кабел', 'двигател', 'трансформ', 'автомат', 'щит', 'пускател', 'частотн', 'преобраз'],
    'Прочее': []
};

function stem(word) { return word.slice(0, 6); }

function plainTitle(title) {
    return title && title.includes(' | ') ? title.split(' | ')[0] : title;
}

function computeMatchScore(order, producer) {
    // Объединяем все текстовые поля профиля производителя
    const text = [
        producer.specialization || '',
        (producer.equipment || []).join(' '),
        (producer.capabilities || []).join(' '),
        producer.about || '',
    ].join(' ').toLowerCase();

    if (!text.trim()) return 0;

    let score = 0;

    // Совпадение по категории (макс 60 баллов)
    const keywords = CATEGORY_KEYWORDS[order.category] || [];
    score += Math.min(keywords.filter(k => text.includes(k)).length, 3) * 20;

    // Совпадение по словам из заголовка и описания заявки (макс 30 баллов)
    const orderText = `${plainTitle(order.title || '')} ${order.description || ''}`.toLowerCase();
    const orderWords = [...new Set(orderText.split(/[^a-zа-яё0-9]+/).filter(w => w.length > 4))];
    score += Math.min(orderWords.filter(w => text.includes(stem(w))).length, 2) * 15;

    // Бонус за свободные мощности
    const cap = producer.freeCapacity || [];
    if (cap.length > 0) {
        const avgFree = cap.reduce((s, c) => s + (c.percent || 0), 0) / cap.length;
        if (avgFree >= 30) score += 10;
    }

    return Math.min(100, score);
}

function computeMatchReasons(order, producer) {
    const text = [
        producer.specialization || '',
        (producer.equipment || []).join(' '),
        (producer.capabilities || []).join(' '),
        producer.about || '',
    ].join(' ').toLowerCase();
    if (!text.trim()) return [];

    const reasons = [];
    const keywords = CATEGORY_KEYWORDS[order.category] || [];
    const catHits = keywords.filter(k => text.includes(k)).slice(0, 3);
    if (catHits.length) {
        reasons.push(`Категория «${order.category}»: ${catHits.join(', ')}`);
    }

    const orderText = `${plainTitle(order.title || '')} ${order.description || ''}`.toLowerCase();
    const orderWords = [...new Set(orderText.split(/[^a-zа-яё0-9]+/).filter(w => w.length > 4))];
    const wordHits = orderWords.filter(w => text.includes(stem(w))).slice(0, 2);
    if (wordHits.length) {
        reasons.push(`По описанию заявки: ${wordHits.join(', ')}`);
    }

    const cap = producer.freeCapacity || [];
    if (cap.length > 0) {
        const avgFree = cap.reduce((s, c) => s + (c.percent || 0), 0) / cap.length;
        if (avgFree >= 30) reasons.push(`Свободные мощности ~${Math.round(avgFree)}%`);
    }

    return reasons;
}

// ===================== ГЕОКОДИРОВАНИЕ =====================

async function geocodeCity(city) {
    if (!city || !city.trim()) return null;
    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city.trim() + ', Россия')}&format=json&limit=1&countrycodes=ru`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'TechZakaz/1.0 (texzakaz)' },
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch {}
    return null;
}

function getProducerCategories(producer) {
    const text = [
        producer.specialization || '',
        (producer.equipment || []).join(' '),
        (producer.capabilities || []).join(' '),
        producer.about || '',
    ].join(' ').toLowerCase();
    return Object.keys(CATEGORY_KEYWORDS).filter(cat => {
        const kw = CATEGORY_KEYWORDS[cat];
        return kw.length > 0 && kw.some(k => text.includes(k));
    });
}

const CITY_PRODUCTION_POINTS = {
    'Тюмень': { lat: 57.1522, lng: 65.5272, region: 'Тюменская область' },
    'Тобольск': { lat: 58.2017, lng: 68.2538, region: 'Тюменская область' },
    'Екатеринбург': { lat: 56.8389, lng: 60.6057, region: 'Свердловская область' },
    'Нижний Тагил': { lat: 57.9194, lng: 59.9650, region: 'Свердловская область' },
    'Пермь': { lat: 58.0105, lng: 56.2502, region: 'Пермский край' },
    'Уфа': { lat: 54.7388, lng: 55.9721, region: 'Башкортостан' },
    'Казань': { lat: 55.7961, lng: 49.1064, region: 'Республика Татарстан' },
    'Сургут': { lat: 61.2540, lng: 73.3962, region: 'Ханты-Мансийский АО' },
    'Нижневартовск': { lat: 60.9397, lng: 76.5696, region: 'Ханты-Мансийский АО' },
    'Самара': { lat: 53.1959, lng: 50.1008, region: 'Самарская область' },
    'Оренбург': { lat: 51.7682, lng: 55.0969, region: 'Оренбургская область' },
    'Томск': { lat: 56.4846, lng: 84.9482, region: 'Томская область' },
    'Челябинск': { lat: 55.1644, lng: 61.4368, region: 'Челябинская область' },
    'Москва': { lat: 55.7558, lng: 37.6173, region: 'Москва' },
    'Санкт-Петербург': { lat: 59.9386, lng: 30.3141, region: 'Санкт-Петербург' },
    'Ярославль': { lat: 57.6261, lng: 39.8845, region: 'Ярославская область' },
};

function getCityProductionPoint(city = '') {
    const cleanCity = String(city || '')
        .replace(/^г\.\s*/i, '')
        .replace(/^город\s+/i, '')
        .trim();
    if (!cleanCity) return null;
    return CITY_PRODUCTION_POINTS[cleanCity] || null;
}

function offsetProductionPoint(point, index) {
    if (!point || index === 0) return point;
    const angle = (index % 8) * (Math.PI / 4);
    const radius = 0.045 + Math.floor(index / 8) * 0.018;
    return {
        ...point,
        lat: Number(point.lat) + Math.sin(angle) * radius,
        lng: Number(point.lng) + Math.cos(angle) * radius,
    };
}

async function geocodeExisting() {
    try {
        const { rows } = await pool.query(
            "SELECT id, city FROM companies WHERE role='producer' AND city != '' AND lat IS NULL LIMIT 50"
        );
        for (const r of rows) {
            const coords = await geocodeCity(r.city);
            if (coords) await pool.query('UPDATE companies SET lat=$1,lng=$2 WHERE id=$3', [coords.lat, coords.lng, r.id]);
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    } catch {}
}

async function matchedProducers(order, minScore = 0, withReasons = false) {
    const { rows } = await pool.query("SELECT * FROM companies WHERE role = 'producer'");
    return rows.map(rowToCompany)
        .map(c => {
            const score = computeMatchScore(order, c);
            const item = { company: c.company, score };
            if (withReasons) item.reasons = computeMatchReasons(order, c);
            return item;
        })
        .filter(m => m.score >= minScore)
        .sort((a, b) => b.score - a.score);
}

// ===================== AUTH MIDDLEWARE =====================

async function requireAuth(req, res, next) {
    try {
        const token = getAccessToken(req);
        if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
        let payload;
        try { payload = jwt.verify(token, JWT_SECRET); }
        catch { return res.status(401).json({ error: 'Неверный или истёкший токен' }); }
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
        req.user = user;
        next();
    } catch (e) { next(e); }
}

function requireVerifiedEmail(req, res, next) {
    if (req.user.role === 'admin' || req.user.email_verified) return next();
    return res.status(403).json({
        error: 'Подтвердите email перед этим действием. Проверьте почту или запросите письмо повторно.',
        code: 'email_not_verified',
    });
}

async function sendVerificationEmail(user) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [user.id]);
    await pool.query(
        "INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
        [user.id, token]
    );
    const link = `${APP_URL}/login.html?verify=${token}`;
    await sendEmail(user.email, 'Подтвердите email — ТехЗаказ', `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a2332">
          <h2 style="color:#41bd97">Подтверждение email</h2>
          <p>Здравствуйте! Подтвердите адрес <strong>${htmlEscape(user.email)}</strong>, чтобы размещать заявки и откликаться на закупки.</p>
          <a href="${link}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Подтвердить email</a>
          <p style="font-size:12px;color:#666">Ссылка действительна 24 часа.</p>
        </div>`
    );
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
        next();
    };
}

async function optionalAuth(req, res, next) {
    try {
        const token = getAccessToken(req);
        if (token) {
            try {
                const payload = jwt.verify(token, JWT_SECRET);
                const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
                if (user) req.user = user;
            } catch { /* invalid token — continue as guest */ }
        }
        next();
    } catch (e) { next(e); }
}

async function getCompanyEmail(companyName) {
    if (!companyName) return null;
    const { rows: [u] } = await pool.query('SELECT email FROM users WHERE company = $1 LIMIT 1', [companyName]);
    return u ? u.email : null;
}

async function addNotification(company, text) {
    if (!company) return;
    const { rows } = await pool.query(
        'INSERT INTO notifications (company, text) VALUES ($1, $2) RETURNING id',
        [company, text]
    );
    if (io) {
        io.to(company).emit('notification', {
            id: rows[0].id, company, text, read: false, createdAt: new Date().toISOString()
        });
    }
}

// ===================== TRANSACTION HELPER =====================

async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function getOrderAccessRow(orderId) {
    const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(orderId)]);
    return order || null;
}

async function canAccessOrderThread(user, orderId, producerCompany) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const order = await getOrderAccessRow(orderId);
    if (!order) return false;
    if (user.role === 'customer') return order.company === user.company;
    if (user.role === 'producer') {
        if (producerCompany !== user.company) return false;
        const { rows: [proposal] } = await pool.query(
            'SELECT id FROM proposals WHERE order_id = $1 AND company = $2 LIMIT 1',
            [Number(orderId), user.company]
        );
        return Boolean(proposal);
    }
    return false;
}

function canAccessProposal(user, proposal) {
    if (!user || !proposal) return false;
    if (user.role === 'admin') return true;
    return proposal.company === user.company || proposal.order_company === user.company;
}

async function canAccessOrderDrawing(user, orderId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const order = await getOrderAccessRow(orderId);
    if (!order) return false;
    if (user.role === 'customer') return order.company === user.company;
    if (user.role === 'producer') {
        const { rows: [proposal] } = await pool.query(
            'SELECT id FROM proposals WHERE order_id = $1 AND company = $2 LIMIT 1',
            [Number(orderId), user.company]
        );
        return Boolean(proposal);
    }
    return false;
}

// ===================== COMPANIES: вычисляемые поля =====================

async function computeProducerRating(companyName) {
    const { rows: resolved } = await pool.query(
        "SELECT status FROM proposals WHERE company = $1 AND status IN ('Выигран', 'Отклонен')",
        [companyName]
    );
    if (!resolved.length) return null;
    const won = resolved.filter(p => p.status === 'Выигран').length;
    const rate = won / resolved.length;
    let rating, ratingLabel;
    if (rate >= 0.7 && won >= 3) { rating = 'A+'; ratingLabel = 'Высокий'; }
    else if (rate >= 0.5)        { rating = 'A';  ratingLabel = 'Высокий'; }
    else if (rate >= 0.3)        { rating = 'B+'; ratingLabel = 'Средний'; }
    else if (rate >= 0.15 || won > 0) { rating = 'B'; ratingLabel = 'Средний'; }
    else                         { rating = 'C';  ratingLabel = 'Низкий'; }
    return { status: won > 0 ? 'Верифицирован' : 'На проверке', rating, ratingLabel, ratingStats: { won, resolved: resolved.length } };
}

async function computeCustomerStatus(companyName) {
    const { rows: [{ n: total }] } = await pool.query('SELECT COUNT(*) AS n FROM orders WHERE company = $1', [companyName]);
    if (!total) return null;
    const { rows: [{ n: closed }] } = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND status = 'Закрыта'", [companyName]);
    return { status: closed > 0 ? 'Верифицирован' : 'На проверке' };
}

async function computeProducerStats(companyName) {
    const { rows: [{ n: total }] } = await pool.query('SELECT COUNT(*) AS n FROM proposals WHERE company = $1', [companyName]);
    if (!total) return null;
    const { rows: won } = await pool.query("SELECT days FROM proposals WHERE company = $1 AND status = 'Выигран'", [companyName]);
    const avgDeliveryDays = won.length ? Math.round(won.reduce((s, p) => s + p.days, 0) / won.length) : null;
    return { completedOrders: won.length, avgDeliveryDays, totalProposals: total };
}

async function computeCustomerStats(companyName) {
    const { rows } = await pool.query('SELECT status FROM orders WHERE company = $1', [companyName]);
    if (!rows.length) return null;
    return { postedOrders: rows.length, closedOrders: rows.filter(o => o.status === 'Закрыта').length };
}

async function enrichCompany(c, ownerCompany) {
    let enriched;
    if (c.role === 'producer') {
        const rating = await computeProducerRating(c.company);
        enriched = { ...c, ...(rating || {}), stats: await computeProducerStats(c.company) };
    } else {
        const status = await computeCustomerStatus(c.company);
        enriched = { ...c, ...(status || {}), stats: await computeCustomerStats(c.company) };
    }
    if (ownerCompany) {
        const { rows: [fav] } = await pool.query('SELECT 1 FROM favorites WHERE owner_company = $1 AND company_id = $2', [ownerCompany, c.id]);
        enriched.isFavorite = Boolean(fav);
    } else {
        enriched.isFavorite = false;
    }
    const { rows: photos } = await pool.query('SELECT id, stored_name, original_name FROM company_photos WHERE company_id = $1 ORDER BY created_at ASC', [c.id]);
    enriched.photos = photos.map(p => ({
        id: p.id,
        storedName: p.stored_name,
        originalName: p.original_name,
        url: storage.photoPublicUrl(p.stored_name),
    }));
    return enriched;
}

// ===================== ORDERS =====================

app.get('/api/orders/public', async (req, res, next) => {
    try {
        const category = req.query.category || '';
        const params = [];
        let where = "status = 'Активный'";
        if (category) { params.push(category); where += ` AND category = $${params.length}`; }
        const { rows } = await pool.query(
            `SELECT id, title, category, deadline, quantity, responses, created_at
             FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT 30`,
            params
        );
        res.json(rows);
    } catch (e) { next(e); }
});

app.get('/api/orders', requireAuth, async (req, res, next) => {
    try {
        let rows;
        if (req.user.role === 'customer') {
            ({ rows } = await pool.query('SELECT * FROM orders WHERE company = $1 ORDER BY created_at DESC', [req.user.company]));
        } else {
            ({ rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC'));
        }
        res.json(rows.map(rowToOrder));
    } catch (e) { next(e); }
});

app.get('/api/orders/match-scores', requireAuth, requireRole('producer'), async (req, res, next) => {
    try {
        const { rows: [meRow] } = await pool.query("SELECT * FROM companies WHERE company = $1 AND role = 'producer'", [req.user.company]);
        const me = meRow ? rowToCompany(meRow) : null;
        const { rows: orders } = await pool.query('SELECT * FROM orders');
        const scores = {};
        orders.map(rowToOrder).forEach(o => { scores[o.id] = me ? computeMatchScore(o, me) : 0; });
        res.json(scores);
    } catch (e) { next(e); }
});

app.get('/api/orders/:orderId/drawing', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        if (!(await canAccessOrderDrawing(req.user, orderId))) {
            return res.status(403).json({ error: 'Нет доступа к чертежу этой закупки' });
        }
        const { rows: [row] } = await pool.query('SELECT drawing FROM orders WHERE id = $1', [orderId]);
        if (!row || !row.drawing) return res.status(404).json({ error: 'Файл не найден' });
        const drawing = JSON.parse(row.drawing);
        if (!storage.isRemote() && !storage.existsLocally(drawing.storedName)) {
            return res.status(404).json({ error: 'Файл был удалён с сервера' });
        }
        const inline = req.query.inline === '1';
        await storage.streamToResponse(drawing.storedName, res, drawing.originalName, { inline });
    } catch (e) { next(e); }
});

app.post('/api/orders', requireAuth, requireRole('customer'), requireVerifiedEmail, handleDrawingUpload, async (req, res, next) => {
    try {
        const { title, category, deadline, quantity, description } = req.body;
        if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

        const drawing = await persistUpload(req.file, 'drawings');
        const { rows: [newRow] } = await pool.query(
            'INSERT INTO orders (title,category,deadline,quantity,description,company,drawing) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [title, category, deadline, quantity ? Number(quantity) : null,
             description ? String(description).slice(0, 1000) : '', req.user.company, drawing]
        );
        const newOrder = rowToOrder(newRow);

        const MATCH_NOTIFY_THRESHOLD = 50;
        const matched = await matchedProducers(newOrder, MATCH_NOTIFY_THRESHOLD);
        await Promise.all(matched.map(m =>
            addNotification(m.company, `🧩 Новая подходящая закупка (${m.score}% совпадение): «${plainTitle(newOrder.title)}»`)
        ));

        res.status(201).json(newOrder);
    } catch (e) { next(e); }
});

app.put('/api/orders/:orderId', requireAuth, requireRole('customer'), handleDrawingUpload, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const { title, category, deadline, quantity, description } = req.body;
        if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

        const { rows: [row] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
        const order = rowToOrder(row);
        if (order.company && order.company !== req.user.company) return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
        if (order.status === 'Закрыта' || order.status === 'Отменена') return res.status(400).json({ error: 'Закрытую или отменённую закупку нельзя редактировать' });

        let drawingJson = row.drawing;
        if (req.file) {
            deleteDrawingFile(order.drawing);
            drawingJson = await persistUpload(req.file, 'drawings');
        }

        await pool.query(
            'UPDATE orders SET title=$1,category=$2,deadline=$3,quantity=$4,description=$5,drawing=$6 WHERE id=$7',
            [title, category, deadline, quantity ? Number(quantity) : null,
             description !== undefined ? String(description).slice(0, 1000) : (order.description || ''),
             drawingJson, orderId]
        );
        const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        res.json(rowToOrder(updated));
    } catch (e) { next(e); }
});

app.post('/api/orders/:orderId/cancel', requireAuth, requireRole('customer'), async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const { rows: [row] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
        const order = rowToOrder(row);
        if (order.company && order.company !== req.user.company) return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
        if (order.status === 'Закрыта')  return res.status(400).json({ error: 'Закупка уже завершена, отменить её нельзя' });
        if (order.status === 'Отменена') return res.status(400).json({ error: 'Закупка уже отменена' });

        const title = plainTitle(order.title);
        const notifs = [];

        await withTransaction(async (client) => {
            await client.query("UPDATE orders SET status = 'Отменена' WHERE id = $1", [orderId]);
            const { rows: pending } = await client.query(
                "SELECT * FROM proposals WHERE order_id = $1 AND status = 'Ожидает ответа'", [orderId]
            );
            for (const p of pending) {
                await client.query("UPDATE proposals SET status = 'Отозвана заказчиком' WHERE id = $1", [p.id]);
                notifs.push({ company: p.company, text: `Закупка «${title}» отменена заказчиком, ваше предложение по ней снято с рассмотрения.` });
            }
        });

        await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
        const { rows: [updated] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        res.json(rowToOrder(updated));
    } catch (e) { next(e); }
});

// ===================== PROPOSALS =====================

app.get('/api/proposals/:proposalId/file', requireAuth, async (req, res, next) => {
    try {
        const { rows: [row] } = await pool.query(`
            SELECT p.*, o.company AS order_company
            FROM proposals p
            JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1
        `, [Number(req.params.proposalId)]);
        if (!row || !row.kp_file) return res.status(404).json({ error: 'Файл не найден' });
        if (!canAccessProposal(req.user, row)) return res.status(403).json({ error: 'Нет доступа к этому файлу' });
        const kpFile = JSON.parse(row.kp_file);
        if (!storage.isRemote() && !storage.existsLocally(kpFile.storedName)) {
            return res.status(404).json({ error: 'Файл был удалён с сервера' });
        }
        await storage.streamToResponse(kpFile.storedName, res, kpFile.originalName);
    } catch (e) { next(e); }
});

app.post('/api/proposals', requireAuth, requireRole('producer'), requireVerifiedEmail, handleKPUpload, async (req, res, next) => {
    try {
        const { orderId, orderTitle, price, days } = req.body;
        if (!orderId || !price || !days) return res.status(400).json({ error: 'Не указаны ID заявки, цена или сроки' });

        const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(orderId)]);
        if (!orderRow) return res.status(404).json({ error: 'Заявка с таким ID не найдена' });
        if (orderRow.status !== 'Активный') {
            return res.status(400).json({ error: 'Нельзя подать КП на закрытую или отменённую закупку' });
        }

        const { rows: [existing] } = await pool.query('SELECT id FROM proposals WHERE order_id = $1 AND company = $2', [Number(orderId), req.user.company]);
        if (existing) return res.status(409).json({ error: 'Вы уже подали КП на эту закупку. Отредактируйте существующее предложение.' });

        const kpFile = await persistUpload(req.file, 'kp');

        const newRow = await withTransaction(async (client) => {
            const { rows: [r] } = await client.query(
                'INSERT INTO proposals (order_id,order_title,price,days,company,kp_file) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
                [Number(orderId), orderTitle || orderRow.title, Number(price), Number(days), req.user.company, kpFile]
            );
            await client.query('UPDATE orders SET responses = responses + 1 WHERE id = $1', [Number(orderId)]);
            return r;
        });

        const newProposal = rowToProposal(newRow);
        if (orderRow.company) {
            const title = plainTitle(orderRow.title);
            await addNotification(orderRow.company, `Получен новый отклик на «${title}» от ${req.user.company}.`);
            const email = await getCompanyEmail(orderRow.company);
            if (email) await sendEmail(email, `Новый отклик на закупку «${title}»`,
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:#41bd97">Новый отклик на закупку</h3>
                  <p>Компания <strong>${htmlEscape(req.user.company)}</strong> подала коммерческое предложение по закупке <strong>«${htmlEscape(title)}»</strong>.</p>
                  <p>Цена: <strong>${Number(newProposal.price).toLocaleString('ru-RU')} ₽</strong> · Срок: <strong>${newProposal.days} дн.</strong></p>
                  <a href="${APP_URL}/index.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                </div>`
            );
        }
        res.status(201).json(newProposal);
    } catch (e) { next(e); }
});

app.get('/api/proposals', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM proposals WHERE company = $1', [req.user.company]);
        res.json(rows.map(rowToProposal));
    } catch (e) { next(e); }
});

app.get('/api/order-proposals/:orderId', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const orderRow = await getOrderAccessRow(orderId);
        if (!orderRow) return res.status(404).json({ error: 'Закупка не найдена' });
        let rows;
        if (req.user.role === 'admin' || orderRow.company === req.user.company) {
            ({ rows } = await pool.query('SELECT * FROM proposals WHERE order_id = $1', [orderId]));
        } else if (req.user.role === 'producer') {
            ({ rows } = await pool.query(
                'SELECT * FROM proposals WHERE order_id = $1 AND company = $2',
                [orderId, req.user.company]
            ));
        } else {
            return res.status(403).json({ error: 'Нет доступа к предложениям этой закупки' });
        }

        const orderObj = rowToOrder(orderRow);
        const withMatch = (req.user.role === 'customer' || req.user.role === 'admin') && rows.length > 0;
        let producerByName = null;
        if (withMatch) {
            const companies = rows.map(r => r.company);
            const { rows: prodRows } = await pool.query(
                "SELECT * FROM companies WHERE role = 'producer' AND company = ANY($1::text[])",
                [companies]
            );
            producerByName = new Map(prodRows.map(r => [r.company, rowToCompany(r)]));
        }

        res.json(rows.map(r => {
            const p = rowToProposal(r);
            if (withMatch) {
                const producer = producerByName.get(p.company);
                p.matchScore = producer ? computeMatchScore(orderObj, producer) : 0;
                p.matchReasons = producer ? computeMatchReasons(orderObj, producer) : [];
            }
            return p;
        }));
    } catch (e) { next(e); }
});

app.get('/api/orders/:orderId/matched-suppliers', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const orderRow = await getOrderAccessRow(orderId);
        if (!orderRow) return res.status(404).json({ error: 'Закупка не найдена' });
        if (req.user.role !== 'admin' && orderRow.company !== req.user.company) {
            return res.status(403).json({ error: 'Нет доступа к этой закупке' });
        }
        const orderObj = rowToOrder(orderRow);
        const minScore = Math.max(0, Math.min(100, Number(req.query.min) || 30));
        const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 8));
        const matched = await matchedProducers(orderObj, minScore, true);
        res.json(matched.slice(0, limit));
    } catch (e) { next(e); }
});

app.post('/api/proposals/:proposalId/accept', requireAuth, requireRole('customer'), async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

        const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
        if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
        if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Принимать предложения может только владелец закупки' });
        if (orderRow.status === 'Закрыта') return res.status(400).json({ error: 'Эта прямая закупка уже завершена' });

        const title = plainTitle(orderRow.title);
        const notifs = [];

        await withTransaction(async (client) => {
            await client.query("UPDATE orders SET status = 'Закрыта' WHERE id = $1", [orderRow.id]);
            const { rows: allProposals } = await client.query('SELECT * FROM proposals WHERE order_id = $1', [orderRow.id]);
            for (const p of allProposals) {
                if (p.id === proposalId) {
                    await client.query("UPDATE proposals SET status = 'Выигран' WHERE id = $1", [p.id]);
                    await client.query(
                        "INSERT INTO delivery_events (proposal_id, stage, notes, updated_by) VALUES ($1, 'КП принят', $2, 'system')",
                        [p.id, `КП принят заказчиком. Сумма: ${p.price ? p.price.toLocaleString('ru-RU') + ' ₽' : '—'}, срок: ${p.days} дн.`]
                    );
                    notifs.push({ company: p.company, text: `Ваше предложение по «${title}» принято! Заказ выигран.` });
                } else {
                    await client.query("UPDATE proposals SET status = 'Отклонен' WHERE id = $1", [p.id]);
                    notifs.push({ company: p.company, text: `Ваше предложение по «${title}» отклонено.` });
                }
            }
        });

        // Fire integrations (Bitrix24, AmoCRM) — non-blocking
        const wonProposal = { id: proposalId, company: proposalRow.company, price: proposalRow.price, days: proposalRow.days };
        triggerIntegrations(req.user.company, wonProposal, orderRow).catch(() => {});

        await Promise.all(notifs.map(n => addNotification(n.company, n.text)));
        await Promise.all(notifs.map(async n => {
            const email = await getCompanyEmail(n.company);
            const won = n.text.includes('принято');
            if (email) await sendEmail(email, won ? `Предложение принято — «${title}»` : `Предложение отклонено — «${title}»`,
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:${won ? '#41bd97' : '#e07070'}">${won ? 'Ваше предложение принято!' : 'Предложение отклонено'}</h3>
                  <p>${won
                    ? `Поздравляем! Заказчик выбрал ваше предложение по закупке <strong>«${htmlEscape(title)}»</strong>.`
                    : `К сожалению, заказчик выбрал другого поставщика по закупке <strong>«${htmlEscape(title)}»</strong>.`
                  }</p>
                  <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                </div>`
            );
        }));
        res.json({ message: 'Победитель успешно определен, прямая закупка закрыта' });
    } catch (e) { next(e); }
});

app.post('/api/proposals/:proposalId/reject', requireAuth, requireRole('customer'), async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { rows: [proposalRow] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

        const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [proposalRow.order_id]);
        if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
        if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Отклонять предложения может только владелец закупки' });
        if (proposalRow.status !== 'Ожидает ответа') return res.status(400).json({ error: 'Можно отклонить только предложение в статусе "Ожидает ответа"' });

        const rejectTitle = plainTitle(orderRow.title);
        await pool.query("UPDATE proposals SET status = 'Отклонен' WHERE id = $1", [proposalId]);
        await addNotification(proposalRow.company, `Ваше предложение по «${rejectTitle}» отклонено.`);
        const rejectEmail = await getCompanyEmail(proposalRow.company);
        if (rejectEmail) await sendEmail(rejectEmail, `Предложение отклонено — «${rejectTitle}»`,
            `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
              <h3 style="color:#e07070">Предложение отклонено</h3>
              <p>Заказчик отклонил ваше предложение по закупке <strong>«${htmlEscape(rejectTitle)}»</strong>.</p>
              <a href="${APP_URL}/producer.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
            </div>`
        );
        const { rows: [updated] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        res.json(rowToProposal(updated));
    } catch (e) { next(e); }
});

app.put('/api/proposals/:proposalId', requireAuth, requireRole('producer'), async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { price, days } = req.body;
        if (!price || !days) return res.status(400).json({ error: 'Не указаны цена или сроки' });

        const { rows: [row] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
        if (row.company !== req.user.company) return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });
        if (row.status !== 'Ожидает ответа') return res.status(400).json({ error: 'Можно редактировать только предложения в статусе "Ожидает ответа"' });

        await pool.query('UPDATE proposals SET price = $1, days = $2 WHERE id = $3', [Number(price), Number(days), proposalId]);
        const { rows: [updated] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        res.json(rowToProposal(updated));
    } catch (e) { next(e); }
});

app.delete('/api/proposals/:proposalId', requireAuth, requireRole('producer'), async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { rows: [row] } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
        if (row.company !== req.user.company) return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });

        await withTransaction(async (client) => {
            await client.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
            await client.query('UPDATE orders SET responses = GREATEST(0, responses - 1) WHERE id = $1', [row.order_id]);
        });

        res.json({ message: 'Предложение отозвано' });
    } catch (e) { next(e); }
});

// ===================== COMPANIES =====================

app.get('/api/top-suppliers', async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                c.id,
                c.company,
                c.specialization,
                c.city,
                c.verified_by_platform,
                COUNT(p.id)                                           AS total_proposals,
                COUNT(p.id) FILTER (WHERE p.status = 'Принято')      AS won_deals
            FROM companies c
            LEFT JOIN proposals p ON p.company = c.company
            WHERE c.role = 'producer'
            GROUP BY c.id
            ORDER BY won_deals DESC, total_proposals DESC
            LIMIT 5
        `);
        res.json(rows.map(r => ({
            id:         r.id,
            company:    r.company,
            spec:       r.specialization || '',
            city:       r.city || '',
            verified:   r.verified_by_platform,
            deals:      Number(r.won_deals),
            proposals:  Number(r.total_proposals),
        })));
    } catch (e) { next(e); }
});

app.get('/api/companies', optionalAuth, async (req, res, next) => {
    try {
        const ownerCompany = req.user ? req.user.company : null;
        const { rows } = await pool.query('SELECT * FROM companies');
        const enriched = await Promise.all(rows.map(r => enrichCompany(rowToCompany(r), ownerCompany)));
        res.json(enriched);
    } catch (e) { next(e); }
});

app.get('/api/companies/:id', optionalAuth, async (req, res, next) => {
    try {
        const { rows: [row] } = await pool.query('SELECT * FROM companies WHERE id = $1', [Number(req.params.id)]);
        if (!row) return res.status(404).json({ error: 'Компания не найдена' });
        res.json(await enrichCompany(rowToCompany(row), req.user ? req.user.company : null));
    } catch (e) { next(e); }
});

app.put('/api/companies/:id', requireAuth, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { rows: [row] } = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
        if (!row) return res.status(404).json({ error: 'Компания не найдена' });
        if (row.company !== req.user.company) return res.status(403).json({ error: 'Можно редактировать только профиль своей компании' });

        const { city, yearsExperience, about, equipment, specialization, phone, website,
                ogrn, director, foundingYear, authorizedCapital, employees, revenue,
                machinesCount, productionArea, videoUrl,
                isoCertificates, qualityCertificates, capabilities, productionLoad } = req.body;

        const str  = (v, max) => String(v).slice(0, max);
        const num  = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

        const sets = [], vals = [];
        const f = (col, val) => { sets.push(`${col} = $${sets.length + 1}`); vals.push(val); };

        if (city !== undefined) {
            const cityVal = str(city, 100);
            f('city', cityVal);
            if (cityVal !== row.city) {
                geocodeCity(cityVal).then(coords => {
                    if (coords) pool.query('UPDATE companies SET lat=$1,lng=$2 WHERE id=$3', [coords.lat, coords.lng, id]);
                    else pool.query('UPDATE companies SET lat=NULL,lng=NULL WHERE id=$1', [id]);
                });
            }
        }
        if (yearsExperience !== undefined)    f('years_experience', num(yearsExperience));
        if (about !== undefined)              f('about', str(about, 1000));
        if (specialization !== undefined)     f('specialization', str(specialization, 200));
        if (phone !== undefined)              f('phone', str(phone, 30));
        if (website !== undefined)            f('website', str(website, 200));
        if (ogrn !== undefined)               f('ogrn', str(ogrn, 20));
        if (director !== undefined)           f('director', str(director, 150));
        if (foundingYear !== undefined)       f('founding_year', num(foundingYear));
        if (authorizedCapital !== undefined)  f('authorized_capital', str(authorizedCapital, 50));
        if (employees !== undefined)          f('employees', num(employees));
        if (revenue !== undefined)            f('revenue', str(revenue, 50));
        if (machinesCount !== undefined)      f('machines_count', num(machinesCount));
        if (productionArea !== undefined)     f('production_area', num(productionArea));
        if (videoUrl !== undefined)           f('video_url', str(videoUrl, 300));
        if (productionLoad !== undefined) {
            const n = Number(productionLoad);
            f('production_load', Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null);
        }
        if (Array.isArray(equipment))           f('equipment', JSON.stringify(equipment.map(e => str(e, 60)).slice(0, 20)));
        if (Array.isArray(isoCertificates))     f('iso_certificates', JSON.stringify(isoCertificates.map(e => str(e, 80)).slice(0, 20)));
        if (Array.isArray(qualityCertificates)) f('quality_certificates', JSON.stringify(qualityCertificates.map(e => str(e, 80)).slice(0, 20)));
        if (Array.isArray(capabilities))        f('capabilities', JSON.stringify(capabilities.slice(0, 20)));
        if (req.body.freeCapacity !== undefined) {
            const cap = Array.isArray(req.body.freeCapacity) ? req.body.freeCapacity : [];
            const valid = cap
                .filter(c => c && typeof c.name === 'string' && c.name.trim())
                .map(c => ({ name: String(c.name).slice(0, 80), percent: Math.min(100, Math.max(0, Number(c.percent) || 0)) }))
                .slice(0, 15);
            f('free_capacity', JSON.stringify(valid));
        }

        if (sets.length) {
            vals.push(id);
            await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
        }

        const { rows: [updated] } = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
        res.json(await enrichCompany(rowToCompany(updated), req.user.company));
    } catch (e) { next(e); }
});

// ===================== ФОТО КОМПАНИИ =====================

app.post('/api/companies/:id/photos', requireAuth, handlePhotoUpload, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { rows: [row] } = await pool.query('SELECT company FROM companies WHERE id = $1', [id]);
        if (!row) return res.status(404).json({ error: 'Компания не найдена' });
        if (row.company !== req.user.company) return res.status(403).json({ error: 'Можно загружать фото только своей компании' });
        if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

        const { rows: [{ n: count }] } = await pool.query('SELECT COUNT(*) AS n FROM company_photos WHERE company_id = $1', [id]);
        if (count >= 10) return res.status(400).json({ error: 'Максимум 10 фотографий' });

        const meta = await storage.saveFile(req.file, 'photos');
        const { rows: [photo] } = await pool.query(
            'INSERT INTO company_photos (company_id, stored_name, original_name) VALUES ($1, $2, $3) RETURNING *',
            [id, meta.storedName, meta.originalName]
        );
        res.status(201).json({
            id: photo.id,
            storedName: photo.stored_name,
            originalName: photo.original_name,
            url: storage.photoPublicUrl(photo.stored_name),
        });
    } catch (e) { next(e); }
});

app.delete('/api/companies/:id/photos/:photoId', requireAuth, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const photoId = Number(req.params.photoId);
        const { rows: [row] } = await pool.query('SELECT company FROM companies WHERE id = $1', [id]);
        if (!row) return res.status(404).json({ error: 'Компания не найдена' });
        if (row.company !== req.user.company) return res.status(403).json({ error: 'Нет прав' });

        const { rows: [photo] } = await pool.query('SELECT stored_name FROM company_photos WHERE id = $1 AND company_id = $2', [photoId, id]);
        if (!photo) return res.status(404).json({ error: 'Фото не найдено' });

        await pool.query('DELETE FROM company_photos WHERE id = $1', [photoId]);
        storage.deleteStored(photo.stored_name).catch(() => {});
        res.json({ message: 'Удалено' });
    } catch (e) { next(e); }
});

// ===================== DASHBOARD COUNTS =====================

app.get('/api/dashboard/counts', requireAuth, async (req, res, next) => {
    try {
        const company = req.user.company;
        if (req.user.role === 'producer') {
            const [{ rows: [{ n: activeOrders }] }, { rows: [{ n: pendingProposals }] }, { rows: [{ n: unreadMessages }] }] = await Promise.all([
                pool.query("SELECT COUNT(*) AS n FROM orders WHERE status = 'Активный'"),
                pool.query("SELECT COUNT(*) AS n FROM proposals WHERE company = $1 AND status = 'Ожидает ответа'", [company]),
                pool.query("SELECT COUNT(*) AS n FROM messages WHERE company = $1 AND sender = 'customer' AND read = false", [company]),
            ]);
            res.json({ activeOrders, pendingProposals, unreadMessages });
        } else {
            const [{ rows: [{ n: myActiveOrders }] }, { rows: [{ n: newResponses }] }, { rows: [{ n: unreadMessages }] }] = await Promise.all([
                pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND status = 'Активный'", [company]),
                pool.query("SELECT COUNT(*) AS n FROM proposals p JOIN orders o ON p.order_id = o.id WHERE o.company = $1 AND p.status = 'Ожидает ответа'", [company]),
                pool.query("SELECT COUNT(*) AS n FROM messages m JOIN orders o ON o.id = m.order_id WHERE o.company = $1 AND m.sender = 'producer' AND m.read = false", [company]),
            ]);
            res.json({ myActiveOrders, newResponses, unreadMessages });
        }
    } catch (e) { next(e); }
});

// ===================== ПУБЛИЧНАЯ СТАТИСТИКА =====================

app.get('/api/public/stats', async (req, res, next) => {
    try {
        const [
            { rows: [{ n: producers }] },
            { rows: [{ n: customers }] },
            { rows: [{ n: orders }] },
            { rows: [{ n: proposals }] },
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) AS n FROM companies WHERE role = 'producer'"),
            pool.query("SELECT COUNT(*) AS n FROM companies WHERE role = 'customer'"),
            pool.query('SELECT COUNT(*) AS n FROM orders'),
            pool.query('SELECT COUNT(*) AS n FROM proposals'),
        ]);
        res.json({ producers, customers, orders, proposals });
    } catch (e) { next(e); }
});

app.get('/api/config/maps', (req, res) => {
    const yandexKey = process.env.YANDEX_MAPS_API_KEY || '';
    const provider = (process.env.MAP_PROVIDER || (yandexKey ? 'yandex' : 'leaflet')).toLowerCase();
    res.json({
        provider: provider === 'yandex' && yandexKey ? 'yandex' : 'leaflet',
        yandexMapsApiKey: yandexKey,
    });
});

// ===================== КАРТА ЗАВОДОВ =====================

app.get('/api/map', async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT *
            FROM companies
            WHERE role = 'producer'
            ORDER BY verified_by_platform DESC, company ASC
        `);
        const cityIndexes = new Map();
        const result = rows.map(r => {
            const producer = rowToCompany(r);
            const fallbackPoint = getCityProductionPoint(producer.city);
            const basePoint = producer.lat != null && producer.lng != null
                ? { lat: Number(producer.lat), lng: Number(producer.lng), region: fallbackPoint?.region || producer.city || '' }
                : fallbackPoint;
            if (!basePoint) return null;

            const cityKey = producer.city || producer.company;
            const cityIndex = cityIndexes.get(cityKey) || 0;
            cityIndexes.set(cityKey, cityIndex + 1);
            const point = offsetProductionPoint(basePoint, cityIndex);
            const categories = getProducerCategories(producer);

            return {
                id: producer.id,
                company: producer.company,
                city: producer.city,
                region: point.region || producer.city || '',
                specialization: producer.specialization || '',
                about: producer.about || '',
                equipment: producer.equipment || [],
                capabilities: producer.capabilities || [],
                categories: categories.length ? categories : ['Прочее'],
                status: producer.status,
                verified: producer.verifiedByPlatform,
                lat: point.lat,
                lng: point.lng,
                productionLoad: producer.productionLoad,
                freeCapacity: producer.freeCapacity || [],
                machinesCount: producer.machinesCount,
                productionArea: producer.productionArea,
                yearsExperience: producer.yearsExperience,
            };
        }).filter(Boolean);
        res.json(result);
    } catch (e) { next(e); }
});

// ===================== БИРЖА МОЩНОСТЕЙ =====================

app.get('/api/capacity', optionalAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT * FROM companies
            WHERE role = 'producer'
              AND free_capacity != '[]'
              AND free_capacity != 'null'
            ORDER BY company ASC
        `);
        const list = rows.map(rowToCompany).map(c => ({
            id: c.id, company: c.company, city: c.city, specialization: c.specialization,
            status: c.status, verifiedByPlatform: c.verifiedByPlatform,
            freeCapacity: c.freeCapacity,
        }));
        res.json(list);
    } catch (e) { next(e); }
});

// ===================== КАТАЛОГ ПРОИЗВОДИТЕЛЕЙ =====================

app.get('/api/catalog', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT * FROM companies
            WHERE role = 'producer'
            ORDER BY verified_by_platform DESC, company ASC
        `);
        res.json(rows.map(rowToCompany));
    } catch (e) { next(e); }
});

const aiSearchCache = new Map(); // query → { results, ts }
const AI_CACHE_TTL = 10 * 60 * 1000; // 10 минут

app.post('/api/ai-search', requireAuth, async (req, res, next) => {
    try {
        if (!genAI) return res.status(503).json({ error: 'AI не настроен: добавьте GEMINI_API_KEY в .env' });
        const { query } = req.body;
        if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });

        const cacheKey = query.trim().toLowerCase();
        const cached = aiSearchCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < AI_CACHE_TTL) return res.json(cached.results);

        const { rows } = await pool.query(`SELECT * FROM companies WHERE role = 'producer'`);
        const producers = rows.map(rowToCompany);

        const catalog = producers.map((p, i) =>
            `[${i}] ${p.company} | ${p.city || '—'} | ${p.specialization || '—'} | Возможности: ${(p.capabilities || []).join(', ') || '—'} | ${p.about || ''}`
        ).join('\n');

        const prompt = `Ты — ассистент B2B платформы прямых закупок ТехЗаказ (Россия).
Пользователь ищет: "${query.trim()}"

Каталог производителей (формат: [индекс] название | город | специализация | возможности | описание):
${catalog}

Верни JSON-массив с 1–6 наиболее подходящими производителями.
Для каждого: index (число из каталога) и reason (1–2 предложения на русском почему подходит).
Отвечай ТОЛЬКО валидным JSON без markdown. Пример: [{"index":0,"reason":"..."}]`;

        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-lite',
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ],
        });
        const result = await model.generateContent(prompt);

        let rawText;
        try { rawText = result.response.text(); }
        catch (textErr) {
            console.error('[ai-search] response.text() failed:', textErr.message);
            return res.status(500).json({ error: 'Gemini заблокировал ответ. Уточните запрос.' });
        }
        const text = rawText.trim().replace(/^```json|^```|```$/gm, '').trim();

        let matches;
        try { matches = JSON.parse(text); }
        catch { return res.status(500).json({ error: 'Не удалось разобрать ответ AI. Попробуйте ещё раз.' }); }
        if (!Array.isArray(matches)) return res.json([]);

        const found = matches
            .filter(m => Number.isInteger(m.index) && m.index >= 0 && m.index < producers.length)
            .map(m => ({ ...producers[m.index], aiReason: m.reason }));

        aiSearchCache.set(cacheKey, { results: found, ts: Date.now() });
        res.json(found);
    } catch (e) {
        console.error('[ai-search error]', e.message, e.status || '', e.stack || '');
        const msg = e.message || '';
        if (msg.includes('API key') || msg.includes('API_KEY') || e.status === 400)
            return res.status(400).json({ error: 'Неверный GEMINI_API_KEY. Проверьте ключ.' });
        if (e.status === 429 || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED'))
            return res.status(429).json({ error: 'Превышен лимит запросов Gemini. Попробуйте позже.' });
        return res.status(500).json({ error: `AI ошибка: ${msg} (status: ${e.status || 'n/a'})` });
    }
});

// ===================== SEO =====================
const seoAuditor = require('./seo/auditor');
const seoGsc     = require('./seo/gsc');
const seoYandex  = require('./seo/yandex');
const seoIntents = require('./seo/intents');

app.post('/api/seo/audit', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const results = await seoAuditor.auditAll();
        for (const r of results) {
            await pool.query(
                'INSERT INTO seo_audits (page, score, issues) VALUES ($1, $2, $3)',
                [r.page, r.score, JSON.stringify(r.issues)]
            );
        }
        res.json(results);
    } catch (e) { next(e); }
});

app.post('/api/seo/sync', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const end   = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const [gscRows, yandexRows] = await Promise.all([
            seoGsc.enabled    ? seoGsc.fetchSearchAnalytics(start, end) : [],
            seoYandex.enabled ? seoYandex.fetchQueries(start, end)      : [],
        ]);

        const allRows = [...gscRows, ...yandexRows];
        for (const r of allRows) {
            await pool.query(
                `INSERT INTO seo_snapshots (source, date, query, page, impressions, clicks, ctr, position)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (source, date, query, page)
                 DO UPDATE SET impressions=$5, clicks=$6, ctr=$7, position=$8`,
                [r.source, r.date, r.query, r.page, r.impressions, r.clicks, r.ctr, r.position]
            );
        }

        const uniqueQueries = [...new Set(allRows.map(r => r.query))];
        await seoIntents.classifyIntents(uniqueQueries, genAI, pool);

        const { rows: [lg] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='google'`);
        const { rows: [ly] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='yandex'`);

        res.json({
            synced: allRows.length,
            newQueries: uniqueQueries.length,
            lastSync: { google: lg?.d || null, yandex: ly?.d || null },
        });
    } catch (e) { next(e); }
});

app.get('/api/seo/data', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        // latest audit result per page
        const { rows: auditRows } = await pool.query(`
            SELECT DISTINCT ON (page) page, score, issues, audited_at
            FROM seo_audits
            ORDER BY page, audited_at DESC
        `);

        // latest snapshot per (source, query) with intent join
        const { rows: snapRows } = await pool.query(`
            SELECT s.source, s.query, s.page, s.impressions, s.clicks, s.ctr, s.position, s.date,
                   i.intent, i.intent_ru
            FROM seo_snapshots s
            LEFT JOIN seo_intents i ON i.query = s.query
            WHERE s.date = (
                SELECT MAX(s2.date) FROM seo_snapshots s2
                WHERE s2.source = s.source AND s2.query = s.query
            )
            ORDER BY s.impressions DESC
            LIMIT 1000
        `);

        // compute delta vs previous snapshot for each row
        const snapshots = await Promise.all(snapRows.map(async s => {
            const { rows: [prev] } = await pool.query(
                `SELECT position FROM seo_snapshots
                 WHERE source=$1 AND query=$2 AND date < $3
                 ORDER BY date DESC LIMIT 1`,
                [s.source, s.query, s.date]
            );
            const delta = prev ? parseFloat((s.position - prev.position).toFixed(2)) : null;
            return { ...s, delta };
        }));

        const { rows: [lg] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='google'`);
        const { rows: [ly] } = await pool.query(`SELECT MAX(date) AS d FROM seo_snapshots WHERE source='yandex'`);

        res.json({
            audit: auditRows,
            gscEnabled: seoGsc.enabled,
            yandexEnabled: seoYandex.enabled,
            snapshots,
            lastSync: { google: lg?.d || null, yandex: ly?.d || null },
        });
    } catch (e) { next(e); }
});

// ===================== CRM / АНАЛИТИКА =====================

app.get('/api/producer/crm-stats', requireAuth, requireRole('producer'), async (req, res, next) => {
    try {
        const company = req.user.company;
        const [
            { rows: [{ n: leads }] },
            { rows: [{ n: sent }] },
            { rows: [{ n: won }] },
            { rows: [{ n: active }] },
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE status = 'Активный'"),
            pool.query('SELECT COUNT(*) AS n FROM proposals WHERE company = $1', [company]),
            pool.query("SELECT COUNT(*) AS n FROM proposals WHERE company = $1 AND status = 'Выигран'", [company]),
            pool.query("SELECT COUNT(*) AS n FROM proposals WHERE company = $1 AND status = 'Ожидает ответа'", [company]),
        ]);
        const conversion = sent > 0 ? Math.round((won / sent) * 100) : 0;
        res.json({ leads, sent, won, active, conversion });
    } catch (e) { next(e); }
});

app.get('/api/customer/analytics', requireAuth, async (req, res, next) => {
    try {
        const company = req.user.company;
        const [
            { rows: [{ n: monthOrders }] },
            { rows: [{ n: activeOrders }] },
            { rows: [{ n: closedOrders }] },
            { rows: [{ n: totalProposals }] },
            { rows: [{ avg: avgDays }] },
            { rows: savingsRows },
            { rows: dynamicsRows },
            { rows: categoryRows },
            { rows: supplierRows },
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE company=$1 AND created_at>=date_trunc('month',NOW())", [company]),
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE company=$1 AND status='Активный'", [company]),
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE company=$1 AND status='Закрыта'", [company]),
            pool.query("SELECT COUNT(*) AS n FROM proposals p JOIN orders o ON o.id=p.order_id WHERE o.company=$1", [company]),
            pool.query(`SELECT ROUND(AVG(p.days)) AS avg FROM proposals p JOIN orders o ON o.id=p.order_id WHERE o.company=$1 AND p.status='Выигран'`, [company]),
            pool.query(`SELECT
                    (SELECT price FROM proposals WHERE order_id=o.id AND status='Выигран' LIMIT 1) AS win_price,
                    (SELECT AVG(price) FROM proposals WHERE order_id=o.id) AS avg_price
                FROM orders o WHERE o.company=$1 AND o.status='Закрыта'`, [company]),
            // Monthly dynamics: last 6 months
            pool.query(`SELECT
                    to_char(date_trunc('month', o.created_at), 'Mon YYYY') AS label,
                    date_trunc('month', o.created_at) AS month_dt,
                    COUNT(o.id) AS order_count,
                    COALESCE(SUM(p.price) FILTER (WHERE p.status='Выигран'), 0) AS volume
                FROM orders o
                LEFT JOIN proposals p ON p.order_id = o.id AND p.status='Выигран'
                WHERE o.company=$1 AND o.created_at >= NOW()-INTERVAL '6 months'
                GROUP BY date_trunc('month',o.created_at)
                ORDER BY month_dt`, [company]),
            // Category breakdown
            pool.query(`SELECT category, COUNT(*) AS cnt
                FROM orders WHERE company=$1
                GROUP BY category ORDER BY cnt DESC LIMIT 6`, [company]),
            // Top suppliers by won deal value
            pool.query(`SELECT p.company, COUNT(*) AS deals, SUM(p.price) AS total
                FROM proposals p JOIN orders o ON o.id=p.order_id
                WHERE o.company=$1 AND p.status='Выигран'
                GROUP BY p.company ORDER BY total DESC LIMIT 5`, [company]),
        ]);

        const validRows = savingsRows.filter(r => r.win_price && r.avg_price && r.avg_price > 0);
        const savings = validRows.length > 0
            ? Math.round(validRows.reduce((s, r) => s + (1 - r.win_price / r.avg_price), 0) / validRows.length * 100)
            : null;

        const totalSupply = supplierRows.reduce((s, r) => s + Number(r.total || 0), 0);

        res.json({
            monthOrders:   Number(monthOrders),
            activeOrders:  Number(activeOrders),
            closedOrders:  Number(closedOrders),
            totalProposals:Number(totalProposals),
            avgDays:       avgDays ? Math.round(avgDays) : null,
            savings,
            dynamics: dynamicsRows.map(r => ({
                label:      r.label,
                orderCount: Number(r.order_count),
                volume:     Math.round(Number(r.volume) / 1e6 * 100) / 100,
            })),
            categories: categoryRows.map(r => ({ label: r.category, count: Number(r.cnt) })),
            suppliers: supplierRows.map(r => ({
                name:   r.company,
                deals:  Number(r.deals),
                amount: Math.round(Number(r.total) / 1e6 * 100) / 100,
                share:  totalSupply > 0 ? Math.round(Number(r.total) / totalSupply * 1000) / 10 : 0,
            })),
        });
    } catch (e) { next(e); }
});

app.get('/api/messages/stats', requireAuth, async (req, res, next) => {
    try {
        const { role, company } = req.user;
        const whereClause = role === 'producer' ? 'm.company=$1' : 'o.company=$1';
        const todayStart  = "date_trunc('day', NOW())";

        const [{ rows: [convRow] }, { rows: [todayRow] }, { rows: [avgRow] }] = await Promise.all([
            pool.query(`SELECT
                COUNT(DISTINCT (m.order_id, m.company)) AS total_convs,
                SUM(CASE WHEN m.sender!=$2 AND m.read=false THEN 1 ELSE 0 END) AS unread
                FROM messages m JOIN orders o ON o.id=m.order_id WHERE ${whereClause}`,
                [company, role]),
            pool.query(`SELECT COUNT(*) AS n FROM messages m JOIN orders o ON o.id=m.order_id
                WHERE ${whereClause} AND m.sender!=$2 AND m.created_at>=${todayStart}`,
                [company, role]),
            // avg response time in hours (time between customer msg and next producer msg)
            pool.query(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (reply.created_at - orig.created_at))/3600)::numeric, 1) AS avg_h
                FROM messages orig
                JOIN messages reply ON reply.order_id=orig.order_id AND reply.company=orig.company
                    AND reply.sender!=orig.sender AND reply.created_at>orig.created_at
                JOIN orders o ON o.id=orig.order_id
                WHERE ${whereClause} AND orig.sender=$2
                    AND reply.created_at = (
                        SELECT MIN(created_at) FROM messages
                        WHERE order_id=orig.order_id AND company=orig.company
                            AND sender!=orig.sender AND created_at>orig.created_at
                    )`,
                [company, role]),
        ]);

        res.json({
            totalConversations: Number(convRow.total_convs || 0),
            unread:             Number(convRow.unread || 0),
            repliesToday:       Number(todayRow.n || 0),
            avgResponseHours:   avgRow.avg_h ? Number(avgRow.avg_h) : null,
        });
    } catch (e) { next(e); }
});

// ===================== РЕЙТИНГИ И ОТЗЫВЫ =====================

app.post('/api/reviews', requireAuth, async (req, res, next) => {
    try {
        const { orderId, toCompany, score, text = '' } = req.body;
        if (!orderId || !toCompany || !score) return res.status(400).json({ error: 'Заполните все поля' });
        const s = Number(score);
        if (s < 1 || s > 5) return res.status(400).json({ error: 'Оценка от 1 до 5' });

        const { rows: [deal] } = await pool.query(
            `SELECT 1 FROM proposals p JOIN orders o ON o.id=p.order_id
             WHERE p.order_id=$1 AND p.company=$2 AND p.status='Выигран' AND o.company=$3`,
            [orderId, toCompany, req.user.company]
        );
        if (!deal) return res.status(403).json({ error: 'Отзыв доступен только после завершения сделки' });

        await pool.query(
            `INSERT INTO reviews (order_id,from_company,to_company,score,text)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (order_id,from_company,to_company) DO UPDATE SET score=$4, text=$5`,
            [orderId, req.user.company, toCompany, s, text.slice(0, 1000)]
        );
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ── Auctions ─────────────────────────────────────────────────────────────────

// Create auction (customer only)
app.post('/api/auctions', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role !== 'customer') return res.status(403).json({ error: 'Только заказчики могут создавать аукционы' });
        const { orderId, startPrice, durationHours = 24 } = req.body;
        if (!orderId || !startPrice) return res.status(400).json({ error: 'orderId и startPrice обязательны' });

        const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1 AND company = $2', [orderId, req.user.company]);
        if (!order) return res.status(404).json({ error: 'Заявка не найдена' });

        const { rows: [existing] } = await pool.query("SELECT id FROM auctions WHERE order_id = $1 AND status = 'active'", [orderId]);
        if (existing) return res.status(409).json({ error: 'Аукцион по этой заявке уже активен' });

        const endTime = new Date(Date.now() + durationHours * 60 * 60 * 1000);
        const { rows: [auction] } = await pool.query(
            'INSERT INTO auctions (order_id, start_price, current_best, end_time) VALUES ($1,$2,$2,$3) RETURNING *',
            [orderId, startPrice, endTime]
        );
        io.emit('auction:created', { auctionId: auction.id, orderId, startPrice, endTime });
        res.json(auction);
    } catch (e) { next(e); }
});

// List active auctions (for producers)
app.get('/api/auctions', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT a.*, o.title, o.category, o.description, o.quantity, o.company as customer_company,
                   (SELECT COUNT(*) FROM auction_bids WHERE auction_id = a.id) as bid_count,
                   (SELECT company FROM auction_bids WHERE auction_id = a.id ORDER BY price ASC LIMIT 1) as leader_company
            FROM auctions a
            JOIN orders o ON o.id = a.order_id
            WHERE a.status = 'active' AND a.end_time > NOW()
            ORDER BY a.end_time ASC
        `);
        res.json(rows);
    } catch (e) { next(e); }
});

// Get single auction with bids
app.get('/api/auctions/:id', requireAuth, async (req, res, next) => {
    try {
        const { rows: [auction] } = await pool.query(`
            SELECT a.*, o.title, o.category, o.description, o.quantity, o.company as customer_company
            FROM auctions a JOIN orders o ON o.id = a.order_id WHERE a.id = $1
        `, [req.params.id]);
        if (!auction) return res.status(404).json({ error: 'Аукцион не найден' });

        const { rows: bids } = await pool.query(
            'SELECT * FROM auction_bids WHERE auction_id = $1 ORDER BY price ASC, created_at ASC',
            [req.params.id]
        );
        res.json({ ...auction, bids });
    } catch (e) { next(e); }
});

// Submit bid (producer only)
app.post('/api/auctions/:id/bid', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role !== 'producer') return res.status(403).json({ error: 'Только поставщики могут делать ставки' });
        const { price } = req.body;
        if (!price || isNaN(price)) return res.status(400).json({ error: 'Укажите цену' });

        const { rows: [auction] } = await pool.query(
            "SELECT * FROM auctions WHERE id = $1 AND status = 'active' AND end_time > NOW()", [req.params.id]
        );
        if (!auction) return res.status(404).json({ error: 'Аукцион не найден или завершён' });
        if (Number(price) >= Number(auction.current_best)) {
            return res.status(400).json({ error: `Ставка должна быть ниже текущей лучшей: ${auction.current_best} ₽` });
        }

        const { rows: [bid] } = await pool.query(
            'INSERT INTO auction_bids (auction_id, company, price) VALUES ($1,$2,$3) RETURNING *',
            [req.params.id, req.user.company, price]
        );
        await pool.query('UPDATE auctions SET current_best = $1, winner_company = $2 WHERE id = $3', [price, req.user.company, req.params.id]);

        io.to(`auction:${req.params.id}`).emit('auction:bid', {
            auctionId: Number(req.params.id), company: req.user.company, price: Number(price), bidId: bid.id, createdAt: bid.created_at
        });
        res.json(bid);
    } catch (e) { next(e); }
});

// My auctions (customer — see auctions for own orders)
app.get('/api/auctions/my/customer', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT a.*, o.title, o.category,
                   (SELECT COUNT(*) FROM auction_bids WHERE auction_id = a.id) as bid_count
            FROM auctions a JOIN orders o ON o.id = a.order_id
            WHERE o.company = $1 ORDER BY a.created_at DESC
        `, [req.user.company]);
        res.json(rows);
    } catch (e) { next(e); }
});

// Auto-close expired auctions (called by cron)
async function closeExpiredAuctions() {
    try {
        const { rows } = await pool.query(
            "UPDATE auctions SET status = 'closed' WHERE status = 'active' AND end_time <= NOW() RETURNING id, winner_company, order_id"
        );
        for (const a of rows) {
            io.to(`auction:${a.id}`).emit('auction:closed', { auctionId: a.id, winnerCompany: a.winner_company });
        }
    } catch {}
}

// ── Risk assessment ─────────────────────────────────────────────────────────
async function fetchEgrulData(inn) {
    return new Promise((resolve) => {
        const https = require('https');
        const body = `query=${encodeURIComponent(inn)}&page=1&cnt=&vpagesz=10`;
        const options = {
            hostname: 'egrul.nalog.ru',
            path: '/search.do',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
            timeout: 5000,
        };
        const req2 = https.request(options, (r) => {
            let data = '';
            r.on('data', chunk => data += chunk);
            r.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const row = (json.rows || [])[0];
                    if (!row) return resolve(null);
                    const isLiquidated = !!(row.e || (row.g && row.g !== ''));
                    const regDate = row.r ? row.r.split('.').reverse().join('-') : null;
                    resolve({ name: row.n, active: !isLiquidated, regDate, ogrn: row.o });
                } catch { resolve(null); }
            });
        });
        req2.on('error', () => resolve(null));
        req2.on('timeout', () => { req2.destroy(); resolve(null); });
        req2.write(body);
        req2.end();
    });
}

app.get('/api/risk/:inn', async (req, res, next) => {
    try {
        const { inn } = req.params;
        if (!/^\d{10,12}$/.test(inn)) return res.status(400).json({ error: 'Неверный формат ИНН' });

        const checks = [];
        let score = 0;

        // 1. EGRUL check
        const egrul = await fetchEgrulData(inn);
        if (egrul) {
            if (egrul.active) {
                checks.push({ name: 'Статус ЕГРЮЛ', status: 'ok', detail: 'Компания действующая' });
                score += 35;
            } else {
                checks.push({ name: 'Статус ЕГРЮЛ', status: 'fail', detail: 'Компания ликвидирована или в процессе ликвидации' });
            }
            if (egrul.regDate) {
                const ageMs = Date.now() - new Date(egrul.regDate).getTime();
                const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
                if (ageYears >= 3) {
                    checks.push({ name: 'Возраст компании', status: 'ok', detail: `${Math.floor(ageYears)} лет на рынке` });
                    score += 25;
                } else if (ageYears >= 1) {
                    const months = Math.floor(ageYears * 12);
                    checks.push({ name: 'Возраст компании', status: 'warn', detail: `${months} мес. на рынке — молодая компания` });
                    score += 12;
                } else {
                    checks.push({ name: 'Возраст компании', status: 'fail', detail: 'Менее года на рынке' });
                }
            }
        } else {
            checks.push({ name: 'ЕГРЮЛ', status: 'neutral', detail: 'Не удалось получить данные ФНС' });
        }

        // 2. Platform verification
        const { rows: compRows } = await pool.query(
            'SELECT verified_by_platform, name FROM companies WHERE inn = $1 LIMIT 1', [inn]
        );
        const comp = compRows[0];
        if (comp && comp.verified_by_platform) {
            checks.push({ name: 'Верификация платформы', status: 'ok', detail: 'Компания проверена командой ТехЗаказ' });
            score += 20;
        } else {
            checks.push({ name: 'Верификация платформы', status: 'warn', detail: 'Компания не верифицирована платформой' });
        }

        // 3. Reviews
        if (comp) {
            const { rows: revRows } = await pool.query(
                `SELECT AVG(score)::numeric(3,1) as avg, COUNT(*) as cnt FROM reviews WHERE to_company = $1`, [comp.name]
            );
            const rv = revRows[0];
            if (rv && parseInt(rv.cnt) > 0) {
                const avg = parseFloat(rv.avg);
                const cnt = parseInt(rv.cnt);
                if (avg >= 4.0) {
                    checks.push({ name: 'Отзывы на платформе', status: 'ok', detail: `Средняя оценка ${avg} (${cnt} отзывов)` });
                    score += 20;
                } else if (avg >= 3.0) {
                    checks.push({ name: 'Отзывы на платформе', status: 'warn', detail: `Средняя оценка ${avg} (${cnt} отзывов)` });
                    score += 10;
                } else {
                    checks.push({ name: 'Отзывы на платформе', status: 'fail', detail: `Низкие оценки: ${avg} (${cnt} отзывов)` });
                }
            } else {
                checks.push({ name: 'Отзывы на платформе', status: 'neutral', detail: 'Нет отзывов на платформе' });
                score += 5;
            }
        }

        const level = score >= 65 ? 'low' : score >= 35 ? 'medium' : 'high';
        res.json({ inn, level, score, checks });
    } catch (e) { next(e); }
});

app.get('/api/reviews/company/:name', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT from_company, score, text, created_at FROM reviews
             WHERE to_company=$1 ORDER BY created_at DESC LIMIT 30`,
            [req.params.name]
        );
        const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length * 10) / 10 : null;
        res.json({ reviews: rows, avg, count: rows.length });
    } catch (e) { next(e); }
});

// Check if current user already reviewed a specific deal
app.get('/api/reviews/check/:orderId/:toCompany', requireAuth, async (req, res, next) => {
    try {
        const { rows: [row] } = await pool.query(
            'SELECT score, text FROM reviews WHERE order_id=$1 AND from_company=$2 AND to_company=$3',
            [req.params.orderId, req.user.company, req.params.toCompany]
        );
        res.json(row || null);
    } catch (e) { next(e); }
});

// ===================== ШАБЛОНЫ ЗАКУПОК =====================

app.get('/api/templates', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM order_templates WHERE company=$1 ORDER BY created_at DESC',
            [req.user.company]
        );
        res.json(rows);
    } catch (e) { next(e); }
});

app.post('/api/templates', requireAuth, async (req, res, next) => {
    try {
        const { title, category, description, quantity, deadlineDays } = req.body;
        if (!title) return res.status(400).json({ error: 'Укажите название шаблона' });
        const { rows: [row] } = await pool.query(
            `INSERT INTO order_templates (company,title,category,description,quantity,deadline_days)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [req.user.company, title, category || '', description || '', quantity || null, deadlineDays || null]
        );
        res.status(201).json(row);
    } catch (e) { next(e); }
});

app.delete('/api/templates/:id', requireAuth, async (req, res, next) => {
    try {
        await pool.query('DELETE FROM order_templates WHERE id=$1 AND company=$2', [req.params.id, req.user.company]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ===================== ЭКСПОРТ EXCEL =====================

app.get('/api/export/orders.xlsx', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT o.id, o.title, o.category, o.status, o.created_at, o.deadline,
                    COUNT(p.id) AS proposals,
                    MIN(p.price) FILTER (WHERE p.status='Выигран') AS won_price,
                    MIN(p.company) FILTER (WHERE p.status='Выигран') AS won_supplier
             FROM orders o LEFT JOIN proposals p ON p.order_id=o.id
             WHERE o.company=$1
             GROUP BY o.id ORDER BY o.created_at DESC`,
            [req.user.company]
        );

        const wb = new ExcelJS.Workbook();
        wb.creator = 'ТехЗаказ';
        const ws = wb.addWorksheet('Закупки');
        ws.columns = [
            { header:'№',                  key:'id',           width:8  },
            { header:'Наименование',        key:'title',        width:40 },
            { header:'Категория',           key:'category',     width:22 },
            { header:'Статус',              key:'status',       width:16 },
            { header:'Дедлайн',             key:'deadline',     width:14 },
            { header:'Откликов',            key:'proposals',    width:12 },
            { header:'Цена договора, ₽',   key:'won_price',    width:18 },
            { header:'Поставщик',           key:'won_supplier', width:32 },
            { header:'Дата создания',       key:'created_at',   width:18 },
        ];
        ws.getRow(1).font  = { bold:true, color:{ argb:'FFFFFFFF' } };
        ws.getRow(1).fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E3A5F' } };
        ws.getRow(1).alignment = { vertical:'middle' };

        rows.forEach(r => ws.addRow({
            id:           r.id,
            title:        r.title,
            category:     r.category,
            status:       r.status,
            deadline:     r.deadline || '—',
            proposals:    Number(r.proposals),
            won_price:    r.won_price ? Number(r.won_price) : '',
            won_supplier: r.won_supplier || '—',
            created_at:   new Date(r.created_at).toLocaleDateString('ru-RU'),
        }));

        ws.getColumn('won_price').numFmt = '#,##0';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%D0%97%D0%B0%D0%BA%D1%83%D0%BF%D0%BA%D0%B8-${Date.now()}.xlsx`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { next(e); }
});

app.get('/api/export/proposals.xlsx', requireAuth, async (req, res, next) => {
    try {
        const isProducer = req.user.role === 'producer';
        const { rows } = isProducer
            ? await pool.query(
                `SELECT p.id, o.title AS order_title, o.category, p.price, p.days,
                        p.status, p.created_at, o.company AS customer
                 FROM proposals p JOIN orders o ON o.id=p.order_id
                 WHERE p.company=$1 ORDER BY p.created_at DESC`,
                [req.user.company]
              )
            : await pool.query(
                `SELECT p.id, o.title AS order_title, o.category, p.company AS supplier,
                        p.price, p.days, p.status, p.created_at
                 FROM proposals p JOIN orders o ON o.id=p.order_id
                 WHERE o.company=$1 ORDER BY p.created_at DESC`,
                [req.user.company]
              );

        const wb = new ExcelJS.Workbook();
        wb.creator = 'ТехЗаказ';
        const ws = wb.addWorksheet('КП');
        ws.columns = isProducer ? [
            { header:'Заявка',      key:'order_title', width:40 },
            { header:'Категория',   key:'category',    width:22 },
            { header:'Заказчик',    key:'customer',    width:30 },
            { header:'Цена, ₽',    key:'price',       width:16 },
            { header:'Срок, дн',   key:'days',        width:12 },
            { header:'Статус',      key:'status',      width:18 },
            { header:'Дата',        key:'created_at',  width:16 },
        ] : [
            { header:'Заявка',      key:'order_title', width:40 },
            { header:'Категория',   key:'category',    width:22 },
            { header:'Поставщик',   key:'supplier',    width:30 },
            { header:'Цена, ₽',    key:'price',       width:16 },
            { header:'Срок, дн',   key:'days',        width:12 },
            { header:'Статус',      key:'status',      width:18 },
            { header:'Дата',        key:'created_at',  width:16 },
        ];
        ws.getRow(1).font = { bold:true, color:{ argb:'FFFFFFFF' } };
        ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFF6A00' } };

        rows.forEach(r => ws.addRow({
            ...r,
            price:      Number(r.price),
            created_at: new Date(r.created_at).toLocaleDateString('ru-RU'),
        }));
        ws.getColumn('price').numFmt = '#,##0';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%D0%9A%D0%9F-${Date.now()}.xlsx`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { next(e); }
});

// ===================== НАСТРОЙКА ДАЙДЖЕСТА =====================

app.patch('/api/auth/digest', requireAuth, async (req, res, next) => {
    try {
        const { frequency } = req.body;
        if (!['daily','weekly','never'].includes(frequency)) return res.status(400).json({ error: 'Недопустимое значение' });
        await pool.query('UPDATE users SET digest_frequency=$1 WHERE id=$2', [frequency, req.user.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ===================== КОМАНДА / ПРИГЛАШЕНИЯ =====================

app.get('/api/team/members', requireAuth, async (req, res, next) => {
    try {
        const { rows: members } = await pool.query(
            'SELECT id, email, team_role, created_at FROM users WHERE company=$1 ORDER BY created_at',
            [req.user.company]
        );
        const { rows: pending } = await pool.query(
            "SELECT id, email, team_role, created_at FROM invitations WHERE company=$1 AND accepted=false AND expires_at>NOW() ORDER BY created_at DESC",
            [req.user.company]
        );
        res.json({ members, pending });
    } catch (e) { next(e); }
});

app.post('/api/team/invite', requireAuth, async (req, res, next) => {
    try {
        const { email, teamRole = 'member' } = req.body;
        if (!email) return res.status(400).json({ error: 'Укажите email' });
        if (!['admin','member','viewer'].includes(teamRole)) return res.status(400).json({ error: 'Недопустимая роль' });

        const { rows: [existing] } = await pool.query('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)', [email]);
        if (existing) return res.status(409).json({ error: 'Этот email уже зарегистрирован на платформе' });

        const token = crypto.randomBytes(24).toString('hex');
        await pool.query(
            `INSERT INTO invitations (token,email,company,role,team_role,invited_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (token) DO NOTHING`,
            [token, email.toLowerCase(), req.user.company, req.user.role, teamRole, req.user.email]
        );

        const appUrl = process.env.APP_URL || 'https://texzakaz.ru';
        const inviteUrl = `${appUrl}/login.html?invite=${token}`;
        const roleLabels = { admin:'Администратор', member:'Менеджер', viewer:'Наблюдатель' };
        await sendEmail(email, `Приглашение в команду — ТехЗаказ`, `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
                <h2 style="color:#1E3A5F;margin:0 0 12px;">Вас пригласили в команду</h2>
                <p style="color:#444;margin:0 0 8px;">Пользователь <strong>${req.user.email}</strong> приглашает вас присоединиться к компании</p>
                <p style="font-size:18px;font-weight:700;color:#1E3A5F;margin:0 0 16px;">${req.user.company}</p>
                <p style="color:#666;margin:0 0 20px;">Роль в команде: <strong>${roleLabels[teamRole] || teamRole}</strong></p>
                <a href="${inviteUrl}" style="display:inline-block;background:#FF6A00;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Принять приглашение →</a>
                <p style="color:#aaa;font-size:12px;margin-top:20px;">Ссылка действительна 7 дней. Если вы не ожидали этого письма — проигнорируйте его.</p>
            </div>`);

        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.delete('/api/team/members/:id', requireAuth, async (req, res, next) => {
    try {
        const targetId = Number(req.params.id);
        if (targetId === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
        const { rows: [target] } = await pool.query('SELECT company FROM users WHERE id=$1', [targetId]);
        if (!target || target.company !== req.user.company) return res.status(404).json({ error: 'Пользователь не найден' });
        await pool.query('DELETE FROM users WHERE id=$1', [targetId]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.delete('/api/team/invites/:id', requireAuth, async (req, res, next) => {
    try {
        await pool.query('DELETE FROM invitations WHERE id=$1 AND company=$2', [req.params.id, req.user.company]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Public — called before login to prefill registration form
app.get('/api/invitations/:token', async (req, res, next) => {
    try {
        const { rows: [inv] } = await pool.query(
            "SELECT email, company, role, team_role FROM invitations WHERE token=$1 AND accepted=false AND expires_at>NOW()",
            [req.params.token]
        );
        if (!inv) return res.status(404).json({ error: 'Приглашение недействительно или истекло' });
        res.json(inv);
    } catch (e) { next(e); }
});

// ===================== ИЗБРАННЫЕ =====================

app.get('/api/favorites', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT c.* FROM companies c JOIN favorites f ON c.id = f.company_id WHERE f.owner_company = $1',
            [req.user.company]
        );
        const enriched = await Promise.all(rows.map(r => enrichCompany(rowToCompany(r), req.user.company)));
        res.json(enriched);
    } catch (e) { next(e); }
});

app.post('/api/favorites', requireAuth, async (req, res, next) => {
    try {
        const id = Number(req.body.companyId);
        if (!id) return res.status(400).json({ error: 'Не указан ID компании' });
        const { rows: [exists] } = await pool.query('SELECT 1 FROM companies WHERE id = $1', [id]);
        if (!exists) return res.status(404).json({ error: 'Компания не найдена' });
        await pool.query(
            'INSERT INTO favorites (owner_company, company_id) VALUES ($1, $2) ON CONFLICT (owner_company, company_id) DO NOTHING',
            [req.user.company, id]
        );
        res.status(201).json({ message: 'Добавлено в избранное' });
    } catch (e) { next(e); }
});

app.delete('/api/favorites/:companyId', requireAuth, async (req, res, next) => {
    try {
        await pool.query('DELETE FROM favorites WHERE owner_company = $1 AND company_id = $2', [req.user.company, Number(req.params.companyId)]);
        res.json({ message: 'Удалено из избранного' });
    } catch (e) { next(e); }
});

// ===================== AUTH =====================

app.post('/api/auth/register', async (req, res, next) => {
    try {
        const { email, password, company, inn, role } = req.body;
        if (!email || !password || !company || !role) return res.status(400).json({ error: 'Заполните все поля регистрации' });
        const ALLOWED_ROLES = ['customer', 'producer'];
        if (!ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
        if (password.length < 8) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });

        const { rows: [taken] } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (taken) return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });

        // Validate invite token if provided
        let inviteData = null;
        if (req.body.inviteToken) {
            const { rows: [inv] } = await pool.query(
                "SELECT * FROM invitations WHERE token=$1 AND LOWER(email)=LOWER($2) AND accepted=false AND expires_at>NOW()",
                [req.body.inviteToken, email]
            );
            if (!inv) return res.status(400).json({ error: 'Приглашение недействительно или истекло' });
            inviteData = inv;
        }

        const resolvedCompany = inviteData ? inviteData.company : company;
        const resolvedRole    = inviteData ? inviteData.role    : role;
        const resolvedTeamRole = inviteData ? (inviteData.team_role || 'member') : 'admin';

        const newUser = await withTransaction(async (client) => {
            const { rows: [u] } = await client.query(
                'INSERT INTO users (email,password,role,company,inn,team_role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
                [email, hashPassword(password), resolvedRole, resolvedCompany, inn || '', resolvedTeamRole]
            );
            const { rows: [compExists] } = await client.query('SELECT 1 FROM companies WHERE company = $1 AND role = $2', [resolvedCompany, resolvedRole]);
            if (!compExists) {
                await client.query(
                    "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,$2,$3,$4,$5)",
                    [resolvedCompany, inn || '', resolvedRole, '', 'На проверке']
                );
            }
            if (inviteData) {
                await client.query('UPDATE invitations SET accepted=true WHERE id=$1', [inviteData.id]);
            }
            return u;
        });

        const { accessToken, refreshToken } = generateTokens(newUser);
        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
            [newUser.id, refreshToken]
        );
        await sendVerificationEmail(newUser);
        setAuthCookies(res, accessToken, refreshToken);
        res.status(201).json({
            token: accessToken,
            refreshToken,
            role: resolvedRole,
            company: resolvedCompany,
            emailVerified: false,
            message: 'Аккаунт создан. Подтвердите email — письмо отправлено на вашу почту.',
        });
    } catch (e) { next(e); }
});

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' });

        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Неверный email или пароль' });

        if (!user.password.includes(':')) {
            await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(password), user.id]);
        }

        if (user.totp_enabled) {
            const { totpCode } = req.body;
            if (!totpCode) return res.status(200).json({ require2fa: true });
            const valid = speakeasy.totp.verify({
                secret:   user.totp_secret,
                encoding: 'base32',
                token:    String(totpCode).replace(/\s/g, ''),
                window:   1,
            });
            if (!valid) return res.status(401).json({ error: 'Неверный код 2FA' });
        }

        const { accessToken, refreshToken } = generateTokens(user);
        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
            [user.id, refreshToken]
        );
        setAuthCookies(res, accessToken, refreshToken);
        res.json({
            token: accessToken,
            refreshToken,
            role: user.role,
            company: user.company,
            emailVerified: Boolean(user.email_verified),
            totpEnabled:   Boolean(user.totp_enabled),
        });
    } catch (e) { next(e); }
});

// ── 2FA setup ─────────────────────────────────────────────────────────────

app.post('/api/auth/2fa/setup', requireAuth, async (req, res, next) => {
    try {
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (user.totp_enabled) return res.status(400).json({ error: '2FA уже включена' });

        const secret = speakeasy.generateSecret({ name: `ТЕХЗАКАЗ (${user.email})`, issuer: 'ТЕХЗАКАЗ', length: 20 });
        await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret.base32, user.id]);

        const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
        res.json({ qr: qrDataUrl, secret: secret.base32 });
    } catch (e) { next(e); }
});

app.post('/api/auth/2fa/confirm', requireAuth, async (req, res, next) => {
    try {
        const { code } = req.body;
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (!user.totp_secret) return res.status(400).json({ error: 'Сначала выполните /api/auth/2fa/setup' });
        if (user.totp_enabled) return res.status(400).json({ error: '2FA уже включена' });

        const valid = speakeasy.totp.verify({
            secret:   user.totp_secret,
            encoding: 'base32',
            token:    String(code).replace(/\s/g, ''),
            window:   1,
        });
        if (!valid) return res.status(400).json({ error: 'Неверный код — попробуйте ещё раз' });

        await pool.query('UPDATE users SET totp_enabled = true WHERE id = $1', [user.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.post('/api/auth/2fa/disable', requireAuth, async (req, res, next) => {
    try {
        const { code } = req.body;
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (!user.totp_enabled) return res.status(400).json({ error: '2FA не включена' });

        const valid = speakeasy.totp.verify({
            secret:   user.totp_secret,
            encoding: 'base32',
            token:    String(code).replace(/\s/g, ''),
            window:   1,
        });
        if (!valid) return res.status(400).json({ error: 'Неверный код' });

        await pool.query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [user.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ===================== ЯНДЕКС OAUTH =====================

const YANDEX_CLIENT_ID     = process.env.YANDEX_CLIENT_ID     || '';
const YANDEX_CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET || '';

app.get('/api/auth/yandex', (req, res) => {
    if (!YANDEX_CLIENT_ID) return res.status(503).json({ error: 'Яндекс OAuth не настроен' });
    const redirectUri = process.env.YANDEX_REDIRECT_URI || `${APP_URL}/api/auth/yandex/callback`;
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: YANDEX_CLIENT_ID,
        redirect_uri: redirectUri,
        force_confirm: 'yes',
    });
    res.redirect(`https://oauth.yandex.ru/authorize?${params}`);
});

app.get('/api/auth/yandex/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) return res.redirect('/login.html?error=oauth_denied');
    if (!YANDEX_CLIENT_ID) return res.redirect('/login.html?error=oauth_not_configured');

    try {
        const redirectUri = process.env.YANDEX_REDIRECT_URI || `${APP_URL}/api/auth/yandex/callback`;

        // Обмен кода на токен
        const tokenRes = await fetch('https://oauth.yandex.ru/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                client_id: YANDEX_CLIENT_ID,
                client_secret: YANDEX_CLIENT_SECRET,
                redirect_uri: redirectUri,
            }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            console.error('Yandex token error:', tokenData);
            return res.redirect('/login.html?error=oauth_token');
        }

        // Получение данных пользователя
        const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
            headers: { Authorization: `OAuth ${tokenData.access_token}` },
        });
        const info = await infoRes.json();

        const email = info.default_email || (info.emails && info.emails[0]);
        if (!email) return res.redirect('/login.html?error=oauth_no_email');

        // Поиск или создание пользователя
        let { rows: [user] } = await pool.query(
            'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]
        );
        if (!user) {
            const company = info.real_name || info.display_name || info.login || email.split('@')[0];
            await withTransaction(async (client) => {
                const { rows: [u] } = await client.query(
                    "INSERT INTO users (email, password, role, company, inn) VALUES ($1,$2,'customer',$3,'') RETURNING *",
                    [email, hashPassword(crypto.randomBytes(32).toString('hex')), company]
                );
                const { rows: [exists] } = await client.query(
                    'SELECT 1 FROM companies WHERE company=$1 AND role=$2', [company, 'customer']
                );
                if (!exists) {
                    await client.query(
                        "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,'','customer','','На проверке')",
                        [company]
                    );
                }
                user = u;
            });
        }

        const { accessToken, refreshToken } = generateTokens(user);
        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,NOW() + INTERVAL '30 days')",
            [user.id, refreshToken]
        );
        setAuthCookies(res, accessToken, refreshToken);

        // Редирект на login.html — он подхватит параметры и установит localStorage
        const ev = user.email_verified ? '1' : '0';
        res.redirect(`/login.html?oauth_ok=1&role=${encodeURIComponent(user.role)}&company=${encodeURIComponent(user.company)}&ev=${ev}`);
    } catch (e) {
        console.error('Yandex OAuth callback error:', e);
        res.redirect('/login.html?error=oauth_error');
    }
});

// ===================== ИНТЕГРАЦИИ =====================

// ── Push helpers ──────────────────────────────────────────────────────────

async function pushToBitrix24(config, proposal, order) {
    const url = (config.webhookUrl || '').trim().replace(/\/?$/, '/');
    if (!url) return;
    try {
        await fetch(`${url}crm.deal.add.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    TITLE:       order.title,
                    OPPORTUNITY: proposal.price || 0,
                    CURRENCY_ID: 'RUB',
                    STAGE_ID:    'WON',
                    COMMENTS:    `Поставщик: ${proposal.company}. Срок поставки: ${proposal.days} дн. Источник: ТЕХЗАКАЗ.`,
                    SOURCE_ID:   'OTHER',
                },
            }),
        });
    } catch (e) {
        console.error('[bitrix24 push]', e.message);
    }
}

async function pushToAmoCRM(config, proposal, order) {
    const { subdomain, accessToken } = config;
    if (!subdomain || !accessToken) return;
    try {
        await fetch(`https://${subdomain}.amocrm.ru/api/v4/leads`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify([{
                name:  order.title,
                price: proposal.price || 0,
                _embedded: {
                    tags: [{ name: 'ТЕХЗАКАЗ' }],
                },
                custom_fields_values: [{
                    field_code: 'COMMENTS',
                    values: [{ value: `Поставщик: ${proposal.company}. Срок: ${proposal.days} дн.` }],
                }],
            }]),
        });
    } catch (e) {
        console.error('[amocrm push]', e.message);
    }
}

// ── SAP Business One (Service Layer) ──────────────────────────────────────

async function sapB1Login(config) {
    const { serverUrl, companyDB, username, password } = config;
    const r = await fetch(`${serverUrl}/b1s/v1/Login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompanyDB: companyDB, UserName: username, Password: password }),
    });
    if (!r.ok) throw new Error(`SAP B1 login failed: ${r.status}`);
    const cookie = r.headers.get('set-cookie') || '';
    const sessionMatch = cookie.match(/B1SESSION=([^;]+)/);
    if (!sessionMatch) throw new Error('SAP B1: no session cookie');
    return sessionMatch[1];
}

async function pushToSapB1(config, proposal, order) {
    try {
        const session = await sapB1Login(config);
        const dateStr = new Date().toISOString().split('T')[0];
        await fetch(`${config.serverUrl}/b1s/v1/PurchaseOrders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `B1SESSION=${session}`,
            },
            body: JSON.stringify({
                DocDate:   dateStr,
                DocDueDate: dateStr,
                Comments:  `ТЕХЗАКАЗ #${order.id}: ${order.title}. Поставщик: ${proposal.company}. Срок: ${proposal.days} дн.`,
                DocumentLines: [{
                    ItemDescription: order.title,
                    Quantity:        order.quantity || 1,
                    UnitPrice:       proposal.price || 0,
                    Currency:        'RUB',
                    WarehouseCode:   config.warehouseCode || '01',
                }],
            }),
        });
    } catch (e) {
        console.error('[sap-b1 push]', e.message);
    }
}

// ── SAP S/4HANA (OData v2) ────────────────────────────────────────────────

async function pushToSapS4(config, proposal, order) {
    const { host, username, password, companyCode } = config;
    try {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        const base = `${host}/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV`;

        // Fetch CSRF token
        const tokenRes = await fetch(`${base}/$metadata`, {
            headers: { 'Authorization': `Basic ${auth}`, 'x-csrf-token': 'fetch' },
        });
        const csrfToken = tokenRes.headers.get('x-csrf-token') || '';
        const cookies   = tokenRes.headers.get('set-cookie') || '';

        await fetch(`${base}/A_PurchaseOrder`, {
            method: 'POST',
            headers: {
                'Authorization':   `Basic ${auth}`,
                'Content-Type':    'application/json',
                'Accept':          'application/json',
                'x-csrf-token':    csrfToken,
                'Cookie':          cookies,
            },
            body: JSON.stringify({
                PurchaseOrderType:       'NB',
                CompanyCode:             companyCode || '1000',
                PurchasingOrganization:  config.purchasingOrg || '1000',
                PurchasingGroup:         config.purchasingGroup || '001',
                Supplier:                config.defaultVendor || '',
                to_PurchaseOrderItem: { results: [{
                    PurchaseOrderItem:     '00010',
                    PurchaseOrderItemText: order.title.slice(0, 40),
                    Plant:                 config.plant || '1000',
                    OrderQuantity:         String(order.quantity || 1),
                    PurchaseOrderQuantityUnit: 'PC',
                    NetPriceAmount:        String(proposal.price || 0),
                    NetPriceCurrency:      'RUB',
                }]},
            }),
        });
    } catch (e) {
        console.error('[sap-s4 push]', e.message);
    }
}

async function triggerIntegrations(customerCompany, proposal, order) {
    try {
        const { rows } = await pool.query(
            "SELECT * FROM integrations WHERE company = $1 AND enabled = true",
            [customerCompany]
        );
        await Promise.all(rows.map(row => {
            if (row.provider === 'bitrix24') return pushToBitrix24(row.config, proposal, order);
            if (row.provider === 'amocrm')   return pushToAmoCRM(row.config, proposal, order);
            if (row.provider === 'sap-b1')   return pushToSapB1(row.config, proposal, order);
            if (row.provider === 'sap-s4')   return pushToSapS4(row.config, proposal, order);
        }));
    } catch (e) {
        console.error('[integrations trigger]', e.message);
    }
}

// ── CRUD ──────────────────────────────────────────────────────────────────

app.get('/api/integrations', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT provider, enabled, created_at, config FROM integrations WHERE company = $1',
            [req.user.company]
        );
        res.json(rows.map(r => ({
            provider: r.provider,
            enabled:  r.enabled,
            connectedAt: r.created_at,
            preview: previewConfig(r.provider, r.config),
        })));
    } catch (e) { next(e); }
});

function previewConfig(provider, config) {
    if (provider === 'bitrix24') {
        const url = config.webhookUrl || '';
        return url ? url.replace(/\/rest\/.*/, '/rest/…') : '';
    }
    if (provider === 'amocrm')  return config.subdomain  ? `${config.subdomain}.amocrm.ru` : '';
    if (provider === 'sap-b1')  return config.serverUrl  ? `${config.serverUrl} / ${config.companyDB}` : '';
    if (provider === 'sap-s4')  return config.host       ? config.host.replace(/^https?:\/\//, '') : '';
    return '';
}

app.post('/api/integrations/:provider', requireAuth, async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!['bitrix24', 'amocrm', 'sap-b1', 'sap-s4'].includes(provider))
            return res.status(400).json({ error: 'Неизвестный провайдер' });

        let config = {};
        if (provider === 'bitrix24') {
            const { webhookUrl } = req.body;
            if (!webhookUrl?.trim()) return res.status(400).json({ error: 'Укажите webhook URL' });
            try { new URL(webhookUrl.trim()); } catch { return res.status(400).json({ error: 'Неверный URL' }); }
            if (!webhookUrl.includes('/rest/')) return res.status(400).json({ error: 'URL должен содержать /rest/' });
            config = { webhookUrl: webhookUrl.trim() };
        }
        if (provider === 'amocrm') {
            const { subdomain, accessToken } = req.body;
            if (!subdomain?.trim() || !accessToken?.trim())
                return res.status(400).json({ error: 'Укажите поддомен и токен доступа' });
            config = { subdomain: subdomain.trim().replace(/\.amocrm\.ru$/, ''), accessToken: accessToken.trim() };
        }
        if (provider === 'sap-b1') {
            const { serverUrl, companyDB, username, password, warehouseCode } = req.body;
            if (!serverUrl?.trim() || !companyDB?.trim() || !username?.trim() || !password?.trim())
                return res.status(400).json({ error: 'Укажите URL сервера, базу данных, логин и пароль' });
            try { new URL(serverUrl.trim()); } catch { return res.status(400).json({ error: 'Неверный URL сервера' }); }
            config = { serverUrl: serverUrl.trim().replace(/\/$/, ''), companyDB: companyDB.trim(), username: username.trim(), password: password.trim(), warehouseCode: warehouseCode?.trim() || '01' };
        }
        if (provider === 'sap-s4') {
            const { host, username, password, companyCode, purchasingOrg, purchasingGroup, plant, defaultVendor } = req.body;
            if (!host?.trim() || !username?.trim() || !password?.trim())
                return res.status(400).json({ error: 'Укажите хост, логин и пароль' });
            try { new URL(host.trim()); } catch { return res.status(400).json({ error: 'Неверный URL хоста' }); }
            config = {
                host:           host.trim().replace(/\/$/, ''),
                username:       username.trim(),
                password:       password.trim(),
                companyCode:    companyCode?.trim()    || '1000',
                purchasingOrg:  purchasingOrg?.trim()  || '1000',
                purchasingGroup:purchasingGroup?.trim() || '001',
                plant:          plant?.trim()           || '1000',
                defaultVendor:  defaultVendor?.trim()   || '',
            };
        }

        await pool.query(
            `INSERT INTO integrations (company, provider, config)
             VALUES ($1, $2, $3)
             ON CONFLICT (company, provider) DO UPDATE SET config = $3, enabled = true, created_at = NOW()`,
            [req.user.company, provider, JSON.stringify(config)]
        );
        res.json({ ok: true, preview: previewConfig(provider, config) });
    } catch (e) { next(e); }
});

app.post('/api/integrations/:provider/test', requireAuth, async (req, res, next) => {
    try {
        const { provider } = req.params;
        const { rows: [row] } = await pool.query(
            'SELECT config FROM integrations WHERE company = $1 AND provider = $2',
            [req.user.company, provider]
        );
        if (!row) return res.status(404).json({ error: 'Интеграция не подключена' });

        if (provider === 'bitrix24') {
            const url = (row.config.webhookUrl || '').trim().replace(/\/?$/, '/');
            const r = await fetch(`${url}profile.json`);
            const data = await r.json();
            if (!r.ok || data.error) return res.status(400).json({ error: data.error_description || 'Ошибка соединения с Bitrix24' });
            return res.json({ ok: true, info: data.result?.NAME || 'Подключено' });
        }
        if (provider === 'amocrm') {
            const { subdomain, accessToken } = row.config;
            const r = await fetch(`https://${subdomain}.amocrm.ru/api/v4/account`, {
                headers: { 'Authorization': `Bearer ${accessToken}` },
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) return res.status(400).json({ error: data.detail || 'Ошибка соединения с AmoCRM' });
            return res.json({ ok: true, info: data.name || subdomain });
        }
        if (provider === 'sap-b1') {
            try {
                const session = await sapB1Login(row.config);
                const r = await fetch(`${row.config.serverUrl}/b1s/v1/CompanyService_GetAdminInfo`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Cookie': `B1SESSION=${session}` },
                    body: '{}',
                });
                const data = await r.json().catch(() => ({}));
                return res.json({ ok: true, info: data.CompanyName || row.config.companyDB });
            } catch (e) {
                return res.status(400).json({ error: e.message });
            }
        }
        if (provider === 'sap-s4') {
            const { host, username, password } = row.config;
            const auth = Buffer.from(`${username}:${password}`).toString('base64');
            const r = await fetch(`${host}/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/$metadata`, {
                headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/xml' },
            });
            if (!r.ok) return res.status(400).json({ error: `HTTP ${r.status} — проверьте хост и учётные данные` });
            return res.json({ ok: true, info: host.replace(/^https?:\/\//, '') });
        }
        res.status(400).json({ error: 'Тест не поддерживается' });
    } catch (e) { next(e); }
});

app.delete('/api/integrations/:provider', requireAuth, async (req, res, next) => {
    try {
        await pool.query(
            'DELETE FROM integrations WHERE company = $1 AND provider = $2',
            [req.user.company, req.params.provider]
        );
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ── 1С CommerceML XML export ───────────────────────────────────────────────

app.get('/api/export/1c/:proposalId', requireAuth, async (req, res, next) => {
    try {
        const { rows: [row] } = await pool.query(`
            SELECT p.*, o.title AS order_title, o.quantity, o.description, o.deadline, o.company AS customer
            FROM proposals p
            JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1
        `, [Number(req.params.proposalId)]);

        if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
        if (row.customer !== req.user.company && req.user.role !== 'admin')
            return res.status(403).json({ error: 'Нет доступа' });

        const now     = new Date().toISOString();
        const dateStr = now.split('T')[0];
        const price   = Number(row.price) || 0;
        const qty     = Number(row.quantity) || 1;

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация xmlns="urn:1C.ru:commerceml_2" ВерсияСхемы="2.09" ДатаФормирования="${now}">
  <Документ>
    <Ид>TZ-${row.id}</Ид>
    <Номер>${row.id}</Номер>
    <Дата>${dateStr}</Дата>
    <ХозОперация>Заказ товара</ХозОперация>
    <Роль>Покупатель</Роль>
    <Валюта>RUB</Валюта>
    <Курс>1</Курс>
    <Сумма>${price.toFixed(2)}</Сумма>
    <Комментарий>${htmlEscape(row.description || '')}</Комментарий>
    ${row.deadline ? `<СрокПоставки>${row.deadline}</СрокПоставки>` : ''}
    <Контрагенты>
      <Контрагент>
        <Наименование>${htmlEscape(row.company)}</Наименование>
        <Роль>Продавец</Роль>
      </Контрагент>
      <Контрагент>
        <Наименование>${htmlEscape(row.customer)}</Наименование>
        <Роль>Покупатель</Роль>
      </Контрагент>
    </Контрагенты>
    <Товары>
      <Товар>
        <Ид>ITEM-${row.order_id}</Ид>
        <Наименование>${htmlEscape(row.order_title)}</Наименование>
        <Количество>${qty}</Количество>
        <Цена>${(price / qty).toFixed(2)}</Цена>
        <Сумма>${price.toFixed(2)}</Сумма>
        <ЕдиницаИзмерения>шт</ЕдиницаИзмерения>
        <СтавкаНДС>Без НДС</СтавкаНДС>
      </Товар>
    </Товары>
  </Документ>
</КоммерческаяИнформация>`;

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="order-${row.id}.xml"`);
        res.send(xml);
    } catch (e) { next(e); }
});

// ===================== ЗАДАЧИ =====================

app.get('/api/tasks', requireAuth, async (req, res, next) => {
    try {
        const { orderId, company } = req.query;
        const { rows } = await pool.query(
            'SELECT * FROM tasks WHERE order_id = $1 AND company = $2 ORDER BY created_at ASC',
            [Number(orderId), company]
        );
        res.json(rows.map(r => ({ id: r.id, title: r.title, dueDate: r.due_date, status: r.status, createdBy: r.created_by, createdAt: r.created_at })));
    } catch (e) { next(e); }
});

app.post('/api/tasks', requireAuth, async (req, res, next) => {
    try {
        const { orderId, company, title, dueDate } = req.body;
        if (!orderId || !company || !title?.trim()) return res.status(400).json({ error: 'Обязательные поля: orderId, company, title' });
        const { rows: [row] } = await pool.query(
            'INSERT INTO tasks (order_id, company, title, due_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [Number(orderId), company, title.trim(), dueDate || null, req.user.company]
        );
        res.json({ id: row.id, title: row.title, dueDate: row.due_date, status: row.status, createdBy: row.created_by, createdAt: row.created_at });
    } catch (e) { next(e); }
});

app.patch('/api/tasks/:id', requireAuth, async (req, res, next) => {
    try {
        const { status } = req.body;
        if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'status: open | done' });
        const { rows: [row] } = await pool.query(
            'UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *',
            [status, Number(req.params.id)]
        );
        if (!row) return res.status(404).json({ error: 'Задача не найдена' });
        res.json({ id: row.id, title: row.title, dueDate: row.due_date, status: row.status });
    } catch (e) { next(e); }
});

// ── Контекст переписки (для правой панели) ──────────────────────────────────

app.get('/api/conversation-context/:orderId/:company', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const company = decodeURIComponent(req.params.company);

        const [orderRes, proposalRes, companyRes] = await Promise.all([
            pool.query('SELECT * FROM orders WHERE id = $1', [orderId]),
            pool.query('SELECT * FROM proposals WHERE order_id = $1 AND company = $2 ORDER BY created_at DESC LIMIT 1', [orderId, company]),
            pool.query('SELECT * FROM companies WHERE company = $1 AND role = $2 LIMIT 1', [company, 'producer']),
        ]);

        const order    = orderRes.rows[0]    || null;
        const proposal = proposalRes.rows[0] || null;
        const comp     = companyRes.rows[0]  || null;

        res.json({
            order: order ? {
                id:       order.id,
                title:    order.title,
                status:   order.status,
                quantity: order.quantity,
                deadline: order.deadline,
                drawing:  order.drawing ? JSON.parse(order.drawing) : null,
            } : null,
            proposal: proposal ? {
                id:     proposal.id,
                price:  proposal.price,
                days:   proposal.days,
                status: proposal.status,
                kpFile: proposal.kp_file ? JSON.parse(proposal.kp_file) : null,
            } : null,
            supplier: comp ? {
                id:   comp.id,
                inn:  comp.inn,
                director: comp.director,
                phone:    comp.phone,
            } : null,
        });
    } catch (e) { next(e); }
});

// ===================== СООБЩЕНИЯ =====================

app.get('/api/messages/conversations', requireAuth, async (req, res, next) => {
    try {
        const { role, company } = req.user;
        const unreadSender = role === 'producer' ? 'customer' : 'producer';
        const whereClause = role === 'producer' ? 'm.company = $1' : 'o.company = $1';

        const { rows } = await pool.query(`
            WITH last_msg AS (
                SELECT DISTINCT ON (order_id, company)
                    order_id, company, text, sender
                FROM messages
                ORDER BY order_id, company, created_at DESC
            )
            SELECT
                m.order_id,
                o.title AS order_title,
                o.company AS customer_company,
                m.company,
                MAX(m.created_at) AS last_at,
                COUNT(CASE WHEN m.sender = $2 AND m.read = false THEN 1 END) AS unread_count,
                lm.text  AS last_message,
                lm.sender AS last_sender
            FROM messages m
            JOIN orders o ON o.id = m.order_id
            LEFT JOIN last_msg lm ON lm.order_id = m.order_id AND lm.company = m.company
            WHERE ${whereClause}
            GROUP BY m.order_id, o.title, o.company, m.company, lm.text, lm.sender
            ORDER BY last_at DESC
        `, [company, unreadSender]);

        res.json(rows.map(r => ({
            orderId: r.order_id,
            orderTitle: r.order_title || `Заявка #${r.order_id}`,
            company: r.company,
            customerCompany: r.customer_company || '',
            lastMessage: r.last_message || '',
            lastSender: r.last_sender || '',
            lastAt: r.last_at,
            unreadCount: Number(r.unread_count) || 0,
        })));
    } catch (e) { next(e); }
});

app.post('/api/messages/:orderId/:company/read', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const company = req.params.company;
        if (!(await canAccessOrderThread(req.user, orderId, company))) {
            return res.status(403).json({ error: 'Нет доступа к этому чату' });
        }
        const otherSender = req.user.role === 'producer' ? 'customer' : 'producer';
        await pool.query(
            'UPDATE messages SET read = true WHERE order_id = $1 AND company = $2 AND sender = $3 AND read = false',
            [orderId, company, otherSender]
        );
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.get('/api/messages/:orderId/:company', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const company = req.params.company;
        if (!(await canAccessOrderThread(req.user, orderId, company))) {
            return res.status(403).json({ error: 'Нет доступа к этому чату' });
        }
        const { rows } = await pool.query(
            'SELECT * FROM messages WHERE order_id = $1 AND company = $2 ORDER BY created_at ASC',
            [orderId, company]
        );
        res.json(rows.map(rowToMessage));
    } catch (e) { next(e); }
});

app.post('/api/messages', requireAuth, async (req, res, next) => {
    try {
        const { orderId, text } = req.body;
        if (!orderId || !text) return res.status(400).json({ error: 'Заполните все поля сообщения' });

        const oid = Number(orderId);
        const { rows: [order] } = await pool.query('SELECT company FROM orders WHERE id = $1', [oid]);
        if (!order) return res.status(404).json({ error: 'Заявка не найдена' });

        let threadCompany;
        if (req.user.role === 'customer') {
            if (order.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа к этому чату' });
            threadCompany = req.body.company;
            if (!threadCompany) return res.status(400).json({ error: 'Не указана компания поставщика' });
            const { rows: [proposal] } = await pool.query(
                'SELECT id FROM proposals WHERE order_id = $1 AND company = $2 LIMIT 1',
                [oid, threadCompany]
            );
            if (!proposal) return res.status(403).json({ error: 'Чат доступен только с поставщиком, подавшим КП' });
        } else {
            // producer: company is always the authenticated user's company — don't trust the client
            const { rows: [proposal] } = await pool.query(
                'SELECT id FROM proposals WHERE order_id = $1 AND company = $2 LIMIT 1',
                [oid, req.user.company]
            );
            if (!proposal) return res.status(403).json({ error: 'Нет доступа к этому чату' });
            threadCompany = req.user.company;
        }

        const { rows: [newRow] } = await pool.query(
            'INSERT INTO messages (order_id,company,sender,text) VALUES ($1,$2,$3,$4) RETURNING *',
            [oid, threadCompany, req.user.role, String(text).slice(0, 2000)]
        );
        const msg = rowToMessage(newRow);
        if (io) io.to(`chat:${msg.orderId}:${msg.company}`).emit('message', msg);

        // Email notification to recipient
        (async () => {
            try {
                const recipientCompany = req.user.role === 'customer' ? threadCompany : order.company;
                const { rows: [orderRow] } = await pool.query('SELECT title FROM orders WHERE id = $1', [oid]);
                const orderTitle = orderRow?.title || 'Заявка';
                const { rows: recips } = await pool.query(
                    'SELECT email FROM users WHERE company = $1 LIMIT 3', [recipientCompany]
                );
                const preview = String(text).slice(0, 200) + (text.length > 200 ? '…' : '');
                for (const r of recips) {
                    await sendEmail(r.email, `Новое сообщение по заявке «${orderTitle}» — ТехЗаказ`, `
                        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
                            <h3 style="color:#1E3A5F;margin:0 0 12px;">Новое сообщение</h3>
                            <p style="color:#444;margin:0 0 12px;">Компания <strong>${req.user.company}</strong> написала по заявке <strong>«${orderTitle}»</strong>:</p>
                            <blockquote style="border-left:3px solid #FF6A00;margin:0 0 16px;padding:10px 16px;background:#FFF4EC;border-radius:0 6px 6px 0;color:#333;">${preview}</blockquote>
                            <a href="https://texzakaz.ru/messages.html" style="display:inline-block;background:#FF6A00;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть переписку →</a>
                        </div>`);
                }
            } catch {}
        })();

        res.status(201).json(msg);
    } catch (e) { next(e); }
});

// ===================== УВЕДОМЛЕНИЯ =====================

app.get('/api/notifications/:company', requireAuth, async (req, res, next) => {
    try {
        if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа к уведомлениям этой компании' });
        const { rows } = await pool.query('SELECT * FROM notifications WHERE company = $1 ORDER BY created_at DESC', [req.user.company]);
        res.json(rows.map(rowToNotification));
    } catch (e) { next(e); }
});

app.post('/api/notifications/:company/read', requireAuth, async (req, res, next) => {
    try {
        if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
        await pool.query('UPDATE notifications SET read = true WHERE company = $1', [req.user.company]);
        res.json({ message: 'ok' });
    } catch (e) { next(e); }
});

app.delete('/api/notifications/:company', requireAuth, async (req, res, next) => {
    try {
        if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
        await pool.query('DELETE FROM notifications WHERE company = $1', [req.user.company]);
        res.json({ message: 'ok' });
    } catch (e) { next(e); }
});

// ===================== НАСТРОЙКИ =====================

app.post('/api/auth/forgot-password', async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Укажите email' });
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (user) {
            await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
            const token = crypto.randomBytes(32).toString('hex');
            await pool.query(
                "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
                [user.id, token]
            );
            const link = `${APP_URL}/login.html?reset=${token}`;
            await sendEmail(user.email, 'Восстановление пароля — ТехЗаказ', `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a2332">
                  <h2 style="color:#41bd97">Восстановление пароля</h2>
                  <p>Поступил запрос на сброс пароля для аккаунта <strong>${user.email}</strong>.</p>
                  <p>Нажмите кнопку ниже, чтобы задать новый пароль. Ссылка действительна <strong>1 час</strong>.</p>
                  <a href="${link}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Сбросить пароль</a>
                  <p style="font-size:12px;color:#666">Если вы не запрашивали сброс — просто проигнорируйте это письмо.</p>
                </div>`
            );
        }
        res.json({ message: 'ok' });
    } catch (e) { next(e); }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: 'Неверный запрос' });
        if (newPassword.length < 8) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });
        const { rows: [row] } = await pool.query(
            'SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()',
            [token]
        );
        if (!row) return res.status(400).json({ error: 'Ссылка недействительна или истекла. Запросите новую.' });
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(newPassword), row.user_id]);
        await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);
        await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [row.user_id]);
        res.json({ message: 'Пароль успешно изменён' });
    } catch (e) { next(e); }
});

app.post('/api/auth/refresh', async (req, res, next) => {
    try {
        const refreshToken = getRefreshToken(req);
        if (!refreshToken) return res.status(401).json({ error: 'Refresh token не указан' });
        const { rows: [tokenRow] } = await pool.query(
            'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
            [refreshToken]
        );
        if (!tokenRow) return res.status(401).json({ error: 'Недействительный или истёкший refresh token' });
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [tokenRow.user_id]);
        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
        const payload = { userId: user.id, role: user.role, company: user.company };
        const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
        setAuthCookies(res, accessToken, refreshToken);
        res.json({ token: accessToken, emailVerified: Boolean(user.email_verified) });
    } catch (e) { next(e); }
});

app.post('/api/auth/logout', async (req, res, next) => {
    try {
        const refreshToken = getRefreshToken(req);
        if (refreshToken) {
            await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
        }
        clearAuthCookies(res);
        res.json({ message: 'Выход выполнен' });
    } catch (e) { next(e); }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
    try {
        const { rows: [user] } = await pool.query('SELECT totp_enabled, digest_frequency, id FROM users WHERE id = $1', [req.user.id]);
        res.json({
            id:               user?.id,
            email:            req.user.email,
            role:             req.user.role,
            company:          req.user.company,
            emailVerified:    Boolean(req.user.email_verified),
            totpEnabled:      Boolean(user?.totp_enabled),
            digest_frequency: user?.digest_frequency || 'daily',
        });
    } catch (e) { next(e); }
});

app.post('/api/auth/verify-email', async (req, res, next) => {
    try {
        const token = String(req.body?.token || req.query?.token || '').trim();
        if (!token) return res.status(400).json({ error: 'Токен не указан' });
        const { rows: [row] } = await pool.query(
            'SELECT * FROM email_verification_tokens WHERE token = $1 AND expires_at > NOW()',
            [token]
        );
        if (!row) return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
        await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [row.user_id]);
        await pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [row.user_id]);
        res.json({ message: 'Email успешно подтверждён' });
    } catch (e) { next(e); }
});

app.post('/api/auth/resend-verification', requireAuth, async (req, res, next) => {
    try {
        if (req.user.email_verified) return res.json({ message: 'Email уже подтверждён' });
        await sendVerificationEmail(req.user);
        res.json({ message: 'Письмо с подтверждением отправлено повторно' });
    } catch (e) { next(e); }
});

app.put('/api/auth/password', requireAuth, async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });
        if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль — минимум 6 символов' });

        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (!verifyPassword(currentPassword, user.password)) return res.status(400).json({ error: 'Неверный текущий пароль' });

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(newPassword), req.user.id]);
        res.json({ message: 'Пароль успешно изменён' });
    } catch (e) { next(e); }
});

app.put('/api/auth/email', requireAuth, async (req, res, next) => {
    try {
        const { newEmail, password } = req.body;
        if (!newEmail || !password) return res.status(400).json({ error: 'Заполните все поля' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'Некорректный формат email' });

        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (!verifyPassword(password, user.password)) return res.status(400).json({ error: 'Неверный пароль' });

        const { rows: [taken] } = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [newEmail, req.user.id]);
        if (taken) return res.status(400).json({ error: 'Этот email уже используется' });

        await pool.query('UPDATE users SET email = $1, email_verified = false WHERE id = $2', [newEmail, req.user.id]);
        const { rows: [updated] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        await sendVerificationEmail(updated);
        res.json({ message: 'Email изменён. Подтвердите новый адрес — письмо отправлено.' });
    } catch (e) { next(e); }
});

// ===================== ЗАКАЗЫ (СДЕЛКИ) =====================

app.get('/api/deals', requireAuth, async (req, res, next) => {
    try {
        const { role, company } = req.user;
        let rows;

        if (role === 'customer') {
            const { rows: r } = await pool.query(`
                SELECT o.id AS order_id, o.title, o.quantity, o.category,
                       p.id AS proposal_id, p.company AS counterparty,
                       p.price, p.days, p.created_at AS deal_date, p.completion_status,
                       p.delivery_stage, c.id AS counterparty_profile_id
                FROM orders o
                JOIN proposals p ON p.order_id = o.id AND p.status = 'Выигран'
                LEFT JOIN companies c ON c.company = p.company AND c.role = 'producer'
                WHERE o.company = $1
                ORDER BY p.created_at DESC
            `, [company]);
            rows = r;
        } else if (role === 'producer') {
            const { rows: r } = await pool.query(`
                SELECT o.id AS order_id, o.title, o.quantity, o.category,
                       p.id AS proposal_id, o.company AS counterparty,
                       p.price, p.days, p.created_at AS deal_date, p.completion_status,
                       p.delivery_stage, c.id AS counterparty_profile_id
                FROM proposals p
                JOIN orders o ON o.id = p.order_id
                LEFT JOIN companies c ON c.company = o.company AND c.role = 'customer'
                WHERE p.company = $1 AND p.status = 'Выигран'
                ORDER BY p.created_at DESC
            `, [company]);
            rows = r;
        } else {
            return res.json([]);
        }

        res.json(rows.map(r => ({
            orderId:               r.order_id,
            proposalId:            r.proposal_id,
            title:                 r.title,
            quantity:              r.quantity,
            category:              r.category,
            counterparty:          r.counterparty,
            counterpartyProfileId: r.counterparty_profile_id || null,
            price:                 r.price,
            days:                  r.days,
            dealDate:              r.deal_date,
            completionStatus:      r.completion_status || 'active',
            deliveryStage:         r.delivery_stage || 'КП принят',
        })));
    } catch (e) { next(e); }
});

app.put('/api/deals/:proposalId/complete', requireAuth, requireRole('customer'), async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { rows: [row] } = await pool.query(`
            SELECT p.*, o.company AS customer_company, o.title AS order_title
            FROM proposals p JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1
        `, [proposalId]);

        if (!row) return res.status(404).json({ error: 'Сделка не найдена' });
        if (row.status !== 'Выигран') return res.status(400).json({ error: 'Это не активная сделка' });
        if (row.customer_company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
        if (row.completion_status === 'completed') return res.status(400).json({ error: 'Сделка уже завершена' });

        await pool.query("UPDATE proposals SET completion_status = 'completed' WHERE id = $1", [proposalId]);
        await addNotification(row.company, `Заказчик подтвердил выполнение заказа «${plainTitle(row.order_title)}».`);
        res.json({ message: 'Сделка завершена' });
    } catch (e) { next(e); }
});

// ===================== ДОСТАВКА =====================

const DELIVERY_STAGES = ['КП принят','В производстве','Готов к отгрузке','Отгружен','Доставлен','Принят заказчиком'];

app.get('/api/deals/:proposalId/delivery', requireAuth, async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { rows: [p] } = await pool.query(`
            SELECT p.id, p.order_id, p.price, p.days, p.company AS producer_company,
                   p.status, p.delivery_stage, p.tracking_number, p.created_at,
                   o.title, o.quantity, o.category, o.company AS customer_company
            FROM proposals p JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1 AND p.status = 'Выигран'
        `, [proposalId]);
        if (!p) return res.status(404).json({ error: 'Сделка не найдена' });

        const { company, role } = req.user;
        if (role !== 'admin' && company !== p.producer_company && company !== p.customer_company)
            return res.status(403).json({ error: 'Нет доступа' });

        const { rows: events } = await pool.query(
            'SELECT * FROM delivery_events WHERE proposal_id = $1 ORDER BY created_at ASC', [proposalId]
        );
        res.json({ deal: p, events });
    } catch (e) { next(e); }
});

app.post('/api/deals/:proposalId/delivery/stage', requireAuth, async (req, res, next) => {
    try {
        const proposalId = Number(req.params.proposalId);
        const { stage, notes = '', trackingNumber = '' } = req.body;
        if (!DELIVERY_STAGES.includes(stage)) return res.status(400).json({ error: 'Неверный этап' });

        const { rows: [p] } = await pool.query(`
            SELECT p.*, o.company AS customer_company, o.title AS order_title
            FROM proposals p JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1 AND p.status = 'Выигран'
        `, [proposalId]);
        if (!p) return res.status(404).json({ error: 'Сделка не найдена' });

        const { company, role } = req.user;
        if (stage === 'Принят заказчиком') {
            if (role !== 'customer' || company !== p.customer_company)
                return res.status(403).json({ error: 'Только заказчик подтверждает получение' });
        } else {
            if (role !== 'producer' || company !== p.company)
                return res.status(403).json({ error: 'Только поставщик обновляет статус доставки' });
        }

        const currentIdx = DELIVERY_STAGES.indexOf(p.delivery_stage);
        const newIdx = DELIVERY_STAGES.indexOf(stage);
        if (newIdx <= currentIdx) return res.status(400).json({ error: 'Нельзя вернуться на предыдущий этап' });

        await pool.query(
            "UPDATE proposals SET delivery_stage = $1, tracking_number = COALESCE(NULLIF($2,''), tracking_number) WHERE id = $3",
            [stage, trackingNumber, proposalId]
        );
        await pool.query(
            'INSERT INTO delivery_events (proposal_id, stage, notes, updated_by) VALUES ($1,$2,$3,$4)',
            [proposalId, stage, notes, company]
        );

        if (stage === 'Принят заказчиком') {
            await pool.query("UPDATE proposals SET completion_status = 'completed' WHERE id = $1", [proposalId]);
        }

        const title = plainTitle(p.order_title);
        const notifyCompany = stage === 'Принят заказчиком' ? p.company : p.customer_company;
        await addNotification(notifyCompany, `Статус доставки по «${title}» изменён: ${stage}.`);

        res.json({ message: 'Статус обновлён', stage });
    } catch (e) { next(e); }
});

// ===================== ВЕРИФИКАЦИЯ =====================

app.post('/api/verification/request', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role === 'admin') return res.status(403).json({ error: 'Недоступно для администраторов' });

        const { rows: [company] } = await pool.query('SELECT * FROM companies WHERE company = $1 AND role = $2', [req.user.company, req.user.role]);
        if (!company) return res.status(404).json({ error: 'Профиль компании не найден' });
        if (company.verified_by_platform) return res.status(400).json({ error: 'Компания уже верифицирована' });

        const { rows: [existing] } = await pool.query('SELECT * FROM verification_requests WHERE company_id = $1', [company.id]);
        if (existing && existing.status === 'pending') return res.status(400).json({ error: 'Заявка уже отправлена и ожидает рассмотрения' });
        if (existing) await pool.query('DELETE FROM verification_requests WHERE company_id = $1', [company.id]);

        await pool.query("INSERT INTO verification_requests (company_id, status) VALUES ($1, 'pending')", [company.id]);
        res.json({ message: 'Заявка на верификацию отправлена' });
    } catch (e) { next(e); }
});

app.get('/api/verification/status', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role === 'admin') return res.json({ status: 'none' });

        const { rows: [company] } = await pool.query('SELECT * FROM companies WHERE company = $1 AND role = $2', [req.user.company, req.user.role]);
        if (!company) return res.json({ status: 'none' });
        if (company.verified_by_platform) return res.json({ status: 'approved' });

        const { rows: [vr] } = await pool.query('SELECT * FROM verification_requests WHERE company_id = $1', [company.id]);
        if (!vr) return res.json({ status: 'none' });

        res.json({ status: vr.status, comment: vr.admin_comment || '', requestedAt: vr.requested_at });
    } catch (e) { next(e); }
});

app.get('/api/verification/requests', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const filter = req.query.filter === 'all' ? 'all' : 'pending';
        const sql = `
            SELECT vr.*, c.company, c.inn, c.ogrn, c.director, c.founding_year,
                c.authorized_capital, c.employees, c.revenue, c.machines_count, c.production_area,
                c.capabilities, c.iso_certificates, c.quality_certificates, c.specialization, c.city,
                c.role AS company_role
            FROM verification_requests vr JOIN companies c ON c.id = vr.company_id
            ${filter === 'pending' ? "WHERE vr.status = 'pending'" : ''}
            ORDER BY vr.requested_at DESC
        `;
        const { rows } = await pool.query(sql);
        res.json(rows.map(r => ({
            id: r.id, companyId: r.company_id, status: r.status,
            adminComment: r.admin_comment, requestedAt: r.requested_at, reviewedAt: r.reviewed_at,
            company: r.company, inn: r.inn, ogrn: r.ogrn || '', director: r.director || '',
            foundingYear: r.founding_year, authorizedCapital: r.authorized_capital || '',
            employees: r.employees, revenue: r.revenue || '',
            machinesCount: r.machines_count, productionArea: r.production_area,
            capabilities: JSON.parse(r.capabilities || '[]'),
            isoCertificates: JSON.parse(r.iso_certificates || '[]'),
            qualityCertificates: JSON.parse(r.quality_certificates || '[]'),
            specialization: r.specialization || '', city: r.city || '', companyRole: r.company_role,
        })));
    } catch (e) { next(e); }
});

app.post('/api/verification/:id/approve', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { rows: [vr] } = await pool.query('SELECT * FROM verification_requests WHERE id = $1', [id]);
        if (!vr) return res.status(404).json({ error: 'Заявка не найдена' });

        const { rows: [companyRow] } = await pool.query('SELECT company FROM companies WHERE id = $1', [vr.company_id]);
        await withTransaction(async (client) => {
            await client.query("UPDATE verification_requests SET status='approved', reviewed_at=NOW() WHERE id=$1", [id]);
            await client.query("UPDATE companies SET verified_by_platform=true, status='Верифицирован' WHERE id=$1", [vr.company_id]);
        });
        if (companyRow) {
            await addNotification(companyRow.company, 'Ваша компания успешно верифицирована платформой!');
            const email = await getCompanyEmail(companyRow.company);
            if (email) await sendEmail(email, 'Верификация пройдена — ТехЗаказ',
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:#41bd97">Компания верифицирована!</h3>
                  <p>Ваша компания <strong>${companyRow.company}</strong> успешно прошла верификацию на платформе ТехЗаказ.</p>
                  <p>Теперь рядом с вашим профилем отображается знак верификации.</p>
                  <a href="${APP_URL}/company-profile.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть профиль</a>
                </div>`
            );
        }
        res.json({ message: 'Компания верифицирована' });
    } catch (e) { next(e); }
});

app.post('/api/verification/:id/reject', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const comment = String(req.body.comment || '').slice(0, 500);
        const { rows: [vr] } = await pool.query('SELECT * FROM verification_requests WHERE id = $1', [id]);
        if (!vr) return res.status(404).json({ error: 'Заявка не найдена' });

        const { rows: [rejectCompany] } = await pool.query('SELECT company FROM companies WHERE id = $1', [vr.company_id]);
        await pool.query(
            "UPDATE verification_requests SET status='rejected', admin_comment=$1, reviewed_at=NOW() WHERE id=$2",
            [comment, id]
        );
        if (rejectCompany) {
            await addNotification(rejectCompany.company, `Заявка на верификацию отклонена.${comment ? ' Причина: ' + comment : ''}`);
            const email = await getCompanyEmail(rejectCompany.company);
            if (email) await sendEmail(email, 'Заявка на верификацию отклонена — ТехЗаказ',
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:#e07070">Заявка на верификацию отклонена</h3>
                  <p>Заявка компании <strong>${rejectCompany.company}</strong> была рассмотрена и отклонена.</p>
                  ${comment ? `<p><strong>Причина:</strong> ${comment}</p>` : ''}
                  <p>Вы можете исправить недочёты и подать заявку повторно.</p>
                  <a href="${APP_URL}/settings.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Настройки профиля</a>
                </div>`
            );
        }
        res.json({ message: 'Заявка отклонена' });
    } catch (e) { next(e); }
});

// ===================== ОБРАБОТКА ОШИБОК =====================

app.use('/api', (req, res) => res.status(404).json({ error: 'Эндпоинт не найден' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '404.html')));

if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ===================== ЗАПУСК =====================

function buildDigestHtml(orders, producerName) {
    const rows = orders.map(o => `
        <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#1E3A5F;">${o.title}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#666;">${o.category}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#666;">${o.deadline || '—'}</td>
        </tr>`).join('');
    return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#1E3A5F;margin:0 0 6px;">Новые заявки на ТехЗаказ</h2>
        <p style="color:#666;font-size:13px;margin:0 0 20px;">Здравствуйте, ${htmlEscape(producerName)}! За последние сутки появились новые закупки:</p>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
            <thead><tr style="background:#1E3A5F;">
                <th style="padding:10px 12px;text-align:left;color:#fff;font-size:12px;">Наименование</th>
                <th style="padding:10px 12px;text-align:left;color:#fff;font-size:12px;">Категория</th>
                <th style="padding:10px 12px;text-align:left;color:#fff;font-size:12px;">Дедлайн</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:20px;text-align:center;">
            <a href="https://texzakaz.ru/zakupki.html" style="display:inline-block;background:#FF6A00;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть все заявки →</a>
        </div>
        <p style="color:#aaa;font-size:11px;margin-top:24px;text-align:center;">
            Управление уведомлениями — <a href="https://texzakaz.ru/settings.html" style="color:#aaa;">Настройки</a>
        </p>
    </div>`;
}

function startAuctionCron() {
    cron.schedule('* * * * *', closeExpiredAuctions); // every minute
}

function startDigestCron() {
    // Daily at 09:00 Moscow time (UTC+3 → 06:00 UTC)
    cron.schedule('0 6 * * *', async () => {
        try {
            const { rows: producers } = await pool.query(
                `SELECT DISTINCT u.email, u.company FROM users u
                 WHERE u.role='producer' AND u.digest_frequency='daily'`
            );
            const { rows: orders } = await pool.query(
                `SELECT title, category, deadline FROM orders
                 WHERE status='Активный' AND created_at > NOW()-INTERVAL '24 hours'
                 ORDER BY created_at DESC LIMIT 10`
            );
            if (!orders.length) return;
            for (const p of producers) {
                await sendEmail(p.email, `Новые заявки на ТехЗаказ — ${new Date().toLocaleDateString('ru-RU')}`,
                    buildDigestHtml(orders, p.company)).catch(() => {});
            }
            console.log(`[digest:daily] sent to ${producers.length} producers, ${orders.length} orders`);
        } catch (e) { console.error('[digest:daily]', e.message); }
    });

    // Weekly on Monday at 09:00 Moscow time
    cron.schedule('0 6 * * 1', async () => {
        try {
            const { rows: producers } = await pool.query(
                `SELECT DISTINCT u.email, u.company FROM users u
                 WHERE u.role='producer' AND u.digest_frequency='weekly'`
            );
            const { rows: orders } = await pool.query(
                `SELECT title, category, deadline FROM orders
                 WHERE status='Активный' AND created_at > NOW()-INTERVAL '7 days'
                 ORDER BY created_at DESC LIMIT 15`
            );
            if (!orders.length) return;
            for (const p of producers) {
                await sendEmail(p.email, `Заявки за неделю — ТехЗаказ`,
                    buildDigestHtml(orders, p.company)).catch(() => {});
            }
            console.log(`[digest:weekly] sent to ${producers.length} producers`);
        } catch (e) { console.error('[digest:weekly]', e.message); }
    });
}

async function start() {
    await initDb();
    httpServer.listen(PORT, () => {
        console.log(`Сервер запущен на порту ${PORT} (файлы: ${storage.isRemote() ? 'S3/R2' : 'локальный диск'})`);
    });
    if (process.env.GEOCODE_ON_START !== 'false') {
        setTimeout(geocodeExisting, 5000);
    }
    startDigestCron();
    startAuctionCron();
    return httpServer;
}

if (require.main === module) {
    start().catch(err => {
        console.error('Ошибка инициализации БД:', err);
        process.exit(1);
    });
}

module.exports = { app, httpServer, start, pool };
