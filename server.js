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
const createExportRouter = require('./routes/export');
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
const createAuctionsRouter = require('./routes/auctions');
const createReviewsRouter = require('./routes/reviews');
const createFavoritesRouter = require('./routes/favorites');
const createAiRouter = require('./routes/ai');
const createAdminRouter = require('./routes/admin');
const createNotificationsRouter = require('./routes/notifications');
const createTasksRouter = require('./routes/tasks');
const createIntegrationsRouter = require('./routes/integrations');
const createTeamRouter = require('./routes/team');
const createTemplatesRouter = require('./routes/templates');
const createSeoRouter = require('./routes/seo');
const createTelegramRouter = require('./routes/telegram');
const createPushRouter = require('./routes/push');
const createPublicRouter = require('./routes/public');
const createAnalyticsRouter = require('./routes/analytics');
const createIntegrationsPush = require('./lib/integrations-push');
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
        kpp: r.kpp || '',
        legalAddress: r.legal_address || '',
        bankName: r.bank_name || '',
        bankAccount: r.bank_account || '',
        bankBik: r.bank_bik || '',
        bankCorr: r.bank_corr || '',
        taxSystem: r.tax_system || '',
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
        // Все производители: верифицированные приоритетнее, заглушки реестра тоже
        // индексируем (4286 страниц «завод + продукция + город» — органический канал)
        const { rows: suppliers } = await pool.query(`
            SELECT id, verified_by_platform, claimed FROM companies
            WHERE role = 'producer' AND status <> 'Отклонено'
            ORDER BY verified_by_platform DESC, claimed DESC, id ASC
            LIMIT 45000
        `);
        for (const s of suppliers) {
            pages.push({
                url: `/p/${s.id}`,
                priority: s.verified_by_platform ? '0.6' : (s.claimed ? '0.5' : '0.4'),
                changefreq: s.claimed ? 'weekly' : 'monthly',
            });
        }
        res.setHeader('Cache-Control', 'public, max-age=3600');
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
            "SELECT company, specialization, city, about, products, claimed, source, verified_by_platform FROM companies WHERE id = $1 AND role = 'producer'",
            [id]
        );
        if (!row) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }
        const filePath = path.join(__dirname, 'supplier-public.html');
        let html = fs.readFileSync(filePath, 'utf8');
        const fromRegistry = !row.claimed && row.source === 'gisp-pp719';
        const title = fromRegistry
            ? `${row.company}${row.city ? ' (' + row.city + ')' : ''} — производитель из реестра Минпромторга | ТехЗаказ`
            : `${row.company} — поставщик | ТехЗаказ`;
        const desc = [row.specialization, row.products, row.city, row.about].filter(Boolean).join(' · ').slice(0, 160)
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

const { triggerIntegrations, sapB1Login } = createIntegrationsPush({ pool });

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
    rowToNotification,
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
app.use('/api/export', createExportRouter(routesDeps));
app.use('/api/auctions', createAuctionsRouter(routesDeps));
app.use('/api/reviews', createReviewsRouter(routesDeps));
app.use('/api/favorites', createFavoritesRouter(routesDeps));
app.use('/api', createAiRouter({ ...routesDeps, genAI }));
app.use('/api', createAdminRouter(routesDeps));
app.use('/api/notifications', createNotificationsRouter(routesDeps));
app.use('/api', createTasksRouter(routesDeps));
app.use('/api/integrations', createIntegrationsRouter({ ...routesDeps, sapB1Login }));
app.use('/api', createTeamRouter(routesDeps));
app.use('/api/templates', createTemplatesRouter(routesDeps));
app.use('/api/seo', createSeoRouter({ ...routesDeps, genAI }));
app.use('/api/telegram', createTelegramRouter(routesDeps));
app.use('/api/push', createPushRouter(routesDeps));
app.use('/api', createPublicRouter({ ...routesDeps, fetchEgrulData, getProducerCategories, getCityProductionPoint, offsetProductionPoint }));
app.use('/api', createAnalyticsRouter(routesDeps));

// ===================== ЭКСПОРТ EXCEL =====================

// ===================== НАСТРОЙКА ДАЙДЖЕСТА =====================

app.patch('/api/auth/digest', requireAuth, async (req, res, next) => {
    try {
        const { frequency } = req.body;
        if (!['daily','weekly','never'].includes(frequency)) return res.status(400).json({ error: 'Недопустимое значение' });
        await pool.query('UPDATE users SET digest_frequency=$1 WHERE id=$2', [frequency, req.user.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ===================== ИНТЕГРАЦИИ =====================

// ── Auction cron helpers ────────────────────────────────────────────────────
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
