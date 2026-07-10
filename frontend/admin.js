/* =============================================
   admin.js - 后台管理逻辑
   API 路径声明（前端调用预留）：
     GET  /api/admin/stats       → 聚合统计
     GET  /api/admin/devices     → 设备列表
     GET  /api/admin/licenses    → 授权列表
     GET  /api/admin/orders      → 付费订单列表
     GET  /api/admin/stats/ai    → AI 使用统计
     GET  /api/admin/conversations → 对话记录
   ============================================= */

(function() {
  'use strict';

  // ---- Tab Switching ----
  document.getElementById('mainTabs').addEventListener('click', e => {
    if (!e.target.classList.contains('tab-btn')) return;
    const tab = e.target.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('panel-' + tab);
    if (panel) {
      panel.classList.add('active');
      // Load data on tab switch
      if (tab === 'devices') loadDevices();
      if (tab === 'licenses') loadLicenses();
      if (tab === 'payments') loadPayments();
      if (tab === 'conversations') loadConversations();
      if (tab === 'resources') loadResources();
    }
  });

  // ---- Dashboard ----
  function loadDashboard() {
    apiFetch('/api/admin/stats').then(data => {
      document.querySelector('#dashStats').innerHTML = `
        <div class="stat-card"><div class="stat-num">${data.total_stations || '-'}</div><div class="stat-title">总电台数</div></div>
        <div class="stat-card"><div class="stat-num">${data.total_devices || '-'}</div><div class="stat-title">总设备数</div></div>
        <div class="stat-card"><div class="stat-num">${data.online_devices || '-'}</div><div class="stat-title">在线设备</div></div>
        <div class="stat-card"><div class="stat-num">${data.active_licenses || '-'}</div><div class="stat-title">活跃授权</div></div>
      `;
    }).catch(() => { /* API not implemented yet */ });

    apiFetch('/api/admin/stats/ai').then(data => {
      document.querySelector('#aiStats').innerHTML = `
        <div class="stat-card"><div class="stat-num">${data.today_calls || '-'}</div><div class="stat-title">今日调用次数</div></div>
        <div class="stat-card"><div class="stat-num">${data.month_calls || '-'}</div><div class="stat-title">本月调用次数</div></div>
        <div class="stat-card"><div class="stat-num">${data.avg_duration || '-'}</div><div class="stat-title">平均时长（秒）</div></div>
      `;
    }).catch(() => { /* API not implemented yet */ });
  }

  // ---- Devices ----
  function loadDevices() {
    const filter = document.getElementById('deviceStatusFilter')?.value || 'all';
    const search = (document.getElementById('deviceSearch')?.value || '').toLowerCase();
    const tbody = document.getElementById('devicesTableBody');

    apiFetch('/api/admin/devices').then(data => {
      let devices = data.devices || [];
      if (filter === 'online') devices = devices.filter(d => d.online);
      if (filter === 'offline') devices = devices.filter(d => !d.online);
      if (search) devices = devices.filter(d => (d.name || '').toLowerCase().includes(search) || (d.device_id || '').toLowerCase().includes(search));

      if (devices.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:20px;">暂无设备数据</td></tr>';
        return;
      }
      tbody.innerHTML = devices.map(d => {
        const healthColor = d.health_status === 'normal' ? 'health-good' : d.health_status === 'warning' ? 'health-warn' : 'health-bad';
        const healthPct = d.health_pct || (d.health_status === 'normal' ? 100 : d.health_status === 'warning' ? 60 : 30);
        return `<tr>
          <td><code style="font-size:0.78rem;">${d.device_id || '-'}</code></td>
          <td>${d.name || '-'}</td>
          <td>${d.location || '-'}</td>
          <td><span class="color-dot ${d.online ? 'green' : 'gray'}"></span>${d.online ? '在线' : '离线'}</td>
          <td><span class="health-bar"><span class="health-fill ${healthColor}" style="width:${healthPct}%"></span></span>${d.health_status || '-'}</td>
          <td>${formatDate(d.last_seen)}</td>
          <td>${d.version || '-'}</td>
        </tr>`;
      }).join('');
    }).catch(() => {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:20px;">API 不可用（/api/admin/devices）</td></tr>';
    });
  }

  // ---- Licenses ----
  function loadLicenses() {
    const filter = document.getElementById('licenseStatusFilter')?.value || 'all';
    const tbody = document.getElementById('licensesTableBody');

    apiFetch('/api/admin/licenses').then(data => {
      let licenses = data.licenses || [];
      if (filter !== 'all') licenses = licenses.filter(l => l.status === filter);

      if (licenses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">暂无授权数据</td></tr>';
        return;
      }
      tbody.innerHTML = licenses.map(l => {
        const planTag = `tag-${l.plan || 'basic'}`;
        const statusTag = `tag-${l.status || 'active'}`;
        return `<tr>
          <td><code style="font-size:0.78rem;">${l.device_id || '-'}</code></td>
          <td><code style="font-size:0.75rem;">${l.license_key || '-'}</code></td>
          <td><span class="tag-status ${planTag}">${l.plan || 'basic'}</span></td>
          <td><span class="tag-status ${statusTag}">${l.status || '-'}</span></td>
          <td>${l.expires_at ? formatDate(l.expires_at) : '-'}</td>
        </tr>`;
      }).join('');
    }).catch(() => {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">API 不可用（/api/admin/licenses）</td></tr>';
    });
  }

  // ---- Payments ----
  function loadPayments() {
    apiFetch('/api/admin/orders').then(data => {
      const orders = data.orders || [];
      const totalRevenue = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
      const thisMonth = orders.filter(o => {
        if (!o.created_at) return false;
        const d = new Date(o.created_at);
        const now = new Date();
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      const monthRevenue = thisMonth.reduce((sum, o) => sum + (o.amount || 0), 0);
      const payingUsers = new Set(orders.map(o => o.device_id)).size;

      document.getElementById('payStats').innerHTML = `
        <div class="stat-card"><div class="stat-num">¥${totalRevenue.toFixed(2)}</div><div class="stat-title">总收入</div></div>
        <div class="stat-card"><div class="stat-num">¥${monthRevenue.toFixed(2)}</div><div class="stat-title">本月收入</div></div>
        <div class="stat-card"><div class="stat-num">${orders.length}</div><div class="stat-title">总订单</div></div>
        <div class="stat-card"><div class="stat-num">${payingUsers}</div><div class="stat-title">付费用户</div></div>
      `;

      const tbody = document.getElementById('ordersTableBody');
      if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:20px;">暂无订单数据</td></tr>';
        return;
      }
      tbody.innerHTML = orders.map(o => `
        <tr>
          <td><code style="font-size:0.78rem;">${o.device_id || '-'}</code></td>
          <td>${o.order_type || '-'}</td>
          <td>¥${(o.amount || 0).toFixed(2)}</td>
          <td>${o.payment_method || '-'}</td>
          <td><span class="tag-status tag-${o.status || 'pending'}">${o.status || '-'}</span></td>
          <td>${formatDate(o.created_at)}</td>
        </tr>
      `).join('');
    }).catch(() => {
      document.getElementById('ordersTableBody').innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:20px;">API 不可用（/api/admin/orders）</td></tr>';
    });
  }

  // ---- Conversations ----
  function loadConversations() {
    const tbody = document.getElementById('convTableBody');
    apiFetch('/api/admin/conversations').then(data => {
      const convs = data.conversations || [];
      if (convs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">暂无对话数据</td></tr>';
        return;
      }
      tbody.innerHTML = convs.map(c => `
        <tr>
          <td style="white-space:nowrap;font-size:0.8rem;">${formatDate(c.created_at)}</td>
          <td><code style="font-size:0.75rem;">${c.device_id || '-'}</code></td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.user_message || '-'}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.bot_reply || '-'}</td>
          <td>${c.duration ? c.duration + 's' : '-'}</td>
        </tr>
      `).join('');
    }).catch(() => {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">API 不可用（/api/admin/conversations）</td></tr>';
    });
  }

  // ---- Resources ----
  function loadResources() {
    fetch('/radio_sources.json').then(r => r.json()).then(data => {
      const stations = data.stations;
      document.getElementById('resCount').textContent = `共 ${stations.length} 个电台`;
      document.getElementById('resTableBody').innerHTML = stations.map(s => `
        <tr>
          <td><code style="font-size:0.72rem;">${s.id}</code></td>
          <td>${s.name}</td>
          <td>${s.province}</td>
          <td>${s.category}</td>
          <td>${s.era || '-'}</td>
          <td><span class="badge ${s.type === 'live' ? 'badge-live' : 'badge-archive'}">${s.type === 'live' ? '直播' : '存档'}</span></td>
          <td>${s.source}</td>
          <td>${s.format || '-'}</td>
        </tr>
      `).join('');
    }).catch(() => {
      document.getElementById('resTableBody').innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:20px;">加载失败</td></tr>';
    });
  }

  // ---- Export JSON ----
  document.getElementById('btnExportJSON')?.addEventListener('click', () => {
    fetch('/radio_sources.json').then(r => r.json()).then(data => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      a.download = `radio_sources_${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('电台数据已导出');
    }).catch(() => showToast('导出失败'));
  });

  document.getElementById('btnRefreshRes')?.addEventListener('click', loadResources);

  // ---- Device filter listeners ----
  document.getElementById('deviceStatusFilter')?.addEventListener('change', loadDevices);
  document.getElementById('deviceSearch')?.addEventListener('input', debounce(loadDevices, 500));
  document.getElementById('licenseStatusFilter')?.addEventListener('change', loadLicenses);

  // ---- Init ----
  loadDashboard();
})();