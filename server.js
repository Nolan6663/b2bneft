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
const compression = require('compression');
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
const { renewAccessToken } = require('./lib/session-renew');
const { sendHttpError } = require('./lib/http-errors');
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
const createLogisticsRouter = require('./routes/logistics');
const { purgeExpiredQuotes } = require('./lib/logistics');
const { purgeExpiredTokens } = require('./lib/purge-expired');
const { checkAllCarriers, formatCarrierAlert } = require('./lib/logistics/health');
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
const { shortTitle: buildProducerTitle, metaDescription: buildProducerDescription, ssrProfileHtml: buildProducerSsr, robotsDirective: buildProducerRobots } = require('./lib/producer-seo');
const { categorizeProducer } = require('./lib/producer-categories');
const { withQuery } = require('./lib/redirect-query');
const { REGIONS, regionBySlug, regionLabel } = require('./seo/regions-data');
const { OPERATIONS, operationBySlug, producerHasOperation } = require('./seo/operations-data');
const {
    buildOperationTitle,
    buildOperationDescription,
    buildOperationRobots,
    buildOperationSsr,
    buildOperationJsonLd,
    MIN_INDEXABLE: OP_MIN_INDEXABLE,
} = require('./lib/equipment-seo');
const {
    buildRegionTitle,
    buildRegionDescription,
    buildRegionRobots,
    buildRegionSsr,
    buildRegionJsonLd,
    esc: regionEsc,
    plural: regionPlural,
    MIN_INDEXABLE,
} = require('./lib/region-seo');
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
const EMAIL_FROM = process.env.EMAIL_FROM || 'info.texzakaz@yandex.com';
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

/* Вложения закупки: новая колонка attachments (массив), старая drawing (один
   файл). Уже размещённые заявки живут в drawing, поэтому читаем обе и отдаём
   единым списком; drawing в ответе остаётся ради старых мест в интерфейсе. */
function parseOrderAttachments(r) {
    if (!r) return [];
    let list = [];
    if (r.attachments) {
        try { list = JSON.parse(r.attachments); } catch { list = []; }
        if (!Array.isArray(list)) list = [];
    }
    if (!list.length && r.drawing) {
        try {
            const single = JSON.parse(r.drawing);
            if (single && single.storedName) list = [single];
        } catch { /* битый JSON старой записи — считаем, что файла нет */ }
    }
    return list.filter(f => f && f.storedName);
}

function rowToOrder(r) {
    if (!r) return null;
    const attachments = parseOrderAttachments(r);
    return {
        id: r.id, title: r.title, category: r.category, status: r.status,
        responses: r.responses, deadline: r.deadline, quantity: r.quantity,
        description: r.description, company: r.company,
        drawing: attachments[0] || null,
        attachments,
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
        // Габариты для расчёта доставки. null во всех полях, если завод их не
        // указал, — в таком КП расчёта не будет, и это нормальный случай.
        cargo: {
            weight: r.cargo_weight == null ? null : Number(r.cargo_weight),
            length: r.cargo_length == null ? null : Number(r.cargo_length),
            width: r.cargo_width == null ? null : Number(r.cargo_width),
            height: r.cargo_height == null ? null : Number(r.cargo_height),
            places: r.cargo_places == null ? null : Number(r.cargo_places),
        },
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
        // отдельно от fromRegistry: плашку «Реестр Минпромторга» имеют право
        // носить только стабы из ГИСП ПП-719, не любой импортированный источник
        fromGisp: !r.claimed && r.source === 'gisp-pp719',
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
/* Сжатие ответов.
 *
 * До этого его не было нигде: nginx впереди стоит, но gzip у него выключен, и
 * наружу всё уходило как есть. Проверено на проде 15.08: /api/map отдавал
 * 2 434 220 байт и на клиента приезжал полностью, даже когда браузер просил
 * gzip. JSON и HTML жмутся примерно в десять раз, и это самая дешёвая правка
 * из всех, что вообще влияют на скорость страниц.
 *
 * Место в цепочке важно: до статики и до роутов, иначе сжимать будет нечего.
 */
app.use(compression());
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

// Гостевой онбординг: мастера /zayavka и /zavod работают без авторизации,
// поэтому потолок ставим по IP — иначе бесплатный доступ к модели и к подбору.
const guestAiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Пока хватит — за час можно собрать три задания. Зарегистрируйтесь, чтобы продолжить без ограничений.' }
});
const guestLookupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Подождите немного или зарегистрируйтесь.' }
});
app.post('/api/public/tz-draft', guestAiLimiter);
app.post('/api/public/analyze-drawing', guestAiLimiter);
app.post('/api/public/match-preview', guestLookupLimiter);
app.get('/api/public/company-by-inn', guestLookupLimiter);
// Подсказки городов нужны в гостевом мастере завода, до регистрации.
app.get('/api/logistics/cities', guestLookupLimiter);
// Публичный калькулятор на /dostavka ходит в чужие API перевозчиков, поэтому
// потолок ниже общего: 20 расчётов за 10 минут с адреса. Честному человеку
// столько на подбор габаритов хватает с запасом, скрипту — нет.
// Выгрузка считает то же самое и ходит к тем же перевозчикам (обычно из кэша),
// поэтому живёт под тем же потолком: путь указан явно, иначе точный маршрут
// выше на подпути не сработает и выгрузка осталась бы без ограничения вовсе.
app.post([
    '/api/logistics/public-quote',
    '/api/logistics/public-quote/export.pdf',
    '/api/logistics/public-quote/export.xlsx',
], rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много расчётов подряд. Подождите несколько минут.' },
}));

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

/* Несколько вложений сразу: возвращает массив объектов, а не JSON-строку —
   вызывающий сам решает, что положить в колонку. */
async function persistUploads(files, prefix) {
    const list = Array.isArray(files) ? files : [];
    const saved = [];
    for (const file of list) {
        const meta = await storage.saveFile(file, prefix);
        saved.push({ originalName: meta.originalName, storedName: meta.storedName });
    }
    return saved;
}

/* К закупке цепляется до десяти файлов: чертежи и фото. Поле `drawing`
   оставлено ради старых клиентов, новые шлют `drawings`. */
const MAX_ORDER_ATTACHMENTS = 10;
const drawingUploadOptions = {
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: MAX_ORDER_ATTACHMENTS },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_DRAWING_EXT.includes(ext)) return cb(new Error('Недопустимый тип файла. Разрешены: ' + ALLOWED_DRAWING_EXT.join(', ')));
        if (BLOCKED_MIME.has(file.mimetype)) return cb(new Error('Недопустимый MIME-тип файла'));
        cb(null, true);
    }
};
const uploadDrawing = multer(drawingUploadOptions).fields([
    { name: 'drawing', maxCount: MAX_ORDER_ATTACHMENTS },
    { name: 'drawings', maxCount: MAX_ORDER_ATTACHMENTS },
]);
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

/* Видео к заявке. Через память процесса такое не пропустить: ролик с телефона
   весит сотни мегабайт, а остальные загрузки живут в memoryStorage. Поэтому
   отдельный multer с diskStorage — файл ложится во временную папку, а оттуда
   уходит в хранилище потоком (storage.saveStreamFile). */
const VIDEO_ALLOWED_EXT = ['.mp4', '.mov', '.m4v', '.webm'];
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 200) * 1024 * 1024;
const VIDEO_TMP_DIR = path.join(__dirname, 'uploads', 'tmp');
if (!fs.existsSync(VIDEO_TMP_DIR)) fs.mkdirSync(VIDEO_TMP_DIR, { recursive: true });

const uploadVideo = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, VIDEO_TMP_DIR),
        filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!VIDEO_ALLOWED_EXT.includes(ext)) {
            return cb(new Error('Видео принимается в форматах: ' + VIDEO_ALLOWED_EXT.join(', ')));
        }
        if (!/^video\//.test(file.mimetype || '')) return cb(new Error('Это не видеофайл'));
        cb(null, true);
    },
}).single('video');

function handleVideoUpload(req, res, next) {
    uploadVideo(req, res, (err) => {
        if (err) {
            /* Недогруженный кусок с диска убираем сразу, иначе на сервере
               копятся обрезки по несколько сотен мегабайт. */
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
            const tooBig = err.code === 'LIMIT_FILE_SIZE';
            return res.status(400).json({
                error: tooBig
                    ? `Видео больше ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} МБ — сожмите или обрежьте ролик`
                    : (err.message || 'Не удалось загрузить видео'),
            });
        }
        next();
    });
}

async function persistVideo(file) {
    if (!file) return null;
    const meta = await storage.saveStreamFile({
        tmpPath: file.path,
        originalName: file.originalname,
        mimetype: file.mimetype,
    }, 'videos');
    return { originalName: meta.originalName, storedName: meta.storedName, kind: 'video', size: meta.size };
}

function handleDrawingUpload(req, res, next) {
    uploadDrawing(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
        /* Оба поля сводим в один список: обработчикам всё равно, как назвал
           файлы клиент. req.file оставлен для кода, ждущего один файл. */
        const fields = req.files && !Array.isArray(req.files) ? req.files : {};
        const list = [...(fields.drawings || []), ...(fields.drawing || [])];
        req.uploadedFiles = list.slice(0, MAX_ORDER_ATTACHMENTS);
        req.file = req.uploadedFiles[0] || undefined;
        next();
    });
}
function handleKPUpload(req, res, next) {
    uploadKP(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
        next();
    });
}

// Картинка чертежа для разбора моделью: живёт только в памяти запроса, в хранилище
// не попадает. Модель принимает растр, поэтому DWG и PDF сюда не пускаем.
const DRAWING_IMAGE_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'];
const uploadDrawingImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!DRAWING_IMAGE_EXT.includes(ext)) {
            return cb(new Error('Нужен PDF чертежа или его изображение: PNG, JPG, TIFF, BMP. Для DWG выгрузите PDF или сделайте снимок листа.'));
        }
        if (BLOCKED_MIME.has(file.mimetype)) return cb(new Error('Недопустимый MIME-тип файла'));
        cb(null, true);
    },
}).single('drawing');

function handleDrawingImageUpload(req, res, next) {
    uploadDrawingImage(req, res, (err) => {
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
    'dostavka.html',
    'zayavka.html',
    'zavod.html',
    'privacy.html', 'terms.html',
];
PUBLIC_PAGES.forEach(page => {
    const slug = '/' + page.replace('.html', '');
    app.get('/' + page, (req, res) => {
        // Query переносим: без него delivery.html?id=1 превращался в /delivery,
        // страница не находила сделку и уводила в «Заказы».
        const target = slug === '/landing' ? '/' : slug;
        res.redirect(301, withQuery(req.originalUrl, target));
    });
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

// ── Страницы регионов: /zakupki/region/<slug> ────────────────────────────────
// Реестр ГИСП пишет в колонку city название региона, поэтому группировка идёт по
// точному совпадению строки. Состав каталога меняется раз в недели — час кэша.
const _regionCache = new Map();
const REGION_TTL_MS = 3600 * 1000;
const REGION_CARDS_LIMIT = 60;

async function loadRegionData(region) {
    const cached = _regionCache.get(region.slug);
    if (cached && Date.now() - cached.ts < REGION_TTL_MS) return cached.data;

    const { rows } = await pool.query(
        `SELECT id, company, city, specialization, products, about, equipment, capabilities,
                verified_by_platform, claimed, source
           FROM companies
          WHERE role = 'producer' AND status <> 'Отклонено' AND city = $1
          ORDER BY verified_by_platform DESC, claimed DESC, company ASC`,
        [region.name]
    );

    const producers = rows.map(rowToCompany);
    const catCount = new Map();
    for (const p of producers) {
        for (const c of categorizeProducer(p)) catCount.set(c, (catCount.get(c) || 0) + 1);
    }
    const data = {
        producers: producers.slice(0, REGION_CARDS_LIMIT),
        stats: {
            total: producers.length,
            verified: producers.filter(p => p.verifiedByPlatform).length,
            claimed: producers.filter(p => p.claimed).length,
            categories: [...catCount.entries()].sort((a, b) => b[1] - a[1]),
        },
    };
    _regionCache.set(region.slug, { ts: Date.now(), data });
    return data;
}

/* ── Публичная страница закупки: /zakupka/<id> ───────────────────────────────
   Нужна для ссылок наружу (посты в сообществе, письма заводам): без неё завод
   упирается в форму входа и не видит, на что его зовут. Показываем задание,
   сроки и категорию; заказчика, контакты и файлы — нет, они за регистрацией. */
function orderPlural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

function formatOrderDeadline(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

app.get('/zakupka/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }
        const { rows: [row] } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (!row) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }

        const order = rowToOrder(row);
        const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
        const isOpen = order.status !== 'Закрыта' && order.status !== 'Отменена' && order.status !== 'Дедлайн истёк';
        const title = plainTitle(order.title);
        const deadline = formatOrderDeadline(order.deadline);

        const facts = [
            order.category ? `<div class="zo-fact"><span>Категория</span><b>${htmlEscape(order.category)}</b></div>` : '',
            order.quantity ? `<div class="zo-fact"><span>Количество</span><b>${order.quantity} шт.</b></div>` : '',
            deadline ? `<div class="zo-fact"><span>Срок поставки</span><b>${htmlEscape(deadline)}</b></div>` : '',
            `<div class="zo-fact"><span>Откликов</span><b>${order.responses || 0}</b></div>`,
        ].filter(Boolean).join('\n      ');

        const attachments = order.attachments || [];
        const hasVideo = attachments.some(f => f.kind === 'video');
        const fileCount = attachments.length;
        const filesHtml = fileCount
            ? `<div class="zo-files"><b>К заявке приложено ${fileCount} ${orderPlural(fileCount, 'файл', 'файла', 'файлов')}</b> — чертежи и фото${hasVideo ? ', есть видео от заказчика' : ''}. Открываются в кабинете после отклика на заявку.</div>`
            : '';

        const description = (order.description || '').trim();
        const descHtml = description
            ? htmlEscape(description)
            : 'Заказчик описал задачу коротко. Подробности — в кабинете после отклика.';

        const metaDesc = [
            title,
            order.category ? `категория: ${order.category}` : '',
            order.quantity ? `${order.quantity} шт.` : '',
            deadline ? `срок ${deadline}` : '',
        ].filter(Boolean).join(', ').slice(0, 300);

        const html = fs.readFileSync(path.join(__dirname, 'zakupki', 'order.html'), 'utf8')
            .replace(/<!--META_TITLE-->/g, htmlEscape(`${title} — заявка на ТехЗаказ`))
            .replace(/<!--META_DESC-->/g, htmlEscape(metaDesc))
            /* Закрытые заявки из индекса убираем: страница живёт ради ссылок из
               сообщества и писем, но в поиске мёртвая закупка бесполезна. */
            .replace(/<!--META_ROBOTS-->/g, isOpen ? 'index, follow' : 'noindex, follow')
            .replace(/<!--CANONICAL_URL-->/g, `${base}/zakupka/${order.id}`)
            .replace(/<!--ORDER_CRUMB-->/g, htmlEscape(order.category || 'Заявка'))
            .replace(/<!--ORDER_STATUS-->/g, isOpen
                ? '<span class="zo-status zo-status-open">Приём предложений открыт</span>'
                : `<span class="zo-status zo-status-closed">${htmlEscape(order.status || 'Заявка закрыта')}</span>`)
            .replace(/<!--ORDER_TITLE-->/g, htmlEscape(title))
            .replace(/<!--ORDER_FACTS-->/g, facts)
            .replace(/<!--ORDER_DESCRIPTION-->/g, descHtml)
            .replace(/<!--ORDER_FILES-->/g, filesHtml)
            .replace(/<!--ORDER_CTA_HREF-->/g, isOpen ? '/zavod' : '/zakupki')
            .replace(/<!--ORDER_CTA_LABEL-->/g, isOpen ? 'Откликнуться на заявку' : 'Смотреть открытые закупки')
            .replace(/<!--ORDER_CTA_NOTE-->/g, isOpen
                ? 'Регистрация по ИНН, данные подтянутся из реестра'
                : 'Эта заявка уже не принимает предложения');

        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(html);
    } catch (e) { next(e); }
});

app.get('/zakupki/region/:slug', async (req, res, next) => {
    try {
        const region = regionBySlug(req.params.slug);
        if (!region) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }
        const { producers, stats } = await loadRegionData(region);
        const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
        const label = regionLabel(region);

        const lead = `В каталоге ${stats.total} ${regionPlural(stats.total, 'предприятие', 'предприятия', 'предприятий')} ${region.where}: производства из реестра Минпромторга и компании, которые сами завели профиль на площадке. Закупка размещается по чертежу или техническому заданию — заводы отвечают напрямую, без посредников и тендерных процедур.`;

        const statsHtml = [
            `<div class="zr-stat"><b>${stats.total}</b><span>${regionPlural(stats.total, 'предприятие', 'предприятия', 'предприятий')} в каталоге</span></div>`,
            stats.claimed ? `<div class="zr-stat"><b>${stats.claimed}</b><span>с заполненным профилем</span></div>` : '',
            stats.verified ? `<div class="zr-stat"><b>${stats.verified}</b><span>проверено платформой</span></div>` : '',
        ].filter(Boolean).join('\n      ');

        const others = REGIONS.filter(r => r.slug !== region.slug).slice(0, 16)
            .map(r => `<li><a href="/zakupki/region/${r.slug}">${regionEsc(regionLabel(r))}</a></li>`)
            .join('\n      ');

        let html = fs.readFileSync(path.join(__dirname, 'zakupki', 'region.html'), 'utf8');
        html = html
            .replace(/<!--META_TITLE-->/g, htmlEscape(buildRegionTitle(region, stats.total)))
            .replace(/<!--META_DESC-->/g, htmlEscape(buildRegionDescription(region, stats)))
            .replace(/<!--META_ROBOTS-->/g, buildRegionRobots(stats.total))
            .replace(/<!--CANONICAL_URL-->/g, `${base}/zakupki/region/${region.slug}`)
            .replace(/<!--JSON_LD-->/g, buildRegionJsonLd(region, stats, base))
            .replace(/<!--REGION_LABEL-->/g, htmlEscape(label))
            .replace(/<!--REGION_WHERE-->/g, htmlEscape(region.where))
            .replace(/<!--REGION_LEAD-->/g, htmlEscape(lead))
            .replace(/<!--REGION_STATS-->/g, statsHtml)
            .replace(/<!--REGION_BODY-->/g, buildRegionSsr(region, producers, stats))
            .replace(/<!--REGION_LINKS-->/g, others);

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.type('html').send(html);
    } catch (e) { next(e); }
});

// ── Каталог оборудования и операций ─────────────────────────────────────────
// Карточек станков в базе нет (0 заполненных equipment на 4535 профилей), поэтому
// каталог строится по тому, что предприятие само написало о производстве. Тексты
// страниц это проговаривают — «заявляют операцию», а не «столько станков».
let _equipCache = { ts: 0, producers: null };
const EQUIP_TTL_MS = 3600 * 1000;

async function loadEquipmentProducers() {
    if (_equipCache.producers && Date.now() - _equipCache.ts < EQUIP_TTL_MS) return _equipCache.producers;
    const { rows } = await pool.query(
        `SELECT id, company, city, specialization, products, about, equipment, capabilities,
                verified_by_platform, claimed
           FROM companies
          WHERE role = 'producer' AND status <> 'Отклонено'
          ORDER BY verified_by_platform DESC, claimed DESC, company ASC`
    );
    const producers = rows.map(rowToCompany);
    _equipCache = { ts: Date.now(), producers };
    return producers;
}

function operationNav(activeSlug) {
    return OPERATIONS.map(o =>
        `<a href="/oborudovanie/${o.slug}" class="zc-cat-link${o.slug === activeSlug ? ' active' : ''}">${regionEsc(o.name)}</a>`
    ).join('\n      ');
}

function regionLinksHtml(limit = 16) {
    return REGIONS.slice(0, limit)
        .map(r => `<li><a href="/zakupki/region/${r.slug}">${regionEsc(regionLabel(r))}</a></li>`)
        .join('\n      ');
}

app.get('/oborudovanie', async (req, res, next) => {
    try {
        const producers = await loadEquipmentProducers();
        const counts = OPERATIONS.map(op => [op, producers.filter(p => producerHasOperation(p, op)).length]);
        const withOps = producers.filter(p => OPERATIONS.some(op => producerHasOperation(p, op))).length;
        const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');

        const opsHtml = counts.map(([op, n]) =>
            `      <li class="zr-op${n ? '' : ' zr-op--empty'}">
        <a href="/oborudovanie/${op.slug}">${regionEsc(op.name)}</a>
        <div class="zr-op-count">${n} ${regionPlural(n, 'предприятие', 'предприятия', 'предприятий')}</div>
        <p class="zr-op-lead">${regionEsc(op.lead)}</p>
      </li>`).join('\n');

        const statsHtml = [
            `<div class="zr-stat"><b>${producers.length}</b><span>${regionPlural(producers.length, 'предприятие', 'предприятия', 'предприятий')} в каталоге</span></div>`,
            `<div class="zr-stat"><b>${withOps}</b><span>указали технологические операции</span></div>`,
            `<div class="zr-stat"><b>${OPERATIONS.length}</b><span>операций в разборе</span></div>`,
        ].join('\n      ');

        const title = 'Оборудование и операции: кто что выполняет — ТехЗаказ';
        const desc = `Токарные и фрезерные работы, ЧПУ, сварка, гибка, литьё, термообработка и покрытия: ${withOps} предприятий каталога с указанными операциями.`;

        let html = fs.readFileSync(path.join(__dirname, 'zakupki', 'oborudovanie-index.html'), 'utf8');
        html = html
            .replace(/<!--META_TITLE-->/g, htmlEscape(title))
            .replace(/<!--META_DESC-->/g, htmlEscape(desc.slice(0, 160)))
            .replace(/<!--META_ROBOTS-->/g, 'index, follow')
            .replace(/<!--CANONICAL_URL-->/g, `${base}/oborudovanie`)
            .replace(/<!--JSON_LD-->/g, JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'CollectionPage',
                name: 'Оборудование и технологические операции',
                url: `${base}/oborudovanie`,
                mainEntity: { '@type': 'ItemList', numberOfItems: OPERATIONS.length },
            }))
            .replace(/<!--EQUIP_STATS-->/g, statsHtml)
            .replace(/<!--EQUIP_OPS-->/g, opsHtml)
            .replace(/<!--EQUIP_REGIONS-->/g, regionLinksHtml());

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.type('html').send(html);
    } catch (e) { next(e); }
});

app.get('/oborudovanie/:slug', async (req, res, next) => {
    try {
        const op = operationBySlug(req.params.slug);
        if (!op) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }
        const producers = (await loadEquipmentProducers()).filter(p => producerHasOperation(p, op));
        const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
        // Считаем все регионы выдачи, а не первые несколько: плашка «6 регионов»
        // при тридцати в списке — враньё цифрой, ровно то, что мы вычищаем.
        const regionsOfOp = new Set(producers.map(p => (p.city || '').trim()).filter(Boolean));

        const statsHtml = [
            `<div class="zr-stat"><b>${producers.length}</b><span>${regionPlural(producers.length, 'предприятие', 'предприятия', 'предприятий')} заявили операцию</span></div>`,
            regionsOfOp.size ? `<div class="zr-stat"><b>${regionsOfOp.size}</b><span>${regionPlural(regionsOfOp.size, 'регион', 'региона', 'регионов')} в выдаче</span></div>` : '',
        ].filter(Boolean).join('\n      ');

        let html = fs.readFileSync(path.join(__dirname, 'zakupki', 'oborudovanie-operation.html'), 'utf8');
        html = html
            .replace(/<!--META_TITLE-->/g, htmlEscape(buildOperationTitle(op, producers.length)))
            .replace(/<!--META_DESC-->/g, htmlEscape(buildOperationDescription(op, producers.length)))
            .replace(/<!--META_ROBOTS-->/g, buildOperationRobots(producers.length))
            .replace(/<!--CANONICAL_URL-->/g, `${base}/oborudovanie/${op.slug}`)
            .replace(/<!--JSON_LD-->/g, buildOperationJsonLd(op, producers.length, base))
            .replace(/<!--OP_NAME-->/g, htmlEscape(op.name))
            .replace(/<!--OP_LEAD-->/g, htmlEscape(op.lead))
            .replace(/<!--OP_STATS-->/g, statsHtml)
            .replace(/<!--OP_NAV-->/g, operationNav(op.slug))
            .replace(/<!--OP_BODY-->/g, buildOperationSsr(op, producers.slice(0, 60)))
            .replace(/<!--OP_REGIONS-->/g, regionLinksHtml());

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.type('html').send(html);
    } catch (e) { next(e); }
});

app.get('/favicon.ico', (req, res) => {
    res.redirect(301, '/favicon.svg');
});
app.get('/favicon.svg', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, 'favicon.svg'));
});
// Подтверждение прав в панелях вебмастеров (Яндекс, Google Search Console).
// Файлы отдаются как есть — содержимое и имя менять нельзя, иначе права слетят.
[
    'yandex_3fbc490e3bd5d37d.html',
    'googleefff6b0475352b2b.html',
].forEach(file => {
    app.get('/' + file, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(__dirname, file));
    });
});
/* Картинка лежит в assets: корневые png не попадают в репозиторий (.gitignore),
   из-за чего адрес отдавал 500 и ВК не собирал карточку по ссылке. Маршрут
   оставлен для старых ссылок и ведёт на файл из assets. */
app.get('/landing-hero.png', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, 'assets', 'og-cover.png'));
});
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(
        'User-agent: *\n' +
        'Allow: /\n' +
        'Allow: /zakupki\n' +
        'Allow: /zakupki/region/\n' +
        'Allow: /oborudovanie\n' +
        'Allow: /map\n' +
        'Allow: /dlya-postavshchikov\n' +
        'Allow: /dostavka\n' +
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
            { url: '/dostavka',            priority: '0.7', changefreq: 'monthly' },
            { url: '/map',                 priority: '0.7', changefreq: 'weekly' },
            { url: '/privacy',             priority: '0.3', changefreq: 'yearly' },
            { url: '/terms',               priority: '0.3', changefreq: 'yearly' },
        ];
        // Регионы: страница отдаёт noindex, пока предприятий меньше MIN_INDEXABLE,
        // поэтому в карту идут только те, где каталог реально что-то показывает.
        const { rows: regionRows } = await pool.query(
            `SELECT city, COUNT(*)::int AS n FROM companies
              WHERE role = 'producer' AND status <> 'Отклонено' AND city = ANY($1)
              GROUP BY city`,
            [REGIONS.map(r => r.name)]
        );
        const regionCounts = new Map(regionRows.map(r => [r.city, r.n]));
        for (const r of REGIONS) {
            if ((regionCounts.get(r.name) || 0) < MIN_INDEXABLE) continue;
            pages.push({ url: `/zakupki/region/${r.slug}`, priority: '0.7', changefreq: 'weekly' });
        }
        // Операции: та же логика — в карту идут только непустые страницы.
        pages.push({ url: '/oborudovanie', priority: '0.8', changefreq: 'weekly' });
        const equipProducers = await loadEquipmentProducers();
        for (const op of OPERATIONS) {
            const n = equipProducers.filter(p => producerHasOperation(p, op)).length;
            if (n < OP_MIN_INDEXABLE) continue;
            pages.push({ url: `/oborudovanie/${op.slug}`, priority: '0.6', changefreq: 'weekly' });
        }
        // Все производители: верифицированные приоритетнее, заглушки реестра тоже
        // индексируем (4286 страниц «завод + продукция + город» — органический канал).
        // Карточки без единого факта, кроме названия, исключаем: сама страница отдаёт
        // им noindex (lib/producer-seo), звать на них робота картой сайта — противоречие.
        const { rows: suppliers } = await pool.query(`
            SELECT id, verified_by_platform, claimed FROM companies
            WHERE role = 'producer' AND status <> 'Отклонено'
              AND (COALESCE(products, '') <> '' OR COALESCE(specialization, '') <> '' OR COALESCE(about, '') <> '')
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
            // inn нужен серверной разметке: по нему строится ссылка «присоединить профиль»
            "SELECT company, inn, specialization, city, about, products, claimed, source, verified_by_platform FROM companies WHERE id = $1 AND role = 'producer'",
            [id]
        );
        if (!row) {
            res.status(404);
            return res.sendFile(path.join(__dirname, '404.html'));
        }
        const filePath = path.join(__dirname, 'supplier-public.html');
        let html = fs.readFileSync(filePath, 'utf8');
        // Заголовок и описание собираются в lib/producer-seo: прежние доходили до 180
        // знаков и обрезались в выдаче, а профиль робот видел как «Загрузка профиля…».
        const title = buildProducerTitle(row);
        const desc = buildProducerDescription(row);
        const base = (process.env.APP_URL || 'https://texzakaz.ru').replace(/\/$/, '');
        const ssr = buildProducerSsr(row, { categories: categorizeProducer(row) });
        html = html
            .replace(/<!--META_TITLE-->/g, htmlEscape(title))
            .replace(/<!--META_DESC-->/g, htmlEscape(desc))
            .replace(/<!--CANONICAL_URL-->/g, `${base}/p/${id}`)
            .replace(/<!--META_ROBOTS-->/g, buildProducerRobots(row))
            .replace(/<!--SSR_PROFILE-->/g, ssr)
            .replace(/<!--COMPANY_ID-->/g, String(id));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(html);
    } catch (e) { next(e); }
});

// Хеш коммита читается один раз при старте — чтобы по /api/health было видно,
// какой код реально задеплоен (урок инцидента с молча-красным CI 04.07.2026)
let GIT_COMMIT = '';
try {
    GIT_COMMIT = require('child_process')
        .execSync('git rev-parse --short HEAD', { cwd: __dirname, timeout: 3000 })
        .toString().trim();
} catch { /* не git-окружение — оставляем пустым */ }

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            ok: true,
            db: true,
            storage: storage.isRemote() ? 's3' : 'local',
            uptime: process.uptime(),
            env: process.env.NODE_ENV || 'development',
            commit: GIT_COMMIT,
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
        let payload = null;
        if (token) {
            try { payload = jwt.verify(token, JWT_SECRET); } catch { payload = null; }
        }
        /* Access-кука живёт час и по истечении просто исчезает из браузера.
           Для fetch это ничего не значит — apiFetch поймает 401 и обновит
           токен. Для прямой ссылки на файл ловить некому, поэтому продлеваем
           сессию здесь: см. lib/session-renew.js. */
        if (!payload) {
            const renewed = await renewAccessToken({ pool, req, res });
            if (renewed) { req.user = renewed; return next(); }
            return sendHttpError(req, res, 401,
                token ? 'Неверный или истёкший токен' : 'Требуется авторизация');
        }
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
        if (!user) return sendHttpError(req, res, 401, 'Пользователь не найден');
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
        if (req.user.role !== role) {
            return sendHttpError(req, res, 403, 'Недостаточно прав для этого действия');
        }
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

/* Доступ заводу открывают два события: поданное КП и запрос чертежа.
   Второе появилось потому, что первого было мало: КП требует цену, а цену без
   чертежа не назвать. Запрос — шаг без обязательств, но именной: он лежит в
   order_drawing_requests, и заказчик видит, кто открывал его чертёж. */
async function canAccessOrderDrawing(user, orderId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const order = await getOrderAccessRow(orderId);
    if (!order) return false;
    if (user.role === 'customer') return order.company === user.company;
    if (user.role === 'producer') {
        const { rows: [granted] } = await pool.query(
            `SELECT 1 FROM proposals WHERE order_id = $1 AND company = $2
              UNION ALL
             SELECT 1 FROM order_drawing_requests WHERE order_id = $1 AND company = $2
             LIMIT 1`,
            [Number(orderId), user.company]
        );
        return Boolean(granted);
    }
    return false;
}

const { enrichCompany, enrichCompanies } = createCompanyEnricher({ pool, storage });

const { createRegistryInviter } = require('./lib/registry-invites');
const registryInviter = createRegistryInviter({ pool, sendEmail, appUrl: APP_URL, jwtSecret: JWT_SECRET });

const { createVkPoster } = require('./lib/vk-poster');
const vkPoster = createVkPoster({ pool, appUrl: APP_URL });

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
            "UPDATE companies SET invite_optout = true WHERE inn = $1 AND claimed = false AND source <> ''",
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
    // для догоняющей рассылки по закупкам, придержанным до подтверждения email
    rowToOrder,
    matchedProducers,
    notifyCompanyEmail,
    registryInviter,
    plainTitle,
    htmlEscape,
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
    handleDrawingImageUpload,
    handleKPUpload,
    handlePhotoUpload,
    persistUpload,
    persistUploads,
    handleVideoUpload,
    persistVideo,
    maxVideoBytes: MAX_VIDEO_BYTES,
    deleteDrawingFile,
    parseOrderAttachments,
    maxOrderAttachments: MAX_ORDER_ATTACHMENTS,
    canAccessOrderDrawing,
    vkPoster,
    canAccessProposal,
    canAccessOrderThread,
    getOrderAccessRow,
    rowToOrder,
    rowToProposal,
    rowToCompany,
    rowToMessage,
    rowToNotification,
    enrichCompany,
    enrichCompanies,
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
app.use('/api/logistics', createLogisticsRouter(routesDeps));
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
    // Ответ уже начали писать (упал стрим файла на середине) — добавить к нему
    // нечего, любая попытка кончится ERR_HTTP_HEADERS_SENT поверх настоящей ошибки.
    if (res.headersSent) return next(err);
    sendHttpError(req, res, 500, 'Внутренняя ошибка сервера');
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
        // Протухший кэш расчётов доставки: TTL проверяется при чтении, но сами
        // строки без уборки лежат вечно. Ошибка здесь не должна ронять крон —
        // это уборка, а не работа.
        try {
            const removed = await purgeExpiredQuotes(pool);
            if (removed) console.log(`[logistics] удалено протухших расчётов: ${removed}`);
        } catch (e) {
            console.error('[logistics] не удалось почистить кэш расчётов:', e.message);
        }
        // Мёртвые токены: истёкшие строки ничего не открывают, но лежат вечно.
        const { removed, failed } = await purgeExpiredTokens(pool);
        for (const [table, n] of Object.entries(removed)) {
            console.log(`[purge] ${table}: удалено протухших строк ${n}`);
        }
        for (const [table, message] of Object.entries(failed)) {
            console.error(`[purge] ${table}: уборка не удалась — ${message}`);
        }
    });
}

/*
 * Недельная проверка перевозчиков. Скрипт npm run check:logistics делает то же
 * самое руками, но руками про него однажды забудут — а он сделан ровно против
 * поломки, которая происходит молча и на нашей стороне никак не проявляется.
 *
 * Раз в неделю, а не ежедневно: ловим не колебания тарифа, а изменение формата
 * ответа. И только на проде — локальный сервер не должен ходить к перевозчикам
 * при каждом запуске.
 *
 * Тревога уходит и в Sentry, и письмом на OPS_EMAIL — оба канала
 * необязательные, и на сервере может не быть ни одного. Поэтому шлём во все
 * настроенные сразу: тревога, которую никто не получил, бесполезнее, чем её
 * отсутствие, потому что создаёт ложное ощущение присмотра.
 */
function startLogisticsCheckCron() {
    if (process.env.NODE_ENV !== 'production') return;
    // Понедельник, 06:00 по Москве (03:00 UTC)
    cron.schedule('0 3 * * 1', async () => {
        try {
            const { results, broken } = await checkAllCarriers();
            for (const result of results) {
                if (!result.ok) console.error(`[logistics] ${result.carrierName}: ${result.problems.join('; ')}`);
            }
            if (!broken.length) {
                console.log('[logistics] проверка перевозчиков: все отвечают');
                return;
            }

            const alert = formatCarrierAlert(results, broken);
            if (process.env.SENTRY_DSN) Sentry.captureMessage(`${alert.subject}\n${alert.text}`, 'error');
            if (process.env.OPS_EMAIL) {
                await sendEmail(
                    process.env.OPS_EMAIL,
                    alert.subject,
                    `<pre style="font-family:sans-serif;font-size:14px;white-space:pre-wrap;">${htmlEscape(alert.text)}</pre>`
                ).catch(e => console.error('[logistics] письмо о поломке не ушло:', e.message));
            }
            if (!process.env.SENTRY_DSN && !process.env.OPS_EMAIL) {
                console.error('[logistics] некуда отправить тревогу: не заданы ни SENTRY_DSN, ни OPS_EMAIL');
            }
        } catch (e) {
            console.error('[logistics] проверка перевозчиков не выполнилась:', e.message);
        }
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
    startLogisticsCheckCron();
    startTelegramBot();
    vkPoster.start();
    return httpServer;
}

if (require.main === module) {
    start().catch(err => {
        console.error('Ошибка инициализации БД:', err);
        process.exit(1);
    });
}

module.exports = { app, httpServer, start, pool };
