'use strict';

// Длины редакторских полей: сколько рекомендуется и что делать при превышении.
//
// Правило задано маркетингом (ответ 22.09, пункт 8) и оно важнее, чем кажется:
//
//   «Рекомендуем показывать рядом с полем текущее количество знаков и
//    рекомендуемую длину. При превышении — выводить предупреждение, но
//    сохранять возможность записать значение целиком, без автоматического
//    обрезания и блокировки сохранения».
//
// То есть ограничение здесь — совет, а не запрет, и это сознательный выбор
// стороны, которая пишет тексты. Автообрезание хуже длинного заголовка: оно
// молча портит работу редактора и обнаруживается уже в выдаче. Блокировка
// сохранения хуже обоих: человек теряет написанное.
//
// Поэтому модуль ничего не режет и ничего не запрещает. Он умеет ровно одно —
// сказать, сколько знаков сейчас и сколько рекомендовано. Решение остаётся за
// редактором.
//
// Отдельно от совета есть страховка от случайной вставки: HARD_CEILING. Это не
// правило длины, а защита от «вставил весь документ в поле заголовка» — предел
// на два порядка выше любого осмысленного текста.

/* Рекомендуемые длины. Первые две — не наши пожелания, а границы, после
   которых поисковая выдача обрезает строку многоточием. Остальные — из
   практики текстов кластера (ТЗ §6, «до 8 000–10 000 знаков на кластер»). */
const FIELDS = {
    title: {
        label: 'Title',
        recommended: 60,
        hint: 'После 60 знаков выдача обрезает заголовок многоточием.',
    },
    description: {
        label: 'Description',
        recommended: 160,
        hint: 'После 160 знаков сниппет обрезается. Главное — в первых 120.',
    },
    h1: {
        label: 'H1',
        recommended: 70,
        hint: 'Заголовок страницы. Длиннее — плохо читается на телефоне.',
    },
    intro: {
        label: 'Вводный текст',
        recommended: 900,
        hint: 'Первый абзац страницы. Длинный текст лучше разбить на разделы.',
    },
};

/* Страховка от случайной вставки, а не правило длины. Различие принципиальное:
   рекомендацию можно превысить, этот предел — признак того, что в поле попало
   не то, что собирались положить. */
const HARD_CEILING = 20000;

const FIELD_NAMES = Object.keys(FIELDS);

/** Знаков с пробелами. Считаем по кодовым точкам, а не по length: у строки
 *  с эмодзи или редким символом length вернёт двойку за один знак, и счётчик
 *  под полем разойдётся с тем, что человек видит. */
function countChars(value) {
    return [...String(value == null ? '' : value)].length;
}

/** Знаков без пробелов — в этих единицах маркетинг задаёт объём текстов. */
function countCharsNoSpaces(value) {
    return [...String(value == null ? '' : value).replace(/\s+/g, '')].length;
}

/**
 * Померить одно поле.
 *
 * Значение возвращается нетронутым — ни обрезки, ни нормализации, кроме снятия
 * крайних пробелов. Превышение отражается в `over` и в тексте предупреждения,
 * но никогда не меняет само значение и не делает результат невалидным.
 *
 * @param {string} field имя поля из FIELDS
 * @param {string} value что написал редактор
 * @returns {{field:string, label:string, chars:number, charsNoSpaces:number,
 *            recommended:number, over:number, warning:string, tooLong:boolean}}
 */
function measure(field, value) {
    const spec = FIELDS[field];
    if (!spec) throw Object.assign(new Error(`Неизвестное поле: ${field}`), { status: 400 });
    const text = String(value == null ? '' : value);
    const chars = countChars(text);
    const over = Math.max(0, chars - spec.recommended);
    return {
        field,
        label: spec.label,
        chars,
        charsNoSpaces: countCharsNoSpaces(text),
        recommended: spec.recommended,
        over,
        // Предупреждение — это текст для человека, а не код ошибки. Оно
        // сообщает последствие, а не запрещает: «обрежет выдача», не «нельзя».
        warning: over
            ? `${spec.label}: ${chars} ${plural(chars, 'знак', 'знака', 'знаков')} при рекомендуемых ${spec.recommended}. ${spec.hint}`
            : '',
        tooLong: over > 0,
    };
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

/**
 * Померить все переданные поля разом.
 *
 * Поля, которых нет в теле запроса, не трогаются вовсе: правка одного лишь
 * заголовка не должна стирать описание.
 *
 * @param {object} body тело запроса
 * @returns {{values:object, warnings:Array, measures:Array}}
 */
function measureAll(body) {
    const values = {};
    const measures = [];
    for (const field of FIELD_NAMES) {
        if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
        const raw = String(body[field] == null ? '' : body[field]).trim();
        if (countChars(raw) > HARD_CEILING) {
            throw Object.assign(
                new Error(`${FIELDS[field].label}: больше ${HARD_CEILING} знаков — похоже, в поле попал не тот текст`),
                { status: 400 }
            );
        }
        values[field] = raw;
        measures.push(measure(field, raw));
    }
    return {
        values,
        measures,
        warnings: measures.filter(m => m.tooLong).map(m => m.warning),
    };
}

/** Что показать рядом с полем: рекомендуемая длина и пояснение. Отдаётся
 *  админке отдельной ручкой, чтобы счётчик не пришлось зашивать в вёрстку. */
function limits() {
    return FIELD_NAMES.map(field => ({
        field,
        label: FIELDS[field].label,
        recommended: FIELDS[field].recommended,
        hint: FIELDS[field].hint,
        ceiling: HARD_CEILING,
    }));
}

module.exports = {
    FIELDS, FIELD_NAMES, HARD_CEILING,
    countChars, countCharsNoSpaces, measure, measureAll, limits,
};
