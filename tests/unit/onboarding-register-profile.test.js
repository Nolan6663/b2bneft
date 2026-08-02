'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');

// Мастер /zavod собирает профиль до регистрации и отдаёт его одним телом запроса.
// Проверяем, что поля доезжают до companies, мусор в операциях не пролезает, а
// чужая (уже присвоенная) карточка не переписывается.
function setup({ stub = null } = {}) {
    const calls = [];
    const pool = fakePool([
        { match: /FROM users WHERE LOWER\(email\)/i, rows: [] },
        { match: /FROM companies WHERE company = \$1 AND role = \$2 AND claimed = true/i, rows: [] },
        { match: /INSERT INTO users/i, rows: [{ id: 1, email: 'z@z.ru', company: 'ООО Завод', role: 'producer' }] },
        { match: /INSERT INTO refresh_tokens/i, rows: [] },
        { match: /SELECT id FROM companies WHERE inn/i, rows: stub ? [stub] : [] },
        { match: /UPDATE companies SET/i, rows: (sql, params) => { calls.push({ kind: 'update', sql, params }); return []; } },
        { match: /INSERT INTO companies/i, rows: (sql, params) => { calls.push({ kind: 'insert', sql, params }); return []; } },
    ]);
    const router = createAuthRouter(baseDeps({ pool, withTransaction: async (fn) => fn(pool) }));
    return { router, calls };
}

const BODY = {
    email: 'z@z.ru', password: 'parol1234', company: 'ООО Завод', inn: '1832000000',
    role: 'producer', consent: true,
    profile: {
        phone: '+7 900 111-22-33', website: 'zavod.ru', city: 'Ижевск',
        products: 'манжеты, кольца', capabilities: ['svarka', 'chpu'], productionLoad: 40,
    },
};

test('регистрация с профилем: поля мастера доезжают до companies', async () => {
    const { router, calls } = setup({ stub: { id: 7 } });
    const srv = await serve('/api/auth', router);
    try {
        const res = await srv.request('/api/auth/register', { method: 'POST', body: BODY });
        assert.ok(res.status === 200 || res.status === 201, `регистрация должна пройти, получили ${res.status}: ${JSON.stringify(res.json)}`);
        const dump = JSON.stringify(calls);
        assert.ok(dump.includes('+7 900 111-22-33'), 'телефон записан');
        assert.ok(dump.includes('Ижевск'), 'город записан');
        assert.ok(dump.includes('svarka'), 'операции записаны');
        assert.ok(dump.includes('манжеты, кольца'), 'продукция записана');
    } finally { await srv.close(); }
});

test('регистрация без профиля работает как раньше', async () => {
    const { router } = setup();
    const srv = await serve('/api/auth', router);
    try {
        const body = { ...BODY };
        delete body.profile;
        const res = await srv.request('/api/auth/register', { method: 'POST', body });
        assert.ok(res.status === 200 || res.status === 201, `получили ${res.status}: ${JSON.stringify(res.json)}`);
    } finally { await srv.close(); }
});

test('операции из профиля фильтруются по справочнику', async () => {
    const { router, calls } = setup({ stub: { id: 7 } });
    const srv = await serve('/api/auth', router);
    try {
        await srv.request('/api/auth/register', {
            method: 'POST',
            body: { ...BODY, profile: { ...BODY.profile, capabilities: ['svarka', '<script>', 'нет-такой-операции'] } },
        });
        const dump = JSON.stringify(calls);
        assert.ok(dump.includes('svarka'));
        assert.ok(!dump.includes('<script>'), 'мусор в операции не пролезает');
        assert.ok(!dump.includes('нет-такой-операции'), 'выдуманная операция не пролезает');
    } finally { await srv.close(); }
});

test('пустые поля профиля не затирают данные реестра', async () => {
    const { router, calls } = setup({ stub: { id: 7 } });
    const srv = await serve('/api/auth', router);
    try {
        await srv.request('/api/auth/register', {
            method: 'POST',
            body: { ...BODY, profile: { phone: '', website: '', city: 'Ижевск', products: '', capabilities: [], productionLoad: null } },
        });
        const update = calls.find(c => c.kind === 'update');
        assert.ok(update, 'стаб должен присваиваться через UPDATE');
        assert.ok(!update.params.includes(''), 'пустые строки в UPDATE не уходят');
        assert.ok(update.params.includes('Ижевск'), 'непустое значение записывается');
    } finally { await srv.close(); }
});

test('чужой ИНН: занятую карточку не трогаем, заводим свою', async () => {
    const { router, calls } = setup();
    const srv = await serve('/api/auth', router);
    try {
        await srv.request('/api/auth/register', { method: 'POST', body: { ...BODY, email: 'x@z.ru', company: 'ООО Другой' } });
        assert.ok(!calls.some(c => c.kind === 'update'), 'занятую карточку не переписываем');
        assert.ok(calls.some(c => c.kind === 'insert'), 'заводим новую компанию');
    } finally { await srv.close(); }
});
