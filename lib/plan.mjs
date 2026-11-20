// 从来源读取监测计划，并在开始取证前校验它确实只改变一个对照条件。
//
// 来源里的 order-study 记录描述“预先确定的合成买家条件”。
// onlyDiff 是唯一计划改变的属性；商品及数量、商户、取货方式、已选权益
// 都必须在两组之间固定，否则就不属于同一个篮子，不能拿来做比较。
//
// subjects 的两项按 onlyDiff 对应的页面字段解释：
//   会员条件 → [普通, 会员]；商品 → [K2, K3]；数量 → ['1', '2']；
//   取货方式 → [到店, 送货]；权益 → [未选, 已选]。

import { CONDITION_FIELDS } from './evidence.mjs';

const REQUIRED = [
  'study',
  'onlyDiff',
  'subjects',
  'sku',
  'quantity',
  'merchant',
  'fulfillment',
  'selectedBenefit',
  'currency',
];

const ALLOWED = {
  买家条件: ['普通', '会员'],
  商品: ['K2', 'K3'],
  数量: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  取货方式: ['到店', '送货'],
  权益: ['未选', '已选'],
};

export class PlanError extends Error {
  constructor(study, problems) {
    super(`监测计划 ${study ?? '（未命名）'} 不成立：${problems.join('；')}`);
    this.name = 'PlanError';
    this.study = study ?? null;
    this.problems = problems;
  }
}

/** 校验单条 order-study 记录，返回规范化计划或抛出 PlanError。 */
export function validatePlan(record) {
  const p = record?.payload ?? {};
  const problems = [];
  for (const key of REQUIRED) {
    if (p[key] === undefined || p[key] === null) problems.push(`缺少 ${key}`);
  }
  if (typeof p.study !== 'string' || !p.study) problems.push('study 必须是非空字符串');
  if (!Array.isArray(p.subjects) || p.subjects.length !== 2) {
    problems.push('subjects 必须恰好包含两组合成买家条件');
  } else if (new Set(p.subjects.map(String)).size !== 2) {
    problems.push('subjects 两组不能相同');
  }
  const field = CONDITION_FIELDS[p.onlyDiff];
  if (!field) {
    problems.push(`onlyDiff“${p.onlyDiff}”无法对应到可观察的页面条件`);
  } else if (Array.isArray(p.subjects) && p.subjects.length === 2) {
    for (const subject of p.subjects) {
      if (!ALLOWED[field].includes(String(subject))) {
        problems.push(`“${p.onlyDiff}”的合成条件“${subject}”不在该字段可取范围内`);
      }
    }
  }
  if (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > 9) {
    problems.push('quantity 必须是 1 至 9 的整数');
  }
  if (!['到店', '送货'].includes(p.fulfillment)) problems.push(`未知的取货方式“${p.fulfillment}”`);
  if (typeof p.selectedBenefit !== 'boolean') problems.push('selectedBenefit 必须是布尔值');
  if (p.currency !== 'CNY') problems.push('只支持 CNY 报价');
  if (problems.length) throw new PlanError(p.study, problems);

  return {
    study: p.study,
    record: record.record,
    onlyDiff: p.onlyDiff,
    field,
    subjects: p.subjects.map(String),
    sku: p.sku,
    quantity: p.quantity,
    merchant: p.merchant,
    fulfillment: p.fulfillment,
    selectedBenefit: p.selectedBenefit,
    currency: p.currency,
  };
}

/** 把计划展开成某一组的页面条件。 */
export function conditionsFor(plan, side) {
  if (side !== 'control' && side !== 'variant') throw new Error(`未知的组 ${side}`);
  const subject = plan.subjects[side === 'control' ? 0 : 1];
  return {
    subject: plan.field === '买家条件' ? subject : '普通',
    sku: plan.field === '商品' ? subject : plan.sku,
    quantity: plan.field === '数量' ? Number(subject) : plan.quantity,
    fulfillment: plan.field === '取货方式' ? subject : plan.fulfillment,
    benefit: plan.field === '权益' ? subject === '已选' : plan.selectedBenefit,
  };
}

/** 分页读完某个来源在当前的可见记录。 */
export async function loadSource(baseUrl, name, { limit = 100, fetchImpl = fetch } = {}) {
  const collected = [];
  let offset = 0;
  for (;;) {
    const response = await fetchImpl(`${baseUrl}/source/${name}?offset=${offset}&limit=${limit}`);
    if (!response.ok) throw new Error(`读取来源 ${name} 失败：HTTP ${response.status}`);
    const page = await response.json();
    collected.push(...page.records);
    if (page.next === null) return { records: collected, stage: page.stage };
    if (!(page.next > offset)) throw new Error(`来源 ${name} 的分页游标没有前进`);
    offset = page.next;
  }
}

/** 读取当前回放阶段的全部计划与提示记录。 */
export async function loadPlans(baseUrl, { fetchImpl = fetch } = {}) {
  const overview = await fetchImpl(baseUrl + '/');
  if (!overview.ok) throw new Error(`读取来源概览失败：HTTP ${overview.status}`);
  const declaredStage = (await overview.json()).stage;
  const { records, stage } = await loadSource(baseUrl, 'sampling', { fetchImpl, limit: 100 });
  if (stage !== declaredStage) throw new Error('来源概览与记录阶段不一致，回放期间可能发生了切换');

  const studies = records.filter((entry) => entry.kind === 'order-study').map(validatePlan);
  const holds = records
    .filter((entry) => entry.kind === 'hold')
    .map((entry) => ({
      record: entry.record,
      availableFrom: entry.availableFrom,
      ...entry.payload,
    }));

  const seen = new Set();
  for (const study of studies) {
    if (seen.has(study.study)) throw new PlanError(study.study, ['同一 study 出现多个生效计划']);
    seen.add(study.study);
  }
  return { stage, declaredStage, studies, holds, records };
}

/** 计划记录在当前阶段是否已经可查。 */
export function plansForStage(plans, stage) {
  return plans.studies.filter((study) => {
    const record = plans.records.find((entry) => entry.record === study.record);
    return !record || record.availableFrom <= stage;
  });
}

/** 与某个计划相关的 hint/hold 记录（仅当前阶段可见的）。 */
export function holdsFor(plans, study) {
  return plans.holds.filter((hold) => hold.study === study && hold.availableFrom <= plans.declaredStage);
}
