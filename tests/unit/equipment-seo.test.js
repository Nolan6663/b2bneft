'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OPERATIONS, operationBySlug, producerHasOperation } = require('../../seo/operations-data');
const {
    buildOperationTitle,
    buildOperationDescription,
    buildOperationRobots,
    buildOperationSsr,
    buildOperationJsonLd,
    MIN_INDEXABLE,
} = require('../../lib/equipment-seo');

const WELD = operationBySlug('svarka');

test('операции: слаги уникальны, латиница, у каждой есть текст и правило', () => {
    const slugs = OPERATIONS.map(o => o.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const o of OPERATIONS) {
        assert.match(o.slug, /^[a-z-]+$/);
        assert.ok(o.match instanceof RegExp, `${o.slug}: нет правила поиска`);
        assert.ok(o.lead && o.lead.length > 20, `${o.slug}: нет пояснения`);
        assert.ok(o.genitive, `${o.slug}: нет родительного падежа`);
    }
});

test('совпадение операции: по специализации, продукции и списку станков', () => {
    assert.ok(producerHasOperation({ specialization: 'Сварные металлоконструкции' }, WELD));
    assert.ok(producerHasOperation({ products: 'сварка аппаратов' }, WELD));
    assert.ok(producerHasOperation({ equipment: ['Сварочный полуавтомат'] }, WELD));
    assert.ok(!producerHasOperation({ specialization: 'Резинотехнические изделия' }, WELD));
});

test('совпадение операции: продажа расходников не считается услугой', () => {
    const seller = { specialization: 'Сварочные электроды и проволока', products: 'электроды' };
    assert.ok(!producerHasOperation(seller, WELD), 'торговля электродами — не сварочные услуги');
});

test('лазер: «лазерная резка» ловится, «лазерная косметология» — нет', () => {
    const laser = operationBySlug('lazernaya-rezka');
    assert.ok(producerHasOperation({ products: 'Лазерная резка листа' }, laser));
    assert.ok(!producerHasOperation({ products: 'Лазерная косметология' }, laser));
});

test('title и description: с реальным числом и без обещаний про станки', () => {
    const title = buildOperationTitle(WELD, 65);
    assert.match(title, /Сварка/);
    assert.match(title, /65/);
    assert.ok(title.length <= 70, `title ${title.length} знаков`);

    const desc = buildOperationDescription(WELD, 65);
    assert.ok(desc.length <= 160, `description ${desc.length} знаков`);
    assert.ok(!/станк\w*\s+в\s+баз/i.test(desc), 'не заявляем базу станков, которой нет');
});

test('robots: операция без предприятий в индекс не идёт', () => {
    assert.equal(buildOperationRobots(0), 'noindex, follow');
    assert.equal(buildOperationRobots(MIN_INDEXABLE - 1), 'noindex, follow');
    assert.equal(buildOperationRobots(MIN_INDEXABLE), 'index, follow');
});

test('SSR: карточки со ссылкой на профиль и экранированием', () => {
    const html = buildOperationSsr(WELD, [
        { id: 7, company: 'ООО «Метиз»', city: 'Тюменская область', specialization: 'Сварные конструкции' },
        { id: 8, company: '<b>взлом</b>', city: 'Москва', products: 'сварка' },
    ]);
    assert.match(html, /\/p\/7/);
    assert.match(html, /Тюменская область/);
    assert.ok(!html.includes('<b>взлом</b>'));
    assert.match(html, /&lt;b&gt;/);
});

test('SSR: пустая операция объясняет пустоту, а не притворяется каталогом', () => {
    const html = buildOperationSsr(WELD, []);
    assert.match(html, /профил/i);
    assert.ok(!/<li class="zr-card"/.test(html));
});

test('JSON-LD: разбирается и несёт число позиций', () => {
    const parsed = JSON.parse(buildOperationJsonLd(WELD, 65, 'https://texzakaz.ru'));
    assert.equal(parsed['@type'], 'CollectionPage');
    assert.equal(parsed.mainEntity.numberOfItems, 65);
    assert.match(parsed.url, /\/oborudovanie\/svarka$/);
    assert.equal(parsed.breadcrumb.itemListElement.length, 3);
});

/* Разбор процессов на странице операции (21.08.2026).

   Семантика показала, что покрытия — второй кластер спроса после резки:
   цинкование, наплавка, порошковая окраска, хромирование и анодирование дают
   около 155 000 показов. Разбивать их на пять страниц оказалось рано —
   покрытия заявили 17 предприятий на весь каталог, — поэтому спрос забирает
   одна страница с разбором всех процессов. */

const { buildOperationContent, buildOperationFaqJsonLd } = require('../../lib/equipment-seo');
const COAT = operationBySlug('pokrytiya');

test('покрытия: на странице разобраны все процессы из спроса', () => {
    const html = buildOperationContent(COAT);
    for (const word of ['Горячее цинкование', 'Гальваническое', 'Хромирование', 'Анодирование', 'Порошковая окраска', 'Наплавка']) {
        assert.ok(html.includes(word), `в разборе нет процесса «${word}»`);
    }
    assert.match(html, /Что указать в заказе/);
    assert.match(html, /ГОСТ/, 'без ссылки на стандарт разбор бесполезен для заявки');
    assert.ok(html.length > 2000, `разбор в ${html.length} знаков — это снова тонкая страница`);
});

test('операция без разбора не даёт ни пустых заголовков, ни пустой разметки', () => {
    // У части операций разбора пока нет, и это нормально: пустой блок «Частые
    // вопросы» без вопросов хуже, чем его отсутствие. Операцию берём не по
    // имени, а первую ненаполненную — иначе тест ломается каждый раз, когда
    // очередная страница обзаводится текстом.
    const plain = OPERATIONS.find(o => !o.processes && !o.faq);
    assert.ok(plain, 'все операции наполнены — тест больше ничего не проверяет, замените его');
    assert.equal(buildOperationContent(plain), '');
    assert.equal(buildOperationFaqJsonLd(plain), '');
});

test('разметка вопросов собирается и не может разорвать тег скрипта', () => {
    const raw = buildOperationFaqJsonLd(COAT);
    assert.ok(!/[<>&]/.test(raw), 'в готовой разметке остались символы, способные закрыть <script>');
    const data = JSON.parse(raw);
    assert.equal(data['@type'], 'FAQPage');
    assert.equal(data.mainEntity.length, COAT.faq.length);
    assert.equal(data.mainEntity[0]['@type'], 'Question');
});

test('шаблон операции знает, куда класть разбор и разметку вопросов', () => {
    const fs = require('fs');
    const path = require('path');
    const tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'zakupki', 'oborudovanie-operation.html'), 'utf8');
    assert.match(tpl, /<!--OP_CONTENT-->/);
    assert.match(tpl, /<!--FAQ_LD-->/);
});

test('наплавка находит сварочные производства', () => {
    /* 30 000 показов в семантике, а в матчинге её не было ни у одной операции:
       завод, который пишет «наплавка» без слова «сварка», выпадал из каталога
       операций совсем. */
    const shop = { specialization: 'Восстановление валов наплавкой', products: '', about: '' };
    assert.ok(producerHasOperation(shop, WELD), 'наплавка не попала ни в одну операцию');
});

/* Лазерная резка (21.08.2026): 166 000 показов — самый крупный запрос ядра, а
   предприятий двое. Прежнее правило прятало такую страницу в noindex, то есть
   закрывало дверь ровно перед тем заказчиком, которого мы ищем. */

const { isOperationIndexable } = require('../../lib/equipment-seo');
const LASER = operationBySlug('lazernaya-rezka');

test('страница с разбором индексируется даже при коротком списке заводов', () => {
    assert.ok(LASER.processes && LASER.processes.length, 'у лазерной резки нет разбора');
    assert.equal(buildOperationRobots(2, LASER), 'index, follow');
    assert.ok(isOperationIndexable(LASER, 2));
});

test('страница без разбора и без заводов по-прежнему прячется', () => {
    const bare = operationBySlug('plazmennaya-rezka');
    assert.equal(buildOperationRobots(1, bare), 'noindex, follow');
    assert.ok(!isOperationIndexable(bare, 1));
    // А с полным списком — открывается, как и раньше.
    assert.equal(buildOperationRobots(MIN_INDEXABLE, bare), 'index, follow');
});

test('заголовок при коротком списке говорит про услугу, а не про размер каталога', () => {
    const thin = buildOperationTitle(LASER, 2);
    assert.ok(!/предприяти/.test(thin), `в заголовке осталось число заводов: «${thin}»`);
    assert.ok(thin.length <= 60, `${thin.length} знаков`);
    assert.match(thin, /Лазерная резка/);
    // Когда заводов наберётся, возвращается обычный заголовок с числом.
    assert.match(buildOperationTitle(LASER, 12), /12 предприятий/);
    assert.ok(buildOperationDescription(LASER, 2).length <= 160);
});

test('лазерная резка честно отказывает неметаллу', () => {
    /* «Лазерная резка фанеры» — 8 786 показов в ядре, но это CO₂ и другие
       исполнители. Обещать то, чего на площадке нет, — верный способ получить
       отказ от заказчика уже после регистрации. */
    const html = buildOperationContent(LASER);
    assert.match(html, /фанер/i);
    assert.match(html, /металл/i);
});

test('токарка: разобрано то, что рядом спрашивают', () => {
    /* В ядре вокруг точения стоят соседние запросы без своих страниц:
       токарно-фрезерные работы (2 400 показов), расточные (1 100) и шлифовка
       во всех формах (около 11 500). Пока они разобраны разделами здесь. */
    const html = buildOperationContent(operationBySlug('tokarka'));
    for (const word of ['ЧПУ', 'Токарно-фрезерная', 'Расточные', 'Шлифовка']) {
        assert.ok(html.includes(word), `в разборе точения нет раздела про «${word}»`);
    }
    assert.match(html, /квалитет/, 'без разговора о точности заявка приходит без допусков');
    assert.match(html, /Количество и повторяемость/, 'главный фактор цены не назван');
});
