const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const PROPOSALS_FILE = path.join(__dirname, 'proposals.json');

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
        { id: 1, title: "Манжета резиновая армированная", category: "РТИ", status: "Активный", responses: 0, deadline: "25.05.2026" },
        { id: 2, title: "Фланец стальной ГОСТ", category: "Металл", status: "Активный", responses: 0, deadline: "28.05.2026" }
    ];
    writeData(ORDERS_FILE, initialOrders);
}

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
        deadline
    };

    orders.push(newOrder);
    writeData(ORDERS_FILE, orders);
    res.status(201).json(newOrder);
});

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
        status: 'Ожидает ответа'
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

app.listen(PORT, () => {
    console.log(`Бэкенд-сервер успешно запущен на порту ${PORT}`);
});