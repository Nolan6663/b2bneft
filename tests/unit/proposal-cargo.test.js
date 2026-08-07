'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createProposalsRouter = require('../../routes/proposals');
const { fakePool, serve, baseDeps, fakeAuth } = require('./helpers');
const { parseCargo, isCargoComplete, cargoToPlaces } = require('../../lib/logistics/cargo');

/* Габариты груза в КП. Спрашиваем у завода: он знает вес готового изделия,
   заказчик обычно нет.

   Главное требование — не сломать подачу КП. Поля необязательные, мусор в них
   не приводит к ошибке, а просто не сохраняется: терять предложение
   поставщика из-за вспомогательного поля недопустимо. */

test('разбор: нормальные значения проходят', () => {
    const cargo = parseCargo({ cargoWeight: '500', cargoLength: '1.2', cargoWidth: '0.8', cargoHeight: '0.6', cargoPlaces: '3' });
    assert.deepEqual(cargo, { weight: 500, length: 1.2, width: 0.8, height: 0.6, places: 3 });
});

test('разбор: запятая как разделитель — у нас так пишут чаще', () => {
    const cargo = parseCargo({ cargoLength: '1,25' });
    assert.equal(cargo.length, 1.25);
});

test('разбор: пустые поля дают null, а не ноль', () => {
    const cargo = parseCargo({});
    assert.deepEqual(cargo, { weight: null, length: null, width: null, height: null, places: null });
});

test('разбор: отрицательные и нулевые значения отбрасываются', () => {
    const cargo = parseCargo({ cargoWeight: '-100', cargoLength: '0', cargoWidth: 'абв' });
    assert.equal(cargo.weight, null);
    assert.equal(cargo.length, null);
    assert.equal(cargo.width, null);
});

test('разбор: заведомо невозможные величины отбрасываются', () => {
    const cargo = parseCargo({ cargoWeight: '999999', cargoLength: '500' });
    assert.equal(cargo.weight, null, '20 тонн — уже не сборный груз');
    assert.equal(cargo.height, null);
    assert.equal(cargo.length, null, '500 метров — опечатка, а не изделие');
});

test('разбор: дробное число мест округляется', () => {
    assert.equal(parseCargo({ cargoPlaces: '2.7' }).places, 3);
});

test('полнота: для расчёта нужны вес и все три размера', () => {
    assert.equal(isCargoComplete({ weight: 500, length: 1, width: 1, height: 1 }), true);
    assert.equal(isCargoComplete({ weight: 500, length: 1, width: 1, height: null }), false);
    assert.equal(isCargoComplete(null), false);
});

test('места: количество разворачивается в список для перевозчика', () => {
    const places = cargoToPlaces({ weight: 300, length: 1, width: 2, height: 0.5, places: 3 });
    assert.equal(places.length, 3);
    assert.deepEqual(places[0], { width: 2, length: 1, height: 0.5, weight: 300 });
});

test('места: не указано количество — считаем одно место', () => {
    assert.equal(cargoToPlaces({ weight: 300, length: 1, width: 1, height: 1, places: null }).length, 1);
});

test('места: неполные габариты не превращаются в груз', () => {
    assert.deepEqual(cargoToPlaces({ weight: 300, length: 1, width: 1, height: null }), []);
});

// --- приём в API -----------------------------------------------------------

function router({ inserted = [] } = {}) {
    const pool = fakePool([
        { match: /FROM orders WHERE id/i, rows: [{ id: 1, title: 'Манжеты РТИ', status: 'Активный', company: '' }] },
        { match: /SELECT id FROM proposals/i, rows: [] },
        { match: /INSERT INTO proposals/i, rows: (sql, params) => {
            inserted.push(params);
            return [{ id: 10, order_id: 1, price: 1000, days: 14, company: 'ООО Завод' }];
        } },
        { match: /UPDATE orders SET responses/i, rows: [] },
    ]);
    const deps = baseDeps({
        pool,
        requireAuth: fakeAuth({ id: 2, company: 'ООО Завод', role: 'producer', email: 'z@t.ru' }),
    });
    deps.withTransaction = async (fn) => fn(pool);
    return createProposalsRouter(deps);
}

test('КП с габаритами: значения уходят в базу', async () => {
    const inserted = [];
    const app = await serve('/api/proposals', router({ inserted }));
    try {
        const res = await app.request('/api/proposals', {
            method: 'POST',
            body: { orderId: 1, price: 1000, days: 14, cargoWeight: '500', cargoLength: '1.2', cargoWidth: '0.8', cargoHeight: '0.6', cargoPlaces: '2' },
        });
        assert.equal(res.status, 201);
        const params = inserted[0];
        assert.deepEqual(params.slice(-5), [500, 1.2, 0.8, 0.6, 2]);
    } finally { await app.close(); }
});

test('КП без габаритов подаётся как раньше', async () => {
    const inserted = [];
    const app = await serve('/api/proposals', router({ inserted }));
    try {
        const res = await app.request('/api/proposals', {
            method: 'POST',
            body: { orderId: 1, price: 1000, days: 14 },
        });
        assert.equal(res.status, 201, 'габариты необязательны');
        assert.deepEqual(inserted[0].slice(-5), [null, null, null, null, null]);
    } finally { await app.close(); }
});

test('мусор в габаритах не ломает подачу КП', async () => {
    const inserted = [];
    const app = await serve('/api/proposals', router({ inserted }));
    try {
        const res = await app.request('/api/proposals', {
            method: 'POST',
            body: { orderId: 1, price: 1000, days: 14, cargoWeight: '-5', cargoLength: 'метр', cargoHeight: '9999' },
        });
        assert.equal(res.status, 201, 'предложение поставщика важнее вспомогательного поля');
        assert.deepEqual(inserted[0].slice(-5), [null, null, null, null, null]);
    } finally { await app.close(); }
});
