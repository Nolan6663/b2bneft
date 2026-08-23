'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkQuote, checkCarrier, checkAllCarriers, formatCarrierAlert } = require('../../lib/logistics/health');

/* Живая проверка перевозчиков (npm run check:logistics). Сам скрипт ходит в
   сеть, но его правила годности — обычные функции, и здесь они проверяются
   без сети.

   Смысл этих правил не в том, чтобы ловить изменение тарифа на 8%, а в том,
   чтобы поймать «формат ответа поехал, и мы разобрали мусор»: ноль вместо
   цены, миллион вместо тарифа, неразобранный срок. */

function goodQuote(extra = {}) {
    return {
        service: 'auto',
        price: { total: 17582, line: 12900, pickup: 2650, delivery: 1350, insurance: 682 },
        days: { min: 4, max: 7 },
        url: 'https://pecom.ru/calculator/',
        ...extra,
    };
}

test('нормальный ответ нареканий не вызывает', () => {
    assert.deepEqual(checkQuote(goodQuote()), []);
});

test('ноль вместо цены — сломанный разбор, а не бесплатная доставка', () => {
    const problems = checkQuote(goodQuote({ price: { total: 0 } }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /вне разумных границ/);
});

test('миллион за куб по России — тоже сломанный разбор', () => {
    assert.match(checkQuote(goodQuote({ price: { total: 1000000 } }))[0], /вне разумных границ/);
});

test('цена не число', () => {
    assert.match(checkQuote(goodQuote({ price: { total: null } }))[0], /не число/);
});

test('перевёрнутый и неправдоподобный срок', () => {
    assert.match(checkQuote(goodQuote({ days: { min: 9, max: 2 } }))[0], /неправдоподобно/);
    assert.match(checkQuote(goodQuote({ days: { min: 1, max: 400 } }))[0], /неправдоподобно/);
});

test('нет ссылки на оформление', () => {
    assert.match(checkQuote(goodQuote({ url: '' }))[0], /ссылки/);
});

test('упавший перевозчик помечается сбоем', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => { throw new Error('502'); } };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /запрос не прошёл/);
});

test('пустой ответ по эталонному маршруту — сбой', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => [] };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /ни одного варианта/);
});

test('ни у одного варианта не разобрался срок — сбой', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => [goodQuote({ days: null })] };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /срок не разобрался/);
});

test('исправный перевозчик проходит', async () => {
    const carrier = { CARRIER: 'x', CARRIER_NAME: 'X', quote: async () => [goodQuote()] };
    const res = await checkCarrier(carrier);
    assert.equal(res.ok, true);
    assert.deepEqual(res.problems, []);
});

test('сводка называет поимённо тех, кто сломался', async () => {
    const { broken, results } = await checkAllCarriers([
        { CARRIER: 'ok', CARRIER_NAME: 'Живой', quote: async () => [goodQuote()] },
        { CARRIER: 'bad', CARRIER_NAME: 'Мёртвый', quote: async () => { throw new Error('502'); } },
    ]);
    assert.deepEqual(broken, ['Мёртвый'], 'в тревогу должно попасть имя, а не «один из двух»');
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
});

test('все живы — список сломанных пуст', async () => {
    const { broken } = await checkAllCarriers([
        { CARRIER: 'ok', CARRIER_NAME: 'Живой', quote: async () => [goodQuote()] },
    ]);
    assert.deepEqual(broken, []);
});

test('в тревоге написано, что именно сломалось, а не «проверка не прошла»', () => {
    const results = [
        { carrierName: 'Живой', ok: true, problems: [] },
        { carrierName: 'Мёртвый', ok: false, problems: ['запрос не прошёл: 502'] },
    ];
    const alert = formatCarrierAlert(results, ['Мёртвый']);

    assert.match(alert.subject, /Мёртвый/, 'имя должно быть видно уже в теме письма');
    assert.match(alert.text, /запрос не прошёл: 502/, 'без конкретной претензии письмо бесполезно');
    assert.match(alert.text, /Отвечают нормально: Живой/, 'видно, что сломалось не всё');
    assert.match(alert.text, /npm run check:logistics/, 'подсказка, чем проверить руками');
});

test('когда не отвечает никто, это сказано прямо', () => {
    const results = [{ carrierName: 'Мёртвый', ok: false, problems: ['502'] }];
    const alert = formatCarrierAlert(results, ['Мёртвый']);
    assert.match(alert.text, /Нормально не отвечает никто/);
});

test('публичная страница доставки не обещает меньше перевозчиков, чем считает', () => {
    /* Описание /dostavka пережило подключение третьего перевозчика и пять дней
       обещало двоих: страница считала по ПЭК, Деловым и Возовозу, а в выдаче
       стояло «ПЭК и Деловые Линии». Такое расхождение живёт долго, потому что
       глазами его на странице не видно — оно только в мета-теге. */
    const fs = require('fs');
    const path = require('path');
    const { CARRIERS } = require('../../lib/logistics');
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dostavka.html'), 'utf8');
    const meta = [...html.matchAll(/<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]+)"/g)].map(m => m[1]);
    assert.ok(meta.length >= 2, 'не нашлись description и og:description');
    for (const text of meta) {
        for (const carrier of CARRIERS) {
            assert.ok(text.includes(carrier.CARRIER_NAME), `в описании нет перевозчика «${carrier.CARRIER_NAME}»: ${text}`);
        }
    }
});
