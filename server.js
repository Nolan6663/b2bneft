'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const rateLimit = require('express-rate-limit');
const { pool, initDb } = require('./db');
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
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const APP_URL = process.env.APP_URL || 'https://b2bneft.onrender.com';
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
    if (!resend) { console.log(`[Email] To: ${to} | ${subject}`); return; }
    try {
        await resend.emails.send({ from: `B2B Нефтесервис <${EMAIL_FROM}>`, to, subject, html });
    } catch (e) {
        console.error('Email error:', e.message);
    }
}

if (IS_PRODUCTION && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-development';

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
    io.on('connection', (socket) => {
        socket.on('join-company', (company) => { if (company) socket.join(company); });
        socket.on('join-chat', ({ orderId, company }) => {
            if (orderId != null && company) socket.join(`chat:${orderId}:${company}`);
        });
    });
}

// ===================== ЗАГРУЗКА ФАЙЛОВ =====================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
const PHOTOS_DIR = path.join(UPLOADS_DIR, 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR);

const ALLOWED_DRAWING_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.dxf', '.dwg', '.step', '.stp'];
const KP_ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];
const PHOTO_ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const BLOCKED_MIME = new Set([
    'text/html', 'text/javascript', 'application/javascript',
    'application/x-php', 'text/x-php', 'application/x-httpd-php',
    'application/x-sh', 'text/x-python',
]);

const drawingStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});
const kpStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'kp-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});
const uploadDrawing = multer({
    storage: drawingStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_DRAWING_EXT.includes(ext)) return cb(new Error('Недопустимый тип файла. Разрешены: ' + ALLOWED_DRAWING_EXT.join(', ')));
        if (BLOCKED_MIME.has(file.mimetype)) return cb(new Error('Недопустимый MIME-тип файла'));
        cb(null, true);
    }
}).single('drawing');
const uploadKP = multer({
    storage: kpStorage,
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

const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTOS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'photo-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});
const uploadPhoto = multer({
    storage: photoStorage,
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
    fs.unlink(path.join(UPLOADS_DIR, drawing.storedName), () => {});
}

// ===================== СТАТИКА =====================
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/uploads/:filename', requireAuth, (req, res) => {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Файл не найден' });
    res.sendFile(filepath);
});
app.use('/company-photos', express.static(PHOTOS_DIR));
const PUBLIC_PAGES = [
    'landing.html', 'login.html', 'index.html', 'producer.html', 'proposals.html', 'partners.html',
    'analytics.html', 'company-profile.html', 'messages.html', 'favorites.html',
    'settings.html', 'admin.html', 'deals.html', 'tariff.html', '404.html', 'catalog.html', 'map.html', 'delivery.html', 'deliveries.html',
];
PUBLIC_PAGES.forEach(page => app.get('/' + page, (req, res) => res.sendFile(path.join(__dirname, page))));
app.get('/', (req, res) => res.redirect('/landing.html'));
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            ok: true,
            db: true,
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

// ===================== ГЕОКОДИРОВАНИЕ =====================

async function geocodeCity(city) {
    if (!city || !city.trim()) return null;
    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city.trim() + ', Россия')}&format=json&limit=1&countrycodes=ru`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'B2BNeft/1.0 (b2bneft)' },
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

async function matchedProducers(order, minScore = 0) {
    const { rows } = await pool.query("SELECT * FROM companies WHERE role = 'producer'");
    return rows.map(rowToCompany)
        .map(c => ({ company: c.company, score: computeMatchScore(order, c) }))
        .filter(m => m.score >= minScore)
        .sort((a, b) => b.score - a.score);
}

// ===================== AUTH MIDDLEWARE =====================

async function requireAuth(req, res, next) {
    try {
        const match = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
        if (!match) return res.status(401).json({ error: 'Требуется авторизация' });
        let payload;
        try { payload = jwt.verify(match[1], JWT_SECRET); }
        catch { return res.status(401).json({ error: 'Неверный или истёкший токен' }); }
        const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
        req.user = user;
        next();
    } catch (e) { next(e); }
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
        next();
    };
}

async function optionalAuth(req, res, next) {
    try {
        const match = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
        if (match) {
            try {
                const payload = jwt.verify(match[1], JWT_SECRET);
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
    enriched.photos = photos;
    return enriched;
}

// ===================== ORDERS =====================

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
        const { rows: [row] } = await pool.query('SELECT drawing FROM orders WHERE id = $1', [Number(req.params.orderId)]);
        if (!row || !row.drawing) return res.status(404).json({ error: 'Файл не найден' });
        const drawing = JSON.parse(row.drawing);
        const filePath = path.join(UPLOADS_DIR, drawing.storedName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл был удалён с сервера' });
        res.download(filePath, drawing.originalName);
    } catch (e) { next(e); }
});

app.post('/api/orders', requireAuth, requireRole('customer'), handleDrawingUpload, async (req, res, next) => {
    try {
        const { title, category, deadline, quantity, description } = req.body;
        if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

        const drawing = req.file ? JSON.stringify({ originalName: req.file.originalname, storedName: req.file.filename }) : null;
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
            drawingJson = JSON.stringify({ originalName: req.file.originalname, storedName: req.file.filename });
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
        const filePath = path.join(UPLOADS_DIR, kpFile.storedName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл был удалён с сервера' });
        res.download(filePath, kpFile.originalName);
    } catch (e) { next(e); }
});

app.post('/api/proposals', requireAuth, requireRole('producer'), handleKPUpload, async (req, res, next) => {
    try {
        const { orderId, orderTitle, price, days } = req.body;
        if (!orderId || !price || !days) return res.status(400).json({ error: 'Не указаны ID заявки, цена или сроки' });

        const { rows: [orderRow] } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(orderId)]);
        if (!orderRow) return res.status(404).json({ error: 'Заявка с таким ID не найдена' });

        const { rows: [existing] } = await pool.query('SELECT id FROM proposals WHERE order_id = $1 AND company = $2', [Number(orderId), req.user.company]);
        if (existing) return res.status(409).json({ error: 'Вы уже подали КП на эту закупку. Отредактируйте существующее предложение.' });

        const kpFile = req.file ? JSON.stringify({ originalName: req.file.originalname, storedName: req.file.filename }) : null;

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
        const order = await getOrderAccessRow(orderId);
        if (!order) return res.status(404).json({ error: 'Закупка не найдена' });
        let rows;
        if (req.user.role === 'admin' || order.company === req.user.company) {
            ({ rows } = await pool.query('SELECT * FROM proposals WHERE order_id = $1', [orderId]));
        } else if (req.user.role === 'producer') {
            ({ rows } = await pool.query(
                'SELECT * FROM proposals WHERE order_id = $1 AND company = $2',
                [orderId, req.user.company]
            ));
        } else {
            return res.status(403).json({ error: 'Нет доступа к предложениям этой закупки' });
        }
        res.json(rows.map(rowToProposal));
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
        if (orderRow.status === 'Закрыта') return res.status(400).json({ error: 'Этот тендер уже завершен' });

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
        res.json({ message: 'Победитель успешно определен, тендер закрыт' });
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

        const { rows: [photo] } = await pool.query(
            'INSERT INTO company_photos (company_id, stored_name, original_name) VALUES ($1, $2, $3) RETURNING *',
            [id, req.file.filename, req.file.originalname]
        );
        res.status(201).json({ id: photo.id, storedName: photo.stored_name, originalName: photo.original_name });
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
        fs.unlink(path.join(PHOTOS_DIR, photo.stored_name), () => {});
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

        const prompt = `Ты — ассистент B2B маркетплейса нефтесервисного оборудования России.
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
            { rows: [{ avg: avgDays }] },
            { rows: savingsRows },
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND created_at >= date_trunc('month', NOW())", [company]),
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND status = 'Активный'", [company]),
            pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND status = 'Закрыта'", [company]),
            pool.query(`SELECT ROUND(AVG(p.days)) AS avg
                FROM proposals p JOIN orders o ON o.id = p.order_id
                WHERE o.company = $1 AND p.status = 'Выигран'`, [company]),
            pool.query(`SELECT
                    (SELECT price FROM proposals WHERE order_id = o.id AND status = 'Выигран' LIMIT 1) AS win_price,
                    (SELECT AVG(price) FROM proposals WHERE order_id = o.id) AS avg_price
                FROM orders o WHERE o.company = $1 AND o.status = 'Закрыта'`, [company]),
        ]);
        const validRows = savingsRows.filter(r => r.win_price && r.avg_price && r.avg_price > 0);
        const savings = validRows.length > 0
            ? Math.round(validRows.reduce((s, r) => s + (1 - r.win_price / r.avg_price), 0) / validRows.length * 100)
            : null;
        res.json({
            monthOrders, activeOrders, closedOrders,
            avgDays: avgDays ? Math.round(avgDays) : null,
            savings,
        });
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

        const newUser = await withTransaction(async (client) => {
            const { rows: [u] } = await client.query(
                'INSERT INTO users (email,password,role,company,inn) VALUES ($1,$2,$3,$4,$5) RETURNING *',
                [email, hashPassword(password), role, company, inn || '']
            );
            const { rows: [compExists] } = await client.query('SELECT 1 FROM companies WHERE company = $1 AND role = $2', [company, role]);
            if (!compExists) {
                await client.query(
                    "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,$2,$3,$4,$5)",
                    [company, inn || '', role, '', 'На проверке']
                );
            }
            return u;
        });

        const { accessToken, refreshToken } = generateTokens(newUser);
        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
            [newUser.id, refreshToken]
        );
        res.status(201).json({ token: accessToken, refreshToken, role, company });
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

        const { accessToken, refreshToken } = generateTokens(user);
        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
            [user.id, refreshToken]
        );
        res.json({ token: accessToken, refreshToken, role: user.role, company: user.company });
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
            await sendEmail(user.email, 'Восстановление пароля — B2B Нефтесервис', `
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
        const { refreshToken } = req.body;
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
        res.json({ token: accessToken });
    } catch (e) { next(e); }
});

app.post('/api/auth/logout', async (req, res, next) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
        }
        res.json({ message: 'Выход выполнен' });
    } catch (e) { next(e); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ email: req.user.email, role: req.user.role, company: req.user.company });
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

        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [newEmail, req.user.id]);
        res.json({ message: 'Email успешно изменён' });
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
            if (email) await sendEmail(email, 'Верификация пройдена — B2B Нефтесервис',
                `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                  <h3 style="color:#41bd97">Компания верифицирована!</h3>
                  <p>Ваша компания <strong>${companyRow.company}</strong> успешно прошла верификацию на платформе B2B Нефтесервис.</p>
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
            if (email) await sendEmail(email, 'Заявка на верификацию отклонена — B2B Нефтесервис',
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

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ===================== ЗАПУСК =====================

async function start() {
    await initDb();
    httpServer.listen(PORT, () => {
        console.log(`Сервер запущен на порту ${PORT}`);
    });
    if (process.env.GEOCODE_ON_START !== 'false') {
        setTimeout(geocodeExisting, 5000);
    }
    return httpServer;
}

if (require.main === module) {
    start().catch(err => {
        console.error('Ошибка инициализации БД:', err);
        process.exit(1);
    });
}

module.exports = { app, httpServer, start, pool };
