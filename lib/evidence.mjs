// 证据模型与可比较性判定。
//
// 一轮取证中，每个“组”（对照组 / 实验组）各自留下独立的报价证据：
// 页面上下文、会话条件、篮子版本、时间、每个金额的原始文本。
// 只有在下列条件全部成立时才允许生成比较记录：
//   1. 两组都有可用的、未过期的报价证据；
//   2. 两组的篮子身份（商户、商品、数量、取货方式、权益）可证明一致；
//   3. 两组只有计划内的一个属性不同（onlyDiff）；
//   4. 两组的条款（货架规则）相同；
//   5. 两组的时间范围有重叠，且比较时刻落在重叠区间内；
//   6. 关键披露已经收到（金额字段没有“尚未返回”），未知项不能按零补齐。
// 任何一条不成立，都给出具体不可比原因，而不是硬凑一张比较表。

import { VALUE, UNKNOWN, NOT_APPLICABLE, parseMoney, describeMoney } from './money.mjs';

/** 不可比原因。前四类与复核员需要区分的四类问题一一对应。 */
export const REASON = {
  SUBJECT: 'subject-mismatch', // 主体不对
  TERMS: 'terms-differ', // 条款不同
  TIME: 'time-disjoint', // 时间范围不重合
  DISCLOSURE: 'disclosure-missing', // 关键披露仍未收到
  EXPIRED: 'evidence-expired', // 报价已过期（时间范围不重合的一种）
  RULES_REVISED: 'rules-revised', // 对照中途货架规则改版（条款不同的一种）
  INCOMPLETE: 'evidence-incomplete', // 缺少证据，无法判断
};

export const REASON_LABELS = {
  [REASON.SUBJECT]: '主体不对',
  [REASON.TERMS]: '条款不同',
  [REASON.TIME]: '时间范围不重合',
  [REASON.DISCLOSURE]: '关键披露仍未收到',
  [REASON.EXPIRED]: '时间范围不重合：一组报价已过期',
  [REASON.RULES_REVISED]: '条款不同：对照期间货架规则改版',
  [REASON.INCOMPLETE]: '证据不完整',
};

/** 篮子身份字段：除计划内唯一改变的属性外，这些必须逐项相同。 */
export const BASKET_KEYS = ['商户', '商品', '数量', '买家条件', '取货方式', '权益'];

/** 篮子身份字段不一致时，归入“主体不对”还是“条款不同”。 */
const SUBJECT_KEYS = new Set(['商户', '商品', '数量', '买家条件']);

/** 监测计划里的 onlyDiff 到页面字段的映射。 */
export const CONDITION_FIELDS = {
  会员条件: '买家条件',
  买家条件: '买家条件',
  商品: '商品',
  数量: '数量',
  取货方式: '取货方式',
  权益: '权益',
};

function sameValue(a, b) {
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * 从页面读出的键值行构造一份证据。
 * @param {object} input
 * @param {string} input.side 组标识
 * @param {Array<{label: string, value: string, index: number}>} input.rows 页面上的标签/值行
 * @param {object} input.session 取数时的会话条件（表单值、草稿、篮子版本）
 * @param {{url: string, title: string, selector: string, visibleText?: string}} input.context 页面上下文
 * @param {number} input.observedAt 读取时刻，毫秒时间戳
 */
export function makeEvidence({ side, rows, session, context, observedAt }) {
  const fields = {};
  const amountTrace = [];
  for (const row of rows) {
    fields[row.label] = row.value;
    if (row.label.endsWith('（元）')) {
      amountTrace.push({
        field: row.label,
        raw: row.value,
        caliber: parseMoney(row.value).state,
        pageUrl: context.url,
        pageTitle: context.title,
        selector: `${context.selector} > dt:nth-of-type(${row.index + 1}) + dd`,
        observedAt: new Date(observedAt).toISOString(),
        basketVersion: fields['篮子版本'] ?? null,
        ruleSet: fields['货架规则'] ?? null,
        session,
      });
    }
  }
  const start = Date.parse(fields['起效时刻']);
  const end = Date.parse(fields['截止时刻']);
  return {
    side,
    context,
    session,
    observedAt,
    observedAtIso: new Date(observedAt).toISOString(),
    fields,
    rows,
    amountTrace,
    basketVersion: fields['篮子版本'] ?? null,
    ruleSet: fields['货架规则'] ?? null,
    notBefore: Number.isFinite(start) ? start : null,
    notAfter: Number.isFinite(end) ? end : null,
  };
}

/** 证据在给定时刻是否仍处于其声明的有效期内。 */
export function isLive(evidence, at) {
  if (!evidence) return false;
  if (!Number.isFinite(evidence.notBefore) || !Number.isFinite(evidence.notAfter)) return false;
  return at >= evidence.notBefore && at <= evidence.notAfter;
}

/** 某一组证据的金额字段及其口径。 */
export function moneyCells(evidence) {
  const cells = {};
  for (const [key, raw] of Object.entries(evidence?.fields ?? {})) {
    if (key.endsWith('（元）')) cells[key] = parseMoney(raw);
  }
  return cells;
}

/** 会话一致性能同时发现三类问题：表单与报价不符、草稿与当前条件不符、版本号对不上。 */
export function checkSessionConsistency(evidence) {
  const { fields, session } = evidence;
  const form = session?.form ?? {};
  const problems = [];
  const expect = (field, actual, wanted) => {
    if (!sameValue(actual, wanted)) problems.push(`报价字段“${field}”=${actual ?? '缺失'}，表单=${wanted ?? '缺失'}`);
  };
  expect('买家条件', fields['买家条件'], form.subject);
  expect('商品', fields['商品'], form.sku);
  expect('数量', fields['数量'], form.quantity);
  expect('取货方式', fields['取货方式'], form.fulfillment);
  expect('权益', fields['权益'], form.benefit === 'on' ? '已选' : '未选');
  expect('篮子版本', fields['篮子版本'], session?.basketVersion);
  if (session?.draft !== undefined && session.draft !== null) {
    let draft = null;
    try {
      draft = JSON.parse(session.draft);
    } catch {
      problems.push('会话草稿不是可解析的 JSON');
    }
    if (draft) {
      expect('买家条件', fields['买家条件'], draft.subject);
      expect('商品', fields['商品'], draft.sku);
      expect('数量', fields['数量'], draft.quantity);
      expect('取货方式', fields['取货方式'], draft.fulfillment);
      expect('权益', fields['权益'], draft.benefit === 'on' ? '已选' : '未选');
    }
  }
  return problems;
}

function block(reason, message) {
  return { reason, label: REASON_LABELS[reason], message };
}

/** 原因按复核优先级排序，最前面作为主要结论。 */
const SEVERITY = [
  REASON.SUBJECT,
  REASON.RULES_REVISED,
  REASON.TERMS,
  REASON.EXPIRED,
  REASON.TIME,
  REASON.DISCLOSURE,
  REASON.INCOMPLETE,
];

/**
 * 比较同一篮子下两组证据。
 * @param {object} input
 * @param {object} input.control 对照组证据
 * @param {object} input.variant 实验组证据
 * @param {string} input.onlyDiff 监测计划里唯一允许改变的属性
 * @param {number} [input.at] 比较时刻
 * @param {Array<object>} [input.holds] 当前阶段对同一计划生效的 hold 记录
 */
export function compareEvidence({ control, variant, onlyDiff, at = Date.now(), holds = [] }) {
  if (!control || !variant) {
    return {
      comparable: false,
      reason: REASON.INCOMPLETE,
      label: REASON_LABELS[REASON.INCOMPLETE],
      blockers: [block(REASON.INCOMPLETE, '缺少至少一组的报价证据')],
      amounts: null,
    };
  }

  const blockers = [];
  const planned = CONDITION_FIELDS[onlyDiff];
  if (!planned) {
    blockers.push(block(REASON.TERMS, `监测计划的对照属性“${onlyDiff}”无法对应到页面字段`));
  }

  // 主体/篮子：除计划内属性外必须逐项相同。
  for (const key of BASKET_KEYS) {
    if (key === planned) continue;
    if (!sameValue(control.fields[key], variant.fields[key])) {
      const subjectKey = SUBJECT_KEYS.has(key);
      const note =
        key === '取货方式'
          ? '对照期间取货方式被改变，两组各自留证，但不并入原对照'
          : subjectKey
            ? '篮子的主体不同'
            : '篮子的条款条件不同';
      blockers.push(
        block(
          subjectKey ? REASON.SUBJECT : REASON.TERMS,
          `${note}：“${key}”${control.fields[key] ?? '（缺失）'} vs ${variant.fields[key] ?? '（缺失）'}`,
        ),
      );
    }
  }
  if (planned && sameValue(control.fields[planned], variant.fields[planned])) {
    blockers.push(block(REASON.TERMS, `计划改变的“${planned}”在两组中反而相同，不能证明对照发生`));
  }

  // 条款：货架规则中途改版时，两份报价不是同一套条款下的观察。
  if (!control.ruleSet || !variant.ruleSet) {
    blockers.push(block(REASON.INCOMPLETE, '缺少货架规则标识，无法证明条款相同'));
  } else if (control.ruleSet !== variant.ruleSet) {
    blockers.push(
      block(
        REASON.RULES_REVISED,
        `对照期间货架规则从 ${control.ruleSet} 变为 ${variant.ruleSet}，不能用新旧两次报价写成差异结论`,
      ),
    );
  }
  for (const hold of holds) {
    blockers.push(
      block(
        REASON.RULES_REVISED,
        `计划 ${hold.study} 当前受 hold 约束：${hold.observation ?? '需要按新计划重新对照'}`,
      ),
    );
  }

  // 时间：两份报价的有效期必须重叠，且比较时刻落在共同有效期内。
  let overlapStart = null;
  let overlapEnd = null;
  const haveWindows = [control.notBefore, control.notAfter, variant.notBefore, variant.notAfter].every(Number.isFinite);
  if (!haveWindows) {
    blockers.push(block(REASON.INCOMPLETE, '缺少报价有效期，无法证明时间范围'));
  } else {
    overlapStart = Math.max(control.notBefore, variant.notBefore);
    overlapEnd = Math.min(control.notAfter, variant.notAfter);
    if (!isLive(control, at) || !isLive(variant, at)) {
      const expired = [isLive(control, at) ? null : '对照组', isLive(variant, at) ? null : '实验组'].filter(Boolean);
      blockers.push(block(REASON.EXPIRED, `${expired.join('、')}报价在比较时刻已过期；已采到的另一组证据单独保留`));
    }
    if (!(overlapStart <= overlapEnd)) {
      blockers.push(block(REASON.TIME, '两组报价有效期没有重叠'));
    } else if (at < overlapStart || at > overlapEnd) {
      blockers.push(block(REASON.TIME, '比较时刻不在两组共同有效期内'));
    }
  }

  // 披露：金额必须来自明确数值；未知项不能用零补齐。
  const a = moneyCells(control);
  const b = moneyCells(variant);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const missing = [];
  const amounts = [];
  for (const key of [...keys].sort()) {
    if (!(key in a) || !(key in b)) {
      missing.push(`${key}（只有一侧提供）`);
      continue;
    }
    amounts.push({ field: key, control: a[key], variant: b[key] });
    if (a[key].state === UNKNOWN || b[key].state === UNKNOWN) {
      missing.push(key);
    } else if (a[key].state !== b[key].state) {
      blockers.push(
        block(
          REASON.TERMS,
          `“${key}”在两组的口径不同：${describeMoney(a[key])} vs ${describeMoney(b[key])}`,
        ),
      );
    }
  }
  if (missing.length) {
    blockers.push(block(REASON.DISCLOSURE, `关键披露仍未收到：${[...new Set(missing)].join('、')}`));
  }

  // 同口径下核对“报价 = 货款 + 运费”；分项齐备却不相等时，总额不可直接采信。
  const total = a['报价（元）'];
  const goods = a['货款（元）'];
  const shipping = a['运费（元）'];
  if (
    total?.state === VALUE && goods?.state === VALUE &&
    shipping?.state === VALUE && b['报价（元）']?.state === VALUE
  ) {
    for (const side of ['control', 'variant']) {
      const cells = side === 'control' ? a : b;
      if (cells['报价（元）'].cents !== cells['货款（元）'].cents + cells['运费（元）'].cents) {
        blockers.push(block(REASON.TERMS, `${side} 的“报价（元）”与分项之和不一致，总额口径不可采信`));
      }
    }
  }

  if (blockers.length) {
    blockers.sort((x, y) => SEVERITY.indexOf(x.reason) - SEVERITY.indexOf(y.reason));
    return {
      comparable: false,
      reason: blockers[0].reason,
      label: blockers[0].label,
      blockers,
      amounts,
    };
  }

  return {
    comparable: true,
    blockers: [],
    amounts,
    overlap: { start: overlapStart, end: overlapEnd },
  };
}

/** 逐字段核对一组证据是否如实描述了计划给这一组规定的条件。 */
export function checkAgainstPlan(evidence, plan, side = 'control') {
  if (side !== 'control' && side !== 'variant') throw new Error(`未知的组 ${side}`);
  const planned = CONDITION_FIELDS[plan.onlyDiff];
  const subject = plan.subjects?.[side === 'control' ? 0 : 1];
  const expected = {
    // 计划未点名买家条件时，两组都用页面的默认买家条件。
    买家条件: planned === '买家条件' ? subject : '普通',
    商户: plan.merchant,
    商品: planned === '商品' ? subject : plan.sku,
    数量: planned === '数量' ? Number(subject) : plan.quantity,
    取货方式: planned === '取货方式' ? subject : plan.fulfillment,
    权益: planned === '权益' ? subject : plan.selectedBenefit ? '已选' : '未选',
  };  const problems = [];
  for (const [key, want] of Object.entries(expected)) {
    if (!sameValue(evidence.fields[key], want)) {
      problems.push({ field: key, expected: want, actual: evidence.fields[key] ?? null });
    }
  }
  return problems;
}

export { NOT_APPLICABLE, VALUE, UNKNOWN };
