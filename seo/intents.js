'use strict';

const BATCH_SIZE = 50;

const INTENT_LABELS = {
    informational: 'Информационный',
    commercial: 'Коммерческий',
    navigational: 'Навигационный',
    transactional: 'Транзакционный',
};

async function classifyIntents(queries, genAI, pool) {
    if (!genAI || !queries || queries.length === 0) return;

    // filter already-cached queries
    const placeholders = queries.map((_, i) => `$${i + 1}`).join(',');
    const { rows: cached } = await pool.query(
        `SELECT query FROM seo_intents WHERE query IN (${placeholders})`,
        queries
    );
    const cachedSet = new Set(cached.map(r => r.query));
    const uncached = queries.filter(q => !cachedSet.has(q));
    if (uncached.length === 0) return;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        const prompt = `Классифицируй поисковые запросы B2B нефтесервисного маркетплейса по интенту.
Возможные интенты:
- informational — пользователь ищет информацию (что такое, как работает)
- commercial — пользователь выбирает поставщика или сравнивает предложения
- navigational — пользователь ищет конкретную компанию или бренд
- transactional — пользователь готов купить или заказать прямо сейчас

Запросы:
${batch.map((q, idx) => `${idx}. ${q}`).join('\n')}

Отвечай ТОЛЬКО валидным JSON-массивом без markdown. Пример:
[{"query":"буровое оборудование купить","intent":"transactional"}]`;

        let rawText;
        try {
            const result = await model.generateContent(prompt);
            rawText = result.response.text().trim().replace(/^```json|^```|```$/gm, '').trim();
        } catch (e) {
            console.error('[seo/intents] Gemini error:', e.message);
            continue;
        }

        let parsed;
        try { parsed = JSON.parse(rawText); }
        catch { console.error('[seo/intents] JSON parse error, skipping batch'); continue; }

        if (!Array.isArray(parsed)) continue;

        for (const item of parsed) {
            if (!item.query || !item.intent) continue;
            const intent_ru = INTENT_LABELS[item.intent] || item.intent;
            await pool.query(
                `INSERT INTO seo_intents (query, intent, intent_ru)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (query) DO UPDATE SET intent=$2, intent_ru=$3, classified_at=NOW()`,
                [item.query, item.intent, intent_ru]
            );
        }
    }
}

module.exports = { classifyIntents };
