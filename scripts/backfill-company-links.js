'use strict';

// Перенос связей «компания ↔ услуга/изделие» из текстовых полей в справочники.
//
// У 4500 карточек производственные возможности записаны прозой: «Токарная и
// фрезерная обработка, изготовление валов и втулок». Страницы кластера строятся
// не по тексту, а по связям сущностей (ТЗ §4.2), поэтому связи нужно один раз
// вытащить из этой прозы.
//
// Что важно понимать про результат:
//
//   • Связи помечаются `confirmation = 'registry'` — слабейшим уровнем из
//     ТЗ §4.2. Это не заявление компании и не подтверждение модератора, а наша
//     догадка по её же тексту. В тематические каталоги подрядчиков такие связи
//     по вкладке 07.09 не пускают: туда идут только подтверждённые.
//   • Существующие связи не трогаются. Если компания сама заявила услугу или
//     модератор её подтвердил, догадка не должна это перезаписать — отсюда
//     ON CONFLICT DO NOTHING.
//   • Разбор намеренно строгий и что-то пропускает. Лишняя связь ставит
//     компанию на страницу, которую она не обслуживает (ТЗ §6.4 это запрещает),
//     а пропущенную компания добавит сама при заполнении профиля.
//
// Запуск из корня проекта:
//   node scripts/backfill-company-links.js              показать, ничего не менять
//   node scripts/backfill-company-links.js --apply      записать связи
//   node scripts/backfill-company-links.js --limit 50   разобрать только 50 компаний
//   node scripts/backfill-company-links.js --show 20    показать 20 примеров разбора

require('dotenv').config();
const { pool } = require('../db.js');
const { buildIndex, matchEntries } = require('../lib/catalog-match');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
function opt(name, def) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? Number(args[i + 1]) : def;
}
const LIMIT = opt('--limit', 0);
const SHOW = opt('--show', 10);

/* Поля, по которым ищем. `about` — маркетинговый текст, где встречается что
   угодно, поэтому его не берём: в поиске у него вес 1 из 5 не случайно. */
const TEXT_FIELDS = ['specialization', 'products', 'capabilities'];

async function loadDictionary(table) {
    const { rows } = await pool.query(
        `SELECT id, name, synonyms FROM ${table} WHERE status <> 'archived'`
    );
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        synonyms: Array.isArray(r.synonyms) ? r.synonyms : [],
    }));
}

function companyText(row) {
    return TEXT_FIELDS.map(f => String(row[f] || '')).filter(Boolean).join('. ');
}

async function main() {
    const [services, products] = await Promise.all([
        loadDictionary('services'),
        loadDictionary('products'),
    ]);
    console.log(`Справочники: услуг ${services.length}, изделий ${products.length}`);
    if (!services.length && !products.length) {
        console.log('Справочники пусты — сначала заведите услуги и изделия в админке.');
        await pool.end();
        return;
    }

    const serviceIndex = buildIndex(services);
    const productIndex = buildIndex(products);

    const { rows: companies } = await pool.query(`
        SELECT id, company, specialization, products, capabilities
          FROM companies
         WHERE role = 'producer' AND status <> 'Отклонено'
           AND (COALESCE(specialization,'') <> '' OR COALESCE(products,'') <> '')
         ORDER BY id
         ${LIMIT ? `LIMIT ${Number(LIMIT)}` : ''}
    `);
    console.log(`Компаний к разбору: ${companies.length}`);

    let withService = 0, withProduct = 0, linksS = 0, linksP = 0, shown = 0, matched = 0;
    const examples = [];

    for (const c of companies) {
        const text = companyText(c);
        if (!text.trim()) continue;

        const s = matchEntries(text, serviceIndex);
        const p = matchEntries(text, productIndex);
        if (!s.length && !p.length) continue;

        matched++;
        if (s.length) { withService++; linksS += s.length; }
        if (p.length) { withProduct++; linksP += p.length; }

        if (shown < SHOW) {
            shown++;
            examples.push({ company: c.company, text: text.slice(0, 120), s, p });
        }

        if (APPLY) {
            for (const m of s) {
                await pool.query(
                    `INSERT INTO company_services (company_id, service_id, confirmation)
                     VALUES ($1, $2, 'registry') ON CONFLICT DO NOTHING`,
                    [c.id, m.id]
                );
            }
            for (const m of p) {
                await pool.query(
                    `INSERT INTO company_products (company_id, product_id, confirmation)
                     VALUES ($1, $2, 'registry') ON CONFLICT DO NOTHING`,
                    [c.id, m.id]
                );
            }
        }
    }

    console.log('');
    console.log('Примеры разбора:');
    for (const e of examples) {
        console.log(`  ${e.company}`);
        console.log(`    текст: ${e.text}`);
        console.log(`    услуги:  ${e.s.map(x => x.name).join(', ') || '—'}`);
        console.log(`    изделия: ${e.p.map(x => x.name).join(', ') || '—'}`);
    }

    console.log('');
    const share = companies.length ? Math.round((matched / companies.length) * 100) : 0;
    console.log(`Компаний с услугами:  ${withService} (связей ${linksS})`);
    console.log(`Компаний с изделиями: ${withProduct} (связей ${linksP})`);
    console.log(`Распознано хоть что-то: ${matched} из ${companies.length} (${share}%)`);
    console.log(`Ничего не распознано:   ${companies.length - matched}`);
    console.log('Низкий процент — не ошибка скрипта, а признак того, что справочник');
    console.log('ещё мал или ему не хватает синонимов. Разбор строгий намеренно.');

    if (!APPLY) {
        console.log('');
        console.log('Сухой прогон: база не изменена. Записать — добавьте --apply.');
    } else {
        console.log('');
        console.log('Связи записаны с уровнем подтверждения registry.');
    }
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
