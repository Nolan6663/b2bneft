'use strict';

/**
 * AI client for TZ generation — OpenAI-compatible API (DeepSeek, OpenAI, OpenRouter, etc.)
 * Gemini remains on GEMINI_API_KEY for /api/ai-search only.
 */

function getTzAiConfig() {
    const apiKey =
        process.env.AI_TZ_API_KEY ||
        process.env.DEEPSEEK_API_KEY ||
        process.env.OPENAI_API_KEY ||
        '';
    let baseUrl = (
        process.env.AI_TZ_BASE_URL ||
        process.env.DEEPSEEK_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        'https://api.deepseek.com'
    ).replace(/\/$/, '');
    if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';
    const model = process.env.AI_TZ_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    return { apiKey: apiKey.trim(), baseUrl, model, configured: !!apiKey.trim() };
}

function isTzAiConfigured() {
    return getTzAiConfig().configured;
}

function parseJsonFromLlm(text) {
    const cleaned = String(text || '')
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/g, '')
        .trim();
    return JSON.parse(cleaned);
}

async function chatCompletion({ system, user, temperature = 0.35, maxTokens = 2048 }) {
    const { apiKey, baseUrl, model, configured } = getTzAiConfig();
    if (!configured) {
        const err = new Error('AI_TZ_API_KEY не задан');
        err.code = 'AI_NOT_CONFIGURED';
        throw err;
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        if (res.status === 401) err.code = 'AI_AUTH';
        if (res.status === 429) err.code = 'AI_RATE_LIMIT';
        throw err;
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
        const err = new Error('Пустой ответ модели');
        err.code = 'AI_EMPTY';
        throw err;
    }
    return text;
}

const TZ_SYSTEM_PROMPT = `Ты — инженер-закупщик B2B-платформы «ТехЗаказ» (нефтесервис, РФ).
Составляешь техническое задание (ТЗ) на закупку для размещения у производителей.

Правила:
- Пиши на русском, деловой стиль, без воды и маркетинга.
- Указывай реальные ГОСТ/ТУ/ГОСТ Р где уместно для категории (РТИ, металл, арматура, электро).
- Если данных не хватает — укажи «уточнить у заказчика» в соответствующем пункте, не выдумывай точные размеры.
- description — структурированный текст с нумерованными разделами (1–6).
- Отвечай ТОЛЬКО валидным JSON без markdown-обёртки.

Формат JSON:
{
  "title": "краткое наименование изделия/закупки",
  "description": "полное ТЗ: 1. Назначение\\n2. Технические требования\\n3. Количество и сроки\\n4. Контроль качества\\n5. Условия поставки\\n6. Комплект документации",
  "checklist": ["2–4 пункта что заказчику стоит проверить перед публикацией"]
}`;

async function generateProcurementTz({ brief, category, quantity, title }) {
    const userParts = [
        `Категория: ${category || 'Прочее'}`,
        title ? `Черновик названия: ${title}` : null,
        quantity ? `Количество: ${quantity} шт.` : null,
        '',
        'Запрос заказчика:',
        brief.trim(),
    ].filter(v => v !== null);

    const raw = await chatCompletion({
        system: TZ_SYSTEM_PROMPT,
        user: userParts.join('\n'),
    });

    let parsed;
    try {
        parsed = parseJsonFromLlm(raw);
    } catch {
        const err = new Error('Не удалось разобрать ответ модели');
        err.code = 'AI_PARSE';
        throw err;
    }

    const outTitle = String(parsed.title || title || '').trim().slice(0, 200);
    const description = String(parsed.description || '').trim().slice(0, 8000);
    const checklist = Array.isArray(parsed.checklist)
        ? parsed.checklist.map(s => String(s).trim()).filter(Boolean).slice(0, 6)
        : [];

    if (!description) {
        const err = new Error('Модель вернула пустое ТЗ');
        err.code = 'AI_EMPTY';
        throw err;
    }

    return { title: outTitle, description, checklist };
}

module.exports = {
    getTzAiConfig,
    isTzAiConfigured,
    generateProcurementTz,
};
