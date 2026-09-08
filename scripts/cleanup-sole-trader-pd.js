'use strict';

// Разовая чистка: карточки ИП, заведённые нами из реестра ГИСП и не забранные
// владельцами. Их наименование — ФИО живого человека, а телефон и почта, которые
// мы собрали из реестра и с сайтов, — его контактные данные. Открытость реестра
// не даёт основания ни хранить их у себя, ни рассылать по ним письма
// (152-ФЗ, ст. 10.1 — распространение; ФЗ-38, ст. 18 ч. 1 — реклама).
//
// Импорт таких строк уже прекращён (scripts/import-registry.js), выдача наружу
// обезличена (lib/personal-data.js), рассылки их не видят. Здесь убирается то,
// что успело осесть в базе до этих правок.
//
// Запуск (из корня проекта):
//   node scripts/cleanup-sole-trader-pd.js                 показать, ничего не менять
//   node scripts/cleanup-sole-trader-pd.js --apply         стереть контакты, карточки оставить
//   node scripts/cleanup-sole-trader-pd.js --apply --delete удалить карточки целиком
//
// По умолчанию — сухой прогон. Карточки, которые предприниматель забрал сам
// (claimed = true), не трогаются ни в одном режиме: там есть согласие,
// полученное при регистрации.

require('dotenv').config();
const { pool } = require('../db.js');
const { unclaimedSoleTradersSql } = require('../lib/personal-data');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DELETE = args.includes('--delete');

// Ровно те строки, которые выдача наружу прячет.
const TARGET = `role = 'producer' AND ${unclaimedSoleTradersSql('')}`;

async function main() {
    const { rows: found } = await pool.query(
        `SELECT id, company, inn, city, contact_email, phone, source
           FROM companies
          WHERE ${TARGET}
          ORDER BY id`
    );

    console.log(`Незабранных карточек ИП: ${found.length}`);
    if (!found.length) { await pool.end(); return; }

    const withEmail = found.filter(r => r.contact_email).length;
    const withPhone = found.filter(r => r.phone).length;
    console.log(`  из них с почтой: ${withEmail}, с телефоном: ${withPhone}`);
    console.log('Примеры (первые 5):');
    for (const r of found.slice(0, 5)) {
        console.log(`  #${r.id} ${r.company} · ${r.city || '—'} · ${r.contact_email || 'без почты'}`);
    }

    if (!APPLY) {
        console.log('');
        console.log('Сухой прогон: база не изменена.');
        console.log('  --apply            стереть контакты, карточки оставить');
        console.log('  --apply --delete   удалить карточки целиком');
        await pool.end();
        return;
    }

    if (DELETE) {
        // Единственная внешняя ссылка на companies — outreach_log (ON DELETE CASCADE),
        // журнал отправленных писем. Он уедет вместе с карточкой, и это правильно:
        // хранить переписку с человеком, чьи данные мы удаляем, незачем.
        const { rowCount } = await pool.query(`DELETE FROM companies WHERE ${TARGET}`);
        console.log(`Удалено карточек: ${rowCount}`);
    } else {
        // Мягкий вариант: карточка остаётся (её ещё может забрать владелец),
        // но личных контактов в ней больше нет. invite_optout закрывает адрес
        // от любых будущих рассылок, даже если их когда-нибудь включат.
        const { rowCount } = await pool.query(
            `UPDATE companies
                SET contact_email = '', phone = '', invite_optout = true
              WHERE ${TARGET}`
        );
        console.log(`Обезличено карточек: ${rowCount} (контакты стёрты, отписка проставлена)`);
    }

    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
