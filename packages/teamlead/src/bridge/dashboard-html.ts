/** Returns the full HTML string for the dashboard page. */
export function getDashboardHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flywheel Operations Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surface:#161b22;--border:#30363d;
  --text:#e6edf3;--text-muted:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;
  --card-bg:#1c2128;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  background:var(--bg);color:var(--text);line-height:1.5;padding:1.5rem}
h1{font-size:1.25rem;font-weight:600;display:flex;align-items:center;gap:.75rem}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse 2s infinite}
.live-dot.offline{background:var(--red);animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.live-label{font-size:.75rem;color:var(--text-muted);font-weight:400}
header{display:flex;justify-content:space-between;align-items:center;padding-bottom:1rem;border-bottom:1px solid var(--border);margin-bottom:1.5rem}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1.5rem}
.metric-card{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:1rem;text-align:center}
.metric-card .label{font-size:.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.metric-card .value{font-size:2rem;font-weight:700;font-variant-numeric:tabular-nums;margin-top:.25rem}
.metric-card .value.green{color:var(--green)}
.metric-card .value.yellow{color:var(--yellow)}
.metric-card .value.blue{color:var(--blue)}
.metric-card .value.red{color:var(--red)}

section{margin-bottom:1.5rem}
section h2{font-size:.875rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem}
table{width:100%;border-collapse:collapse;font-size:.8125rem}
th{text-align:left;padding:.5rem .75rem;color:var(--text-muted);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.5rem .75rem;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(255,255,255,.03)}

.badge{display:inline-flex;align-items:center;gap:4px;font-size:.75rem;padding:2px 8px;border-radius:12px;white-space:nowrap}
.badge-running{background:rgba(63,185,80,.15);color:var(--green)}
.badge-awaiting_review{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge-completed{background:rgba(139,148,158,.15);color:var(--text-muted)}
.badge-approved{background:rgba(63,185,80,.15);color:var(--green)}
.badge-blocked{background:rgba(248,81,73,.15);color:var(--red)}
.badge-failed{background:rgba(248,81,73,.15);color:var(--red)}
.badge-rejected{background:rgba(248,81,73,.15);color:var(--red)}
.badge-deferred{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge-shelved{background:rgba(139,148,158,.15);color:var(--text-muted)}

.empty{color:var(--text-muted);font-style:italic;padding:1rem 0}
.mono{font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:.8125rem}
.truncate{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.act-btn{font-size:.6875rem;padding:2px 8px;border:1px solid var(--border);border-radius:4px;
  background:transparent;color:var(--text-muted);cursor:pointer;margin-right:4px;transition:all .15s}
.act-btn:hover{background:var(--surface);color:var(--text);border-color:var(--text-muted)}
.act-btn.approve{border-color:rgba(63,185,80,.4);color:var(--green)}
.act-btn.approve:hover{background:rgba(63,185,80,.15)}
.act-btn.reject{border-color:rgba(248,81,73,.4);color:var(--red)}
.act-btn.reject:hover{background:rgba(248,81,73,.15)}
.act-btn.retry{border-color:rgba(88,166,255,.4);color:var(--blue)}
.act-btn.retry:hover{background:rgba(88,166,255,.15)}
.act-btn:disabled{opacity:.4;cursor:not-allowed;pointer-events:none}

.toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:.75rem 1rem;border-radius:8px;font-size:.8125rem;
  background:var(--card-bg);border:1px solid var(--border);color:var(--text);opacity:0;transition:opacity .3s;z-index:100}
.toast.show{opacity:1}
.toast.error{border-color:var(--red);color:var(--red)}
.toast.success{border-color:var(--green);color:var(--green)}
</style>
</head>
<body>
<header>
  <h1>Flywheel Operations Dashboard</h1>
  <div style="display:flex;align-items:center;gap:6px">
    <span class="live-dot" id="live-dot"></span>
    <span class="live-label" id="live-label">Connecting...</span>
  </div>
</header>

<div class="metrics">
  <div class="metric-card"><div class="label">Running</div><div class="value green" id="m-running">-</div></div>
  <div class="metric-card"><div class="label">Awaiting Review</div><div class="value yellow" id="m-review">-</div></div>
  <div class="metric-card"><div class="label">Completed Today</div><div class="value blue" id="m-completed">-</div></div>
  <div class="metric-card"><div class="label">Failed</div><div class="value red" id="m-failed">-</div></div>
</div>

<section>
  <h2>Active Sessions</h2>
  <table><thead><tr>
    <th>Issue</th><th>Status</th><th>Project</th><th>Runtime</th><th>Branch</th><th>Actions</th>
  </tr></thead><tbody id="t-active"></tbody></table>
  <div class="empty" id="e-active" style="display:none">No active sessions</div>
</section>

<section>
  <h2>Recent Outcomes</h2>
  <table><thead><tr>
    <th>Issue</th><th>Status</th><th>Time</th><th>Diff</th><th>Route</th><th>Actions</th>
  </tr></thead><tbody id="t-recent"></tbody></table>
  <div class="empty" id="e-recent" style="display:none">No recent outcomes</div>
</section>

<section id="s-stuck" style="display:none">
  <h2>Stuck Sessions</h2>
  <table><thead><tr>
    <th>Issue</th><th>Runtime</th><th>Last Active</th><th>Error</th><th>Actions</th>
  </tr></thead><tbody id="t-stuck"></tbody></table>
</section>

<div class="toast" id="toast"></div>

<script>
// Dashboard client — all dynamic data is sanitized through escapeHtml()
// before any DOM insertion. See plan: "安全渲染约束".
(function(){
  var STATUS_ICONS = {
    running: '\\u{1F7E2}', awaiting_review: '\\u{1F7E1}',
    completed: '\\u2B1C', approved: '\\u2705', blocked: '\\u26D4',
    failed: '\\u{1F534}', rejected: '\\u274C', deferred: '\\u23F8\\uFE0F', shelved: '\\u{1F4E6}'
  };

  // Valid actions per status (mirrors ACTION_SOURCE_STATUS in actions.ts)
  var STATUS_ACTIONS = {
    awaiting_review: ['approve', 'reject', 'defer', 'shelve'],
    blocked: ['defer', 'retry', 'shelve'],
    failed: ['retry', 'shelve'],
    rejected: ['retry', 'shelve'],
    deferred: ['shelve']
  };

  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function formatRuntime(startedAt) {
    if (!startedAt) return '-';
    var start = new Date(startedAt.replace(' ', 'T') + 'Z');
    var diff = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ' + (diff % 60) + 's';
    return Math.floor(diff / 3600) + 'h ' + Math.floor((diff % 3600) / 60) + 'm';
  }

  function formatDiff(added, removed) {
    if (added == null && removed == null) return '-';
    var parts = [];
    if (added) parts.push('+' + added);
    if (removed) parts.push('-' + removed);
    return parts.join(' / ') || '-';
  }

  function statusBadge(status) {
    var icon = STATUS_ICONS[status] || '';
    var safe = escapeHtml(status);
    return '<span class="badge badge-' + safe + '">' + icon + ' ' + safe + '</span>';
  }

  function actionButtons(session) {
    var actions = STATUS_ACTIONS[session.status];
    if (!actions || !actions.length) return '<span style="color:var(--text-muted)">\\u2014</span>';
    var html = '';
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var cls = a === 'approve' ? ' approve' : a === 'reject' ? ' reject' : a === 'retry' ? ' retry' : '';
      html += '<button class="act-btn' + cls + '" onclick="doAction(\\'' + escapeHtml(a) + '\\',\\'' + escapeHtml(session.execution_id) + '\\')">'
        + escapeHtml(a) + '</button>';
    }
    return html;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(text);
  }

  // Toast notification
  var toastTimer = null;
  function showToast(msg, type) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { el.className = 'toast'; }, 3000);
  }

  // Action handler — POST to /actions/:action
  window.doAction = function(action, executionId) {
    var btn = event.target;
    btn.disabled = true;
    btn.textContent = '...';
    fetch('/actions/' + encodeURIComponent(action), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({execution_id: executionId})
    }).then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          showToast(data.message || (action + ' succeeded'), 'success');
        } else {
          showToast(data.message || (action + ' failed'), 'error');
          btn.disabled = false;
          btn.textContent = action;
        }
      })
      .catch(function(err) {
        showToast('Network error: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = action;
      });
  };

  function render(data) {
    var m = data.metrics;
    setText('m-running', m.running);
    setText('m-review', m.awaiting_review);
    setText('m-completed', m.completed_today);
    setText('m-failed', m.failed_today);
    renderActive(data.active);
    renderRecent(data.recent);
    renderStuck(data.stuck);
  }

  function renderActive(sessions) {
    var tbody = document.getElementById('t-active');
    var empty = document.getElementById('e-active');
    if (!sessions.length) { tbody.textContent = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    var html = '';
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      html += '<tr>'
        + '<td class="mono">' + escapeHtml(s.issue_identifier || s.execution_id) + '</td>'
        + '<td>' + statusBadge(s.status) + '</td>'
        + '<td>' + escapeHtml(s.project_name) + '</td>'
        + '<td class="runtime" data-started="' + escapeHtml(s.started_at || '') + '">' + escapeHtml(formatRuntime(s.started_at)) + '</td>'
        + '<td class="mono truncate">' + escapeHtml(s.branch || '-') + '</td>'
        + '<td>' + actionButtons(s) + '</td>'
        + '</tr>';
    }
    tbody.innerHTML = html;
  }

  function renderRecent(sessions) {
    var tbody = document.getElementById('t-recent');
    var empty = document.getElementById('e-recent');
    if (!sessions.length) { tbody.textContent = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    var html = '';
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      html += '<tr>'
        + '<td class="mono">' + escapeHtml(s.issue_identifier || s.execution_id) + '</td>'
        + '<td>' + statusBadge(s.status) + '</td>'
        + '<td>' + escapeHtml(formatRuntime(s.started_at)) + '</td>'
        + '<td class="mono">' + escapeHtml(formatDiff(s.lines_added, s.lines_removed)) + '</td>'
        + '<td>' + escapeHtml(s.decision_route || '\\u2014') + '</td>'
        + '<td>' + actionButtons(s) + '</td>'
        + '</tr>';
    }
    tbody.innerHTML = html;
  }

  function renderStuck(sessions) {
    var section = document.getElementById('s-stuck');
    var tbody = document.getElementById('t-stuck');
    if (!sessions.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    var html = '';
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      html += '<tr>'
        + '<td class="mono">' + escapeHtml(s.issue_identifier || s.execution_id) + '</td>'
        + '<td>' + escapeHtml(formatRuntime(s.started_at)) + '</td>'
        + '<td>' + escapeHtml(s.last_activity_at || '-') + '</td>'
        + '<td class="truncate">' + escapeHtml(s.last_error || '-') + '</td>'
        + '<td>' + actionButtons(s) + '</td>'
        + '</tr>';
    }
    tbody.innerHTML = html;
  }

  // Runtime ticker
  setInterval(function() {
    var els = document.querySelectorAll('.runtime[data-started]');
    for (var i = 0; i < els.length; i++) {
      var started = els[i].getAttribute('data-started');
      if (started) els[i].textContent = formatRuntime(started);
    }
  }, 1000);

  // SSE connection with auto-reconnect
  var dot = document.getElementById('live-dot');
  var lbl = document.getElementById('live-label');
  function connect() {
    var es = new EventSource('/sse');
    es.addEventListener('state', function(e) {
      try { render(JSON.parse(e.data)); } catch(err) { console.error('render error', err); }
    });
    es.onopen = function() { dot.classList.remove('offline'); lbl.textContent = 'Live'; };
    es.onerror = function() { dot.classList.add('offline'); lbl.textContent = 'Offline'; es.close(); setTimeout(connect, 3000); };
  }
  connect();
})();
</script>
</body>
</html>`;
}
