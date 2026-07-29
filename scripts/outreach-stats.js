#!/usr/bin/env node
'use strict';

// Сводка по холодной рассылке заводам-заглушкам. Только чтение, ничего не отправляет.
//   node scripts/outreach-stats.js            последние 20 дней
//   node scripts/outreach-stats.js --days 60  другой период
// Гонять на VPS: база слушает localhost, извне недоступна.

require('dotenv').config();
const { Pool } = require('pg');

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const DAYS = daysArg !== -1 ? Math.max(1, Math.min(365, parseInt(args[daysArg + 1], 10) || 20)) : 20;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { relevanceScore } = require('../lib/outreach');

// Тот же отбор кандидатов, что в lib/outreach.js — чтобы «осталось» совпадало с реальностью.
// Строки, а не COUNT: релевантность считается в JS тем же кодом, что и при отправке.
const REMAINING_SQL = `
    SELECT c.specialization, c.products
    FROM companies c
    WHERE c.role = 'producer' AND c.claimed = false AND c.invite_optout = false
      AND c.contact_email <> ''
      AND (c.last_invited_at IS NULL OR c.last_invited_at < NOW() - INTERVAL '7 days')
      AND NOT EXISTS (
          SELECT 1 FROM outreach_log l
          WHERE l.company_id = c.id AND l.status IN ('sent', 'bad-domain')
      )
`;

function table(rows, cols) {
    if (!rows.length) return '  (пусто)';
    const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
    const line = (vals) => '  ' + vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
    return [line(cols), line(widths.map(w => '-'.repeat(w))), ...rows.map(r => line(cols.map(c => r[c])))].join('\n');
}

(async () => {
    try {
        const { rows: byStatus } = await pool.query(
            'SELECT status, COUNT(*)::int AS n FROM outreach_log GROUP BY status ORDER BY n DESC'
        );
        const { rows: [span] } = await pool.query(
            'SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*)::int AS total FROM outreach_log'
        );
        const { rows: byDay } = await pool.query(
            `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                    COUNT(*)::int AS all_rows,
                    COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
                    COUNT(*) FILTER (WHERE status <> 'sent')::int AS other
             FROM outreach_log
             WHERE created_at > NOW() - ($1 || ' days')::interval
             GROUP BY day ORDER BY day DESC`,
            [String(DAYS)]
        );
        const { rows: errors } = await pool.query(
            `SELECT left(error, 90) AS error, COUNT(*)::int AS n
             FROM outreach_log WHERE error <> '' GROUP BY 1 ORDER BY n DESC LIMIT 8`
        );
        const { rows: remainingRows } = await pool.query(REMAINING_SQL);
        const remainingRelevant = remainingRows.filter(r => relevanceScore(r) > 0).length;
        const { rows: [optout] } = await pool.query(
            "SELECT COUNT(*)::int AS n FROM companies WHERE invite_optout = true"
        );
        const { rows: [claimed] } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM companies c
             WHERE c.claimed = true
               AND EXISTS (SELECT 1 FROM outreach_log l WHERE l.company_id = c.id AND l.status = 'sent')`
        );

        console.log('=== Холодная рассылка: сводка ===');
        console.log(`Всего записей в outreach_log: ${span.total}`);
        console.log(`Первая: ${span.first ? span.first.toISOString() : '—'}`);
        console.log(`Последняя: ${span.last ? span.last.toISOString() : '—'} (время UTC; МСК = +3, Екатеринбург = +5)`);
        console.log('\nПо статусам:');
        console.log(table(byStatus, ['status', 'n']));
        console.log(`\nПо дням (последние ${DAYS}):`);
        console.log(table(byDay, ['day', 'all_rows', 'sent', 'other']));
        console.log('\nОшибки отправки:');
        console.log(table(errors, ['error', 'n']));
        console.log('\nИтоги:');
        console.log(`  Пул по формальным правилам: ${remainingRows.length}`);
        console.log(`  Из них релевантных (кому реально пишем): ${remainingRelevant} — это ${Math.ceil(remainingRelevant / 20)} дней при 20 письмах в день`);
        console.log(`  Отписались по ссылке opt-out: ${optout.n}`);
        console.log(`  Получили письмо и потом зарегистрировались (claimed): ${claimed.n}`);
    } catch (e) {
        console.error('Не смог собрать сводку:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
