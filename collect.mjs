#!/usr/bin/env node
// 命令行入口：在授权的本地演练站采集一轮报价证据。
//
// 用法：
//   node collect.mjs --base http://127.0.0.1:4100 --study Q-61 --out ./evidence/Q-61
// 可选项：
//   --budget 30000      本轮时间预算（毫秒）
//   --attempts 3        每组最多重试次数
//   --port 4100         本地启动来源服务（与 --base 二选一）
//   --stage 1           本地启动时直接切到某个回放阶段
//
// 只读取确认页，不提交订单；不复用浏览器上下文，不同组的草稿互不影响。
// 退出码：0 生成了比较记录；2 证据已留但不可比较；1 运行错误。

import { chromium } from 'playwright';
import { start, sendJson } from './source-server.mjs';
import { makePortal } from './portal.mjs';
import { runRound, writeRound } from './lib/round.mjs';

function parseArgs(argv) {
  const args = { budget: 30_000, attempts: 3, out: null, base: null, port: null, study: null, stage: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    switch (token) {
      case '--base': args.base = value; i += 1; break;
      case '--study': args.study = value; i += 1; break;
      case '--out': args.out = value; i += 1; break;
      case '--budget': args.budget = Number(value); i += 1; break;
      case '--attempts': args.attempts = Number(value); i += 1; break;
      case '--port': args.port = Number(value); i += 1; break;
      case '--stage': args.stage = Number(value); i += 1; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`未知参数 ${token}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('node collect.mjs --base <url> --study <Q-xx> --out <dir> [--budget 30000] [--attempts 3] [--port 4100 --stage 1]');
  process.exit(0);
}
if (!args.study) throw new Error('必须指定 --study');
if (!args.base && args.port === null) throw new Error('必须指定 --base 或 --port');
if (!Number.isFinite(args.budget) || args.budget < 1000) throw new Error('--budget 至少 1000 毫秒');
if (!Number.isInteger(args.attempts) || args.attempts < 1) throw new Error('--attempts 至少为 1');
if (args.stage !== null && (!Number.isInteger(args.stage) || args.stage < 1)) throw new Error('--stage 必须是正整数');
if (args.port !== null && (!Number.isInteger(args.port) || args.port < 0)) throw new Error('--port 必须是非负整数');

let server = null;
let baseUrl = args.base;
if (!baseUrl) {
  const app = await start({ port: args.port ?? 0, portal: makePortal(sendJson) });  server = app.server;
  baseUrl = app.url;
  if (args.stage !== null) {
    const control = await fetch(`${baseUrl}/control?stage=${args.stage}`, { method: 'POST' });
    if (!control.ok) throw new Error(`切换回放阶段失败：HTTP ${control.status}`);
    const applied = await control.json();
    if (applied.stage !== args.stage) throw new Error('切换回放阶段后确认不一致');
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const run = await runRound({
    browser,
    baseUrl,
    study: args.study,
    budgetMs: args.budget,
    maxAttempts: args.attempts,
  });
  const directory = args.out ?? `evidence/${args.study}`;
  const written = await writeRound(directory, run);
  const summary = {
    study: run.study,
    stage: run.stage,
    directory,
    files: written,
    comparable: run.comparison.comparable,
    label: run.comparison.comparable ? null : run.comparison.label,
    reason: run.comparison.comparable ? null : run.comparison.reason,
    controlLive: run.sides.control?.live ?? false,
    variantLive: run.sides.variant?.live ?? false,
    quarantinedReadings: run.quarantine.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!run.comparison.comparable) process.exitCode = 2;
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
