'use strict';

/* Отбор кандидатов для умного поиска по каталогу.
 *
 * Раньше в модель уезжал весь каталог одним промптом: около 4500 строк на
 * каждый запрос мимо кэша. Держалось это только на миллионном окне Gemini,
 * стоило дорого при каждом нажатии кнопки и в принципе не переносилось на
 * GigaChat, где окно в десятки раз меньше.
 *
 * Поэтому кандидатов выбираем сами — обычным поиском по словам, — а модели
 * отдаём короткий список на ранжирование. Так она занимается тем, что
 * действительно умеет: понять формулировку живого человека и объяснить выбор.
 * Перебор каталога по складам — работа кода, а не языковой модели.
 */

const { CATEGORY_WORDS, categorizeProducer } = require('./producer-categories');

/** Сколько кандидатов уходит в модель. Сорок строк — это около 4 КБ: помещается
 *  в любое окно и оставляет запас на объяснения в ответе. */
const CANDIDATES = 40;

/* Слова, которые есть почти в каждом профиле и потому ничего не отбирают.
   Без этого списка «нужен производитель фланцев» вытаскивает половину реестра
   по слову «производитель», и фланцы тонут. */
const STOPWORDS = new Set([
    'и', 'или', 'для', 'под', 'из', 'на', 'в', 'во', 'с', 'со', 'по', 'к', 'от', 'до', 'при',
    'за', 'над', 'про', 'без', 'у', 'о', 'об', 'же', 'ли', 'бы', 'а', 'но', 'это', 'что', 'как',
    'мне', 'нам', 'нужен', 'нужна', 'нужно', 'нужны', 'ищу', 'ищем', 'найти', 'найди', 'где',
    'кто', 'какой', 'какие', 'хочу', 'хотим', 'подскажи', 'посоветуй',
    'цена', 'цены', 'стоимость', 'купить', 'заказать', 'заказ', 'закупка',
    'изготовление', 'изготовить', 'производство', 'выпуск', 'поставка',
    'завод', 'заводы', 'компания', 'компании', 'предприятие', 'предприятия',
    'поставщик', 'поставщики', 'производитель', 'производители', 'фирма', 'организация',
]);

/* Как человек называет место и как оно записано в реестре — разные вещи.
   Список намеренно короткий: каждая строка здесь утверждает, что два разных
   слова означают одно место, и ошибка тут молча уводит поиск в другой регион. */
const PLACE_HINTS = {
    'подмосковье': 'московская область',
    'питер': 'санкт-петербург',
    'спб': 'санкт-петербург',
    'мск': 'москва',
    'екб': 'екатеринбург',
    'нижний': 'нижний новгород',
};

/* Вес поля говорит, насколько попадание в него осмысленно. Название и
   специализация — то, чем завод сам себя объявляет; «о компании» — маркетинговый
   текст, где найдётся любое слово, поэтому вес символический. */
const FIELDS = [
    ['company', 5],
    ['specialization', 4],
    ['products', 3],
    ['capabilities', 3],
    ['city', 3],
    ['about', 1],
];

/** Общий корень для однокоренных: «нержавейка», «нержавеющий» → «нержав».
 *  Грубо и намеренно: это предварительный отбор, а не морфологический разбор. */
const STEM_LEN = 6;

function normalize(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/ё/g, 'е');
}

function stem(word) {
    return word.length > STEM_LEN ? word.slice(0, STEM_LEN) : word;
}

/** Запрос человека → набор корней, по которым есть смысл искать. */
function tokenize(query) {
    let text = normalize(query);
    for (const [from, to] of Object.entries(PLACE_HINTS)) {
        if (text.includes(from)) text += ' ' + to;
    }
    const words = text.split(/[^a-zа-я0-9]+/).filter(Boolean);
    const out = [];
    for (const w of words) {
        if (w.length < 3 || STOPWORDS.has(w)) continue;
        const s = stem(w);
        if (!out.includes(s)) out.push(s);
    }
    return out;
}

/** Текст профиля по полям — считаем один раз на компанию, а не на каждое слово. */
function haystack(producer) {
    const out = {};
    for (const [field] of FIELDS) {
        const v = producer[field];
        out[field] = normalize(Array.isArray(v) ? v.join(' ') : v);
    }
    return out;
}

/* Категорию запроса определяем тем же классификатором, что и витрины: «нужны
   резиновые уплотнения» должно поднимать РТИ целиком, даже если конкретное
   слово в профиле не встретилось. Вес меньше прямого попадания — это подсказка,
   а не совпадение. */
function queryCategories(query) {
    const text = normalize(query);
    return Object.keys(CATEGORY_WORDS).filter(cat =>
        CATEGORY_WORDS[cat].some(word => text.includes(normalize(word).slice(0, STEM_LEN)))
    );
}

/**
 * Кандидаты для модели: те, у кого есть хоть одно совпадение со словами запроса.
 * Возвращает список { producer, score }, отсортированный по убыванию.
 */
function pickCandidates(producers, query, { limit = CANDIDATES } = {}) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const cats = queryCategories(query);

    const scored = [];
    for (const p of producers) {
        const hay = haystack(p);
        let score = 0;
        let hits = 0;
        for (const token of tokens) {
            let best = 0;
            for (const [field, weight] of FIELDS) {
                if (hay[field].includes(token)) best = Math.max(best, weight);
            }
            if (best) { score += best; hits++; }
        }
        if (!hits) continue;
        // Совпало несколько слов сразу — это заметно сильнее, чем одно случайное.
        if (hits > 1) score += (hits - 1) * 2;
        if (cats.length && categorizeProducer(p).some(c => cats.includes(c))) score += 3;
        // Проверенные профили полнее и отвечают чаще: при равном счёте — они выше.
        if (p.verifiedByPlatform) score += 2;
        scored.push({ producer: p, score });
    }

    scored.sort((a, b) => b.score - a.score || String(a.producer.company).localeCompare(String(b.producer.company), 'ru'));
    return scored.slice(0, limit);
}

/** Строка кандидата для модели: только то, по чему принимают решение. */
function candidateLine(p, i) {
    const cut = (v, n) => {
        const s = String(Array.isArray(v) ? v.join(', ') : (v || '')).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
    };
    const parts = [
        cut(p.company, 90),
        cut(p.city, 40) || '—',
        cut(p.specialization, 90) || '—',
        cut(p.capabilities, 90) || cut(p.products, 90) || '—',
    ];
    return `[${i}] ${parts.join(' | ')}`;
}

function buildRankingPrompt(query, candidates) {
    const list = candidates.map((c, i) => candidateLine(c.producer, i)).join('\n');
    return {
        system: 'Ты помогаешь снабженцу выбрать завод на площадке прямых закупок. '
            + 'Отвечай только валидным JSON, без пояснений и без markdown.',
        user: `Запрос снабженца: "${String(query).trim()}"

Кандидаты (формат: [номер] название | город | специализация | возможности):
${list}

Выбери от 1 до 6 самых подходящих. Если подходящих нет — верни пустой список.
Не придумывай заводов, которых нет в списке, и не додумывай факты о них.
Формат ответа: {"matches":[{"index":0,"reason":"почему подходит, 1–2 предложения"}]}`,
    };
}

/** Ответ модели → компании. Чужие и повторные номера отбрасываем: модель иногда
 *  возвращает индекс, которого в списке не было. */
function applyRanking(candidates, parsed, { limit = 6 } = {}) {
    const raw = parsed && Array.isArray(parsed.matches) ? parsed.matches : [];
    const seen = new Set();
    const out = [];
    for (const m of raw) {
        const i = Number(m && m.index);
        if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
        seen.add(i);
        const reason = String((m && m.reason) || '').replace(/\s+/g, ' ').trim();
        out.push({ ...candidates[i].producer, aiReason: reason.slice(0, 400) || null });
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = {
    CANDIDATES,
    tokenize,
    pickCandidates,
    buildRankingPrompt,
    applyRanking,
};
