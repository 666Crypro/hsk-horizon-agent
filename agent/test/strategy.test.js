import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/strategy.js';
import { tickToPrice } from '../src/market.js';

const vault = { baseBal: 1000, quoteBal: 320, nav: 400, dailyRemaining: 300, maxTradeQuote: 60 };
const flat = { spot: 0.08, twaps: { 60: 0.08, 300: 0.08, 900: 0.08, 3600: 0.08 } };

test('live HSKSwap tick converts to ~0.08 USDT/WHSK', () => {
  const p = tickToPrice(-301484, true);
  assert.ok(p > 0.079 && p < 0.082, String(p));
});

test('flat market -> hold', () => {
  const d = decide(flat, { price: 0.08, source: 't' }, vault, { riskAppetite: 'medium', maxTradeUsd: 50 });
  assert.equal(d.action, 'hold');
});

test('DEX below reference by more than fee -> buy, capped by user size and contract cap', () => {
  const d = decide({ ...flat, spot: 0.077 }, { price: 0.08, source: 't' }, vault, { riskAppetite: 'high', maxTradeUsd: 500 });
  assert.equal(d.action, 'buy');
  assert.ok(d.sizeUsd <= 60);
});

test('spread inside fee band is ignored', () => {
  const d = decide({ ...flat, spot: 0.0799 }, { price: 0.08, source: 't' }, vault, { riskAppetite: 'high', maxTradeUsd: 50 });
  assert.equal(d.action, 'hold');
});

test('downtrend with inventory -> sell', () => {
  const m = { spot: 0.076, twaps: { 60: 0.076, 300: 0.076, 900: 0.077, 3600: 0.08 } };
  const d = decide(m, null, vault, { riskAppetite: 'medium', maxTradeUsd: 50 });
  assert.equal(d.action, 'sell');
});

test('buy blocked once exposure target is reached', () => {
  const heavy = { ...vault, baseBal: 4500, quoteBal: 40, nav: 400 };
  const d = decide({ ...flat, spot: 0.077 }, { price: 0.08, source: 't' }, heavy, { riskAppetite: 'low', maxTradeUsd: 50 });
  assert.equal(d.action, 'hold');
});
