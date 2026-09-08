'use strict';
// Приглашения заводам-стабам из госреестра при появлении подходящей закупки.
// Только claimed=false, с contact_email, без optout, не чаще 1 письма/14 дней, топ-20 на закупку.
// ИП исключены (их название — ФИО физлица), отправка включается REGISTRY_INVITES_ENABLED=1.
const crypto = require('crypto');
const { excludeUnclaimedSoleTradersSql } = require('./personal-data');

const MIN_SCORE = 2;
const MAX_INVITES_PER_ORDER = 20;

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function words(s) {
    const str = String(s || '');
    const tokens = str.match(/[а-яёА-ЯЁa-zA-Z]+/g) || [];
    const out = [];
    for (const t of tokens) {
        if (t.length >= 4) {
            out.push(t.toLowerCase());
        } else if (t.length >= 3 && t === t.toUpperCase() && t !== t.toLowerCase()) {
            // Отраслевые аббревиатуры (РТИ, ГОСТ, ISO...) короче 4 букв, но заглавные и значимые —
            // учитываем их отдельно, не ослабляя общий порог длины для обычных слов.
            out.push(t.toLowerCase());
        }
    }
    return out;
}

function createRegistryInviter({ pool, sendEmail, appUrl, jwtSecret }) {
    function matchScoreStub(order, stub) {
        const orderWords = new Set(words(`${order.title} ${order.category} ${order.description}`));
        const stubWords = new Set(words(`${stub.specialization} ${stub.products}`));
        let score = 0;
        for (const w of stubWords) if (orderWords.has(w)) score++;
        return score;
    }

    function optoutToken(inn) {
        return crypto.createHmac('sha256', jwtSecret).update(String(inn)).digest('hex').slice(0, 32);
    }

    function verifyOptoutToken(inn, token) {
        const expected = optoutToken(inn);
        const a = Buffer.from(expected);
        const b = Buffer.from(String(token || ''));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    function inviteHtml(order, stub) {
        // Ведём в мастер /zavod с готовым ИНН: он сам находит стаб и показывает,
        // что мы про предприятие уже знаем. Раньше ссылка шла на общую регистрацию,
        // где завод вводил руками то, что у нас и так есть.
        const claimUrl = `${appUrl}/zavod?inn=${encodeURIComponent(stub.inn)}&utm_source=registry-invite&utm_medium=email&utm_campaign=order-invite`;
        const optoutUrl = `${appUrl}/api/registry-invites/optout?inn=${encodeURIComponent(stub.inn)}&token=${optoutToken(stub.inn)}`;
        // Про Минпромторг (ПП-719) пишем только стабам из ГИСП — остальные источники
        // (например fabricators) получают честную формулировку про открытые данные
        const fromGisp = stub.source === 'gisp-pp719';
        const intro = fromGisp
            ? `Ваше предприятие «${esc(stub.company)}» состоит в реестре производителей промышленной
               продукции Минпромторга (ПП-719).`
            : `Профиль вашего предприятия «${esc(stub.company)}» есть в каталоге производителей ТехЗаказ
               (создан по открытым данным).`;
        const footer = fromGisp
            ? 'Вы получили это письмо, потому что предприятие есть в открытом госреестре.'
            : 'Вы получили это письмо, потому что контакты предприятия опубликованы в открытых источниках.';
        return `
            <p>Здравствуйте!</p>
            <p>${intro} На площадке прямых закупок ТехЗаказ появился заказ,
               который может вам подойти:</p>
            <p style="font-size:16px;font-weight:700">«${esc(order.title)}»${order.category ? ' · ' + esc(order.category) : ''}</p>
            <p>Чтобы откликнуться, присоедините профиль вашего предприятия (бесплатно, по ИНН):</p>
            <p><a href="${claimUrl}" style="display:inline-block;padding:10px 24px;background:#FF6A00;color:#fff;text-decoration:none;font-weight:600">Присоединить профиль и посмотреть заказ</a></p>
            <p style="color:#64748B;font-size:12px">${footer}
               Больше не присылать: <a href="${optoutUrl}">отписаться</a>.</p>`;
    }

    async function inviteStubsForOrder(order) {
        // Рубильник: рассылка включается только явным REGISTRY_INVITES_ENABLED=1.
        //
        // Раньше значением по умолчанию была отправка, а выключал её '0'. Это
        // письмо предприятию, которое нас ни о чём не просило и адрес нам не
        // давало, — реклама по сетям электросвязи, а она требует предварительного
        // согласия адресата (ФЗ-38 «О рекламе», ст. 18 ч. 1; ответственность —
        // ст. 14.3 ч. 1 КоАП, за каждое письмо). У такой рассылки безопасное
        // положение по умолчанию — «выключено»: забытая переменная окружения
        // должна приводить к молчанию, а не к рассылке.
        if (process.env.REGISTRY_INVITES_ENABLED !== '1') return 0;
        const { rows: stubs } = await pool.query(
            `SELECT id, company, inn, specialization, products, contact_email, source
             FROM companies
             WHERE role = 'producer' AND claimed = false AND invite_optout = false
               AND ${excludeUnclaimedSoleTradersSql('')}
               AND contact_email <> ''
               AND (last_invited_at IS NULL OR last_invited_at < NOW() - INTERVAL '14 days')`
        );
        const scored = stubs
            .map(s => ({ s, score: matchScoreStub(order, s) }))
            .filter(x => x.score >= MIN_SCORE)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_INVITES_PER_ORDER);
        for (const { s } of scored) {
            try {
                await sendEmail(s.contact_email, `Заказ на ТехЗаказ: ${order.title}`, inviteHtml(order, s));
                await pool.query('UPDATE companies SET last_invited_at = NOW(), invites_sent = invites_sent + 1 WHERE id = $1', [s.id]);
            } catch (e) {
                console.error('registry-invite fail', s.inn, e.message);
            }
        }
        return scored.length;
    }

    return { inviteStubsForOrder, optoutToken, verifyOptoutToken, matchScoreStub };
}

module.exports = { createRegistryInviter };
