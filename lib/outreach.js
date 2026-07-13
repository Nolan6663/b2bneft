'use strict';
// Маркетинговая рассылка заводам-стабам: одно персональное AI-письмо на компанию, повторно не шлём.
// Кандидаты: claimed=false, invite_optout=false, есть contact_email, нет записи в outreach_log
// со status='sent', и не получали инвайт по закупке последние 7 дней (не бомбим).
// Отписка — тот же токен и эндпоинт, что у registry-invites (/api/registry-invites/optout).
const { chatCompletion, parseJsonFromLlm, isTzAiConfigured } = require('./ai-client');
const { createRegistryInviter } = require('./registry-invites');

const MAX_PARAGRAPHS = 4;

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LEGAL_FORMS = /^\s*(ПУБЛИЧНОЕ\s+)?(АКЦИОНЕРНОЕ\s+ОБЩЕСТВО|ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ|ЗАКРЫТОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО|ОТКРЫТОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО|НЕПУБЛИЧНОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО|ПРОИЗВОДСТВЕННЫЙ\s+КООПЕРАТИВ|(П|З|О|Н)?АО|ООО|ПК|ИП)\s+/i;

// «АКЦИОНЕРНОЕ ОБЩЕСТВО "АБС ЗЭИМ АВТОМАТИЗАЦИЯ"» -> «АБС ЗЭИМ Автоматизация»:
// правовую форму убираем, капс длинных слов приводим к виду с заглавной,
// короткие капс-слова (АБС, ЗЭИМ, РТИ) считаем аббревиатурами и не трогаем.
function shortCompanyName(raw) {
    let s = String(raw || '').trim().replace(LEGAL_FORMS, '').replace(/["«»]/g, '').trim();
    if (!s) return String(raw || '').trim();
    if (s === s.toUpperCase()) {
        s = s.split(/\s+/).map(w =>
            (w.length > 4 && /[А-ЯЁA-Z]/.test(w)) ? w.charAt(0) + w.slice(1).toLowerCase() : w
        ).join(' ');
    }
    return s;
}

const OUTREACH_SYSTEM_PROMPT = `Ты пишешь короткое деловое письмо-знакомство от площадки прямых
промышленных закупок «ТехЗаказ» (texzakaz.ru) конкретному российскому заводу-производителю.

Факты о площадке (используй только их, ничего не выдумывай):
- Заказчики из нефтесервиса и промышленности размещают закупки (РТИ, металлообработка, арматура, электрика и др.).
- Производитель откликается на заказы напрямую, без посредников и тендерных комиссий.
- Профиль завода уже создан на площадке по открытым данным — его нужно только присоединить по ИНН, это бесплатно.
- Есть карта производителей, по которой заказчики ищут поставщиков рядом.

Правила:
- Пиши на русском, деловой тон, без рекламных штампов («уникальная возможность», «не упустите» — запрещено).
- Обращайся к предприятию по его профилю: упомяни, что оно производит и где находится, и какие
  закупки на площадке ему релевантны. Это главная ценность письма — оно не должно выглядеть массовым.
- 2–3 коротких абзаца, каждый 1–3 предложения. Без приветствия и подписи — их добавит шаблон.
- Тема письма: конкретная, до 60 знаков, без слов «реклама», «скидка», «бесплатно», без восклицаний,
  без капса и без организационно-правовых форм (АО, ООО и т.п.).
- Отвечай ТОЛЬКО валидным JSON без markdown-обёртки.

Формат JSON:
{
  "subject": "тема письма",
  "paragraphs": ["абзац 1", "абзац 2", "абзац 3 (опционально)"]
}`;

function buildUserPrompt(stub) {
    return [
        `Завод: ${shortCompanyName(stub.company)}`,
        stub.city ? `Регион: ${stub.city}` : null,
        stub.specialization ? `Специализация: ${stub.specialization}` : null,
        stub.products ? `Продукция: ${String(stub.products).slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');
}

function fallbackLetter(stub) {
    const name = shortCompanyName(stub.company);
    // не обрезаем посреди слова — длинное имя просто выкидываем из темы
    const subject = name.length <= 40
        ? `Прямые заказы для «${name}» на ТехЗаказ`
        : 'Прямые заказы для вашего предприятия на ТехЗаказ';
    return {
        subject,
        paragraphs: [
            `Профиль вашего предприятия уже есть в каталоге производителей ТехЗаказ — площадки прямых закупок для нефтесервиса и промышленности.`,
            `Заказчики размещают закупки и ищут производителей по карте. Чтобы получать заказы по вашему профилю, присоедините предприятие по ИНН — это бесплатно и занимает пару минут.`,
        ],
    };
}

function createOutreach({ pool, transport, appUrl, jwtSecret, emailFrom, replyTo }) {
    const inviter = createRegistryInviter({ pool, sendEmail: null, appUrl, jwtSecret });

    async function generateLetter(stub) {
        if (!isTzAiConfigured()) return { ...fallbackLetter(stub), ai: false };
        try {
            const raw = await chatCompletion({
                system: OUTREACH_SYSTEM_PROMPT,
                user: buildUserPrompt(stub),
                temperature: 0.5,
                maxTokens: 600,
            });
            if (process.env.AI_DEBUG_RAW) console.log('=== RAW LLM OUTPUT ===\n', raw, '\n=== END ===');
            const parsed = parseJsonFromLlm(raw);
            const subject = String(parsed.subject || '').trim().slice(0, 80);
            const paragraphs = (Array.isArray(parsed.paragraphs) ? parsed.paragraphs : [])
                .map(p => String(p || '').trim()).filter(Boolean).slice(0, MAX_PARAGRAPHS);
            if (!subject || !paragraphs.length) return { ...fallbackLetter(stub), ai: false };
            return { subject, paragraphs, ai: true };
        } catch (e) {
            console.error('outreach: AI fail, использую шаблон:', e.message);
            return { ...fallbackLetter(stub), ai: false };
        }
    }

    function renderHtml(stub, letter) {
        const claimUrl = `${appUrl}/login.html?utm_source=outreach&utm_medium=email&utm_campaign=cold-intro#register?claim=${encodeURIComponent(stub.inn)}&company=${encodeURIComponent(stub.company)}`;
        const optoutUrl = `${appUrl}/api/registry-invites/optout?inn=${encodeURIComponent(stub.inn)}&token=${inviter.optoutToken(stub.inn)}`;
        const body = letter.paragraphs.map(p => `<p>${esc(p)}</p>`).join('\n            ');
        return `
            <p>Здравствуйте!</p>
            ${body}
            <p><a href="${claimUrl}" style="display:inline-block;padding:10px 24px;background:#FF6A00;color:#fff;text-decoration:none;font-weight:600">Присоединить профиль по ИНН</a></p>
            <p style="color:#64748B;font-size:12px">Вы получили это письмо, потому что контакты предприятия
               опубликованы в открытых источниках. Больше не присылать: <a href="${optoutUrl}">отписаться</a>.</p>`;
    }

    async function pickCandidates(limit) {
        const { rows } = await pool.query(
            `SELECT c.id, c.company, c.inn, c.city, c.specialization, c.products, c.contact_email
             FROM companies c
             WHERE c.role = 'producer' AND c.claimed = false AND c.invite_optout = false
               AND c.contact_email <> ''
               AND (c.last_invited_at IS NULL OR c.last_invited_at < NOW() - INTERVAL '7 days')
               AND NOT EXISTS (SELECT 1 FROM outreach_log l WHERE l.company_id = c.id AND l.status = 'sent')
             ORDER BY (c.specialization <> '' OR c.products <> '') DESC, c.id
             LIMIT $1`,
            [limit]
        );
        return rows;
    }

    async function sendLetter(stub, letter, overrideTo) {
        const to = overrideTo || stub.contact_email;
        const info = await transport.sendMail({
            from: `ТехЗаказ <${emailFrom}>`,
            to,
            replyTo: replyTo || undefined,
            subject: letter.subject,
            html: renderHtml(stub, letter),
        });
        return info.messageId;
    }

    async function markSent(stub, letter) {
        await pool.query(
            `INSERT INTO outreach_log (company_id, email, subject, status) VALUES ($1, $2, $3, 'sent')`,
            [stub.id, stub.contact_email, letter.subject]
        );
        // last_invited_at двигаем, чтобы registry-invites не прислал этому же заводу
        // ещё и инвайт по закупке на следующий день
        await pool.query('UPDATE companies SET last_invited_at = NOW() WHERE id = $1', [stub.id]);
    }

    async function markFailed(stub, letter, err) {
        await pool.query(
            `INSERT INTO outreach_log (company_id, email, subject, status, error) VALUES ($1, $2, $3, 'failed', $4)`,
            [stub.id, stub.contact_email, letter.subject, String(err.message || err).slice(0, 500)]
        );
    }

    return { generateLetter, renderHtml, pickCandidates, sendLetter, markSent, markFailed, buildUserPrompt, fallbackLetter };
}

module.exports = { createOutreach, buildUserPrompt, fallbackLetter, shortCompanyName, OUTREACH_SYSTEM_PROMPT };
