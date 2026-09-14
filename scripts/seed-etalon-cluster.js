'use strict';

// Наполнение эталонного кластера «Токарная обработка — Валы» (ТЗ §15.1).
//
// Зачем скрипт: страницы кластера написаны, но открыть их нельзя — справочник
// пуст, и /uslugi/tokarnaya-obrabotka честно отдаёт 404. Проверить работу по
// отчёту невозможно, её надо видеть. Скрипт заводит минимальный набор данных,
// после которого все три страницы открываются и показывают реальные
// предприятия из каталога.
//
// Страницы создаются в статусе `published_noindex`: они доступны по прямой
// ссылке, но робот на них не приходит и в карту сайта они не попадают. Это
// ровно тот порядок, который описан в «Краулинговом бюджете» §3 и который мы
// предложили маркетингу: сначала посмотреть наполнение, потом открывать
// индексацию. Переводить в индекс до появления их текстов нельзя — страница
// без уникального содержания в индексе хуже, чем её отсутствие.
//
// Запуск на сервере, из каталога проекта:
//   node scripts/seed-etalon-cluster.js            показать, что будет сделано
//   node scripts/seed-etalon-cluster.js --apply    завести данные
//
// Идемпотентно: повторный запуск ничего не дублирует и не затирает правки
// редактора — существующие записи опознаются по slug и остаются как есть.

require('dotenv').config();
const { pool } = require('../db.js');
const { linkOrder } = require('../lib/order-linking');
const { buildIndex, matchEntries } = require('../lib/catalog-match');

const APPLY = process.argv.includes('--apply');

/* Состав кластера. Синонимы важнее, чем кажется: по ним разбираются профили
   заводов и тексты заявок, и без «токарки» с «точением» половина подходящих
   предприятий не свяжется с услугой. */
const SERVICE = {
    slug: 'tokarnaya-obrabotka',
    name: 'Токарная обработка',
    description: 'Точение деталей вращения на универсальных станках и станках с ЧПУ.',
    synonyms: ['токарка', 'точение', 'токарные работы', 'токарная обработка металла', 'токарно-фрезерная обработка'],
};

const PRODUCT = {
    slug: 'valy',
    name: 'Валы',
    description: 'Валы и оси: ступенчатые, гладкие, шлицевые, с термообработкой и шлифовкой.',
    synonyms: ['вал', 'валы стальные', 'ступенчатый вал', 'оси и валы'],
};

/* Посадочные страницы кластера. Системный ключ строится по «Краулинговому
   бюджету» §5: тип:интент:сущность. Заказы отделены интентом `executor` —
   страница для исполнителя, а не для заказчика. */
const LANDINGS = [
    { key: 'service:customer:tokarnaya-obrabotka', url: '/uslugi/tokarnaya-obrabotka', type: 'service',   intent: 'customer', of: 'service' },
    { key: 'product:customer:valy',                url: '/izdeliya/valy',              type: 'product',   intent: 'customer', of: 'product' },
    { key: 'order:executor:valy',                  url: '/zakazy/valy',                type: 'order',     intent: 'executor', of: 'product' },
];

const STATUS = 'published_noindex';

async function upsertEntity(table, spec) {
    const { rows: [existing] } = await pool.query(`SELECT id, name FROM ${table} WHERE slug = $1`, [spec.slug]);
    if (existing) return { id: existing.id, created: false };
    if (!APPLY) return { id: null, created: true };
    const { rows: [row] } = await pool.query(
        `INSERT INTO ${table} (slug, name, description, status, synonyms)
         VALUES ($1, $2, $3, 'published', $4) RETURNING id`,
        [spec.slug, spec.name, spec.description, JSON.stringify(spec.synonyms)]
    );
    return { id: row.id, created: true };
}

/** Связывает компании каталога с сущностью по тексту их профилей. Тот же
 *  разбор, что в scripts/backfill-company-links.js, но только для одной
 *  сущности — чтобы кластер наполнился, а остальной каталог не трогался. */
async function linkCompanies(entity, kind) {
    const linkTable = kind === 'service' ? 'company_services' : 'company_products';
    const column = kind === 'service' ? 'service_id' : 'product_id';
    const index = buildIndex([{ id: entity.id, name: entity.name, synonyms: entity.synonyms }]);

    const { rows: companies } = await pool.query(`
        SELECT id, specialization, products, capabilities FROM companies
         WHERE role = 'producer' AND status <> 'Отклонено'
           AND (COALESCE(specialization,'') <> '' OR COALESCE(products,'') <> '')
    `);

    let matched = 0;
    for (const c of companies) {
        const text = [c.specialization, c.products, c.capabilities].filter(Boolean).join('. ');
        if (!matchEntries(text, index).length) continue;
        matched++;
        if (APPLY && entity.id) {
            await pool.query(
                `INSERT INTO ${linkTable} (company_id, ${column}, confirmation)
                 VALUES ($1, $2, 'registry') ON CONFLICT DO NOTHING`,
                [c.id, entity.id]
            );
        }
    }
    return { scanned: companies.length, matched };
}

async function upsertLanding(spec, ids) {
    const { rows: [existing] } = await pool.query('SELECT id, status FROM landing_pages WHERE system_key = $1', [spec.key]);
    if (existing) return { created: false, status: existing.status };
    if (!APPLY) return { created: true, status: STATUS };
    await pool.query(
        `INSERT INTO landing_pages (system_key, url, page_type, intent, service_id, product_id, status, index_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            spec.key, spec.url, spec.type, spec.intent,
            spec.of === 'service' ? ids.service : null,
            spec.of === 'product' ? ids.product : null,
            STATUS,
            'Эталонный кластер. В индекс — после текстов от маркетинга.',
        ]
    );
    return { created: true, status: STATUS };
}

/** Пересобирает связи уже опубликованных заявок: они создавались до появления
 *  справочника, и без этого хаб заказов останется пустым. */
async function relinkOrders() {
    const { rows: orders } = await pool.query(
        `SELECT id, title, category, description FROM orders WHERE status = 'Активный'`
    );
    let linked = 0;
    for (const o of orders) {
        if (!APPLY) { linked++; continue; }
        const res = await linkOrder(pool, o);
        if (res.services || res.products) linked++;
    }
    return { total: orders.length, linked };
}

async function main() {
    console.log(APPLY ? 'Режим: запись в базу' : 'Режим: сухой прогон, база не изменится');
    console.log('');

    const service = await upsertEntity('services', SERVICE);
    const product = await upsertEntity('products', PRODUCT);
    console.log(`Услуга «${SERVICE.name}»: ${service.created ? 'создаётся' : 'уже есть (id ' + service.id + ')'}`);
    console.log(`Изделие «${PRODUCT.name}»: ${product.created ? 'создаётся' : 'уже есть (id ' + product.id + ')'}`);

    if (APPLY && service.id && product.id) {
        await pool.query(
            `INSERT INTO service_products (service_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [service.id, product.id]
        );
        console.log('Связь «услуга ↔ изделие» проставлена');
    }

    const s = await linkCompanies({ ...SERVICE, id: service.id }, 'service');
    const p = await linkCompanies({ ...PRODUCT, id: product.id }, 'product');
    console.log('');
    console.log(`Предприятий в каталоге просмотрено: ${s.scanned}`);
    console.log(`  подходят под «${SERVICE.name}»: ${s.matched}`);
    console.log(`  подходят под «${PRODUCT.name}»:  ${p.matched}`);

    const o = await relinkOrders();
    console.log(`Активных заявок: ${o.total}, из них попадут в хабы: ${o.linked}`);

    console.log('');
    for (const spec of LANDINGS) {
        const r = await upsertLanding(spec, { service: service.id, product: product.id });
        console.log(`${spec.url.padEnd(30)} ${r.created ? 'создаётся' : 'уже есть'} · статус ${r.status}`);
    }

    console.log('');
    if (!APPLY) {
        console.log('Сухой прогон завершён. Чтобы записать: node scripts/seed-etalon-cluster.js --apply');
    } else {
        console.log('Готово. Страницы открываются по прямым ссылкам:');
        for (const spec of LANDINGS) console.log('  https://texzakaz.ru' + spec.url);
        console.log('');
        console.log('Они отдают noindex и в карту сайта не попадают — это намеренно.');
        console.log('В индекс переводим после того, как маркетинг пришлёт тексты.');
    }
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
