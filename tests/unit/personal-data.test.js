'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    isSoleTraderName,
    publicCompanyName,
    excludeUnclaimedSoleTradersSql,
} = require('../../lib/personal-data');
const { scrubEvent, SCRUB } = require('../../lib/sentry-scrub');

/* Наименование ИП в реестре — это ФИО живого человека, то есть персональные
   данные. Реестр открыт, но открытость источника не даёт права печатать имя в
   каталоге (152-ФЗ, ст. 10.1) и слать по нему рекламу (ФЗ-38, ст. 18 ч. 1).
   Тесты сторожат именно границу: что уходит наружу и кому мы пишем. */

test('ИП распознаётся в обоих написаниях реестра', () => {
    assert.ok(isSoleTraderName('ИП АБАЕВ АЛЕКСАНДР ГЕННАДЬЕВИЧ'));
    assert.ok(isSoleTraderName('Индивидуальный предприниматель Ласкина Татьяна Сергеевна'));
    assert.ok(!isSoleTraderName('АО «КУРСКАЯ ФАБРИКА ТЕХНИЧЕСКИХ ТКАНЕЙ»'));
    // «ИПиг» — не ИП: правило смотрит на границу слова, а не на первые две буквы.
    assert.ok(!isSoleTraderName('ООО ИПиГ'));
});

test('незабранная карточка ИП уходит наружу без полного имени', () => {
    const row = { company: 'ИП НИКОЛЕНКО АНДРЕЙ ФЁДОРОВИЧ', claimed: false };
    assert.equal(publicCompanyName(row), 'ИП Николенко А. Ф.');
});

test('забрал карточку — показываем как есть: данные его собственные', () => {
    const row = { company: 'ИП НИКОЛЕНКО АНДРЕЙ ФЁДОРОВИЧ', claimed: true };
    assert.equal(publicCompanyName(row), 'ИП НИКОЛЕНКО АНДРЕЙ ФЁДОРОВИЧ');
});

test('юрлицо не трогаем', () => {
    const row = { company: 'АО «АВАНГАРД»', claimed: false };
    assert.equal(publicCompanyName(row), 'АО «АВАНГАРД»');
});

test('SQL-условие умеет и с алиасом, и без', () => {
    assert.match(excludeUnclaimedSoleTradersSql('c'), /c\.claimed = false/);
    assert.match(excludeUnclaimedSoleTradersSql('c'), /c\.company ~\*/);
    assert.match(excludeUnclaimedSoleTradersSql(''), /\(claimed = false/);
});

/* Sentry — сервис за пределами РФ. В отчёт об ошибке нужен стек, а не почта
   заказчика: всё, по чему человека можно узнать, вырезается до отправки. */

test('из отчёта Sentry вычищаются тело запроса и контакты', () => {
    const event = scrubEvent({
        message: 'Отказ для ivan.petrov@zavod.ru, тел. +7 900 123-45-67',
        request: {
            url: 'https://texzakaz.ru/api/orders?email=ivan.petrov@zavod.ru',
            data: { password: 'hunter2', description: 'секретный чертёж' },
            cookies: { token: 'abc' },
            headers: { authorization: 'Bearer xyz', 'user-agent': 'Chrome' },
        },
        user: { id: 42, email: 'ivan.petrov@zavod.ru' },
        extra: { inn: '7729634801', note: 'звонить на 8(900)1234567' },
    });

    assert.equal(event.request.data, undefined, 'тело запроса не отправляем вовсе');
    assert.equal(event.request.cookies, undefined);
    assert.equal(event.request.headers.authorization, SCRUB);
    assert.equal(event.request.headers['user-agent'], 'Chrome', 'браузер для диагностики нужен');
    assert.ok(!event.request.url.includes('ivan.petrov@zavod.ru'));
    assert.deepEqual(event.user, { id: 42 }, 'от пользователя остаётся только номер');
    assert.ok(!event.message.includes('ivan.petrov@zavod.ru'));
    assert.ok(!event.message.includes('900'));
    assert.equal(event.extra.inn, SCRUB);
    assert.ok(!event.extra.note.includes('1234567'));
});

test('сломанное событие не отправляется, а не роняет обработчик', () => {
    const circular = { message: 'сбой' };
    circular.extra = { self: circular };
    // Главное — обработчик не бросает исключение: иначе он гасит весь отчёт.
    assert.doesNotThrow(() => scrubEvent(circular));
});
