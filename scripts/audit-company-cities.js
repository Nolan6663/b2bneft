#!/usr/bin/env node
'use strict';

// Отчёт: сколько городов из профилей компаний узнаёт расчёт доставки.
//
//   npm run audit:cities
//
// Ничего не меняет. Только читает companies.city и прогоняет через тот же
// resolveCity, которым пользуется расчёт, — то есть показывает ровно ту
// картину, которую видит заказчик, нажимая «Рассчитать доставку».
//
// Чинить молча нельзя: «Белый Яр» под Абаканом и под Сургутом одинаково
// правдоподобны, и выбрать за человека мы не вправе. Задача отчёта — показать
// масштаб и назвать конкретные записи, а решение принимает владелец.

require('dotenv').config();

const { pool } = require('../db');
const { resolveCity } = require('../lib/logistics/geo');

function pad(value, width) {
    return String(value).padEnd(width);
}

async function main() {
    const { rows } = await pool.query(
        `SELECT id, company, city, role FROM companies ORDER BY id`
    );

    const buckets = { ok: [], ambiguous: [], not_found: [], empty: [] };

    for (const row of rows) {
        if (!String(row.city || '').trim()) { buckets.empty.push(row); continue; }
        const found = await resolveCity(pool, row.city);
        buckets[found.status].push({ ...row, candidates: found.candidates });
    }

    const total = rows.length;
    const share = (n) => (total ? Math.round((n / total) * 100) : 0);

    console.log(`Компаний всего: ${total}\n`);
    console.log(`  ${pad('распознаётся', 22)} ${pad(buckets.ok.length, 6)} ${share(buckets.ok.length)}%`);
    console.log(`  ${pad('город не заполнен', 22)} ${pad(buckets.empty.length, 6)} ${share(buckets.empty.length)}%`);
    console.log(`  ${pad('не найден', 22)} ${pad(buckets.not_found.length, 6)} ${share(buckets.not_found.length)}%`);
    console.log(`  ${pad('двойники, нужен выбор', 22)} ${pad(buckets.ambiguous.length, 6)} ${share(buckets.ambiguous.length)}%`);

    // Нераспознанные интереснее всего: обычно это несколько повторяющихся
    // форм записи, а не сотни разных ошибок.
    if (buckets.not_found.length) {
        const byValue = new Map();
        for (const row of buckets.not_found) {
            const key = row.city.trim();
            byValue.set(key, (byValue.get(key) || 0) + 1);
        }
        const top = Array.from(byValue.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25);
        console.log(`\nЧаще всего не распознаётся (${byValue.size} разных значений):`);
        for (const [value, count] of top) console.log(`  ${pad(count, 5)} «${value}»`);
    }

    if (buckets.ambiguous.length) {
        console.log('\nДвойники — выбирать должен человек:');
        for (const row of buckets.ambiguous.slice(0, 15)) {
            const variants = row.candidates.map(c => c.qualifier || c.hub || c.name).join(' / ');
            console.log(`  «${row.city}» → ${variants}  [${row.company}]`);
        }
        if (buckets.ambiguous.length > 15) console.log(`  …и ещё ${buckets.ambiguous.length - 15}`);
    }

    const blocked = buckets.empty.length + buckets.not_found.length + buckets.ambiguous.length;
    console.log(`\nИтого расчёт доставки не состоится у ${blocked} компаний из ${total} (${share(blocked)}%).`);
    console.log('Ничего не изменено: это только отчёт.');

    await pool.end();
}

main().catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
});
