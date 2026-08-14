'use strict';

/* Отказ, который читает человек, а не браузер.
 *
 * Файлы, PDF и выгрузки открываются прямой ссылкой: window.open, <a href>,
 * window.location. Такой переход не проходит через apiFetch — ни повтора
 * запроса, ни тоста, ни обновления токена там нет и быть не может. Поэтому
 * любой отказ по такой ссылке приезжал на экран голым JSON:
 * {"error":"Нет доступа к чертежу этой закупки"}. Правило при этом работало
 * верно, а выглядело как поломка сайта — ровно так его и прочитал первый
 * живой завод 14.08, и одну такую кнопку мы тогда убрали. Ссылок этого рода
 * в интерфейсе с дюжину (чертёж, файл КП, договор, Excel/PDF, выгрузка 1С),
 * и лечить их поштучно в разметке — значит забыть следующую.
 *
 * Разводим два вида клиента по Accept, а не по маршруту: навигация браузера
 * просит text/html с весом q=1 и получает страницу, fetch со своим Accept по
 * умолчанию (одни звёздочки) получает прежний JSON. Контракт API не меняется,
 * тесты на нём — тоже.
 */

const PAGE_STYLE = `body{font-family:system-ui,sans-serif;background:#F4F6F8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;max-width:440px;padding:32px;border:1px solid #E2E8F0;border-radius:12px}
h1{font-size:20px;color:#1E2A3A;margin:0 0 12px}
p{color:#475569;line-height:1.5;margin:0 0 20px;font-size:14px}
a{display:inline-block;padding:10px 22px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}`;

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Навигация ли это. Проверяем через req.accepts, а не по строке заголовка: у
   навигации text/html идёт с большим весом, чем звёздочки, а у fetch по
   умолчанию только звёздочки — и тогда первым в списке выигрывает json.
   req без accepts (фейковый в тестах, вызов из не-express кода) — это не
   браузер, отдаём JSON. */
function wantsHtml(req) {
    if (!req || typeof req.accepts !== 'function') return false;
    return req.accepts(['json', 'html']) === 'html';
}

function errorPage({ title, message, actionHref, actionText }) {
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — ТехЗаказ</title>
<style>${PAGE_STYLE}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<a href="${escapeHtml(actionHref)}">${escapeHtml(actionText)}</a></div></body></html>`;
}

/* Заголовок страницы по коду: человеку важно не число, а что произошло.
   Сам текст ошибки роут пишет сам — он знает про закупку больше, чем мы. */
const TITLES = {
    400: 'Так не получится',
    401: 'Сессия истекла',
    403: 'Нет доступа',
    404: 'Файл не найден',
    409: 'Заявка закрыта',
    500: 'Что-то пошло не так',
};

/**
 * Отказ на запрос файла. Для fetch — прежний JSON, для навигации — страница
 * с одной кнопкой: человеку, упёршемуся в отказ, нужен выход, а не текст.
 */
function sendHttpError(req, res, status, message, extra = {}) {
    if (!wantsHtml(req)) {
        return res.status(status).json({ error: message, ...extra });
    }
    const toLogin = status === 401;
    return res.status(status).type('html').send(errorPage({
        title: TITLES[status] || 'Ошибка',
        message,
        actionHref: toLogin ? '/login.html' : '/index.html',
        actionText: toLogin ? 'Войти' : 'Вернуться в кабинет',
    }));
}

module.exports = { sendHttpError, wantsHtml, errorPage, escapeHtml };
