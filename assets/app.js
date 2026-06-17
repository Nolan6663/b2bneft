/* =====================================================================
   B2B НЕФТЕСЕРВИС — общие JS-утилиты (тема, уведомления, чат, select, auth)
   Подключается на каждой странице ДО page-specific <script>:
   <script src="assets/app.js"></script>
   ===================================================================== */

const SERVER_URL = 'http://localhost:5000/api';

/* ---------------------------------------------------------------------
   Светлая / тёмная тема
   --------------------------------------------------------------------- */
// Класс .light-mode уже может быть выставлен инлайн-скриптом в <head>
// (до загрузки CSS, чтобы избежать мигания) — здесь только переключение и UI.
function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  syncThemeUI(isLight);
}

function syncThemeUI(isLight) {
  const checkbox = document.getElementById('themeCheckbox');
  if (checkbox) checkbox.checked = isLight;
  const label = document.getElementById('themeLabel');
  if (label) label.innerText = isLight ? '☀️ Светлая тема' : '🌙 Тёмная тема';
  const icon = document.getElementById('themeIcon');
  if (icon) icon.innerText = isLight ? '☀️' : '🌙';
}

document.addEventListener('DOMContentLoaded', () => {
  syncThemeUI(document.documentElement.classList.contains('light-mode'));
});

/* ---------------------------------------------------------------------
   Универсальное закрытие модалок: клик по фону или Escape
   --------------------------------------------------------------------- */
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal')) {
    e.target.style.display = 'none';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach(m => {
      if (getComputedStyle(m).display !== 'none') m.style.display = 'none';
    });
  }
});

/* ---------------------------------------------------------------------
   Auth guard / logout
   --------------------------------------------------------------------- */
// Вызвать на защищённых страницах: const session = authGuard('producer');
// requiredRole === null -> просто вернуть текущую сессию без редиректа.
function authGuard(requiredRole) {
  const token = localStorage.getItem('authToken');
  const role = localStorage.getItem('userRole');
  const company = localStorage.getItem('userCompany');
  if (requiredRole && token && role !== requiredRole) {
    window.location.href = 'login.html';
    return null;
  }
  return { token, role, company, isGuest: !token };
}

function logout() {
  localStorage.clear();
  window.location.href = 'login.html';
}

/* ---------------------------------------------------------------------
   Custom select dropdown
   --------------------------------------------------------------------- */
function initCustomSelect(wrapperId, hiddenInputId, callback) {
  const wrapper = document.getElementById(wrapperId);
  const hiddenInput = document.getElementById(hiddenInputId);
  if (!wrapper || !hiddenInput) return;
  const trigger = wrapper.querySelector('.custom-select-trigger');
  const options = wrapper.querySelectorAll('.custom-option');

  trigger.addEventListener('click', (e) => { e.stopPropagation(); wrapper.classList.toggle('open'); });

  options.forEach(option => {
    option.addEventListener('click', function () {
      options.forEach(opt => opt.classList.remove('selected'));
      this.classList.add('selected');
      hiddenInput.value = this.getAttribute('data-value');
      const span = trigger.querySelector('span');
      if (span) span.textContent = this.textContent;
      wrapper.classList.remove('open');
      if (callback) callback(hiddenInput.value);
    });
  });
}

document.addEventListener('click', () => {
  document.querySelectorAll('.custom-select').forEach(el => el.classList.remove('open'));
});

/* ---------------------------------------------------------------------
   Mock-скачивание файла (вложения, экспорт реестра)
   --------------------------------------------------------------------- */
function downloadMockFile(filename, content) {
  const blob = new Blob([content || ('Файл: ' + filename)], { type: 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/* CSV-экспорт: принимает имя файла, массив заголовков и массив строк (массивов значений) */
function exportToCSV(filename, headers, rows) {
  const BOM = '﻿';
  const escape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [headers, ...rows].map(row => row.map(escape).join(';')).join('\n');
  const blob = new Blob([BOM + lines], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/* ---------------------------------------------------------------------
   Защита от XSS при вставке пользовательского текста в innerHTML
   --------------------------------------------------------------------- */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str == null ? '' : String(str);
  return div.innerHTML;
}

/* ---------------------------------------------------------------------
   Форматирование дедлайна — поддерживает оба формата хранения:
   старый DD.MM.YYYY и новый YYYY-MM-DD (ISO date input)
   --------------------------------------------------------------------- */
function formatDeadline(str) {
  if (!str) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-');
    return `${d}.${m}.${y}`;
  }
  return str;
}

/* Конвертирует DD.MM.YYYY или YYYY-MM-DD в значение для <input type="date"> */
function deadlineToInputValue(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parts = str.split('.');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return '';
}

/* ---------------------------------------------------------------------
   Toast-уведомления (всплывающие карточки в углу экрана)
   --------------------------------------------------------------------- */
function showToast(text) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<div class="toast-icon">🔔</div><div class="toast-text">${escapeHtml(text)}</div><button class="toast-close" aria-label="Закрыть">✕</button>`;
  const dismiss = () => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 220);
  };
  toast.querySelector('.toast-close').onclick = dismiss;
  container.appendChild(toast);
  setTimeout(dismiss, 6000);
}

/* ---------------------------------------------------------------------
   Живые обновления через Socket.IO — чат и уведомления приходят мгновенно,
   без ожидания следующего тика поллинга. Поллинг ниже остаётся как
   подстраховка (если соединение оборвалось/не успело переподключиться).
   --------------------------------------------------------------------- */
const currentCompanyName = localStorage.getItem('userCompany') || 'Гость';
let socket = null;

if (typeof io === 'function') {
  try {
    socket = io(SERVER_URL.replace(/\/api$/, ''), { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      if (currentCompanyName !== 'Гость') socket.emit('join-company', currentCompanyName);
      if (activeChatOrderId != null) socket.emit('join-chat', { orderId: activeChatOrderId, company: activeChatCompany });
    });

    socket.on('notification', (entry) => {
      if (entry.company !== currentCompanyName) return;
      showToast(entry.text);
      refreshNotificationBadge();
    });

    socket.on('message', (msg) => {
      if (activeChatOrderId != null && msg.orderId === activeChatOrderId && msg.company === activeChatCompany) {
        renderChatHistory();
      }
    });
  } catch (error) {
    console.warn('Socket.IO недоступен, работаем по поллингу:', error);
  }
}

/* ---------------------------------------------------------------------
   Центр уведомлений — дропдаун под колокольчиком
   --------------------------------------------------------------------- */
let notifPollInterval = null;
let notifDropdown = null;

function initNotifications() {
  if (currentCompanyName === 'Гость') return;
  refreshNotificationBadge();
  if (notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(refreshNotificationBadge, 25000);
}

async function refreshNotificationBadge() {
  const badgeEl = document.getElementById('bellBadge');
  if (!badgeEl) return;
  try {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    const response = await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const list = await response.json();
    const unreadCount = list.filter(n => !n.read).length;
    badgeEl.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    if (unreadCount > 0) badgeEl.innerText = unreadCount;
  } catch { /* тихо */ }
}

function _getOrCreateDropdown() {
  if (notifDropdown) return notifDropdown;
  notifDropdown = document.createElement('div');
  notifDropdown.className = 'notif-dropdown';
  notifDropdown.innerHTML = `
    <div class="notif-dropdown-header">
      <span class="notif-dropdown-title">Уведомления</span>
      <button class="notif-clear-btn" onclick="clearNotifications()">Очистить всё</button>
    </div>
    <div class="notif-list" id="notifList"></div>`;
  document.body.appendChild(notifDropdown);
  return notifDropdown;
}

function _positionDropdown(dropdown) {
  const btn = document.querySelector('.bell-btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  dropdown.style.top   = (rect.bottom + 8) + 'px';
  dropdown.style.right = (window.innerWidth - rect.right) + 'px';
}

async function openNotificationsModal() {
  const dropdown = _getOrCreateDropdown();

  if (dropdown.classList.contains('open')) {
    dropdown.classList.remove('open');
    return;
  }

  _positionDropdown(dropdown);
  dropdown.classList.add('open');

  const listEl = document.getElementById('notifList');
  listEl.innerHTML = '<div class="notif-empty">Загрузка...</div>';

  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const response = await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, { headers });
    const items = await response.json();

    if (items.length === 0) {
      listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-icon">🔔</div>Уведомлений пока нет</div>';
      return;
    }

    listEl.innerHTML = '';
    items.forEach(n => {
      const el = document.createElement('div');
      el.className = 'notif-item' + (n.read ? '' : ' unread');
      const time = new Date(n.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
        <div class="notif-dot"></div>
        <div>
          <div class="notif-item-text">${escapeHtml(n.text)}</div>
          <div class="notif-item-time">${time}</div>
        </div>`;
      listEl.appendChild(el);
    });

    await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}/read`, { method: 'POST', headers });
    refreshNotificationBadge();
  } catch {
    listEl.innerHTML = '<div class="notif-empty">Не удалось загрузить уведомления</div>';
  }
}

function closeNotificationsModal() {
  if (notifDropdown) notifDropdown.classList.remove('open');
}

async function clearNotifications() {
  try {
    const token = localStorage.getItem('authToken');
    await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, {
      method: 'DELETE',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
  } catch { /* ignore */ }
  if (notifDropdown) notifDropdown.classList.remove('open');
  openNotificationsModal();
}

document.addEventListener('click', (e) => {
  if (!notifDropdown || !notifDropdown.classList.contains('open')) return;
  const btn = document.querySelector('.bell-btn');
  if (btn && btn.contains(e.target)) return;
  if (!notifDropdown.contains(e.target)) notifDropdown.classList.remove('open');
});

/* ---------------------------------------------------------------------
   Чат по закупке — сообщения хранятся на сервере (тред = orderId + company
   производителя), обновляется поллингом, пока модалка открыта.
   --------------------------------------------------------------------- */
let activeChatOrderId = null;
let activeChatCompany = null;
let chatPollInterval = null;

function openGlobalChat(orderId, orderTitle, company) {
  activeChatOrderId = orderId;
  activeChatCompany = company;
  const titleEl = document.getElementById('chatModalTitle');
  if (titleEl) titleEl.innerText = `Чат по закупке: ${orderTitle}`;
  const modal = document.getElementById('chatModal');
  if (modal) modal.style.display = 'flex';
  if (socket) socket.emit('join-chat', { orderId, company });
  renderChatHistory();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(renderChatHistory, 15000);
}

function closeChatModal() {
  const modal = document.getElementById('chatModal');
  if (modal) modal.style.display = 'none';
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
}

async function renderChatHistory() {
  const container = document.getElementById('chatModalMessages');
  if (!container || activeChatOrderId == null) return;

  try {
    const response = await fetch(`${SERVER_URL}/messages/${activeChatOrderId}/${encodeURIComponent(activeChatCompany)}`);
    const history = await response.json();
    const myRole = localStorage.getItem('userRole');
    const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;

    container.innerHTML = '';
    if (history.length === 0) {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.style.background = 'transparent';
      bubble.style.color = 'var(--text-secondary)';
      bubble.style.textAlign = 'center';
      bubble.style.maxWidth = '100%';
      bubble.style.fontSize = '12px';
      bubble.style.fontStyle = 'italic';
      bubble.style.alignSelf = 'center';
      bubble.innerText = 'Чат открыт. Обсудите технические параметры ТЗ напрямую с контрагентом.';
      container.appendChild(bubble);
    } else {
      history.forEach(msg => {
        const bubble = document.createElement('div');
        bubble.className = msg.sender === myRole ? 'chat-bubble me' : 'chat-bubble partner';
        bubble.innerText = msg.text;
        container.appendChild(bubble);
      });
    }
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
  } catch (error) { /* поллинг — тихо пробуем снова на следующем тике */ }
}

async function sendGlobalChatMessage() {
  const input = document.getElementById('chatModalInput');
  if (!input || !input.value.trim() || activeChatOrderId == null) return;
  const text = input.value.trim();
  input.value = '';
  try {
    const token = localStorage.getItem('authToken');
    await fetch(`${SERVER_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ orderId: activeChatOrderId, company: activeChatCompany, text })
    });
  } catch (error) { /* ignore, отрисуем то, что есть */ }
  renderChatHistory();
}

/* ---------------------------------------------------------------------
   Бейджи-счётчики на пунктах сайдбара
   --------------------------------------------------------------------- */
function _setBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.style.display = 'inline-block'; }
  else el.style.display = 'none';
}

async function initSidebarBadges() {
  const token = localStorage.getItem('authToken');
  const role  = localStorage.getItem('userRole');
  if (!token) return;
  try {
    const r = await fetch(`${SERVER_URL}/dashboard/counts`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return;
    const counts = await r.json();
    if (role === 'producer') {
      _setBadge('navBadgeOrders',    counts.activeOrders);
      _setBadge('navBadgeProposals', counts.pendingProposals);
    } else {
      _setBadge('navBadgeOrders',    counts.myActiveOrders);
      _setBadge('navBadgeProposals', counts.newResponses);
    }
    _setBadge('navBadgeMessages', counts.unreadMessages);
  } catch { /* сервер недоступен — тихо */ }
}
