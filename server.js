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
const { pool, initDb, logOrderEvent } = require('./db');
const storage = require('./storage');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const cron      = require('node-cron');
const ExcelJS   = require('exceljs');
const { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf } = require('./export-pdf');
const { startTelegramBot } = require('./telegram-bot');
const { JWT_SECRET, getAccessToken } = require('./lib/auth-tokens');
const createAuthRouter = require('./routes/auth');
const createOrdersRouter = require('./routes/orders');
const createProposalsRouter = require('./routes/proposals');
const { createOrderProposalsRouter } = require('./routes/proposals');
const createCompanyEnricher = require('./lib/company-enrich');
const createCompaniesRouter = require('./routes/companies');
const { createTopSuppliersRouter } = require('./routes/companies');
const createMessagesRouter = require('./routes/messages');
const createDealsRouter = require('./routes/deals');
const { fetchEgrulData, evaluateAutoVerification } = require('./lib/egrul-verify');
const { acceptWonProposal } = require('./lib/proposal-accept');
const tzAi = require('./lib/ai-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;
const webpush = require('web-push');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:noreply@texzakaz.ru',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

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

async function sendTelegramNotification(userId, text) {
    if (!global.__tgBot) return;
    try {
        const { rows: [user] } = await pool.query(
            'SELECT telegram_id FROM users WHERE id=$1 AND telegram_id IS NOT NULL', [userId]
        );
        if (!user?.telegram_id) return;
        await global.__tgBot.telegram.sendMessage(user.telegram_id, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error('[tg:notify]', e.message);
    }
}

async function sendPush(userId, title, body, url) {
    if (!process.env.VAPID_PUBLIC_KEY) return;
    try {
        const { rows } = await pool.query(
            'SELECT id, subscription FROM push_subscriptions WHERE user_id = $1',
            [userId]
        );
        for (const row of rows) {
            try {
                await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, url }));
            } catch (e) {
                if (e.statusCode === 410 || e.statusCode === 404) {
                    await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
                } else {
                    console.error('[push] send error:', e.message);
                }
            }
        }
    } catch (e) {
        console.error('[push] sendPush error:', e.message);
    }
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
        message: r.message || '',
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
        products: r.products || '',
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
        verifiedEgrul: Boolean(r.verified_egrul),
        egrulVerifiedAt: r.egrul_verified_at,
        claimed: r.claimed !== false,
        fromRegistry: !r.claimed && !!r.source,
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

const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Подождите минуту.' }
});
app.use('/api/', generalLimiter);

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много AI-запросов. Подождите минуту.' }
});
app.post('/api/ai-search', aiLimiter);
app.post('/api/ai/generate-tz', aiLimiter);
app.post('/api/ai/generate-proposal', aiLimiter);

// ===================== WEBSOCKET =====================
let Server = null;
try { Server = require('socket.io').Server; }
catch { console.warn('socket.io не установлен — работаем через поллинг.'); }

const httpServer = http.createServer(app);
const socketOrigin = IS_PRODUCTION
    ? Array.from(ALLOWED_ORIGINS)
    : [...Array.from(ALLOWED_ORIGINS), 'http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:5000'];
const io = Server ? new Server(httpServer, {
    cors: { origin: socketOrigin, credentials: true },
    pingInterval: 10000,
    pingTimeout: 5000,
}) : null;

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
        if (socket.user?.company) socket.join(socket.user.company);
        socket.on('join-company', (company) => {
            if (company && company === socket.user.company) socket.join(company);
        });
        socket.on('join-auction', (auctionId) => {
            if (auctionId != null) socket.join(`auction:${auctionId}`);
        });
        socket.on('leave-auction', (auctionId) => {
            if (auctionId != null) socket.leave(`auction:${auctionId}`);
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
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));
async function canAccessStoredFile(user, storedName) {
    if (!user || !storedName) return false;
    if (user.role === 'admin') return true;
    const base = path.basename(storedName);
    const { rows: [orderHit] } = await pool.query(
        'SELECT id FROM orders WHERE drawing = $1 AND company = $2 LIMIT 1',
        [base, user.company]
    );
    if (orderHit) return true;
    const { rows: [proposalHit] } = await pool.query(
        'SELECT p.id FROM proposals p JOIN orders o ON o.id = p.order_id WHERE p.kp_file = $1 AND (p.company = $2 OR o.company = $2) LIMIT 1',
        [base, user.company]
    );
    return Boolean(proposalHit);
}

app.get('/uploads/:filename', requireAuth, async (req, res, next) => {
    try {
        const filename = path.basename(req.params.filename);
        if (!(await canAccessStoredFile(req.user, filename))) {
            return res.status(403).json({ error: 'Нет доступа к файлу' });
        }
        await storage.streamToResponse(filename, res);
    } catch (e) { next(e); }
});
app.get('/api/company-photos/:filename', async (req, res, next) => {
    try {
        const filename = path.basename(req.params.filename);
        await storage.streamToResponse(filename, res);
    } catch (e) { next(e); }
});

/* ── Sidebar partial: единый источник для всех страниц кабинета ── */
let _sidebarPartialCache = null;
const SIDEBAR_ACTIVE = {
    'index.html': '#mainCabinetLink',
    'producer.html': '#mainCabinetLink',
    'catalog.html': 'catalog.html',
    'proposals.html': 'proposals.html',
    'deals.html': 'deals.html',
    'deliveries.html': 'deliveries.html',
    'partners.html': 'partners.html',
    'analytics.html': 'analytics.html',
    'messages.html': 'messages.html',
    'favorites.html': 'favorites.html',
    'map.html': 'map.html',
    'settings.html': 'settings.html',
    'tariff.html': 'settings.html',
    'admin.html': 'admin.html',
    'company-profile.html': '#sidebarProfileLink',
    'delivery.html': 'deliveries.html',
};

function getSidebarPartial() {
    if (!_sidebarPartialCache) {
        _sidebarPartialCache = fs.readFileSync(path.join(__dirname, 'partials', 'sidebar.html'), 'utf8');
    }
    return _sidebarPartialCache;
}

function sidebarHtmlForPage(pageFile) {
    let html = getSidebarPartial().replace(/\sclass="active"/g, '');
    const target = SIDEBAR_ACTIVE[pageFile];
    if (!target) return html;
    if (target.startsWith('#')) {
        const id = target.slice(1);
        html = html.replace(new RegExp(`(<a\\s)([^>]*\\bid="${id}"[^>]*)>`, 'i'), '$1class="active" $2>');
    } else {
        html = html.replace(new RegExp(`(<a\\s)([^>]*href="${target}"[^>]*)>`, 'i'), '$1class="active" $2>');
    }
    return html;
}

function injectSidebarPartial(html, pageFile) {
    const anchor = '<div id="spa-content"';
    const idx = html.indexOf(anchor);
    if (idx === -1) return html;
    const start = html.lastIndexOf('<div class="sidebar">', idx);
    if (start === -1) return html;
    return html.slice(0, start) + sidebarHtmlForPage(pageFile).trim() + '\n\n    ' + html.slice(idx);
}

function sendCabinetPage(page, res) {
    res.setHeader('Cache-Control', 'no-cache');
    const filePath = path.join(__dirname, page);
    let html = fs.readFileSync(filePath, 'utf8');
    if (html.includes('<div class="sidebar">')) {
        html = injectSidebarPartial(html, page);
    }
    res.type('html').send(html);
}

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
        if (fs.existsSync(path.join(__dirname, page)) && fs.readFileSync(path.join(__dirname, page), 'utf8').includes('<div class="sidebar">')) {
            sendCabinetPage(page, res);
        } else {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(path.join(__dirname, page));
        }
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
    res.redirect(301, '/favicon.svg');
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
        'Allow: /p/\n' +
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

app.get('/sitemap.xml', async (req, res, next) => {
    try {
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
        const { rows: suppliers } = await pool.query(
            "SELECT id FROM companies WHERE role = 'producer' AND verified_by_platform = true ORDER BY id ASC LIMIT 200"
        );
        for (const s of suppliers) {
            pages.push({ url: `/p/${s.id}`, priority: '0.6', changefreq: 'weekly' });
        }
        const urls = pages.map(p =>
            `  <url>\n    <loc>${base}${p.url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
        ).join('\n');
        res.type('application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
    } catch (e) { next(e); }
});

app.get('/p/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { rows: [row] } = await pool.query(
            "SELECT company, specialization, city, about, verified_by_platform FROM companies WHERE id = $1 AND role = 'producer'",
            [id]
        );
        if (!row) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }
        const filePath = path.join(__dirname, 'supplier-public.html');
        let html = fs.readFileSync(filePath, 'utf8');
        const title = `${row.company} — поставщик | ТехЗаказ`;
        const desc = [row.specialization, row.city, row.about].filter(Boolean).join(' · ').slice(0, 160)
            || `Профиль поставщика ${row.company} на B2B-платформе ТехЗаказ`;
        const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
        html = html
            .replace(/<!--META_TITLE-->/g, htmlEscape(title))
            .replace(/<!--META_DESC-->/g, htmlEscape(desc))
            .replace(/<!--CANONICAL_URL-->/g, `${base}/p/${id}`)
            .replace(/<!--COMPANY_ID-->/g, String(id));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(html);
    } catch (e) { next(e); }
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

// ===================== WEB PUSH =====================

app.get('/api/push/vapid-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push не настроен' });
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, async (req, res, next) => {
    try {
        const { subscription } = req.body;
        if (!subscription?.endpoint) return res.status(400).json({ error: 'Неверный subscription объект' });
        await pool.query(
            `INSERT INTO push_subscriptions (user_id, subscription)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [req.user.id, JSON.stringify(subscription)]
        );
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.delete('/api/push/subscribe', requireAuth, async (req, res, next) => {
    try {
        await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ===================== TELEGRAM =====================

app.post('/api/telegram/link-token', requireAuth, async (req, res, next) => {
    try {
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 15 * 60 * 1000);
        await pool.query(
            'UPDATE users SET telegram_link_token=$1, telegram_link_expires=$2 WHERE id=$3',
            [token, expires, req.user.id]
        );
        const botName = process.env.TELEGRAM_BOT_NAME || 'TexZakazBot';
        res.json({ token, deepLink: `https://t.me/${botName}?start=${token}` });
    } catch (e) { next(e); }
});

app.delete('/api/telegram/unlink', requireAuth, async (req, res, next) => {
    try {
        await pool.query(
            'UPDATE users SET telegram_id=NULL, telegram_link_token=NULL, telegram_link_expires=NULL WHERE id=$1',
            [req.user.id]
        );
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.get('/api/telegram/status', requireAuth, async (req, res, next) => {
    try {
        const { rows: [user] } = await pool.query(
            'SELECT telegram_id FROM users WHERE id=$1', [req.user.id]
        );
        res.json({ linked: Boolean(user?.telegram_id), telegramId: user?.telegram_id || null });
    } catch (e) { next(e); }
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

    // Бонус за низкую загрузку производства (поле productionLoad = % занятости)
    if (producer.productionLoad != null && producer.productionLoad < 80) {
        score += producer.productionLoad < 50 ? 10 : 5;
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

    if (producer.productionLoad != null && producer.productionLoad < 80) {
        const free = 100 - producer.productionLoad;
        reasons.push(`Загрузка цеха ${producer.productionLoad}% — свободно ~${free}%`);
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
            "SELECT id, city FROM companies WHERE role='producer' AND city != '' AND lat IS NULL LIMIT 1000"
        );
        const cityCache = new Map();
        for (const r of rows) {
            const key = r.city.trim().toLowerCase();
            let coords = cityCache.get(key);
            if (coords === undefined) {
                coords = await geocodeCity(r.city);
                cityCache.set(key, coords);
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
            if (coords) await pool.query('UPDATE companies SET lat=$1,lng=$2 WHERE id=$3', [coords.lat, coords.lng, r.id]);
        }
    } catch {}
}

async function matchedProducers(order, minScore = 0, withReasons = false) {
    const { rows } = await pool.query("SELECT * FROM companies WHERE role = 'producer' AND claimed = true");
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

function parseDeadlineDate(deadline) {
    if (!deadline) return null;
    const s = String(deadline).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function emailWrap(title, bodyHtml) {
    return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="color:#1E3A5F;margin:0 0 12px;font-size:18px;">${htmlEscape(title)}</h2>
        ${bodyHtml}
        <p style="color:#aaa;font-size:11px;margin-top:24px;text-align:center;">
            <a href="${APP_URL}" style="color:#FF6A00;">Открыть ТехЗаказ</a>
        </p>
    </div>`;
}

async function notifyCompanyEmail(company, notifText, emailSubject, emailBodyHtml) {
    if (!company) return;
    await addNotification(company, notifText);
    const email = await getCompanyEmail(company);
    if (email && emailSubject) {
        await sendEmail(email, emailSubject, emailWrap(emailSubject, emailBodyHtml)).catch(e => console.error('[email:notify]', e.message));
    }
}

async function computePriceBenchmark(category, excludeOrderId) {
    const { rows } = await pool.query(
        `SELECT p.price::numeric AS price
         FROM proposals p
         JOIN orders o ON o.id = p.order_id
         WHERE o.category = $1
           AND o.status = 'Закрыта'
           AND p.status = 'Выигран'
           AND p.price IS NOT NULL AND p.price > 0
           AND ($2::int = 0 OR o.id != $2)
           AND o.created_at > NOW() - INTERVAL '6 months'`,
        [category, excludeOrderId || 0]
    );
    const prices = rows.map(r => Number(r.price)).filter(v => v > 0).sort((a, b) => a - b);
    if (prices.length < 3) {
        return { enough: false, sampleSize: prices.length, category };
    }
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    return {
        enough: true,
        sampleSize: prices.length,
        category,
        median: Math.round(median),
        min: prices[0],
        max: prices[prices.length - 1],
        periodMonths: 6,
    };
}

function emitRealtime(company, event, payload) {
    if (!io || !company) return;
    io.to(company).emit(event, payload);
}

function emitDashboardRefresh(company) {
    emitRealtime(company, 'dashboard:refresh', { at: new Date().toISOString() });
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

async function getUserIdsByCompany(company) {
    const { rows } = await pool.query(
        'SELECT id FROM users WHERE company = $1',
        [company]
    );
    return rows.map(r => r.id);
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

const { enrichCompany } = createCompanyEnricher({ pool, storage });

const { createRegistryInviter } = require('./lib/registry-invites');
const registryInviter = createRegistryInviter({ pool, sendEmail, appUrl: APP_URL, jwtSecret: JWT_SECRET });

// Отписка от приглашений из госреестра (ссылка в письме, без авторизации)
app.get('/api/registry-invites/optout', async (req, res, next) => {
    try {
        const { inn, token } = req.query;
        const page = (title, text) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — ТехЗаказ</title>
            <style>body{font-family:system-ui,sans-serif;background:#F4F6F8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
            .card{background:#fff;max-width:440px;padding:32px;border:1px solid #E2E8F0}
            h1{font-size:20px;color:#1E2A3A;margin:0 0 12px}p{color:#475569;line-height:1.5;margin:0}</style></head>
            <body><div class="card"><h1>${title}</h1><p>${text}</p></div></body></html>`;
        if (!inn || !registryInviter.verifyOptoutToken(inn, token)) {
            return res.status(400).send(page('Ссылка недействительна',
                'Проверьте, что ссылка из письма скопирована целиком.'));
        }
        await pool.query(
            "UPDATE companies SET invite_optout = true WHERE inn = $1 AND claimed = false AND source = 'gisp-pp719'",
            [String(inn)]
        );
        res.send(page('Вы отписаны',
            'Приглашения на этот адрес больше приходить не будут. Если передумаете — зарегистрируйтесь на texzakaz.ru по ИНН вашего предприятия.'));
    } catch (e) { next(e); }
});

// ===================== AUTH ROUTES =====================

app.use('/api/auth', createAuthRouter({
    pool,
    crypto,
    speakeasy,
    QRCode,
    requireAuth,
    withTransaction,
    sendEmail,
    sendPush,
    sendTelegramNotification,
    getUserIdsByCompany,
    sendVerificationEmail,
    APP_URL,
}));

const routesDeps = {
    pool,
    storage,
    requireAuth,
    requireRole,
    optionalAuth,
    requireVerifiedEmail,
    handleDrawingUpload,
    handleKPUpload,
    handlePhotoUpload,
    persistUpload,
    deleteDrawingFile,
    canAccessOrderDrawing,
    canAccessProposal,
    canAccessOrderThread,
    getOrderAccessRow,
    rowToOrder,
    rowToProposal,
    rowToCompany,
    rowToMessage,
    enrichCompany,
    geocodeCity,
    computeMatchScore,
    computeMatchReasons,
    matchedProducers,
    computePriceBenchmark,
    plainTitle,
    htmlEscape,
    notifyCompanyEmail,
    withTransaction,
    addNotification,
    emitRealtime,
    emitDashboardRefresh,
    getCompanyEmail,
    sendEmail,
    getUserIdsByCompany,
    sendPush,
    sendTelegramNotification,
    triggerIntegrations,
    logOrderEvent,
    getIo: () => io,
    APP_URL,
    registryInviter,
};

app.use('/api/orders', createOrdersRouter(routesDeps));
app.use('/api/proposals', createProposalsRouter(routesDeps));
app.use('/api/order-proposals', createOrderProposalsRouter(routesDeps));
app.use('/api/top-suppliers', createTopSuppliersRouter(routesDeps));
app.use('/api/companies', createCompaniesRouter(routesDeps));
app.use('/api/messages', createMessagesRouter(routesDeps));
app.use('/api/deals', createDealsRouter(routesDeps));

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

// Плотность поставщиков по регионам (для воксельной карты лендинга). Кэш 1 час.
let _geoDensityCache = { ts: 0, data: null };
app.get('/api/public/geo-density', async (req, res, next) => {
    try {
        if (_geoDensityCache.data && Date.now() - _geoDensityCache.ts < 3600 * 1000) {
            return res.json(_geoDensityCache.data);
        }
        const { rows } = await pool.query(`
            SELECT ROUND(lng::numeric, 0)::float AS lon,
                   ROUND(lat::numeric, 0)::float AS lat,
                   COUNT(*)::int AS n
            FROM companies
            WHERE role = 'producer' AND lat IS NOT NULL AND lng IS NOT NULL
            GROUP BY 1, 2
        `);
        const data = { points: rows };
        // Пустой результат не кэшируем: геокодинг доезжает после старта — не залипать на час
        if (rows.length) _geoDensityCache = { ts: Date.now(), data };
        res.json(data);
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
            ORDER BY verified_by_platform DESC, verified_egrul DESC, company ASC
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
                verifiedEgrul: producer.verifiedEgrul,
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
            verifiedEgrul: c.verifiedEgrul,
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
            ORDER BY verified_by_platform DESC, verified_egrul DESC, company ASC
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

app.post('/api/ai/generate-tz', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Генерация ТЗ доступна только заказчикам' });
        }
        if (!tzAi.isTzAiConfigured()) {
            return res.status(503).json({
                error: 'AI для ТЗ не настроен. Добавьте AI_TZ_API_KEY в .env (DeepSeek, OpenAI или OpenRouter).',
            });
        }

        const { brief, category, quantity, title } = req.body || {};
        if (!brief || !String(brief).trim()) {
            return res.status(400).json({ error: 'Опишите задачу в поле brief (2–3 предложения)' });
        }
        if (String(brief).trim().length > 2000) {
            return res.status(400).json({ error: 'Слишком длинный запрос (макс. 2000 символов)' });
        }

        const result = await tzAi.generateProcurementTz({
            brief: String(brief).trim(),
            category: String(category || 'Прочее').slice(0, 80),
            quantity: quantity != null && quantity !== '' ? Number(quantity) : null,
            title: title ? String(title).slice(0, 200) : '',
        });

        const cfg = tzAi.getTzAiConfig();
        res.json({ ...result, model: cfg.model });
    } catch (e) {
        console.error('[ai/generate-tz]', e.message, e.status || '', e.code || '');
        if (e.code === 'AI_NOT_CONFIGURED') {
            return res.status(503).json({ error: 'AI для ТЗ не настроен' });
        }
        if (e.code === 'AI_AUTH' || e.status === 401) {
            return res.status(400).json({ error: 'Неверный AI_TZ_API_KEY. Проверьте ключ и base URL.' });
        }
        if (e.code === 'AI_RATE_LIMIT' || e.status === 429) {
            return res.status(429).json({ error: 'Превышен лимит запросов к AI. Подождите минуту.' });
        }
        if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY') {
            return res.status(500).json({ error: e.message || 'Не удалось сгенерировать ТЗ' });
        }
        return res.status(500).json({ error: e.message || 'Ошибка генерации ТЗ' });
    }
});

app.get('/api/ai/tz-status', requireAuth, (req, res) => {
    const cfg = tzAi.getTzAiConfig();
    res.json({ configured: cfg.configured, model: cfg.configured ? cfg.model : null });
});

app.post('/api/ai/generate-proposal', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role !== 'producer') {
            return res.status(403).json({ error: 'Генерация сопроводительного текста доступна только поставщикам' });
        }
        if (!tzAi.isTzAiConfigured()) {
            return res.status(503).json({ error: 'AI не настроен на сервере' });
        }

        const { orderId, brief } = req.body || {};
        if (!brief || !String(brief).trim()) {
            return res.status(400).json({ error: 'Опишите, что вы можете предложить (2–3 предложения)' });
        }
        if (String(brief).trim().length > 2000) {
            return res.status(400).json({ error: 'Слишком длинный запрос (макс. 2000 символов)' });
        }

        let orderRow = null;
        if (orderId) {
            const { rows } = await pool.query('SELECT title, description, category FROM orders WHERE id = $1', [Number(orderId)]);
            orderRow = rows[0] || null;
        }

        const result = await tzAi.generateProposalMessage({
            orderTitle: orderRow?.title || '',
            orderDescription: orderRow?.description || '',
            orderCategory: orderRow?.category || '',
            brief: String(brief).trim(),
        });

        const cfg = tzAi.getTzAiConfig();
        res.json({ ...result, model: cfg.model });
    } catch (e) {
        console.error('[ai/generate-proposal]', e.message, e.status || '', e.code || '');
        if (e.code === 'AI_NOT_CONFIGURED') {
            return res.status(503).json({ error: 'AI не настроен' });
        }
        if (e.code === 'AI_AUTH' || e.status === 401 || e.status === 403) {
            return res.status(400).json({ error: 'Неверный AI_TZ_API_KEY. Проверьте ключ и base URL.' });
        }
        if (e.code === 'AI_RATE_LIMIT' || e.status === 429) {
            return res.status(429).json({ error: 'Превышен лимит запросов к AI. Подождите минуту.' });
        }
        if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY') {
            return res.status(500).json({ error: e.message || 'Не удалось сгенерировать текст' });
        }
        return res.status(500).json({ error: e.message || 'Ошибка генерации' });
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
                    COALESCE(SUM(p.price) FILTER (WHERE p.status='Выигран'), 0) AS volume,
                    ROUND(AVG(p.days) FILTER (WHERE p.status='Выигран')) AS avg_days,
                    CASE WHEN COUNT(o.id) > 0
                        THEN ROUND(COUNT(o.id) FILTER (WHERE o.status='Закрыта')::numeric / COUNT(o.id) * 100)
                        ELSE 0 END AS conversion
                FROM orders o
                LEFT JOIN proposals p ON p.order_id = o.id AND p.status='Выигран'
                WHERE o.company=$1 AND o.created_at >= NOW()-INTERVAL '6 months'
                GROUP BY date_trunc('month',o.created_at)
                ORDER BY month_dt`, [company]),
            // Category breakdown
            pool.query(`SELECT category, COUNT(*) AS cnt
                FROM orders WHERE company=$1
                GROUP BY category ORDER BY cnt DESC LIMIT 6`, [company]),
            // Top suppliers by won deal value + ratings
            pool.query(`SELECT p.company,
                    COUNT(*) AS deals,
                    SUM(p.price) AS total,
                    ROUND(AVG(p.days)) AS avg_days,
                    ROUND(AVG(EXTRACT(EPOCH FROM (p.created_at - o.created_at)) / 3600)) AS avg_response_hours,
                    (SELECT ROUND(AVG(rv.score)::numeric, 1)
                     FROM reviews rv
                     WHERE rv.to_company = p.company AND rv.from_company = $1) AS avg_score
                FROM proposals p
                JOIN orders o ON o.id = p.order_id
                WHERE o.company = $1 AND p.status = 'Выигран'
                GROUP BY p.company
                ORDER BY total DESC
                LIMIT 5`, [company]),
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
                avgDays:    r.avg_days != null ? Number(r.avg_days) : null,
                conversion: r.conversion != null ? Number(r.conversion) : null,
            })),
            categories: categoryRows.map(r => ({ label: r.category, count: Number(r.cnt) })),
            suppliers: supplierRows.map(r => ({
                name:   r.company,
                deals:  Number(r.deals),
                amount: Math.round(Number(r.total) / 1e6 * 100) / 100,
                share:  totalSupply > 0 ? Math.round(Number(r.total) / totalSupply * 1000) / 10 : 0,
                avgScore: r.avg_score != null ? Number(r.avg_score) : null,
                avgResponseHours: r.avg_response_hours != null ? Number(r.avg_response_hours) : null,
                avgDays: r.avg_days != null ? Number(r.avg_days) : null,
            })),
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
        if (io) io.emit('auction:created', { auctionId: auction.id, orderId, startPrice, endTime });
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
        const { price, days } = req.body;
        if (!price || isNaN(price)) return res.status(400).json({ error: 'Укажите цену' });
        if (!days || isNaN(days) || Number(days) <= 0) return res.status(400).json({ error: 'Укажите срок поставки' });

        const { rows: [auction] } = await pool.query(
            "SELECT * FROM auctions WHERE id = $1 AND status = 'active' AND end_time > NOW()", [req.params.id]
        );
        if (!auction) return res.status(404).json({ error: 'Аукцион не найден или завершён' });
        if (Number(price) >= Number(auction.current_best)) {
            return res.status(400).json({ error: `Ставка должна быть ниже текущей лучшей: ${auction.current_best} ₽` });
        }

        const { rows: [bid] } = await pool.query(
            'INSERT INTO auction_bids (auction_id, company, price, days) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.params.id, req.user.company, price, days]
        );
        await pool.query('UPDATE auctions SET current_best = $1, winner_company = $2 WHERE id = $3', [price, req.user.company, req.params.id]);

        if (io) io.to(`auction:${req.params.id}`).emit('auction:bid', {
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
    let rows;
    try {
        ({ rows } = await pool.query(
            "UPDATE auctions SET status = 'closed' WHERE status = 'active' AND end_time <= NOW() RETURNING id, order_id, winner_company, current_best"
        ));
    } catch (e) { console.error('[cron:auctions]', e.message); return; }

    for (const a of rows) {
        try {
            await handleClosedAuction(a);
        } catch (e) {
            console.error('[cron:auctions] failed for auction', a.id, e.message);
        }
    }
}

async function handleClosedAuction(a) {
    const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [a.order_id]);
    if (!order) return;
    const title = plainTitle(order.title);

    if (!a.winner_company) {
        await addNotification(order.company, `Аукцион «${title}» завершён без ставок.`);
        const email = await getCompanyEmail(order.company);
        if (email) {
            try {
                await sendEmail(email, `Аукцион завершён без ставок — «${title}»`,
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:#e07070">Аукцион завершён без ставок</h3>
                      <p>По закупке <strong>«${htmlEscape(title)}»</strong> никто не сделал ставку в течение отведённого времени.</p>
                      <a href="${APP_URL}/index.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть кабинет</a>
                    </div>`
                );
            } catch (e) {
                console.error('[email]', e.message);
            }
        }
        if (io) io.to(`auction:${a.id}`).emit('auction:closed', { auctionId: a.id, winnerCompany: null, orderId: a.order_id });
        return;
    }

    const { rows: [winningBid] } = await pool.query(
        'SELECT days FROM auction_bids WHERE auction_id = $1 AND company = $2 AND price = $3 ORDER BY created_at ASC LIMIT 1',
        [a.id, a.winner_company, a.current_best]
    );
    const days = winningBid ? winningBid.days : 0;

    const { rows: [newProposal] } = await pool.query(
        "INSERT INTO proposals (order_id, order_title, price, days, company, status, kp_file) VALUES ($1,$2,$3,$4,$5,'Ожидает ответа',NULL) RETURNING id",
        [a.order_id, order.title, a.current_best, days, a.winner_company]
    );

    const result = await acceptWonProposal(
        { pool, withTransaction, addNotification, getCompanyEmail, sendEmail, getUserIdsByCompany, sendPush, sendTelegramNotification, triggerIntegrations, logOrderEvent, plainTitle, htmlEscape, APP_URL },
        { proposalId: newProposal.id, actorCompany: 'Система (аукцион)' }
    );
    if (!result.ok) {
        console.error('[cron:auctions] accept failed for auction', a.id, result.reason);
        return;
    }

    await pool.query('UPDATE auctions SET winner_proposal_id = $1 WHERE id = $2', [newProposal.id, a.id]);
    await addNotification(a.winner_company, `Вы выиграли аукцион «${title}»! Цена: ${Number(a.current_best).toLocaleString('ru-RU')} ₽.`);

    await addNotification(order.company, `Аукцион «${title}» завершён. Победитель: ${a.winner_company}, ${Number(a.current_best).toLocaleString('ru-RU')} ₽.`);
    const customerEmail = await getCompanyEmail(order.company);
    if (customerEmail) {
        try {
            await sendEmail(customerEmail, `Аукцион завершён — «${title}»`,
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:#41bd97">Аукцион завершён</h3>
                  <p>По закупке <strong>«${htmlEscape(title)}»</strong> определён победитель.</p>
                  <p>Поставщик: <strong>${htmlEscape(a.winner_company)}</strong> · Цена: <strong>${Number(a.current_best).toLocaleString('ru-RU')} ₽</strong></p>
                  <a href="${APP_URL}/deals.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть сделку</a>
                </div>`
            );
        } catch (e) {
            console.error('[email]', e.message);
        }
    }
    const customerIds = await getUserIdsByCompany(order.company);
    for (const id of customerIds) {
        sendTelegramNotification(id, `🏁 <b>Аукцион завершён</b>\n«${title}»\nПобедитель: ${a.winner_company}\nЦена: ${Number(a.current_best).toLocaleString('ru-RU')} ₽`);
    }

    const { rows: losers } = await pool.query(
        'SELECT DISTINCT company FROM auction_bids WHERE auction_id = $1 AND company != $2',
        [a.id, a.winner_company]
    );
    for (const l of losers) {
        await addNotification(l.company, `Аукцион «${title}» завершён. Ваша ставка не победила.`);
    }

    if (io) io.to(`auction:${a.id}`).emit('auction:closed', { auctionId: a.id, winnerCompany: a.winner_company, price: a.current_best, orderId: a.order_id });
    emitDashboardRefresh(a.winner_company);
    emitDashboardRefresh(order.company);
}

async function notifyAuctionsEndingSoon() {
    try {
        const { rows } = await pool.query(`
            SELECT a.id, a.start_price, a.current_best, o.title
            FROM auctions a
            JOIN orders o ON o.id = a.order_id
            WHERE a.status = 'active'
              AND a.reminder_sent = false
              AND a.end_time > NOW()
              AND a.end_time <= NOW() + INTERVAL '10 minutes'
        `);
        for (const a of rows) {
            const { rows: bidders } = await pool.query(
                'SELECT DISTINCT company FROM auction_bids WHERE auction_id = $1',
                [a.id]
            );
            const price = Number(a.current_best || a.start_price).toLocaleString('ru-RU');
            const text = `⏳ <b>Аукцион скоро завершится</b>\n«${plainTitle(a.title)}»\nТекущая лучшая цена: ${price} ₽\nУспейте сделать финальную ставку!`;
            for (const b of bidders) {
                const userIds = await getUserIdsByCompany(b.company);
                for (const id of userIds) sendTelegramNotification(id, text);
            }
            await pool.query('UPDATE auctions SET reminder_sent = true WHERE id = $1', [a.id]);
        }
    } catch (e) { console.error('[cron:auction-reminder]', e.message); }
}

// ── Risk assessment (ЕГРЮЛ + платформа + отзывы) ────────────────────────────
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
            'SELECT verified_by_platform, verified_egrul, company FROM companies WHERE inn = $1 LIMIT 1', [inn]
        );
        const comp = compRows[0];
        if (comp && comp.verified_by_platform) {
            checks.push({ name: 'Верификация платформы', status: 'ok', detail: 'Компания проверена командой ТехЗаказ' });
            score += 20;
        } else if (comp && comp.verified_egrul) {
            checks.push({ name: 'Верификация ЕГРЮЛ', status: 'ok', detail: 'Компания проверена автоматически по реестру ФНС' });
            score += 12;
        } else {
            checks.push({ name: 'Верификация', status: 'warn', detail: 'Компания не верифицирована' });
        }

        // 3. Reviews
        if (comp) {
            const { rows: revRows } = await pool.query(
                `SELECT AVG(score)::numeric(3,1) as avg, COUNT(*) as cnt FROM reviews WHERE to_company = $1`, [comp.company]
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

app.get('/api/public/companies/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { rows: [row] } = await pool.query(
            "SELECT * FROM companies WHERE id = $1 AND role = 'producer'",
            [id]
        );
        if (!row) return res.status(404).json({ error: 'Поставщик не найден' });
        const c = await enrichCompany(rowToCompany(row), null);
        const { rows: reviews } = await pool.query(
            `SELECT from_company, score, text, created_at FROM reviews
             WHERE to_company = $1 ORDER BY created_at DESC LIMIT 12`,
            [c.company]
        );
        const avg = reviews.length
            ? Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length * 10) / 10
            : null;
        res.json({
            id: c.id,
            company: c.company,
            inn: c.inn || '',
            specialization: c.specialization || '',
            city: c.city || '',
            about: c.about || '',
            equipment: c.equipment || [],
            isoCertificates: c.iso_certificates || [],
            qualityCertificates: c.quality_certificates || [],
            capabilities: c.capabilities || [],
            productionLoad: c.production_load,
            verified: Boolean(c.verified_by_platform),
            verifiedEgrul: Boolean(c.verified_egrul),
            status: c.status,
            rating: c.rating,
            ratingLabel: c.ratingLabel,
            stats: c.stats,
            photos: c.photos || [],
            reviews,
            reviewAvg: avg,
            reviewCount: reviews.length,
            publicUrl: `/p/${c.id}`,
        });
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

app.get('/api/export/orders.pdf', requireAuth, async (req, res, next) => {
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
        buildOrdersPdf(rows, res);
    } catch (e) { next(e); }
});

app.get('/api/export/proposals.pdf', requireAuth, async (req, res, next) => {
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
        buildProposalsPdf(rows, res, isProducer);
    } catch (e) { next(e); }
});

app.get('/api/export/compare-kp.pdf', requireAuth, requireRole('customer'), async (req, res, next) => {
    try {
        const orderId = Number(req.query.orderId);
        if (!orderId) return res.status(400).json({ error: 'Укажите orderId' });
        const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (!order) return res.status(404).json({ error: 'Закупка не найдена' });
        if (order.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });

        const ids = String(req.query.ids || '')
            .split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
        const { rows } = ids.length
            ? await pool.query(
                `SELECT p.company AS supplier, p.price, p.days, p.status, p.created_at
                 FROM proposals p WHERE p.order_id = $1 AND p.id = ANY($2::int[])
                 ORDER BY p.price ASC NULLS LAST`,
                [orderId, ids]
              )
            : await pool.query(
                `SELECT p.company AS supplier, p.price, p.days, p.status, p.created_at
                 FROM proposals p WHERE p.order_id = $1 ORDER BY p.price ASC NULLS LAST`,
                [orderId]
              );
        if (rows.length < 2) return res.status(400).json({ error: 'Нужно минимум 2 КП для сравнения' });

        const orderObj = rowToOrder(order);
        const benchmark = await computePriceBenchmark(orderObj.category, orderId);
        const { rows: producers } = await pool.query("SELECT * FROM companies WHERE role = 'producer'");
        const producerMap = new Map(producers.map(r => [r.company, rowToCompany(r)]));
        const enriched = rows.map(r => ({
            ...r,
            match_score: producerMap.has(r.supplier) ? computeMatchScore(orderObj, producerMap.get(r.supplier)) : null,
        }));

        buildCompareKpPdf(
            { orderId, orderTitle: plainTitle(order.title), benchmark },
            enriched,
            res
        );
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
        if (!orderId || !company) return res.status(400).json({ error: 'orderId и company обязательны' });
        if (!(await canAccessOrderThread(req.user, orderId, company))) {
            return res.status(403).json({ error: 'Нет доступа к задачам этой переписки' });
        }
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
        if (!(await canAccessOrderThread(req.user, orderId, company))) {
            return res.status(403).json({ error: 'Нет доступа к задачам этой переписки' });
        }
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
        const { rows: [existing] } = await pool.query('SELECT * FROM tasks WHERE id = $1', [Number(req.params.id)]);
        if (!existing) return res.status(404).json({ error: 'Задача не найдена' });
        if (!(await canAccessOrderThread(req.user, existing.order_id, existing.company))) {
            return res.status(403).json({ error: 'Нет доступа к этой задаче' });
        }
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
        if (!(await canAccessOrderThread(req.user, orderId, company))) {
            return res.status(403).json({ error: 'Нет доступа к контексту этой переписки' });
        }

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

// ===================== ВЕРИФИКАЦИЯ =====================

app.post('/api/verification/request', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role === 'admin') return res.status(403).json({ error: 'Недоступно для администраторов' });

        const platformTier = req.body?.platformTier === true;

        const { rows: [company] } = await pool.query(
            'SELECT * FROM companies WHERE company = $1 AND role = $2',
            [req.user.company, req.user.role]
        );
        if (!company) return res.status(404).json({ error: 'Профиль компании не найден' });
        if (company.verified_by_platform) {
            return res.status(400).json({ error: 'Компания уже верифицирована платформой' });
        }

        const { rows: [existing] } = await pool.query(
            'SELECT * FROM verification_requests WHERE company_id = $1',
            [company.id]
        );
        if (existing && existing.status === 'pending') {
            return res.status(400).json({ error: 'Заявка уже отправлена и ожидает рассмотрения' });
        }
        if (existing) {
            await pool.query('DELETE FROM verification_requests WHERE company_id = $1', [company.id]);
        }

        // Расширенная верификация платформой (ручная) — для тех, у кого уже есть ЕГРЮЛ
        if (platformTier || company.verified_egrul) {
            await pool.query(
                "INSERT INTO verification_requests (company_id, status) VALUES ($1, 'pending')",
                [company.id]
            );
            return res.json({
                tier: 'platform',
                status: 'pending',
                message: 'Заявка на верификацию платформой отправлена. Мы проверим профиль вручную.',
            });
        }

        // Автопроверка по ЕГРЮЛ (бесплатно)
        const egrul = await fetchEgrulData(String(company.inn || '').trim());
        const evaluation = evaluateAutoVerification(company, req.user, egrul);

        if (evaluation.pass) {
            await withTransaction(async (client) => {
                await client.query(
                    'UPDATE companies SET verified_egrul = true, egrul_verified_at = NOW() WHERE id = $1',
                    [company.id]
                );
                await client.query(
                    "INSERT INTO verification_requests (company_id, status, reviewed_at) VALUES ($1, 'approved_auto', NOW())",
                    [company.id]
                );
            });

            const checksText = evaluation.checks.map(c => c.detail).filter(Boolean).join(' · ');
            await addNotification(
                company.company,
                `✓ Компания проверена по ЕГРЮЛ${checksText ? ': ' + checksText : ''}`
            );
            const email = await getCompanyEmail(company.company);
            if (email) {
                await sendEmail(email, 'Верификация по ЕГРЮЛ — ТехЗаказ',
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:#0B8FCE">Проверено по ЕГРЮЛ</h3>
                      <p>Компания <strong>${htmlEscape(company.company)}</strong> прошла автоматическую проверку в реестре ФНС.</p>
                      <p style="color:#555;font-size:14px;">${htmlEscape(checksText || 'Компания действующая')}</p>
                      <p style="font-size:13px;color:#888;">Для знака «Верифицирован платформой» заполните профиль и подайте заявку на расширенную проверку.</p>
                      <a href="${APP_URL}/company-profile.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#0B8FCE;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть профиль</a>
                    </div>`
                );
            }

            return res.json({
                tier: 'egrul',
                status: 'approved_egrul',
                autoApproved: true,
                checks: evaluation.checks,
                message: 'Компания проверена автоматически по ЕГРЮЛ. Знак отображается в профиле и каталоге.',
            });
        }

        if (evaluation.manual) {
            await pool.query(
                "INSERT INTO verification_requests (company_id, status, admin_comment) VALUES ($1, 'pending', $2)",
                [company.id, evaluation.reason || 'Требуется ручная проверка']
            );
            return res.json({
                tier: 'platform',
                status: 'pending',
                manual: true,
                message: evaluation.reason
                    || 'Не удалось проверить по ЕГРЮЛ автоматически — заявка передана модератору.',
            });
        }

        return res.status(400).json({
            error: evaluation.reason || 'Автоматическая проверка не пройдена',
            checks: evaluation.checks,
        });
    } catch (e) { next(e); }
});

app.get('/api/verification/status', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role === 'admin') return res.json({ status: 'none', tier: null });

        const { rows: [company] } = await pool.query(
            'SELECT * FROM companies WHERE company = $1 AND role = $2',
            [req.user.company, req.user.role]
        );
        if (!company) return res.json({ status: 'none', tier: null });

        if (company.verified_by_platform) {
            return res.json({ status: 'approved', tier: 'platform' });
        }
        if (company.verified_egrul) {
            return res.json({
                status: 'approved_egrul',
                tier: 'egrul',
                egrulVerifiedAt: company.egrul_verified_at,
            });
        }

        const { rows: [vr] } = await pool.query(
            'SELECT * FROM verification_requests WHERE company_id = $1',
            [company.id]
        );
        if (!vr) return res.json({ status: 'none', tier: null });

        return res.json({
            status: vr.status === 'approved_auto' ? 'approved_egrul' : vr.status,
            tier: vr.status === 'approved_auto' ? 'egrul' : (vr.status === 'pending' ? 'platform' : null),
            comment: vr.admin_comment || '',
            requestedAt: vr.requested_at,
        });
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
            // Push: верификация одобрена
            getUserIdsByCompany(companyRow.company).then(ids =>
                ids.forEach(id => {
                    sendPush(id, 'Верификация одобрена ✓', 'Ваша компания верифицирована платформой ТехЗаказ', `${APP_URL}/settings`);
                    sendTelegramNotification(id, `✅ <b>Верификация одобрена!</b>\nВаша компания верифицирована платформой ТехЗаказ.`);
                })
            ).catch(() => {});
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

// ===================== ADMIN: USERS & STATS =====================

app.get('/api/admin/stats', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const [
            { rows: [{ n: users }] },
            { rows: [{ n: pending }] },
            { rows: [{ n: orders }] },
            { rows: [{ n: companies }] },
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) AS n FROM users'),
            pool.query("SELECT COUNT(*) AS n FROM verification_requests WHERE status='pending'"),
            pool.query('SELECT COUNT(*) AS n FROM orders'),
            pool.query('SELECT COUNT(*) AS n FROM companies'),
        ]);
        res.json({ users, pending, orders, companies });
    } catch (e) { next(e); }
});

// Регистрации по дням за 30 дней (для графика в админке).
// У старых пользователей created_at = дата миграции — история начинается с 03.07.2026.
app.get('/api/admin/registrations', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS n
            FROM users
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY day ORDER BY day
        `);
        res.json(rows.map(r => ({ day: r.day, n: Number(r.n) })));
    } catch (e) { next(e); }
});

app.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, email, role, company, inn, email_verified, created_at FROM users ORDER BY id'
        );
        res.json(rows);
    } catch (e) { next(e); }
});

app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { rows: [me] } = await pool.query('SELECT id FROM users WHERE id=$1', [req.user.id]);
        if (me && me.id === id) return res.status(400).json({ error: 'Нельзя удалить собственный аккаунт' });
        await pool.query('DELETE FROM users WHERE id=$1', [id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.patch('/api/admin/users/:id/role', requireAuth, requireRole('admin'), async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const { role } = req.body;
        if (!['customer', 'producer', 'admin'].includes(role)) return res.status(400).json({ error: 'Неверная роль' });
        await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
        res.json({ ok: true });
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

async function closeExpiredOrders() {
    try {
        const { rows } = await pool.query(
            "SELECT * FROM orders WHERE status = 'Активный' AND deadline IS NOT NULL AND TRIM(deadline) != ''"
        );
        const today = startOfDay(new Date());
        let closed = 0;
        for (const row of rows) {
            const dl = parseDeadlineDate(row.deadline);
            if (!dl || startOfDay(dl) >= today) continue;

            const order = rowToOrder(row);
            const title = plainTitle(order.title);

            await pool.query("UPDATE orders SET status = 'Дедлайн истёк' WHERE id = $1", [order.id]);

            const { rows: pending } = await pool.query(
                "SELECT company FROM proposals WHERE order_id = $1 AND status = 'Ожидает ответа'",
                [order.id]
            );

            await notifyCompanyEmail(
                order.company,
                `Дедлайн прямой закупки «${title}» истёк — закупка закрыта автоматически.`,
                `Дедлайн истёк — «${title}»`,
                `<p style="color:#444;font-size:14px;">Истёк срок приёма предложений по закупке <strong>«${htmlEscape(title)}»</strong>.</p>
                 <p style="color:#666;font-size:13px;">Закупка закрыта автоматически. Если победитель ещё не выбран — откройте отклики и примите КП вручную или создайте новую закупку.</p>`
            );

            for (const p of pending) {
                await notifyCompanyEmail(
                    p.company,
                    `Дедлайн закупки «${title}» истёк — приём предложений завершён.`,
                    `Дедлайн закупки истёк — «${title}»`,
                    `<p style="color:#444;font-size:14px;">Заказчик закрыл приём предложений по закупке <strong>«${htmlEscape(title)}»</strong> (истёк дедлайн).</p>`
                );
            }
            closed += 1;
        }
        if (closed) console.log(`[cron:close-expired-orders] closed ${closed} order(s)`);
    } catch (e) { console.error('[cron:close-expired-orders]', e.message); }
}

async function sendDeadlineReminders() {
    try {
        const { rows } = await pool.query("SELECT * FROM orders WHERE status = 'Активный'");
        const today = startOfDay(new Date());
        const remindDay = new Date(today);
        remindDay.setDate(remindDay.getDate() + 3);
        let sent = 0;

        for (const row of rows) {
            const dl = parseDeadlineDate(row.deadline);
            if (!dl || startOfDay(dl).getTime() !== remindDay.getTime()) continue;

            const title = plainTitle(row.title);
            const { rows: countRows } = await pool.query(
                "SELECT COUNT(*)::int AS count FROM proposals WHERE order_id = $1 AND status = 'Ожидает ответа'",
                [row.id]
            );
            const count = countRows[0]?.count ?? 0;

            await notifyCompanyEmail(
                row.company,
                `⏳ До дедлайна закупки «${title}» осталось 3 дня.`,
                `Напоминание: дедлайн через 3 дня — «${title}»`,
                `<p style="color:#444;font-size:14px;">По закупке <strong>«${htmlEscape(title)}»</strong> дедлайн через <strong>3 дня</strong>.</p>
                 <p style="color:#666;font-size:13px;">Откликов на рассмотрении: ${count}. Сравните КП и выберите поставщика, пока закупка активна.</p>
                 <p style="margin-top:14px;"><a href="${APP_URL}/index.html" style="display:inline-block;background:#FF6A00;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Открыть закупки →</a></p>`
            );
            const reminderIds = await getUserIdsByCompany(row.company);
            await Promise.all(reminderIds.map(id => {
                sendPush(id, 'Дедлайн через 3 дня', `Закупка «${plainTitle(row.title)}» закрывается через 3 дня`, `${APP_URL}/index`);
                sendTelegramNotification(id, `⏳ <b>Дедлайн через 3 дня</b>\nЗакупка «${plainTitle(row.title)}» закрывается.`);
            }));
            sent += 1;
        }
        if (sent) console.log(`[cron:deadline-reminders] sent ${sent} reminder(s)`);
    } catch (e) { console.error('[cron:deadline-reminders]', e.message); }
}

function startOrderMaintenanceCron() {
    // 08:00 Moscow (05:00 UTC)
    cron.schedule('0 5 * * *', async () => {
        await sendDeadlineReminders();
        await closeExpiredOrders();
    });
}

function startAuctionCron() {
    cron.schedule('* * * * *', closeExpiredAuctions); // every minute
    cron.schedule('* * * * *', notifyAuctionsEndingSoon); // every minute
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
                    buildDigestHtml(orders, p.company)).catch(e => console.error('[email:digest:daily]', e.message));
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
                    buildDigestHtml(orders, p.company)).catch(e => console.error('[email:digest:weekly]', e.message));
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
    startOrderMaintenanceCron();
    startTelegramBot();
    return httpServer;
}

if (require.main === module) {
    start().catch(err => {
        console.error('Ошибка инициализации БД:', err);
        process.exit(1);
    });
}

module.exports = { app, httpServer, start, pool };
