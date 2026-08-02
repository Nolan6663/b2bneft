'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDrawingCard, isDrawingImage, analyzeDrawing } = require('../../lib/ai-client');

test('формат: картинки принимаем, чертёж в DWG и PDF — нет', () => {
    assert.ok(isDrawingImage('image/png'));
    assert.ok(isDrawingImage('image/JPEG'));
    assert.ok(!isDrawingImage('application/pdf'));
    assert.ok(!isDrawingImage('application/acad'));
    assert.ok(!isDrawingImage(''));
});

test('нормализация: русские ключи модели приводятся к нашим', () => {
    const card = normalizeDrawingCard({
        'деталь': ' Фланец ',
        'материал': 'Сталь 09Г2С',
        'операции': ['резка', 'точение'],
        'вопросы_к_заказчику': ['не указана шероховатость'],
    });
    assert.equal(card.part, 'Фланец');
    assert.equal(card.material, 'Сталь 09Г2С');
    assert.deepEqual(card.operations, ['резка', 'точение']);
    assert.deepEqual(card.questions, ['не указана шероховатость']);
});

test('нормализация: одиночная строка вместо списка не ломает карту', () => {
    const card = normalizeDrawingCard({ operations: 'фрезерование', controls: null });
    assert.deepEqual(card.operations, ['фрезерование']);
    assert.deepEqual(card.controls, []);
});

test('нормализация: пустые поля остаются пустыми строками, а не undefined', () => {
    const card = normalizeDrawingCard({});
    for (const k of ['part', 'designation', 'material', 'blank', 'quantity', 'tolerances', 'coating']) {
        assert.equal(card[k], '', `${k} должно быть пустой строкой`);
    }
    assert.deepEqual(card.operations, []);
});

test('нормализация: длинный список операций обрезается', () => {
    const card = normalizeDrawingCard({ operations: Array.from({ length: 30 }, (_, i) => `оп${i}`) });
    assert.equal(card.operations.length, 12);
});

test('разбор: без ключа отвечаем понятным кодом, а не падаем', async () => {
    const saved = { p: process.env.AI_TZ_PROVIDER, k: process.env.AI_TZ_API_KEY, g: process.env.GIGACHAT_API_KEY };
    process.env.AI_TZ_PROVIDER = 'gigachat';
    delete process.env.AI_TZ_API_KEY;
    delete process.env.GIGACHAT_API_KEY;
    try {
        await analyzeDrawing({ buffer: Buffer.from('x'), filename: 'd.png', mime: 'image/png' });
        assert.fail('должно было выбросить ошибку');
    } catch (e) {
        assert.equal(e.code, 'AI_NOT_CONFIGURED');
    } finally {
        if (saved.p !== undefined) process.env.AI_TZ_PROVIDER = saved.p;
        if (saved.k !== undefined) process.env.AI_TZ_API_KEY = saved.k;
        if (saved.g !== undefined) process.env.GIGACHAT_API_KEY = saved.g;
    }
});

test('разбор: чужой формат отсекается до обращения к модели', async () => {
    const saved = process.env.AI_TZ_API_KEY;
    process.env.AI_TZ_PROVIDER = 'gigachat';
    process.env.AI_TZ_API_KEY = 'тестовый-ключ';
    try {
        await analyzeDrawing({ buffer: Buffer.from('AC1027'), filename: 'd.dwg', mime: 'application/acad' });
        assert.fail('должно было выбросить ошибку');
    } catch (e) {
        assert.equal(e.code, 'AI_FORMAT');
        assert.match(e.message, /PDF|PNG|JPG/);
    } finally {
        if (saved === undefined) delete process.env.AI_TZ_API_KEY; else process.env.AI_TZ_API_KEY = saved;
    }
});

test('разбор: PDF-скан без текста не уходит модели, а объясняет причину', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const PDFDocument = require('pdfkit');

    const buf = await new Promise(resolve => {
        const file = path.join(os.tmpdir(), `tz-scan-card-${Date.now()}.pdf`);
        const doc = new PDFDocument({ size: 'A4', margin: 30 });
        const stream = fs.createWriteStream(file);
        doc.pipe(stream);
        doc.rect(60, 60, 300, 200).stroke();
        doc.end();
        stream.on('finish', () => resolve(fs.readFileSync(file)));
    });

    const saved = process.env.AI_TZ_API_KEY;
    process.env.AI_TZ_PROVIDER = 'gigachat';
    process.env.AI_TZ_API_KEY = 'тестовый-ключ';
    try {
        await analyzeDrawing({ buffer: buf, filename: 'scan.pdf', mime: 'application/pdf' });
        assert.fail('должно было выбросить ошибку');
    } catch (e) {
        assert.equal(e.code, 'AI_PDF_SCAN');
        assert.match(e.message, /скан|изображение/i);
    } finally {
        if (saved === undefined) delete process.env.AI_TZ_API_KEY; else process.env.AI_TZ_API_KEY = saved;
    }
});
