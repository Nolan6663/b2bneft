'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const {
    JWT_SECRET,
    getRefreshToken,
    setAuthCookies,
    clearAuthCookies,
    generateTokens,
    hashPassword,
    verifyPassword,
} = require('../lib/auth-tokens');

module.exports = function createAuthRouter(deps) {
    const {
        pool,
        crypto,
        speakeasy,
        QRCode,
        requireAuth,
        withTransaction,
        sendEmail,
        sendPush,
        sendTelegramNotification,
        getUserIdsByCompany,
        sendVerificationEmail,
        APP_URL,
    } = deps;

    const router = express.Router();

    const YANDEX_CLIENT_ID     = process.env.YANDEX_CLIENT_ID     || '';
    const YANDEX_CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET || '';

    function clientIp(req) {
        return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    }

    async function storeRefreshToken(req, userId, refreshToken) {
        await pool.query(
            `INSERT INTO refresh_tokens (user_id, token, expires_at, user_agent, ip, last_used_at)
             VALUES ($1, $2, NOW() + INTERVAL '30 days', $3, $4, NOW())`,
            [userId, refreshToken, String(req.headers['user-agent'] || '').slice(0, 500), clientIp(req)]
        );
    }

    /* «Windows — Chrome» из user-agent; без внешних библиотек */
    function describeUserAgent(ua) {
        const s = String(ua || '');
        let os = 'Устройство';
        if (/Windows/i.test(s)) os = 'Windows';
        else if (/iPhone/i.test(s)) os = 'iPhone';
        else if (/iPad/i.test(s)) os = 'iPad';
        else if (/Android/i.test(s)) os = 'Android';
        else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
        else if (/Linux/i.test(s)) os = 'Linux';
        let browser = 'Браузер';
        if (/Edg\//i.test(s)) browser = 'Edge';
        else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
        else if (/YaBrowser/i.test(s)) browser = 'Яндекс Браузер';
        else if (/Firefox\//i.test(s)) browser = 'Firefox';
        else if (/Chrome\//i.test(s)) browser = 'Chrome';
        else if (/Safari\//i.test(s)) browser = 'Safari';
        const mobile = /iPhone|iPad|Android|Mobile/i.test(s);
        return { label: `${os} — ${browser}`, mobile };
    }

    router.post('/register', async (req, res, next) => {
        try {
            const { email, password, company, inn, role } = req.body;
            if (!email || !password || !company || !role) return res.status(400).json({ error: 'Заполните все поля регистрации' });
            const ALLOWED_ROLES = ['customer', 'producer'];
            if (!ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
            if (password.length < 8) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });

            const { rows: [taken] } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
            if (taken) return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });

            let inviteData = null;
            if (req.body.inviteToken) {
                const { rows: [inv] } = await pool.query(
                    "SELECT * FROM invitations WHERE token=$1 AND LOWER(email)=LOWER($2) AND accepted=false AND expires_at>NOW()",
                    [req.body.inviteToken, email]
                );
                if (!inv) return res.status(400).json({ error: 'Приглашение недействительно или истекло' });
                inviteData = inv;
            }

            const resolvedCompany = inviteData ? inviteData.company : company;
            const resolvedRole    = inviteData ? inviteData.role    : role;
            const resolvedTeamRole = inviteData ? (inviteData.team_role || 'member') : 'admin';

            if (!inviteData) {
                // claimed=false — стаб из реестра без пользователей; не блокирует регистрацию
                // (внутри транзакции ниже такой стаб «усыновляется» по ИНН, а не блокируется)
                const { rows: [existingCompany] } = await pool.query(
                    'SELECT 1 FROM companies WHERE company = $1 AND role = $2 AND claimed = true LIMIT 1',
                    [resolvedCompany, resolvedRole]
                );
                if (existingCompany) {
                    return res.status(409).json({
                        error: 'Компания с таким названием уже зарегистрирована. Попросите администратора пригласить вас по email или укажите другое название.',
                    });
                }
            }

            const newUser = await withTransaction(async (client) => {
                const normInn = String(inn || '').replace(/\D/g, '');
                const { rows: [u] } = await client.query(
                    'INSERT INTO users (email,password,role,company,inn,team_role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
                    [email, hashPassword(password), resolvedRole, resolvedCompany, normInn.length === 10 || normInn.length === 12 ? normInn : (inn || ''), resolvedTeamRole]
                );
                const { rows: [compExists] } = await client.query('SELECT 1 FROM companies WHERE company = $1 AND role = $2 AND claimed = true', [resolvedCompany, resolvedRole]);
                if (!compExists) {
                    // Присоединение профиля из реестра: ИНН совпал со стабом → «усыновляем»
                    // (у стаба нет пользователей/заявок, переименование безопасно)
                    let adopted = null;
                    if (resolvedRole === 'producer' && (normInn.length === 10 || normInn.length === 12)) {
                        const { rows: [stub] } = await client.query(
                            "SELECT id FROM companies WHERE inn = $1 AND role = 'producer' AND claimed = false LIMIT 1 FOR UPDATE", [normInn]
                        );
                        if (stub) {
                            await client.query(
                                "UPDATE companies SET company = $1, claimed = true, status = 'На проверке' WHERE id = $2",
                                [resolvedCompany, stub.id]
                            );
                            adopted = stub.id;
                        }
                    }
                    if (!adopted) {
                        await client.query(
                            "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,$2,$3,$4,$5)",
                            [resolvedCompany, normInn.length === 10 || normInn.length === 12 ? normInn : (inn || ''), resolvedRole, '', 'На проверке']
                        );
                    }
                }
                if (inviteData) {
                    await client.query('UPDATE invitations SET accepted=true WHERE id=$1', [inviteData.id]);
                }
                return u;
            });

            const { accessToken, refreshToken } = generateTokens(newUser);
            await storeRefreshToken(req, newUser.id, refreshToken);
            await sendVerificationEmail(newUser);
            if (inviteData) {
                getUserIdsByCompany(inviteData.company).then(ids =>
                    ids.forEach(id => {
                        sendPush(id, 'Новый участник команды', `${newUser.email} присоединился к вашей компании`, `${APP_URL}/settings`);
                        sendTelegramNotification(id, `👤 <b>Новый участник команды</b>\n${newUser.email} присоединился к вашей компании.`);
                    })
                ).catch(() => {});
            }
            setAuthCookies(res, accessToken, refreshToken);
            res.status(201).json({
                token: accessToken,
                refreshToken,
                role: resolvedRole,
                company: resolvedCompany,
                emailVerified: false,
                message: 'Аккаунт создан. Подтвердите email — письмо отправлено на вашу почту.',
            });
        } catch (e) { next(e); }
    });

    router.post('/login', async (req, res, next) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' });

            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
            if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Неверный email или пароль' });

            if (!user.password.includes(':')) {
                await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(password), user.id]);
            }

            if (user.totp_enabled) {
                const { totpCode } = req.body;
                if (!totpCode) return res.status(200).json({ require2fa: true });
                const valid = speakeasy.totp.verify({
                    secret:   user.totp_secret,
                    encoding: 'base32',
                    token:    String(totpCode).replace(/\s/g, ''),
                    window:   1,
                });
                if (!valid) return res.status(401).json({ error: 'Неверный код 2FA' });
            }

            const { accessToken, refreshToken } = generateTokens(user);
            await storeRefreshToken(req, user.id, refreshToken);
            setAuthCookies(res, accessToken, refreshToken);
            res.json({
                token: accessToken,
                refreshToken,
                role: user.role,
                company: user.company,
                emailVerified: Boolean(user.email_verified),
                totpEnabled:   Boolean(user.totp_enabled),
            });
        } catch (e) { next(e); }
    });

    router.post('/2fa/setup', requireAuth, async (req, res, next) => {
        try {
            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
            if (user.totp_enabled) return res.status(400).json({ error: '2FA уже включена' });

            const secret = speakeasy.generateSecret({ name: `ТЕХЗАКАЗ (${user.email})`, issuer: 'ТЕХЗАКАЗ', length: 20 });
            await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret.base32, user.id]);

            const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
            res.json({ qr: qrDataUrl, secret: secret.base32 });
        } catch (e) { next(e); }
    });

    router.post('/2fa/confirm', requireAuth, async (req, res, next) => {
        try {
            const { code } = req.body;
            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
            if (!user.totp_secret) return res.status(400).json({ error: 'Сначала выполните /api/auth/2fa/setup' });
            if (user.totp_enabled) return res.status(400).json({ error: '2FA уже включена' });

            const valid = speakeasy.totp.verify({
                secret:   user.totp_secret,
                encoding: 'base32',
                token:    String(code).replace(/\s/g, ''),
                window:   1,
            });
            if (!valid) return res.status(400).json({ error: 'Неверный код — попробуйте ещё раз' });

            await pool.query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user.id]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });

    router.post('/2fa/disable', requireAuth, async (req, res, next) => {
        try {
            const { code } = req.body;
            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
            if (!user.totp_enabled) return res.status(400).json({ error: '2FA не включена' });

            const valid = speakeasy.totp.verify({
                secret:   user.totp_secret,
                encoding: 'base32',
                token:    String(code).replace(/\s/g, ''),
                window:   1,
            });
            if (!valid) return res.status(400).json({ error: 'Неверный код' });

            await pool.query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [req.user.id]);
            res.json({ ok: true });
        } catch (e) { next(e); }
    });

    router.get('/yandex', (req, res) => {
        if (!YANDEX_CLIENT_ID) return res.status(503).json({ error: 'Яндекс OAuth не настроен' });
        const redirectUri = process.env.YANDEX_REDIRECT_URI || `${APP_URL}/api/auth/yandex/callback`;
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: YANDEX_CLIENT_ID,
            redirect_uri: redirectUri,
            force_confirm: 'yes',
        });
        res.redirect(`https://oauth.yandex.ru/authorize?${params}`);
    });

    router.get('/yandex/callback', async (req, res) => {
        const { code, error } = req.query;
        if (error || !code) return res.redirect('/login.html?error=oauth_denied');
        if (!YANDEX_CLIENT_ID) return res.redirect('/login.html?error=oauth_not_configured');

        try {
            const redirectUri = process.env.YANDEX_REDIRECT_URI || `${APP_URL}/api/auth/yandex/callback`;

            const tokenRes = await fetch('https://oauth.yandex.ru/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    client_id: YANDEX_CLIENT_ID,
                    client_secret: YANDEX_CLIENT_SECRET,
                    redirect_uri: redirectUri,
                }),
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) {
                console.error('Yandex token error:', tokenData);
                return res.redirect('/login.html?error=oauth_token');
            }

            const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
                headers: { Authorization: `OAuth ${tokenData.access_token}` },
            });
            const info = await infoRes.json();

            const email = info.default_email || (info.emails && info.emails[0]);
            if (!email) return res.redirect('/login.html?error=oauth_no_email');

            let { rows: [user] } = await pool.query(
                'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]
            );
            if (!user) {
                const company = info.real_name || info.display_name || info.login || email.split('@')[0];
                await withTransaction(async (client) => {
                    const { rows: [u] } = await client.query(
                        "INSERT INTO users (email, password, role, company, inn) VALUES ($1,$2,'customer',$3,'') RETURNING *",
                        [email, hashPassword(crypto.randomBytes(32).toString('hex')), company]
                    );
                    const { rows: [exists] } = await client.query(
                        'SELECT 1 FROM companies WHERE company=$1 AND role=$2', [company, 'customer']
                    );
                    if (!exists) {
                        await client.query(
                            "INSERT INTO companies (company,inn,role,specialization,status) VALUES ($1,'','customer','','На проверке')",
                            [company]
                        );
                    }
                    user = u;
                });
            }

            const { accessToken, refreshToken } = generateTokens(user);
            await storeRefreshToken(req, user.id, refreshToken);
            setAuthCookies(res, accessToken, refreshToken);

            const ev = user.email_verified ? '1' : '0';
            res.redirect(`/login.html?oauth_ok=1&role=${encodeURIComponent(user.role)}&company=${encodeURIComponent(user.company)}&ev=${ev}`);
        } catch (e) {
            console.error('Yandex OAuth callback error:', e);
            res.redirect('/login.html?error=oauth_error');
        }
    });

    router.post('/forgot-password', async (req, res, next) => {
        try {
            const { email } = req.body;
            if (!email) return res.status(400).json({ error: 'Укажите email' });
            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
            if (user) {
                await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
                const token = crypto.randomBytes(32).toString('hex');
                await pool.query(
                    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
                    [user.id, token]
                );
                const link = `${APP_URL}/login.html?reset=${token}`;
                await sendEmail(user.email, 'Восстановление пароля — ТехЗаказ', `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a2332">
                  <h2 style="color:#41bd97">Восстановление пароля</h2>
                  <p>Поступил запрос на сброс пароля для аккаунта <strong>${user.email}</strong>.</p>
                  <p>Нажмите кнопку ниже, чтобы задать новый пароль. Ссылка действительна <strong>1 час</strong>.</p>
                  <a href="${link}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#41bd97;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Сбросить пароль</a>
                  <p style="font-size:12px;color:#666">Если вы не запрашивали сброс — просто проигнорируйте это письмо.</p>
                </div>`
                );
            }
            res.json({ message: 'ok' });
        } catch (e) { next(e); }
    });

    router.post('/reset-password', async (req, res, next) => {
        try {
            const { token, newPassword } = req.body;
            if (!token || !newPassword) return res.status(400).json({ error: 'Неверный запрос' });
            if (newPassword.length < 8) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });
            const { rows: [row] } = await pool.query(
                'SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()',
                [token]
            );
            if (!row) return res.status(400).json({ error: 'Ссылка недействительна или истекла. Запросите новую.' });
            await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(newPassword), row.user_id]);
            await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);
            await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [row.user_id]);
            res.json({ message: 'Пароль успешно изменён' });
        } catch (e) { next(e); }
    });

    router.post('/refresh', async (req, res, next) => {
        try {
            const refreshToken = getRefreshToken(req);
            if (!refreshToken) return res.status(401).json({ error: 'Refresh token не указан' });
            const { rows: [tokenRow] } = await pool.query(
                'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
                [refreshToken]
            );
            if (!tokenRow) return res.status(401).json({ error: 'Недействительный или истёкший refresh token' });
            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [tokenRow.user_id]);
            if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
            const payload = { userId: user.id, role: user.role, company: user.company };
            const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
            pool.query('UPDATE refresh_tokens SET last_used_at = NOW() WHERE id = $1', [tokenRow.id]).catch(() => {});
            setAuthCookies(res, accessToken, refreshToken);
            res.json({ token: accessToken, emailVerified: Boolean(user.email_verified) });
        } catch (e) { next(e); }
    });

    /* ── Активные сессии (refresh-токены) ─────────────────────────────── */

    router.get('/sessions', requireAuth, async (req, res, next) => {
        try {
            const current = getRefreshToken(req);
            const { rows } = await pool.query(
                `SELECT id, token, user_agent, ip, created_at, last_used_at
                 FROM refresh_tokens
                 WHERE user_id = $1 AND expires_at > NOW()
                 ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
                [req.user.id]
            );
            res.json(rows.map(r => {
                const d = describeUserAgent(r.user_agent);
                return {
                    id: r.id,
                    label: d.label,
                    mobile: d.mobile,
                    ip: r.ip,
                    createdAt: r.created_at,
                    lastUsedAt: r.last_used_at,
                    current: Boolean(current && r.token === current),
                };
            }));
        } catch (e) { next(e); }
    });

    router.delete('/sessions/:id', requireAuth, async (req, res, next) => {
        try {
            const current = getRefreshToken(req);
            const { rows: [row] } = await pool.query(
                'SELECT id, token FROM refresh_tokens WHERE id = $1 AND user_id = $2',
                [Number(req.params.id), req.user.id]
            );
            if (!row) return res.status(404).json({ error: 'Сессия не найдена' });
            if (current && row.token === current) {
                return res.status(400).json({ error: 'Это текущая сессия — используйте «Выйти из аккаунта»' });
            }
            await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [row.id]);
            res.json({ message: 'Сессия завершена' });
        } catch (e) { next(e); }
    });

    router.post('/sessions/revoke-others', requireAuth, async (req, res, next) => {
        try {
            const current = getRefreshToken(req);
            const { rowCount } = current
                ? await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1 AND token <> $2', [req.user.id, current])
                : await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);
            res.json({ message: 'Готово', revoked: rowCount });
        } catch (e) { next(e); }
    });

    router.post('/logout', async (req, res, next) => {
        try {
            const refreshToken = getRefreshToken(req);
            if (refreshToken) {
                await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
            }
            clearAuthCookies(res);
            res.json({ message: 'Выход выполнен' });
        } catch (e) { next(e); }
    });

    router.get('/me', requireAuth, async (req, res, next) => {
        try {
            const [{ rows: [user] }, { rows: [comp] }] = await Promise.all([
                pool.query('SELECT totp_enabled, digest_frequency, id FROM users WHERE id = $1', [req.user.id]),
                pool.query('SELECT id FROM companies WHERE company = $1 AND role = $2 LIMIT 1', [req.user.company, req.user.role]),
            ]);
            res.json({
                id:               user?.id,
                email:            req.user.email,
                role:             req.user.role,
                company:          req.user.company,
                companyId:        comp?.id || null,
                emailVerified:    Boolean(req.user.email_verified),
                totpEnabled:      Boolean(user?.totp_enabled),
                digest_frequency: user?.digest_frequency || 'daily',
            });
        } catch (e) { next(e); }
    });

    router.post('/verify-email', async (req, res, next) => {
        try {
            const token = String(req.body?.token || req.query?.token || '').trim();
            if (!token) return res.status(400).json({ error: 'Токен не указан' });
            const { rows: [row] } = await pool.query(
                'SELECT * FROM email_verification_tokens WHERE token = $1 AND expires_at > NOW()',
                [token]
            );
            if (!row) return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
            await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [row.user_id]);
            await pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [row.user_id]);
            res.json({ message: 'Email успешно подтверждён' });
        } catch (e) { next(e); }
    });

    router.post('/resend-verification', requireAuth, async (req, res, next) => {
        try {
            if (req.user.email_verified) return res.json({ message: 'Email уже подтверждён' });
            await sendVerificationEmail(req.user);
            res.json({ message: 'Письмо с подтверждением отправлено повторно' });
        } catch (e) { next(e); }
    });

    router.put('/password', requireAuth, async (req, res, next) => {
        try {
            const { currentPassword, newPassword } = req.body;
            if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });
            if (newPassword.length < 8) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });

            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
            if (!verifyPassword(currentPassword, user.password)) return res.status(400).json({ error: 'Неверный текущий пароль' });

            await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(newPassword), req.user.id]);
            res.json({ message: 'Пароль успешно изменён' });
        } catch (e) { next(e); }
    });

    router.put('/email', requireAuth, async (req, res, next) => {
        try {
            const { newEmail, password } = req.body;
            if (!newEmail || !password) return res.status(400).json({ error: 'Заполните все поля' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'Некорректный формат email' });

            const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
            if (!verifyPassword(password, user.password)) return res.status(400).json({ error: 'Неверный пароль' });

            const { rows: [taken] } = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [newEmail, req.user.id]);
            if (taken) return res.status(400).json({ error: 'Этот email уже используется' });

            await pool.query('UPDATE users SET email = $1, email_verified = false WHERE id = $2', [newEmail, req.user.id]);
            const { rows: [updated] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
            await sendVerificationEmail(updated);
            res.json({ message: 'Email изменён. Подтвердите новый адрес — письмо отправлено.' });
        } catch (e) { next(e); }
    });

    return router;
};
