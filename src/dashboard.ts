/**
 * Nanoclaw Dashboard
 * Local-only HTTP + WebSocket server at http://localhost:3737
 * Opens its own SQLite read/write connection (safe alongside main process).
 */
import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { WebSocketServer } from 'ws';

import { GROUPS_DIR, STORE_DIR } from './config.js';
import Database from 'better-sqlite3';

export type DashboardEvent =
  | {
      type: 'message';
      group: string;
      sender: string;
      content: string;
      timestamp: number;
      isBot: boolean;
    }
  | { type: 'agent_start'; group: string }
  | { type: 'agent_end'; group: string; success: boolean };

type BroadcastFn = (event: DashboardEvent) => void;

const PORT = parseInt(process.env.DASHBOARD_PORT || '3737', 10);

export function startDashboard(
  getChannelStatus: () => Array<{ name: string; connected: boolean }>,
): BroadcastFn {
  const db = new Database(join(STORE_DIR, 'messages.db'));
  const clients = new Set<import('ws').WebSocket>();

  const server = http.createServer((req, res) => {
    handleRequest(req, res, db, getChannelStatus).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[dashboard] http://localhost:${PORT}`);
  });

  return function broadcast(event: DashboardEvent) {
    const msg = JSON.stringify(event);
    clients.forEach((ws) => {
      if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    });
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
  getChannelStatus: () => Array<{ name: string; connected: boolean }>,
) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method ?? 'GET';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, PUT, PATCH, DELETE, OPTIONS',
  );
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (method === 'GET' && p === '/api/status') {
    res.end(
      JSON.stringify({
        channels: getChannelStatus(),
        uptime: process.uptime() * 1000,
      }),
    );
    return;
  }

  if (method === 'GET' && p === '/api/groups') {
    const groups = db
      .prepare(
        `
      SELECT rg.folder, rg.name, rg.jid, rg.is_main, rg.requires_trigger, rg.trigger_pattern,
             c.last_message_time, c.name as chat_name
      FROM registered_groups rg
      LEFT JOIN chats c ON c.jid = rg.jid
      ORDER BY rg.is_main DESC, c.last_message_time DESC
    `,
      )
      .all();
    res.end(JSON.stringify({ groups }));
    return;
  }

  const msgM = p.match(/^\/api\/groups\/([^/]+)\/messages$/);
  if (method === 'GET' && msgM) {
    const folder = decodeURIComponent(msgM[1]);
    const limit = Math.min(
      parseInt(url.searchParams.get('limit') ?? '100', 10),
      500,
    );
    const row = db
      .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
      .get(folder) as { jid: string } | undefined;
    if (!row) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const messages = db
      .prepare(
        `
      SELECT sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?
    `,
      )
      .all(row.jid, limit);
    res.end(JSON.stringify({ messages: (messages as unknown[]).reverse() }));
    return;
  }

  const memM = p.match(/^\/api\/groups\/([^/]+)\/memory$/);
  if (memM) {
    const folder = decodeURIComponent(memM[1]);
    const memPath = join(GROUPS_DIR, folder, 'CLAUDE.md');
    if (method === 'GET') {
      res.end(
        JSON.stringify({
          content: existsSync(memPath) ? readFileSync(memPath, 'utf8') : '',
        }),
      );
      return;
    }
    if (method === 'PUT') {
      const { content } = JSON.parse(await readBody(req));
      writeFileSync(memPath, content, 'utf8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  if (method === 'GET' && p === '/api/tasks') {
    const tasks = db
      .prepare(
        `
      SELECT t.id, t.group_folder, t.prompt, t.schedule_type, t.schedule_value,
             t.next_run, t.last_run, t.last_result, t.status, t.created_at,
             rg.name as group_name
      FROM scheduled_tasks t
      LEFT JOIN registered_groups rg ON rg.folder = t.group_folder
      ORDER BY (t.status = 'active') DESC, t.next_run ASC
    `,
      )
      .all();
    res.end(JSON.stringify({ tasks }));
    return;
  }

  const logsM = p.match(/^\/api\/tasks\/([^/]+)\/logs$/);
  if (method === 'GET' && logsM) {
    const logs = db
      .prepare(
        `
      SELECT id, run_at, status, duration_ms, result, error
      FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 50
    `,
      )
      .all(logsM[1]);
    res.end(JSON.stringify({ logs }));
    return;
  }

  if (method === 'DELETE' && p === '/api/tasks/completed') {
    const completed = db
      .prepare(`SELECT id FROM scheduled_tasks WHERE status = 'completed'`)
      .all() as { id: number }[];
    for (const { id } of completed) {
      db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
      db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    }
    res.end(JSON.stringify({ deleted: completed.length }));
    return;
  }

  const taskM = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskM) {
    const id = taskM[1];
    if (method === 'PATCH') {
      const { status } = JSON.parse(await readBody(req));
      if (!['active', 'paused'].includes(status)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid status' }));
        return;
      }
      db.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(
        status,
        id,
      );
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
      db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nanoclaw</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0d1117;
  --bg2: #111820;
  --surface: #161b22;
  --surface2: #1c2128;
  --surface3: #21262d;
  --border: #30363d;
  --border2: #3d444d;
  --text: #e6edf3;
  --text2: #b0bec9;
  --muted: #7d8590;
  --accent: #4493f8;
  --accent-dim: rgba(68,147,248,0.12);
  --green: #3fb950;
  --green-dim: rgba(63,185,80,0.12);
  --red: #f85149;
  --red-dim: rgba(248,81,73,0.12);
  --yellow: #d29922;
  --yellow-dim: rgba(210,153,34,0.12);
  --orange: #db6d28;
  --mono: ui-monospace,'SF Mono','Cascadia Code','Fira Code',monospace;
  --radius: 8px;
  --radius-sm: 5px;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.5;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Header ─────────────────────────────────────────────────── */
header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  z-index: 10;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
  letter-spacing: -0.01em;
  color: var(--text);
}

.logo-icon {
  width: 26px;
  height: 26px;
  background: linear-gradient(135deg, #4493f8 0%, #a855f7 100%);
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}

.header-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.channel-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid transparent;
  transition: all 0.2s;
}
.channel-pill.ok { background: var(--green-dim); color: var(--green); border-color: rgba(63,185,80,0.25); }
.channel-pill.err { background: var(--red-dim); color: var(--red); border-color: rgba(248,81,73,0.25); }

.ws-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--muted);
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--surface2);
  transition: all 0.3s;
}
.ws-status.live { color: var(--green); border-color: rgba(63,185,80,0.25); background: var(--green-dim); }
.ws-status.error { color: var(--red); border-color: rgba(248,81,73,0.25); background: var(--red-dim); }

.ws-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.ws-status.live .ws-dot {
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.uptime-badge {
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ── Navigation ─────────────────────────────────────────────── */
nav {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

nav button {
  background: none;
  border: none;
  color: var(--muted);
  padding: 10px 14px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}
nav button:hover { color: var(--text2); }
nav button.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* ── Layout ─────────────────────────────────────────────────── */
#content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.tab { display: none; max-width: 1100px; margin: 0 auto; }
.tab.active { display: block; }

/* ── Cards ──────────────────────────────────────────────────── */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 14px;
  overflow: hidden;
}

.card-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.card-body { padding: 16px; }
.card-body.flush { padding: 0; }

/* ── Overview Grid ──────────────────────────────────────────── */
.overview-grid {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 14px;
  margin-bottom: 14px;
}

/* ── Channel Status ─────────────────────────────────────────── */
.ch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(48,54,61,0.6);
}
.ch-row:last-child { border-bottom: none; }

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.ok { background: var(--green); box-shadow: 0 0 0 2px rgba(63,185,80,0.2); }
.status-dot.err { background: var(--red); }

.ch-name { font-weight: 500; font-size: 13px; }
.ch-state {
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
}
.ch-state.ok { color: var(--green); }
.ch-state.err { color: var(--red); }

/* ── System Stats ───────────────────────────────────────────── */
.stat-block {
  padding: 16px;
}
.stat-num {
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(135deg, var(--text) 0%, var(--text2) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  line-height: 1;
}
.stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; }
.stat-sub { font-size: 12px; color: var(--muted); margin-top: 14px; }

/* ── Activity Feed ──────────────────────────────────────────── */
#feed {
  min-height: 200px;
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-family: var(--mono);
  font-size: 12px;
}

.feed-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  color: var(--muted);
  gap: 6px;
  font-family: inherit;
}

.feed-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1.45;
}
.feed-row:hover { background: rgba(255,255,255,0.03); }

.feed-ts { color: var(--muted); font-size: 11px; flex-shrink: 0; }
.feed-content { color: var(--text2); word-break: break-word; }
.feed-row.bot .feed-content { color: var(--accent); }
.feed-row.start .feed-content { color: var(--yellow); }
.feed-row.end-ok .feed-content { color: var(--green); }
.feed-row.end-err .feed-content { color: var(--red); }

/* ── Tables ─────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th {
  padding: 9px 14px;
  text-align: left;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  position: sticky;
  top: 0;
}
td {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(48,54,61,0.5);
  vertical-align: middle;
  font-size: 13px;
}
tr:last-child > td { border-bottom: none; }
tbody tr:hover > td { background: rgba(255,255,255,0.025); }

/* ── Badges ─────────────────────────────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}
.badge-wa { background: rgba(37,211,102,.1); color: #2dd36f; border: 1px solid rgba(37,211,102,.2); }
.badge-tg { background: rgba(0,136,204,.1); color: #38b2f0; border: 1px solid rgba(0,136,204,.2); }
.badge-sl { background: rgba(224,30,90,.1); color: #e01e5a; border: 1px solid rgba(224,30,90,.2); }
.badge-dc { background: rgba(114,137,218,.1); color: #7289da; border: 1px solid rgba(114,137,218,.2); }
.badge-main { background: var(--accent-dim); color: var(--accent); border: 1px solid rgba(68,147,248,.25); }
.badge-active { background: var(--green-dim); color: var(--green); border: 1px solid rgba(63,185,80,.25); }
.badge-paused { background: var(--yellow-dim); color: var(--yellow); border: 1px solid rgba(210,153,34,.25); }
.badge-completed { background: rgba(125,133,144,.1); color: var(--muted); border: 1px solid var(--border); }

/* ── Buttons ─────────────────────────────────────────────────── */
button { font-family: inherit; }

.btn {
  background: var(--surface2);
  border: 1px solid var(--border2);
  color: var(--text2);
  padding: 5px 11px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.btn:hover { background: var(--surface3); color: var(--text); border-color: var(--border2); }
.btn:active { transform: scale(0.97); }

.btn-sm { padding: 3px 9px; font-size: 12px; }

.btn-danger {
  color: var(--red);
  border-color: rgba(248,81,73,0.3);
  background: transparent;
}
.btn-danger:hover { background: var(--red-dim); border-color: rgba(248,81,73,0.5); color: var(--red); }

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
}
.btn-primary:hover { background: #5aa9ff; border-color: #5aa9ff; color: #0d1117; }

.btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--muted);
}
.btn-ghost:hover { background: var(--surface2); color: var(--text2); border-color: var(--border); }

/* ── Forms ───────────────────────────────────────────────────── */
select {
  background: var(--surface2);
  border: 1px solid var(--border2);
  color: var(--text);
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  min-width: 200px;
}
select:focus { border-color: var(--accent); }

/* ── Conversations ───────────────────────────────────────────── */
#messages-list {
  max-height: 520px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
}

.bubble {
  padding: 9px 13px;
  border-radius: 10px;
  max-width: 78%;
  word-break: break-word;
}
.bubble.them {
  background: var(--surface2);
  border: 1px solid var(--border);
  align-self: flex-start;
  border-bottom-left-radius: 3px;
}
.bubble.me {
  background: rgba(68,147,248,0.1);
  border: 1px solid rgba(68,147,248,0.2);
  align-self: flex-end;
  border-bottom-right-radius: 3px;
}
.bubble-meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; font-weight: 500; }
.bubble-text { font-size: 13px; line-height: 1.55; white-space: pre-wrap; }

/* ── Task Logs ───────────────────────────────────────────────── */
.task-logs-row td {
  background: var(--bg2) !important;
  padding: 0 !important;
}
.task-logs-inner {
  padding: 10px 14px 14px;
}
.task-logs-list {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11.5px;
  max-height: 200px;
  overflow-y: auto;
  padding: 8px 10px;
}
.log-line { padding: 2px 0; line-height: 1.5; }
.log-line.success { color: var(--green); }
.log-line.error { color: var(--red); }

/* ── Memory Editor ───────────────────────────────────────────── */
#memory-editor {
  width: 100%;
  min-height: 460px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  padding: 14px;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
}
#memory-editor:focus { border-color: var(--accent); }

/* ── Empty States ────────────────────────────────────────────── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--muted);
  gap: 8px;
  text-align: center;
}
.empty-state-icon { font-size: 28px; opacity: 0.5; }
.empty-state-text { font-size: 13px; }

/* ── Toolbar ─────────────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* ── Prompt truncate ─────────────────────────────────────────── */
.prompt-cell {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text2);
}

/* ── Scrollbars ──────────────────────────────────────────────── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }
</style>
</head>
<body>

<!-- Header -->
<header>
  <div class="logo">
    <div class="logo-icon">🐾</div>
    Nanoclaw
  </div>
  <div class="header-right">
    <div id="channel-pills"><!-- populated by loadStatus() --></div>
    <div class="ws-status" id="ws-status">
      <div class="ws-dot"></div>
      <span id="ws-label">Connecting…</span>
    </div>
    <span class="uptime-badge" id="uptime-badge"></span>
  </div>
</header>

<!-- Nav -->
<nav>
  <button class="active" data-tab="overview">Overview</button>
  <button data-tab="groups">Groups</button>
  <button data-tab="conversations">Conversations</button>
  <button data-tab="tasks">Tasks</button>
  <button data-tab="memory">Memory</button>
</nav>

<!-- Content -->
<div id="content">

  <!-- ── Overview ──────────────────────────────────── -->
  <div class="tab active" id="tab-overview">
    <div class="overview-grid">
      <div>
        <div class="card">
          <div class="card-header"><span class="card-title">Channels</span></div>
          <div id="channels-list">
            <div class="empty-state" style="padding:20px"><span class="empty-state-text">Loading…</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">System</span></div>
          <div class="stat-block">
            <div class="stat-num" id="uptime-big">—</div>
            <div class="stat-label">Uptime</div>
            <div class="stat-sub" id="groups-count"></div>
          </div>
        </div>
      </div>
      <div class="card" style="display:flex;flex-direction:column;margin-bottom:0">
        <div class="card-header">
          <span class="card-title">Live Activity</span>
          <button class="btn btn-ghost btn-sm" onclick="clearFeed()" style="margin-left:auto">Clear</button>
        </div>
        <div class="card-body" style="flex:1;overflow:hidden;padding:10px 12px">
          <div id="feed">
            <div class="feed-empty">
              <div style="font-size:22px">📡</div>
              <div>Waiting for activity…</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Groups ─────────────────────────────────────── -->
  <div class="tab" id="tab-groups">
    <div class="card">
      <div class="card-header">
        <span class="card-title">Registered Groups</span>
        <button class="btn btn-sm" onclick="loadGroups()" style="margin-left:auto">↻ Refresh</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Folder</th>
              <th>Channel</th>
              <th>Last Activity</th>
              <th>Trigger</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="groups-tbody">
            <tr><td colspan="6"><div class="empty-state">Loading…</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ── Conversations ──────────────────────────────── -->
  <div class="tab" id="tab-conversations">
    <div class="card" style="margin-bottom:14px">
      <div class="card-body" style="padding:12px 16px">
        <div class="toolbar">
          <select id="conv-select" onchange="loadMessages()">
            <option value="">Select a group…</option>
          </select>
          <span id="conv-count" style="color:var(--muted);font-size:12px"></span>
          <button class="btn btn-sm" onclick="loadMessages()" style="margin-left:auto">↻ Refresh</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-body">
        <div id="messages-list">
          <div class="empty-state">
            <div class="empty-state-icon">💬</div>
            <div class="empty-state-text">Select a group to view messages</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Tasks ──────────────────────────────────────── -->
  <div class="tab" id="tab-tasks">
    <div class="card">
      <div class="card-header">
        <span class="card-title">Scheduled Tasks</span>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="btn btn-sm btn-danger" onclick="deleteCompletedTasks()">🗑 Delete Completed</button>
          <button class="btn btn-sm" onclick="loadTasks()">↻ Refresh</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>Prompt</th>
              <th>Schedule</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="tasks-tbody">
            <tr><td colspan="7"><div class="empty-state">Loading…</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ── Memory ─────────────────────────────────────── -->
  <div class="tab" id="tab-memory">
    <div class="card" style="margin-bottom:14px">
      <div class="card-body" style="padding:12px 16px">
        <div class="toolbar">
          <select id="mem-select" onchange="loadMemory()">
            <option value="">Select a group…</option>
          </select>
          <code id="mem-path" style="font-size:11.5px;color:var(--muted);font-family:var(--mono)"></code>
          <button class="btn btn-primary btn-sm" id="save-btn" onclick="saveMemory()" style="margin-left:auto">
            Save Changes
          </button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-body flush">
        <textarea id="memory-editor" placeholder="Select a group above to view and edit its CLAUDE.md memory file."></textarea>
      </div>
    </div>
  </div>

</div><!-- #content -->

<script>
var ws = null;
var groups = [];
var feedHasItems = false;

// ── Tab navigation ────────────────────────────────────────────
document.querySelectorAll('nav button').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('nav button').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    var tab = btn.dataset.tab;
    if (tab === 'groups') loadGroups();
    else if (tab === 'conversations') populateSelect('conv-select');
    else if (tab === 'tasks') loadTasks();
    else if (tab === 'memory') populateSelect('mem-select');
  });
});

// ── Utilities ─────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  if (!ts) return 'never';
  var ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  var sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  var ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtUptime(ms) {
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function channelBadge(folder) {
  if (!folder) return '';
  var f = folder.toLowerCase();
  if (f.indexOf('telegram') === 0) return '<span class="badge badge-tg">Telegram</span>';
  if (f.indexOf('slack') === 0) return '<span class="badge badge-sl">Slack</span>';
  if (f.indexOf('discord') === 0) return '<span class="badge badge-dc">Discord</span>';
  return '<span class="badge badge-wa">WhatsApp</span>';
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Live feed ─────────────────────────────────────────────────
function addFeed(text, cls) {
  var feed = document.getElementById('feed');
  if (!feedHasItems) {
    feed.innerHTML = '';
    feedHasItems = true;
  }
  var row = document.createElement('div');
  row.className = 'feed-row' + (cls ? ' ' + cls : '');
  row.innerHTML = '<span class="feed-ts">' + now() + '</span><span class="feed-content">' + esc(text) + '</span>';
  feed.appendChild(row);
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

function clearFeed() {
  feedHasItems = false;
  document.getElementById('feed').innerHTML =
    '<div class="feed-empty"><div style="font-size:22px">📡</div><div>Waiting for activity…</div></div>';
}

// ── WebSocket ─────────────────────────────────────────────────
function setWsStatus(state, label) {
  var el = document.getElementById('ws-status');
  var lbl = document.getElementById('ws-label');
  el.className = 'ws-status' + (state ? ' ' + state : '');
  lbl.textContent = label;
}

function connectWS() {
  setWsStatus('', 'Connecting…');
  try {
    ws = new WebSocket('ws://' + location.host + '/');
  } catch (e) {
    setWsStatus('error', 'Error');
    setTimeout(connectWS, 4000);
    return;
  }
  ws.onopen = function() { setWsStatus('live', 'Live'); };
  ws.onclose = function() {
    setWsStatus('error', 'Disconnected');
    setTimeout(connectWS, 3000);
  };
  ws.onerror = function() { setWsStatus('error', 'Error'); };
  ws.onmessage = function(e) {
    try {
      var ev = JSON.parse(e.data);
      if (ev.type === 'message') {
        var who = ev.isBot ? '🤖 ' + ev.sender : ev.sender;
        var preview = ev.content.length > 120 ? ev.content.slice(0, 120) + '…' : ev.content;
        addFeed('[' + ev.group + '] ' + who + ': ' + preview, ev.isBot ? 'bot' : '');
      } else if (ev.type === 'agent_start') {
        addFeed('▶ Agent running in ' + ev.group, 'start');
      } else if (ev.type === 'agent_end') {
        addFeed((ev.success ? '✓ Agent done' : '✗ Agent failed') + ' · ' + ev.group,
                ev.success ? 'end-ok' : 'end-err');
      }
    } catch (err) {}
  };
}

// ── Status ────────────────────────────────────────────────────
function loadStatus() {
  fetch('/api/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var channels = data.channels || [];
      var uptime = data.uptime || 0;

      // Header channel pills
      var pillsEl = document.getElementById('channel-pills');
      pillsEl.innerHTML = channels.map(function(c) {
        return '<span class="channel-pill ' + (c.connected ? 'ok' : 'err') + '">' +
               '<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>' +
               esc(c.name) + '</span>';
      }).join('');

      // Header uptime
      document.getElementById('uptime-badge').textContent = '⏱ ' + fmtUptime(uptime);

      // Overview: channel list
      var listEl = document.getElementById('channels-list');
      if (!listEl) return;
      if (channels.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-state-text">No channels configured</div></div>';
      } else {
        listEl.innerHTML = channels.map(function(c) {
          return '<div class="ch-row">' +
                 '<div class="status-dot ' + (c.connected ? 'ok' : 'err') + '"></div>' +
                 '<span class="ch-name">' + esc(c.name) + '</span>' +
                 '<span class="ch-state ' + (c.connected ? 'ok' : 'err') + '">' +
                 (c.connected ? 'Connected' : 'Disconnected') + '</span></div>';
        }).join('');
      }

      // Overview: uptime big
      var upEl = document.getElementById('uptime-big');
      if (upEl) upEl.textContent = fmtUptime(uptime);
    })
    .catch(function() {
      document.getElementById('uptime-badge').textContent = '';
    });
}

// ── Groups ────────────────────────────────────────────────────
function loadGroups() {
  fetch('/api/groups')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      groups = data.groups || [];
      var gcEl = document.getElementById('groups-count');
      if (gcEl) gcEl.textContent = groups.length + ' group' + (groups.length !== 1 ? 's' : '') + ' registered';

      var tbody = document.getElementById('groups-tbody');
      if (!tbody) return;
      if (groups.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">🗂</div><div class="empty-state-text">No groups registered</div></div></td></tr>';
        return;
      }
      tbody.innerHTML = groups.map(function(g) {
        return '<tr>' +
          '<td style="font-weight:500">' + (g.is_main ? '<span class="badge badge-main" style="margin-right:6px">main</span>' : '') + esc(g.name || g.folder) + '</td>' +
          '<td style="font-family:var(--mono);font-size:11.5px;color:var(--muted)">' + esc(g.folder) + '</td>' +
          '<td>' + channelBadge(g.folder) + '</td>' +
          '<td style="color:var(--muted);font-size:12px">' + timeAgo(g.last_message_time) + '</td>' +
          '<td style="font-family:var(--mono);font-size:11.5px;color:var(--muted)">' + esc(g.requires_trigger ? (g.trigger_pattern || '@Andy') : 'always') + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn btn-sm" data-folder="' + esc(g.folder) + '" onclick="gotoConversationClick(this)">Messages</button>' +
            ' <button class="btn btn-sm" data-folder="' + esc(g.folder) + '" onclick="gotoMemoryClick(this)">Memory</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    });
}

function populateSelect(id) {
  return fetch('/api/groups')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      groups = data.groups || [];
      var sel = document.getElementById(id);
      var cur = sel.value;
      sel.innerHTML = '<option value="">Select a group…</option>' +
        groups.map(function(g) {
          return '<option value="' + esc(g.folder) + '">' + esc(g.folder) + (g.is_main ? ' ★' : '') + '</option>';
        }).join('');
      if (cur) sel.value = cur;
    });
}

function gotoConversation(folder) {
  document.querySelectorAll('nav button').forEach(function(b) { b.classList.toggle('active', b.dataset.tab === 'conversations'); });
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-conversations').classList.add('active');
  populateSelect('conv-select').then(function() {
    document.getElementById('conv-select').value = folder;
    loadMessages();
  });
}

function gotoMemory(folder) {
  document.querySelectorAll('nav button').forEach(function(b) { b.classList.toggle('active', b.dataset.tab === 'memory'); });
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-memory').classList.add('active');
  populateSelect('mem-select').then(function() {
    document.getElementById('mem-select').value = folder;
    loadMemory();
  });
}

// ── Conversations ─────────────────────────────────────────────
function loadMessages() {
  var folder = document.getElementById('conv-select').value;
  var list = document.getElementById('messages-list');
  if (!folder) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-text">Select a group to view messages</div></div>';
    return;
  }
  list.innerHTML = '<div class="empty-state"><div class="empty-state-text">Loading…</div></div>';
  fetch('/api/groups/' + encodeURIComponent(folder) + '/messages?limit=100')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var messages = data.messages || [];
      document.getElementById('conv-count').textContent = messages.length + ' messages';
      if (!messages.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-text">No messages stored yet</div></div>';
        return;
      }
      list.innerHTML = messages.map(function(m) {
        var isMe = m.is_from_me || m.is_bot_message;
        return '<div class="bubble ' + (isMe ? 'me' : 'them') + '">' +
          '<div class="bubble-meta">' + esc(m.sender_name || m.sender || '?') + ' · ' + timeAgo(m.timestamp) + '</div>' +
          '<div class="bubble-text">' + esc(m.content || '') + '</div>' +
        '</div>';
      }).join('');
      list.scrollTop = list.scrollHeight;
    });
}

// ── Tasks ─────────────────────────────────────────────────────
function loadTasks() {
  fetch('/api/tasks')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var tasks = data.tasks || [];
      var tbody = document.getElementById('tasks-tbody');
      if (!tasks.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-text">No scheduled tasks yet</div></div></td></tr>';
        return;
      }
      tbody.innerHTML = tasks.map(function(t) {
        var statusCls = 'badge-' + esc(t.status);
        return '<tr id="task-row-' + esc(t.id) + '">' +
          '<td style="color:var(--muted);font-size:12px">' + esc(t.group_name || t.group_folder) + '</td>' +
          '<td class="prompt-cell" title="' + esc(t.prompt) + '">' + esc(t.prompt.length > 55 ? t.prompt.slice(0, 55) + '…' : t.prompt) + '</td>' +
          '<td style="font-family:var(--mono);font-size:11.5px;color:var(--muted)">' + esc(t.schedule_type) + ': ' + esc(t.schedule_value) + '</td>' +
          '<td style="font-size:12px;color:var(--muted)">' + fmtDateTime(t.next_run) + '</td>' +
          '<td style="font-size:12px;color:var(--muted)">' + (t.last_run ? timeAgo(t.last_run) : 'never') + '</td>' +
          '<td><span class="badge ' + statusCls + '">' + esc(t.status) + '</span></td>' +
          '<td style="white-space:nowrap;display:flex;gap:4px;align-items:center">' +
            (t.status === 'active'
              ? '<button class="btn btn-sm" data-tid="' + esc(t.id) + '" onclick="pauseTaskBtn(this)">⏸ Pause</button>'
              : '<button class="btn btn-sm" data-tid="' + esc(t.id) + '" onclick="resumeTaskBtn(this)">▶ Resume</button>') +
            ' <button class="btn btn-sm btn-ghost" data-tid="' + esc(t.id) + '" onclick="logsTaskBtn(this)">Logs</button>' +
            ' <button class="btn btn-sm btn-danger" data-tid="' + esc(t.id) + '" onclick="deleteTaskBtn(this)">Delete</button>' +
          '</td>' +
        '</tr>' +
        '<tr class="task-logs-row" id="task-logs-' + esc(t.id) + '" style="display:none">' +
          '<td colspan="7">' +
            '<div class="task-logs-inner">' +
              '<div class="task-logs-list" id="task-logs-content-' + esc(t.id) + '">Loading…</div>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('');
    });
}

function patchTask(id, status) {
  fetch('/api/tasks/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status })
  }).then(function() { loadTasks(); });
}

function deleteTask(id) {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  fetch('/api/tasks/' + id, { method: 'DELETE' }).then(function() { loadTasks(); });
}

function toggleLogs(id, btn) {
  var row = document.getElementById('task-logs-' + id);
  if (row.style.display !== 'none') {
    row.style.display = 'none';
    btn.textContent = 'Logs';
    return;
  }
  row.style.display = '';
  btn.textContent = 'Hide Logs';
  var el = document.getElementById('task-logs-content-' + id);
  el.textContent = 'Loading…';
  fetch('/api/tasks/' + id + '/logs')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var logs = data.logs || [];
      if (!logs.length) { el.textContent = 'No run history yet.'; return; }
      el.innerHTML = logs.map(function(l) {
        return '<div class="log-line ' + esc(l.status) + '">' +
          fmtDateTime(l.run_at) + '  ' + esc(l.status.toUpperCase()) + '  ' + l.duration_ms + 'ms' +
          (l.error ? '  —  ' + esc(l.error.slice(0, 140)) : '') +
        '</div>';
      }).join('');
    });
}

// ── Memory ────────────────────────────────────────────────────
function loadMemory() {
  var folder = document.getElementById('mem-select').value;
  var editor = document.getElementById('memory-editor');
  var pathEl = document.getElementById('mem-path');
  if (!folder) {
    editor.value = '';
    pathEl.textContent = '';
    return;
  }
  editor.value = 'Loading…';
  pathEl.textContent = 'groups/' + folder + '/CLAUDE.md';
  fetch('/api/groups/' + encodeURIComponent(folder) + '/memory')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      editor.value = data.content || '';
    });
}

function saveMemory() {
  var folder = document.getElementById('mem-select').value;
  if (!folder) { alert('Select a group first.'); return; }
  var btn = document.getElementById('save-btn');
  var content = document.getElementById('memory-editor').value;
  btn.textContent = 'Saving…';
  btn.disabled = true;
  fetch('/api/groups/' + encodeURIComponent(folder) + '/memory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content })
  })
    .then(function() {
      btn.textContent = '✓ Saved';
      btn.style.background = 'var(--green)';
      btn.style.borderColor = 'var(--green)';
      setTimeout(function() {
        btn.textContent = 'Save Changes';
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.disabled = false;
      }, 2000);
    })
    .catch(function() {
      btn.textContent = 'Error — try again';
      btn.disabled = false;
    });
}

// ── onclick shims (data-* attributes avoid quoting issues) ────
function gotoConversationClick(btn) { gotoConversation(btn.dataset.folder); }
function gotoMemoryClick(btn) { gotoMemory(btn.dataset.folder); }
function pauseTaskBtn(btn) { patchTask(btn.dataset.tid, 'paused'); }
function resumeTaskBtn(btn) { patchTask(btn.dataset.tid, 'active'); }
function logsTaskBtn(btn) { toggleLogs(btn.dataset.tid, btn); }
function deleteTaskBtn(btn) { deleteTask(btn.dataset.tid); }

function deleteCompletedTasks() {
  if (!confirm('Delete all completed tasks? This cannot be undone.')) return;
  fetch('/api/tasks/completed', { method: 'DELETE' })
    .then(r => r.json())
    .then(d => { loadTasks(); if (d.deleted === 0) alert('No completed tasks found.'); })
    .catch(() => alert('Failed to delete completed tasks.'));
}

// ── Init ──────────────────────────────────────────────────────
connectWS();
loadStatus();
setInterval(loadStatus, 15000);

</script>
</body>
</html>`;
}
