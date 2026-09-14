'use strict';

// Подписка исполнителя на заказы по теме — ТЗ §6.6.
//
// Зачем понадобилась. Хаб заказов в пустом состоянии предлагает подписаться —
// это правильный ответ на «сейчас заявок нет», но до сих пор кнопка вела на
// регистрацию и ничего не подписывала. Обещание без механизма запрещено тем же
// §6.6, что и обещание несуществующих заявок, так что либо убирать текст, либо
// делать подписку. Сделали подписку.
//
// Подписка привязана к сущности справочника, а не к произвольной строке. Тема
// «токарная обработка» — это то, что мы умеем сопоставить с новой заявкой через
// те же связи, по которым собирается хаб (lib/order-linking). Свободная фраза
// потребовала бы полнотекстового поиска на каждую заявку и всё равно давала бы
// ложные срабатывания.

const CHANNELS = ['email', 'telegram'];

/** Кого уведомить о новой заявке.
 *
 *  Совпадение — по тем же связям, которые уже проставлены заявке при создании.
 *  Никакого отдельного разбора текста здесь нет намеренно: если заявка попала
 *  в хаб, подписчик этого хаба должен о ней узнать, и наоборот. Два разных
 *  правила для одного и того же вопроса неизбежно разъедутся.
 *
 *  @param {Array} subscriptions строки order_subscriptions
 *  @param {{services:number[], products:number[], region?:string}} order связи заявки
 */
function matchSubscribers(subscriptions, order) {
    const services = new Set(order.services || []);
    const products = new Set(order.products || []);
    const region = String(order.region || '').trim().toLowerCase();

    return (subscriptions || []).filter(s => {
        const byService = s.service_id && services.has(s.service_id);
        const byProduct = s.product_id && products.has(s.product_id);
        if (!byService && !byProduct) return false;
        // Регион в подписке сужает, но не обязателен: пустой означает «везде».
        if (s.region && s.region.trim().toLowerCase() !== region) return false;
        return true;
    });
}

/** Не чаще одного письма в час на подписку. Заявки приходят пачками, и десять
 *  писем подряд превращают полезное уведомление в причину отписаться. */
const QUIET_MINUTES = 60;

function isQuiet(subscription, now = Date.now()) {
    if (!subscription || !subscription.last_sent_at) return false;
    const last = new Date(subscription.last_sent_at).getTime();
    if (!Number.isFinite(last)) return false;
    return (now - last) < QUIET_MINUTES * 60 * 1000;
}

/** Текст уведомления. Предмет и срок — то, по чему исполнитель решает,
 *  открывать ли; всё остальное он увидит на странице заявки. */
function notificationText(order, topicName) {
    const parts = [`Новая заявка по теме «${topicName}»: ${order.title}`];
    if (order.deadline) parts.push(`срок подачи ${order.deadline}`);
    if (order.quantity) parts.push(`${order.quantity} шт.`);
    return parts.join(', ');
}

function normalizeChannel(value) {
    const c = String(value || '').trim().toLowerCase();
    return CHANNELS.includes(c) ? c : 'email';
}

module.exports = { CHANNELS, QUIET_MINUTES, matchSubscribers, isQuiet, notificationText, normalizeChannel };
