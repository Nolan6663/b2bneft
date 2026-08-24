'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/* .env.example — единственное место, где написано, что вообще нужно проекту для
   работы. Расходится он молча: переменную добавляют в код, на VPS её дописывают
   руками, и всё работает — пока кто-то не поднимает окружение с нуля или не
   ищет, куда положить ключ. Именно на этом 24.08.2026 я отправил владельца
   настраивать переменную не в то место.

   Поэтому список сверяется автоматически: всё, что код читает из окружения,
   обязано быть либо в примере, либо в исключениях ниже — с причиной. */

const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'uploads', 'test-results', '.shots', '.vs', '.superpowers', 'outreach-preview']);

/** Переменные, которых в примере быть не должно, и почему. */
const NOT_IN_EXAMPLE = {
    // Задаётся в ecosystem.config.js: Node читает NODE_ENV при старте процесса,
    // и правка .env его не меняет. См. README, раздел про деплой.
    NODE_ENV: 'живёт в ecosystem.config.js',
    // Читается только тестом разбора чертежа — он чистит окружение перед
    // проверкой. Ни один рабочий модуль эту переменную не использует.
    GIGACHAT_API_KEY: 'вестигиальная, осталась только в тесте',
};

function collectEnvKeys(dir, found = new Set()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectEnvKeys(full, found);
        else if (/\.(js|mjs)$/.test(entry.name)) {
            const src = fs.readFileSync(full, 'utf8');
            for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]);
        }
    }
    return found;
}

test('всё, что код читает из окружения, описано в .env.example', () => {
    const used = [...collectEnvKeys(ROOT)].sort();
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const declared = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]));

    const missing = used.filter(k => !declared.has(k) && !NOT_IN_EXAMPLE[k]);
    assert.deepEqual(missing, [], `не описаны в .env.example: ${missing.join(', ')}`);
});

test('исключения из сверки не протухли', () => {
    // Если переменную из списка исключений всё же добавили в пример — исключение
    // нужно убрать, иначе список превращается в свалку «потом разберёмся».
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const declared = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]));
    for (const key of Object.keys(NOT_IN_EXAMPLE)) {
        assert.ok(!declared.has(key), `${key} есть и в примере, и в исключениях — уберите из исключений`);
    }
});

test('репозиторий не описывает деплой, которого нет', () => {
    /* render.yaml пролежал в корне с июня и описывал выкладку на Render, хотя
       прод — VPS с pm2, а деплой делает .github/workflows/deploy.yml. Файл
       никто не использовал, но он врал: по нему я отправил владельца добавлять
       ключ в панель Render, которой у нас нет. */
    assert.ok(!fs.existsSync(path.join(ROOT, 'render.yaml')), 'render.yaml вернулся — прод на VPS, см. README');
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
    assert.match(workflow, /pm2 restart neft/, 'описание деплоя разошлось с реальностью');
});
