'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, clusterize, classify, growth, buildQueue, MIN_HITS } = require('../../lib/search-demand');
const { buildIndex } = require('../../lib/catalog-match');

/* Панель поискового спроса — ТЗ §8.3 и §13.3. Журнал пишется с августа, но
   пока его никто не разбирал, это просто таблица. Самое ценное здесь не топ
   запросов, а то, чего не находят: это спрос, которого у нас нет. */

const row = (q, over = {}) => ({
    query_normalized: q, results_count: 5, conversion: null,
    role: 'customer', clicked_entity: null, created_at: '2026-09-10T10:00:00Z', ...over,
});

test('повторы одной фразы сводятся в одну строку', () => {
    const items = summarize([row('валы'), row('валы'), row('фланцы')]);
    assert.equal(items.length, 2);
    assert.equal(items[0].query, 'валы');
    assert.equal(items[0].hits, 2, 'частые фразы идут первыми');
});

test('доля пустых выдач считается, а не только их число', () => {
    // Фраза, которая иногда находится, а иногда нет, — это проблема
    // ранжирования; всегда пустая — дыра в каталоге. Разные диагнозы.
    const items = summarize([
        row('лазерная резка', { results_count: 0 }),
        row('лазерная резка', { results_count: 0 }),
        row('лазерная резка', { results_count: 3 }),
    ]);
    assert.equal(items[0].zeroHits, 2);
    assert.ok(Math.abs(items[0].zeroRate - 2 / 3) < 0.01);
});

test('конверсии и клики считаются отдельно', () => {
    const items = summarize([
        row('валы', { conversion: 'order_created', clicked_entity: 'company:5' }),
        row('валы', { clicked_entity: 'company:7' }),
        row('валы'),
    ]);
    assert.equal(items[0].conversions, 1);
    assert.equal(items[0].clicked, 2);
});

test('пустые фразы в сводку не попадают', () => {
    assert.deepEqual(summarize([row(''), row('   '), row(null)]), []);
});

// ─────────────────── Кластеры ───────────────────

test('фразы об одном собираются в кластер', () => {
    // Три запроса — один спрос, и заводить под них три страницы нельзя.
    const items = summarize([
        row('изготовление валов'), row('валы на заказ'), row('вал ступенчатый'),
        row('фланцы гост'),
    ]);
    const clusters = clusterize(items);
    const valy = clusters.find(c => c.queries.some(q => q.includes('вал')));
    assert.equal(valy.queries.length, 3, 'все три фразы про валы в одном кластере');
    assert.ok(clusters.some(c => c.queries.includes('фланцы гост')), 'фланцы — отдельный кластер');
});

test('кластер суммирует обращения своих фраз', () => {
    const items = summarize([row('валы'), row('валы'), row('изготовление валов')]);
    const [c] = clusterize(items);
    assert.equal(c.hits, 3);
});

// ─────────────────── Предложения ───────────────────

const DICT = buildIndex([
    { id: 1, name: 'Токарная обработка', synonyms: ['токарка'] },
    { id: 2, name: 'Валы' },
]);

test('редкая фраза считается шумом', () => {
    // Один человек мог искать пять раз, исправляя опечатку.
    const [item] = summarize([row('что-то очень редкое')]);
    assert.ok(item.hits < MIN_HITS);
    assert.equal(classify(item, DICT).action, 'noise');
});

test('фраза, покрытая справочником, не требует действий', () => {
    const [item] = summarize([row('токарка'), row('токарка')]);
    const s = classify(item, DICT);
    assert.equal(s.action, 'covered');
    assert.equal(s.entity, 'Токарная обработка');
});

test('справочник знает тему, а каталог ничего не находит — это про наполнение', () => {
    // Важное различие: структура в порядке, не хватает предприятий.
    const [item] = summarize([
        row('валы', { results_count: 0 }),
        row('валы', { results_count: 0 }),
    ]);
    const s = classify(item, DICT);
    assert.equal(s.action, 'no_supply');
    assert.match(s.why, /каталог ничего не находит/);
});

test('тема неизвестна и ничего не находится — кандидат в справочник', () => {
    const [item] = summarize([
        row('гидроабразивная резка', { results_count: 0 }),
        row('гидроабразивная резка', { results_count: 0 }),
    ]);
    assert.equal(classify(item, DICT).action, 'new_entity');
});

test('каталог находит, а справочник тему не знает — похоже на синоним', () => {
    const [item] = summarize([row('точение деталей'), row('точение деталей')]);
    const s = classify(item, DICT);
    assert.equal(s.action, 'synonym');
});

// ─────────────────── Рост ───────────────────

test('рост считается сравнением периодов', () => {
    assert.equal(growth(150, 100), 50);
    assert.equal(growth(50, 100), -50);
    assert.equal(growth(100, 100), 0);
});

test('рост с нуля не показывается как сто процентов', () => {
    // «Рост на 100%» с нулевой базы вводит в заблуждение.
    assert.equal(growth(10, 0), null);
    assert.equal(growth(0, 0), 0);
});

// ─────────────────── Очередь ───────────────────

test('очередь раскладывает спрос по корзинам решений', () => {
    const rows = [
        row('токарка'), row('токарка'),
        row('гидроабразивная резка', { results_count: 0 }),
        row('гидроабразивная резка', { results_count: 0 }),
        row('единичный запрос'),
    ];
    const queue = buildQueue(rows, [
        { id: 1, name: 'Токарная обработка', synonyms: ['токарка'] },
    ]);
    const byAction = Object.fromEntries(queue.map(i => [i.query, i.suggestion.action]));
    assert.equal(byAction['токарка'], 'covered');
    assert.equal(byAction['гидроабразивная резка'], 'new_entity');
    assert.equal(byAction['единичный запрос'], 'noise', 'шум остаётся в списке, но помечен');
});

test('пустой справочник не ломает разбор', () => {
    // На старте справочник действительно пуст — всё должно становиться
    // кандидатами, а не падать.
    const queue = buildQueue([row('валы'), row('валы')], []);
    assert.equal(queue.length, 1);
    assert.ok(['new_entity', 'synonym'].includes(queue[0].suggestion.action));
});
