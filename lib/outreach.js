'use strict';
// Маркетинговая рассылка заводам-стабам: одно персональное AI-письмо на компанию, повторно не шлём.
// Кандидаты: claimed=false, invite_optout=false, есть contact_email, нет записи в outreach_log
// со status='sent', и не получали инвайт по закупке последние 7 дней (не бомбим).
// Отписка — тот же токен и эндпоинт, что у registry-invites (/api/registry-invites/optout).
const dns = require('dns').promises;
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
- Профиль завода виден заказчикам на карте производителей — ЗАКАЗЧИКИ находят по ней завод,
  а не наоборот. Никогда не предлагай заводу «искать поставщиков».

Правила:
- Пиши на русском, деловой тон, без рекламных штампов («уникальная возможность», «не упустите» — запрещено).
- Обращайся к предприятию по его профилю: упомяни, что оно производит и где находится, и какие
  закупки на площадке ему релевантны. Это главная ценность письма — оно не должно выглядеть массовым.
- Продукцию описывай обобщённо, своими словами. Артикулы и модельные номера из профиля
  (типа «CM.2B-101/4Н») дословно НЕ копируй.
- 2–3 коротких абзаца, каждый 1–3 законченных предложения с точкой на конце.
- Без приветствия и подписи — их добавит шаблон. Не начинай абзацы с обращений
  («Уважаемые коллеги», «Уважаемый производитель») — сразу к делу.
- Название площадки пиши всегда «ТехЗаказ» — с большой буквы, в кавычках или без.
- Тема письма: конкретная, до 60 знаков. Не начинай с призыва («Присоединяйтесь», «Получите»),
  лучше упомяни продукцию или отрасль завода. Без слов «реклама», «скидка», «бесплатно»,
  без восклицаний, без капса и без организационно-правовых форм (АО, ООО и т.п.).
- Отвечай ТОЛЬКО валидным JSON без markdown-обёртки.

Формат JSON:
{
  "subject": "тема письма",
  "paragraphs": ["абзац 1", "абзац 2", "абзац 3 (опционально)"]
}`;

// Почты в реестрах протухшие: несуществующий домен = гарантированный отскок,
// а отскоки роняют репутацию ящика-отправителя. Проверяем MX (или хотя бы A) до отправки.
async function domainLooksDeliverable(email) {
    const domain = String(email || '').split('@')[1];
    if (!domain) return false;
    try {
        const mx = await dns.resolveMx(domain);
        if (mx.length) return true;
    } catch {}
    try {
        const a = await dns.resolve4(domain);
        return a.length > 0;
    } catch {}
    return false;
}

// Модель игнорирует запрет на обращения — срезаем «Уважаемые...», «Здравствуйте...»
// с начала абзаца детерминированно (шаблон письма уже начинается со «Здравствуйте!»)
function stripGreeting(p) {
    return String(p || '')
        .replace(/^\s*(уважаем[^.!?]*|здравствуйте[^.!?]*|добрый\s+день[^.!?]*|коллеги[^.!?]*)[.!?]+\s*/i, '')
        .trim();
}

function buildUserPrompt(stub) {
    return [
        `Завод: ${shortCompanyName(stub.company)}`,
        stub.city ? `Регион: ${stub.city}` : null,
        stub.specialization ? `Специализация: ${stub.specialization}` : null,
        stub.products ? `Продукция: ${String(stub.products).slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');
}

// Реестр ГИСП широкий: там и авиастроение, и кухонные плиты. Площадка про нефтесервис
// и промышленную обвязку, поэтому письмо такому заводу — сожжённая квота и репутационный
// риск. Группы ниже повторяют категории закупок (РТИ, металл, арматура, электротехника)
// плюс типовую обвязку. Совпадение по нескольким группам ценнее одного.
const RELEVANCE_GROUPS = [
    ['рти', 'резинотехн', 'резинов', 'уплотнен', 'манжет', 'прокладк', 'сальник', 'полиуретан', 'шланг', 'рукав'],
    ['металлообработ', 'мехобработ', 'механическ обработ', 'токарн', 'фрезер', 'литейн', 'литьё', 'литье', 'штамп', 'поковк', 'металлоконструкц', 'сварн'],
    ['арматур', 'задвижк', 'шаров кран', 'клапан', 'затвор', 'фланец', 'фланц', 'фитинг', 'трубопровод', 'труб'],
    ['электротехн', 'кабел', 'щит управлен', 'шкаф управлен', 'электродвигател', 'трансформатор', 'электропривод', 'кип', 'автоматизаци'],
    ['насос', 'компрессор', 'редуктор', 'подшипник', 'емкост', 'резервуар', 'теплообмен'],
    ['нефт', 'газов', 'бурен', 'скважин', 'нпз', 'нефтесервис', 'нефтепром'],
];

/** Сколько групп категорий затронул профиль завода. 0 — писать не о чем. */
function relevanceScore(stub) {
    const haystack = `${stub.specialization || ''} ${stub.products || ''}`.toLowerCase().replace(/ё/g, 'е');
    let score = 0;
    for (const group of RELEVANCE_GROUPS) {
        if (group.some(word => haystack.includes(word.replace(/ё/g, 'е')))) score++;
    }
    return score;
}

/** Только релевантные, лучшие первыми. Нерелевантными добор не делаем — лучше
 *  отправить меньше писем, чем предложить производителю самолётов «прямые закупки РТИ». */
function pickRelevant(stubs, limit) {
    return stubs
        .map(stub => ({ stub, score: relevanceScore(stub) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.stub.id || 0) - (b.stub.id || 0))
        .slice(0, limit)
        .map(x => x.stub);
}

const SUBJECT_MAX = 80;

/** Тема письма не должна обрываться посреди слова: модель регулярно выдаёт строку
 *  длиннее лимита, и жёсткий slice давал в ящике «...щебнеочистительного оборудован». */
function trimSubject(text, max = SUBJECT_MAX) {
    const s = String(text || '').trim().replace(/\s+/g, ' ');
    if (s.length <= max) return s;
    const lastSpace = s.slice(0, max + 1).lastIndexOf(' ');
    const cut = lastSpace > 0 ? s.slice(0, lastSpace) : s.slice(0, max);
    return cut.replace(/[\s,;:.—-]+$/, '');
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
            const subject = trimSubject(parsed.subject);
            const paragraphs = (Array.isArray(parsed.paragraphs) ? parsed.paragraphs : [])
                .map(p => stripGreeting(p)).filter(Boolean).slice(0, MAX_PARAGRAPHS);
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

    // Профиль без специализации и продукции оценивать нечем — такие в отбор не берём:
    // relevanceScore всё равно вернёт 0. Отбор по релевантности идёт в JS (pickRelevant),
    // поэтому из базы забираем весь пул подходящих по формальным правилам.
    async function pickCandidates(limit) {
        const { rows } = await pool.query(
            `SELECT c.id, c.company, c.inn, c.city, c.specialization, c.products, c.contact_email
             FROM companies c
             WHERE c.role = 'producer' AND c.claimed = false AND c.invite_optout = false
               AND c.contact_email <> ''
               AND (c.specialization <> '' OR c.products <> '')
               AND (c.last_invited_at IS NULL OR c.last_invited_at < NOW() - INTERVAL '7 days')
               AND NOT EXISTS (SELECT 1 FROM outreach_log l WHERE l.company_id = c.id AND l.status IN ('sent', 'bad-domain'))
             ORDER BY c.id`
        );
        const picked = pickRelevant(rows, limit);
        console.log(`Пул по формальным правилам: ${rows.length}, релевантных из них: ${rows.filter(r => relevanceScore(r) > 0).length}, беру: ${picked.length}`);
        return picked;
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

    async function markBadDomain(stub) {
        await pool.query(
            `INSERT INTO outreach_log (company_id, email, subject, status, error) VALUES ($1, $2, '', 'bad-domain', 'MX/A lookup failed')`,
            [stub.id, stub.contact_email]
        );
    }

    async function markFailed(stub, letter, err) {
        await pool.query(
            `INSERT INTO outreach_log (company_id, email, subject, status, error) VALUES ($1, $2, $3, 'failed', $4)`,
            [stub.id, stub.contact_email, letter.subject, String(err.message || err).slice(0, 500)]
        );
    }

    return { generateLetter, renderHtml, pickCandidates, sendLetter, markSent, markFailed, markBadDomain, buildUserPrompt, fallbackLetter };
}

module.exports = { createOutreach, buildUserPrompt, fallbackLetter, trimSubject, relevanceScore, pickRelevant, shortCompanyName, stripGreeting, domainLooksDeliverable, OUTREACH_SYSTEM_PROMPT };
