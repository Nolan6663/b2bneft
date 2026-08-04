'use strict';

const express = require('express');
const { categorizeProducer } = require('../lib/producer-categories');
const tzAi = require('../lib/ai-client');

function createPublicRouter(deps) {
    const {
        pool,
        optionalAuth,
        requireAuth,
        rowToCompany,
        enrichCompany,
        fetchEgrulData,
        getProducerCategories,
        getCityProductionPoint,
        offsetProductionPoint,
        matchedProducers,
        computeMatchScore,
        rowToOrder,
        // ИИ берём из lib/ai-client, но через deps — так тесты подставляют заглушку
        // вместо живых вызовов модели.
        generateProcurementTz = tzAi.generateProcurementTz,
        analyzeDrawing = tzAi.analyzeDrawing,
        isTzAiConfigured = tzAi.isTzAiConfigured,
        handleDrawingImageUpload = (req, res, next) => next(),
    } = deps;

    const router = express.Router();

    // ===================== ПУБЛИЧНАЯ СТАТИСТИКА =====================
    
    router.get('/public/stats', async (req, res, next) => {
        try {
            const [
                { rows: [{ n: producers }] },
                { rows: [{ n: customers }] },
                { rows: [{ n: orders }] },
                { rows: [{ n: proposals }] },
            ] = await Promise.all([
                pool.query("SELECT COUNT(*) AS n FROM companies WHERE role = 'producer'"),
                pool.query("SELECT COUNT(*) AS n FROM companies WHERE role = 'customer'"),
                pool.query('SELECT COUNT(*) AS n FROM orders'),
                pool.query('SELECT COUNT(*) AS n FROM proposals'),
            ]);
            res.json({ producers, customers, orders, proposals });
        } catch (e) { next(e); }
    });
    
    // Плотность поставщиков по регионам (для воксельной карты лендинга). Кэш 1 час.
    let _geoDensityCache = { ts: 0, data: null };
    router.get('/public/geo-density', async (req, res, next) => {
        try {
            if (_geoDensityCache.data && Date.now() - _geoDensityCache.ts < 3600 * 1000) {
                return res.json(_geoDensityCache.data);
            }
            const { rows } = await pool.query(`
                SELECT ROUND(lng::numeric, 0)::float AS lon,
                       ROUND(lat::numeric, 0)::float AS lat,
                       COUNT(*)::int AS n
                FROM companies
                WHERE role = 'producer' AND lat IS NOT NULL AND lng IS NOT NULL
                GROUP BY 1, 2
            `);
            const data = { points: rows };
            // Пустой результат не кэшируем: геокодинг доезжает после старта — не залипать на час
            if (rows.length) _geoDensityCache = { ts: Date.now(), data };
            res.json(data);
        } catch (e) { next(e); }
    });
    
    router.get('/config/maps', (req, res) => {
        const yandexKey = process.env.YANDEX_MAPS_API_KEY || '';
        const provider = (process.env.MAP_PROVIDER || (yandexKey ? 'yandex' : 'leaflet')).toLowerCase();
        res.json({
            provider: provider === 'yandex' && yandexKey ? 'yandex' : 'leaflet',
            yandexMapsApiKey: yandexKey,
        });
    });
    
    // ===================== КАРТА ЗАВОДОВ =====================
    
    // Самый тяжёлый публичный запрос: 4300 строк, геокодирование и разведение точек
    // одного города по спирали — и всё это на каждый заход на карту. Состав каталога
    // меняется раз в недели, так что час кэша ничего не искажает.
    let _mapCache = { ts: 0, data: null };
    const MAP_TTL_MS = 3600 * 1000;

    router.get('/map', async (req, res, next) => {
        try {
            if (_mapCache.data && Date.now() - _mapCache.ts < MAP_TTL_MS) {
                return res.json(_mapCache.data);
            }
            const { rows } = await pool.query(`
                SELECT *
                FROM companies
                WHERE role = 'producer'
                ORDER BY verified_by_platform DESC, verified_egrul DESC, company ASC
            `);
            const cityIndexes = new Map();
            const result = rows.map(r => {
                const producer = rowToCompany(r);
                const fallbackPoint = getCityProductionPoint(producer.city);
                const basePoint = producer.lat != null && producer.lng != null
                    ? { lat: Number(producer.lat), lng: Number(producer.lng), region: fallbackPoint?.region || producer.city || '' }
                    : fallbackPoint;
                if (!basePoint) return null;
    
                const cityKey = producer.city || producer.company;
                const cityIndex = cityIndexes.get(cityKey) || 0;
                cityIndexes.set(cityKey, cityIndex + 1);
                const point = offsetProductionPoint(basePoint, cityIndex);
                const categories = getProducerCategories(producer);
    
                return {
                    id: producer.id,
                    company: producer.company,
                    city: producer.city,
                    region: point.region || producer.city || '',
                    specialization: producer.specialization || '',
                    about: producer.about || '',
                    equipment: producer.equipment || [],
                    capabilities: producer.capabilities || [],
                    categories: categories.length ? categories : ['Прочее'],
                    status: producer.status,
                    verified: producer.verifiedByPlatform,
                    verifiedEgrul: producer.verifiedEgrul,
                    lat: point.lat,
                    lng: point.lng,
                    productionLoad: producer.productionLoad,
                    freeCapacity: producer.freeCapacity || [],
                    machinesCount: producer.machinesCount,
                    productionArea: producer.productionArea,
                    yearsExperience: producer.yearsExperience,
                };
            }).filter(Boolean);
            // Пустую выдачу не кэшируем: геокодирование доезжает после старта,
            // иначе карта залипнет пустой на час — та же логика, что у geo-density.
            if (result.length) _mapCache = { ts: Date.now(), data: result };
            res.json(result);
        } catch (e) { next(e); }
    });

    // ===================== БИРЖА МОЩНОСТЕЙ =====================
    
    router.get('/capacity', optionalAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT * FROM companies
                WHERE role = 'producer'
                  AND free_capacity != '[]'
                  AND free_capacity != 'null'
                ORDER BY company ASC
            `);
            const list = rows.map(rowToCompany).map(c => ({
                id: c.id, company: c.company, city: c.city, specialization: c.specialization,
                status: c.status, verifiedByPlatform: c.verifiedByPlatform,
                verifiedEgrul: c.verifiedEgrul,
                freeCapacity: c.freeCapacity,
            }));
            res.json(list);
        } catch (e) { next(e); }
    });
    
    // ===================== КАТАЛОГ ПРОИЗВОДИТЕЛЕЙ =====================
    
    router.get('/catalog', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT * FROM companies
                WHERE role = 'producer'
                ORDER BY verified_by_platform DESC, verified_egrul DESC, company ASC
            `);
            res.json(rows.map(rowToCompany));
        } catch (e) { next(e); }
    });
    
    // ── Risk assessment (ЕГРЮЛ + платформа + отзывы) ────────────────────────────
    router.get('/risk/:inn', async (req, res, next) => {
        try {
            const { inn } = req.params;
            if (!/^\d{10,12}$/.test(inn)) return res.status(400).json({ error: 'Неверный формат ИНН' });
    
            const checks = [];
            let score = 0;
    
            // 1. EGRUL check
            const egrul = await fetchEgrulData(inn);
            if (egrul) {
                if (egrul.active) {
                    checks.push({ name: 'Статус ЕГРЮЛ', status: 'ok', detail: 'Компания действующая' });
                    score += 35;
                } else {
                    checks.push({ name: 'Статус ЕГРЮЛ', status: 'fail', detail: 'Компания ликвидирована или в процессе ликвидации' });
                }
                if (egrul.regDate) {
                    const ageMs = Date.now() - new Date(egrul.regDate).getTime();
                    const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
                    if (ageYears >= 3) {
                        checks.push({ name: 'Возраст компании', status: 'ok', detail: `${Math.floor(ageYears)} лет на рынке` });
                        score += 25;
                    } else if (ageYears >= 1) {
                        const months = Math.floor(ageYears * 12);
                        checks.push({ name: 'Возраст компании', status: 'warn', detail: `${months} мес. на рынке — молодая компания` });
                        score += 12;
                    } else {
                        checks.push({ name: 'Возраст компании', status: 'fail', detail: 'Менее года на рынке' });
                    }
                }
            } else {
                checks.push({ name: 'ЕГРЮЛ', status: 'neutral', detail: 'Не удалось получить данные ФНС' });
            }
    
            // 2. Platform verification
            const { rows: compRows } = await pool.query(
                'SELECT verified_by_platform, verified_egrul, company FROM companies WHERE inn = $1 LIMIT 1', [inn]
            );
            const comp = compRows[0];
            if (comp && comp.verified_by_platform) {
                checks.push({ name: 'Верификация платформы', status: 'ok', detail: 'Компания проверена командой ТехЗаказ' });
                score += 20;
            } else if (comp && comp.verified_egrul) {
                checks.push({ name: 'Верификация ЕГРЮЛ', status: 'ok', detail: 'Компания проверена автоматически по реестру ФНС' });
                score += 12;
            } else {
                checks.push({ name: 'Верификация', status: 'warn', detail: 'Компания не верифицирована' });
            }
    
            // 3. Reviews
            if (comp) {
                const { rows: revRows } = await pool.query(
                    `SELECT AVG(score)::numeric(3,1) as avg, COUNT(*) as cnt FROM reviews WHERE to_company = $1`, [comp.company]
                );
                const rv = revRows[0];
                if (rv && parseInt(rv.cnt) > 0) {
                    const avg = parseFloat(rv.avg);
                    const cnt = parseInt(rv.cnt);
                    if (avg >= 4.0) {
                        checks.push({ name: 'Отзывы на платформе', status: 'ok', detail: `Средняя оценка ${avg} (${cnt} отзывов)` });
                        score += 20;
                    } else if (avg >= 3.0) {
                        checks.push({ name: 'Отзывы на платформе', status: 'warn', detail: `Средняя оценка ${avg} (${cnt} отзывов)` });
                        score += 10;
                    } else {
                        checks.push({ name: 'Отзывы на платформе', status: 'fail', detail: `Низкие оценки: ${avg} (${cnt} отзывов)` });
                    }
                } else {
                    checks.push({ name: 'Отзывы на платформе', status: 'neutral', detail: 'Нет отзывов на платформе' });
                    score += 5;
                }
            }
    
            const level = score >= 65 ? 'low' : score >= 35 ? 'medium' : 'high';
            res.json({ inn, level, score, checks });
        } catch (e) { next(e); }
    });
    
    router.get('/public/companies/:id', async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const { rows: [row] } = await pool.query(
                "SELECT * FROM companies WHERE id = $1 AND role = 'producer'",
                [id]
            );
            if (!row) return res.status(404).json({ error: 'Поставщик не найден' });
            const c = await enrichCompany(rowToCompany(row), null);
            const { rows: reviews } = await pool.query(
                `SELECT from_company, score, text, created_at FROM reviews
                 WHERE to_company = $1 ORDER BY created_at DESC LIMIT 12`,
                [c.company]
            );
            const avg = reviews.length
                ? Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length * 10) / 10
                : null;
            res.json({
                id: c.id,
                company: c.company,
                inn: c.inn || '',
                specialization: c.specialization || '',
                city: c.city || '',
                about: c.about || '',
                equipment: c.equipment || [],
                isoCertificates: c.iso_certificates || [],
                qualityCertificates: c.quality_certificates || [],
                capabilities: c.capabilities || [],
                productionLoad: c.production_load,
                verified: Boolean(c.verified_by_platform),
                verifiedEgrul: Boolean(c.verified_egrul),
                status: c.status,
                rating: c.rating,
                ratingLabel: c.ratingLabel,
                stats: c.stats,
                photos: c.photos || [],
                reviews,
                reviewAvg: avg,
                reviewCount: reviews.length,
                publicUrl: `/p/${c.id}`,
                products: c.products || '',
                phone: c.phone || '',
                website: c.website || '',
                fromRegistry: c.fromRegistry,
                fromGisp: c.fromGisp,
            });
        } catch (e) { next(e); }
    });


    // Заводы категории для пустого состояния категорийных страниц: открытых закупок
    // может не быть, но страница должна оставаться полезной и линковать карточки /p/:id.
    // Раскладка «категория → заводы» строится одним прогоном по каталогу и живёт час.
    // Категорийные страницы в sitemap с changefreq: daily, то есть поисковики ходят
    // сюда по расписанию, а классификация в JS индекс использовать не может.
    // Состав категорий меняется куда медленнее часа.
    let _producersCache = { ts: 0, byCategory: null };
    const PRODUCERS_TTL_MS = 3600 * 1000;

    async function producersByCategory() {
        if (_producersCache.byCategory && Date.now() - _producersCache.ts < PRODUCERS_TTL_MS) {
            return _producersCache.byCategory;
        }
        const { rows } = await pool.query(
            `SELECT * FROM companies
             WHERE role = 'producer' AND status <> 'Отклонено'
             ORDER BY verified_by_platform DESC, verified_egrul DESC, claimed DESC, company ASC`
        );

        const byCategory = new Map();
        for (const row of rows) {
            const producer = rowToCompany(row);
            const card = {
                id: producer.id,
                company: producer.company,
                city: producer.city || '',
                // verified_by_platform/verified_egrul — сырые колонки; rowToCompany
                // переименовывает их в camelCase (verifiedByPlatform/verifiedEgrul),
                // поэтому читаем флаг из необработанной строки, а не из producer.
                verified: Boolean(row.verified_by_platform || row.verified_egrul),
            };
            // Витрина использует свой классификатор, не общий getProducerCategories:
            // тот засчитывает любое совпадение в маркетинговом описании, из-за чего
            // кабельный завод попадал сразу во все четыре категории. Общий трогать
            // нельзя — на нём висят карта и биржа мощностей.
            for (const category of categorizeProducer(producer)) {
                if (!byCategory.has(category)) byCategory.set(category, []);
                byCategory.get(category).push(card);
            }
        }

        // Пустой каталог не кэшируем: импорт реестра мог ещё не доехать — не залипать на час.
        if (rows.length) _producersCache = { ts: Date.now(), byCategory };
        return byCategory;
    }

    router.get('/public/producers', async (req, res, next) => {
        try {
            const category = String(req.query.category || '').trim();
            if (!category) return res.status(400).json({ error: 'Укажите категорию' });
            const parsed = parseInt(req.query.limit, 10);
            const limit = Math.max(1, Math.min(24, Number.isFinite(parsed) ? parsed : 8));

            const byCategory = await producersByCategory();
            res.json((byCategory.get(category) || []).slice(0, limit));
        } catch (e) { next(e); }
    });

    // ===================== ГОСТЕВОЙ ОНБОРДИНГ =====================
    // Мастер /zayavka показывает незарегистрированному заказчику, кто возьмётся за
    // его задачу. Контакты предприятий не отдаём: за ними на площадку и приходят.
    router.post('/public/match-preview', async (req, res, next) => {
        try {
            const { title, category, description, quantity } = req.body || {};
            if (!String(title || '').trim() && !String(description || '').trim()) {
                return res.status(400).json({ error: 'Опишите, что нужно изготовить' });
            }
            const draft = {
                title: String(title || '').slice(0, 200),
                category: String(category || '').slice(0, 100),
                description: String(description || '').slice(0, 4000),
                quantity: quantity ? Number(quantity) : null,
            };
            const matched = await matchedProducers(draft, 0, false);
            res.json({
                total: matched.length,
                items: matched.slice(0, 6).map(m => ({
                    company: m.company,
                    city: m.city || '',
                    products: String(m.products || '').slice(0, 160),
                    score: Number(m.score) || 0,
                })),
            });
        } catch (e) { next(e); }
    });

    /* Подбор закупок под профиль завода — зеркало match-preview.
       Раньше мастер завода звал match-preview и показывал число подходящих
       ПРЕДПРИЯТИЙ под подписью «подходит закупок»: заводу выводили количество
       его же конкурентов. Здесь считаются именно активные закупки. */
    router.post('/public/match-orders', async (req, res, next) => {
        try {
            const { products, capabilities, specialization } = req.body || {};
            const profile = {
                specialization: String(specialization || '').slice(0, 300),
                products: String(products || '').slice(0, 1000),
                about: String(products || '').slice(0, 1000),
                capabilities: Array.isArray(capabilities) ? capabilities.slice(0, 20) : [],
                equipment: [],
            };
            if (!profile.products.trim() && !profile.specialization.trim() && !profile.capabilities.length) {
                return res.status(400).json({ error: 'Расскажите, что вы производите' });
            }

            /* deadline — колонка TEXT, поэтому сравниваем как текст в формате
               ISO: to_char даёт ровно '2026-08-04'. Приведение CURRENT_DATE::text
               зависит от DateStyle сервера и на проде давало другой формат —
               из-за этого условие отсекало все закупки разом. */
            const { rows } = await pool.query(
                `SELECT id, title, category, quantity, deadline, description, created_at
                   FROM orders
                  WHERE status = 'Активный'
                    AND (deadline IS NULL OR deadline = '' OR deadline >= to_char(CURRENT_DATE, 'YYYY-MM-DD'))
                  ORDER BY created_at DESC
                  LIMIT 200`
            );

            const scored = rows
                .map(row => ({ row, score: computeMatchScore(rowToOrder(row), profile) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            res.json({
                total: scored.length,
                /* временная диагностика: сколько заявок просмотрено и какой
                   лучший балл — без неё непонятно, режет запрос или подбор */
                debug: req.query.debug === '1'
                    ? {
                        scanned: rows.length,
                        best: rows.reduce((max, row) => Math.max(max, computeMatchScore(rowToOrder(row), profile)), 0),
                        profileText: [profile.specialization, profile.about].filter(Boolean).join(' | ').slice(0, 120),
                        firstCategory: rows[0] ? rows[0].category : null,
                    }
                    : undefined,
                items: scored.slice(0, 6).map(({ row, score }) => ({
                    id: row.id,
                    title: String(row.title || '').slice(0, 160),
                    category: row.category || '',
                    quantity: row.quantity || null,
                    deadline: row.deadline || null,
                    score,
                })),
            });
        } catch (e) { next(e); }
    });

    // Сборка ТЗ до регистрации. Потолок по IP стоит в server.js, здесь — валидация
    // и перевод кодов ошибок клиента модели в понятный человеку текст.
    router.post('/public/tz-draft', async (req, res, next) => {
        try {
            const brief = String(req.body?.brief || '').trim();
            if (brief.length < 5) return res.status(400).json({ error: 'Опишите задачу — хотя бы пару слов' });
            if (!isTzAiConfigured()) {
                return res.status(503).json({ error: 'Сборка задания временно недоступна. Заполните описание вручную — это не помешает разместить закупку.' });
            }
            const out = await generateProcurementTz({
                brief: brief.slice(0, 2000),
                category: String(req.body?.category || '').slice(0, 100),
                quantity: req.body?.quantity ? Number(req.body.quantity) : null,
                title: String(req.body?.title || '').slice(0, 200),
            });
            res.json(out);
        } catch (e) {
            console.error('[public/tz-draft]', e.message, e.code || '');
            if (e.code === 'AI_NOT_CONFIGURED') {
                return res.status(503).json({ error: 'Сборка задания временно недоступна. Заполните описание вручную — это не помешает разместить закупку.' });
            }
            if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY' || e.code === 'AI_RATE_LIMIT' || e.code === 'AI_AUTH') {
                return res.status(502).json({ error: 'Не получилось собрать задание с первого раза. Попробуйте ещё раз или опишите своими словами.' });
            }
            next(e);
        }
    });

    // Разбор чертежа до регистрации. Файл живёт только в памяти запроса: гостю на
    // диск ничего не пишем, чтобы нечему было копиться и нечего абузить.
    router.post('/public/analyze-drawing', handleDrawingImageUpload, async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Приложите чертёж — картинку или PDF' });
            const { card, model, source } = await analyzeDrawing({
                buffer: req.file.buffer,
                filename: req.file.originalname,
                mime: req.file.mimetype,
            });
            res.json({ card, model, source: source || 'image' });
        } catch (e) {
            console.error('[public/analyze-drawing]', e.message, e.code || '');
            if (e.code === 'AI_FORMAT' || e.code === 'AI_PDF_SCAN') return res.status(415).json({ error: e.message });
            if (e.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: 'Разбор чертежей временно недоступен. Опишите деталь словами — так тоже работает.' });
            if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY') {
                return res.status(502).json({ error: 'Не получилось разобрать чертёж. Опишите деталь словами — так тоже работает.' });
            }
            next(e);
        }
    });

    // Завод вводит ИНН — показываем, что мы про него уже знаем из реестра, вместо
    // анкеты на пятнадцать полей.
    router.get('/public/company-by-inn', async (req, res, next) => {
        try {
            const inn = String(req.query.inn || '').replace(/\D/g, '');
            if (inn.length !== 10 && inn.length !== 12) {
                return res.status(400).json({ error: 'ИНН — 10 или 12 цифр' });
            }
            const { rows: [row] } = await pool.query(
                "SELECT id, company, city, products, specialization, source, claimed FROM companies WHERE inn = $1 AND role = 'producer' LIMIT 1",
                [inn]
            );
            if (!row) return res.json({ found: false });
            res.json({
                found: true,
                company: {
                    id: row.id,
                    company: row.company,
                    city: row.city || '',
                    products: String(row.products || '').slice(0, 400),
                    specialization: row.specialization || '',
                    source: row.source || '',
                    claimed: Boolean(row.claimed),
                },
            });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createPublicRouter;
