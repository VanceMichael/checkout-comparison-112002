// 一轮取证的编排与可复核的产物。
//
// 一组：在一个隔离浏览器上下文里按计划设置条件，停在确认页，读取可见报价。
// 两组分别采集，各自留证；即使一组过期或采集失败，另一组的证据也原样保留。
// 只有在 compareEvidence 判定可比时才生成比较记录，并附上每笔金额的
// 页面上下文、会话条件、篮子版本与时间。
//
// 每轮目录下：control.json / variant.json（各组证据）、comparison.json（仅在可比时）、
// run.json（整轮摘要与隔离记录）、report.md（复核员可通读的摘要）。
// 复核时可以指定比较时刻，在报价过期后重新判定；不会据此删改已采证据。

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  compareEvidence,
  checkSessionConsistency,
  REASON,
  REASON_LABELS,
  isLive,
} from './evidence.mjs';
import { describeMoney, subtractMoney } from './money.mjs';
import { collectSide } from './collect.mjs';
import { conditionsFor, loadPlans, plansForStage, holdsFor } from './plan.mjs';

export const SIDES = ['control', 'variant'];

/**
 * 依次采集两组证据，每组一个隔离浏览器上下文。
 * 一组失败不会中止另一组；两组的草稿、篮子版本与页面会话互不共享。
 * 晚回旧报价的读取被隔离在 quarantine 中，只消耗该次尝试的时间，
 * 本轮剩余时间仍可用于重采或另一组。
 * `beforeCollect` 只用于演练/测试时模拟站点侧变化（如改版、慢响应）。
 */
export async function collectRound({ browser, baseUrl, plan, deadline, maxAttempts = 3, beforeCollect = null }) {
  const sides = {};
  const quarantine = [];
  for (const side of SIDES) {
    const outcome = await collectSide({
      browser,
      baseUrl,
      side,
      conditions: conditionsFor(plan, side),
      plan,
      deadline,
      maxAttempts,
      beforeCollect,
    });
    sides[side] = outcome.evidence;
    quarantine.push(...outcome.quarantine);
  }
  return { sides, quarantine };
}

/**
 * 执行一轮取证。
 * @param {object} options
 * @param {import('playwright').Browser} options.browser
 * @param {string} options.baseUrl
 * @param {string} options.study 计划编号
 * @param {number} [options.budgetMs] 本轮剩余时间
 * @param {number} [options.maxAttempts] 每组最多重试次数
 * @param {() => number} [options.now] 可注入的时钟（用于计时和默认比较时刻）
 * @param {number | null} [options.compareAt] 显式比较时刻；复核时可在报价过期后重判
 */
export async function runRound({
  browser,
  baseUrl,
  study,
  budgetMs = 30_000,
  maxAttempts = 3,
  now = () => Date.now(),
  compareAt = null,
  beforeCollect = null,
}) {
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  const plans = await loadPlans(baseUrl);
  const plan = plansForStage(plans, plans.declaredStage).find((item) => item.study === study);
  if (!plan) throw new Error(`当前回放阶段没有计划 ${study} 的 order-study 记录`);

  const { sides, quarantine } = await collectRound({
    browser,
    baseUrl,
    plan,
    deadline,
    maxAttempts,
    beforeCollect,
  });

  // 会话一致性属于采证本身的问题，不作为“比较结论”，但会阻止该组证据被使用。
  const consistency = {};
  for (const side of SIDES) {
    if (!sides[side]) continue;
    const problems = checkSessionConsistency(sides[side]);
    consistency[side] = problems;
    if (problems.length) {
      quarantine.push({ side, kind: 'session-mismatch', problems });
      sides[side] = null;
    }
  }

  const observedAt = now();
  const at = compareAt ?? observedAt;
  const holds = holdsFor(plans, plan.study);
  const comparison = compareEvidence({
    control: sides.control,
    variant: sides.variant,
    onlyDiff: plan.onlyDiff,
    at,
    holds,
  });

  return {
    study: plan.study,
    plan: {
      record: plan.record,
      onlyDiff: plan.onlyDiff,
      field: plan.field,
      subjects: plan.subjects,
      sku: plan.sku,
      quantity: plan.quantity,
      merchant: plan.merchant,
      fulfillment: plan.fulfillment,
      selectedBenefit: plan.selectedBenefit,
      currency: plan.currency,
    },
    stage: plans.declaredStage,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(observedAt).toISOString(),
    budgetMs,
    sides: {
      control: sides.control ? sideRecord(sides.control, observedAt) : null,
      variant: sides.variant ? sideRecord(sides.variant, observedAt) : null,
    },
    sessionChecks: consistency,
    holds,
    quarantine,
    comparison: comparison.comparable
      ? {
          comparable: true,
          observedAt: new Date(at).toISOString(),
          overlap: {
            start: new Date(comparison.overlap.start).toISOString(),
            end: new Date(comparison.overlap.end).toISOString(),
          },
          amounts: comparison.amounts.map((row) => ({
            field: row.field,
            control: describeMoney(row.control),
            variant: describeMoney(row.variant),
            deltaCents: subtractMoney(row.control, row.variant),
            caliber: row.control.state,
          })),
          note: '仅在两组有效期内、同一篮子、同一货架规则下生成',
        }
      : {
          comparable: false,
          reason: comparison.reason,
          label: comparison.label ?? REASON_LABELS[comparison.reason],
          comparedAt: new Date(at).toISOString(),
          blockers: comparison.blockers,
          amountObservations: comparison.amounts
            ? comparison.amounts.map((row) => ({
                field: row.field,
                control: row.control.text,
                variant: row.variant.text,
                controlCaliber: row.control.state,
                variantCaliber: row.variant.state,
              }))
            : null,
        },
  };
}

function sideRecord(evidence, at) {
  return {
    side: evidence.side,
    live: isLive(evidence, at),
    observedAt: evidence.observedAtIso,
    notBefore: evidence.notBefore === null ? null : new Date(evidence.notBefore).toISOString(),
    notAfter: evidence.notAfter === null ? null : new Date(evidence.notAfter).toISOString(),
    basketVersion: evidence.basketVersion,
    ruleSet: evidence.ruleSet,
    session: evidence.session,
    context: evidence.context,
    fields: evidence.fields,
    amountTrace: evidence.amountTrace,
  };
}

/** 把一轮结果写到目录；每组单独落盘，比较记录只在可比时写出。 */
export async function writeRound(directory, run) {
  await mkdir(directory, { recursive: true });
  const written = [];
  for (const side of SIDES) {
    const record = run.sides[side];
    if (!record) continue;
    const name = `${side}.json`;
    await writeFile(join(directory, name), JSON.stringify(record, null, 2) + '\n');
    written.push(name);
  }
  if (run.comparison.comparable) {
    await writeFile(join(directory, 'comparison.json'), JSON.stringify(run.comparison, null, 2) + '\n');
    written.push('comparison.json');
  }
  await writeFile(join(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  written.push('run.json');
  await writeFile(join(directory, 'report.md'), renderReport(run));
  written.push('report.md');
  return written;
}

/**
 * 把一轮摘要写成便于复核员通读的 Markdown。
 * 只复述已有证据，不重新判断，不补写缺失金额。
 */
export function renderReport(run) {
  const lines = [];
  const amount = (row) => `${row.field}：${row.control} vs ${row.variant}`;
  lines.push(`# 结算页报价证据 · ${run.study}`, '');
  lines.push(`- 计划记录：${run.plan.record}`);
  lines.push(`- 唯一对照属性：${run.plan.onlyDiff}（${run.plan.subjects.join(' / ')}）`);
  lines.push(`- 回放阶段：${run.stage}`);
  lines.push(`- 取证时间：${run.startedAt} → ${run.finishedAt}`);
  lines.push(`- 篮子：${run.plan.merchant} ${run.plan.sku} ×${run.plan.quantity}，${run.plan.fulfillment}，权益${run.plan.selectedBenefit ? '已选' : '未选'}`);
  lines.push('');

  for (const side of SIDES) {
    const record = run.sides[side];
    lines.push(`## ${side === 'control' ? '对照组' : '实验组'}`, '');
    if (!record) {
      lines.push('_没有可用的报价证据。_', '');
      continue;
    }
    lines.push(`- 观察时刻：${record.observedAt}`);
    lines.push(`- 有效期：${record.notBefore} → ${record.notAfter}（${record.live ? '仍有效' : '已过期'}）`);
    lines.push(`- 篮子版本：${record.basketVersion}；货架规则：${record.ruleSet}`);
    lines.push(`- 页面：${record.context.pageTitle ?? record.context.title ?? ''} ${record.context.url}`);
    lines.push(`- 会话条件：\`${JSON.stringify(record.session.conditions)}\``);
    lines.push('');
    lines.push('| 字段 | 页面原文 | 口径 | 页面定位 | 读取时刻 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const trace of record.amountTrace) {
      lines.push(`| ${trace.field} | ${trace.raw} | ${trace.caliber} | ${trace.selector} | ${trace.observedAt} |`);
    }
    lines.push('');
  }

  lines.push('## 比较', '');
  if (run.comparison.comparable) {
    lines.push(`- 共同有效期：${run.comparison.overlap.start} → ${run.comparison.overlap.end}`);
    lines.push('');
    lines.push('| 金额 | 对照组 | 实验组 | 差额（分） |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of run.comparison.amounts) {
      lines.push(`| ${row.field} | ${row.control} | ${row.variant} | ${row.deltaCents ?? '—'} |`);
    }
  } else {
    lines.push(`- 结论：不可比较——**${run.comparison.label}**`);
    for (const blocker of run.comparison.blockers) lines.push(`  - ${blocker.message}`);
    if (run.comparison.amountObservations?.length) {
      lines.push('', '| 金额 | 对照组原值 | 实验组原值 |', '| --- | --- | --- |');
      for (const row of run.comparison.amountObservations) {
        lines.push(`| ${row.field} | ${row.control}（${row.controlCaliber}） | ${row.variant}（${row.variantCaliber}） |`);
      }
    }
  }
  if (run.holds.length) {
    lines.push('', '## 计划提示', '');
    for (const hold of run.holds) lines.push(`- ${hold.record}：${hold.observation ?? '（无说明）'}`);
  }
  if (run.quarantine.length) {
    lines.push('', '## 被隔离的读取', '');
    for (const item of run.quarantine) {
      const detail = item.kind === 'late-old-quote-overwrote-page'
        ? `目标 seq=${item.targetSeq}，页面最终可见 seq=${item.visibleAfter}`
        : item.message ?? item.kind;
      lines.push(`- ${item.side} 第 ${item.attempt ?? '-'} 次：${item.kind}（${detail}）`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export { REASON, REASON_LABELS, isLive };
