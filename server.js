'use strict';
require('dotenv').config();
const express = require('express');
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

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const APP_URL = process.env.APP_URL || 'https://b2bneft.onrender.com';

async function sendEmail(to, subject, html) {
    if (!resend) { console.log(`[Email] To: ${to} | ${subject}`); return; }
    try {
        await resend.emails.send({ from: `B2B Нефтесервис <${EMAIL_FROM}>`, to, subject, html });
    } catch (e) {
        console.error('Email error:', e.message);
    }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

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
app.use(cors());
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
const io = Server ? new Server(httpServer, { cors: { origin: '*' } }) : null;

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
        cb(null, true);
    }
}).single('drawing');
const uploadKP = multer({
    storage: kpStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!KP_ALLOWED_EXT.includes(ext)) return cb(new Error('Недопустимый тип файла. Разрешены: ' + KP_ALLOWED_EXT.join(', ')));
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
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/company-photos', express.static(PHOTOS_DIR));
const PUBLIC_PAGES = [
    'landing.html', 'login.html', 'index.html', 'producer.html', 'proposals.html', 'partners.html',
    'analytics.html', 'company-profile.html', 'messages.html', 'favorites.html',
    'settings.html', 'admin.html', 'deals.html', 'tariff.html', '404.html',
];
PUBLIC_PAGES.forEach(page => app.get('/' + page, (req, res) => res.sendFile(path.join(__dirname, page))));
app.get('/', (req, res) => res.redirect('/landing.html'));

// ===================== УМНЫЙ МАТЧИНГ =====================
const CATEGORY_KEYWORDS = {
    'РТИ': ['рти', 'резин', 'уплотн', 'манжет', 'вулканиз'],
    'Металл': ['металл', 'прокат', 'сварк', 'металлоконструкц', 'лазерн', 'гибочн', 'чпу', 'литье', 'нефтепромысл'],
    'Трубопроводная арматура': ['арматур', 'задвиж', 'клапан', 'кран', 'вентил', 'фланц', 'фитинг', 'трубопров'],
    'Электрооборудование': ['электр', 'кабел', 'двигател', 'трансформ', 'автомат', 'щит', 'пускател'],
    'Прочее': []
};

function stem(word) { return word.slice(0, 5); }

function plainTitle(title) {
    return title && title.includes(' | ') ? title.split(' | ')[0] : title;
}

function computeMatchScore(order, producer) {
    const text = `${producer.specialization || ''} ${(producer.equipment || []).join(' ')}`.toLowerCase();
    if (!text.trim()) return 0;
    let score = 0;
    const keywords = CATEGORY_KEYWORDS[order.category] || [];
    score += Math.min(keywords.filter(k => text.includes(k)).length, 3) * 20;
    const titleWords = plainTitle(order.title || '').toLowerCase().split(/[^a-zа-яё0-9]+/).filter(w => w.length > 3);
    score += Math.min(titleWords.filter(w => text.includes(stem(w))).length, 2) * 15;
    // Бонус за свободные мощности: есть ресурсы — выше в рекомендациях
    const cap = producer.freeCapacity || [];
    if (cap.length > 0) {
        const avgFree = cap.reduce((s, c) => s + (c.percent || 0), 0) / cap.length;
        if (avgFree >= 30) score += 10;
    }
    return Math.min(100, score);
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

app.get('/api/orders', async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
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

app.get('/api/orders/:orderId/drawing', async (req, res, next) => {
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

app.get('/api/proposals/:proposalId/file', async (req, res, next) => {
    try {
        const { rows: [row] } = await pool.query('SELECT kp_file FROM proposals WHERE id = $1', [Number(req.params.proposalId)]);
        if (!row || !row.kp_file) return res.status(404).json({ error: 'Файл не найден' });
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
                  <p>Компания <strong>${req.user.company}</strong> подала коммерческое предложение по закупке <strong>«${title}»</strong>.</p>
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

app.get('/api/order-proposals/:orderId', async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM proposals WHERE order_id = $1', [Number(req.params.orderId)]);
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
                    ? `Поздравляем! Заказчик выбрал ваше предложение по закупке <strong>«${title}»</strong>.`
                    : `К сожалению, заказчик выбрал другого поставщика по закупке <strong>«${title}»</strong>.`
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
              <p>Заказчик отклонил ваше предложение по закупке <strong>«${rejectTitle}»</strong>.</p>
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

        if (city !== undefined)               f('city', str(city, 100));
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
        let rows;
        if (role === 'producer') {
            const { rows: r } = await pool.query(`
                SELECT m.order_id, o.title AS order_title, m.company,
                    MAX(m.created_at) AS last_at,
                    COUNT(CASE WHEN m.sender = 'customer' AND m.read = false THEN 1 END) AS unread_count
                FROM messages m JOIN orders o ON o.id = m.order_id
                WHERE m.company = $1
                GROUP BY m.order_id, o.title, m.company ORDER BY last_at DESC
            `, [company]);
            rows = r;
        } else {
            const { rows: r } = await pool.query(`
                SELECT m.order_id, o.title AS order_title, m.company,
                    MAX(m.created_at) AS last_at,
                    COUNT(CASE WHEN m.sender = 'producer' AND m.read = false THEN 1 END) AS unread_count
                FROM messages m JOIN orders o ON o.id = m.order_id
                WHERE o.company = $1
                GROUP BY m.order_id, o.title, m.company ORDER BY last_at DESC
            `, [company]);
            rows = r;
        }

        const result = await Promise.all(rows.map(async (r) => {
            const { rows: [last] } = await pool.query(
                'SELECT * FROM messages WHERE order_id = $1 AND company = $2 ORDER BY created_at DESC LIMIT 1',
                [r.order_id, r.company]
            );
            return {
                orderId: r.order_id,
                orderTitle: r.order_title || `Заявка #${r.order_id}`,
                company: r.company,
                lastMessage: last ? last.text : '',
                lastSender: last ? last.sender : '',
                lastAt: r.last_at,
                unreadCount: Number(r.unread_count) || 0,
            };
        }));
        res.json(result);
    } catch (e) { next(e); }
});

app.post('/api/messages/:orderId/:company/read', requireAuth, async (req, res, next) => {
    try {
        const orderId = Number(req.params.orderId);
        const company = req.params.company;
        const otherSender = req.user.role === 'producer' ? 'customer' : 'producer';
        await pool.query(
            'UPDATE messages SET read = true WHERE order_id = $1 AND company = $2 AND sender = $3 AND read = false',
            [orderId, company, otherSender]
        );
        res.json({ ok: true });
    } catch (e) { next(e); }
});

app.get('/api/messages/:orderId/:company', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM messages WHERE order_id = $1 AND company = $2 ORDER BY created_at ASC',
            [Number(req.params.orderId), req.params.company]
        );
        res.json(rows.map(rowToMessage));
    } catch (e) { next(e); }
});

app.post('/api/messages', requireAuth, async (req, res, next) => {
    try {
        const { orderId, company, text } = req.body;
        if (!orderId || !company || !text) return res.status(400).json({ error: 'Заполните все поля сообщения' });

        const { rows: [newRow] } = await pool.query(
            'INSERT INTO messages (order_id,company,sender,text) VALUES ($1,$2,$3,$4) RETURNING *',
            [Number(orderId), company, req.user.role, String(text).slice(0, 2000)]
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
        if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
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
                       c.id AS counterparty_profile_id
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
                       c.id AS counterparty_profile_id
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

initDb()
    .then(() => {
        httpServer.listen(PORT, () => {
            console.log(`Сервер запущен на порту ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Ошибка инициализации БД:', err);
        process.exit(1);
    });
