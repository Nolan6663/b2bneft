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
const dadata = require('../lib/logistics/dadata');
const { findCityCode } = require('../lib/logistics/dellin');
const { findCityGuid } = require('../lib/logistics/vozovoz');
const {
    parseCargo, isCargoComplete, cargoToPlaces,
    parseQuoteItems, itemsToPlaces, parseDeclaredValue,
} = require('../lib/logistics/cargo');
const { buildDeliveryQuotesPdf } = require('../export-pdf');
const { buildQuotesWorkbook } = require('../lib/logistics/quote-xlsx');

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

    /* Подсказки адресов для расчёта доставки.
     *
     * Ходит в DaData нашим ключом и отдаёт только то, что нужно расчёту:
     * строку адреса и город из неё. Ключ на клиент не уезжает — квота общая на
     * аккаунт (10 000 подсказок в сутки), и ключ в исходниках страницы любой
     * желающий выжигает за вечер.
     *
     * Ключа нет — отвечаем пустым списком, а не ошибкой: поле остаётся
     * обычным текстовым, человек допишет адрес руками, расчёт по городу
     * работает как работал. Подсказки — удобство, а не условие.
     */
    router.get('/addresses', optionalAuth, async (req, res, next) => {
        try {
            if (!dadata.isConfigured()) return res.json([]);
            const found = await dadata.suggestAddress(req.query.q || '', 6);
            res.json(found);
        } catch (e) {
            // Чужой сервис лёг или ответил отказом — это не повод ронять форму
            // расчёта. Логируем и отдаём пустоту.
            console.error('[dadata] подсказки недоступны:', e.message);
            res.json([]);
        }
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
    /* Сам расчёт вынесен из обработчика: тем же считает выгрузка в PDF и Excel.
     * Документ обязан повторять экран построчно, а строить его из чисел,
     * присланных клиентом, нельзя — тогда в бумаге с нашей рамкой окажется что
     * угодно. Повторный счёт почти всегда бесплатный: результат перевозчика
     * лежит в logistics_quotes_cache, и выгрузка забирает его оттуда. */
    async function computePublicQuote(body) {
        /* Две формы запроса. items — опросный лист: несколько позиций разных
           габаритов, с негабаритом, жёсткой упаковкой и объявленной
           стоимостью. Без items читаем прежние поля: так шлют старая вкладка,
           открытая до выкатки, и любой внешний клиент. */
        let items;
        if (Array.isArray(body.items)) {
            const parsed = parseQuoteItems(body);
            if (parsed.error) return { error: parsed.error, reason: 'no_cargo' };
            items = parsed.items;
        } else {
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
                return { error: 'Укажите вес и все три габарита одного места', reason: 'no_cargo' };
            }
            items = [{
                length: cargo.length, width: cargo.width, height: cargo.height,
                weight: cargo.weight, quantity: cargo.places || 1,
                oversized: false, hardPack: false,
            }];
        }

        const from = await pointFor(pool, body.from, 'Город отправления');
        if (from.error) return { error: from.error, reason: 'from_city', candidates: from.candidates };
        const to = await pointFor(pool, body.to, 'Город получения');
        if (to.error) return { error: to.error, reason: 'to_city', candidates: to.candidates };

        if (from.point.id === to.point.id) {
            return { error: 'Города отправления и получения совпадают', reason: 'same_city' };
        }

        await Promise.all([
            fillDellinCode(pool, from.point, dellinLookup),
            fillDellinCode(pool, to.point, dellinLookup),
            fillVozovozGuid(pool, from.point, vozovozLookup),
            fillVozovozGuid(pool, to.point, vozovozLookup),
        ]);

        const doorFrom = body.doorFrom !== false;
        const doorTo = body.doorTo !== false;
        // Объявленная стоимость уходит только к ПЭК — остальные её не примут,
        // и в ответе это видно: страхование у них считается своё.
        const declaredValue = parseDeclaredValue(body.declaredValue);

        const result = await quoteCarriers(pool, {
            from: from.point,
            to: to.point,
            places: itemsToPlaces(items),
            insurance: declaredValue,
            doorFrom,
            doorTo,
        });

        /* Полный адрес не участвует в расчёте — все трое считают забор и
           доставку по городу. Но он едет в ответ и в документы: снабженцу
           обоснование нужно с адресом склада, а не с одним названием города. */
        const addressOf = (v) => String(v || '').replace(/s+/g, ' ').trim().slice(0, 250);

        return {
            data: {
                from: { name: from.point.name, address: addressOf(body.fromAddress) },
                to: { name: to.point.name, address: addressOf(body.toAddress) },
                items,
                declaredValue,
                doorFrom,
                doorTo,
                quotes: result.quotes,
                failed: result.failed,
                silent: result.silent,
            },
        };
    }

    router.post('/public-quote', async (req, res, next) => {
        try {
            const result = await computePublicQuote(req.body || {});
            if (result.error) {
                return res.status(422).json({ error: result.error, reason: result.reason, candidates: result.candidates });
            }
            res.json(result.data);
        } catch (e) { next(e); }
    });

    /* Выгрузка расчёта — PDF и Excel.
     *
     * Просьба пришла от двух компаний: им нужно объяснить внутри своей
     * компании, почему из трёх перевозчиков выбран этот. Отсюда и состав
     * документа — не только итоги, но и из чего сложилась цена и кто на запрос
     * не ответил.
     *
     * POST, как и сам расчёт: параметры те же, а GET такую ссылку сделал бы
     * индексируемой. Ошибку отдаём JSON-ом — фронт скачивает через fetch и
     * показывает её тостом, а не роняет пустой файл на диск.
     */
    async function exportQuote(req, res, next, render) {
        try {
            const result = await computePublicQuote(req.body || {});
            if (result.error) {
                return res.status(422).json({ error: result.error, reason: result.reason });
            }
            if (!result.data.quotes.length) {
                return res.status(422).json({ error: 'Перевозчики не вернули расчёт — выгружать нечего' });
            }
            await render(result.data, res);
        } catch (e) { next(e); }
    }

    router.post('/public-quote/export.pdf', (req, res, next) =>
        exportQuote(req, res, next, async (data) => buildDeliveryQuotesPdf(data, res)));

    router.post('/public-quote/export.xlsx', (req, res, next) =>
        exportQuote(req, res, next, async (data) => {
            const wb = buildQuotesWorkbook(data);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`dostavka-${Date.now()}.xlsx`)}`);
            await wb.xlsx.write(res);
            res.end();
        }));

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
                silent: result.silent,
            });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createLogisticsRouter;
