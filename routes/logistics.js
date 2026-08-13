'use strict';

// Расчёт доставки по конкретному КП.
//
// Маршрут берётся из сделки: откуда — город завода, подавшего предложение,
// куда — город заказчика. Габариты — из самого КП, их указывает завод при
// подаче. Поэтому отдельной формы у заказчика нет: всё, что нужно, уже собрано
// вокруг предложения.
//
// Ошибки здесь осмысленные, а не общее «не удалось». Расчёт может не
// состояться по разным причинам, и человеку важно знать, чинится это его
// действием или нет: «завод не указал габариты» и «не смогли определить город»
// требуют разного.

const express = require('express');
const { quoteAll } = require('../lib/logistics');
const { resolveCity, suggestCities, fillDellinCode, fillVozovozGuid } = require('../lib/logistics/geo');
const { findCityCode } = require('../lib/logistics/dellin');
const { findCityGuid } = require('../lib/logistics/vozovoz');
const { parseCargo, isCargoComplete, cargoToPlaces } = require('../lib/logistics/cargo');

function cargoOf(row) {
    return {
        weight: row.cargo_weight == null ? null : Number(row.cargo_weight),
        length: row.cargo_length == null ? null : Number(row.cargo_length),
        width: row.cargo_width == null ? null : Number(row.cargo_width),
        height: row.cargo_height == null ? null : Number(row.cargo_height),
        places: row.cargo_places == null ? null : Number(row.cargo_places),
    };
}

/** Город компании → точка перевозчиков, с человеческим объяснением неудачи. */
async function pointFor(pool, city, who) {
    if (!String(city || '').trim()) {
        return { error: `${who} не указал город в профиле — без него доставку не рассчитать` };
    }
    const found = await resolveCity(pool, city);
    if (found.status === 'ok') return { point: found.point };
    if (found.status === 'ambiguous') {
        const names = found.candidates.map((c) => c.name).slice(0, 3);
        return { error: `Городов с названием «${city}» несколько (${names.join(', ')}) — уточните район`, candidates: found.candidates };
    }
    return { error: `Город «${city}» не найден в справочниках перевозчиков` };
}

function createLogisticsRouter(deps) {
    // quoteAll подменяем в тестах: иначе юниты пошли бы в сеть к перевозчикам,
    // а деплойный гейт не должен зависеть от доступности чужих сайтов.
    const {
        pool, requireAuth, optionalAuth, canAccessProposal,
        quoteAll: quoteCarriers = quoteAll,
        dellinLookup = findCityCode,
        vozovozLookup = findCityGuid,
    } = deps;
    const router = express.Router();

    // Подсказки для полей города. Без авторизации: город спрашивают ещё в
    // гостевом мастере завода, до регистрации. Раскрывать тут нечего — это
    // справочник перевозчиков, а не наши данные. От перебора закрывает
    // guestLookupLimiter, навешенный на путь в server.js.
    router.get('/cities', optionalAuth, async (req, res, next) => {
        try {
            const found = await suggestCities(pool, req.query.q || '', 10);
            res.json(found.map((c) => ({ id: c.id, name: c.name, qualifier: c.qualifier })));
        } catch (e) { next(e); }
    });

    /* Публичный расчёт по произвольному маршруту — для страницы /dostavka.
     *
     * Отдельно от /quote, а не флагом в нём: у того другая модель доступа
     * (проверка прав на конкретное КП), и смешивать их — верный способ однажды
     * открыть чужие данные. Здесь никакого доступа к нашим данным нет вовсе:
     * на входе город и коробка, на выходе чужие тарифы.
     *
     * POST, а не GET: расчёт не должен индексироваться как ссылка и собираться
     * ботами обходом параметров. Потолок запросов навешен на путь в server.js.
     */
    router.post('/public-quote', async (req, res, next) => {
        try {
            const body = req.body || {};
            // Габариты проверяем тем же модулем, что и КП: те же границы
            // (20 тонн, 20 метров), тот же разбор запятой в дробных.
            const cargo = parseCargo({
                cargoWeight: body.weight,
                cargoLength: body.length,
                cargoWidth: body.width,
                cargoHeight: body.height,
                cargoPlaces: body.places,
            });
            if (!isCargoComplete(cargo)) {
                return res.status(422).json({ error: 'Укажите вес и все три габарита одного места', reason: 'no_cargo' });
            }

            const from = await pointFor(pool, body.from, 'Город отправления');
            if (from.error) return res.status(422).json({ error: from.error, reason: 'from_city', candidates: from.candidates });
            const to = await pointFor(pool, body.to, 'Город получения');
            if (to.error) return res.status(422).json({ error: to.error, reason: 'to_city', candidates: to.candidates });

            if (from.point.id === to.point.id) {
                return res.status(422).json({ error: 'Города отправления и получения совпадают', reason: 'same_city' });
            }

            await Promise.all([
                fillDellinCode(pool, from.point, dellinLookup),
                fillDellinCode(pool, to.point, dellinLookup),
                fillVozovozGuid(pool, from.point, vozovozLookup),
                fillVozovozGuid(pool, to.point, vozovozLookup),
            ]);

            const doorFrom = body.doorFrom !== false;
            const doorTo = body.doorTo !== false;

            const result = await quoteCarriers(pool, {
                from: from.point,
                to: to.point,
                places: cargoToPlaces(cargo),
                insurance: 0,
                doorFrom,
                doorTo,
            });

            res.json({
                from: { name: from.point.name },
                to: { name: to.point.name },
                cargo,
                doorFrom,
                doorTo,
                quotes: result.quotes,
                failed: result.failed,
            });
        } catch (e) { next(e); }
    });

    router.get('/quote', requireAuth, async (req, res, next) => {
        try {
            const proposalId = Number(req.query.proposalId);
            if (!proposalId) return res.status(400).json({ error: 'Не указано предложение' });

            const { rows: [proposal] } = await pool.query(
                `SELECT p.*, o.company AS order_company
                   FROM proposals p
                   JOIN orders o ON o.id = p.order_id
                  WHERE p.id = $1`,
                [proposalId]
            );
            if (!proposal) return res.status(404).json({ error: 'Предложение не найдено' });
            if (!canAccessProposal(req.user, proposal)) {
                return res.status(403).json({ error: 'Это предложение принадлежит другой компании' });
            }

            const cargo = cargoOf(proposal);
            if (!isCargoComplete(cargo)) {
                return res.status(422).json({ error: 'Завод не указал габариты груза — попросите его дополнить КП', reason: 'no_cargo' });
            }

            const { rows: companies } = await pool.query(
                'SELECT company, city FROM companies WHERE company = ANY($1)',
                [[proposal.company, proposal.order_company]]
            );
            const cityOf = (name) => (companies.find((c) => c.company === name) || {}).city;

            const from = await pointFor(pool, cityOf(proposal.company), 'Завод');
            if (from.error) return res.status(422).json({ error: from.error, reason: 'from_city' });
            const to = await pointFor(pool, cityOf(proposal.order_company), 'Заказчик');
            if (to.error) return res.status(422).json({ error: to.error, reason: 'to_city' });

            // Коды Деловых Линий и Возовоза добываются их же поиском при первом
            // расчёте по городу и запоминаются. Не нашёлся — считаем без них.
            await Promise.all([
                fillDellinCode(pool, from.point, dellinLookup),
                fillDellinCode(pool, to.point, dellinLookup),
                fillVozovozGuid(pool, from.point, vozovozLookup),
                fillVozovozGuid(pool, to.point, vozovozLookup),
            ]);

            // Забор и доставка по умолчанию включены — это то, чего ждёт
            // большинство. Но многие заводы сами возят на терминал, а заказчики
            // сами забирают: на Москве — Екатеринбурге это около пяти тысяч,
            // и прятать такую возможность неправильно.
            const doorFrom = req.query.doorFrom !== '0';
            const doorTo = req.query.doorTo !== '0';

            const result = await quoteCarriers(pool, {
                from: from.point,
                to: to.point,
                places: cargoToPlaces(cargo),
                insurance: Number(proposal.price) || 0,
                doorFrom,
                doorTo,
            });

            res.json({
                from: { name: from.point.name },
                to: { name: to.point.name },
                cargo,
                doorFrom,
                doorTo,
                quotes: result.quotes,
                failed: result.failed,
            });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createLogisticsRouter;
