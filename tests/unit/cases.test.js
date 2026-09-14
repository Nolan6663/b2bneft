'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    validateForReview, adWarnings, canTransition, isPublic,
    publicView, buildSlug, sanitize,
} = require('../../lib/cases');
const caseSeo = require('../../lib/case-seo');

/* Кейс — подтверждение «мы сделали», в отличие от профиля, который заявляет
   «мы умеем». Тесты давят на три места, где цена ошибки чужая: имя заказчика,
   право публикации и содержательность. */

const full = (over = {}) => ({
    title: 'Вал ступенчатый Ø40, партия 200 шт',
    product_id: 3,
    services: [{ id: 1 }],
    task: 'Требовался вал с посадочными шейками под подшипники, материал сталь 45.',
    solution: 'Точение на ЧПУ с последующей шлифовкой в центрах, контроль биения.',
    result: 'Партия принята с первого предъявления за 12 дней.',
    customer_named: false,
    customer_name: '',
    ...over,
});

// ─────────────────── Конфиденциальность заказчика ───────────────────

test('по умолчанию кейс обезличен', () => {
    // Галочка «имя раскрывать разрешено» снимается сознательно, а не
    // забывается: цена ошибки здесь чужая.
    const d = sanitize({ title: 'Вал', customerName: 'ООО Заказчик' });
    assert.equal(d.customerNamed, false);
    assert.equal(d.customerName, '', 'имя без разрешения не сохраняется вовсе');
});

test('имя сохраняется только вместе с разрешением', () => {
    const d = sanitize({ title: 'Вал', customerNamed: true, customerName: 'ООО Заказчик' });
    assert.equal(d.customerNamed, true);
    assert.equal(d.customerName, 'ООО Заказчик');
});

test('разрешение без имени — повод переспросить', () => {
    const problems = validateForReview(full({ customer_named: true, customer_name: '' }));
    assert.ok(problems.some(p => /имя не указано/i.test(p)));
});

test('имя без разрешения не пропускается на модерацию', () => {
    const problems = validateForReview(full({ customer_named: false, customer_name: 'ООО Заказчик' }));
    assert.ok(problems.some(p => /без разрешения/i.test(p)));
});

test('имя заказчика не уходит в публичный вид без разрешения', () => {
    const withName = publicView({ slug: 'x', title: 'Вал', customer_named: false, customer_name: 'ООО Заказчик' });
    assert.equal(withName.customer, null);
    const allowed = publicView({ slug: 'x', title: 'Вал', customer_named: true, customer_name: 'ООО Заказчик' });
    assert.equal(allowed.customer, 'ООО Заказчик');
});

// ─────────────────── Содержательность ───────────────────

test('заполненный кейс уходит на модерацию', () => {
    assert.deepEqual(validateForReview(full()), []);
});

test('кейс без задачи и решения — заголовок, а не подтверждение', () => {
    const problems = validateForReview(full({ task: '', solution: '' }));
    assert.ok(problems.some(p => /Задача/.test(p)));
    assert.ok(problems.some(p => /Решение/.test(p)));
});

test('кейс, не привязанный ни к чему, не попадёт ни на одну страницу', () => {
    const problems = validateForReview(full({ product_id: null, services: [] }));
    assert.ok(problems.some(p => /изделие или хотя бы одну услугу/i.test(p)));
});

test('рекламные штампы подсвечиваются автору', () => {
    // Не запрет, а подсказка: решение всё равно за модератором (ТЗ §9.4).
    const w = adWarnings(full({ title: 'Лидер рынка: уникальные валы' }));
    assert.ok(w.length >= 1, JSON.stringify(w));
});

// ─────────────────── Статусы ───────────────────

test('исполнитель не может опубликовать себя сам', () => {
    const r = canTransition('review', 'published', 'owner');
    assert.equal(r.allowed, false);
    assert.match(r.why, /только модератор/i);
});

test('модератор публикует и возвращает на доработку', () => {
    assert.equal(canTransition('review', 'published', 'admin').allowed, true);
    assert.equal(canTransition('review', 'changes_requested', 'admin').allowed, true);
});

test('после возврата кейс можно отправить снова', () => {
    assert.equal(canTransition('changes_requested', 'review', 'owner').allowed, true);
});

test('из черновика нельзя прыгнуть в опубликованные', () => {
    assert.equal(canTransition('draft', 'published', 'admin').allowed, false);
});

test('исполнитель может снять свой кейс с публикации', () => {
    // Своё право убрать работу из витрины у предприятия должно остаться.
    assert.equal(canTransition('published', 'hidden', 'owner').allowed, true);
});

test('неизвестный статус отвергается', () => {
    assert.match(canTransition('draft', 'опубликован', 'admin').why, /Неизвестный статус/);
});

test('публичным считается только опубликованный', () => {
    assert.equal(isPublic({ status: 'published' }), true);
    for (const s of ['draft', 'review', 'changes_requested', 'hidden']) {
        assert.equal(isPublic({ status: s }), false, s);
    }
});

// ─────────────────── Адрес ───────────────────

test('адрес кейса включает номер предприятия', () => {
    // Два завода могут назвать работу одинаково — адреса обязаны различаться.
    const a = buildSlug('Вал ступенчатый', 5);
    const b = buildSlug('Вал ступенчатый', 9);
    assert.notEqual(a, b);
    assert.match(a, /^val-stupenchatyy-5$/);
});

test('пустое название не даёт пустой адрес', () => {
    assert.match(buildSlug('!!!', 7), /^keys-7$/);
});

// ─────────────────── Страница ───────────────────

const CASE = {
    id: 1, slug: 'val-40-5', title: 'Вал ступенчатый Ø40, партия 200 шт',
    company_name: 'ООО «Станкозавод»', product_name: 'Валы',
    material: 'Сталь 45', quantity: 200, tolerance: 'h7', roughness: 'Ra 1,6',
    task: 'Нужен вал с посадочными шейками.', solution: 'Точение и шлифовка.',
    result: 'Принято с первого предъявления.', customer_named: false, customer_name: '',
};

test('заголовок страницы называет предприятие', () => {
    const t = caseSeo.buildTitle(CASE);
    assert.match(t, /Станкозавод/);
    assert.ok(t.length <= 60, String(t.length));
});

test('описание ведёт числами, а не прилагательными', () => {
    const d = caseSeo.buildDescription(CASE);
    assert.match(d, /Сталь 45/);
    assert.match(d, /200 штук/);
    assert.ok(d.length <= 160);
});

test('первый экран показывает параметры, пустые поля не выводятся', () => {
    const stats = caseSeo.buildStats(CASE);
    assert.match(stats, /Сталь 45/);
    assert.match(stats, /h7/);
    const bare = caseSeo.buildStats({ title: 'Вал' });
    assert.equal(bare, '', 'прочерк в карточке хуже отсутствия строки');
});

test('тело страницы ведёт к размещению закупки', () => {
    // Кейс должен заканчиваться не точкой, а возможностью заказать похожее.
    const body = caseSeo.buildBody(CASE, []);
    assert.match(body, /href="\/zayavka"/);
});

test('данные кейса экранируются', () => {
    const body = caseSeo.buildBody({ ...CASE, task: '<script>alert(1)</script>' }, []);
    assert.ok(!body.includes('<script>'), body.slice(0, 200));
});

test('разметка называет автором предприятие, а не платформу', () => {
    const ld = JSON.parse(caseSeo.buildJsonLd(CASE, [], 'https://texzakaz.ru')
        .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
    assert.equal(ld.author.name, 'ООО «Станкозавод»');
    assert.equal(ld.url, 'https://texzakaz.ru/keisy/val-40-5');
});
