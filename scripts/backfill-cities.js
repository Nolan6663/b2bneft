#!/usr/bin/env node
'use strict';

// Проставляет городá предприятиям, у которых их нет.
//
//   node scripts/backfill-cities.js --dry            # показать, ничего не менять
//   node scripts/backfill-cities.js --limit 200      # прогнать первые 200
//   node scripts/backfill-cities.js                  # весь каталог
//
// Зачем. В колонке city у двух третей карточек стоит регион: реестр ГИСП пишет
// туда «Удмуртская Республика». Из-за этого заголовок карточки в выдаче звучал
// как «завод — производитель, Удмуртская Республика», хотя ищут «завод Глазов».
// Город берётся по ИНН из справочника организаций DaData и кладётся в town —
// city остаётся регионом, по нему группируются региональные страницы.
//
// Про квоту. У DaData 10 000 запросов в сутки на аккаунт, и та же квота нужна
// подсказкам адресов в расчёте доставки. Поэтому запросы идут по одному с
// паузой и с потолком: прогон на 3000 карточек занимает около десяти минут и
// оставляет запас живым пользователям. Прерванный прогон можно повторить —
// скрипт берёт только тех, у кого town ещё пуст.
//
// Про даты. Обновление карточки поднимает updated_at (триггер companies_touch),
// то есть после прогона эти страницы приедут в карту сайта со свежим lastmod.
// Так и надо: заголовок и содержимое карточки действительно изменились.

require('dotenv').config();

const { pool } = require('../db');
const { isConfigured, townByInn } = require('../lib/dadata-party');

const PAUSE_MS = 150;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) || 0 : 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    if (!isConfigured()) {
        console.error('Нет DADATA_API_KEY в окружении — города добывать нечем.');
        process.exit(1);
    }

    const { rows } = await pool.query(`
        SELECT id, company, inn, city
          FROM companies
         WHERE role = 'producer'
           AND status <> 'Отклонено'
           AND COALESCE(town, '') = ''
           AND COALESCE(inn, '') <> ''
         ORDER BY claimed DESC, verified_by_platform DESC, id ASC
         ${limit ? 'LIMIT ' + Number(limit) : ''}
    `);

    console.log(`Карточек без города: ${rows.length}${limit ? ` (взято по --limit ${limit})` : ''}`);
    if (dryRun) console.log('Режим --dry: ничего не записывается.\n');

    const stats = { filled: 0, same: 0, notFound: 0, failed: 0 };

    for (const [i, row] of rows.entries()) {
        let town = '';
        try {
            town = await townByInn(row.inn);
        } catch (e) {
            stats.failed += 1;
            console.warn(`  ! ${row.inn} ${row.company}: ${e.message}`);
            // Ошибка сети или упёрлись в квоту — пауза длиннее, чтобы не добивать.
            await sleep(PAUSE_MS * 10);
            continue;
        }

        if (!town) {
            stats.notFound += 1;
        } else if (town === String(row.city || '').trim()) {
            // Город и регион совпали: это города федерального значения — Москва,
            // Санкт-Петербург. Писать одно и то же в две колонки незачем.
            stats.same += 1;
        } else {
            stats.filled += 1;
            if (!dryRun) await pool.query('UPDATE companies SET town = $1 WHERE id = $2', [town, row.id]);
            if (stats.filled <= 20) console.log(`  ${row.city || '—'} → ${town}  [${row.company}]`);
        }

        if ((i + 1) % 200 === 0) console.log(`… обработано ${i + 1} из ${rows.length}`);
        await sleep(PAUSE_MS);
    }

    console.log('\nИтог:');
    console.log(`  город проставлен:      ${stats.filled}`);
    console.log(`  город равен региону:   ${stats.same} (Москва и подобные — пропущены)`);
    console.log(`  не найден в справочнике: ${stats.notFound}`);
    console.log(`  ошибок запроса:        ${stats.failed}`);
    if (dryRun) console.log('\nЭто был --dry: база не изменилась.');

    await pool.end();
}

main().catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
});
