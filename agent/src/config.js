// Network + protocol configuration for HSK Chain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// load ROOT/.env if present (gitignored); never overrides variables already set
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

// Verified on-chain on 2026-11-25 (see docs/VERIFICATION.md):
//   factory.getPool(WHSK, USDT, 3000) == POOL, router.factory() == FACTORY, pool cardinality 240.
export const HSK_MAINNET = {
  name: 'HSK Chain Mainnet',
  chainId: 177,
  rpc: 'https://mainnet.hsk.xyz',
  explorer: 'https://hsk.blockscout.com',
  WHSK: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1',
  USDT: '0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029',
  POOL: '0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC', // HSKSwap WHSK/USDT 0.3%
  ROUTER: '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3', // HSKSwap SwapRouter02
  QUOTER: '0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD', // HSKSwap QuoterV2
  FACTORY: '0x972cA9D1662F5e029cD18327D29026532E84c742',
};

export const HSK_TESTNET = {
  name: 'HSK Chain Testnet',
  chainId: 133,
  rpc: 'https://testnet.hsk.xyz',
  explorer: 'https://testnet-explorer.hsk.xyz',
};

export function loadDeployment(file = process.env.DEPLOYMENT || path.join(ROOT, 'deployments', 'local-fork.json')) {
  if (!fs.existsSync(path.resolve(ROOT, file))) {
    throw new Error(`No deployment file at ${file}. Run "npm run demo" (fork) or deploy first and set DEPLOYMENT=...`);
  }
  const d = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  return { ...HSK_MAINNET, ...d, file };
}

export function loadArtifact() {
  const candidates = [
    path.join(ROOT, 'contracts', 'out', 'SentinelVault.sol', 'SentinelVault.json'),
    path.join(ROOT, 'agent', 'abi', 'SentinelVault.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      return { abi: j.abi, bytecode: j.bytecode?.object ?? j.bytecode };
    }
  }
  throw new Error('SentinelVault artifact not found. Run "forge build" in contracts/.');
}

export const STATE_DIR = path.join(ROOT, 'agent', 'state');
export const JOURNAL_DIR = path.join(ROOT, 'agent', 'journal');
