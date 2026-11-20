// 金额口径与可比较性判定的单元测试。
// 这些判定不依赖浏览器，先把“未知 / 零 / 不适用”和四类不可比原因钉住。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseMoney,
  describeMoney,
  subtractMoney,
  VALUE,
  UNKNOWN,
  NOT_APPLICABLE,
} from '../lib/money.mjs';
import {
  compareEvidence,
  makeEvidence,
  REASON,
  checkSessionConsistency,
} from '../lib/evidence.mjs';
import { validatePlan, conditionsFor, PlanError } from '../lib/plan.mjs';

test('金额的三种口径互不混同', () => {
  assert.deepEqual(parseMoney('74'), { state: VALUE, cents: 7400, text: '74' });
  assert.deepEqual(parseMoney('9.5'), { state: VALUE, cents: 950, text: '9.5' });
  assert.deepEqual(parseMoney('0'), { state: VALUE, cents: 0, text: '0' });
  assert.equal(parseMoney('尚未返回').state, UNKNOWN);
  assert.equal(parseMoney('待核算').state, UNKNOWN);
  assert.equal(parseMoney('不适用').state, NOT_APPLICABLE);
  assert.equal(parseMoney('').state, UNKNOWN);
  assert.equal(parseMoney('免运费').state, UNKNOWN);
  assert.equal(describeMoney(parseMoney('0')), '¥0.00');
  assert.equal(describeMoney(parseMoney('不适用')), '不适用');
  assert.equal(describeMoney(parseMoney('尚未返回')), '尚未返回');
  assert.equal(subtractMoney(parseMoney('74'), parseMoney('70')), 400);
  assert.equal(subtractMoney(parseMoney('74'), parseMoney('不适用')), null);
  assert.equal(subtractMoney(parseMoney('0'), parseMoney('尚未返回')), null);
});

const baseFields = (overrides = {}) => ({
  商户: '雪岸行',
  商品: 'K2',
  数量: '2',
  买家条件: '普通',
  取货方式: '到店',
  权益: '未选',
  权益条件: '仅用于本篮子配送',
  货架规则: 'R1',
  篮子版本: '3',
  '货款（元）': '74',
  '运费（元）': '不适用',
  '报价（元）': '74',
  计价币种: 'CNY',
  起效时刻: '2026-11-20T10:00:00.000Z',
  截止时刻: '2026-11-20T10:01:00.000Z',
  ...overrides,
});

function evidence(side, fields) {
  const { rows } = buildRows(fields);
  return makeEvidence({
    side,
    rows,
    session: { side, conditions: {}, form: {}, basketVersion: fields['篮子版本'] },
    context: { url: 'http://127.0.0.1/checkout', title: '雪岸行 · 报价确认', selector: '#quote' },
    observedAt: Date.parse('2026-11-20T10:00:30.000Z'),
  });
}

function buildRows(fields) {
  return {
    rows: Object.entries(fields).map(([label, value], index) => ({ label, value: String(value), index })),
  };
}

const at = Date.parse('2026-11-20T10:00:30.000Z');

test('同一篮子、同一规则、同一有效期内的两组可以比较', () => {
  const control = evidence('control', baseFields());
  const variant = evidence('variant', baseFields({ 买家条件: '会员', '货款（元）': '70', '报价（元）': '70' }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, true, JSON.stringify(result.blockers));
  const total = result.amounts.find((row) => row.field === '报价（元）');
  assert.equal(total.control.cents, 7400);
  assert.equal(total.variant.cents, 7000);
  const shipping = result.amounts.find((row) => row.field === '运费（元）');
  assert.equal(shipping.control.state, NOT_APPLICABLE);
  assert.equal(subtractMoney(shipping.control, shipping.variant), null, '不适用不能相减');
});

test('未知费用不能按零补齐', () => {
  const control = evidence('control', baseFields({ 取货方式: '送货', 货架规则: 'R1', '运费（元）': '9', '报价（元）': '83' }));
  const variant = evidence('variant', baseFields({
    买家条件: '会员', 取货方式: '送货', '运费（元）': '尚未返回', '报价（元）': '待核算',
  }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, false);
  assert.equal(result.reason, REASON.DISCLOSURE);
  assert.match(result.blockers[0].message, /尚未返回|待核算|报价（元）|运费（元）/);
});

test('来源明确为零与不适用不是同一口径', () => {
  const control = evidence('control', baseFields({ 取货方式: '送货', 权益: '已选', '运费（元）': '0', '报价（元）': '74' }));
  const variant = evidence('variant', baseFields({
    买家条件: '会员', 取货方式: '送货', 权益: '已选', '货款（元）': '70', '运费（元）': '不适用', '报价（元）': '70',
  }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, false);
  assert.equal(result.reason, REASON.TERMS);
});

test('主体不同判为主体不对', () => {
  const control = evidence('control', baseFields());
  const variant = evidence('variant', baseFields({ 买家条件: '会员', 商品: 'K3', 数量: '1', '货款（元）': '46', '报价（元）': '46' }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, false);
  assert.equal(result.reason, REASON.SUBJECT);
});

test('中途切换取货方式造成不同运费时不能并入原对照', () => {
  const control = evidence('control', baseFields());
  const variant = evidence('variant', baseFields({
    买家条件: '会员', 取货方式: '送货', '货款（元）': '70', '运费（元）': '9', '报价（元）': '79',
  }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, false);
  assert.equal(result.reason, REASON.TERMS);
  assert.ok(result.blockers.some((item) => item.reason === REASON.TERMS && /取货方式/.test(item.message)));
});

test('货架规则改版判为条款不同，不能写成歧视结论', () => {
  const control = evidence('control', baseFields());
  const variant = evidence('variant', baseFields({ 买家条件: '会员', 货架规则: 'R2', '货款（元）': '70', '报价（元）': '70' }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, false);
  assert.equal(result.reason, REASON.RULES_REVISED);
});

test('只有一组过期时判为时间范围不重合，并保留原因', () => {
  const control = evidence('control', baseFields({ 截止时刻: '2026-11-20T10:00:20.000Z' }));
  const variant = evidence('variant', baseFields({ 买家条件: '会员', '货款（元）': '70', '报价（元）': '70' }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at });
  assert.equal(result.comparable, false);
  assert.equal(result.reason, REASON.EXPIRED);
  assert.ok(result.blockers.some((item) => /对照组/.test(item.message)));
});

test('两组有效期不重叠判为时间范围不重合', () => {
  const control = evidence('control', baseFields({
    起效时刻: '2026-11-20T10:00:00.000Z', 截止时刻: '2026-11-20T10:00:10.000Z',
  }));
  const variant = evidence('variant', baseFields({
    买家条件: '会员', 起效时刻: '2026-11-20T10:00:20.000Z', 截止时刻: '2026-11-20T10:00:40.000Z',
    '货款（元）': '70', '报价（元）': '70',
  }));
  const result = compareEvidence({ control, variant, onlyDiff: '会员条件', at: Date.parse('2026-11-20T10:00:30.000Z') });
  assert.equal(result.comparable, false);
  assert.ok(result.blockers.some((item) => item.reason === REASON.TIME));
});

test('计划只允许买家公司条件不同，其余条件必须与计划一致', () => {
  const plan = validatePlan({
    record: 'sampling-1',
    payload: {
      study: 'Q-61', onlyDiff: '会员条件', subjects: ['普通', '会员'], sku: 'K2', quantity: 2,
      merchant: '雪岸行', fulfillment: '到店', selectedBenefit: false, currency: 'CNY',
    },
  });
  assert.deepEqual(conditionsFor(plan, 'control'), {
    subject: '普通', sku: 'K2', quantity: 2, fulfillment: '到店', benefit: false,
  });
  assert.deepEqual(conditionsFor(plan, 'variant'), {
    subject: '会员', sku: 'K2', quantity: 2, fulfillment: '到店', benefit: false,
  });
});

test('不合法的计划在取证前就被拒绝', () => {
  const payload = {
    study: 'Q-x', onlyDiff: '会员条件', subjects: ['普通', '普通'], sku: 'K2', quantity: 2,
    merchant: '雪岸行', fulfillment: '到店', selectedBenefit: false, currency: 'CNY',
  };
  assert.throws(() => validatePlan({ record: 'r', payload }), PlanError);
  assert.throws(
    () => validatePlan({ record: 'r', payload: { ...payload, subjects: ['普通', '会员'], onlyDiff: '价格' } }),
    /无法对应/,
  );
  assert.throws(
    () => validatePlan({ record: 'r', payload: { ...payload, subjects: ['普通', '会员'], quantity: 0 } }),
    /quantity/,
  );
});

test('会话一致性能识别出被旧草稿或旧报价影响的读取', () => {
  const fields = baseFields();
  const { rows } = buildRows(fields);
  const good = makeEvidence({
    side: 'control', rows,
    session: {
      side: 'control', form: { subject: '普通', sku: 'K2', quantity: '2', fulfillment: '到店' },
      draft: JSON.stringify({ subject: '普通', sku: 'K2', quantity: '2', fulfillment: '到店' }),
      basketVersion: '3',
    },
    context: { url: 'http://127.0.0.1/checkout', title: 't', selector: '#quote' },
    observedAt: at,
  });
  assert.deepEqual(checkSessionConsistency(good), []);

  const bad = makeEvidence({
    side: 'control', rows,
    session: {
      side: 'control', form: { subject: '普通', sku: 'K2', quantity: '3', fulfillment: '到店' },
      draft: JSON.stringify({ subject: '会员', sku: 'K2', quantity: '2', fulfillment: '到店' }),
      basketVersion: '2',
    },
    context: { url: 'http://127.0.0.1/checkout', title: 't', selector: '#quote' },
    observedAt: at,
  });
  const problems = checkSessionConsistency(bad);
  assert.ok(problems.length >= 2, JSON.stringify(problems));
});
