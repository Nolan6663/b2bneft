'use strict';

// Sentry живёт за пределами РФ, и политика обработки данных (privacy.html,
// раздел 5) прямо признаёт: «фрагменты запроса могут попасть в отчёт об ошибке».
// Предупредить — не то же самое, что получить основание: персональные данные
// всё равно уезжают за границу без согласия субъекта именно на эту передачу
// (152-ФЗ, ст. 12). Дешевле не отправлять их вовсе.
//
// Отчёт об ошибке нужен разработчику ради стека и места падения, а не ради
// почты заказчика. Поэтому вырезаем то, по чему человека можно узнать:
// адреса почты, телефоны, ИНН, и целиком — значения полей, которые по имени
// являются секретом или контактом.
//
// Функция вызывается на каждом событии Sentry и не имеет права упасть: ошибка
// внутри обработчика ошибок гасит весь отчёт. Отсюда try/catch на верхнем
// уровне и жёсткий лимит глубины вместо доверия к форме объекта.

const SCRUB = '[вырезано]';
const MAX_DEPTH = 6;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;
// +7 900 123-45-67, 8(900)1234567 и прочие написания одного и того же номера.
const PHONE_RE = /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
// ИНН: 10 цифр у организации, 12 у физлица и ИП. Отдельно стоящие, не часть числа.
const INN_RE = /\b\d{12}\b|\b\d{10}\b/g;

/** Поля, значение которых не нужно даже смотреть — вырезаем целиком по имени. */
const SENSITIVE_KEY_RE =
    /(pass|password|secret|token|authorization|cookie|session|api[_-]?key|dsn|email|mail|phone|tel|inn|ogrn|director|fio|address|account|card)/i;

function scrubString(value) {
    return String(value)
        .replace(EMAIL_RE, SCRUB)
        .replace(PHONE_RE, SCRUB)
        .replace(INN_RE, SCRUB);
}

function scrubValue(value, depth) {
    if (value == null) return value;
    if (typeof value === 'string') return scrubString(value);
    if (typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return SCRUB;
    if (Array.isArray(value)) return value.map(v => scrubValue(v, depth + 1));

    const out = {};
    for (const [key, val] of Object.entries(value)) {
        out[key] = SENSITIVE_KEY_RE.test(key) ? SCRUB : scrubValue(val, depth + 1);
    }
    return out;
}

/** Обработчик для Sentry.init({ beforeSend }). Возвращает событие без ПД. */
function scrubEvent(event) {
    if (!event) return event;
    try {
        // Тело запроса не нужно для диагностики никогда: там закупки, переписка
        // и контакты. Стек и адрес запроса остаются — по ним и чинят.
        if (event.request) {
            delete event.request.data;
            delete event.request.cookies;
            if (event.request.headers) event.request.headers = scrubValue(event.request.headers, 0);
            if (event.request.query_string) {
                event.request.query_string = scrubValue(event.request.query_string, 0);
            }
            if (event.request.url) event.request.url = scrubString(event.request.url);
        }
        // Кто именно упал — для нас это номер учётной записи, не человек.
        if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
        if (event.message) event.message = scrubString(event.message);
        if (event.extra) event.extra = scrubValue(event.extra, 0);
        if (event.contexts) event.contexts = scrubValue(event.contexts, 0);
        if (Array.isArray(event.breadcrumbs)) {
            event.breadcrumbs = event.breadcrumbs.map(b => scrubValue(b, 0));
        }
        if (event.exception && Array.isArray(event.exception.values)) {
            for (const ex of event.exception.values) {
                if (ex && ex.value) ex.value = scrubString(ex.value);
            }
        }
        return event;
    } catch (e) {
        // Не смогли почистить — не отправляем. Молчащий Sentry чинится за минуту,
        // утёкшие данные не отзываются.
        return null;
    }
}

module.exports = { scrubEvent, scrubString, SCRUB };
