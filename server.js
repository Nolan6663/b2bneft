const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const crypto = require('crypto');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(input, stored) {
    if (!stored || !stored.includes(':')) return input === stored; // legacy plain text
    const [salt, hash] = stored.split(':');
    try {
        const derived = crypto.scryptSync(input, salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
    } catch { return false; }
}

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// ===================== WEBSOCKET (Socket.IO, опционально) =====================
// Живые уведомления и чат вместо поллинга: комната "<company>" — для
// персональных уведомлений компании, комната "chat:<orderId>:<company>" —
// для конкретного треда чата. Клиент подключается и сам просит join
// нужных комнат (см. assets/app.js).
//
// Пакет socket.io пока не установился (нестабильная сеть при npm install) —
// require обёрнут в try/catch, чтобы сервер не падал при старте. Как только
// `npm install socket.io` пройдёт успешно, всё заработает само — без правок кода.
let Server = null;
try {
    Server = require('socket.io').Server;
} catch (error) {
    console.warn('socket.io не установлен — живые WebSocket-обновления отключены, работаем через обычный поллинг.');
}

const httpServer = http.createServer(app);
const io = Server ? new Server(httpServer, { cors: { origin: '*' } }) : null;

if (io) {
    io.on('connection', (socket) => {
        socket.on('join-company', (company) => {
            if (company) socket.join(company);
        });
        socket.on('join-chat', ({ orderId, company }) => {
            if (orderId != null && company) socket.join(`chat:${orderId}:${company}`);
        });
    });
}

// ===================== ЗАГРУЗКА ЧЕРТЕЖЕЙ =====================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const ALLOWED_DRAWING_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.dxf', '.dwg', '.step', '.stp'];

const drawingStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
        cb(null, safeName);
    }
});

const uploadDrawing = multer({
    storage: drawingStorage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15 МБ
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_DRAWING_EXT.includes(ext)) {
            return cb(new Error('Недопустимый тип файла. Разрешены: ' + ALLOWED_DRAWING_EXT.join(', ')));
        }
        cb(null, true);
    }
}).single('drawing');

// Оборачиваем multer, чтобы его ошибки (размер/тип) превращались в обычный JSON-ответ 400,
// а не падали необработанным исключением.
function handleDrawingUpload(req, res, next) {
    uploadDrawing(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
        next();
    });
}

// ===================== ЗАГРУЗКА ФАЙЛОВ К КП =====================
const KP_ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];

const kpStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'kp-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});

const uploadKP = multer({
    storage: kpStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!KP_ALLOWED_EXT.includes(ext)) {
            return cb(new Error('Недопустимый тип файла. Разрешены: ' + KP_ALLOWED_EXT.join(', ')));
        }
        cb(null, true);
    }
}).single('kpFile');

function handleKPUpload(req, res, next) {
    uploadKP(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
        next();
    });
}

function deleteDrawingFile(drawing) {
    if (!drawing || !drawing.storedName) return;
    const filePath = path.join(UPLOADS_DIR, drawing.storedName);
    fs.unlink(filePath, () => {}); // не критично, если файла уже нет
}

// ВАЖНО: раздаём статикой только assets/ и сами HTML-страницы по явному списку.
// express.static(__dirname) раздавал бы ВСЮ папку проекта, включая users.json
// (пароли открытым текстом), orders.json, companies.json и сам server.js —
// этого допускать нельзя.
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const PUBLIC_PAGES = ['login.html', 'index.html', 'producer.html', 'proposals.html', 'partners.html', 'analytics.html', 'company-profile.html'];
PUBLIC_PAGES.forEach(page => {
    app.get('/' + page, (req, res) => res.sendFile(path.join(__dirname, page)));
});
app.get('/', (req, res) => res.redirect('/login.html'));

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const PROPOSALS_FILE = path.join(__dirname, 'proposals.json');
const COMPANIES_FILE = path.join(__dirname, 'companies.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

function readData(filePath, defaultData = []) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
            return defaultData;
        }
        const fileContent = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        console.error(`Ошибка при чтении файла ${filePath}:`, error);
        return defaultData;
    }
}

function writeData(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Ошибка при записи в файл ${filePath}:`, error);
    }
}

// Заголовок без подвешенного " | имя_файла_чертежа"
function plainTitle(title) {
    return title && title.includes(' | ') ? title.split(' | ')[0] : title;
}

// ===================== УМНЫЙ МАТЧИНГ =====================
// Считаем % соответствия заказа профилю производителя по специализации
// и заявленному оборудованию — вместо того, чтобы показывать/рассылать
// все заказы всем подряд без разбора (как делает большинство досок
// объявлений). Сравнение по "стемам" (первые 5 букв слова), а не по
// точному совпадению — иначе из-за русских падежных окончаний
// ("резиновая" vs "резина") совпадения почти никогда не находились бы.

const CATEGORY_KEYWORDS = {
    'РТИ': ['рти', 'резин', 'уплотн', 'манжет', 'вулканиз'],
    'Металл': ['металл', 'прокат', 'сварк', 'металлоконструкц', 'лазерн', 'гибочн', 'чпу', 'литье', 'нефтепромысл'],
    'Трубопроводная арматура': ['арматур', 'задвиж', 'клапан', 'кран', 'вентил', 'фланц', 'фитинг', 'трубопров'],
    'Электрооборудование': ['электр', 'кабел', 'двигател', 'трансформ', 'автомат', 'щит', 'пускател'],
    'Прочее': []
};

function stem(word) {
    return word.slice(0, 5);
}

function computeMatchScore(order, producer) {
    const text = `${producer.specialization || ''} ${(producer.equipment || []).join(' ')}`.toLowerCase();
    if (!text.trim()) return 0;

    let score = 0;

    const keywords = CATEGORY_KEYWORDS[order.category] || [];
    const categoryHits = keywords.filter(k => text.includes(k)).length;
    score += Math.min(categoryHits, 3) * 20; // до 60 баллов за соответствие категории

    const titleWords = plainTitle(order.title || '')
        .toLowerCase()
        .split(/[^a-zа-яё0-9]+/)
        .filter(w => w.length > 3);
    const titleHits = titleWords.filter(w => text.includes(stem(w))).length;
    score += Math.min(titleHits, 2) * 15; // до 30 баллов за совпадение слов в названии

    return Math.min(100, score);
}

// Список производителей с их matchScore по конкретному заказу, отсортированный по убыванию.
function matchedProducers(order, minScore = 0) {
    const companies = readData(COMPANIES_FILE).filter(c => c.role === 'producer');
    return companies
        .map(c => ({ company: c.company, score: computeMatchScore(order, c) }))
        .filter(m => m.score >= minScore)
        .sort((a, b) => b.score - a.score);
}

// ===================== AUTH MIDDLEWARE =====================
// Токен — простая строка 'token-<userId>' (без JWT, см. комментарий ниже
// у /api/auth/*), но теперь backend реально проверяет её перед мутацией
// данных: без валидного токена в Authorization запрос отклоняется, а
// company для заказа/КП берётся из учётной записи токена, а не из тела
// запроса — это не даёт прислать данные от имени чужой компании.

function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+token-(\d+)$/);
    if (!match) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const users = readData(USERS_FILE);
    const user = users.find(u => u.id === Number(match[1]));
    if (!user) {
        return res.status(401).json({ error: 'Неверный или истёкший токен' });
    }
    req.user = user;
    next();
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) {
            return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
        }
        next();
    };
}

// Мягкая авторизация: если токен есть и валиден — кладёт req.user, иначе
// просто пропускает дальше без ошибки. Нужна там, где эндпоинт открыт и для
// гостей (реестр контрагентов), но хочет знать, кто смотрит, если залогинен
// (например, чтобы пометить избранные компании).
function optionalAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+token-(\d+)$/);
    if (match) {
        const users = readData(USERS_FILE);
        const user = users.find(u => u.id === Number(match[1]));
        if (user) req.user = user;
    }
    next();
}

// Создать уведомление для конкретной компании (используется другими эндпоинтами при событиях)
// и сразу пушнуть его живым клиентам этой компании через WebSocket.
function addNotification(company, text) {
    if (!company) return;
    const notifications = readData(NOTIFICATIONS_FILE);
    const entry = {
        id: notifications.length > 0 ? Math.max(...notifications.map(n => n.id)) + 1 : 1,
        company,
        text,
        read: false,
        createdAt: new Date().toISOString()
    };
    notifications.push(entry);
    writeData(NOTIFICATIONS_FILE, notifications);
    if (io) io.to(company).emit('notification', entry);
}

if (!fs.existsSync(ORDERS_FILE)) {
    const initialOrders = [
        { id: 1, title: "Манжета резиновая армированная", category: "РТИ", status: "Активный", responses: 0, deadline: "25.05.2026", createdAt: new Date().toISOString() },
        { id: 2, title: "Фланец стальной ГОСТ", category: "Металл", status: "Активный", responses: 0, deadline: "28.05.2026", createdAt: new Date().toISOString() }
    ];
    writeData(ORDERS_FILE, initialOrders);
}

// ===================== ORDERS =====================

// 1. Получить все заявки
app.get('/api/orders', (req, res) => {
    res.json(readData(ORDERS_FILE));
});

// 1a. % соответствия каждой активной закупки профилю текущего производителя
// (умный матчинг — см. computeMatchScore выше)
app.get('/api/orders/match-scores', requireAuth, requireRole('producer'), (req, res) => {
    const companies = readData(COMPANIES_FILE);
    const me = companies.find(c => c.company === req.user.company && c.role === 'producer');
    const orders = readData(ORDERS_FILE);
    const scores = {};
    orders.forEach(order => {
        scores[order.id] = me ? computeMatchScore(order, me) : 0;
    });
    res.json(scores);
});

// 1b. Скачать чертёж/спецификацию, приложенный к закупке
app.get('/api/orders/:orderId/drawing', (req, res) => {
    const orderId = Number(req.params.orderId);
    const orders = readData(ORDERS_FILE);
    const order = orders.find(o => o.id === orderId);
    if (!order || !order.drawing) {
        return res.status(404).json({ error: 'Файл не найден' });
    }
    const filePath = path.join(UPLOADS_DIR, order.drawing.storedName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Файл был удалён с сервера' });
    }
    res.download(filePath, order.drawing.originalName);
});

// 2. Создать новую заявку
app.post('/api/orders', requireAuth, requireRole('customer'), handleDrawingUpload, (req, res) => {
    const { title, category, deadline, quantity, description } = req.body;
    if (!title || !category || !deadline) {
        return res.status(400).json({ error: 'Заполните все поля заявки' });
    }

    const orders = readData(ORDERS_FILE);
    const newOrder = {
        id: orders.length > 0 ? Math.max(...orders.map(o => o.id)) + 1 : 1,
        title,
        category,
        status: "Активный",
        responses: 0,
        deadline,
        quantity: quantity ? Number(quantity) : null,
        description: description ? String(description).slice(0, 1000) : '',
        company: req.user.company,
        drawing: req.file ? { originalName: req.file.originalname, storedName: req.file.filename } : null,
        createdAt: new Date().toISOString()
    };

    orders.push(newOrder);
    writeData(ORDERS_FILE, orders);

    // Умный матчинг: уведомляем не всех производителей подряд, а только тех,
    // чей профиль (специализация/оборудование) реально подходит под закупку.
    const MATCH_NOTIFY_THRESHOLD = 50;
    matchedProducers(newOrder, MATCH_NOTIFY_THRESHOLD).forEach(m => {
        addNotification(m.company, `🎯 Новая подходящая закупка (${m.score}% совпадение): «${plainTitle(newOrder.title)}»`);
    });

    res.status(201).json(newOrder);
});

// 2b. Редактировать свою закупку (только пока не закрыта и не отменена)
app.put('/api/orders/:orderId', requireAuth, requireRole('customer'), handleDrawingUpload, (req, res) => {
    const orderId = Number(req.params.orderId);
    const { title, category, deadline, quantity, description } = req.body;
    if (!title || !category || !deadline) {
        return res.status(400).json({ error: 'Заполните все поля заявки' });
    }

    const orders = readData(ORDERS_FILE);
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ error: 'Заявка не найдена' });
    }
    if (order.company && order.company !== req.user.company) {
        return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
    }
    if (order.status === 'Закрыта' || order.status === 'Отменена') {
        return res.status(400).json({ error: 'Закрытую или отменённую закупку нельзя редактировать' });
    }

    order.title = title;
    order.category = category;
    order.deadline = deadline;
    order.quantity = quantity ? Number(quantity) : null;
    order.description = description !== undefined ? String(description).slice(0, 1000) : (order.description || '');
    if (req.file) {
        deleteDrawingFile(order.drawing);
        order.drawing = { originalName: req.file.originalname, storedName: req.file.filename };
    }
    writeData(ORDERS_FILE, orders);
    res.json(order);
});

// 2c. Отменить свою закупку — статус "Отменена", ожидающие КП отзываются с уведомлением
app.post('/api/orders/:orderId/cancel', requireAuth, requireRole('customer'), (req, res) => {
    const orderId = Number(req.params.orderId);
    const orders = readData(ORDERS_FILE);
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ error: 'Заявка не найдена' });
    }
    if (order.company && order.company !== req.user.company) {
        return res.status(403).json({ error: 'Это закупка принадлежит другой компании' });
    }
    if (order.status === 'Закрыта') {
        return res.status(400).json({ error: 'Закупка уже завершена, отменить её нельзя' });
    }
    if (order.status === 'Отменена') {
        return res.status(400).json({ error: 'Закупка уже отменена' });
    }

    order.status = 'Отменена';
    const title = plainTitle(order.title);

    const proposals = readData(PROPOSALS_FILE);
    proposals.forEach(p => {
        if (p.orderId === orderId && p.status === 'Ожидает ответа') {
            p.status = 'Отозвана заказчиком';
            addNotification(p.company, `Закупка «${title}» отменена заказчиком, ваше предложение по ней снято с рассмотрения.`);
        }
    });

    writeData(ORDERS_FILE, orders);
    writeData(PROPOSALS_FILE, proposals);
    res.json(order);
});

// ===================== PROPOSALS =====================

// 3. Скачать файл, приложенный к КП
app.get('/api/proposals/:proposalId/file', (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposals = readData(PROPOSALS_FILE);
    const proposal = proposals.find(p => p.id === proposalId);
    if (!proposal || !proposal.kpFile) {
        return res.status(404).json({ error: 'Файл не найден' });
    }
    const filePath = path.join(UPLOADS_DIR, proposal.kpFile.storedName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Файл был удалён с сервера' });
    }
    res.download(filePath, proposal.kpFile.originalName);
});

// 3b. Отправить коммерческое предложение (КП)
app.post('/api/proposals', requireAuth, requireRole('producer'), handleKPUpload, (req, res) => {
    const { orderId, orderTitle, price, days } = req.body;
    if (!orderId || !price || !days) {
        return res.status(400).json({ error: 'Не указаны ID заявки, цена или сроки' });
    }

    const proposals = readData(PROPOSALS_FILE);
    const orders = readData(ORDERS_FILE);

    const order = orders.find(o => o.id === Number(orderId));
    if (!order) {
        return res.status(404).json({ error: 'Заявка с таким ID не найдена' });
    }

    const duplicate = proposals.find(p => p.orderId === Number(orderId) && p.company === req.user.company);
    if (duplicate) {
        return res.status(409).json({ error: 'Вы уже подали КП на эту закупку. Отредактируйте существующее предложение.' });
    }

    const newProposal = {
        id: proposals.length > 0 ? Math.max(...proposals.map(p => p.id)) + 1 : 1,
        orderId: Number(orderId),
        orderTitle: orderTitle || order.title,
        price: Number(price),
        days: Number(days),
        company: req.user.company,
        status: 'Ожидает ответа',
        kpFile: req.file ? { originalName: req.file.originalname, storedName: req.file.filename } : null,
        createdAt: new Date().toISOString()
    };

    proposals.push(newProposal);
    order.responses += 1;

    writeData(PROPOSALS_FILE, proposals);
    writeData(ORDERS_FILE, orders);

    if (order.company) {
        addNotification(order.company, `Получен новый отклик на «${plainTitle(order.title)}» от ${newProposal.company}.`);
    }

    res.status(201).json(newProposal);
});

// 4. Получить предложения своей компании
app.get('/api/proposals', requireAuth, (req, res) => {
    const proposals = readData(PROPOSALS_FILE).filter(p => p.company === req.user.company);
    res.json(proposals);
});

// 5. Получить предложения для конкретной заявки
app.get('/api/order-proposals/:orderId', (req, res) => {
    const orderId = Number(req.params.orderId);
    const proposals = readData(PROPOSALS_FILE);
    const orderProposals = proposals.filter(p => p.orderId === orderId);
    res.json(orderProposals);
});

// 6. Выбрать победителя
app.post('/api/proposals/:proposalId/accept', requireAuth, requireRole('customer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposals = readData(PROPOSALS_FILE);
    const orders = readData(ORDERS_FILE);

    const targetProposal = proposals.find(p => p.id === proposalId);
    if (!targetProposal) {
        return res.status(404).json({ error: 'Предложение не найдено' });
    }

    const order = orders.find(o => o.id === targetProposal.orderId);
    if (!order) {
        return res.status(404).json({ error: 'Связанная заявка не найдена' });
    }

    if (order.company && order.company !== req.user.company) {
        return res.status(403).json({ error: 'Принимать предложения может только владелец закупки' });
    }

    if (order.status === 'Закрыта') {
        return res.status(400).json({ error: 'Этот тендер уже завершен' });
    }

    order.status = 'Закрыта';
    const title = plainTitle(order.title);

    proposals.forEach(p => {
        if (p.orderId === targetProposal.orderId) {
            if (p.id === proposalId) {
                p.status = 'Выигран';
                addNotification(p.company, `Ваше предложение по «${title}» принято! Заказ выигран.`);
            } else {
                p.status = 'Отклонен';
                addNotification(p.company, `Ваше предложение по «${title}» отклонено.`);
            }
        }
    });

    writeData(PROPOSALS_FILE, proposals);
    writeData(ORDERS_FILE, orders);

    res.json({ message: 'Победитель успешно определен, тендер закрыт' });
});

// 6b. Точечно отклонить одно предложение — тендер остаётся открытым для остальных
app.post('/api/proposals/:proposalId/reject', requireAuth, requireRole('customer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposals = readData(PROPOSALS_FILE);
    const orders = readData(ORDERS_FILE);

    const targetProposal = proposals.find(p => p.id === proposalId);
    if (!targetProposal) {
        return res.status(404).json({ error: 'Предложение не найдено' });
    }

    const order = orders.find(o => o.id === targetProposal.orderId);
    if (!order) {
        return res.status(404).json({ error: 'Связанная заявка не найдена' });
    }
    if (order.company && order.company !== req.user.company) {
        return res.status(403).json({ error: 'Отклонять предложения может только владелец закупки' });
    }
    if (targetProposal.status !== 'Ожидает ответа') {
        return res.status(400).json({ error: 'Можно отклонить только предложение в статусе "Ожидает ответа"' });
    }

    targetProposal.status = 'Отклонен';
    addNotification(targetProposal.company, `Ваше предложение по «${plainTitle(order.title)}» отклонено.`);

    writeData(PROPOSALS_FILE, proposals);
    res.json(targetProposal);
});

// 7. Редактировать предложение (только пока статус "Ожидает ответа")
app.put('/api/proposals/:proposalId', requireAuth, requireRole('producer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const { price, days } = req.body;
    if (!price || !days) {
        return res.status(400).json({ error: 'Не указаны цена или сроки' });
    }

    const proposals = readData(PROPOSALS_FILE);
    const target = proposals.find(p => p.id === proposalId);
    if (!target) {
        return res.status(404).json({ error: 'Предложение не найдено' });
    }
    if (target.company !== req.user.company) {
        return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });
    }
    if (target.status !== 'Ожидает ответа') {
        return res.status(400).json({ error: 'Можно редактировать только предложения в статусе "Ожидает ответа"' });
    }

    target.price = Number(price);
    target.days = Number(days);
    writeData(PROPOSALS_FILE, proposals);
    res.json(target);
});

// 8. Отозвать предложение
app.delete('/api/proposals/:proposalId', requireAuth, requireRole('producer'), (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposals = readData(PROPOSALS_FILE);
    const orders = readData(ORDERS_FILE);

    const target = proposals.find(p => p.id === proposalId);
    if (!target) {
        return res.status(404).json({ error: 'Предложение не найдено' });
    }
    if (target.company !== req.user.company) {
        return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });
    }

    const remaining = proposals.filter(p => p.id !== proposalId);
    const order = orders.find(o => o.id === target.orderId);
    if (order && order.responses > 0) {
        order.responses -= 1;
    }

    writeData(PROPOSALS_FILE, remaining);
    writeData(ORDERS_FILE, orders);
    res.json({ message: 'Предложение отозвано' });
});

// ===================== COMPANIES (реестр контрагентов) =====================
// Статус "Верифицирован" и рейтинг надёжности производителя — НЕ статичные
// данные, а результат реальной активности на платформе:
//   - производитель верифицируется и получает рейтинг по соотношению
//     выигранных/отклонённых КП среди уже РАЗРЕШЁННЫХ (не "Ожидает ответа");
//   - заказчик верифицируется, если у него есть хотя бы одна закрытая закупка.
// Если у компании вообще нет реальных заказов/предложений (например, это
// декоративная seed-запись для наполнения реестра) — отдаём как есть из
// companies.json, чтобы реестр не выглядел пустым для демо-данных.

function computeProducerRating(companyName) {
    const proposals = readData(PROPOSALS_FILE).filter(p => p.company === companyName);
    const resolved = proposals.filter(p => p.status === 'Выигран' || p.status === 'Отклонен');
    if (resolved.length === 0) return null;

    const won = resolved.filter(p => p.status === 'Выигран').length;
    const winRate = won / resolved.length;

    let rating, ratingLabel;
    if (winRate >= 0.7 && won >= 3) { rating = 'A+'; ratingLabel = 'Высокий'; }
    else if (winRate >= 0.5) { rating = 'A'; ratingLabel = 'Высокий'; }
    else if (winRate >= 0.3) { rating = 'B+'; ratingLabel = 'Средний'; }
    else if (winRate >= 0.15 || won > 0) { rating = 'B'; ratingLabel = 'Средний'; }
    else { rating = 'C'; ratingLabel = 'Низкий'; }

    return {
        status: won > 0 ? 'Верифицирован' : 'На проверке',
        rating,
        ratingLabel,
        ratingStats: { won, resolved: resolved.length }
    };
}

function computeCustomerStatus(companyName) {
    const orders = readData(ORDERS_FILE).filter(o => o.company === companyName);
    if (orders.length === 0) return null;
    const closed = orders.filter(o => o.status === 'Закрыта').length;
    return { status: closed > 0 ? 'Верифицирован' : 'На проверке' };
}

// Статистика профиля компании — тоже из реальных данных, а не выдуманные цифры.
function computeProducerStats(companyName) {
    const proposals = readData(PROPOSALS_FILE).filter(p => p.company === companyName);
    if (proposals.length === 0) return null;
    const won = proposals.filter(p => p.status === 'Выигран');
    const avgDeliveryDays = won.length ? Math.round(won.reduce((s, p) => s + p.days, 0) / won.length) : null;
    return {
        completedOrders: won.length,
        avgDeliveryDays,
        totalProposals: proposals.length
    };
}

function computeCustomerStats(companyName) {
    const orders = readData(ORDERS_FILE).filter(o => o.company === companyName);
    if (orders.length === 0) return null;
    return {
        postedOrders: orders.length,
        closedOrders: orders.filter(o => o.status === 'Закрыта').length
    };
}

function enrichCompany(c, ownerCompany) {
    let enriched;
    if (c.role === 'producer') {
        const rating = computeProducerRating(c.company);
        const stats = computeProducerStats(c.company);
        enriched = { ...c, ...(rating || {}), stats: stats || null };
    } else {
        const status = computeCustomerStatus(c.company);
        const stats = computeCustomerStats(c.company);
        enriched = { ...c, ...(status || {}), stats: stats || null };
    }
    if (ownerCompany) {
        const favorites = readData(FAVORITES_FILE);
        enriched.isFavorite = favorites.some(f => f.ownerCompany === ownerCompany && f.companyId === c.id);
    } else {
        enriched.isFavorite = false;
    }
    return enriched;
}

app.get('/api/companies', optionalAuth, (req, res) => {
    const companies = readData(COMPANIES_FILE);
    const ownerCompany = req.user ? req.user.company : null;
    res.json(companies.map(c => enrichCompany(c, ownerCompany)));
});

app.get('/api/companies/:id', optionalAuth, (req, res) => {
    const id = Number(req.params.id);
    const companies = readData(COMPANIES_FILE);
    const company = companies.find(c => c.id === id);
    if (!company) {
        return res.status(404).json({ error: 'Компания не найдена' });
    }
    res.json(enrichCompany(company, req.user ? req.user.company : null));
});

// Редактировать профиль — только свою собственную компанию.
app.put('/api/companies/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const companies = readData(COMPANIES_FILE);
    const company = companies.find(c => c.id === id);
    if (!company) {
        return res.status(404).json({ error: 'Компания не найдена' });
    }
    if (company.company !== req.user.company) {
        return res.status(403).json({ error: 'Можно редактировать только профиль своей компании' });
    }

    const { city, yearsExperience, about, equipment, specialization, phone, website } = req.body;
    if (city !== undefined) company.city = String(city).slice(0, 100);
    if (yearsExperience !== undefined) {
        const n = Number(yearsExperience);
        company.yearsExperience = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (about !== undefined) company.about = String(about).slice(0, 1000);
    if (specialization !== undefined) company.specialization = String(specialization).slice(0, 200);
    if (phone !== undefined) company.phone = String(phone).slice(0, 30);
    if (website !== undefined) company.website = String(website).slice(0, 200);
    if (equipment !== undefined && Array.isArray(equipment)) {
        company.equipment = equipment.map(e => String(e).slice(0, 60)).slice(0, 20);
    }

    writeData(COMPANIES_FILE, companies);
    res.json(enrichCompany(company, req.user.company));
});

// ===================== ИЗБРАННЫЕ ПОСТАВЩИКИ =====================

app.get('/api/favorites', requireAuth, (req, res) => {
    const favorites = readData(FAVORITES_FILE).filter(f => f.ownerCompany === req.user.company);
    const companies = readData(COMPANIES_FILE);
    const result = favorites
        .map(f => companies.find(c => c.id === f.companyId))
        .filter(Boolean)
        .map(c => enrichCompany(c, req.user.company));
    res.json(result);
});

app.post('/api/favorites', requireAuth, (req, res) => {
    const id = Number(req.body.companyId);
    if (!id) {
        return res.status(400).json({ error: 'Не указан ID компании' });
    }
    const companies = readData(COMPANIES_FILE);
    if (!companies.find(c => c.id === id)) {
        return res.status(404).json({ error: 'Компания не найдена' });
    }

    const favorites = readData(FAVORITES_FILE);
    if (favorites.some(f => f.ownerCompany === req.user.company && f.companyId === id)) {
        return res.status(200).json({ message: 'Уже в избранном' });
    }
    favorites.push({
        id: favorites.length > 0 ? Math.max(...favorites.map(f => f.id)) + 1 : 1,
        ownerCompany: req.user.company,
        companyId: id,
        createdAt: new Date().toISOString()
    });
    writeData(FAVORITES_FILE, favorites);
    res.status(201).json({ message: 'Добавлено в избранное' });
});

app.delete('/api/favorites/:companyId', requireAuth, (req, res) => {
    const id = Number(req.params.companyId);
    const favorites = readData(FAVORITES_FILE);
    const remaining = favorites.filter(f => !(f.ownerCompany === req.user.company && f.companyId === id));
    writeData(FAVORITES_FILE, remaining);
    res.json({ message: 'Удалено из избранного' });
});

// ===================== AUTH =====================
// Простая демо-авторизация на JSON-файлах, без хеширования/JWT —
// этот backend не предназначен для продакшена.

app.post('/api/auth/register', (req, res) => {
    const { email, password, company, inn, role } = req.body;
    if (!email || !password || !company || !role) {
        return res.status(400).json({ error: 'Заполните все поля регистрации' });
    }

    const users = readData(USERS_FILE);
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }

    const newUser = {
        id: users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1,
        email,
        password: hashPassword(password),
        role,
        company,
        inn: inn || ''
    };
    users.push(newUser);
    writeData(USERS_FILE, users);

    const companies = readData(COMPANIES_FILE);
    if (!companies.find(c => c.company === company && c.role === role)) {
        companies.push({
            id: companies.length > 0 ? Math.max(...companies.map(c => c.id)) + 1 : 1,
            company,
            inn: inn || '',
            role,
            specialization: '',
            status: 'На проверке',
            rating: null,
            ratingLabel: null,
            city: '',
            yearsExperience: null,
            about: '',
            equipment: []
        });
        writeData(COMPANIES_FILE, companies);
    }

    res.status(201).json({ token: 'token-' + newUser.id, role: newUser.role, company: newUser.company });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Укажите email и пароль' });
    }

    const users = readData(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user || !verifyPassword(password, user.password)) {
        return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    // Если пароль хранился открытым текстом — обновляем до хэша при первом входе
    if (!user.password.includes(':')) {
        user.password = hashPassword(password);
        writeData(USERS_FILE, users);
    }

    res.json({ token: 'token-' + user.id, role: user.role, company: user.company });
});

// ===================== ЧАТ ПО ЗАКУПКЕ =====================
// Тред определяется парой orderId + company (компания производителя,
// участвующего в обсуждении), сообщения видны обеим сторонам.

app.get('/api/messages/:orderId/:company', (req, res) => {
    const orderId = Number(req.params.orderId);
    const company = req.params.company;
    const messages = readData(MESSAGES_FILE);
    res.json(messages.filter(m => m.orderId === orderId && m.company === company));
});

app.post('/api/messages', requireAuth, (req, res) => {
    const { orderId, company, text } = req.body;
    if (!orderId || !company || !text) {
        return res.status(400).json({ error: 'Заполните все поля сообщения' });
    }

    const messages = readData(MESSAGES_FILE);
    const newMessage = {
        id: messages.length > 0 ? Math.max(...messages.map(m => m.id)) + 1 : 1,
        orderId: Number(orderId),
        company,
        sender: req.user.role,
        text: String(text).slice(0, 2000),
        createdAt: new Date().toISOString()
    };
    messages.push(newMessage);
    writeData(MESSAGES_FILE, messages);
    if (io) io.to(`chat:${newMessage.orderId}:${newMessage.company}`).emit('message', newMessage);
    res.status(201).json(newMessage);
});

// ===================== УВЕДОМЛЕНИЯ =====================
// Создаются автоматически сервером при событиях (новый отклик,
// принятие/отклонение КП) — см. addNotification() выше.

app.get('/api/notifications/:company', requireAuth, (req, res) => {
    if (req.params.company !== req.user.company) {
        return res.status(403).json({ error: 'Нет доступа к уведомлениям этой компании' });
    }
    const list = readData(NOTIFICATIONS_FILE)
        .filter(n => n.company === req.user.company)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
});

app.post('/api/notifications/:company/read', requireAuth, (req, res) => {
    if (req.params.company !== req.user.company) {
        return res.status(403).json({ error: 'Нет доступа' });
    }
    const notifications = readData(NOTIFICATIONS_FILE);
    notifications.forEach(n => { if (n.company === req.user.company) n.read = true; });
    writeData(NOTIFICATIONS_FILE, notifications);
    res.json({ message: 'ok' });
});

app.delete('/api/notifications/:company', requireAuth, (req, res) => {
    if (req.params.company !== req.user.company) {
        return res.status(403).json({ error: 'Нет доступа' });
    }
    const notifications = readData(NOTIFICATIONS_FILE).filter(n => n.company !== req.user.company);
    writeData(NOTIFICATIONS_FILE, notifications);
    res.json({ message: 'ok' });
});

httpServer.listen(PORT, () => {
    console.log(`Бэкенд-сервер успешно запущен на порту ${PORT}`);
});
