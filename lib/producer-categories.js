'use strict';

// Классификатор заводов для публичных витрин (категорийные страницы /zakupki/*).
//
// Зачем отдельный от CATEGORY_KEYWORDS в server.js: тот ищет подстроки по
// specialization + equipment + capabilities + about и любую находку считает
// достаточной. На длинном маркетинговом about это ломается — кабельный завод
// «Марпосадкабель» получал все четыре категории сразу, потому что в тексте про
// 35 лет истории найдётся слово под каждую. Трогать общий классификатор нельзя:
// на нём висят карта и биржа мощностей.
//
// Здесь строже: вес имеет то, что завод сам объявил профилем (specialization,
// products), а about — только как дополнение. И если компания всё равно
// «подошла» больше чем к двум категориям, остаются лучшие по баллу.

const CATEGORY_WORDS = {
    'РТИ': [
        'рти', 'резин', 'резинотехн', 'уплотнен', 'манжет', 'прокладк', 'сальник',
        'вулканиз', 'эластомер', 'полиуретан', 'силикон', 'футеровк', 'резинометалл',
    ],
    'Металл': [
        'металлообработ', 'мехобработ', 'механическая обработ', 'токарн', 'фрезер',
        'расточн', 'шлифов', 'штамповк', 'ковк', 'поковк', 'литейн', 'литьё', 'литье',
        'металлоконструкц', 'сварн', 'лазерн раскрой', 'листогиб', 'чпу', 'нержавеющ',
    ],
    'Трубопроводная арматура': [
        'трубопроводн арматур', 'запорн арматур', 'арматур', 'задвижк', 'шаров кран',
        'клапан', 'затвор', 'фланц', 'фитинг', 'отвод', 'тройник', 'трубопровод',
    ],
    'Электрооборудование': [
        // «провод» без уточнения ловится внутри «трубопроводная» — берём только
        // однозначные формы.
        'электрооборудован', 'электротехн', 'кабельн', 'кабел', 'проводник', 'провода',
        'щит управлен', 'шкаф управлен', 'нку', 'электродвигател', 'трансформатор',
        'электропривод', 'преобразователь частот', 'кип', 'взрывозащищ',
    ],
};

const CATEGORY_NAMES = Object.keys(CATEGORY_WORDS);

// Профиль весит больше маркетингового текста: совпадение в specialization или
// products само по себе достаточно, совпадение в about — только половина.
const PROFILE_WEIGHT = 2;
const ABOUT_WEIGHT = 1;
const QUALIFY_SCORE = 2;
// Больше двух категорий у одного завода — почти всегда шум, а не универсальность.
const MAX_CATEGORIES = 2;

function normalize(value) {
    if (Array.isArray(value)) return value.join(' ').toLowerCase().replace(/ё/g, 'е');
    return String(value || '').toLowerCase().replace(/ё/g, 'е');
}

function countHits(text, words) {
    let hits = 0;
    for (const word of words) {
        if (text.includes(word.replace(/ё/g, 'е'))) hits++;
    }
    return hits;
}

/**
 * @param {object} producer профиль завода (specialization, products, about)
 * @returns {string[]} категории витрины, от самой уверенной к менее
 */
function categorizeProducer(producer) {
    if (!producer || typeof producer !== 'object') return [];

    const profile = `${normalize(producer.specialization)} ${normalize(producer.products)}`;
    const about = normalize(producer.about);

    const scored = [];
    for (const category of CATEGORY_NAMES) {
        const words = CATEGORY_WORDS[category];
        const profileHits = countHits(profile, words);
        // Упоминание в маркетинговом тексте само по себе категорию не даёт:
        // завод должен объявить это профилем или продукцией.
        if (profileHits === 0) continue;
        const score = profileHits * PROFILE_WEIGHT + countHits(about, words) * ABOUT_WEIGHT;
        if (score >= QUALIFY_SCORE) scored.push({ category, score });
    }
    if (!scored.length) return [];

    // Всеядный профиль отсекается по количеству: берём сильнейшие категории,
    // а не все, к которым нашлось хоть одно слово.
    scored.sort((a, b) => b.score - a.score || CATEGORY_NAMES.indexOf(a.category) - CATEGORY_NAMES.indexOf(b.category));
    return scored.slice(0, MAX_CATEGORIES).map(s => s.category);
}

module.exports = { categorizeProducer, CATEGORY_WORDS, CATEGORY_NAMES };
