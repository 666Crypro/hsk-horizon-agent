// Market data: multi-window TWAPs straight from the HSKSwap pool oracle, QuoterV2 quotes,
// and an off-chain reference price for spread / arbitrage detection.
const Q = 1.0001;

/** price of 1 whole base token in whole quote tokens, from a tick */
export function tickToPrice(tick, baseIsToken0, baseDec = 18, quoteDec = 6) {
  const raw = Math.pow(Q, Number(tick)); // token1 per token0, raw units
  const t1PerT0 = baseIsToken0 ? raw : 1 / raw;
  return t1PerT0 * Math.pow(10, baseDec - quoteDec);
}

function meanTick(c0, c1, w) {
  const d = BigInt(c1) - BigInt(c0);
  let t = d / BigInt(w);
  if (d < 0n && d % BigInt(w) !== 0n) t -= 1n;
  return Number(t);
}

export async function readMarket(c, { windows = [60, 300, 900, 3600] } = {}) {
  const [slot0, token0, liq, block] = await Promise.all([
    c.pool.slot0(),
    c.pool.token0(),
    c.pool.liquidity(),
    c.provider.getBlock('latest'),
  ]);
  const baseIs0 = token0.toLowerCase() === c.dep.WHSK.toLowerCase();
  const spot = tickToPrice(slot0.tick, baseIs0);
  const twaps = {};
  for (const w of windows) {
    try {
      const [cum] = await c.pool.observe([w, 0]);
      twaps[w] = tickToPrice(meanTick(cum[0], cum[1], w), baseIs0);
    } catch {
      twaps[w] = null; // window older than oracle history
    }
  }
  return { spot, twaps, tick: Number(slot0.tick), liquidity: liq.toString(), block: block.number, timestamp: block.timestamp };
}

/** Executable quote from HSKSwap QuoterV2 (exact input). */
export async function quote(c, buyBase, amountInRaw) {
  const tokenIn = buyBase ? c.dep.USDT : c.dep.WHSK;
  const tokenOut = buyBase ? c.dep.WHSK : c.dep.USDT;
  const r = await c.quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn: amountInRaw, fee: 3000, sqrtPriceLimitX96: 0 });
  return r.amountOut;
}

/** Off-chain reference price (CEX-aggregated) for HSK in USD. Returns null if unavailable/offline. */
export async function referencePrice({ timeoutMs = 4000 } = {}) {
  if (process.env.REF_PRICE) return { price: Number(process.env.REF_PRICE), source: 'env REF_PRICE' };
  if (process.env.NO_REF === '1') return null;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hashkey-ecopoints&vs_currencies=usd', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    const p = j?.['hashkey-ecopoints']?.usd;
    return p ? { price: p, source: 'coingecko hashkey-ecopoints/usd' } : null;
  } catch {
    return null;
  }
}
