'use strict';
// Приглашения заводам-стабам из госреестра при появлении подходящей закупки.
// Только claimed=false, с contact_email, без optout, не чаще 1 письма/14 дней, топ-20 на закупку.
const crypto = require('crypto');

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
        const claimUrl = `${appUrl}/login.html#register?claim=${encodeURIComponent(stub.inn)}&company=${encodeURIComponent(stub.company)}`;
        const optoutUrl = `${appUrl}/api/registry-invites/optout?inn=${encodeURIComponent(stub.inn)}&token=${optoutToken(stub.inn)}`;
        return `
            <p>Здравствуйте!</p>
            <p>Ваше предприятие «${esc(stub.company)}» состоит в реестре производителей промышленной
               продукции Минпромторга (ПП-719). На площадке прямых закупок ТехЗаказ появился заказ,
               который может вам подойти:</p>
            <p style="font-size:16px;font-weight:700">«${esc(order.title)}»${order.category ? ' · ' + esc(order.category) : ''}</p>
            <p>Чтобы откликнуться, присоедините профиль вашего предприятия (бесплатно, по ИНН):</p>
            <p><a href="${claimUrl}" style="display:inline-block;padding:10px 24px;background:#FF6A00;color:#fff;text-decoration:none;font-weight:600">Присоединить профиль и посмотреть заказ</a></p>
            <p style="color:#64748B;font-size:12px">Вы получили это письмо, потому что предприятие есть в открытом госреестре.
               Больше не присылать: <a href="${optoutUrl}">отписаться</a>.</p>`;
    }

    async function inviteStubsForOrder(order) {
        // Рубильник: REGISTRY_INVITES_ENABLED=0 в .env отключает рассылку
        // (тестовые закупки на проде не должны слать письма реальным заводам)
        if (process.env.REGISTRY_INVITES_ENABLED === '0') return 0;
        const { rows: stubs } = await pool.query(
            `SELECT id, company, inn, specialization, products, contact_email
             FROM companies
             WHERE role = 'producer' AND claimed = false AND invite_optout = false
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
                await pool.query('UPDATE companies SET last_invited_at = NOW() WHERE id = $1', [s.id]);
            } catch (e) {
                console.error('registry-invite fail', s.inn, e.message);
            }
        }
        return scored.length;
    }

    return { inviteStubsForOrder, optoutToken, verifyOptoutToken, matchScoreStub };
}

module.exports = { createRegistryInviter };
