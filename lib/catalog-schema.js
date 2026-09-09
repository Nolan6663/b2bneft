'use strict';

// Минимальная модель справочников под эталонный кластер «Токарная обработка — Валы».
//
// Объём выбран по ответу маркетинга (вкладка «Ответы на вопросы разработчиков»,
// раздел 4): не начинать с полной CMS, собрать эталонный кластер на минимально
// необходимой модели и расширять справочники после того, как подтвердится, что
// данные реально появляются и используются. Поэтому здесь ровно то, без чего не
// собрать четыре страницы кластера:
//
//     /uslugi/tokarnaya-obrabotka/      → services
//     /izdeliya/valy/                   → products
//     /podryadchiki/izgotovlenie-valov/ → companies × products/services
//     /zakazy/izgotovlenie-valov/       → orders × products/services
//
// Сознательно НЕ заводится сейчас (см. docs/SEO-DECOMPOSITION.md):
//   • materials, cases, equipment — нужны шаблонам страниц, но не нужны, чтобы
//     четыре страницы кластера заработали; это этапы 5 и далее;
//   • regions — сейчас живут в seo/regions-data.js и работают; заводить пустую
//     таблицу, которой ничего не пользуется, вредно;
//   • полноценная CMS — по ответу маркетинга, обязательна примерно с 20–30
//     кластеров, а не сейчас.
//
// Схема идемпотентна и вызывается из initDb() при каждом старте — как остальные
// таблицы проекта.

/** Статусы посадочной страницы — ТЗ §4.3. Список нормативный, не расширять
 *  без правки документа: на нём завязаны Sitemap, robots и перелинковка. */
const LANDING_STATUSES = ['draft', 'preview', 'published_noindex', 'published_index', 'merged', 'archived'];

/** Только этот статус даёт право попасть в Sitemap и в индекс.
 *  Краулинговый бюджет §9: в Sitemap включаются только URL с 200, index и
 *  self-canonical. Публичность страницы сама по себе допуска не даёт. */
const INDEXABLE_STATUS = 'published_index';

/** Откуда взялась связь компании с услугой или изделием — ТЗ §4.2.
 *  Различать обязательно: заявленное компанией и подтверждённое платформой
 *  показываются по-разному (ТЗ §11.2), а в тематические каталоги подрядчиков
 *  по 07.09 попадают только подтверждённые компетенции. */
const LINK_CONFIRMATIONS = ['registry', 'claimed', 'case', 'moderated'];

async function initCatalog(pool) {
    await pool.query(`
        /* ── Справочник услуг (технологических операций) ──────────────────
           parent_id даёт иерархию «хаб → услуга»: /uslugi/mehanicheskaya-obrabotka/
           над /uslugi/tokarnaya-obrabotka/ (вкладка «Контент-хабы», §2.2).
           Хаб — обычная строка с потомками, отдельной сущности не нужно. */
        CREATE TABLE IF NOT EXISTS services (
            id          SERIAL      PRIMARY KEY,
            slug        TEXT        NOT NULL UNIQUE,
            name        TEXT        NOT NULL,
            parent_id   INTEGER     REFERENCES services(id) ON DELETE SET NULL,
            description TEXT        NOT NULL DEFAULT '',
            status      TEXT        NOT NULL DEFAULT 'draft',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        /* ── Справочник изделий ───────────────────────────────────────────
           Та же иерархия: группа изделий («детали вращения») → изделие («валы»). */
        CREATE TABLE IF NOT EXISTS products (
            id          SERIAL      PRIMARY KEY,
            slug        TEXT        NOT NULL UNIQUE,
            name        TEXT        NOT NULL,
            parent_id   INTEGER     REFERENCES products(id) ON DELETE SET NULL,
            description TEXT        NOT NULL DEFAULT '',
            status      TEXT        NOT NULL DEFAULT 'draft',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        /* ── Услуга ↔ изделие ─────────────────────────────────────────────
           Связь многие-ко-многим (ТЗ §4.2): вал делается точением и шлифовкой,
           точением делаются валы, оси и втулки. На этой связи стоят блоки
           «какие изделия изготавливаются данной технологией» (ТЗ §6.2)
           и «подходящие услуги» (ТЗ §6.3). */
        CREATE TABLE IF NOT EXISTS service_products (
            service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            PRIMARY KEY (service_id, product_id)
        );

        /* ── Компания ↔ услуга и компания ↔ изделие ───────────────────────
           confirmation обязателен: он отделяет «мы взяли это из реестра» от
           «компания сама заявила» и от «подтверждено модератором или кейсом».
           Каталоги подрядчиков строятся не по всем связям подряд, а по
           подтверждённым (вкладка 07.09: организация без подтверждённых
           производственных возможностей в тематические каталоги не попадает).

           numeric-ограничения (ТЗ §4.2) держим в JSONB: набор параметров разный
           у точения, литья и гибки — диаметр и длина против тоннажа и размера
           стола. Отдельная таблица параметров на этом этапе даёт схему, которой
           никто не пользуется; JSONB честно говорит «форма ещё не устоялась». */
        CREATE TABLE IF NOT EXISTS company_services (
            company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            service_id   INTEGER NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
            confirmation TEXT    NOT NULL DEFAULT 'claimed',
            limits       JSONB   NOT NULL DEFAULT '{}'::jsonb,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (company_id, service_id)
        );

        CREATE TABLE IF NOT EXISTS company_products (
            company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            product_id   INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
            confirmation TEXT    NOT NULL DEFAULT 'claimed',
            limits       JSONB   NOT NULL DEFAULT '{}'::jsonb,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (company_id, product_id)
        );

        /* ── Реестр посадочных страниц ────────────────────────────────────
           Центральная таблица всей SEO-архитектуры.

           system_key — уникальный ключ вида «тип:интент:сущность[:доп][:гео]»
           (Краулинговый бюджет §5): service:customer:tokarnaya-obrabotka,
           product:customer:valy, contractor:customer:izgotovlenie-valov,
           order:executor:izgotovlenie-valov. Две страницы с одинаковым ключом
           существовать не могут — это и есть механическая защита от
           каннибализации, которую требует ТЗ §2.2.

           status управляет допуском в индекс отдельно от факта существования
           страницы. Ответ маркетинга (вопрос 13): готовность шаблона, публичная
           доступность URL и допуск в индекс — три разных состояния.

           redirect_to заполняется при status='merged' — 301 на выбранную
           основную страницу (ТЗ §4.3). */
        CREATE TABLE IF NOT EXISTS landing_pages (
            id            SERIAL      PRIMARY KEY,
            system_key    TEXT        NOT NULL UNIQUE,
            url           TEXT        NOT NULL UNIQUE,
            page_type     TEXT        NOT NULL,
            intent        TEXT        NOT NULL,
            service_id    INTEGER     REFERENCES services(id) ON DELETE SET NULL,
            product_id    INTEGER     REFERENCES products(id) ON DELETE SET NULL,
            region_slug   TEXT        NOT NULL DEFAULT '',
            status        TEXT        NOT NULL DEFAULT 'draft',
            title         TEXT        NOT NULL DEFAULT '',
            description   TEXT        NOT NULL DEFAULT '',
            h1            TEXT        NOT NULL DEFAULT '',
            intro         TEXT        NOT NULL DEFAULT '',
            redirect_to   TEXT        NOT NULL DEFAULT '',
            /* Почему страницу пустили в индекс или не пустили: числа спроса и
               предложения на момент решения. Без этого через полгода никто не
               вспомнит, почему страница висит в noindex (ТЗ §11.3 — решение
               фиксируется в журнале). */
            demand_hits   INTEGER     NOT NULL DEFAULT 0,
            supply_count  INTEGER     NOT NULL DEFAULT 0,
            index_note    TEXT        NOT NULL DEFAULT '',
            indexed_at    TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        /* ── Настраиваемые пороги ─────────────────────────────────────────
           Маркетинг настоял (ответ на вопрос 1): пороги стартовые и хранятся
           как настройки, а не как числа в коде. Значения по умолчанию
           проставляются ниже, из вкладки «Краулинговый бюджет» §4.1. */
        CREATE TABLE IF NOT EXISTS catalog_settings (
            key        TEXT        PRIMARY KEY,
            value      TEXT        NOT NULL,
            comment    TEXT        NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_landing_status   ON landing_pages (status);
        CREATE INDEX IF NOT EXISTS idx_landing_type     ON landing_pages (page_type, intent);
        CREATE INDEX IF NOT EXISTS idx_company_services ON company_services (service_id, confirmation);
        CREATE INDEX IF NOT EXISTS idx_company_products ON company_products (product_id, confirmation);
        CREATE INDEX IF NOT EXISTS idx_services_parent  ON services (parent_id);
        CREATE INDEX IF NOT EXISTS idx_products_parent  ON products (parent_id);
    `);

    await seedThresholds(pool);
}

/* Стартовые пороги из вкладки «Краулинговый бюджет» §4.1 и ответа на вопрос 1.
   ON CONFLICT DO NOTHING: правки редактора в админке не затираются при рестарте.

   Порог геостраницы в документах назван трижды и по-разному — «3–5 исполнителей»
   в приложении, «3–5, действующий порог 5 как стартовый» и «не менее 5
   подходящих предприятий» в ответах. Берём 5: это то значение, которое во всех
   трёх местах названо действующим. Расхождение вынесено маркетингу отдельным
   вопросом (docs/SEO-QUESTIONS-TO-MARKETING.md). */
const DEFAULT_THRESHOLDS = [
    ['threshold.service.demand',    '20', 'Услуга: показов в месяц по очищенному кластеру'],
    ['threshold.service.supply',     '3', 'Услуга: активных исполнителей'],
    ['threshold.product.demand',    '10', 'Изделие: показов в месяц'],
    ['threshold.product.supply',     '3', 'Изделие: исполнителей либо подтверждённых кейсов'],
    ['threshold.contractor.demand', '10', 'Каталог подрядчиков: показов в месяц по коммерческому кластеру'],
    ['threshold.contractor.supply',  '5', 'Каталог подрядчиков: подходящих компаний'],
    ['threshold.geo.demand',         '5', 'Геостраница: показов в месяц в регионе'],
    ['threshold.geo.supply',         '5', 'Геостраница: исполнителей в регионе (в документах 3–5, действующий — 5)'],
    ['threshold.case.demand',        '5', 'Кейс: спрос связанной услуги или изделия; своего порога у кейса нет'],
    ['threshold.orderhub.demand',   '10', 'Хаб заказов: показов в месяц'],
    ['threshold.orderhub.supply',    '3', 'Хаб заказов: новых релевантных заказов за 90 дней'],
    ['threshold.orderhub.window',   '90', 'Хаб заказов: окно подсчёта заказов, дней'],
    ['threshold.hub.children',       '4', 'Хаб: значимых дочерних страниц (Контент-хабы §3)'],
];

async function seedThresholds(pool) {
    for (const [key, value, comment] of DEFAULT_THRESHOLDS) {
        await pool.query(
            `INSERT INTO catalog_settings (key, value, comment) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO NOTHING`,
            [key, value, comment]
        );
    }
}

/** Ключ страницы по правилу Краулингового бюджета §5.
 *  Пустые части отбрасываются, чтобы service:customer:tokarnaya-obrabotka и
 *  service:customer:tokarnaya-obrabotka:: не оказались разными ключами. */
function buildSystemKey({ pageType, intent, entity, extra = '', geo = '' }) {
    return [pageType, intent, entity, extra, geo]
        .map(p => String(p == null ? '' : p).trim().toLowerCase())
        .filter(Boolean)
        .join(':');
}

/** Пускать ли страницу в Sitemap и в индекс. Единственная точка, где это
 *  решается, — чтобы ответ был одинаковым в sitemap.xml, в meta robots и в
 *  перелинковке. */
function isIndexable(landing) {
    return !!landing && landing.status === INDEXABLE_STATUS;
}

module.exports = {
    initCatalog,
    buildSystemKey,
    isIndexable,
    LANDING_STATUSES,
    INDEXABLE_STATUS,
    LINK_CONFIRMATIONS,
    DEFAULT_THRESHOLDS,
};
