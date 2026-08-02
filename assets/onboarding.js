'use strict';

/**
 * Каркас мастеров онбординга — общий для /zayavka (заказчик) и /zavod (завод).
 *
 * Главное отличие от кабинета: человек здесь ещё без аккаунта. Поэтому черновик
 * живёт в sessionStorage (перезагрузка вкладки не должна стирать набранное), а
 * файл чертежа держится только в памяти вкладки — гостю на диск сервера мы
 * ничего не пишем, чтобы нечему было копиться и нечего абузить.
 */
(function () {
    const KEY = 'tz-onboarding-draft';

    function loadDraft() {
        try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; }
    }

    let draft = loadDraft();
    let current = 1;
    let total = 1;

    function saveDraft() {
        try { sessionStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* приватный режим — переживём */ }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function goal(name) {
        if (typeof window.ym === 'function' && window.__tzYmId) {
            window.ym(window.__tzYmId, 'reachGoal', name);
        }
    }

    function goStep(n) {
        current = Math.min(Math.max(1, n), total);
        document.querySelectorAll('[data-step]').forEach(el => {
            el.hidden = Number(el.dataset.step) !== current;
        });
        document.querySelectorAll('[data-progress-dot]').forEach(el => {
            const i = Number(el.dataset.progressDot);
            el.classList.toggle('is-done', i < current);
            el.classList.toggle('is-current', i === current);
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        goal('onboarding_step_' + current);
    }

    function setBusy(btn, busy, busyText) {
        if (!btn) return;
        if (busy) {
            btn.dataset.idleText = btn.textContent;
            btn.textContent = busyText || 'Секунду…';
            btn.disabled = true;
        } else {
            if (btn.dataset.idleText) btn.textContent = btn.dataset.idleText;
            btn.disabled = false;
        }
    }

    function showError(el, message) {
        if (!el) return;
        el.textContent = message || '';
        el.hidden = !message;
    }

    async function readJson(res) {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Не получилось. Попробуйте ещё раз.');
        return json;
    }

    window.TZWizard = {
        mount(totalSteps) {
            total = totalSteps;
            goStep(1);
        },
        getDraft() { return draft; },
        setDraft(patch) {
            draft = { ...draft, ...patch };
            saveDraft();
            return draft;
        },
        clearDraft() {
            draft = {};
            try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
        },
        goStep,
        step() { return current; },
        escapeHtml,
        goal,
        setBusy,
        showError,
        async post(path, body) {
            return readJson(await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }));
        },
        async postForm(path, formData) {
            return readJson(await fetch(path, { method: 'POST', body: formData, credentials: 'include' }));
        },
        async get(path) {
            return readJson(await fetch(path));
        },
    };
})();
