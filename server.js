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
        phone: r.phone, website: r.website
    };
}

function rowToMessage(r) {
    if (!r) return null;
    return {
        id: r.id, orderId: r.order_id, company: r.company,
        sender: r.sender, text: r.text, createdAt: r.created_at
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

const ALLOWED_DRAWING_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.dxf', '.dwg', '.step', '.stp'];
const KP_ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];

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

function deleteDrawingFile(drawing) {
    if (!drawing || !drawing.storedName) return;
    fs.unlink(path.join(UPLOADS_DIR, drawing.storedName), () => {});
}

// ===================== СТАТИКА =====================
app.use('/assets', express.static(path.join(__dirname, 'assets')));
const PUBLIC_PAGES = ['login.html', 'index.html', 'producer.html', 'proposals.html', 'partners.html', 'analytics.html', 'company-profile.html'];
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

    const { city, yearsExperience, about, equipment, specialization, phone, website } = req.body;
    const cols = [], vals = [];
    if (city !== undefined)             { cols.push('city = ?');             vals.push(String(city).slice(0, 100)); }
    if (yearsExperience !== undefined)  { const n = Number(yearsExperience); cols.push('years_experience = ?'); vals.push(Number.isFinite(n) && n >= 0 ? n : null); }
    if (about !== undefined)            { cols.push('about = ?');            vals.push(String(about).slice(0, 1000)); }
    if (specialization !== undefined)   { cols.push('specialization = ?');   vals.push(String(specialization).slice(0, 200)); }
    if (phone !== undefined)            { cols.push('phone = ?');            vals.push(String(phone).slice(0, 30)); }
    if (website !== undefined)          { cols.push('website = ?');          vals.push(String(website).slice(0, 200)); }
    if (equipment !== undefined && Array.isArray(equipment)) {
        cols.push('equipment = ?');
        vals.push(JSON.stringify(equipment.map(e => String(e).slice(0, 60)).slice(0, 20)));
    }
    if (cols.length) db.prepare(`UPDATE companies SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);

    res.json(enrichCompany(rowToCompany(db.prepare('SELECT * FROM companies WHERE id = ?').get(id)), req.user.company));
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

httpServer.listen(PORT, () => {
    console.log(`Бэкенд-сервер успешно запущен на порту ${PORT}`);
});
