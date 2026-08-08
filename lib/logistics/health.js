'use strict';

// Проверка живости API перевозчиков.
//
// Юниты гоняются на сохранённых ответах и в сеть не ходят — деплойный гейт не
// должен падать из-за чужого сайта. Но сохранённый ответ устаревает молча:
// расчёт ПЭК живёт в ajax-компоненте их Битрикса, путь и формат могут
// поменяться при первом же редизайне, и узнать об этом мы должны раньше
// заказчика.
//
// Отсюда отдельная проверка, которую зовут двое: `npm run check:logistics`
// руками и недельный крон в server.js. Ни та, ни другая в `npm test` не входят.

const { CARRIERS } = require('./index');

// Эталонный маршрут: Москва → Екатеринбург, одно место 1 м³, 500 кг.
// Коды у каждого перевозчика свои, поэтому точки описаны явно — добавляя
// перевозчика, добавьте ему коды сюда.
//
// Коды Деловых Линий 25-значные и взяты из их же поиска /v2/public/kladr.json.
// Тринадцатизначный КЛАДР у них не находится, а почтовый индекс молча
// подставляет чужой город (см. шапку lib/logistics/dellin.js).
const REFERENCE_CODES = {
    from: { id: 1, name: 'Москва', codes: { pecom: '-446', dellin: '7700000000000000000000000' } },
    to: { id: 2, name: 'Екатеринбург', codes: { pecom: '-473', dellin: '6600000100000000000000000' } },
};

const REFERENCE_PLACES = [{ width: 1, length: 1, height: 1, weight: 500 }];
const REFERENCE_INSURANCE = 100000;

// Границы здравого смысла. Цель — поймать не «цена выросла на 8%», а «формат
// поехал и мы разобрали мусор»: ноль, копейки или миллион вместо тарифа.
const MIN_TOTAL = 1000;
const MAX_TOTAL = 500000;
const MAX_DAYS = 60;

function checkQuote(quote) {
    const problems = [];
    const total = quote && quote.price && quote.price.total;

    if (!Number.isFinite(total)) {
        problems.push('итоговая цена не число');
    } else if (total < MIN_TOTAL || total > MAX_TOTAL) {
        problems.push(`итог ${total} руб. вне разумных границ ${MIN_TOTAL}–${MAX_TOTAL}`);
    }

    if (quote.days) {
        const { min, max } = quote.days;
        if (!Number.isFinite(min) || !Number.isFinite(max)) problems.push('срок не число');
        else if (min < 1 || max > MAX_DAYS || min > max) problems.push(`срок ${min}–${max} выглядит неправдоподобно`);
    }

    if (!quote.url) problems.push('нет ссылки на оформление');
    return problems;
}

async function checkCarrier(carrier) {
    const started = Date.now();
    let quotes;
    try {
        quotes = await carrier.quote({
            from: REFERENCE_CODES.from,
            to: REFERENCE_CODES.to,
            places: REFERENCE_PLACES,
            insurance: REFERENCE_INSURANCE,
        });
    } catch (e) {
        return { carrier: carrier.CARRIER, carrierName: carrier.CARRIER_NAME, ok: false, ms: Date.now() - started, problems: [`запрос не прошёл: ${e.message}`] };
    }

    const ms = Date.now() - started;
    const base = { carrier: carrier.CARRIER, carrierName: carrier.CARRIER_NAME, ms, quotes };

    if (!Array.isArray(quotes) || quotes.length === 0) {
        return { ...base, ok: false, problems: ['по эталонному маршруту не вернулось ни одного варианта'] };
    }

    const problems = [];
    quotes.forEach((q) => {
        checkQuote(q).forEach((p) => problems.push(`${q.service}: ${p}`));
    });

    // Срок хотя бы у одного варианта должен разбираться. Если ни у одного —
    // разметка на их стороне поменялась, и в таблице у всех будет прочерк.
    if (!quotes.some((q) => q.days)) problems.push('срок не разобрался ни у одного варианта');

    return { ...base, ok: problems.length === 0, problems };
}

/** Проверяет всех перевозчиков. Возвращает результаты и имена сломанных. */
async function checkAllCarriers(carriers = CARRIERS) {
    const results = [];
    for (const carrier of carriers) results.push(await checkCarrier(carrier));
    return { results, broken: results.filter((r) => !r.ok).map((r) => r.carrierName) };
}

/**
 * Текст тревоги о сломанном перевозчике.
 *
 * Отдельной функцией, потому что важно не «что-то сломалось», а что именно:
 * получатель должен из письма понять, идти чинить разбор ответа или ждать, пока
 * перевозчик поднимет свой сайт. Поэтому в тексте имена и конкретные претензии,
 * а не «проверка не прошла».
 */
function formatCarrierAlert(results, broken) {
    const lines = results
        .filter((r) => !r.ok)
        .map((r) => `${r.carrierName}: ${r.problems.join('; ')}`);
    const alive = results.filter((r) => r.ok).map((r) => r.carrierName);

    return {
        subject: `Расчёт доставки сломан: ${broken.join(', ')}`,
        text: [
            'Недельная проверка перевозчиков нашла проблемы.',
            '',
            ...lines,
            '',
            alive.length ? `Отвечают нормально: ${alive.join(', ')}` : 'Нормально не отвечает никто.',
            '',
            'Заказчики пока видят расчёт только по исправным перевозчикам —',
            'сломанный молча выпадает из выдачи, а не роняет расчёт.',
            '',
            'Проверить руками: npm run check:logistics',
        ].join('\n'),
    };
}

module.exports = {
    checkQuote,
    checkCarrier,
    checkAllCarriers,
    formatCarrierAlert,
    REFERENCE_CODES,
    REFERENCE_PLACES,
    MIN_TOTAL,
    MAX_TOTAL,
    MAX_DAYS,
};
