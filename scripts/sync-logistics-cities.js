#!/usr/bin/env node
'use strict';

// Загрузка справочника городов ПЭК в logistics_cities.
//
// Справочник открытый: ни ключа, ни регистрации. Отдаётся одним куском примерно
// на 586 КБ, поэтому гоняем руками или по расписанию, а не при каждом расчёте.
//
//   node scripts/sync-logistics-cities.js          — записать в БД
//   node scripts/sync-logistics-cities.js --dry    — только показать, что вышло
//
// Города Деловых Линий (КЛАДР) здесь не заполняются: их коды добываются лениво,
// когда появится appKey (Task 6 плана 2026-08-08-logistics-calculator).

const { parsePecomTowns, saveCities, normalizeCityName } = require('../lib/logistics/geo');

const TOWNS_URL = 'https://pecom.ru/ru/calc/towns.php';

async function fetchPecomTowns() {
    const res = await fetch(TOWNS_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`ПЭК: справочник городов вернул ${res.status}`);
    return res.json();
}

async function main() {
    const dry = process.argv.includes('--dry');

    const payload = await fetchPecomTowns();
    const cities = parsePecomTowns(payload);
    const hubs = cities.filter((c) => c.isHub).length;

    const byKey = new Map();
    for (const c of cities) byKey.set(c.searchKey, (byKey.get(c.searchKey) || 0) + 1);
    const ambiguous = Array.from(byKey.values()).filter((n) => n > 1).length;

    console.log(`Справочник ПЭК: ${cities.length} записей, хабов ${hubs}, названий-двойников ${ambiguous}`);

    // Контрольные города: если их нет, что-то поменялось в формате ответа.
    // На 2026-08-08 было 4810 записей, 225 хабов, 307 двойников.
    for (const probe of ['Москва', 'Санкт-Петербург', 'Екатеринбург', 'Челябинск']) {
        const key = normalizeCityName(probe);
        const found = cities.find((c) => c.searchKey === key && c.isHub);
        console.log(`  ${probe.padEnd(18)} ${found ? `id=${found.pecomId} (${found.pecomHub})` : 'НЕ НАЙДЕН'}`);
    }

    if (dry) {
        console.log('--dry: в базу ничего не записано');
        return;
    }

    const { pool } = require('../db');
    const saved = await saveCities(pool, cities);
    console.log(`Записано в logistics_cities: ${saved}`);
    await pool.end();
}

main().catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
});
