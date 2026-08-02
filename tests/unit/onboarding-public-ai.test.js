'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPublicRouter = require('../../routes/public');
const { fakePool, serve, baseDeps } = require('./helpers');

// ИИ до регистрации — смысл всего мастера. Проверяем валидацию, чтобы пустые
// запросы не тратили вызовы модели, и переводы ошибок в человеческий текст.
function router(overrides = {}) {
    return createPublicRouter(baseDeps({
        pool: fakePool([{ match: /FROM companies/i, rows: [] }]),
        isTzAiConfigured: () => true,
        generateProcurementTz: async ({ brief }) => ({
            title: 'Манжеты уплотнительные',
            description: `1. Назначение\n${brief}`,
            checklist: ['Уточнить размеры'],
        }),
        analyzeDrawing: async () => ({ card: { part: 'Втулка', material: 'Сталь 45' }, model: 'GigaChat-2-Max', source: 'image' }),
        ...overrides,
    }));
}

test('гостевое ТЗ: короткий бриф превращается в задание', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/tz-draft', {
            method: 'POST',
            body: { brief: 'манжеты полиуретан 25 МПа', category: 'РТИ', quantity: 200 },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.title, 'Манжеты уплотнительные');
        assert.ok(res.json.description.includes('манжеты полиуретан'));
        assert.deepEqual(res.json.checklist, ['Уточнить размеры']);
    } finally { await srv.close(); }
});

test('гостевое ТЗ: пустой бриф — 400, к модели не идём', async () => {
    let called = false;
    const srv = await serve('/api', router({
        generateProcurementTz: async () => { called = true; return {}; },
    }));
    try {
        const res = await srv.request('/api/public/tz-draft', { method: 'POST', body: { brief: '   ' } });
        assert.equal(res.status, 400);
        assert.equal(called, false, 'пустой запрос не должен тратить вызов модели');
    } finally { await srv.close(); }
});

test('гостевое ТЗ: сбой модели отдаёт понятный текст, а не пятисотку', async () => {
    const srv = await serve('/api', router({
        generateProcurementTz: async () => { const e = new Error('Не удалось разобрать ответ модели'); e.code = 'AI_PARSE'; throw e; },
    }));
    try {
        const res = await srv.request('/api/public/tz-draft', { method: 'POST', body: { brief: 'манжеты' } });
        assert.equal(res.status, 502);
        assert.ok(res.json.error.length > 10);
    } finally { await srv.close(); }
});

test('гостевое ТЗ: без ключа модели мастер не встаёт колом', async () => {
    const srv = await serve('/api', router({ isTzAiConfigured: () => false }));
    try {
        const res = await srv.request('/api/public/tz-draft', { method: 'POST', body: { brief: 'манжеты полиуретан' } });
        assert.equal(res.status, 503);
        assert.ok(/вручную/i.test(res.json.error), 'подсказываем заполнить руками');
    } finally { await srv.close(); }
});

test('гостевой разбор чертежа: без файла — 400', async () => {
    const srv = await serve('/api', router());
    try {
        const res = await srv.request('/api/public/analyze-drawing', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('гостевой разбор чертежа: карточка детали доезжает до ответа', async () => {
    const srv = await serve('/api', router({
        handleDrawingImageUpload: (req, res, next) => {
            req.file = { buffer: Buffer.from('fake'), originalname: 'draw.png', mimetype: 'image/png' };
            next();
        },
    }));
    try {
        const res = await srv.request('/api/public/analyze-drawing', { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.equal(res.json.card.part, 'Втулка');
        assert.equal(res.json.model, 'GigaChat-2-Max');
    } finally { await srv.close(); }
});

test('гостевой разбор чертежа: неподходящий формат объясняется, а не падает', async () => {
    const srv = await serve('/api', router({
        handleDrawingImageUpload: (req, res, next) => {
            req.file = { buffer: Buffer.from('fake'), originalname: 'draw.dwg', mimetype: 'application/acad' };
            next();
        },
        analyzeDrawing: async () => { const e = new Error('DWG не поддерживается'); e.code = 'AI_FORMAT'; throw e; },
    }));
    try {
        const res = await srv.request('/api/public/analyze-drawing', { method: 'POST', body: {} });
        assert.equal(res.status, 415);
        assert.equal(res.json.error, 'DWG не поддерживается');
    } finally { await srv.close(); }
});
