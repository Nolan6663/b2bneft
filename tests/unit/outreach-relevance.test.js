'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relevanceScore, pickRelevant } = require('../../lib/outreach');

// Профили — из реальных писем в outreach.log за 29.07.2026.
const RTI = { company: 'ООО РТИ-Групп', specialization: 'Резинотехнические изделия', products: 'манжеты армированные, прокладки, сальники' };
const METAL = { company: 'ООО Завод', specialization: 'Металлообработка', products: 'токарная и фрезерная обработка по чертежам, поковки' };
const ARMATURE = { company: 'ООО Арм', specialization: 'Трубопроводная арматура', products: 'задвижки, шаровые краны, фланцы' };
const TUPOLEV = { company: 'АКЦИОНЕРНОЕ ОБЩЕСТВО "ТУПОЛЕВ"', specialization: 'Авиастроение', products: 'самолёты Ту-214' };
const CATERING = { company: 'АО ТУЛАТОРГТЕХНИКА', specialization: 'Торговое оборудование', products: 'столы разделочные производственные, плиты кухонные, стеллажи технологические' };
const EMPTY = { company: 'ООО Ничего', specialization: '', products: '' };

test('релевантность: профиль по нашим категориям получает ненулевой балл', () => {
    assert.ok(relevanceScore(RTI) > 0, 'РТИ должно попадать');
    assert.ok(relevanceScore(METAL) > 0, 'металлообработка должна попадать');
    assert.ok(relevanceScore(ARMATURE) > 0, 'арматура должна попадать');
});

test('релевантность: чужие отрасли получают ноль', () => {
    assert.equal(relevanceScore(TUPOLEV), 0, 'производитель самолётов не наш адресат');
    assert.equal(relevanceScore(CATERING), 0, 'кухонные плиты и стеллажи — не наш адресат');
    assert.equal(relevanceScore(EMPTY), 0, 'пустой профиль оценивать нечем');
});

test('релевантность: совпадение по нескольким группам ценится выше', () => {
    const multi = { company: 'ООО Много', specialization: 'Металлообработка и РТИ', products: 'фланцы, манжеты, насосы' };
    assert.ok(relevanceScore(multi) > relevanceScore(METAL), 'несколько групп — выше одной');
});

test('релевантность: регистр и падежи в тексте профиля не мешают', () => {
    const upper = { company: 'ООО К', specialization: 'ПРОИЗВОДСТВО РЕЗИНОТЕХНИЧЕСКИХ ИЗДЕЛИЙ', products: '' };
    assert.ok(relevanceScore(upper) > 0);
});

test('отбор: берутся только релевантные, лучшие первыми, с учётом лимита', () => {
    const picked = pickRelevant([TUPOLEV, RTI, CATERING, ARMATURE, METAL], 2);
    assert.equal(picked.length, 2);
    for (const p of picked) assert.ok(relevanceScore(p) > 0, 'нерелевантных в выборке быть не должно');
    assert.ok(relevanceScore(picked[0]) >= relevanceScore(picked[1]), 'порядок по убыванию балла');
});

test('отбор: если релевантных меньше лимита, отдаём сколько есть и не добираем чужими', () => {
    const picked = pickRelevant([TUPOLEV, CATERING, RTI], 10);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].company, RTI.company);
});

test('отбор: пустой список не роняет', () => {
    assert.deepEqual(pickRelevant([], 5), []);
});
