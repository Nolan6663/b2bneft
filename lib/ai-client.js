'use strict';

const crypto = require('crypto');

/**
 * AI client for TZ generation.
 * Two provider paths:
 *  - OpenAI-compatible (DeepSeek, OpenAI, OpenRouter, Groq...) — static Bearer key.
 *  - GigaChat (Sber) — OAuth2 client-credentials exchange (key -> short-lived access_token).
 * Gemini remains on GEMINI_API_KEY for /api/ai-search only.
 */

function getProvider() {
    const explicit = (process.env.AI_TZ_PROVIDER || '').trim().toLowerCase();
    if (explicit) return explicit;
    if (/sberbank|gigachat/i.test(process.env.AI_TZ_BASE_URL || '')) return 'gigachat';
    return 'openai';
}

function getTzAiConfig() {
    const provider = getProvider();
    const apiKey = (
        process.env.AI_TZ_API_KEY ||
        process.env.DEEPSEEK_API_KEY ||
        process.env.OPENAI_API_KEY ||
        ''
    ).trim();

    if (provider === 'gigachat') {
        const model = process.env.AI_TZ_MODEL || 'GigaChat';
        return { provider, apiKey, model, configured: !!apiKey };
    }

    let baseUrl = (
        process.env.AI_TZ_BASE_URL ||
        process.env.DEEPSEEK_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        'https://api.deepseek.com'
    ).replace(/\/$/, '');
    if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';
    const model = process.env.AI_TZ_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    return { provider, apiKey, baseUrl, model, configured: !!apiKey };
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
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // модели без строгого JSON-режима (GigaChat и т.п.) иногда добавляют
        // пояснительный текст вокруг объекта — вытаскиваем первый {...} блок
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) {
            return JSON.parse(cleaned.slice(start, end + 1));
        }
        throw e;
    }
}

/* ===================== GigaChat (Sber) ===================== */
const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const GIGACHAT_API_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
let gigaToken = { value: null, expiresAt: 0 };

async function getGigaChatToken(authKey) {
    if (gigaToken.value && Date.now() < gigaToken.expiresAt - 10000) {
        return gigaToken.value;
    }
    const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
    const res = await fetch(GIGACHAT_OAUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Basic ${authKey}`,
            RqUID: crypto.randomUUID(),
        },
        body: new URLSearchParams({ scope }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data?.message || `GigaChat OAuth HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    gigaToken = {
        value: data.access_token,
        expiresAt: Number(data.expires_at) || (Date.now() + 25 * 60 * 1000),
    };
    return gigaToken.value;
}

async function chatCompletionGigaChat({ system, user, temperature, maxTokens, apiKey, model }) {
    const token = await getGigaChatToken(apiKey);
    const res = await fetch(GIGACHAT_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = data?.message || data?.error?.message || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        if (res.status === 401 || res.status === 403) err.code = 'AI_AUTH';
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

/* ===================== OpenAI-compatible ===================== */
async function chatCompletionOpenAi({ system, user, temperature, maxTokens, apiKey, baseUrl, model }) {
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
        if (res.status === 401 || res.status === 403) err.code = 'AI_AUTH';
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

async function chatCompletion({ system, user, temperature = 0.35, maxTokens = 2048 }) {
    const cfg = getTzAiConfig();
    if (!cfg.configured) {
        const err = new Error('AI_TZ_API_KEY не задан');
        err.code = 'AI_NOT_CONFIGURED';
        throw err;
    }
    if (cfg.provider === 'gigachat') {
        return chatCompletionGigaChat({ system, user, temperature, maxTokens, apiKey: cfg.apiKey, model: cfg.model });
    }
    return chatCompletionOpenAi({ system, user, temperature, maxTokens, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model });
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
        if (process.env.AI_DEBUG_RAW) console.log('=== RAW LLM OUTPUT ===\n', raw, '\n=== END ===');
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

const PROPOSAL_SYSTEM_PROMPT = `Ты — менеджер по продажам компании-поставщика на B2B-платформе «ТехЗаказ» (нефтесервис, РФ).
Составляешь сопроводительное сообщение к коммерческому предложению (КП) в ответ на заявку заказчика.

Правила:
- Пиши на русском, деловой и уверенный тон, без канцелярита.
- Опирайся только на факты из брифа поставщика — не выдумывай сертификаты, опыт, оборудование, которых там нет.
- Покажи, что понял задачу заказчика — сошлись на 1–2 детали из его ТЗ.
- 3–5 предложений связным текстом, без списков и заголовков — это сопроводительное письмо, не спецификация.
- Не указывай в тексте цену и срок поставки — они уже отображаются в форме отдельно.
- Отвечай ТОЛЬКО валидным JSON без markdown-обёртки.

Формат JSON:
{
  "message": "готовый текст сопроводительного сообщения к КП"
}`;

async function generateProposalMessage({ orderTitle, orderDescription, orderCategory, brief }) {
    const userParts = [
        `Заявка заказчика: ${orderTitle || 'без названия'}`,
        orderCategory ? `Категория: ${orderCategory}` : null,
        orderDescription ? `Техническое задание заказчика:\n${String(orderDescription).slice(0, 1500)}` : null,
        '',
        'Что может предложить поставщик (бриф от поставщика):',
        brief.trim(),
    ].filter(v => v !== null);

    const raw = await chatCompletion({
        system: PROPOSAL_SYSTEM_PROMPT,
        user: userParts.join('\n'),
        maxTokens: 700,
    });

    let parsed;
    try {
        if (process.env.AI_DEBUG_RAW) console.log('=== RAW LLM OUTPUT ===\n', raw, '\n=== END ===');
        parsed = parseJsonFromLlm(raw);
    } catch {
        const err = new Error('Не удалось разобрать ответ модели');
        err.code = 'AI_PARSE';
        throw err;
    }

    const message = String(parsed.message || '').trim().slice(0, 2000);
    if (!message) {
        const err = new Error('Модель вернула пустое сообщение');
        err.code = 'AI_EMPTY';
        throw err;
    }
    return { message };
}

module.exports = {
    getTzAiConfig,
    isTzAiConfigured,
    chatCompletion,
    parseJsonFromLlm,
    generateProcurementTz,
    generateProposalMessage,
};
