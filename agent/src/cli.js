#!/usr/bin/env node
// Conversational control surface for the Sentinel agent.
//   npm run chat            interactive chat
//   npm run agent           autonomous loop + chat at the same time
//   node src/cli.js --once "status"
import readline from 'node:readline';
import { ethers } from 'ethers';
import { loadDeployment } from './config.js';
import { connect, explainRevert } from './chain.js';
import { loadSettings, saveSettings, tick, fmtTick, vaultSnapshot, pnl } from './agent.js';
import { readMarket, referencePrice } from './market.js';
import { parseIntent, llmEnabled } from './llm.js';
import { readDecision } from './journal.js';
import { RISK_PROFILES, POOL_FEE } from './strategy.js';

const HELP = `Talk to me in plain English, e.g.
  "how am I doing?" / "status"          positions, NAV, PnL, limits
  "show trades" / "journal"             every trade with its on-chain reasonHash, verified
  "trade 25 USDT max"                   set position size per trade
  "be more conservative" / "risk high"  risk appetite: low | medium | high
  "check every 5 minutes"               trading frequency
  "what can you trade?"                 target assets
  "stop at 0.075" / "stop 5%"           tighten the on-chain stop-loss (agent can only tighten)
  "take profit 0.09"                    on-chain take-profit (anyone can trigger)
  "scan" / "any arbitrage?"             spread vs reference + TWAP signals, no trade
  "trade now" / "tick"                  run one decision cycle now
  "pause" / "resume"                    pause/resume the autonomous loop (owner key: also on-chain)
  "exit"                                quit`;

function regexIntent(t) {
  const s = t.toLowerCase().trim();
  let m;
  if (/^(help|\?)$/.test(s) || s.includes('what can you do')) return { cmd: 'help' };
  if ((m = s.match(/(?:size|trade|max|position)[^0-9]*(\d+(?:\.\d+)?)/)) && !s.includes('stop') && !s.includes('profit')) return { cmd: 'size', arg: m[1] };
  if (/(status|position|how am i|how are we|balance|nav|p&l|pnl|profit)/.test(s)) return { cmd: s.includes('pnl') || s.includes('profit') || s.includes('p&l') ? 'pnl' : 'status' };
  if (/(journal|trades|history|why did)/.test(s)) return { cmd: 'journal' };
  if (/(conservative|careful|safer|low risk|risk low)/.test(s)) return { cmd: 'risk', arg: 'low' };
  if (/(aggressive|degen|high risk|risk high)/.test(s)) return { cmd: 'risk', arg: 'high' };
  if (/(risk medium|balanced|normal risk|medium)/.test(s)) return { cmd: 'risk', arg: 'medium' };
  if ((m = s.match(/(?:every|frequency|interval)\s*(\d+)\s*(s|sec|m|min|h|hour)/))) return { cmd: 'every', arg: m[1] + m[2][0] };
  if (/(asset|pair|what.*trade|which token)/.test(s)) return { cmd: 'assets' };
  if ((m = s.match(/stop[^0-9]*(\d+(?:\.\d+)?%?)/))) return { cmd: 'stop', arg: m[1] };
  if ((m = s.match(/(?:take.?profit|tp)[^0-9]*(\d+(?:\.\d+)?%?)/))) return { cmd: 'tp', arg: m[1] };
  if (/(scan|arb|spread|signal|opportunit)/.test(s)) return { cmd: 'scan' };
  if (/(trade now|tick|run once|go$|analy)/.test(s)) return { cmd: 'tick' };
  if (/(pause|stop trading|halt)/.test(s)) return { cmd: 'pause' };
  if (/(resume|unpause|start trading)/.test(s)) return { cmd: 'resume' };
  if (/^(exit|quit|bye)$/.test(s)) return { cmd: 'exit' };
  return null;
}

const fmt = (n, d = 4) => (n === null || n === undefined ? '-' : Number(n).toFixed(d));

export async function handle(c, text, ctx) {
  const intent = regexIntent(text) ?? (await parseIntent(text)) ?? { cmd: 'unknown' };
  const s = ctx.settings;
  switch (intent.cmd) {
    case 'help':
      return HELP;
    case 'status':
    case 'pnl': {
      const p = await pnl(c);
      const v = p.snap;
      return [
        `Vault ${c.dep.vault} on ${c.dep.name ?? 'HSK Chain'}`,
        `  Position   ${fmt(v.baseBal, 2)} WHSK (~${fmt(v.baseBal * v.twap, 2)} USDT) + ${fmt(v.quoteBal, 2)} USDT`,
        `  NAV        ${fmt(v.nav, 2)} USDT   PnL ${p.pnl >= 0 ? '+' : ''}${fmt(p.pnl, 2)} USDT (${fmt(p.pnlPct * 100, 2)}%)   drawdown ${fmt(v.drawdown * 100, 2)}% of ${v.policy.maxDrawdownBps / 100}% breaker`,
        `  Price      spot ${fmt(v.spot, 6)}  TWAP(${v.policy.twapWindow}s) ${fmt(v.twap, 6)} USDT/WHSK`,
        `  Stops      stop-loss ${v.stopLoss ? fmt(v.stopLoss, 6) : 'off'}  take-profit ${v.takeProfit ? fmt(v.takeProfit, 6) : 'off'}`,
        `  Limits     ${fmt(v.maxTradeQuote, 0)} USDT/trade, ${fmt(v.dailyRemaining, 0)}/${fmt(v.dailyLimit, 0)} USDT left today, slippage ${v.policy.maxSlippageBps / 100}%, exposure <= ${v.policy.maxBaseExposureBps / 100}%`,
        `  Agent      size ${s.maxTradeUsd} USDT, risk ${s.riskAppetite}, every ${s.intervalSec}s, ${ctx.loopPaused ? 'PAUSED' : 'running'}${v.paused ? ' | vault PAUSED' : ''}${v.breaker ? ' | BREAKER TRIPPED' : ''}`,
        `  Trades     ${v.trades} agent trades, ${p.log.filter((x) => x.kind === 'exit').length} keeper exits`,
      ].join('\n');
    }
    case 'journal': {
      const p = await pnl(c);
      if (!p.log.length) return 'No trades yet.';
      return p.log
        .map((x) => {
          if (x.kind === 'exit') return `#- ${x.side.padEnd(11)} sold ${fmt(x.in, 2)} WHSK -> ${fmt(x.out, 2)} USDT @TWAP ${fmt(x.twap, 6)} by keeper ${x.keeper.slice(0, 8)}  tx ${x.tx}`;
          const j = readDecision(x.reasonHash);
          const why = j ? `${j.verified ? 'verified' : 'HASH MISMATCH'}: ${j.record.decision.reasons[0]}` : 'journal file not on this machine';
          const io = x.side === 'BUY' ? `${fmt(x.in, 2)} USDT -> ${fmt(x.out, 2)} WHSK` : `${fmt(x.in, 2)} WHSK -> ${fmt(x.out, 2)} USDT`;
          return `#${x.id} ${x.side.padEnd(11)} ${io} @TWAP ${fmt(x.twap, 6)}  tx ${x.tx}\n     reasonHash ${x.reasonHash.slice(0, 18)}... (${why})`;
        })
        .join('\n');
    }
    case 'size': {
      const v = await vaultSnapshot(c);
      const want = Number(intent.arg);
      s.maxTradeUsd = Math.min(want, v.maxTradeQuote);
      saveSettings(s);
      return `Position size set to ${s.maxTradeUsd} USDT per trade${want > v.maxTradeQuote ? ` (capped: the vault owner allows at most ${v.maxTradeQuote} USDT per trade on-chain)` : ''}.`;
    }
    case 'risk': {
      const r = String(intent.arg ?? 'medium').toLowerCase();
      if (!RISK_PROFILES[r]) return 'Risk must be low, medium or high.';
      s.riskAppetite = r;
      saveSettings(s);
      const p = RISK_PROFILES[r];
      return `Risk appetite: ${r}. Entry threshold ${(p.entry * 100).toFixed(2)}%, ${p.sizeFrac * 100}% of max size per signal, target exposure ${p.targetExposure * 100}%, trailing stop ${p.trail * 100}%.`;
    }
    case 'every': {
      const m = String(intent.arg).match(/(\d+)\s*([smh])?/);
      if (!m) return 'Try "every 90s" or "every 5m".';
      const secs = Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] ?? 's']);
      const v = await vaultSnapshot(c);
      s.intervalSec = Math.max(secs, v.policy.cooldown);
      saveSettings(s);
      ctx.reschedule?.();
      return `I'll evaluate the market every ${s.intervalSec}s${secs < v.policy.cooldown ? ` (vault cooldown is ${v.policy.cooldown}s)` : ''}.`;
    }
    case 'assets':
      return `Target assets: ${s.assets.join(', ')} on HSKSwap (pool ${c.dep.POOL}, 0.3% fee). The vault is bound to this pool at deploy time, so the agent physically cannot trade anything else. Deploy another vault per pair to add assets.`;
    case 'stop':
    case 'tp': {
      const v = await vaultSnapshot(c);
      const a = String(intent.arg);
      const price = a.endsWith('%') ? v.twap * (intent.cmd === 'stop' ? 1 - parseFloat(a) / 100 : 1 + parseFloat(a) / 100) : Number(a);
      const raw = ethers.parseUnits(price.toFixed(6), 6);
      const signer = c.agent ?? c.owner;
      if (!signer) return 'No agent key loaded (AGENT_PK).';
      try {
        const tx = intent.cmd === 'stop' ? await c.vaultAs(signer).tightenStopLoss(raw) : await c.vaultAs(signer).setTakeProfit(raw);
        await tx.wait();
        return `${intent.cmd === 'stop' ? 'Stop-loss' : 'Take-profit'} set on-chain at ${price.toFixed(6)} USDT/WHSK (TWAP ${v.twap.toFixed(6)}). Any keeper can execute it, even if I'm offline. tx ${tx.hash}`;
      } catch (e) {
        return `The vault refused: ${explainRevert(c, e)}${intent.cmd === 'stop' ? ' (the agent may only tighten the stop, never loosen it below the owner floor)' : ''}`;
      }
    }
    case 'scan': {
      const [m, ref] = await Promise.all([readMarket(c), referencePrice()]);
      const lines = [`HSKSwap WHSK/USDT spot ${fmt(m.spot, 6)}; TWAP 1m ${fmt(m.twaps[60], 6)} 5m ${fmt(m.twaps[300], 6)} 15m ${fmt(m.twaps[900], 6)} 1h ${fmt(m.twaps[3600], 6)}`];
      if (ref) {
        const spread = (m.spot - ref.price) / ref.price;
        const edge = Math.abs(spread) - POOL_FEE;
        lines.push(`Reference ${ref.price} (${ref.source}); DEX spread ${(spread * 100).toFixed(2)}%, ${edge > 0 ? `EDGE ${(edge * 100).toFixed(2)}% after 0.30% fee -> ${spread < 0 ? 'buy on DEX' : 'sell on DEX'}` : 'inside the fee band, no arbitrage'}`);
      } else lines.push('Reference price unavailable (offline); trading on TWAP signals only.');
      const mom = m.twaps[300] && m.twaps[3600] ? (m.twaps[300] - m.twaps[3600]) / m.twaps[3600] : 0;
      lines.push(`Momentum 5m vs 1h ${(mom * 100).toFixed(2)}%`);
      return lines.join('\n');
    }
    case 'tick': {
      const r = await tick(c, s, { log: (x) => ctx.print(x) });
      return fmtTick(r);
    }
    case 'pause':
    case 'resume': {
      ctx.loopPaused = intent.cmd === 'pause';
      let extra = '';
      if (c.owner) {
        try {
          const tx = await c.vaultAs(c.owner).setPaused(ctx.loopPaused);
          await tx.wait();
          extra = ` Vault ${ctx.loopPaused ? 'paused' : 'unpaused'} on-chain (owner key), tx ${tx.hash}.`;
        } catch (e) {
          extra = ` On-chain pause failed: ${explainRevert(c, e)}`;
        }
      }
      return `Autonomous loop ${ctx.loopPaused ? 'paused' : 'resumed'}.${extra}`;
    }
    case 'exit':
      process.exit(0);
    default:
      return `Not sure what you mean${llmEnabled() ? '' : ' (set LLM_API_KEY for free-form understanding)'}. Type "help".`;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dep = loadDeployment();
  const c = connect(dep);
  const ctx = { settings: loadSettings(), loopPaused: false, print: (x) => console.log(x) };

  const onceIdx = args.indexOf('--once');
  if (onceIdx >= 0) {
    console.log(await handle(c, args.slice(onceIdx + 1).join(' ') || 'status', ctx));
    process.exit(0);
  }

  console.log(`HSK Sentinel agent | vault ${dep.vault} | ${llmEnabled() ? 'LLM on' : 'deterministic engine (LLM off)'}\nType "help" for commands.`);
  let timer = null;
  const loop = async () => {
    if (!ctx.loopPaused) {
      try {
        console.log(`\n[auto ${new Date().toLocaleTimeString()}]\n${fmtTick(await tick(c, ctx.settings))}`);
      } catch (e) {
        console.log(`[auto] error: ${e.message}`);
      }
    }
    timer = setTimeout(loop, ctx.settings.intervalSec * 1000);
  };
  ctx.reschedule = () => {
    if (timer) {
      clearTimeout(timer);
      timer = setTimeout(loop, ctx.settings.intervalSec * 1000);
    }
  };
  if (args.includes('--auto')) loop();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim()) {
      try {
        console.log(await handle(c, line, ctx));
      } catch (e) {
        console.log(`error: ${e.message}`);
      }
    }
    rl.prompt();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
