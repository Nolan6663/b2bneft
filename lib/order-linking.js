'use strict';

// Привязка заявки к справочнику услуг и изделий.
//
// Тематический хаб /zakazy/{slug} должен показывать заказы по теме. Пока связи
// нет, единственный способ их собрать — искать вхождение названия сущности в
// заголовок заявки, и он плох: «вал» находит «вальцовку», «резка» — «нарезку
// резьбы». Исполнитель приходит из поиска за валами и видит чужие заявки.
//
// Здесь тот же разбор, что и для профилей компаний (lib/catalog-match), но с
// двумя отличиями, которые следуют из природы данных:
//
//   • Текста больше и он конкретнее. Заголовок и описание заявки пишет человек,
//     которому нужна именно эта деталь, — «Вал ступенчатый Ø40, сталь 45,
//     40 шт». Профиль завода перечисляет всё, что тот умеет, и потому шумнее.
//
//   • Ошибка дешевле. Лишняя связь заявки показывает её в соседнем хабе, и это
//     видно сразу: заказчику приходят отклики не по теме, он жалуется. Лишняя
//     связь компании тихо сидит в каталоге годами. Поэтому здесь допустимо
//     связывать по описанию, а не только по названию.
//
// Уровень подтверждения различает происхождение связи: 'auto' — наш разбор,
// 'claimed' — заказчик выбрал сам в мастере размещения. Ручной выбор сильнее
// и разбором не перетирается: ТЗ §6.8 требует возможности ручного исправления,
// а исправление, которое переписывают обратно, исправлением не является.

const { buildIndex, matchEntries } = require('./catalog-match');

const AUTO = 'auto';
const CLAIMED = 'claimed';

/* Поля заявки, по которым ищем. Заголовок весомее описания, но оба идут в
   разбор: «Вал ступенчатый» в заголовке и «точение, шлифовка» в описании
   вместе дают и изделие, и услугу. */
function orderText(order) {
    return [order.title, order.category, order.description]
        .map(v => String(v == null ? '' : v))
        .filter(Boolean)
        .join('. ');
}

/**
 * Что из справочника упомянуто в заявке.
 *
 * @param {object} order            заявка: title, category, description
 * @param {Array}  services         справочник услуг: {id, name, synonyms}
 * @param {Array}  products         справочник изделий
 * @returns {{services:number[], products:number[]}}
 */
function detectEntities(order, services, products) {
    const text = orderText(order);
    if (!text.trim()) return { services: [], products: [] };
    return {
        services: matchEntries(text, buildIndex(services)).map(m => m.id),
        products: matchEntries(text, buildIndex(products)).map(m => m.id),
    };
}

/**
 * Записывает связи заявки. Вызывается после создания заказа и после правки.
 *
 * Связи, выбранные заказчиком вручную, не трогаются: ON CONFLICT DO NOTHING
 * оставляет их как есть, а удаление затрагивает только автоматические. Иначе
 * повторное сохранение заявки стирало бы исправление, сделанное человеком.
 *
 * @param {object} client   pg-клиент или пул
 * @param {number} orderId
 * @param {{services:number[], products:number[]}} detected
 */
async function applyLinks(client, orderId, detected) {
    // Сначала снимаем прежние автоматические связи: заголовок могли
    // переписать, и старый разбор больше не верен.
    await client.query(`DELETE FROM order_services WHERE order_id = $1 AND confirmation = $2`, [orderId, AUTO]);
    await client.query(`DELETE FROM order_products WHERE order_id = $1 AND confirmation = $2`, [orderId, AUTO]);

    for (const id of detected.services) {
        await client.query(
            `INSERT INTO order_services (order_id, service_id, confirmation)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [orderId, id, AUTO]
        );
    }
    for (const id of detected.products) {
        await client.query(
            `INSERT INTO order_products (order_id, product_id, confirmation)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [orderId, id, AUTO]
        );
    }
    return { services: detected.services.length, products: detected.products.length };
}

/** Справочники для разбора. Архивные не берём: связывать заявку с сущностью,
 *  которую редактор убрал, — значит наполнять страницу, которой нет. */
async function loadDictionaries(client) {
    const [{ rows: services }, { rows: products }] = await Promise.all([
        client.query(`SELECT id, name, synonyms FROM services WHERE status <> 'archived'`),
        client.query(`SELECT id, name, synonyms FROM products WHERE status <> 'archived'`),
    ]);
    const norm = r => ({ id: r.id, name: r.name, synonyms: Array.isArray(r.synonyms) ? r.synonyms : [] });
    return { services: services.map(norm), products: products.map(norm) };
}

/**
 * Полный цикл: прочитать справочники, разобрать заявку, записать связи.
 * Молча ничего не делает, если справочники пусты, — на старте это нормально.
 */
async function linkOrder(client, order) {
    const { services, products } = await loadDictionaries(client);
    if (!services.length && !products.length) return { services: 0, products: 0 };
    return applyLinks(client, order.id, detectEntities(order, services, products));
}

module.exports = { AUTO, CLAIMED, orderText, detectEntities, applyLinks, loadDictionaries, linkOrder };
