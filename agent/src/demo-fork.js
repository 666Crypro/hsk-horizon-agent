#!/usr/bin/env node
// End-to-end demo against the REAL HSKSwap WHSK/USDT pool, on a local anvil fork of HSK Chain mainnet.
// No real funds, no real keys: anvil's public test accounts play owner, agent, keeper and a market whale.
//   npm run demo                 (needs anvil from Foundry on PATH)
//   FORK_URL=... npm run demo    (custom HSK mainnet RPC)
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { HSK_MAINNET, ROOT, loadArtifact, JOURNAL_DIR, STATE_DIR } from './config.js';
import { connect, WETH_ABI, ROUTER_ABI, explainRevert } from './chain.js';
import { tick, fmtTick, saveSettings, DEFAULT_SETTINGS } from './agent.js';
import { keeperOnce } from './keeper.js';
import { handle } from './cli.js';

const PORT = Number(process.env.FORK_PORT ?? 8547);
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // owner (anvil #0)
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // agent (anvil #1)
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3d71e7b6a6dc8b0b', // keeper (anvil #2)
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // whale (anvil #3)
];
const SLOW = Number(process.env.DEMO_PAUSE_MS ?? 600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const step = async (n, title) => {
  const head = `== ${n}. ${title} `.padEnd(78, '=');
  console.log('\n' + C.b(C.c(head)));
  await sleep(SLOW);
};
const you = async (c, ctx, text) => {
  console.log(`${C.y('you>')} ${text}`);
  console.log(await handle(c, text, ctx));
  await sleep(SLOW);
};

async function waitRpc(p) {
  for (let i = 0; i < 120; i++) {
    try {
      await p.getBlockNumber();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('anvil did not start');
}

async function main() {
  // fresh demo state
  fs.rmSync(JOURNAL_DIR, { recursive: true, force: true });
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  if (!fs.existsSync(path.join(ROOT, 'contracts', 'out', 'SentinelVault.sol', 'SentinelVault.json')) && !fs.existsSync(path.join(ROOT, 'agent', 'abi', 'SentinelVault.json'))) {
    execSync('forge build', { cwd: path.join(ROOT, 'contracts'), stdio: 'inherit' });
  }

  const forkUrl = process.env.FORK_URL ?? HSK_MAINNET.rpc;
  console.log(C.b(`HSK Sentinel demo: forking HSK Chain mainnet (${forkUrl}) on ${RPC}`));
  const anvil = spawn('anvil', ['--fork-url', forkUrl, '--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'inherit' });
  const cleanup = () => anvil.kill('SIGINT');
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));

  const provider = new ethers.JsonRpcProvider(RPC, ethers.Network.from(31337), { staticNetwork: true, polling: true, pollingInterval: 200, cacheTimeout: -1 });
  await waitRpc(provider);
  const [owner, agent, keeper, whale] = KEYS.map((k) => new ethers.Wallet(k, provider));
  for (const w of [owner, agent, keeper, whale]) {
    await provider.send('anvil_setBalance', [await w.getAddress(), '0x' + ethers.parseEther('2000000').toString(16)]);
  }
  const ownerAddr = await owner.getAddress();
  const agentAddr = await agent.getAddress();
  const advance = async (secs) => {
    await provider.send('evm_increaseTime', [secs]);
    await provider.send('anvil_mine', ['0x' + Math.max(1, Math.floor(secs / 2)).toString(16)]);
  };

  // ----------------------------------------------------------------- deploy
  await step(1, 'Owner deploys SentinelVault bound to the live HSKSwap WHSK/USDT pool');
  const { abi, bytecode } = loadArtifact();
  const policy = {
    maxTradeQuote: 60_000_000n, // 60 USDT per trade
    dailyQuoteLimit: 300_000_000n, // 300 USDT per day
    maxSlippageBps: 100, // 1%
    maxTwapDeviationBps: 150, // refuse if spot is >1.5% off the TWAP
    maxDrawdownBps: 1_200, // breaker at -12% from high-water mark
    maxBaseExposureBps: 8_000, // never more than 80% in WHSK
    twapWindow: 600, // 10 min TWAP
    cooldown: 30,
  };
  const factory = new ethers.ContractFactory(abi, bytecode, owner);
  const vault = await factory.deploy(ownerAddr, agentAddr, HSK_MAINNET.POOL, HSK_MAINNET.ROUTER, HSK_MAINNET.WHSK, policy);
  await vault.waitForDeployment();
  const deployBlock = (await vault.deploymentTransaction().wait()).blockNumber;
  const dep = { ...HSK_MAINNET, name: 'HSK mainnet fork (local)', chainId: 31337, rpc: RPC, explorer: null, vault: await vault.getAddress(), deployBlock, owner: ownerAddr, agent: agentAddr };
  fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'deployments', 'local-fork.json'), JSON.stringify(dep, null, 2));
  console.log(`vault ${dep.vault}\n  owner ${ownerAddr} (human, cold)\n  agent ${agentAddr} (AI hot key, trade-only)`);
  console.log(`  policy: 60 USDT/trade, 300 USDT/day, 1% slippage vs TWAP, 1.5% spot/TWAP guard, 12% drawdown breaker, 80% max exposure`);

  // ----------------------------------------------------------------- fund
  await step(2, 'Owner funds the vault (wrap HSK, buy USDT on HSKSwap, deposit)');
  const whsk = new ethers.Contract(HSK_MAINNET.WHSK, WETH_ABI, owner);
  const usdt = new ethers.Contract(HSK_MAINNET.USDT, WETH_ABI, owner);
  const router = new ethers.Contract(HSK_MAINNET.ROUTER, ROUTER_ABI, owner);
  await (await whsk.deposit({ value: ethers.parseEther('8000') })).wait();
  await (await whsk.approve(HSK_MAINNET.ROUTER, ethers.parseEther('4000'))).wait();
  await (await router.exactInputSingle({ tokenIn: HSK_MAINNET.WHSK, tokenOut: HSK_MAINNET.USDT, fee: 3000, recipient: ownerAddr, amountIn: ethers.parseEther('4000'), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  await (await whsk.approve(dep.vault, ethers.MaxUint256)).wait();
  await (await usdt.approve(dep.vault, ethers.MaxUint256)).wait();
  await (await vault.deposit(ethers.parseEther('1000'), await usdt.balanceOf(ownerAddr))).wait();

  process.env.AGENT_PK = KEYS[1];
  process.env.OWNER_PK = KEYS[0];
  process.env.KEEPER_PK = KEYS[2];
  process.env.RPC_URL = RPC;
  const c = connect(dep);
  const [, twap0] = await vault.prices();
  // Reference price: pin to the pre-event TWAP = "the CEX market did not follow the on-chain dump".
  process.env.REF_PRICE = process.env.REF_PRICE ?? (Number(twap0) / 1e6).toString();
  saveSettings({ ...DEFAULT_SETTINGS, autoTrailStop: false });
  const ctx = { settings: { ...DEFAULT_SETTINGS, autoTrailStop: false }, loopPaused: false, print: console.log };
  await you(c, ctx, 'how am I doing?');

  // ----------------------------------------------------------------- chat config
  await step(3, 'Conversational control: size, risk, frequency, assets, stops');
  await you(c, ctx, 'trade 40 USDT max per position');
  await you(c, ctx, 'be more aggressive');
  await you(c, ctx, 'check every 2 minutes');
  await you(c, ctx, 'what can you trade?');
  const ownerVault = vault.connect(owner);
  await (await ownerVault.setStops((twap0 * 95n) / 100n, 0, (twap0 * 90n) / 100n)).wait();
  console.log(C.g(`owner armed on-chain stop-loss at -5% (${Number((twap0 * 95n) / 100n) / 1e6}) with a -10% floor the agent can never go below`));
  await you(c, ctx, 'stop 7%');
  await you(c, ctx, 'stop 3%');

  // ----------------------------------------------------------------- spread event
  await step(4, 'Market event: a whale dumps 60k WHSK into HSKSwap; DEX now trades below the reference');
  const wWhale = new ethers.Contract(HSK_MAINNET.WHSK, WETH_ABI, whale);
  const rWhale = new ethers.Contract(HSK_MAINNET.ROUTER, ROUTER_ABI, whale);
  const whaleAddr = await whale.getAddress();
  const dump = async (amt) => {
    await (await wWhale.deposit({ value: ethers.parseEther(amt) })).wait();
    await (await wWhale.approve(HSK_MAINNET.ROUTER, ethers.parseEther(amt))).wait();
    await (await rWhale.exactInputSingle({ tokenIn: HSK_MAINNET.WHSK, tokenOut: HSK_MAINNET.USDT, fee: 3000, recipient: whaleAddr, amountIn: ethers.parseEther(amt), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  };
  await dump('60000');
  await you(c, ctx, 'any arbitrage?');
  console.log(C.b('agent tick (same block as the dump):'));
  let r = await tick(c, ctx.settings);
  console.log(fmtTick(r));
  if (r.error) console.log(C.g('-> the vault refused to buy the wick: spot is too far from the TWAP (possible manipulation).'));

  await step(5, '10 minutes later: TWAP has converged, the discount vs reference persists -> agent buys');
  await advance(660);
  for (let i = 0; i < 2; i++) {
    r = await tick(c, ctx.settings);
    console.log(fmtTick(r));
    await advance(45);
  }

  // ----------------------------------------------------------------- rogue agent
  await step(6, 'A compromised / hallucinating agent tries to break the rules. The contract says no.');
  const rogue = vault.connect(agent);
  for (const [label, args] of [
    ['500 USDT market buy, minOut = 0', [true, 500_000_000n, 0n, ethers.ZeroHash]],
    ['40 USDT buy with minOut = 0 (sandwich bait)', [true, 40_000_000n, 0n, ethers.ZeroHash]],
  ]) {
    try {
      await (await rogue.trade(...args)).wait();
      console.log(C.r(`  ${label}: EXECUTED (unexpected)`));
    } catch (e) {
      console.log(`  ${label}: ${C.g('REVERTED')} ${explainRevert(c, e)}`);
    }
  }
  try {
    await (await vault.connect(agent).withdraw(agentAddr, 1n, 0n)).wait();
  } catch (e) {
    console.log(`  agent tries to withdraw funds to itself: ${C.g('REVERTED')} ${explainRevert(c, e)}`);
  }
  try {
    await (await vault.connect(agent).tightenStopLoss(1n)).wait();
  } catch (e) {
    console.log(`  agent tries to loosen the stop-loss: ${C.g('REVERTED')} ${explainRevert(c, e)}`);
  }

  // ----------------------------------------------------------------- crash + keeper
  await step(7, 'Crash: whale dumps another 300k WHSK. The agent is OFFLINE; a permissionless keeper runs the stop.');
  await dump('300000');
  let k = await keeperOnce(c);
  if (k.notArmed) console.log(C.g('-> spot crashed but the TWAP has not crossed the stop yet: a one-block wick cannot trigger it'));
  for (let i = 0; i < 15 && !k.triggered; i++) {
    await advance(60);
    k = await keeperOnce(c, (x) => console.log(`  [+${(i + 1) * 60}s] ${x}`));
  }
  await (await vault.connect(keeper).checkpoint()).wait();

  // ----------------------------------------------------------------- report
  await step(8, 'Report: positions, PnL and a verifiable decision journal');
  await you(c, ctx, 'status');
  await you(c, ctx, 'show trades');
  console.log(`\nJournal files: ${JOURNAL_DIR} (keccak256(file) == on-chain reasonHash)`);
  console.log(C.b('\nDemo complete. Deployment written to deployments/local-fork.json.'));
  if (process.env.KEEP_FORK === '1') {
    console.log(`Fork still running on ${RPC}. Try: RPC_URL=${RPC} AGENT_PK=<anvil #1> npm run chat   (Ctrl+C to stop)`);
    await new Promise(() => {});
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
