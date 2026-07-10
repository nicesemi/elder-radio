/* =============================================
   app.js - 全局共享工具函数
   供 index.html / admin.html / config.html 共用
   ============================================= */

(function() {
  'use strict';

  // ---- Toast ----
  window.showToast = function(message, duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  };

  // ---- Format Date ----
  window.formatDate = function(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };

  // ---- API Helper ----
  window.apiFetch = function(path, options = {}) {
    const url = path.startsWith('/') ? path : '/api/' + path;
    return fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    }).then(r => {
      if (!r.ok) throw new Error(`API error: ${r.status}`);
      return r.json();
    });
  };

  // ---- Debounce ----
  window.debounce = function(fn, delay = 300) {
    let timer;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  };

  // ---- Chips Helper ----
  window.initChips = function(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.addEventListener('click', e => {
      if (!e.target.classList.contains('chip')) return;
      container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      e.target.classList.add('active');
      if (onChange) onChange(e.target.dataset.value || e.target.textContent.trim());
    });
  };

  // ---- Modal ----
  window.showModal = function(title, content, buttons = []) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const btnHTML = buttons.map(b =>
      `<button class="btn ${b.cls || ''}" id="modal-btn-${b.id || 'default'}">${b.label}</button>`
    ).join('');
    overlay.innerHTML = `
      <div class="modal">
        <h2 style="margin-bottom:12px;">${title}</h2>
        <div style="margin-bottom:16px;">${content}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">${btnHTML}</div>
      </div>`;
    document.body.appendChild(overlay);

    buttons.forEach(b => {
      const btn = overlay.querySelector(`#modal-btn-${b.id || 'default'}`);
      if (btn) btn.addEventListener('click', () => {
        overlay.remove();
        if (b.callback) b.callback();
      });
    });

    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove();
    });
    return overlay;
  };

  console.log('[KeyClaw] app.js loaded - shared utilities ready.');
})();