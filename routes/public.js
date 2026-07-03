'use strict';

const express = require('express');

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
    
    router.get('/map', async (req, res, next) => {
        try {
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
            });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createPublicRouter;
