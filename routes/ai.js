'use strict';

const express = require('express');
const tzAi = require('../lib/ai-client');
const { pickCandidates, buildRankingPrompt, applyRanking } = require('../lib/producer-search');

function createAiRouter(deps) {
    const { pool, requireAuth, rowToCompany, handleDrawingImageUpload, canAccessOrderDrawing, storage } = deps;

    const router = express.Router();

    const aiSearchCache = new Map(); // query → { results, ts }
    const AI_CACHE_TTL = 10 * 60 * 1000; // 10 минут

    /* Умный поиск по каталогу.
     *
     * Кандидатов отбирает код (lib/producer-search), модель их ранжирует и
     * объясняет выбор. До 19.08.2026 было наоборот: в промпт уезжал весь
     * каталог — около 4500 строк на каждый запрос мимо кэша. Держалось это
     * только на миллионном окне Gemini и на GigaChat не переносилось вовсе.
     *
     * Модель тут — улучшение, а не условие работы. Не настроена, не ответила,
     * вернула чушь — отдаём то, что нашли словами, и честно помечаем ranked:false.
     * Пустой экран с красной плашкой вместо десятка подходящих заводов — худший
     * из возможных ответов на живой запрос снабженца.
     */
    router.post('/ai-search', requireAuth, async (req, res, next) => {
        try {
            const query = String((req.body && req.body.query) || '').trim();
            if (!query) return res.status(400).json({ error: 'query required' });

            const cacheKey = query.toLowerCase();
            const cached = aiSearchCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < AI_CACHE_TTL) return res.json(cached.payload);

            const { rows } = await pool.query(
                `SELECT * FROM companies WHERE role = 'producer' AND status <> 'Отклонено'`
            );
            const candidates = pickCandidates(rows.map(rowToCompany), query);

            // Ни одного совпадения по словам — звать модель незачем: в каталоге
            // этого нет, и придумать его она может только выдумав.
            if (!candidates.length) {
                const payload = { results: [], ranked: true };
                aiSearchCache.set(cacheKey, { payload, ts: Date.now() });
                return res.json(payload);
            }

            const byWords = candidates.slice(0, 6).map(c => ({ ...c.producer, aiReason: null }));
            if (!tzAi.isTzAiConfigured()) return res.json({ results: byWords, ranked: false });

            let payload;
            try {
                const { system, user } = buildRankingPrompt(query, candidates);
                const text = await tzAi.chatCompletion({ system, user, temperature: 0.2, maxTokens: 900 });
                const ranked = applyRanking(candidates, tzAi.parseJsonFromLlm(text));
                payload = ranked.length ? { results: ranked, ranked: true } : { results: byWords, ranked: false };
            } catch (e) {
                console.error('[ai-search] модель не ответила:', e.message);
                payload = { results: byWords, ranked: false };
            }

            // Кэшируем только удавшийся разбор: иначе минутный сбой модели
            // залипает на десять минут и выглядит как «поиск сломался».
            if (payload.ranked) aiSearchCache.set(cacheKey, { payload, ts: Date.now() });
            res.json(payload);
        } catch (e) {
            console.error('[ai-search error]', e.message);
            next(e);
        }
    });

    router.post('/ai/generate-tz', requireAuth, async (req, res, next) => {
        try {
            if (req.user.role !== 'customer') {
                return res.status(403).json({ error: 'Генерация ТЗ доступна только заказчикам' });
            }
            if (!tzAi.isTzAiConfigured()) {
                return res.status(503).json({
                    error: 'AI для ТЗ не настроен. Добавьте AI_TZ_API_KEY в .env (DeepSeek, OpenAI или OpenRouter).',
                });
            }

            const { brief, category, quantity, title } = req.body || {};
            if (!brief || !String(brief).trim()) {
                return res.status(400).json({ error: 'Опишите задачу в поле brief (2–3 предложения)' });
            }
            if (String(brief).trim().length > 2000) {
                return res.status(400).json({ error: 'Слишком длинный запрос (макс. 2000 символов)' });
            }

            const result = await tzAi.generateProcurementTz({
                brief: String(brief).trim(),
                category: String(category || 'Прочее').slice(0, 80),
                quantity: quantity != null && quantity !== '' ? Number(quantity) : null,
                title: title ? String(title).slice(0, 200) : '',
            });

            const cfg = tzAi.getTzAiConfig();
            res.json({ ...result, model: cfg.model });
        } catch (e) {
            console.error('[ai/generate-tz]', e.message, e.status || '', e.code || '');
            if (e.code === 'AI_NOT_CONFIGURED') {
                return res.status(503).json({ error: 'AI для ТЗ не настроен' });
            }
            if (e.code === 'AI_AUTH' || e.status === 401) {
                return res.status(400).json({ error: 'Неверный AI_TZ_API_KEY. Проверьте ключ и base URL.' });
            }
            if (e.code === 'AI_RATE_LIMIT' || e.status === 429) {
                return res.status(429).json({ error: 'Превышен лимит запросов к AI. Подождите минуту.' });
            }
            if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY') {
                return res.status(500).json({ error: e.message || 'Не удалось сгенерировать ТЗ' });
            }
            return res.status(500).json({ error: e.message || 'Ошибка генерации ТЗ' });
        }
    });

    router.get('/ai/tz-status', requireAuth, (req, res) => {
        const cfg = tzAi.getTzAiConfig();
        res.json({
            configured: cfg.configured,
            model: cfg.configured ? cfg.model : null,
            drawing: cfg.configured && cfg.provider === 'gigachat',
        });
    });

    // Разбор чертежа, уже приложенного к закупке: файл берём из хранилища, доступ
    // проверяем тем же правилом, что и на скачивание, — иначе разбор стал бы
    // обходным путём посмотреть чужой чертёж.
    router.post('/ai/analyze-order-drawing', requireAuth, async (req, res, next) => {
        try {
            const orderId = Number(req.body && req.body.orderId);
            if (!orderId) return res.status(400).json({ error: 'Не указана закупка' });
            if (!(await canAccessOrderDrawing(req.user, orderId))) {
                return res.status(403).json({ error: 'Нет доступа к чертежу этой закупки' });
            }
            const { rows: [row] } = await pool.query('SELECT drawing FROM orders WHERE id = $1', [orderId]);
            if (!row || !row.drawing) return res.status(404).json({ error: 'К закупке не приложен чертёж' });

            let drawing;
            try { drawing = JSON.parse(row.drawing); } catch { drawing = null; }
            if (!drawing || !drawing.storedName) return res.status(404).json({ error: 'К закупке не приложен чертёж' });

            const { buffer, mime } = await storage.readFileBuffer(drawing.storedName);
            const { card, model, source } = await tzAi.analyzeDrawing({
                buffer,
                filename: drawing.originalName || drawing.storedName,
                mime: mime || '',
            });
            res.json({ card, model, source: source || 'image', file: drawing.originalName || null });
        } catch (e) {
            if (e.code === 'AI_FORMAT' || e.code === 'AI_PDF_SCAN') return res.status(415).json({ error: e.message });
            if (e.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: 'Разбор чертежей не настроен на сервере' });
            if (e.code === 'AI_EMPTY') return res.status(502).json({ error: 'Модель не смогла прочитать чертёж' });
            if (e.code === 'FILE_TOO_BIG') return res.status(413).json({ error: 'Чертёж слишком большой для разбора' });
            if (e.code === 'FILE_NOT_FOUND') return res.status(404).json({ error: 'Файл чертежа не найден в хранилище' });
            next(e);
        }
    });

    // Разбор чертежа: картинка → предварительная техкарта. Файл приходит одним
    // запросом и в базе не оседает — модели он нужен только на время ответа.
    router.post('/ai/analyze-drawing', requireAuth, handleDrawingImageUpload, async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Приложите изображение чертежа' });
            const { card, model, source } = await tzAi.analyzeDrawing({
                buffer: req.file.buffer,
                filename: req.file.originalname,
                mime: req.file.mimetype,
            });
            res.json({ card, model, source: source || 'image' });
        } catch (e) {
            if (e.code === 'AI_FORMAT' || e.code === 'AI_PDF_SCAN') return res.status(415).json({ error: e.message });
            if (e.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: 'Разбор чертежей не настроен на сервере' });
            if (e.code === 'AI_EMPTY') return res.status(502).json({ error: 'Модель не смогла прочитать чертёж. Попробуйте более чёткое изображение' });
            next(e);
        }
    });

    router.post('/ai/generate-proposal', requireAuth, async (req, res, next) => {
        try {
            if (req.user.role !== 'producer') {
                return res.status(403).json({ error: 'Генерация сопроводительного текста доступна только поставщикам' });
            }
            if (!tzAi.isTzAiConfigured()) {
                return res.status(503).json({ error: 'AI не настроен на сервере' });
            }

            const { orderId, brief } = req.body || {};
            if (!brief || !String(brief).trim()) {
                return res.status(400).json({ error: 'Опишите, что вы можете предложить (2–3 предложения)' });
            }
            if (String(brief).trim().length > 2000) {
                return res.status(400).json({ error: 'Слишком длинный запрос (макс. 2000 символов)' });
            }

            let orderRow = null;
            if (orderId) {
                const { rows } = await pool.query('SELECT title, description, category FROM orders WHERE id = $1', [Number(orderId)]);
                orderRow = rows[0] || null;
            }

            const result = await tzAi.generateProposalMessage({
                orderTitle: orderRow?.title || '',
                orderDescription: orderRow?.description || '',
                orderCategory: orderRow?.category || '',
                brief: String(brief).trim(),
            });

            const cfg = tzAi.getTzAiConfig();
            res.json({ ...result, model: cfg.model });
        } catch (e) {
            console.error('[ai/generate-proposal]', e.message, e.status || '', e.code || '');
            if (e.code === 'AI_NOT_CONFIGURED') {
                return res.status(503).json({ error: 'AI не настроен' });
            }
            if (e.code === 'AI_AUTH' || e.status === 401 || e.status === 403) {
                return res.status(400).json({ error: 'Неверный AI_TZ_API_KEY. Проверьте ключ и base URL.' });
            }
            if (e.code === 'AI_RATE_LIMIT' || e.status === 429) {
                return res.status(429).json({ error: 'Превышен лимит запросов к AI. Подождите минуту.' });
            }
            if (e.code === 'AI_PARSE' || e.code === 'AI_EMPTY') {
                return res.status(500).json({ error: e.message || 'Не удалось сгенерировать текст' });
            }
            return res.status(500).json({ error: e.message || 'Ошибка генерации' });
        }
    });

    return router;
}

module.exports = createAiRouter;
