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

/* ---------------------------------------------------------------------
   Защита от XSS при вставке пользовательского текста в innerHTML
   --------------------------------------------------------------------- */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str == null ? '' : String(str);
  return div.innerHTML;
}

/* ---------------------------------------------------------------------
   Центр уведомлений — реальные данные с сервера (события: новый отклик,
   принятие/отклонение КП), с поллингом для почти-живого обновления.
   --------------------------------------------------------------------- */
const currentCompanyName = localStorage.getItem('userCompany') || 'Гость';
let notifPollInterval = null;

function initNotifications() {
  if (currentCompanyName === 'Гость') return;
  refreshNotificationBadge();
  if (notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(refreshNotificationBadge, 10000);
}

async function refreshNotificationBadge() {
  const badgeEl = document.getElementById('bellBadge');
  if (!badgeEl) return;
  try {
    const response = await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`);
    const list = await response.json();
    const unreadCount = list.filter(n => !n.read).length;
    badgeEl.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    if (unreadCount > 0) badgeEl.innerText = unreadCount;
  } catch (error) { /* backend недоступен — тихо игнорируем, попробуем на следующем тике */ }
}

async function openNotificationsModal() {
  const modal = document.getElementById('notificationModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const container = document.getElementById('notificationsList');
  if (!container) return;
  container.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-secondary);font-size:14px;">Загрузка...</div>';

  try {
    const response = await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`);
    const list = await response.json();
    if (list.length === 0) {
      container.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-secondary);font-size:14px;">История уведомлений пуста</div>';
      return;
    }
    container.innerHTML = '';
    list.forEach(n => {
      const item = document.createElement('div');
      item.className = 'notification-item';
      const time = new Date(n.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      item.innerHTML = `<div>${escapeHtml(n.text)}</div><div class="time">⏱ ${time}</div>`;
      container.appendChild(item);
    });
    await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}/read`, { method: 'POST' });
    refreshNotificationBadge();
  } catch (error) {
    container.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-secondary);font-size:14px;">Не удалось загрузить уведомления</div>';
  }
}

function closeNotificationsModal() {
  const modal = document.getElementById('notificationModal');
  if (modal) modal.style.display = 'none';
}

async function clearNotifications() {
  try {
    await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, { method: 'DELETE' });
  } catch (error) { /* ignore */ }
  openNotificationsModal();
}

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
  renderChatHistory();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(renderChatHistory, 4000);
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
    await fetch(`${SERVER_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: activeChatOrderId, company: activeChatCompany, sender: localStorage.getItem('userRole'), text })
    });
  } catch (error) { /* ignore, отрисуем то, что есть */ }
  renderChatHistory();
}
