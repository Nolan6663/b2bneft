const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const PROPOSALS_FILE = path.join(__dirname, 'proposals.json');
const COMPANIES_FILE = path.join(__dirname, 'companies.json');
const USERS_FILE = path.join(__dirname, 'users.json');

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

// 2. Создать новую заявку
app.post('/api/orders', (req, res) => {
    const { title, category, deadline } = req.body;
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
        createdAt: new Date().toISOString()
    };

    orders.push(newOrder);
    writeData(ORDERS_FILE, orders);
    res.status(201).json(newOrder);
});

// ===================== PROPOSALS =====================

// 3. Отправить коммерческое предложение (КП)
app.post('/api/proposals', (req, res) => {
    const { orderId, orderTitle, price, days, company } = req.body;
    if (!orderId || !price || !days) {
        return res.status(400).json({ error: 'Не указаны ID заявки, цена или сроки' });
    }

    const proposals = readData(PROPOSALS_FILE);
    const orders = readData(ORDERS_FILE);

    const order = orders.find(o => o.id === Number(orderId));
    if (!order) {
        return res.status(404).json({ error: 'Заявка с таким ID не найдена' });
    }

    const newProposal = {
        id: proposals.length > 0 ? Math.max(...proposals.map(p => p.id)) + 1 : 1,
        orderId: Number(orderId),
        orderTitle: orderTitle || order.title,
        price: Number(price),
        days: Number(days),
        company: company || "Анонимный поставщик",
        status: 'Ожидает ответа',
        createdAt: new Date().toISOString()
    };

    proposals.push(newProposal);
    order.responses += 1;

    writeData(PROPOSALS_FILE, proposals);
    writeData(ORDERS_FILE, orders);

    res.status(201).json(newProposal);
});

// 4. Получить все предложения
app.get('/api/proposals', (req, res) => {
    res.json(readData(PROPOSALS_FILE));
});

// 5. Получить предложения для конкретной заявки
app.get('/api/order-proposals/:orderId', (req, res) => {
    const orderId = Number(req.params.orderId);
    const proposals = readData(PROPOSALS_FILE);
    const orderProposals = proposals.filter(p => p.orderId === orderId);
    res.json(orderProposals);
});

// 6. Выбрать победителя
app.post('/api/proposals/:proposalId/accept', (req, res) => {
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

    if (order.status === 'Закрыта') {
        return res.status(400).json({ error: 'Этот тендер уже завершен' });
    }

    order.status = 'Закрыта';

    proposals.forEach(p => {
        if (p.orderId === targetProposal.orderId) {
            if (p.id === proposalId) {
                p.status = 'Выигран';
            } else {
                p.status = 'Отклонен';
            }
        }
    });

    writeData(PROPOSALS_FILE, proposals);
    writeData(ORDERS_FILE, orders);

    res.json({ message: 'Победитель успешно определен, тендер закрыт' });
});

// 7. Редактировать предложение (только пока статус "Ожидает ответа")
app.put('/api/proposals/:proposalId', (req, res) => {
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
    if (target.status !== 'Ожидает ответа') {
        return res.status(400).json({ error: 'Можно редактировать только предложения в статусе "Ожидает ответа"' });
    }

    target.price = Number(price);
    target.days = Number(days);
    writeData(PROPOSALS_FILE, proposals);
    res.json(target);
});

// 8. Отозвать предложение
app.delete('/api/proposals/:proposalId', (req, res) => {
    const proposalId = Number(req.params.proposalId);
    const proposals = readData(PROPOSALS_FILE);
    const orders = readData(ORDERS_FILE);

    const target = proposals.find(p => p.id === proposalId);
    if (!target) {
        return res.status(404).json({ error: 'Предложение не найдено' });
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

app.get('/api/companies', (req, res) => {
    res.json(readData(COMPANIES_FILE));
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
        password,
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
            ratingLabel: null
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
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
    if (!user) {
        return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    res.json({ token: 'token-' + user.id, role: user.role, company: user.company });
});

app.listen(PORT, () => {
    console.log(`Бэкенд-сервер успешно запущен на порту ${PORT}`);
});
