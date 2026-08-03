'use strict';

/* Чистка тестовых данных с прода.

   По умолчанию НИЧЕГО НЕ УДАЛЯЕТ — печатает, что нашёл. Удаление только с
   флагом --apply. Так список можно сначала прочитать глазами: на проде живые
   заказчики и заводы, ошибиться нельзя.

   Что считается тестовым:
     • компании (и их пользователи), чьё название начинается на «MVP»;
     • закупки, чьё название начинается на «E2E» или «MVP», плюс закупки
       компаний из списка выше.

   Всё остальное не трогается. Ни одна компания из госреестра под правило не
   попадает: там названия вида «ООО ...», «АО ...».

   Запуск на сервере:
     cd /var/www/neft && node scripts/cleanup-test-data.js
     cd /var/www/neft && node scripts/cleanup-test-data.js --apply
*/

const { pool } = require('../db');

const APPLY = process.argv.includes('--apply');

/* ILIKE 'MVP%' — именно начало строки, как просил владелец: «с названием MVP
   в начале, остальные не трогать». */
const COMPANY_RULE = "company ILIKE 'MVP%'";
const ORDER_TITLE_RULE = "(title ILIKE 'E2E%' OR title ILIKE 'MVP%')";

async function main() {
    const { rows: companies } = await pool.query(
        `SELECT id, company, role, inn FROM companies WHERE ${COMPANY_RULE} ORDER BY id`
    );
    const companyNames = companies.map(c => c.company);

    const { rows: users } = await pool.query(
        `SELECT id, email, company, role FROM users WHERE ${COMPANY_RULE} ORDER BY id`
    );
    const userIds = users.map(u => u.id);
    for (const u of users) if (!companyNames.includes(u.company)) companyNames.push(u.company);

    const { rows: orders } = await pool.query(
        `SELECT id, title, company, status FROM orders
          WHERE ${ORDER_TITLE_RULE} OR company = ANY($1::text[])
          ORDER BY id`,
        [companyNames]
    );
    const orderIds = orders.map(o => o.id);

    console.log(`\nКомпании (${companies.length}):`);
    companies.forEach(c => console.log(`  #${c.id} ${c.company} · ${c.role}${c.inn ? ' · ИНН ' + c.inn : ''}`));

    console.log(`\nПользователи (${users.length}):`);
    users.forEach(u => console.log(`  #${u.id} ${u.email} · ${u.company} · ${u.role}`));

    console.log(`\nЗакупки (${orders.length}):`);
    orders.forEach(o => console.log(`  #${o.id} ${o.title} · ${o.company} · ${o.status}`));

    if (!companies.length && !users.length && !orders.length) {
        console.log('\nНечего удалять.');
        await pool.end();
        return;
    }

    if (!APPLY) {
        console.log('\nЭто предпросмотр. Ничего не удалено.');
        console.log('Удалить: node scripts/cleanup-test-data.js --apply\n');
        await pool.end();
        return;
    }

    const client = await pool.connect();
    const removed = {};
    try {
        await client.query('BEGIN');

        const byOrder = ['proposals', 'messages', 'tasks', 'favorite_orders', 'reviews',
            'auctions', 'order_events', 'vk_posts'];
        for (const table of byOrder) {
            if (!orderIds.length) break;
            const r = await client.query(`DELETE FROM ${table} WHERE order_id = ANY($1::int[])`, [orderIds]);
            if (r.rowCount) removed[table] = r.rowCount;
        }

        const byCompany = ['notifications', 'integrations', 'invitations', 'order_templates',
            'auction_bids', 'company_photos', 'verification_requests'];
        for (const table of byCompany) {
            if (!companyNames.length) break;
            const r = await client.query(`DELETE FROM ${table} WHERE company = ANY($1::text[])`, [companyNames]);
            if (r.rowCount) removed[table] = r.rowCount;
        }

        const byUser = ['password_reset_tokens', 'refresh_tokens', 'email_verification_tokens', 'push_subscriptions'];
        for (const table of byUser) {
            if (!userIds.length) break;
            const r = await client.query(`DELETE FROM ${table} WHERE user_id = ANY($1::int[])`, [userIds]);
            if (r.rowCount) removed[table] = r.rowCount;
        }

        if (orderIds.length) {
            const r = await client.query('DELETE FROM orders WHERE id = ANY($1::int[])', [orderIds]);
            removed.orders = r.rowCount;
        }
        if (userIds.length) {
            const r = await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
            removed.users = r.rowCount;
        }
        if (companies.length) {
            const r = await client.query('DELETE FROM companies WHERE id = ANY($1::int[])',
                [companies.map(c => c.id)]);
            removed.companies = r.rowCount;
        }

        await client.query('COMMIT');
        console.log('\nУдалено:');
        Object.entries(removed).forEach(([t, n]) => console.log(`  ${t}: ${n}`));
        console.log('');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('\nОшибка, изменения откачены:', e.message, '\n');
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(e => {
    console.error('Ошибка:', e.message);
    process.exit(1);
});
