'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    matchSubscribers, isQuiet, notificationText, normalizeChannel, QUIET_MINUTES,
} = require('../../lib/order-subscriptions');

/* Подписка на заказы — ТЗ §6.6. Появилась не от хорошей жизни: пустое состояние
   хаба заказов уже предлагало подписаться, а механизма не было. Обещание без
   механизма запрещено тем же §6.6, что и обещание несуществующих заявок. */

const sub = (over = {}) => ({
    id: 1, company: 'ООО Исполнитель', service_id: null, product_id: null,
    region: '', channel: 'email', last_sent_at: null, topic: 'Токарная обработка', ...over,
});

test('подписка по услуге срабатывает на заявку с этой услугой', () => {
    const matched = matchSubscribers([sub({ service_id: 7 })], { services: [7], products: [] });
    assert.equal(matched.length, 1);
});

test('подписка по изделию не срабатывает на чужую тему', () => {
    const matched = matchSubscribers([sub({ product_id: 3 })], { services: [7], products: [9] });
    assert.equal(matched.length, 0);
});

test('заявка без связей не уведомляет никого', () => {
    // Если заявку не удалось сопоставить со справочником, она и в хаб не
    // попадёт — уведомлять о ней подписчиков хаба неоткуда.
    assert.equal(matchSubscribers([sub({ service_id: 7 })], { services: [], products: [] }).length, 0);
});

test('регион в подписке сужает, пустой означает «везде»', () => {
    const anywhere = sub({ service_id: 7, region: '' });
    const moscow = sub({ id: 2, service_id: 7, region: 'Москва' });
    const inPerm = { services: [7], products: [], region: 'Пермь' };
    const matched = matchSubscribers([anywhere, moscow], inPerm);
    assert.deepEqual(matched.map(m => m.id), [1], 'московская подписка на пермскую заявку не реагирует');
});

test('регион сравнивается без учёта регистра и пробелов', () => {
    const matched = matchSubscribers(
        [sub({ service_id: 7, region: ' москва ' })],
        { services: [7], products: [], region: 'Москва' }
    );
    assert.equal(matched.length, 1);
});

// ─────────────────── Частота ───────────────────

test('второе письмо в течение часа не уходит', () => {
    // Заявки приходят пачками, и десять писем подряд — причина отписаться,
    // а не полезное уведомление.
    const now = Date.now();
    const recent = sub({ last_sent_at: new Date(now - 10 * 60 * 1000).toISOString() });
    assert.equal(isQuiet(recent, now), true);
});

test('через час тишина заканчивается', () => {
    const now = Date.now();
    const old = sub({ last_sent_at: new Date(now - (QUIET_MINUTES + 1) * 60 * 1000).toISOString() });
    assert.equal(isQuiet(old, now), false);
});

test('первая отправка не считается частой', () => {
    assert.equal(isQuiet(sub({ last_sent_at: null })), false);
});

test('битая дата не блокирует уведомления навсегда', () => {
    // Иначе одна испорченная строка молча отключила бы подписку.
    assert.equal(isQuiet(sub({ last_sent_at: 'не дата' })), false);
});

// ─────────────────── Текст и канал ───────────────────

test('в уведомлении есть предмет и срок — по ним решают, открывать ли', () => {
    const text = notificationText(
        { title: 'Вал ступенчатый Ø40', deadline: '01.10.2026', quantity: 200 },
        'Токарная обработка'
    );
    assert.match(text, /Токарная обработка/);
    assert.match(text, /Вал ступенчатый/);
    assert.match(text, /01\.10\.2026/);
    assert.match(text, /200 шт/);
});

test('отсутствующие поля не превращаются в пустые хвосты', () => {
    const text = notificationText({ title: 'Вал' }, 'Валы');
    assert.equal(text, 'Новая заявка по теме «Валы»: Вал');
});

test('неизвестный канал уведомления сводится к почте', () => {
    assert.equal(normalizeChannel('карьерный голубь'), 'email');
    assert.equal(normalizeChannel(''), 'email');
    assert.equal(normalizeChannel('telegram'), 'telegram');
});
