'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shortTitle, metaDescription, ssrProfileHtml } = require('../../lib/producer-seo');

// Реальная строка из каталога: длинное название с правовой формой в капсе — из-за
// таких title на карточках доходил до 180 знаков и обрезался в выдаче.
const GISP = {
    id: 355,
    company: 'АКЦИОНЕРНОЕ ОБЩЕСТВО "КУРСКАЯ ФАБРИКА ТЕХНИЧЕСКИХ ТКАНЕЙ"',
    city: 'Курская область',
    specialization: 'Резинотехнические изделия, ткани технические',
    products: 'манжеты; кольца уплотнительные; прокладки резиновые',
    about: '',
    inn: '4632012345',
    claimed: false,
    source: 'gisp-pp719',
    verified_by_platform: false,
};
const CLAIMED = {
    id: 12,
    company: 'ООО «Механик»',
    city: 'Челябинск',
    specialization: 'Металлообработка',
    products: 'токарная обработка; фрезерные работы',
    about: 'Механический завод полного цикла.',
    inn: '7451000000',
    claimed: true,
    source: '',
    verified_by_platform: true,
};

test('title: короткий, без правовой формы, укладывается в выдачу', () => {
    const t = shortTitle(GISP);
    assert.ok(t.length <= 65, `${t.length} знаков: ${t}`);
    assert.ok(!/АКЦИОНЕРНОЕ ОБЩЕСТВО/i.test(t), 'правовая форма должна быть убрана');
    assert.match(t, /Курская область/, 'город нужен: по нему ищут');
    assert.match(t, /ТехЗаказ$/, 'бренд в конце');
});

test('title: не обрывает слово, если имя само по себе длинное', () => {
    const t = shortTitle({ ...GISP, company: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "НАУЧНО ПРОИЗВОДСТВЕННОЕ ОБЪЕДИНЕНИЕ СПЕЦИАЛЬНЫХ МАТЕРИАЛОВ"' });
    assert.ok(t.length <= 65, `${t.length} знаков: ${t}`);
    assert.doesNotMatch(t, /\S…$/, 'обрезка должна идти по границе слова');
});

test('описание: до 160 знаков, по границе слова, из фактов профиля', () => {
    const d = metaDescription(GISP);
    assert.ok(d.length <= 160, `${d.length} знаков`);
    assert.match(d, /манжет|кольц|Резинотехн/i, 'описание должно опираться на продукцию или специализацию');
    assert.doesNotMatch(d, /\s…$/, 'висящее многоточие после пробела');
});

test('описание: пустой профиль не даёт пустой тег', () => {
    const d = metaDescription({ company: 'ООО Пустое', city: '', specialization: '', products: '', about: '' });
    assert.ok(d.length > 30, 'должен быть осмысленный запасной текст');
});

test('серверная разметка: отдаёт факты, а не «Загрузка профиля…»', () => {
    const html = ssrProfileHtml(GISP, { categories: ['РТИ'] });
    assert.match(html, /<h1[^>]*>/, 'нет h1');
    assert.ok(html.includes('Курская область'), 'нет города');
    assert.ok(html.includes('манжеты'), 'нет продукции');
    assert.match(html, /Реестр Минпромторга/, 'у стаба из ГИСП должна быть плашка реестра');

    const text = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(w => /[а-яА-ЯёЁa-zA-Z0-9]/.test(w));
    assert.ok(text.length >= 80, `в блоке ${text.length} слов, для карточки этого мало`);
});

test('серверная разметка: ставит ссылки на релевантные категории', () => {
    const html = ssrProfileHtml(GISP, { categories: ['РТИ'] });
    assert.ok(html.includes('/zakupki/rti'), 'нет ссылки на категорию РТИ');
    assert.ok(!html.includes('/zakupki/elektro'), 'лишняя категория в перелинковке');
});

test('серверная разметка: у присоединённой компании нет призыва «это ваша компания»', () => {
    const stub = ssrProfileHtml(GISP, { categories: [] });
    const claimed = ssrProfileHtml(CLAIMED, { categories: ['Металл'] });
    assert.match(stub, /присоедин/i, 'стаб должен звать владельца присоединить профиль');
    assert.doesNotMatch(claimed, /присоедин/i, 'у присоединённой компании такого призыва быть не должно');
    assert.match(claimed, /Проверен/i, 'верифицированной компании нужна плашка проверки');
});

test('серверная разметка: враждебные данные экранируются', () => {
    const html = ssrProfileHtml({ ...GISP, company: '<img src=x onerror=alert(1)>', products: '<script>alert(2)</script>' }, { categories: [] });
    assert.ok(!html.includes('<img src=x'), 'имя компании попало в разметку как есть');
    assert.ok(!html.includes('<script>alert(2)'), 'продукция попала в разметку как есть');
    assert.match(html, /&lt;img src=x/, 'ожидалось экранирование');
});
