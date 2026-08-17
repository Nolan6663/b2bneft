'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createLogisticsRouter = require('../../routes/logistics');
const { buildQuotesWorkbook } = require('../../lib/logistics/quote-xlsx');
const { DISCLAIMER, quoteRows, cargoLabel, doorsLabel } = require('../../lib/logistics/quote-doc');
const { fakePool, serve, baseDeps } = require('./helpers');

/* Выгрузка расчёта доставки в PDF и Excel.

   Просьба от двух компаний через партнёра: расчёт нужен не на экране, а в
   папке — объяснить своим, почему из трёх перевозчиков выбран этот.

   Проверяем то, на чём такая выгрузка врёт: что цифры в документе считает
   сервер, а не присылает клиент; что оговорка про публичный тариф на месте;
   что пустой расчёт не превращается в файл с одной шапкой. */

const CITY = { id: 1, name: 'Москва', codes: {} };
const CITY2 = { id: 2, name: 'Екатеринбург', codes: {} };

const QUOTES = [
    { carrier: 'dellin', carrierName: 'Деловые Линии', service: 'auto', days: { min: 3, max: 4 },
      price: { total: 18740, line: 11200, pickup: 3100, delivery: 4440, insurance: 890 }, url: 'https://dellin.ru' },
    { carrier: 'pecom', carrierName: 'ПЭК', service: 'auto', days: { min: 4, max: 6 },
      price: { total: 21350, line: 13600, pickup: 3400, delivery: 4350 }, url: 'https://pecom.ru' },
];

const BODY = { from: 'Москва', to: 'Екатеринбург', weight: 57, length: 1, width: 0.8, height: 0.6, places: 3 };

function router({ quotes = QUOTES, failed = [], spy = {} } = {}) {
    const pool = fakePool([
        { match: /FROM logistics_cities/i, rows: (sql, params) => {
            const q = String(params && params[0] || '').toLowerCase();
            return q.includes('екат') ? [CITY2] : [CITY];
        } },
        { match: /UPDATE logistics_cities/i, rows: [] },
    ]);
    return createLogisticsRouter(baseDeps({
        pool,
        quoteAll: async (_pool, params) => {
            spy.params = params;
            return { quotes, failed, fromCache: [] };
        },
        dellinLookup: async () => null,
        vozovozLookup: async () => null,
        canAccessProposal: () => true,
    }));
}

test('PDF отдаётся как файл и собирается на сервере, а не из присланных цифр', async () => {
    const spy = {};
    const srv = await serve('/api/logistics', router({ spy }));
    try {
        const res = await srv.request('/api/logistics/public-quote/export.pdf', {
            method: 'POST',
            // Клиент подсовывает свои цены — они не должны никуда попасть.
            body: { ...BODY, quotes: [{ carrierName: 'Мойперевозчик', price: { total: 1 } }] },
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /application\/pdf/);
        assert.match(res.headers.get('content-disposition') || '', /attachment/);
        assert.ok(res.buf.length > 1000, 'пустой PDF — значит документ не собрался');
        assert.equal(res.buf.slice(0, 4).toString('latin1'), '%PDF');

        assert.ok(spy.params, 'сервер обязан пересчитать сам');
        assert.equal(spy.params.places.length, 3, 'мест столько, сколько указал человек');
    } finally { await srv.close(); }
});

test('Excel отдаётся как книга, а не как HTML с ошибкой', async () => {
    const srv = await serve('/api/logistics', router());
    try {
        const res = await srv.request('/api/logistics/public-quote/export.xlsx', { method: 'POST', body: BODY });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /spreadsheetml\.sheet/);
        // xlsx — это zip, и начинается он с PK.
        assert.equal(res.buf.slice(0, 2).toString('latin1'), 'PK');
    } finally { await srv.close(); }
});

test('пустой расчёт не превращается в файл', async () => {
    const srv = await serve('/api/logistics', router({ quotes: [], failed: ['ПЭК'] }));
    try {
        for (const kind of ['pdf', 'xlsx']) {
            const res = await srv.request(`/api/logistics/public-quote/export.${kind}`, { method: 'POST', body: BODY });
            assert.equal(res.status, 422, `${kind}: выгружать нечего`);
            assert.match(res.json.error, /нечего/i);
        }
    } finally { await srv.close(); }
});

test('негодные габариты отклоняются так же, как в самом расчёте', async () => {
    const srv = await serve('/api/logistics', router());
    try {
        const res = await srv.request('/api/logistics/public-quote/export.pdf', {
            method: 'POST',
            body: { ...BODY, weight: '' },
        });
        assert.equal(res.status, 422);
        assert.equal(res.json.reason, 'no_cargo');
    } finally { await srv.close(); }
});

test('в книге есть маршрут, груз, оговорка и все перевозчики', async () => {
    const wb = buildQuotesWorkbook({
        from: { name: 'Москва' }, to: { name: 'Екатеринбург' },
        cargo: { weight: 57, length: 1, width: 0.8, height: 0.6, places: 3 },
        doorFrom: true, doorTo: false, quotes: QUOTES, failed: ['Возовоз'],
    });
    const ws = wb.getWorksheet('Доставка');
    const text = [];
    ws.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
    const all = text.join(' | ');

    assert.match(all, /Москва → Екатеринбург/);
    assert.match(all, /57 кг/);
    assert.match(all, /до терминала/, 'снятая доставка до адреса меняет цену — это должно быть видно');
    assert.match(all, /Деловые Линии/);
    assert.match(all, /ПЭК/);
    assert.match(all, /Возовоз/, 'кто не ответил — часть обоснования');
    assert.ok(all.includes(DISCLAIMER.slice(0, 40)), 'без оговорки документ обещает нашу цену');

    // Цены — числа, иначе первое же СУММ в чужой таблице даст ноль.
    const totals = [];
    ws.eachRow((row) => { const v = row.getCell(7).value; if (typeof v === 'number') totals.push(v); });
    assert.deepEqual(totals, [18740, 21350]);
});

test('строки документа повторяют экран: состав цены и «дешевле»', () => {
    const rows = quoteRows(QUOTES);
    assert.equal(rows[0].cheapest, true, 'первый в списке — самый дешёвый, как и на экране');
    assert.equal(rows[1].cheapest, false);
    // Пробел в разряде — неразрывный, как и на экране: там тот же Intl.
    assert.equal(rows[0].breakdown.replace(/ /g, ' '), 'плечо 11 200, забор 3 100, доставка 4 440');
    assert.equal(rows[0].insurance, 890, 'страхование отдельной строкой и не в итоге');
    assert.equal(rows[0].total, 18740);
    assert.equal(rows[0].days, '3–4 сут.');
    assert.equal(cargoLabel({ weight: 57, length: 1, width: 0.8, height: 0.6, places: 3 }), '57 кг · 1×0.8×0.6 м, мест 3');
    assert.equal(doorsLabel(false, true), 'от терминала, доставка до адреса');
});
