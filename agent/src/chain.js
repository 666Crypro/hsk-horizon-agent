import { ethers } from 'ethers';
import { loadArtifact } from './config.js';

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
];
export const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];
export const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
];
export const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
export const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

export function connect(dep, { agentKey = process.env.AGENT_PK, ownerKey = process.env.OWNER_PK, keeperKey = process.env.KEEPER_PK } = {}) {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || dep.rpc, ethers.Network.from(Number(dep.chainId)), { staticNetwork: true, polling: true, pollingInterval: 500, cacheTimeout: -1 });
  const { abi } = loadArtifact();
  const agent = agentKey ? new ethers.Wallet(agentKey, provider) : null;
  const owner = ownerKey ? new ethers.Wallet(ownerKey, provider) : null;
  const keeper = keeperKey ? new ethers.Wallet(keeperKey, provider) : agent;
  const vault = new ethers.Contract(dep.vault, abi, provider);
  return {
    provider,
    dep,
    agent,
    owner,
    keeper,
    vault,
    vaultAs: (signer) => vault.connect(signer),
    pool: new ethers.Contract(dep.POOL, POOL_ABI, provider),
    quoter: new ethers.Contract(dep.QUOTER, QUOTER_ABI, provider),
    base: new ethers.Contract(dep.WHSK, ERC20_ABI, provider),
    quote: new ethers.Contract(dep.USDT, ERC20_ABI, provider),
    iface: new ethers.Interface(abi),
  };
}

/** Decode a custom error from a revert so the chat can explain *why* the contract refused. */
export function explainRevert(c, err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (data && typeof data === 'string') {
    try {
      const e = c.iface.parseError(data);
      if (e) return `${e.name}(${e.args.map((a) => a.toString()).join(', ')})`;
    } catch {}
  }
  return err?.shortMessage || err?.reason || err?.message || String(err);
}
