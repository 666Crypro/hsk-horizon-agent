import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { STATE_DIR } from './config.js';
import { explainRevert } from './chain.js';
import { readMarket, quote, referencePrice } from './market.js';
import { decide } from './strategy.js';
import { reviewDecision } from './llm.js';
import { recordDecision } from './journal.js';

const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
export const DEFAULT_SETTINGS = { maxTradeUsd: 50, riskAppetite: 'medium', intervalSec: 120, assets: ['WHSK/USDT'], autoTrailStop: true };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

const U = (x) => Number(ethers.formatUnits(x, 6));
const B = (x) => Number(ethers.formatUnits(x, 18));

export async function vaultSnapshot(c) {
  const v = c.vault;
  const [baseBal, quoteBal, nav, hwm, pol, rem, sl, tp, paused, breaker, prices, trades, agentAddr, owner] = await Promise.all([
    c.base.balanceOf(c.dep.vault),
    c.quote.balanceOf(c.dep.vault),
    v.nav(),
    v.highWaterMark(),
    v.policy(),
    v.dailyRemaining(),
    v.stopLossPrice(),
    v.takeProfitPrice(),
    v.paused(),
    v.breakerTripped(),
    v.prices(),
    v.tradeCount(),
    v.agent(),
    v.owner(),
  ]);
  return {
    baseBal: B(baseBal),
    quoteBal: U(quoteBal),
    nav: U(nav),
    highWaterMark: U(hwm),
    drawdown: hwm > 0n ? 1 - Number(nav) / Number(hwm) : 0,
    maxTradeQuote: U(pol.maxTradeQuote),
    dailyLimit: U(pol.dailyQuoteLimit),
    dailyRemaining: U(rem),
    policy: {
      maxSlippageBps: Number(pol.maxSlippageBps),
      maxTwapDeviationBps: Number(pol.maxTwapDeviationBps),
      maxDrawdownBps: Number(pol.maxDrawdownBps),
      maxBaseExposureBps: Number(pol.maxBaseExposureBps),
      twapWindow: Number(pol.twapWindow),
      cooldown: Number(pol.cooldown),
    },
    stopLoss: U(sl),
    takeProfit: U(tp),
    paused,
    breaker,
    spot: U(prices.spot),
    twap: U(prices.twap),
    trades: Number(trades),
    agent: agentAddr,
    owner,
  };
}

/** Cost-basis PnL reconstructed purely from on-chain events. */
export async function pnl(c, fromBlock = Number(c.dep.deployBlock ?? 0)) {
  const v = c.vault;
  const [deps, wds, trades, exits] = await Promise.all([
    v.queryFilter(v.filters.Deposited(), fromBlock),
    v.queryFilter(v.filters.Withdrawn(), fromBlock),
    v.queryFilter(v.filters.TradeExecuted(), fromBlock),
    v.queryFilter(v.filters.ExitTriggered(), fromBlock),
  ]);
  let contributed = 0;
  for (const e of deps) contributed += U(e.args.quoteAmount) + B(e.args.baseAmount) * (await twapAt(c, e.blockNumber));
  for (const e of wds) contributed -= U(e.args.quoteAmount) + B(e.args.baseAmount) * (await twapAt(c, e.blockNumber));
  const snap = await vaultSnapshot(c);
  const log = [
    ...trades.map((e) => ({
      kind: 'trade',
      block: e.blockNumber,
      tx: e.transactionHash,
      id: Number(e.args.id),
      side: e.args.buyBase ? 'BUY' : 'SELL',
      in: e.args.buyBase ? U(e.args.amountIn) : B(e.args.amountIn),
      out: e.args.buyBase ? B(e.args.amountOut) : U(e.args.amountOut),
      twap: U(e.args.twapPrice),
      reasonHash: e.args.reasonHash,
    })),
    ...exits.map((e) => ({
      kind: 'exit',
      block: e.blockNumber,
      tx: e.transactionHash,
      side: e.args.stopLoss ? 'STOP-LOSS' : 'TAKE-PROFIT',
      in: B(e.args.baseSold),
      out: U(e.args.quoteOut),
      twap: U(e.args.twapPrice),
      keeper: e.args.keeper,
    })),
  ].sort((a, b) => a.block - b.block);
  return { contributed, nav: snap.nav, pnl: snap.nav - contributed, pnlPct: contributed ? (snap.nav - contributed) / contributed : 0, log, snap };
}

const twapCache = new Map();
async function twapAt(c, blockTag) {
  if (twapCache.has(blockTag)) return twapCache.get(blockTag);
  const [, twap] = await c.vault.prices({ blockTag });
  const p = U(twap);
  twapCache.set(blockTag, p);
  return p;
}

/**
 * One autonomous cycle: observe -> decide -> (LLM review) -> journal -> execute on-chain.
 * Returns a structured result the CLI/dashboard can render.
 */
export async function tick(c, settings, { dryRun = false, log = console.log } = {}) {
  const [m, ref, v] = await Promise.all([readMarket(c), referencePrice(), vaultSnapshot(c)]);
  const d = decide(m, ref, v, settings);
  const review = await reviewDecision(d, m, v);
  if (review && !review.approve) {
    d.reasons.push(`LLM risk officer vetoed: ${review.note}`);
    d.action = 'hold';
    d.sizeUsd = 0;
  } else if (review) {
    d.sizeUsd = Number((d.sizeUsd * review.sizeMultiplier).toFixed(2));
    if (review.note) d.reasons.push(`LLM: ${review.note}`);
  }
  const result = { market: m, ref, vault: v, decision: d, review, tx: null, error: null };

  if (v.paused || v.breaker) {
    d.reasons.push(v.paused ? 'vault paused by owner' : 'drawdown breaker tripped; owner must reset');
    d.action = 'hold';
  }

  // trailing stop: tighten only (contract enforces "only up")
  if (settings.autoTrailStop && d.trailStop && d.trailStop > v.stopLoss * 1.002 && c.agent && !dryRun) {
    try {
      const raw = ethers.parseUnits(d.trailStop.toFixed(6), 6);
      const tx = await c.vaultAs(c.agent).tightenStopLoss(raw);
      await tx.wait();
      result.trail = { stop: d.trailStop, tx: tx.hash };
      log?.(`  trailing stop tightened to ${d.trailStop.toFixed(6)} USDT (${tx.hash})`);
    } catch (e) {
      result.trail = { error: explainRevert(c, e) };
    }
  }

  if (d.action === 'hold' || dryRun || !c.agent) return result;

  const buy = d.action === 'buy';
  const amountIn = buy ? ethers.parseUnits(d.sizeUsd.toFixed(6), 6) : ethers.parseUnits((d.sizeUsd / v.twap).toFixed(18), 18);
  const quoted = await quote(c, buy, amountIn);
  // our minOut: executable quote minus 0.5%; the contract additionally floors it at TWAP-fair minus maxSlippage
  const minOut = (quoted * 9950n) / 10000n;
  const record = {
    v: 1,
    agent: 'hsk-sentinel',
    chainId: c.dep.chainId,
    vault: c.dep.vault,
    ts: m.timestamp,
    block: m.block,
    market: { spot: m.spot, twaps: m.twaps, ref: ref?.price ?? null, refSource: ref?.source ?? null },
    vaultState: { baseBal: v.baseBal, quoteBal: v.quoteBal, nav: v.nav, exposure: d.exposure },
    settings,
    decision: { action: d.action, sizeUsd: d.sizeUsd, score: d.score, signals: d.signals, reasons: d.reasons },
    review,
    execution: { amountIn: amountIn.toString(), quoted: quoted.toString(), minOut: minOut.toString() },
  };
  const reasonHash = recordDecision(record);
  result.reasonHash = reasonHash;
  try {
    const tx = await c.vaultAs(c.agent).trade(buy, amountIn, minOut, reasonHash);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return c.iface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'TradeExecuted');
    result.tx = tx.hash;
    result.fill = ev ? { amountOut: ev.args.amountOut.toString(), twap: U(ev.args.twapPrice), navAfter: U(ev.args.navAfter) } : null;
  } catch (e) {
    result.error = explainRevert(c, e);
  }
  return result;
}

export function fmtTick(r) {
  const d = r.decision;
  const lines = [];
  lines.push(`  market  spot ${r.market.spot.toFixed(6)} | TWAP 5m ${r.market.twaps[300]?.toFixed(6)} 1h ${r.market.twaps[3600]?.toFixed(6)}${r.ref ? ` | ref ${r.ref.price}` : ''}`);
  lines.push(`  decide  ${d.action.toUpperCase()}${d.sizeUsd ? ` ~${d.sizeUsd} USDT` : ''} (score ${d.score}, risk ${d.profile})`);
  for (const why of d.reasons) lines.push(`          - ${why}`);
  if (r.tx) {
    const out = d.action === 'buy' ? `${ethers.formatUnits(r.fill.amountOut, 18)} WHSK` : `${ethers.formatUnits(r.fill.amountOut, 6)} USDT`;
    lines.push(`  filled  ${out}  NAV ${r.fill.navAfter.toFixed(2)} USDT  tx ${r.tx}`);
    lines.push(`  journal reasonHash ${r.reasonHash}`);
  }
  if (r.error) lines.push(`  REFUSED by vault: ${r.error}`);
  return lines.join('\n');
}
