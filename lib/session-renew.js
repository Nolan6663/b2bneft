'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET, getRefreshToken, setAuthCookies } = require('./auth-tokens');

/* Продление сессии на стороне сервера.
 *
 * Access-кука живёт час, refresh — тридцать дней. Через час вкладка,
 * открытая утром, теряет access-куку совсем: apiFetch это переживает — ловит
 * 401 и обновляет токен сам. А прямые ссылки (чертёж, файл КП, договор,
 * выгрузки) идут мимо apiFetch: там некому поймать 401, и человек, который
 * час назад вошёл и никуда не выходил, получал отказ на ровном месте.
 *
 * Здесь тот же обмен, что делает POST /api/auth/refresh, только инициирует
 * его сервер. Ротации нет — refresh-токен остаётся прежним, поэтому соседние
 * вкладки и устройства это не задевает.
 *
 * Только GET и HEAD: cookie-авторизация и без того открыта для межсайтовых
 * переходов, но расширять это на запросы, которые что-то меняют, незачем.
 * POST с протухшим токеном по-прежнему получает 401 и повтор через apiFetch.
 */
async function renewAccessToken({ pool, req, res }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;

    const refreshToken = getRefreshToken(req);
    if (!refreshToken) return null;

    const { rows: [tokenRow] } = await pool.query(
        'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
        [refreshToken]
    );
    if (!tokenRow) return null;

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [tokenRow.user_id]);
    if (!user) return null;

    const accessToken = jwt.sign(
        { userId: user.id, role: user.role, company: user.company },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
    pool.query('UPDATE refresh_tokens SET last_used_at = NOW() WHERE id = $1', [tokenRow.id]).catch(() => {});
    // Вход без «запомнить меня» продлеваем такими же сессионными куками: иначе
    // продление молча сделало бы его постоянным на чужой машине.
    setAuthCookies(res, accessToken, refreshToken, { persistent: tokenRow.persistent !== false });
    return user;
}

module.exports = { renewAccessToken };
