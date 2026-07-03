'use strict';

const express = require('express');
const crypto = require('crypto');

function createTeamRouter(deps) {
    const {
        pool,
        requireAuth,
        sendEmail,
    } = deps;

    const router = express.Router();

    // ===================== КОМАНДА / ПРИГЛАШЕНИЯ =====================
    
    router.get('/team/members', requireAuth, async (req, res, next) => {
        try {
            const { rows: members } = await pool.query(
                'SELECT id, email, team_role, created_at FROM users WHERE company=$1 ORDER BY created_at',
                [req.user.company]
            );
            const { rows: pending } = await pool.query(
                "SELECT id, email, team_role, created_at FROM invitations WHERE company=$1 AND accepted=false AND expires_at>NOW() ORDER BY created_at DESC",
                [req.user.company]
            );
            res.json({ members, pending });
        } catch (e) { next(e); }
    });
    
    router.post('/team/invite', requireAuth, async (req, res, next) => {
        try {
            const { email, teamRole = 'member' } = req.body;
            if (!email) return res.status(400).json({ error: 'Укажите email' });
            if (!['admin','member','viewer'].includes(teamRole)) return res.status(400).json({ error: 'Недопустимая роль' });
    
            const { rows: [existing] } = await pool.query('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)', [email]);
            if (existing) return res.status(409).json({ error: 'Этот email уже зарегистрирован на платформе' });
    
            const token = crypto.randomBytes(24).toString('hex');
            await pool.query(
                `INSERT INTO invitations (token,email,company,role,team_role,invited_by)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (token) DO NOTHING`,
                [token, email.toLowerCase(), req.user.company, req.user.role, teamRole, req.user.email]
            );
    
            const appUrl = process.env.APP_URL || 'https://texzakaz.ru';
            const inviteUrl = `${appUrl}/login.html?invite=${token}`;
            const roleLabels = { admin:'Администратор', member:'Менеджер', viewer:'Наблюдатель' };
            await sendEmail(email, `Приглашение в команду — ТехЗаказ`, `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
                    <h2 style="color:#1E3A5F;margin:0 0 12px;">Вас пригласили в команду</h2>
                    <p style="color:#444;margin:0 0 8px;">Пользователь <strong>${req.user.email}</strong> приглашает вас присоединиться к компании</p>
                    <p style="font-size:18px;font-weight:700;color:#1E3A5F;margin:0 0 16px;">${req.user.company}</p>
                    <p style="color:#666;margin:0 0 20px;">Роль в команде: <strong>${roleLabels[teamRole] || teamRole}</strong></p>
                    <a href="${inviteUrl}" style="display:inline-block;background:#FF6A00;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Принять приглашение →</a>
                    <p style="color:#aaa;font-size:12px;margin-top:20px;">Ссылка действительна 7 дней. Если вы не ожидали этого письма — проигнорируйте его.</p>
                </div>`);
    
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    
    router.delete('/team/members/:id', requireAuth, async (req, res, next) => {
        try {
            const targetId = Number(req.params.id);
            if (targetId === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
            const { rows: [target] } = await pool.query('SELECT company FROM users WHERE id=$1', [targetId]);
            if (!target || target.company !== req.user.company) return res.status(404).json({ error: 'Пользователь не найден' });
            await pool.query('DELETE FROM users WHERE id=$1', [targetId]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    
    router.delete('/team/invites/:id', requireAuth, async (req, res, next) => {
        try {
            await pool.query('DELETE FROM invitations WHERE id=$1 AND company=$2', [req.params.id, req.user.company]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    
    // Public — called before login to prefill registration form
    router.get('/invitations/:token', async (req, res, next) => {
        try {
            const { rows: [inv] } = await pool.query(
                "SELECT email, company, role, team_role FROM invitations WHERE token=$1 AND accepted=false AND expires_at>NOW()",
                [req.params.token]
            );
            if (!inv) return res.status(404).json({ error: 'Приглашение недействительно или истекло' });
            res.json(inv);
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createTeamRouter;
