// 端到端取证测试：真实 Chromium 打开本地演练确认页。
//
// 这里刻意把几个容易混淆的场景分开：
//   - 正常对照：两组同篮子、同规则、有效期重叠 → 才生成比较记录；
//   - 关键披露尚未返回：不补零、不生成比较记录，但两组证据都保留；
//   - 站点的货架规则在中途改版：不写成差异结论；
//   - 一组过期：另一组证据照旧保留，比较记录不生成；
//   - 晚回的旧配送报价：隔离该次读取，本轮剩余时间仍能取得有效证据。
// 所有场景都只读取确认页，不提交订单。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { makePortal } from '../portal.mjs';
import { sendJson, start } from '../source-server.mjs';
import { runRound, writeRound } from '../lib/round.mjs';
import { collectSide } from '../lib/collect.mjs';
import { loadPlans, plansForStage, conditionsFor } from '../lib/plan.mjs';
import { REASON } from '../lib/evidence.mjs';

async function withSite(t) {
  const { server, url } = await start({ portal: makePortal(sendJson) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return { url, browser, setStage: (stage) => fetch(`${url}/control?stage=${stage}`, { method: 'POST' }) };
}

test('正常对照：两组独立会话，只有计划内属性不同时才生成比较记录', async (t) => {
  const { url, browser, setStage } = await withSite(t);
  await setStage(1);
  const run = await runRound({ browser, baseUrl: url, study: 'Q-61', budgetMs: 20_000 });

  assert.equal(run.comparison.comparable, true, JSON.stringify(run.comparison.blockers));
  assert.equal(run.sides.control.session.conditions.subject, '普通');
  assert.equal(run.sides.variant.session.conditions.subject, '会员');
  for (const key of ['sku', 'quantity', 'fulfillment', 'benefit']) {
    assert.deepEqual(
      run.sides.control.session.conditions[key],
      run.sides.variant.session.conditions[key],
      `条件 ${key} 必须固定`,
    );
  }
  assert.notEqual(run.sides.control.basketVersion, undefined);
  assert.equal(run.sides.control.ruleSet, 'R1');
  assert.equal(run.sides.variant.ruleSet, 'R1');

  const total = run.comparison.amounts.find((row) => row.field === '报价（元）');
  assert.equal(total.control, '¥74.00');
  assert.equal(total.variant, '¥70.00');
  assert.equal(total.deltaCents, 400);

  // 每个金额都能查回页面上下文、会话条件与时间。
  for (const side of ['control', 'variant']) {
    assert.ok(run.sides[side].amountTrace.length >= 2);
    for (const trace of run.sides[side].amountTrace) {
      assert.equal(trace.pageUrl.endsWith('/checkout'), true);
      assert.ok(trace.selector.startsWith('#quote'));
      assert.ok(trace.observedAt);
      assert.equal(trace.session.basketVersion, run.sides[side].basketVersion);
      assert.ok(trace.caliber);
    }
  }
});

test('关键披露尚未返回：不补零、不生成比较记录，两组证据都保留', async (t) => {
  const { url, browser, setStage } = await withSite(t);
  await setStage(1);
  const run = await runRound({ browser, baseUrl: url, study: 'Q-62', budgetMs: 20_000 });

  assert.equal(run.comparison.comparable, false);
  assert.equal(run.comparison.reason, REASON.DISCLOSURE);
  assert.match(run.comparison.label, /关键披露仍未收到/);
  // 未知的运费/总额原样记录口径，绝不出现在任何差额里。
  const rows = run.comparison.amountObservations;
  const shipping = rows.find((row) => row.field === '运费（元）');
  assert.equal(shipping.variantCaliber, 'unknown');
  assert.ok(rows.every((row) => !('deltaCents' in row)));
  assert.ok(run.sides.control && run.sides.variant);

  const directory = await mkdtemp(join(tmpdir(), 'checkout-evidence-'));
  const written = await writeRound(directory, run);
  assert.deepEqual(written, ['control.json', 'variant.json', 'run.json', 'report.md']);
  await assert.rejects(readFile(join(directory, 'comparison.json'), 'utf8'), { code: 'ENOENT' });
  const control = JSON.parse(await readFile(join(directory, 'control.json'), 'utf8'));
  // 第 1 阶段送货的运费还没返回：原样留证为“尚未返回”，不会写成 0 或“不适用”。
  assert.equal(control.fields['运费（元）'], '尚未返回');
  assert.equal(control.fields['报价（元）'], '待核算');
  const totalTrace = control.amountTrace.find((item) => item.field === '报价（元）');
  assert.equal(totalTrace.caliber, 'unknown');
  const report = await readFile(join(directory, 'report.md'), 'utf8');
  assert.match(report, /关键披露仍未收到/);
  assert.doesNotMatch(report, /差额/);
});

test('货架规则中途改版：不把新旧两次报价写成差异结论', async (t) => {
  const { url, browser, setStage } = await withSite(t);
  await setStage(3);
  const run = await runRound({ browser, baseUrl: url, study: 'Q-62', budgetMs: 20_000 });

  assert.equal(run.comparison.comparable, false);
  assert.equal(run.comparison.reason, REASON.RULES_REVISED);
  assert.match(run.comparison.label, /条款不同/);
  assert.ok(run.comparison.blockers.some((item) => /货架规则|hold/.test(item.message)));
  // 两组证据仍然各自可查，只是不能被拼成一个结论。
  assert.equal(run.sides.control.ruleSet, 'R2');
  assert.equal(run.sides.variant.ruleSet, 'R2');
  assert.ok(run.holds.length >= 1);
});

test('货架规则在两组之间改版：不把新旧两次报价写成差异结论', async (t) => {
  const { url, browser, setStage } = await withSite(t);
  await setStage(1);
  // 对照组按 R1 采完后，站点改版到 R2，实验组在 R2 下采集。
  const run = await runRound({
    browser,
    baseUrl: url,
    study: 'Q-61',
    budgetMs: 20_000,
    beforeCollect: async ({ side }) => {
      if (side === 'variant') await setStage(3);
    },
  });

  assert.equal(run.sides.control.ruleSet, 'R1');
  assert.equal(run.sides.variant.ruleSet, 'R2');
  assert.equal(run.comparison.comparable, false);
  assert.equal(run.comparison.reason, REASON.RULES_REVISED);
  assert.ok(run.comparison.blockers.some((item) => /R1/.test(item.message) && /R2/.test(item.message)));
  // 两份报价都还在，但只能各自作为证据，不能拼成结论。
  assert.ok(run.sides.control.fields['报价（元）']);
  assert.ok(run.sides.variant.fields['报价（元）']);
});

test('一组过期：另一组证据单独保留，比较记录不生成', async (t) => {
  const { url, browser, setStage } = await withSite(t);
  await setStage(4);
  const run = await runRound({ browser, baseUrl: url, study: 'Q-62', budgetMs: 20_000 });

  assert.equal(run.comparison.comparable, false);
  assert.ok(run.comparison.blockers.length > 0);
  assert.equal(run.sides.control.live, false, '对照组的短有效期应当已过期');
  assert.equal(run.sides.variant.live, true, '实验组已采到的证据仍保留且有效');
  assert.ok(run.sides.variant.amountTrace.length >= 2);
  const directory = await mkdtemp(join(tmpdir(), 'checkout-evidence-'));
  const written = await writeRound(directory, run);
  assert.ok(written.includes('variant.json'));
  assert.ok(!written.includes('comparison.json'));
  const variant = JSON.parse(await readFile(join(directory, 'variant.json'), 'utf8'));
  assert.equal(variant.live, true);
});

test('复核时刻可以晚于采集时刻；过期后重新判定但不删改证据', async (t) => {
  const { url, browser } = await withSite(t);
  const first = await runRound({ browser, baseUrl: url, study: 'Q-61', budgetMs: 20_000 });
  assert.equal(first.comparison.comparable, true);
  const control = first.sides.control;

  // 在对照组的截止时刻之后重新判定：证据仍在，但不能再生成比较记录。
  const later = Date.parse(control.notAfter) + 1_000;
  const reread = await runRound({
    browser,
    baseUrl: url,
    study: 'Q-61',
    budgetMs: 20_000,
    compareAt: later,
  });
  assert.equal(reread.comparison.comparable, false);
  assert.equal(reread.comparison.reason, REASON.EXPIRED);
  assert.equal(reread.comparison.comparedAt, new Date(later).toISOString());
  assert.ok(reread.sides.control && reread.sides.variant, '证据本身仍然保留');
});

test('晚回的旧配送报价被隔离，本轮剩余时间仍取得有效证据', async (t) => {
  const { url, browser } = await withSite(t);
  const plans = await loadPlans(url);
  const plan = plansForStage(plans, plans.declaredStage).find((item) => item.study === 'Q-61');
  const started = Date.now();
  const outcome = await collectSide({
    browser,
    baseUrl: url,
    side: 'control',
    conditions: conditionsFor(plan, 'control'),
    plan,
    deadline: started + 20_000,
    // 先触发一次 450ms 才返回的“旧配送”报价，再设置本组条件。
    beforeCollect: async ({ attempt, page }) => {
      if (attempt === 1) await page.getByLabel('取货').selectOption('送货');
    },
  });

  assert.ok(outcome.evidence, '诊断仍应取得一组有效证据');
  assert.ok(
    outcome.quarantine.some((item) => item.kind === 'late-old-quote-overwrote-page'),
    JSON.stringify(outcome.quarantine.map((item) => item.kind)),
  );
  const evidence = outcome.evidence;
  assert.equal(evidence.fields['取货方式'], '到店');
  assert.equal(evidence.fields['数量'], '2');
  assert.ok(Date.now() - started < 20_000, '隔离不应耗尽整轮时间');
  // 隔离记录的请求序列保留下来，复核员能看到是哪一次读取被丢弃。
  const quarantined = outcome.quarantine.find((item) => item.kind === 'late-old-quote-overwrote-page');
  assert.ok(quarantined.requests.length >= 1);
  assert.ok(quarantined.requests.some((entry) => entry.conditions.fulfillment === '送货'));
});
