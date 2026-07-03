'use strict';

const express = require('express');
const tzAi = require('../lib/ai-client');

function createAiRouter(deps) {
    const { pool, requireAuth, rowToCompany, genAI } = deps;

    const router = express.Router();

    const aiSearchCache = new Map(); // query → { results, ts }
    const AI_CACHE_TTL = 10 * 60 * 1000; // 10 минут

    router.post('/ai-search', requireAuth, async (req, res, next) => {
        try {
            if (!genAI) return res.status(503).json({ error: 'AI не настроен: добавьте GEMINI_API_KEY в .env' });
            const { query } = req.body;
            if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });

            const cacheKey = query.trim().toLowerCase();
            const cached = aiSearchCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < AI_CACHE_TTL) return res.json(cached.results);

            const { rows } = await pool.query(`SELECT * FROM companies WHERE role = 'producer'`);
            const producers = rows.map(rowToCompany);

            const catalog = producers.map((p, i) =>
                `[${i}] ${p.company} | ${p.city || '—'} | ${p.specialization || '—'} | Возможности: ${(p.capabilities || []).join(', ') || '—'} | ${p.about || ''}`
            ).join('\n');

            const prompt = `Ты — ассистент B2B платформы прямых закупок ТехЗаказ (Россия).
Пользователь ищет: "${query.trim()}"

Каталог производителей (формат: [индекс] название | город | специализация | возможности | описание):
${catalog}

Верни JSON-массив с 1–6 наиболее подходящими производителями.
Для каждого: index (число из каталога) и reason (1–2 предложения на русском почему подходит).
Отвечай ТОЛЬКО валидным JSON без markdown. Пример: [{"index":0,"reason":"..."}]`;

            const model = genAI.getGenerativeModel({
                model: 'gemini-2.0-flash-lite',
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                ],
            });
            const result = await model.generateContent(prompt);

            let rawText;
            try { rawText = result.response.text(); }
            catch (textErr) {
                console.error('[ai-search] response.text() failed:', textErr.message);
                return res.status(500).json({ error: 'Gemini заблокировал ответ. Уточните запрос.' });
            }
            const text = rawText.trim().replace(/^```json|^```|```$/gm, '').trim();

            let matches;
            try { matches = JSON.parse(text); }
            catch { return res.status(500).json({ error: 'Не удалось разобрать ответ AI. Попробуйте ещё раз.' }); }
            if (!Array.isArray(matches)) return res.json([]);

            const found = matches
                .filter(m => Number.isInteger(m.index) && m.index >= 0 && m.index < producers.length)
                .map(m => ({ ...producers[m.index], aiReason: m.reason }));

            aiSearchCache.set(cacheKey, { results: found, ts: Date.now() });
            res.json(found);
        } catch (e) {
            console.error('[ai-search error]', e.message, e.status || '', e.stack || '');
            const msg = e.message || '';
            if (msg.includes('API key') || msg.includes('API_KEY') || e.status === 400)
                return res.status(400).json({ error: 'Неверный GEMINI_API_KEY. Проверьте ключ.' });
            if (e.status === 429 || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED'))
                return res.status(429).json({ error: 'Превышен лимит запросов Gemini. Попробуйте позже.' });
            return res.status(500).json({ error: `AI ошибка: ${msg} (status: ${e.status || 'n/a'})` });
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
        res.json({ configured: cfg.configured, model: cfg.configured ? cfg.model : null });
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
