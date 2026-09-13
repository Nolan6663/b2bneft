'use strict';

// Транслитерация русских названий в slug для адресов справочников.
//
// Правила выведены из примеров в самом ТЗ, чтобы наши адреса совпадали с теми,
// что маркетинг уже нарисовал в «Архитектуре публичных страниц»:
//
//   токарная обработка      → tokarnaya-obrabotka
//   механическая обработка  → mehanicheskaya-obrabotka   (х → h, не kh)
//   фланцы                  → flancy                     (ц → c, не ts)
//   нержавеющая сталь       → nerzhaveyushchaya-stal      (щ → shch, ь на конце опускается)
//   литьё под давлением     → litie-pod-davleniem         (ь перед ё → i)
//
// Последнее правило неочевидно и стоит объяснения: мягкий знак сам по себе
// исчезает («сталь» → stal), но перед йотированной гласной превращается в i,
// иначе «литьё» дало бы lite, а это читается как английское слово. В ТЗ
// написано litie — следуем их варианту.
//
// Slug, который выдаёт эта функция, — предложение, а не приговор: в админке он
// правится руками. Спорить о вариантах транслитерации бессмысленно, важно лишь
// чтобы значение по умолчанию было предсказуемым и совпадало с ожиданиями.

const MAP = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Гласные, перед которыми мягкий знак читается как i: литьё → litie. */
const IOTATED = new Set(['е', 'ё', 'ю', 'я', 'и']);

function transliterate(text) {
    const src = String(text == null ? '' : text).toLowerCase();
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === 'ь' && IOTATED.has(src[i + 1])) { out += 'i'; continue; }
        out += Object.prototype.hasOwnProperty.call(MAP, ch) ? MAP[ch] : ch;
    }
    return out;
}

/**
 * Название → slug: только строчные латинские буквы, цифры и дефисы.
 * @param {string} text
 * @param {number} maxLength — адреса длиннее 80 знаков нечитаемы и обрезаются
 *        по границе слова, чтобы не получить оборванное «tokarnaya-obrabot».
 */
function toSlug(text, maxLength = 80) {
    let s = transliterate(text)
        .replace(/['"«»`’]/g, '')      // кавычки просто выбрасываем, дефис из них не нужен
        .replace(/[^a-z0-9]+/g, '-')   // всё остальное — разделитель
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (s.length <= maxLength) return s;
    const cut = s.slice(0, maxLength);
    const lastDash = cut.lastIndexOf('-');
    return (lastDash > maxLength * 0.5 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/**
 * Уникальный slug: если базовый занят, добавляется -2, -3 и так далее.
 * @param {string} base — желаемый slug
 * @param {(s: string) => Promise<boolean>} isTaken — проверка занятости
 */
async function uniqueSlug(base, isTaken) {
    const root = toSlug(base) || 'bez-nazvaniya';
    if (!await isTaken(root)) return root;
    // Ограничение сверху нужно: без него ошибка в isTaken даёт бесконечный цикл
    // прямо в обработчике запроса.
    for (let n = 2; n <= 100; n++) {
        const candidate = `${root}-${n}`;
        if (!await isTaken(candidate)) return candidate;
    }
    throw new Error(`Не удалось подобрать свободный slug для «${base}»`);
}

/** Годится ли slug, введённый руками. Те же требования, что к сгенерированному. */
function isValidSlug(s) {
    return typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;
}

module.exports = { toSlug, transliterate, uniqueSlug, isValidSlug };
