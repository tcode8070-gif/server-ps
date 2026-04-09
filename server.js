/**
 * Server Pinger Backend — Render pe deploy karo
 * 24/7 ping karta hai bina browser ke
 *
 * Setup:
 *   1. Render pe "New Web Service" banao
 *   2. Yeh folder upload karo (ya GitHub se connect karo)
 *   3. Environment variables set karo (neeche dekho)
 *   4. Deploy!
 *
 * Environment Variables (Render Dashboard > Environment):
 *   SERVERS_JSON   = JSON array of servers (example below)
 *   PING_INTERVAL  = Minutes between pings (default: 5)
 *   PORT           = Auto-set by Render
 *
 * SERVERS_JSON example:
 * [{"name":"Backend","url":"https://myapp.onrender.com","routes":["/","/api","/health"]},{"name":"Bot","url":"https://mybot.onrender.com","routes":["/"]}]
 */

const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PING_INTERVAL_MIN = parseFloat(process.env.PING_INTERVAL || '5');
const PING_INTERVAL_MS = PING_INTERVAL_MIN * 60 * 1000;
const MAX_HISTORY = 200;
const REQUEST_TIMEOUT_MS = 12000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 10000;

// ── Load servers from env ──────────────────────────────────────────────────
let servers = [];
try {
  if (process.env.SERVERS_JSON) {
    servers = JSON.parse(process.env.SERVERS_JSON);
    console.log(`✓ ${servers.length} server(s) loaded from SERVERS_JSON`);
  } else {
    console.warn('⚠️  SERVERS_JSON env variable nahi mila. /servers/add endpoint use karo.');
  }
} catch (e) {
  console.error('✗ SERVERS_JSON parse error:', e.message);
}

// ── In-memory state ────────────────────────────────────────────────────────
const pingLog = {};   // { serverName: [{ route, ok, status, ms, attempts, time }] }
const stats = {
  totalPings: 0,
  startTime: new Date(),
  lastPingAt: null,
};

// ── Ping single URL with retry ─────────────────────────────────────────────
function pingURL(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    let attempts = 0;

    function attempt() {
      attempts++;
      const start = Date.now();
      let done = false;

      const req = lib.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
        if (done) return;
        done = true;
        const ms = Date.now() - start;
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        res.resume(); // drain response
        if (!ok && attempts < RETRY_COUNT) {
          setTimeout(attempt, RETRY_DELAY_MS);
        } else {
          resolve({ ok, statusCode: res.statusCode, ms, attempts });
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (done) return;
        if (attempts < RETRY_COUNT) {
          setTimeout(attempt, RETRY_DELAY_MS);
        } else {
          resolve({ ok: false, statusCode: 'timeout', ms: REQUEST_TIMEOUT_MS, attempts });
        }
      });

      req.on('error', (err) => {
        if (done) return;
        if (attempts < RETRY_COUNT) {
          setTimeout(attempt, RETRY_DELAY_MS);
        } else {
          resolve({ ok: false, statusCode: err.code || 'error', ms: Date.now() - start, attempts });
        }
      });
    }

    attempt();
  });
}

// ── Ping one server (all routes) ───────────────────────────────────────────
async function pingServer(server) {
  const routes = (server.routes && server.routes.length) ? server.routes : ['/'];
  const results = [];

  for (const route of routes) {
    const url = server.url.replace(/\/$/, '') + route;
    const r = await pingURL(url);
    results.push({ route, url, ...r, time: new Date() });
    stats.totalPings++;
  }

  const anyOk = results.some(r => r.ok);
  const avgMs = results.filter(r => r.ok && r.ms).map(r => r.ms);
  const avg = avgMs.length ? Math.round(avgMs.reduce((a, b) => a + b, 0) / avgMs.length) : null;

  const entry = {
    status: anyOk ? 'online' : 'offline',
    avgMs: avg,
    routes: results,
    time: new Date(),
  };

  if (!pingLog[server.name]) pingLog[server.name] = [];
  pingLog[server.name].unshift(entry);
  pingLog[server.name] = pingLog[server.name].slice(0, MAX_HISTORY);

  const icon = anyOk ? '✓' : '✗';
  console.log(`${icon} [${new Date().toISOString()}] ${server.name} → ${anyOk ? 'ONLINE' : 'OFFLINE'} ${avg ? avg + 'ms' : ''}`);

  return entry;
}

// ── Ping ALL servers ────────────────────────────────────────────────────────
async function pingAll() {
  if (!servers.length) {
    console.log('No servers configured. Set SERVERS_JSON env variable.');
    return;
  }
  console.log(`\n── Pinging ${servers.length} server(s)... ──`);
  stats.lastPingAt = new Date();
  await Promise.all(servers.map(s => pingServer(s)));
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Home
app.get('/', (req, res) => {
  const upSec = Math.round((Date.now() - stats.startTime) / 1000);
  const lines = servers.map(s => {
    const log = pingLog[s.name];
    const last = log && log[0];
    return `  ${last ? (last.status === 'online' ? '🟢' : '🔴') : '⚪'} ${s.name} — ${last ? last.status + (last.avgMs ? ' (' + last.avgMs + 'ms)' : '') : 'never pinged'}`;
  });

  res.send(`
    <html><head><title>Server Pinger</title>
    <meta http-equiv="refresh" content="30">
    <style>body{font-family:monospace;background:#0a0c12;color:#e2e8f0;padding:30px;max-width:700px;margin:0 auto}
    h2{color:#34d399}a{color:#60a5fa}pre{background:#13161f;padding:16px;border-radius:8px;overflow:auto}
    .on{color:#34d399}.off{color:#f87171}</style></head><body>
    <h2>🛰️ Server Pinger — Active</h2>
    <p>Uptime: ${Math.floor(upSec/3600)}h ${Math.floor((upSec%3600)/60)}m · Total Pings: ${stats.totalPings} · Last: ${stats.lastPingAt ? stats.lastPingAt.toLocaleTimeString() : 'never'}</p>
    <pre>${lines.join('\n') || 'No servers configured'}</pre>
    <p><a href="/status">/status</a> — JSON API &nbsp;|&nbsp; <a href="/ping">/ping</a> — Manual ping now</p>
    <p style="color:#374151;font-size:12px">Ping interval: every ${PING_INTERVAL_MIN} min | Retries: ${RETRY_COUNT}x | Timeout: ${REQUEST_TIMEOUT_MS/1000}s</p>
    </body></html>
  `);
});

// Full status JSON
app.get('/status', (req, res) => {
  const serverStatus = servers.map(s => {
    const log = pingLog[s.name] || [];
    const last = log[0] || null;
    const onlineCount = log.filter(e => e.status === 'online').length;
    const uptime = log.length ? Math.round(onlineCount / log.length * 100) : null;
    return {
      name: s.name,
      url: s.url,
      routes: s.routes,
      status: last ? last.status : 'never',
      lastPing: last ? last.time : null,
      avgMs: last ? last.avgMs : null,
      uptime: uptime !== null ? uptime + '%' : 'no data',
      history: log.slice(0, 10),
    };
  });

  res.json({
    ok: true,
    pingInterval: `${PING_INTERVAL_MIN} min`,
    totalPings: stats.totalPings,
    startTime: stats.startTime,
    lastPingAt: stats.lastPingAt,
    servers: serverStatus,
  });
});

// Manual ping trigger
app.get('/ping', async (req, res) => {
  await pingAll();
  res.json({ ok: true, message: 'Ping complete', time: new Date() });
});

// Add server at runtime (optional)
app.post('/servers/add', (req, res) => {
  const { name, url, routes } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  servers.push({ name, url, routes: routes || ['/'] });
  res.json({ ok: true, servers });
});

// Health check (so Render knows this service itself is alive)
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛰️  Server Pinger running on port ${PORT}`);
  console.log(`   Ping interval: every ${PING_INTERVAL_MIN} minute(s)`);
  console.log(`   Servers: ${servers.length}`);
  console.log(`   Status: http://localhost:${PORT}/status\n`);
});

// Initial ping after 5 seconds
setTimeout(pingAll, 5000);

// Then every N minutes
setInterval(pingAll, PING_INTERVAL_MS);
