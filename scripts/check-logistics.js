#!/usr/bin/env node
'use strict';

// Живая проверка API перевозчиков руками:
//
//   npm run check:logistics
//
// Сама проверка живёт в lib/logistics/health.js — её же зовёт недельный крон в
// server.js. Здесь только вывод в терминал и код возврата.
//
// В `npm test` не входит и входить не должна: падение чужого сайта не повод
// останавливать нашу выкатку. Базы данных не требует.

require('dotenv').config();

const { CARRIERS } = require('../lib/logistics');
const { checkAllCarriers, REFERENCE_CODES } = require('../lib/logistics/health');

async function main() {
    console.log(`Эталон: ${REFERENCE_CODES.from.name} → ${REFERENCE_CODES.to.name}, 1 м³, 500 кг\n`);

    const { results, broken } = await checkAllCarriers();

    for (const result of results) {
        console.log(`${result.ok ? 'OK  ' : 'СБОЙ'} ${result.carrierName} (${result.ms} мс)`);
        for (const q of result.quotes || []) {
            const days = q.days ? `${q.days.min}–${q.days.max} сут.` : 'срок не разобран';
            console.log(`       ${q.service}: ${q.price.total} руб., ${days}`);
        }
        for (const problem of result.problems) console.log(`       ! ${problem}`);
    }

    if (broken.length) {
        console.error(`\nСломано перевозчиков: ${broken.length} из ${CARRIERS.length} (${broken.join(', ')})`);
        process.exit(1);
    }
    console.log(`\nВсе перевозчики отвечают: ${CARRIERS.length} из ${CARRIERS.length}`);
}

main().catch((e) => {
    console.error('Проверка не выполнилась:', e.message);
    process.exit(1);
});
