'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAiRouter = require('../../routes/ai');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const PRODUCER = { id: 2, company: 'ООО Завод', role: 'producer' };

function deps({ pool, canAccess = async () => true, storage } = {}) {
    return baseDeps({
        pool: pool || fakePool([]),
        requireAuth: fakeAuth(PRODUCER),
        canAccessOrderDrawing: canAccess,
        storage: storage || { readFileBuffer: async () => ({ buffer: Buffer.from('%PDF-'), mime: 'application/pdf' }) },
    });
}

test('чертёж закупки: без orderId — 400', async () => {
    const srv = await serve('/api', createAiRouter(deps({})));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: {} });
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('чертёж закупки: чужая закупка — 403 и в базу не лезем', async () => {
    const pool = fakePool([]);
    const srv = await serve('/api', createAiRouter(deps({ pool, canAccess: async () => false })));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: { orderId: 7 } });
        assert.equal(r.status, 403);
        assert.equal(pool.calls.length, 0, 'без права доступа запрос к базе не нужен');
    } finally { await srv.close(); }
});

test('чертёж закупки: закупка без файла — 404', async () => {
    const pool = fakePool([{ match: /SELECT drawing FROM orders/i, rows: [{ drawing: null }] }]);
    const srv = await serve('/api', createAiRouter(deps({ pool })));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: { orderId: 7 } });
        assert.equal(r.status, 404);
        assert.match(r.json.error, /чертёж/i);
    } finally { await srv.close(); }
});

test('чертёж закупки: битый JSON в колонке не роняет сервер', async () => {
    const pool = fakePool([{ match: /SELECT drawing FROM orders/i, rows: [{ drawing: '{не json' }] }]);
    const srv = await serve('/api', createAiRouter(deps({ pool })));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: { orderId: 7 } });
        assert.equal(r.status, 404);
    } finally { await srv.close(); }
});

test('чертёж закупки: слишком большой файл — 413 с понятным текстом', async () => {
    const pool = fakePool([{ match: /SELECT drawing FROM orders/i, rows: [{ drawing: JSON.stringify({ storedName: 'a.pdf', originalName: 'сборка.pdf' }) }] }]);
    const storage = {
        readFileBuffer: async () => { const e = new Error('too big'); e.code = 'FILE_TOO_BIG'; throw e; },
    };
    const srv = await serve('/api', createAiRouter(deps({ pool, storage })));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: { orderId: 7 } });
        assert.equal(r.status, 413);
        assert.match(r.json.error, /большой/i);
    } finally { await srv.close(); }
});

test('чертёж закупки: файла нет в хранилище — 404, а не пятисотка', async () => {
    const pool = fakePool([{ match: /SELECT drawing FROM orders/i, rows: [{ drawing: JSON.stringify({ storedName: 'a.pdf' }) }] }]);
    const storage = {
        readFileBuffer: async () => { const e = new Error('нет файла'); e.code = 'FILE_NOT_FOUND'; throw e; },
    };
    const srv = await serve('/api', createAiRouter(deps({ pool, storage })));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: { orderId: 7 } });
        assert.equal(r.status, 404);
    } finally { await srv.close(); }
});

test('чертёж закупки: DWG отбивается как формат, а не как сбой', async () => {
    const saved = { p: process.env.AI_TZ_PROVIDER, k: process.env.AI_TZ_API_KEY };
    process.env.AI_TZ_PROVIDER = 'gigachat';
    process.env.AI_TZ_API_KEY = 'тестовый-ключ';
    const pool = fakePool([{ match: /SELECT drawing FROM orders/i, rows: [{ drawing: JSON.stringify({ storedName: 'a.dwg', originalName: 'узел.dwg' }) }] }]);
    const storage = { readFileBuffer: async () => ({ buffer: Buffer.from('AC1027'), mime: 'application/acad' }) };
    const srv = await serve('/api', createAiRouter(deps({ pool, storage })));
    try {
        const r = await srv.request('/api/ai/analyze-order-drawing', { method: 'POST', body: { orderId: 7 } });
        assert.equal(r.status, 415);
        assert.match(r.json.error, /PDF|PNG/);
    } finally {
        await srv.close();
        if (saved.p !== undefined) process.env.AI_TZ_PROVIDER = saved.p; else delete process.env.AI_TZ_PROVIDER;
        if (saved.k !== undefined) process.env.AI_TZ_API_KEY = saved.k; else delete process.env.AI_TZ_API_KEY;
    }
});
