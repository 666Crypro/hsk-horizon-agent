#!/usr/bin/env node
// Read-only live dashboard: positions, PnL, limits, and the trade log with verified decision journal.
//   npm run dashboard  ->  http://localhost:8788
import http from 'node:http';
import { loadDeployment } from './config.js';
import { connect } from './chain.js';
import { pnl } from './agent.js';
import { readDecision } from './journal.js';

const PORT = Number(process.env.PORT ?? 8788);
const c = connect(loadDeployment());
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const n = (x, d = 2) => Number(x).toFixed(d);
const link = (kind, h) => (c.dep.explorer ? `<a href="${c.dep.explorer}/${kind}/${h}" target="_blank">${h.slice(0, 10)}…</a>` : `<code>${h.slice(0, 10)}…</code>`);

async function state() {
  const p = await pnl(c);
  return {
    ...p,
    log: p.log.map((x) => (x.kind === 'trade' ? { ...x, journal: readDecision(x.reasonHash) } : x)),
  };
}

function page(s) {
  const v = s.snap;
  const rows = s.log
    .slice()
    .reverse()
    .map((x) => {
      const j = x.journal;
      const why = x.kind === 'exit' ? `keeper ${x.keeper.slice(0, 8)}…` : j ? `${j.verified ? '✅' : '❌'} ${esc(j.record.decision.reasons.join('; '))}` : 'journal not on this host';
      const io = x.side === 'BUY' ? `${n(x.in)} USDT → ${n(x.out)} WHSK` : `${n(x.in)} WHSK → ${n(x.out)} USDT`;
      return `<tr><td>${x.id ?? '–'}</td><td class="${x.side === 'BUY' ? 'buy' : 'sell'}">${x.side}</td><td>${io}</td><td>${n(x.twap, 6)}</td><td>${link('tx', x.tx)}</td><td class="why">${why}</td></tr>`;
    })
    .join('');
  const card = (k, val, sub = '') => `<div class="card"><div class="k">${k}</div><div class="v">${val}</div><div class="s">${sub}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>HSK Sentinel</title><meta http-equiv="refresh" content="10">
<style>body{font-family:ui-sans-serif,system-ui;background:#0b0f17;color:#e6edf3;margin:0;padding:24px}h1{margin:0 0 4px}small{color:#8b949e}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0}.card{background:#151b26;border:1px solid #263041;border-radius:10px;padding:14px}
.k{color:#8b949e;font-size:12px;text-transform:uppercase}.v{font-size:22px;font-weight:700;margin-top:4px}.s{color:#8b949e;font-size:12px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#151b26;border-radius:10px;overflow:hidden}td,th{padding:8px 10px;border-bottom:1px solid #263041;font-size:13px;text-align:left}
.buy{color:#3fb950}.sell{color:#f85149}.why{color:#c9d1d9;max-width:520px}a{color:#58a6ff}.bad{color:#f85149}.ok{color:#3fb950}</style></head><body>
<h1>🛡️ HSK Sentinel</h1><small>Vault ${link('address', c.dep.vault)} · ${esc(c.dep.name ?? '')} · HSKSwap WHSK/USDT · auto-refresh 10s</small>
<div class="grid">
${card('NAV', `${n(v.nav)} USDT`, `HWM ${n(v.highWaterMark)} · drawdown ${n(v.drawdown * 100)}% / ${v.policy.maxDrawdownBps / 100}%`)}
${card('PnL', `<span class="${s.pnl >= 0 ? 'ok' : 'bad'}">${s.pnl >= 0 ? '+' : ''}${n(s.pnl)} USDT</span>`, `${n(s.pnlPct * 100)}% on ${n(s.contributed)} contributed`)}
${card('Position', `${n(v.baseBal)} WHSK`, `${n(v.quoteBal)} USDT cash`)}
${card('Price', n(v.twap, 6), `TWAP ${v.policy.twapWindow}s · spot ${n(v.spot, 6)}`)}
${card('Stops', v.stopLoss ? n(v.stopLoss, 6) : 'off', `take-profit ${v.takeProfit ? n(v.takeProfit, 6) : 'off'} · anyone can trigger`)}
${card('Limits', `${n(v.maxTradeQuote, 0)} / trade`, `${n(v.dailyRemaining, 0)} of ${n(v.dailyLimit, 0)} USDT left today`)}
${card('Status', v.breaker ? '<span class="bad">BREAKER</span>' : v.paused ? '<span class="bad">PAUSED</span>' : '<span class="ok">ACTIVE</span>', `${v.trades} agent trades`)}
</div>
<table><tr><th>#</th><th>Side</th><th>Fill</th><th>TWAP</th><th>Tx</th><th>Why (journal hash verified against on-chain reasonHash)</th></tr>${rows || '<tr><td colspan=6>No trades yet</td></tr>'}</table>
</body></html>`;
}

http
  .createServer(async (req, res) => {
    try {
      const s = await state();
      if (req.url.startsWith('/api')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(s, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(s));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  })
  .listen(PORT, () => console.log(`dashboard on http://localhost:${PORT}  (JSON at /api)`));
