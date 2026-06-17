'use strict';
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');

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
// Преобразуют строки SQLite (snake_case, JSON-строки) в объекты для клиента.

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
        verifiedByPlatform: r.verified_by_platform === 1
    };
}

function rowToMessage(r) {
    if (!r) return null;
    return {
        id: r.id, orderId: r.order_id, company: r.company,
        sender: r.sender, text: r.text, createdAt: r.created_at,
        read: r.read === 1,
    };
}

function rowToNotification(r) {
    if (!r) return null;
    return {
        id: r.id, company: r.company, text: r.text,
        read: r.read === 1, createdAt: r.created_at
    };
}

// ===================== APP =====================

const app = express();
const PORT = 5000;
app.use(cors());
app.use(express.json());

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
app.use('/company-photos', express.static(PHOTOS_DIR));
const PUBLIC_PAGES = [
    'login.html', 'index.html', 'producer.html', 'proposals.html', 'partners.html',
    'analytics.html', 'company-profile.html', 'messages.html', 'favorites.html',
    'settings.html', 'admin.html', 'deals.html', 'tariff.html', '404.html',
];
PUBLIC_PAGES.forEach(page => app.get('/' + page, (req, res) => res.sendFile(path.join(__dirname, page))));
app.get('/', (req, res) => res.redirect('/login.html'));

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
    return Math.min(100, score);
}

function matchedProducers(order, minScore = 0) {
    const companies = db.prepare("SELECT * FROM companies WHERE role = 'producer'").all().map(rowToCompany);
    return companies
        .map(c => ({ company: c.company, score: computeMatchScore(order, c) }))
        .filter(m => m.score >= minScore)
        .sort((a, b) => b.score - a.score);
}

// ===================== AUTH =====================

function requireAuth(req, res, next) {
    const match = (req.headers['authorization'] || '').match(/^Bearer\s+token-(\d+)$/);
    if (!match) return res.status(401).json({ error: 'Требуется авторизация' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(match[1]));
    if (!user) return res.status(401).json({ error: 'Неверный или истёкший токен' });
    req.user = user;
    next();
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
        next();
    };
}

function optionalAuth(req, res, next) {
    const match = (req.headers['authorization'] || '').match(/^Bearer\s+token-(\d+)$/);
    if (match) {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(match[1]));
        if (user) req.user = user;
    }
    next();
}

function addNotification(company, text) {
    if (!company) return;
    const result = db.prepare('INSERT INTO notifications (company, text) VALUES (?, ?)').run(company, text);
    if (io) {
        io.to(company).emit('notification', {
            id: Number(result.lastInsertRowid), company, text,
            read: false, createdAt: new Date().toISOString()
        });
    }
}

// ===================== COMPANIES: вычисляемые поля =====================

function computeProducerRating(companyName) {
    const resolved = db.prepare("SELECT status FROM proposals WHERE company = ? AND status IN ('Выигран', 'Отклонен')").all(companyName);
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

function computeCustomerStatus(companyName) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE company = ?').get(companyName).n;
    if (!total) return null;
    const closed = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE company = ? AND status = 'Закрыта'").get(companyName).n;
    return { status: closed > 0 ? 'Верифицирован' : 'На проверке' };
}

function computeProducerStats(companyName) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE company = ?').get(companyName).n;
    if (!total) return null;
    const won = db.prepare("SELECT days FROM proposals WHERE company = ? AND status = 'Выигран'").all(companyName);
    const avgDeliveryDays = won.length ? Math.round(won.reduce((s, p) => s + p.days, 0) / won.length) : null;
    return { completedOrders: won.length, avgDeliveryDays, totalProposals: total };
}

function computeCustomerStats(companyName) {
    const rows = db.prepare('SELECT status FROM orders WHERE company = ?').all(companyName);
    if (!rows.length) return null;
    return { postedOrders: rows.length, closedOrders: rows.filter(o => o.status === 'Закрыта').length };
}

function enrichCompany(c, ownerCompany) {
    let enriched;
    if (c.role === 'producer') {
        const rating = computeProducerRating(c.company);
        enriched = { ...c, ...(rating || {}), stats: computeProducerStats(c.company) };
    } else {
        const status = computeCustomerStatus(c.company);
        enriched = { ...c, ...(status || {}), stats: computeCustomerStats(c.company) };
    }
    if (ownerCompany) {
        enriched.isFavorite = !!db.prepare('SELECT 1 FROM favorites WHERE owner_company = ? AND company_id = ?').get(ownerCompany, c.id);
    } else {
        enriched.isFavorite = false;
    }
    enriched.photos = db.prepare('SELECT id, stored_name, original_name FROM company_photos WHERE company_id = ? ORDER BY created_at ASC').all(c.id);
    return enriched;
}

// ===================== ORDERS =====================

app.get('/api/orders', (req, res) => {
    res.json(db.prepare('SELECT * FROM orders').all().map(rowToOrder));
});

app.get('/api/orders/match-scores', requireAuth, requireRole('producer'), (req, res) => {
    const meRow = db.prepare("SELECT * FROM companies WHERE company = ? AND role = 'producer'").get(req.user.company);
    const me = meRow ? rowToCompany(meRow) : null;
    const scores = {};
    db.prepare('SELECT * FROM orders').all().map(rowToOrder).forEach(o => {
        scores[o.id] = me ? computeMatchScore(o, me) : 0;
    });
    res.json(scores);
});

app.get('/api/orders/:orderId/drawing', (req, res) => {
    const row = db.prepare('SELECT drawing FROM orders WHERE id = ?').get(Number(req.params.orderId));
    if (!row || !row.drawing) return res.status(404).json({ error: 'Файл не найден' });
    const drawing = JSON.parse(row.drawing);
    const filePath = path.join(UPLOADS_DIR, drawing.storedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл был удалён с сервера' });
    res.download(filePath, drawing.originalName);
});

app.post('/api/orders', requireAuth, requireRole('customer'), handleDrawingUpload, (req, res) => {
    const { title, category, deadline, quantity, description } = req.body;
    if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

    const drawing = req.file ? JSON.stringify({ originalName: req.file.originalname, storedName: req.file.filename }) : null;
    const result = db.prepare(
        'INSERT INTO orders (title,category,deadline,quantity,description,company,drawing) VALUES (?,?,?,?,?,?,?)'
    ).run(title, category, deadline, quantity ? Number(quantity) : null,
        description ? String(description).slice(0, 1000) : '', req.user.company, drawing);

    const newOrder = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(result.lastInsertRowid)));

    const MATCH_NOTIFY_THRESHOLD = 50;
    matchedProducers(newOrder, MATCH_NOTIFY_THRESHOLD).forEach(m => {
        addNotification(m.company, `🧩 Новая подходящая закупка (${m.score}% совпадение): «${plainTitle(newOrder.title)}»`);
    });

    res.status(201).json(newOrder);
});

app.put('/api/orders/:orderId', requireAuth, requireRole('customer'), handleDrawingUpload, (req, res) => {
    const orderId = Number(req.params.orderId);
    const { title, category, deadline, quantity, description } = req.body;
    if (!title || !category || !deadline) return res.status(400).json({ error: 'Заполните все поля заявки' });

    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
    const order = rowToOrder(row);
    if (order.company && order.company !== req.user.company) return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
    if (order.status === 'Закрыта' || order.status === 'Отменена') return res.status(400).json({ error: 'Закрытую или отменённую закупку нельзя редактировать' });

    let drawingJson = row.drawing;
    if (req.file) {
        deleteDrawingFile(order.drawing);
        drawingJson = JSON.stringify({ originalName: req.file.originalname, storedName: req.file.filename });
    }

    db.prepare('UPDATE orders SET title=?,category=?,deadline=?,quantity=?,description=?,drawing=? WHERE id=?')
        .run(title, category, deadline, quantity ? Number(quantity) : null,
            description !== undefined ? String(description).slice(0, 1000) : (order.description || ''),
            drawingJson, orderId);

    res.json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
});

app.post('/api/orders/:orderId/cancel', requireAuth, requireRole('customer'), (req, res) => {
    const orderId = Number(req.params.orderId);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
    const order = rowToOrder(row);
    if (order.company && order.company !== req.user.company) return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
    if (order.status === 'Закрыта')  return res.status(400).json({ error: 'Закупка уже завершена, отменить её нельзя' });
    if (order.status === 'Отменена') return res.status(400).json({ error: 'Закупка уже отменена' });

    const title = plainTitle(order.title);
    const notifs = [];

    db.transaction(() => {
        db.prepare("UPDATE orders SET status = 'Отменена' WHERE id = ?").run(orderId);
        db.prepare("SELECT * FROM proposals WHERE order_id = ? AND status = 'Ожидает ответа'").all(orderId).forEach(p => {
            db.prepare("UPDATE proposals SET status = 'Отозвана заказчиком' WHERE id = ?").run(p.id);
            notifs.push({ company: p.company, text: `Закупка «${title}» отменена заказчиком, ваше предложение по ней снято с рассмотрения.` });
        });
    })();

    notifs.forEach(n => addNotification(n.company, n.text));
    res.json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
});

// ===================== PROPOSALS =====================

app.get('/api/proposals/:proposalId/file', (req, res) => {
    const row = db.prepare('SELECT kp_file FROM proposals WHERE id = ?').get(Number(req.params.proposalId));
    if (!row || !row.kp_file) return res.status(404).json({ error: 'Файл не найден' });
    const kpFile = JSON.parse(row.kp_file);
    const filePath = path.join(UPLOADS_DIR, kpFile.storedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл был удалён с сервера' });
    res.download(filePath, kpFile.originalName);
});

app.post('/api/proposals', requireAuth, requireRole('producer'), handleKPUpload, (req, res) => {
    const { orderId, orderTitle, price, days } = req.body;
    if (!orderId || !price || !days) return res.status(400).json({ error: 'Не указаны ID заявки, цена или сроки' });

    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
    if (!orderRow) return res.status(404).json({ error: 'Заявка с таким ID не найдена' });

    if (db.prepare('SELECT id FROM proposals WHERE order_id = ? AND company = ?').get(Number(orderId), req.user.company)) {
        return res.status(409).json({ error: 'Вы уже подали КП на эту закупку. Отредактируйте существующее предложение.' });
    }

    const kpFile = req.file ? JSON.stringify({ originalName: req.file.originalname, storedName: req.file.filename }) : null;

    const result = db.transaction(() => {
        const r = db.prepare('INSERT INTO proposals (order_id,order_title,price,days,company,kp_file) VALUES (?,?,?,?,?,?)')
            .run(Number(orderId), orderTitle || orderRow.title, Number(price), Number(days), req.user.company, kpFile);
        db.prepare('UPDATE orders SET responses = responses + 1 WHERE id = ?').run(Number(orderId));
        return r;
    })();

    const newProposal = rowToProposal(db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(result.lastInsertRowid)));
    if (orderRow.company) addNotification(orderRow.company, `Получен новый отклик на «${plainTitle(orderRow.title)}» от ${req.user.company}.`);
    res.status(201).json(newProposal);
});

app.get('/api/proposals', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT * FROM proposals WHERE company = ?').all(req.user.company).map(rowToProposal));
});

app.get('/api/order-proposals/:orderId', (req, res) => {
    res.json(db.prepare('SELECT * FROM proposals WHERE order_id = ?').all(Number(req.params.orderId)).map(rowToProposal));
});

app.post('/api/proposals/:proposalId/accept', requireAuth, requireRole('customer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposalRow = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
    if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(proposalRow.order_id);
    if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
    if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Принимать предложения может только владелец закупки' });
    if (orderRow.status === 'Закрыта') return res.status(400).json({ error: 'Этот тендер уже завершен' });

    const title = plainTitle(orderRow.title);
    const notifs = [];

    db.transaction(() => {
        db.prepare("UPDATE orders SET status = 'Закрыта' WHERE id = ?").run(orderRow.id);
        db.prepare('SELECT * FROM proposals WHERE order_id = ?').all(orderRow.id).forEach(p => {
            if (p.id === proposalId) {
                db.prepare("UPDATE proposals SET status = 'Выигран' WHERE id = ?").run(p.id);
                notifs.push({ company: p.company, text: `Ваше предложение по «${title}» принято! Заказ выигран.` });
            } else {
                db.prepare("UPDATE proposals SET status = 'Отклонен' WHERE id = ?").run(p.id);
                notifs.push({ company: p.company, text: `Ваше предложение по «${title}» отклонено.` });
            }
        });
    })();

    notifs.forEach(n => addNotification(n.company, n.text));
    res.json({ message: 'Победитель успешно определен, тендер закрыт' });
});

app.post('/api/proposals/:proposalId/reject', requireAuth, requireRole('customer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposalRow = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
    if (!proposalRow) return res.status(404).json({ error: 'Предложение не найдено' });

    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(proposalRow.order_id);
    if (!orderRow) return res.status(404).json({ error: 'Связанная заявка не найдена' });
    if (orderRow.company && orderRow.company !== req.user.company) return res.status(403).json({ error: 'Отклонять предложения может только владелец закупки' });
    if (proposalRow.status !== 'Ожидает ответа') return res.status(400).json({ error: 'Можно отклонить только предложение в статусе "Ожидает ответа"' });

    db.prepare("UPDATE proposals SET status = 'Отклонен' WHERE id = ?").run(proposalId);
    addNotification(proposalRow.company, `Ваше предложение по «${plainTitle(orderRow.title)}» отклонено.`);
    res.json(rowToProposal(db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId)));
});

app.put('/api/proposals/:proposalId', requireAuth, requireRole('producer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const { price, days } = req.body;
    if (!price || !days) return res.status(400).json({ error: 'Не указаны цена или сроки' });

    const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
    if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
    if (row.company !== req.user.company) return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });
    if (row.status !== 'Ожидает ответа') return res.status(400).json({ error: 'Можно редактировать только предложения в статусе "Ожидает ответа"' });

    db.prepare('UPDATE proposals SET price = ?, days = ? WHERE id = ?').run(Number(price), Number(days), proposalId);
    res.json(rowToProposal(db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId)));
});

app.delete('/api/proposals/:proposalId', requireAuth, requireRole('producer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
    if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
    if (row.company !== req.user.company) return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });

    db.transaction(() => {
        db.prepare('DELETE FROM proposals WHERE id = ?').run(proposalId);
        db.prepare('UPDATE orders SET responses = MAX(0, responses - 1) WHERE id = ?').run(row.order_id);
    })();

    res.json({ message: 'Предложение отозвано' });
});

// ===================== COMPANIES =====================

app.get('/api/companies', optionalAuth, (req, res) => {
    const ownerCompany = req.user ? req.user.company : null;
    res.json(db.prepare('SELECT * FROM companies').all().map(r => enrichCompany(rowToCompany(r), ownerCompany)));
});

app.get('/api/companies/:id', optionalAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Компания не найдена' });
    res.json(enrichCompany(rowToCompany(row), req.user ? req.user.company : null));
});

app.put('/api/companies/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Компания не найдена' });
    if (row.company !== req.user.company) return res.status(403).json({ error: 'Можно редактировать только профиль своей компании' });

    const { city, yearsExperience, about, equipment, specialization, phone, website,
            ogrn, director, foundingYear, authorizedCapital, employees, revenue,
            machinesCount, productionArea, videoUrl,
            isoCertificates, qualityCertificates, capabilities, productionLoad } = req.body;
    const cols = [], vals = [];
    const str  = (v, max) => String(v).slice(0, max);
    const num  = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
    if (city !== undefined)               { cols.push('city = ?');                vals.push(str(city, 100)); }
    if (yearsExperience !== undefined)    { cols.push('years_experience = ?');    vals.push(num(yearsExperience)); }
    if (about !== undefined)              { cols.push('about = ?');               vals.push(str(about, 1000)); }
    if (specialization !== undefined)     { cols.push('specialization = ?');      vals.push(str(specialization, 200)); }
    if (phone !== undefined)              { cols.push('phone = ?');               vals.push(str(phone, 30)); }
    if (website !== undefined)            { cols.push('website = ?');             vals.push(str(website, 200)); }
    if (ogrn !== undefined)               { cols.push('ogrn = ?');               vals.push(str(ogrn, 20)); }
    if (director !== undefined)           { cols.push('director = ?');            vals.push(str(director, 150)); }
    if (foundingYear !== undefined)       { cols.push('founding_year = ?');       vals.push(num(foundingYear)); }
    if (authorizedCapital !== undefined)  { cols.push('authorized_capital = ?');  vals.push(str(authorizedCapital, 50)); }
    if (employees !== undefined)          { cols.push('employees = ?');           vals.push(num(employees)); }
    if (revenue !== undefined)            { cols.push('revenue = ?');             vals.push(str(revenue, 50)); }
    if (machinesCount !== undefined)      { cols.push('machines_count = ?');      vals.push(num(machinesCount)); }
    if (productionArea !== undefined)     { cols.push('production_area = ?');     vals.push(num(productionArea)); }
    if (videoUrl !== undefined)           { cols.push('video_url = ?');           vals.push(str(videoUrl, 300)); }
    if (productionLoad !== undefined)     { const n = Number(productionLoad); cols.push('production_load = ?'); vals.push(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null); }
    if (Array.isArray(equipment))         { cols.push('equipment = ?');           vals.push(JSON.stringify(equipment.map(e => str(e, 60)).slice(0, 20))); }
    if (Array.isArray(isoCertificates))   { cols.push('iso_certificates = ?');    vals.push(JSON.stringify(isoCertificates.map(e => str(e, 80)).slice(0, 20))); }
    if (Array.isArray(qualityCertificates)) { cols.push('quality_certificates = ?'); vals.push(JSON.stringify(qualityCertificates.map(e => str(e, 80)).slice(0, 20))); }
    if (Array.isArray(capabilities))      { cols.push('capabilities = ?');        vals.push(JSON.stringify(capabilities.slice(0, 20))); }
    if (cols.length) db.prepare(`UPDATE companies SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);

    res.json(enrichCompany(rowToCompany(db.prepare('SELECT * FROM companies WHERE id = ?').get(id)), req.user.company));
});

// ===================== ФОТО КОМПАНИИ =====================

app.post('/api/companies/:id/photos', requireAuth, handlePhotoUpload, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT company FROM companies WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Компания не найдена' });
    if (row.company !== req.user.company) return res.status(403).json({ error: 'Можно загружать фото только своей компании' });
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

    const count = db.prepare('SELECT COUNT(*) AS n FROM company_photos WHERE company_id = ?').get(id).n;
    if (count >= 10) return res.status(400).json({ error: 'Максимум 10 фотографий' });

    const result = db.prepare('INSERT INTO company_photos (company_id, stored_name, original_name) VALUES (?, ?, ?)')
        .run(id, req.file.filename, req.file.originalname);

    res.status(201).json({ id: Number(result.lastInsertRowid), storedName: req.file.filename, originalName: req.file.originalname });
});

app.delete('/api/companies/:id/photos/:photoId', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const photoId = Number(req.params.photoId);
    const row = db.prepare('SELECT company FROM companies WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Компания не найдена' });
    if (row.company !== req.user.company) return res.status(403).json({ error: 'Нет прав' });

    const photo = db.prepare('SELECT stored_name FROM company_photos WHERE id = ? AND company_id = ?').get(photoId, id);
    if (!photo) return res.status(404).json({ error: 'Фото не найдено' });

    db.prepare('DELETE FROM company_photos WHERE id = ?').run(photoId);
    fs.unlink(path.join(PHOTOS_DIR, photo.stored_name), () => {});
    res.json({ message: 'Удалено' });
});

// ===================== DASHBOARD COUNTS =====================

app.get('/api/dashboard/counts', requireAuth, (req, res) => {
    const company = req.user.company;
    if (req.user.role === 'producer') {
        const activeOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'Активный'").get().n;
        const pendingProposals = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE company = ? AND status = 'Ожидает ответа'").get(company).n;
        const unreadMessages = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE company = ? AND sender = 'customer' AND read = 0").get(company).n;
        res.json({ activeOrders, pendingProposals, unreadMessages });
    } else {
        const myActiveOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE company = ? AND status = 'Активный'").get(company).n;
        const newResponses = db.prepare("SELECT COUNT(*) AS n FROM proposals p JOIN orders o ON p.order_id = o.id WHERE o.company = ? AND p.status = 'Ожидает ответа'").get(company).n;
        const unreadMessages = db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN orders o ON o.id = m.order_id WHERE o.company = ? AND m.sender = 'producer' AND m.read = 0").get(company).n;
        res.json({ myActiveOrders, newResponses, unreadMessages });
    }
});

// ===================== ИЗБРАННЫЕ =====================

app.get('/api/favorites', requireAuth, (req, res) => {
    const result = db.prepare('SELECT company_id FROM favorites WHERE owner_company = ?').all(req.user.company)
        .map(f => db.prepare('SELECT * FROM companies WHERE id = ?').get(f.company_id))
        .filter(Boolean)
        .map(r => enrichCompany(rowToCompany(r), req.user.company));
    res.json(result);
});

app.post('/api/favorites', requireAuth, (req, res) => {
    const id = Number(req.body.companyId);
    if (!id) return res.status(400).json({ error: 'Не указан ID компании' });
    if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) return res.status(404).json({ error: 'Компания не найдена' });
    try {
        db.prepare('INSERT INTO favorites (owner_company, company_id) VALUES (?, ?)').run(req.user.company, id);
        res.status(201).json({ message: 'Добавлено в избранное' });
    } catch { res.status(200).json({ message: 'Уже в избранном' }); }
});

app.delete('/api/favorites/:companyId', requireAuth, (req, res) => {
    db.prepare('DELETE FROM favorites WHERE owner_company = ? AND company_id = ?').run(req.user.company, Number(req.params.companyId));
    res.json({ message: 'Удалено из избранного' });
});

// ===================== AUTH =====================

app.post('/api/auth/register', (req, res) => {
    const { email, password, company, inn, role } = req.body;
    if (!email || !password || !company || !role) return res.status(400).json({ error: 'Заполните все поля регистрации' });
    if (db.prepare('SELECT 1 FROM users WHERE LOWER(email) = LOWER(?)').get(email)) {
        return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }

    const result = db.transaction(() => {
        const r = db.prepare('INSERT INTO users (email,password,role,company,inn) VALUES (?,?,?,?,?)')
            .run(email, hashPassword(password), role, company, inn || '');
        if (!db.prepare('SELECT 1 FROM companies WHERE company = ? AND role = ?').get(company, role)) {
            db.prepare('INSERT INTO companies (company,inn,role,specialization,status) VALUES (?,?,?,?,?)')
                .run(company, inn || '', role, '', 'На проверке');
        }
        return r;
    })();

    res.status(201).json({ token: 'token-' + Number(result.lastInsertRowid), role, company });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' });

    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Неверный email или пароль' });

    if (!user.password.includes(':')) {
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), user.id);
    }

    res.json({ token: 'token-' + user.id, role: user.role, company: user.company });
});

// ===================== СООБЩЕНИЯ =====================

app.get('/api/messages/conversations', requireAuth, (req, res) => {
    const { role, company } = req.user;
    const otherSender = role === 'producer' ? 'customer' : 'producer';
    let rows;
    if (role === 'producer') {
        rows = db.prepare(`
            SELECT m.order_id, o.title AS order_title, m.company,
                MAX(m.created_at) AS last_at,
                COUNT(CASE WHEN m.sender = 'customer' AND m.read = 0 THEN 1 END) AS unread_count
            FROM messages m JOIN orders o ON o.id = m.order_id
            WHERE m.company = ?
            GROUP BY m.order_id ORDER BY last_at DESC
        `).all(company);
    } else {
        rows = db.prepare(`
            SELECT m.order_id, o.title AS order_title, m.company,
                MAX(m.created_at) AS last_at,
                COUNT(CASE WHEN m.sender = 'producer' AND m.read = 0 THEN 1 END) AS unread_count
            FROM messages m JOIN orders o ON o.id = m.order_id
            WHERE o.company = ?
            GROUP BY m.order_id, m.company ORDER BY last_at DESC
        `).all(company);
    }
    res.json(rows.map(r => {
        const last = db.prepare('SELECT * FROM messages WHERE order_id = ? AND company = ? ORDER BY created_at DESC LIMIT 1')
            .get(r.order_id, r.company);
        return {
            orderId: r.order_id,
            orderTitle: r.order_title || `Заявка #${r.order_id}`,
            company: r.company,
            lastMessage: last ? last.text : '',
            lastSender: last ? last.sender : '',
            lastAt: r.last_at,
            unreadCount: r.unread_count || 0,
        };
    }));
});

app.post('/api/messages/:orderId/:company/read', requireAuth, (req, res) => {
    const orderId = Number(req.params.orderId);
    const company = req.params.company;
    const otherSender = req.user.role === 'producer' ? 'customer' : 'producer';
    db.prepare('UPDATE messages SET read = 1 WHERE order_id = ? AND company = ? AND sender = ? AND read = 0')
        .run(orderId, company, otherSender);
    res.json({ ok: true });
});

app.get('/api/messages/:orderId/:company', (req, res) => {
    res.json(
        db.prepare('SELECT * FROM messages WHERE order_id = ? AND company = ? ORDER BY created_at ASC')
            .all(Number(req.params.orderId), req.params.company)
            .map(rowToMessage)
    );
});

app.post('/api/messages', requireAuth, (req, res) => {
    const { orderId, company, text } = req.body;
    if (!orderId || !company || !text) return res.status(400).json({ error: 'Заполните все поля сообщения' });

    const result = db.prepare('INSERT INTO messages (order_id,company,sender,text) VALUES (?,?,?,?)')
        .run(Number(orderId), company, req.user.role, String(text).slice(0, 2000));

    const msg = rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid)));
    if (io) io.to(`chat:${msg.orderId}:${msg.company}`).emit('message', msg);
    res.status(201).json(msg);
});

// ===================== УВЕДОМЛЕНИЯ =====================

app.get('/api/notifications/:company', requireAuth, (req, res) => {
    if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа к уведомлениям этой компании' });
    res.json(
        db.prepare('SELECT * FROM notifications WHERE company = ? ORDER BY created_at DESC').all(req.user.company).map(rowToNotification)
    );
});

app.post('/api/notifications/:company/read', requireAuth, (req, res) => {
    if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare('UPDATE notifications SET read = 1 WHERE company = ?').run(req.user.company);
    res.json({ message: 'ok' });
});

app.delete('/api/notifications/:company', requireAuth, (req, res) => {
    if (req.params.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare('DELETE FROM notifications WHERE company = ?').run(req.user.company);
    res.json({ message: 'ok' });
});

// ===================== НАСТРОЙКИ =====================

app.post('/api/auth/forgot-password', (req, res) => {
    // No email system — just acknowledge silently (don't reveal whether email exists)
    res.json({ message: 'ok' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ email: req.user.email, role: req.user.role, company: req.user.company });
});

app.put('/api/auth/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль — минимум 6 символов' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(currentPassword, user.password)) return res.status(400).json({ error: 'Неверный текущий пароль' });

    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
    res.json({ message: 'Пароль успешно изменён' });
});

app.put('/api/auth/email', requireAuth, (req, res) => {
    const { newEmail, password } = req.body;
    if (!newEmail || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'Некорректный формат email' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(password, user.password)) return res.status(400).json({ error: 'Неверный пароль' });

    const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, req.user.id);
    if (taken) return res.status(400).json({ error: 'Этот email уже используется' });

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, req.user.id);
    res.json({ message: 'Email успешно изменён' });
});

// ===================== ЗАКАЗЫ (СДЕЛКИ) =====================

app.get('/api/deals', requireAuth, (req, res) => {
    const { role, company } = req.user;
    let rows;

    if (role === 'customer') {
        rows = db.prepare(`
            SELECT o.id AS order_id, o.title, o.quantity, o.unit, o.category,
                   p.id AS proposal_id, p.company AS counterparty,
                   p.price, p.days, p.created_at AS deal_date, p.completion_status,
                   c.id AS counterparty_profile_id
            FROM orders o
            JOIN proposals p ON p.order_id = o.id AND p.status = 'Выигран'
            LEFT JOIN companies c ON c.company = p.company AND c.role = 'producer'
            WHERE o.company = ?
            ORDER BY p.created_at DESC
        `).all(company);
    } else if (role === 'producer') {
        rows = db.prepare(`
            SELECT o.id AS order_id, o.title, o.quantity, o.unit, o.category,
                   p.id AS proposal_id, o.company AS counterparty,
                   p.price, p.days, p.created_at AS deal_date, p.completion_status,
                   c.id AS counterparty_profile_id
            FROM proposals p
            JOIN orders o ON o.id = p.order_id
            LEFT JOIN companies c ON c.company = o.company AND c.role = 'customer'
            WHERE p.company = ? AND p.status = 'Выигран'
            ORDER BY p.created_at DESC
        `).all(company);
    } else {
        return res.json([]);
    }

    res.json(rows.map(r => ({
        orderId:               r.order_id,
        proposalId:            r.proposal_id,
        title:                 r.title,
        quantity:              r.quantity,
        unit:                  r.unit,
        category:              r.category,
        counterparty:          r.counterparty,
        counterpartyProfileId: r.counterparty_profile_id || null,
        price:                 r.price,
        days:                  r.days,
        dealDate:              r.deal_date,
        completionStatus:      r.completion_status || 'active',
    })));
});

app.put('/api/deals/:proposalId/complete', requireAuth, requireRole('customer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const row = db.prepare(`
        SELECT p.*, o.company AS customer_company, o.title AS order_title
        FROM proposals p JOIN orders o ON o.id = p.order_id
        WHERE p.id = ?
    `).get(proposalId);

    if (!row) return res.status(404).json({ error: 'Сделка не найдена' });
    if (row.status !== 'Выигран') return res.status(400).json({ error: 'Это не активная сделка' });
    if (row.customer_company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });
    if (row.completion_status === 'completed') return res.status(400).json({ error: 'Сделка уже завершена' });

    db.prepare("UPDATE proposals SET completion_status = 'completed' WHERE id = ?").run(proposalId);
    addNotification(row.company, `Заказчик подтвердил выполнение заказа «${plainTitle(row.order_title)}».`);
    res.json({ message: 'Сделка завершена' });
});

// ===================== ВЕРИФИКАЦИЯ =====================

app.post('/api/verification/request', requireAuth, (req, res) => {
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Недоступно для администраторов' });

    const company = db.prepare('SELECT * FROM companies WHERE company = ? AND role = ?').get(req.user.company, req.user.role);
    if (!company) return res.status(404).json({ error: 'Профиль компании не найден' });
    if (company.verified_by_platform) return res.status(400).json({ error: 'Компания уже верифицирована' });

    const existing = db.prepare('SELECT * FROM verification_requests WHERE company_id = ?').get(company.id);
    if (existing && existing.status === 'pending') return res.status(400).json({ error: 'Заявка уже отправлена и ожидает рассмотрения' });

    if (existing) db.prepare('DELETE FROM verification_requests WHERE company_id = ?').run(company.id);

    db.prepare("INSERT INTO verification_requests (company_id, status, requested_at) VALUES (?, 'pending', ?)")
        .run(company.id, new Date().toISOString());

    res.json({ message: 'Заявка на верификацию отправлена' });
});

app.get('/api/verification/status', requireAuth, (req, res) => {
    if (req.user.role === 'admin') return res.json({ status: 'none' });

    const company = db.prepare('SELECT * FROM companies WHERE company = ? AND role = ?').get(req.user.company, req.user.role);
    if (!company) return res.json({ status: 'none' });
    if (company.verified_by_platform) return res.json({ status: 'approved' });

    const vr = db.prepare('SELECT * FROM verification_requests WHERE company_id = ?').get(company.id);
    if (!vr) return res.json({ status: 'none' });

    res.json({ status: vr.status, comment: vr.admin_comment || '', requestedAt: vr.requested_at });
});

app.get('/api/verification/requests', requireAuth, requireRole('admin'), (req, res) => {
    const filter = req.query.filter === 'all' ? 'all' : 'pending';
    const sql = `SELECT vr.*, c.company, c.inn, c.ogrn, c.director, c.founding_year,
        c.authorized_capital, c.employees, c.revenue, c.machines_count, c.production_area,
        c.capabilities, c.iso_certificates, c.quality_certificates, c.specialization, c.city,
        c.role AS company_role
        FROM verification_requests vr JOIN companies c ON c.id = vr.company_id
        ${filter === 'pending' ? "WHERE vr.status = 'pending'" : ''}
        ORDER BY vr.requested_at DESC`;
    const rows = db.prepare(sql).all();
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
});

app.post('/api/verification/:id/approve', requireAuth, requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const vr = db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(id);
    if (!vr) return res.status(404).json({ error: 'Заявка не найдена' });

    db.exec('BEGIN');
    try {
        db.prepare("UPDATE verification_requests SET status='approved', reviewed_at=? WHERE id=?")
            .run(new Date().toISOString(), id);
        db.prepare("UPDATE companies SET verified_by_platform=1, status='Верифицирован' WHERE id=?")
            .run(vr.company_id);
        db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.json({ message: 'Компания верифицирована' });
});

app.post('/api/verification/:id/reject', requireAuth, requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const comment = String(req.body.comment || '').slice(0, 500);
    const vr = db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(id);
    if (!vr) return res.status(404).json({ error: 'Заявка не найдена' });

    db.prepare("UPDATE verification_requests SET status='rejected', admin_comment=?, reviewed_at=? WHERE id=?")
        .run(comment, new Date().toISOString(), id);

    res.json({ message: 'Заявка отклонена' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Эндпоинт не найден' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '404.html')));

httpServer.listen(PORT, () => {
    console.log(`Бэкенд-сервер успешно запущен на порту ${PORT}`);
});
