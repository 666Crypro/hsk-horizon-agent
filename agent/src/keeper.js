#!/usr/bin/env node
// Permissionless keeper: anyone can run this. It executes the vault's on-chain stop-loss / take-profit
// and pokes the drawdown breaker. It needs no special role, only gas.
import { loadDeployment } from './config.js';
import { connect, explainRevert } from './chain.js';

export async function keeperOnce(c, log = console.log) {
  const [stopHit, tpHit, twap] = await c.vault.stopStatus();
  if (!stopHit && !tpHit) {
    log(`keeper: TWAP ${Number(twap) / 1e6} has not crossed stop/take-profit; nothing to do`);
    return { triggered: false, notArmed: true, twap };
  }
  try {
    const tx = await c.vaultAs(c.keeper).triggerExit();
    const rc = await tx.wait();
    log(`keeper: ${stopHit ? 'STOP-LOSS' : 'TAKE-PROFIT'} executed at TWAP ${Number(twap) / 1e6} tx ${tx.hash} (gas ${rc.gasUsed})`);
    return { triggered: true, tx: tx.hash };
  } catch (e) {
    const why = explainRevert(c, e);
    log(
      why.includes('Too little received')
        ? `keeper: TWAP ${Number(twap) / 1e6} crossed the stop, but spot is still far below the TWAP; the anti-sandwich minOut holds the exit until they reconverge`
        : `keeper: exit not yet executable (${why}); retrying`,
    );
    return { triggered: false, error: explainRevert(c, e) };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = connect(loadDeployment());
  if (!c.keeper) throw new Error('Set KEEPER_PK (any funded key) or AGENT_PK');
  const every = Number(process.env.KEEPER_INTERVAL ?? 15) * 1000;
  console.log(`keeper watching ${c.dep.vault} every ${every / 1000}s`);
  const run = async () => {
    try {
      await keeperOnce(c);
      const [nav, hwm, pol, tripped] = await Promise.all([c.vault.nav(), c.vault.highWaterMark(), c.vault.policy(), c.vault.breakerTripped()]);
      if (!tripped && nav * 10000n < hwm * (10000n - BigInt(pol.maxDrawdownBps))) {
        await (await c.vaultAs(c.keeper).checkpoint()).wait();
        console.log('keeper: drawdown breaker tripped on-chain');
      }
    } catch (e) {
      console.log(`keeper error: ${e.message}`);
    }
    setTimeout(run, every);
  };
  run();
}
