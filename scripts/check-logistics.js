#!/usr/bin/env node
'use strict';

// Живая проверка API перевозчиков.
//
//   npm run check:logistics
//
// Зачем отдельно от npm test: юниты гоняются на сохранённых ответах и в сеть не
// ходят — деплойный гейт не должен падать из-за чужого сайта. Но сохранённый
// ответ устаревает молча: у ПЭК расчёт живёт в ajax-компоненте их Битрикса,
// путь и формат могут поменяться при первом же редизайне, и узнать об этом мы
// должны раньше заказчика.
//
// Поэтому проверка отдельной командой: по расписанию или руками перед выкаткой,
// но НЕ в `npm test` и НЕ в CI-гейте.
//
// Базы данных не требует: перевозчики зовутся напрямую, мимо кэша.

const { CARRIERS } = require('../lib/logistics');

// Эталонный маршрут: Москва → Екатеринбург, одно место 1 м³, 500 кг.
// Коды у каждого перевозчика свои, поэтому точки описаны здесь явно —
// добавляя перевозчика, добавьте ему коды в эту таблицу.
const REFERENCE_CODES = {
    from: { id: 1, name: 'Москва', codes: { pecom: '-446', dellin: '7700000000000' } },
    to: { id: 2, name: 'Екатеринбург', codes: { pecom: '-473', dellin: '6600000100000' } },
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
        return { ok: false, ms: Date.now() - started, problems: [`запрос не прошёл: ${e.message}`] };
    }

    const ms = Date.now() - started;
    if (!Array.isArray(quotes) || quotes.length === 0) {
        return { ok: false, ms, problems: ['по эталонному маршруту не вернулось ни одного варианта'] };
    }

    const problems = [];
    quotes.forEach((q) => {
        checkQuote(q).forEach((p) => problems.push(`${q.service}: ${p}`));
    });

    // Срок хотя бы у одного варианта должен разбираться. Если ни у одного —
    // разметка на их стороне поменялась, и в таблице у всех будет прочерк.
    if (!quotes.some((q) => q.days)) problems.push('срок не разобрался ни у одного варианта');

    return { ok: problems.length === 0, ms, quotes, problems };
}

async function main() {
    console.log(`Эталон: ${REFERENCE_CODES.from.name} → ${REFERENCE_CODES.to.name}, 1 м³, 500 кг\n`);

    let broken = 0;
    for (const carrier of CARRIERS) {
        const result = await checkCarrier(carrier);
        const mark = result.ok ? 'OK  ' : 'СБОЙ';
        console.log(`${mark} ${carrier.CARRIER_NAME} (${result.ms} мс)`);

        for (const q of result.quotes || []) {
            const days = q.days ? `${q.days.min}–${q.days.max} сут.` : 'срок не разобран';
            console.log(`       ${q.service}: ${q.price.total} руб., ${days}`);
        }
        for (const problem of result.problems) console.log(`       ! ${problem}`);
        if (!result.ok) broken += 1;
    }

    if (broken > 0) {
        console.error(`\nСломано перевозчиков: ${broken} из ${CARRIERS.length}`);
        process.exit(1);
    }
    console.log(`\nВсе перевозчики отвечают: ${CARRIERS.length} из ${CARRIERS.length}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error('Проверка не выполнилась:', e.message);
        process.exit(1);
    });
}

module.exports = { checkQuote, checkCarrier, MIN_TOTAL, MAX_TOTAL, MAX_DAYS };
