'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/* Роль `seo` заведена по ответу маркетинга 22.09 (пункт 5): очередь поискового
   спроса разбирает SEO-специалист, и ему нужен доступ. Отдавать ради этого
   полного администратора нельзя — под админом лежат заявки на верификацию,
   список пользователей и контакты предприятий, то есть персональные данные,
   которых у подрядчика по SEO быть не должно.
 
   Тест сторожит границу со стороны кода, а не запроса: он читает исходники и
   проверяет, что новая роль упомянута ровно там, где её разрешили. Любой
   следующий requireRole('admin', 'seo') в чужом файле придётся вносить сюда
   руками — и это как раз тот момент, когда стоит подумать, что именно
   открывается. */

const ROOT = path.join(__dirname, '..', '..');

/** Файлы, которым роль `seo` разрешена. */
const ALLOWED = new Set([
    'routes/catalog-admin.js',  // справочник и реестр посадочных
    'routes/search-demand.js',  // панель спроса
    'routes/admin.js',          // смена роли: сам список допустимых значений
    'server.js',                // определение requireRole
]);

function sourcesWithSeoRole() {
    const found = [];
    for (const dir of ['routes', 'lib']) {
        for (const name of fs.readdirSync(path.join(ROOT, dir))) {
            if (!name.endsWith('.js')) continue;
            const rel = `${dir}/${name}`;
            const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            if (/requireRole\([^)]*'seo'/.test(text)) found.push(rel);
        }
    }
    return found;
}

test('роль seo открыта только там, где разрешено', () => {
    for (const file of sourcesWithSeoRole()) {
        assert.ok(ALLOWED.has(file),
            `${file} пускает роль seo. Это персональные данные? Если нет — добавьте файл в ALLOWED осознанно.`);
    }
});

test('панель спроса и справочник её действительно пускают', () => {
    // Обратная проверка: если роль потеряется, доступ молча исчезнет, и
    // маркетинг об этом узнает не от нас.
    const files = sourcesWithSeoRole();
    assert.ok(files.includes('routes/search-demand.js'));
    assert.ok(files.includes('routes/catalog-admin.js'));
});

test('заявки на верификацию и пользователи остаются за администратором', () => {
    /* Прямая проверка самых чувствительных обработчиков: там персональные
       данные — ФИО, телефоны, почты, ИНН. */
    const adminRoutes = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
    for (const marker of ['/verification/requests', '/admin/users', '/admin/registrations']) {
        const line = adminRoutes.split('\n').find(l => l.includes(`'${marker}'`));
        assert.ok(line, `обработчик ${marker} не найден`);
        assert.match(line, /requireRole\('admin'\)/, `${marker} обязан требовать роль admin`);
    }
});

test('requireRole принимает несколько ролей и не пускает посторонних', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const impl = server.slice(server.indexOf('function requireRole('));
    assert.match(impl.slice(0, 400), /roles\.flat\(\)/,
        'несколько ролей должны разворачиваться в список');
    assert.match(impl.slice(0, 400), /!allowed\.includes\(req\.user\.role\)/,
        'проверка обязана быть по белому списку, а не по отрицанию одной роли');
});
