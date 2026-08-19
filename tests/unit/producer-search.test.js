'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    CANDIDATES,
    tokenize,
    pickCandidates,
    buildRankingPrompt,
    applyRanking,
} = require('../../lib/producer-search');

/* Умный поиск по каталогу до 19.08.2026 отправлял в модель весь реестр —
   около 4500 строк на каждый запрос мимо кэша. Это работало только на
   миллионном окне Gemini и не переносилось на GigaChat вовсе. Теперь кандидатов
   отбирает код, а модель ранжирует короткий список. Тесты сторожат обе границы:
   отбор должен быть осмысленным, а промпт — оставаться коротким. */

const P = (over) => ({
    company: 'ООО «Завод»', city: '', specialization: '', products: '',
    capabilities: [], about: '', verifiedByPlatform: false, ...over,
});

const TOKAR = P({
    company: 'ООО «Механик»', city: 'Подольск, Московская область',
    specialization: 'Механическая обработка, токарные работы',
    products: 'валы; втулки; фланцы', capabilities: ['токарная обработка', 'фрезеровка'],
});
const RTI = P({
    company: 'АО «Уралрезина»', city: 'Екатеринбург',
    specialization: 'Резинотехнические изделия',
    products: 'манжеты; уплотнительные кольца',
});
const KABEL = P({
    company: 'ЗАО «Кабельный завод»', city: 'Пермь',
    specialization: 'Кабельная продукция', products: 'кабель силовой',
});
// Маркетинговый текст, в котором найдётся слово под любой запрос: ровно на таких
// профилях ломается наивный поиск «есть ли слово хоть где-нибудь».
const VODA = P({
    company: 'ООО «Универсал»', city: 'Тула',
    about: 'За 35 лет мы работали с металлом, резиной, кабелем и арматурой '
        + 'для сотен предприятий: токарные работы, уплотнения, шкафы управления.',
});

const ALL = [TOKAR, RTI, KABEL, VODA];
const names = (list) => list.map(c => c.producer.company);

test('слова запроса: служебное отсеивается, значимое остаётся', () => {
    const t = tokenize('Мне нужен производитель фланцев из нержавейки');
    assert.ok(!t.includes('нужен'), 'служебное слово попало в поиск');
    assert.ok(!t.some(w => 'производитель'.startsWith(w)), '«производитель» есть у всех и ничего не отбирает');
    assert.ok(t.some(w => 'фланцев'.startsWith(w)), 'потерялось само изделие');
    assert.ok(t.some(w => 'нержавейки'.startsWith(w)), 'потерялся материал');
});

test('запрос из одних общих слов не тянет каталог целиком', () => {
    /* «Ищу поставщика» — это ноль информации. Раньше такой запрос всё равно
       уезжал в модель вместе со всем реестром; теперь до модели он не доходит. */
    assert.deepEqual(pickCandidates(ALL, 'ищу поставщика для заказа'), []);
});

test('отбор идёт по профилю, а не по маркетинговому тексту', () => {
    const found = names(pickCandidates(ALL, 'токарная обработка валов'));
    assert.equal(found[0], 'ООО «Механик»', 'первым должен быть тот, у кого это в специализации');
    const universal = pickCandidates(ALL, 'токарная обработка валов').find(c => c.producer.company === 'ООО «Универсал»');
    const mechanic = pickCandidates(ALL, 'токарная обработка валов').find(c => c.producer.company === 'ООО «Механик»');
    assert.ok(!universal || universal.score < mechanic.score, '«о компании» не должно весить как объявленный профиль');
});

test('однокоренные находятся: «нержавейка» и «нержавеющая» — одно и то же', () => {
    const zavod = P({ company: 'ООО «Сталь»', specialization: 'Нержавеющая сталь, листовой прокат' });
    const found = names(pickCandidates([zavod, RTI], 'нержавейка листом'));
    assert.deepEqual(found, ['ООО «Сталь»']);
});

test('город человек называет по-своему: Подмосковье — это Московская область', () => {
    const found = names(pickCandidates(ALL, 'фланцы в Подмосковье'));
    assert.ok(found.includes('ООО «Механик»'), 'завод в Московской области не нашёлся по «Подмосковью»');
});

test('несколько совпавших слов весят больше одного случайного', () => {
    const scored = pickCandidates(ALL, 'резинотехнические изделия манжеты Екатеринбург');
    assert.equal(scored[0].producer.company, 'АО «Уралрезина»');
    assert.ok(scored[0].score > (scored[1] ? scored[1].score : 0), 'полное попадание должно отрываться от случайного');
});

test('в модель уходит короткий список, а не каталог', () => {
    // Тысяча одинаково подходящих заводов — модель должна увидеть сорок строк,
    // а не тысячу: ради этого вся переделка и затевалась.
    const many = Array.from({ length: 1000 }, (_, i) =>
        P({ company: `ООО «Механик-${i}»`, specialization: 'Токарные работы', about: 'x'.repeat(4000) }));
    const candidates = pickCandidates(many, 'токарные работы');
    assert.equal(candidates.length, CANDIDATES);

    const { user } = buildRankingPrompt('токарные работы', candidates);
    assert.ok(user.length < 12000, `промпт вырос до ${user.length} знаков — длинные профили просачиваются в запрос`);
    assert.ok(!user.includes('xxxxxxxxxx'), 'в промпт уехал текст «о компании» целиком');
});

test('ответ модели: чужие и повторные номера отбрасываются', () => {
    const candidates = pickCandidates(ALL, 'токарная обработка валов');
    const out = applyRanking(candidates, {
        matches: [
            { index: 0, reason: 'Точит валы нужного диаметра.' },
            { index: 0, reason: 'Он же ещё раз.' },
            { index: 999, reason: 'Завод, которого нет в списке.' },
            { index: 'ноль', reason: 'Номер не числом.' },
        ],
    });
    assert.equal(out.length, 1, 'дубль или выдуманный номер прошли в выдачу');
    assert.equal(out[0].company, candidates[0].producer.company);
    assert.equal(out[0].aiReason, 'Точит валы нужного диаметра.');
});

test('ответ модели без объяснения не ломает карточку', () => {
    const candidates = pickCandidates(ALL, 'манжеты');
    const out = applyRanking(candidates, { matches: [{ index: 0 }] });
    assert.equal(out.length, 1);
    assert.equal(out[0].aiReason, null, 'пустая причина должна быть null, а не строкой «undefined»');
});

test('мусор вместо ответа модели не роняет поиск', () => {
    const candidates = pickCandidates(ALL, 'манжеты');
    for (const junk of [null, undefined, {}, { matches: 'нет' }, { matches: [] }]) {
        assert.deepEqual(applyRanking(candidates, junk), [], `упало на ${JSON.stringify(junk)}`);
    }
});
