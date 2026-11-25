// Tamper-evident decision journal: every trade's full reasoning is stored off-chain as canonical JSON,
// and keccak256(json) is written on-chain as `reasonHash` in the TradeExecuted event.
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { JOURNAL_DIR } from './config.js';

function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(obj ?? null);
}

export function recordDecision(record) {
  const json = canonical(record);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(json));
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(JOURNAL_DIR, `${hash}.json`), json);
  return hash;
}

export function readDecision(hash) {
  const f = path.join(JOURNAL_DIR, `${hash}.json`);
  if (!fs.existsSync(f)) return null;
  const json = fs.readFileSync(f, 'utf8');
  const ok = ethers.keccak256(ethers.toUtf8Bytes(json)) === hash;
  return { verified: ok, record: JSON.parse(json) };
}
