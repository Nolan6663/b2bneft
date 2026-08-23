'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dadata = require('../../lib/logistics/dadata');
const { routeLabel } = require('../../lib/logistics/quote-doc');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Адрес в расчёте доставки (24.08.2026).
 *
 * Заказчик дважды просил «от точного адреса до точного адреса». Сделано так:
 * подсказки дают полный адрес, город из него достаётся для расчёта, а сам
 * адрес едет в документы. Цену адрес не меняет — перевозчики считают забор и
 * доставку по городской зоне, и это отдельно проверяется ниже. */

test('город достаётся из адреса по убыванию точности', () => {
    const city = dadata.normalize({ value: 'г Москва, ул Тверская, д 1', data: { city: 'Москва', region_with_type: 'г Москва' } });
    assert.equal(city.city, 'Москва');

    // Посёлок: города в ответе нет, но доставка туда идёт — берём населённый пункт.
    const village = dadata.normalize({ value: 'Тульская обл, п Ленинский, ул Ленина, д 5', data: { settlement: 'Ленинский', region_with_type: 'Тульская обл' } });
    assert.equal(village.city, 'Ленинский');

    // Совсем без привязки к пункту — остаётся регион, расчёт хотя бы не пустой.
    const region = dadata.normalize({ value: 'Тульская обл', data: { region: 'Тульская' } });
    assert.equal(region.city, 'Тульская');
});

test('без ключа и на коротком запросе в чужой сервис не ходим', async () => {
    const key = process.env.DADATA_API_KEY;
    const realFetch = global.fetch;
    let called = 0;
    global.fetch = async () => { called++; throw new Error('в сеть ходить не должны'); };
    try {
        delete process.env.DADATA_API_KEY;
        assert.equal(dadata.isConfigured(), false);
        assert.deepEqual(await dadata.suggestAddress('Москва Тверская'), [], 'без ключа должен быть пустой список');

        process.env.DADATA_API_KEY = 'x'.repeat(20);
        assert.deepEqual(await dadata.suggestAddress('мо'), [], 'запрос короче трёх знаков — не повод тратить квоту');
        assert.equal(called, 0, `сходили в сеть ${called} раз(а)`);
    } finally {
        global.fetch = realFetch;
        if (key === undefined) delete process.env.DADATA_API_KEY; else process.env.DADATA_API_KEY = key;
    }
});

test('подсказка без города до расчёта не доходит', async () => {
    const key = process.env.DADATA_API_KEY;
    const realFetch = global.fetch;
    process.env.DADATA_API_KEY = 'y'.repeat(20);
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            suggestions: [
                { value: 'г Казань, ул Баумана, д 1', data: { city: 'Казань' } },
                // Страна целиком: города нет, считать по такому адресу нечего.
                { value: 'Россия', data: {} },
            ],
        }),
    });
    try {
        const out = await dadata.suggestAddress('казань баумана 1 уникальный запрос');
        assert.equal(out.length, 1);
        assert.equal(out[0].city, 'Казань');
    } finally {
        global.fetch = realFetch;
        if (key === undefined) delete process.env.DADATA_API_KEY; else process.env.DADATA_API_KEY = key;
    }
});

test('в документах адрес вытесняет город, а без адреса остаётся город', () => {
    const withAddress = routeLabel({
        from: { name: 'Москва', address: 'г Москва, Варшавское шоссе, д 132' },
        to: { name: 'Екатеринбург', address: 'г Екатеринбург, ул Малышева, д 51' },
    });
    assert.match(withAddress, /Варшавское шоссе, д 132 → г Екатеринбург/);

    const cityOnly = routeLabel({ from: { name: 'Москва' }, to: { name: 'Екатеринбург' } });
    assert.equal(cityOnly, 'Москва → Екатеринбург');

    // Половина маршрута с адресом — обычное дело: склад известен, получатель нет.
    const mixed = routeLabel({ from: { name: 'Москва', address: 'г Москва, ул Тверская, д 1' }, to: { name: 'Пермь' } });
    assert.equal(mixed, 'г Москва, ул Тверская, д 1 → Пермь');
});

test('формы расчёта шлют город отдельно от адреса', () => {
    /* Ключевое место всей затеи: в поле лежит адрес, а перевозчику нужен
       город. Если сюда однажды вернётся `from: value`, расчёт начнёт искать
       город по строке «г Москва, Варшавское шоссе, д 132» и не найдёт. */
    for (const page of ['dostavka.html', 'deliveries.html']) {
        const html = read(page);
        assert.match(html, /attachAddressSuggest/, `${page}: подсказки адресов не подключены`);
        assert.match(html, /fromAddress:/, `${page}: адрес не уходит в запрос`);
        assert.match(html, /dataset\.city/, `${page}: город не берётся из выбранного адреса`);
        assert.ok(!/from: val\('dvFrom'\)\.trim\(\)/.test(html), `${page}: город снова берётся из поля целиком`);
    }
});

test('подсказки адресов ограничены по частоте отдельно от общего потолка', () => {
    // Квота DaData общая на аккаунт: 10 000 подсказок в сутки. Без своего
    // потолка её выжигают с одного адреса, и расчёт встаёт у всех.
    const server = read('server.js');
    assert.match(server, /addressSuggestLimiter/);
    assert.match(server, /app\.get\('\/api\/logistics\/addresses', addressSuggestLimiter\)/);
});
