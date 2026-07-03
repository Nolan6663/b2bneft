'use strict';

const express = require('express');
const { fetchEgrulData, evaluateAutoVerification } = require('../lib/egrul-verify');

function createAdminRouter(deps) {
    const {
        pool,
        requireAuth,
        requireRole,
        withTransaction,
        addNotification,
        getCompanyEmail,
        sendEmail,
        htmlEscape,
        getUserIdsByCompany,
        sendPush,
        sendTelegramNotification,
        APP_URL,
    } = deps;

    const router = express.Router();

    // ===================== ВЕРИФИКАЦИЯ =====================
    
    router.post('/verification/request', requireAuth, async (req, res, next) => {
        try {
            if (req.user.role === 'admin') return res.status(403).json({ error: 'Недоступно для администраторов' });
    
            const platformTier = req.body?.platformTier === true;
    
            const { rows: [company] } = await pool.query(
                'SELECT * FROM companies WHERE company = $1 AND role = $2',
                [req.user.company, req.user.role]
            );
            if (!company) return res.status(404).json({ error: 'Профиль компании не найден' });
            if (company.verified_by_platform) {
                return res.status(400).json({ error: 'Компания уже верифицирована платформой' });
            }
    
            const { rows: [existing] } = await pool.query(
                'SELECT * FROM verification_requests WHERE company_id = $1',
                [company.id]
            );
            if (existing && existing.status === 'pending') {
                return res.status(400).json({ error: 'Заявка уже отправлена и ожидает рассмотрения' });
            }
            if (existing) {
                await pool.query('DELETE FROM verification_requests WHERE company_id = $1', [company.id]);
            }
    
            // Расширенная верификация платформой (ручная) — для тех, у кого уже есть ЕГРЮЛ
            if (platformTier || company.verified_egrul) {
                await pool.query(
                    "INSERT INTO verification_requests (company_id, status) VALUES ($1, 'pending')",
                    [company.id]
                );
                return res.json({
                    tier: 'platform',
                    status: 'pending',
                    message: 'Заявка на верификацию платформой отправлена. Мы проверим профиль вручную.',
                });
            }
    
            // Автопроверка по ЕГРЮЛ (бесплатно)
            const egrul = await fetchEgrulData(String(company.inn || '').trim());
            const evaluation = evaluateAutoVerification(company, req.user, egrul);
    
            if (evaluation.pass) {
                await withTransaction(async (client) => {
                    await client.query(
                        'UPDATE companies SET verified_egrul = true, egrul_verified_at = NOW() WHERE id = $1',
                        [company.id]
                    );
                    await client.query(
                        "INSERT INTO verification_requests (company_id, status, reviewed_at) VALUES ($1, 'approved_auto', NOW())",
                        [company.id]
                    );
                });
    
                const checksText = evaluation.checks.map(c => c.detail).filter(Boolean).join(' · ');
                await addNotification(
                    company.company,
                    `✓ Компания проверена по ЕГРЮЛ${checksText ? ': ' + checksText : ''}`
                );
                const email = await getCompanyEmail(company.company);
                if (email) {
                    await sendEmail(email, 'Верификация по ЕГРЮЛ — ТехЗаказ',
                        `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                          <h3 style="color:#0B8FCE">Проверено по ЕГРЮЛ</h3>
                          <p>Компания <strong>${htmlEscape(company.company)}</strong> прошла автоматическую проверку в реестре ФНС.</p>
                          <p style="color:#555;font-size:14px;">${htmlEscape(checksText || 'Компания действующая')}</p>
                          <p style="font-size:13px;color:#888;">Для знака «Верифицирован платформой» заполните профиль и подайте заявку на расширенную проверку.</p>
                          <a href="${APP_URL}/company-profile.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#0B8FCE;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть профиль</a>
                        </div>`
                    );
                }
    
                return res.json({
                    tier: 'egrul',
                    status: 'approved_egrul',
                    autoApproved: true,
                    checks: evaluation.checks,
                    message: 'Компания проверена автоматически по ЕГРЮЛ. Знак отображается в профиле и каталоге.',
                });
            }
    
            if (evaluation.manual) {
                await pool.query(
                    "INSERT INTO verification_requests (company_id, status, admin_comment) VALUES ($1, 'pending', $2)",
                    [company.id, evaluation.reason || 'Требуется ручная проверка']
                );
                return res.json({
                    tier: 'platform',
                    status: 'pending',
                    manual: true,
                    message: evaluation.reason
                        || 'Не удалось проверить по ЕГРЮЛ автоматически — заявка передана модератору.',
                });
            }
    
            return res.status(400).json({
                error: evaluation.reason || 'Автоматическая проверка не пройдена',
                checks: evaluation.checks,
            });
        } catch (e) { next(e); }
    });
    
    router.get('/verification/status', requireAuth, async (req, res, next) => {
        try {
            if (req.user.role === 'admin') return res.json({ status: 'none', tier: null });
    
            const { rows: [company] } = await pool.query(
                'SELECT * FROM companies WHERE company = $1 AND role = $2',
                [req.user.company, req.user.role]
            );
            if (!company) return res.json({ status: 'none', tier: null });
    
            if (company.verified_by_platform) {
                return res.json({ status: 'approved', tier: 'platform' });
            }
            if (company.verified_egrul) {
                return res.json({
                    status: 'approved_egrul',
                    tier: 'egrul',
                    egrulVerifiedAt: company.egrul_verified_at,
                });
            }
    
            const { rows: [vr] } = await pool.query(
                'SELECT * FROM verification_requests WHERE company_id = $1',
                [company.id]
            );
            if (!vr) return res.json({ status: 'none', tier: null });
    
            return res.json({
                status: vr.status === 'approved_auto' ? 'approved_egrul' : vr.status,
                tier: vr.status === 'approved_auto' ? 'egrul' : (vr.status === 'pending' ? 'platform' : null),
                comment: vr.admin_comment || '',
                requestedAt: vr.requested_at,
            });
        } catch (e) { next(e); }
    });
    
    router.get('/verification/requests', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const filter = req.query.filter === 'all' ? 'all' : 'pending';
            const sql = `
                SELECT vr.*, c.company, c.inn, c.ogrn, c.director, c.founding_year,
                    c.authorized_capital, c.employees, c.revenue, c.machines_count, c.production_area,
                    c.capabilities, c.iso_certificates, c.quality_certificates, c.specialization, c.city,
                    c.role AS company_role
                FROM verification_requests vr JOIN companies c ON c.id = vr.company_id
                ${filter === 'pending' ? "WHERE vr.status = 'pending'" : ''}
                ORDER BY vr.requested_at DESC
            `;
            const { rows } = await pool.query(sql);
            res.json(rows.map(r => ({
                id: r.id, companyId: r.company_id, status: r.status,
                adminComment: r.admin_comment, requestedAt: r.requested_at, reviewedAt: r.reviewed_at,
                company: r.company, inn: r.inn, ogrn: r.ogrn || '', director: r.director || '',
                foundingYear: r.founding_year, authorizedCapital: r.authorized_capital || '',
                employees: r.employees, revenue: r.revenue || '',
                machinesCount: r.machines_count, productionArea: r.production_area,
                capabilities: JSON.parse(r.capabilities || '[]'),
                isoCertificates: JSON.parse(r.iso_certificates || '[]'),
                qualityCertificates: JSON.parse(r.quality_certificates || '[]'),
                specialization: r.specialization || '', city: r.city || '', companyRole: r.company_role,
            })));
        } catch (e) { next(e); }
    });
    
    router.post('/verification/:id/approve', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const { rows: [vr] } = await pool.query('SELECT * FROM verification_requests WHERE id = $1', [id]);
            if (!vr) return res.status(404).json({ error: 'Заявка не найдена' });
    
            const { rows: [companyRow] } = await pool.query('SELECT company FROM companies WHERE id = $1', [vr.company_id]);
            await withTransaction(async (client) => {
                await client.query("UPDATE verification_requests SET status='approved', reviewed_at=NOW() WHERE id=$1", [id]);
                await client.query("UPDATE companies SET verified_by_platform=true, status='Верифицирован' WHERE id=$1", [vr.company_id]);
            });
            if (companyRow) {
                await addNotification(companyRow.company, 'Ваша компания успешно верифицирована платформой!');
                const email = await getCompanyEmail(companyRow.company);
                if (email) await sendEmail(email, 'Верификация пройдена — ТехЗаказ',
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:#41bd97">Компания верифицирована!</h3>
                      <p>Ваша компания <strong>${companyRow.company}</strong> успешно прошла верификацию на платформе ТехЗаказ.</p>
                      <p>Теперь рядом с вашим профилем отображается знак верификации.</p>
                      <a href="${APP_URL}/company-profile.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Открыть профиль</a>
                    </div>`
                );
                // Push: верификация одобрена
                getUserIdsByCompany(companyRow.company).then(ids =>
                    ids.forEach(id => {
                        sendPush(id, 'Верификация одобрена ✓', 'Ваша компания верифицирована платформой ТехЗаказ', `${APP_URL}/settings`);
                        sendTelegramNotification(id, `✅ <b>Верификация одобрена!</b>\nВаша компания верифицирована платформой ТехЗаказ.`);
                    })
                ).catch(() => {});
            }
            res.json({ message: 'Компания верифицирована' });
        } catch (e) { next(e); }
    });
    
    router.post('/verification/:id/reject', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const comment = String(req.body.comment || '').slice(0, 500);
            const { rows: [vr] } = await pool.query('SELECT * FROM verification_requests WHERE id = $1', [id]);
            if (!vr) return res.status(404).json({ error: 'Заявка не найдена' });
    
            const { rows: [rejectCompany] } = await pool.query('SELECT company FROM companies WHERE id = $1', [vr.company_id]);
            await pool.query(
                "UPDATE verification_requests SET status='rejected', admin_comment=$1, reviewed_at=NOW() WHERE id=$2",
                [comment, id]
            );
            if (rejectCompany) {
                await addNotification(rejectCompany.company, `Заявка на верификацию отклонена.${comment ? ' Причина: ' + comment : ''}`);
                const email = await getCompanyEmail(rejectCompany.company);
                if (email) await sendEmail(email, 'Заявка на верификацию отклонена — ТехЗаказ',
                    `<div style="font-family:sans-serif;color:#1a2332;max-width:520px">
                      <h3 style="color:#e07070">Заявка на верификацию отклонена</h3>
                      <p>Заявка компании <strong>${rejectCompany.company}</strong> была рассмотрена и отклонена.</p>
                      ${comment ? `<p><strong>Причина:</strong> ${comment}</p>` : ''}
                      <p>Вы можете исправить недочёты и подать заявку повторно.</p>
                      <a href="${APP_URL}/settings.html" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Настройки профиля</a>
                    </div>`
                );
            }
            res.json({ message: 'Заявка отклонена' });
        } catch (e) { next(e); }
    });
    
    // ===================== ADMIN: USERS & STATS =====================
    
    router.get('/admin/stats', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const [
                { rows: [{ n: users }] },
                { rows: [{ n: pending }] },
                { rows: [{ n: orders }] },
                { rows: [{ n: companies }] },
            ] = await Promise.all([
                pool.query('SELECT COUNT(*) AS n FROM users'),
                pool.query("SELECT COUNT(*) AS n FROM verification_requests WHERE status='pending'"),
                pool.query('SELECT COUNT(*) AS n FROM orders'),
                pool.query('SELECT COUNT(*) AS n FROM companies'),
            ]);
            // Воронка приглашений заводам из госреестра
            const { rows: [reg] } = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE claimed = false)                          AS stubs,
                    COUNT(*) FILTER (WHERE claimed = false AND contact_email <> '') AS with_email,
                    COALESCE(SUM(invites_sent), 0)                                  AS invites_sent,
                    COUNT(*) FILTER (WHERE claimed = true)                          AS claimed,
                    COUNT(*) FILTER (WHERE invite_optout = true)                    AS optout
                FROM companies WHERE source = 'gisp-pp719'
            `);
            res.json({
                users, pending, orders, companies,
                registry: {
                    stubs: Number(reg.stubs),
                    withEmail: Number(reg.with_email),
                    invitesSent: Number(reg.invites_sent),
                    claimed: Number(reg.claimed),
                    optout: Number(reg.optout),
                },
            });
        } catch (e) { next(e); }
    });
    
    // Регистрации по дням за 30 дней (для графика в админке).
    // У старых пользователей created_at = дата миграции — история начинается с 03.07.2026.
    router.get('/admin/registrations', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS n
                FROM users
                WHERE created_at > NOW() - INTERVAL '30 days'
                GROUP BY day ORDER BY day
            `);
            res.json(rows.map(r => ({ day: r.day, n: Number(r.n) })));
        } catch (e) { next(e); }
    });
    
    router.get('/admin/users', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                'SELECT id, email, role, company, inn, email_verified, created_at FROM users ORDER BY id'
            );
            res.json(rows);
        } catch (e) { next(e); }
    });
    
    router.delete('/admin/users/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const { rows: [me] } = await pool.query('SELECT id FROM users WHERE id=$1', [req.user.id]);
            if (me && me.id === id) return res.status(400).json({ error: 'Нельзя удалить собственный аккаунт' });
            await pool.query('DELETE FROM users WHERE id=$1', [id]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    
    router.patch('/admin/users/:id/role', requireAuth, requireRole('admin'), async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const { role } = req.body;
            if (!['customer', 'producer', 'admin'].includes(role)) return res.status(400).json({ error: 'Неверная роль' });
            await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createAdminRouter;
