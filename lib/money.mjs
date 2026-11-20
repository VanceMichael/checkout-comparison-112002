// 金额与字段口径。
//
// 报价页上的金额字段只有三种可核对状态：
//   - 数值（value）：来源明确给出的金额，单位为元，内部存为整数分。
//   - 尚未返回（unknown）：来源还没核算出来，是“未知”，绝不能当零。
//   - 不适用（not-applicable）：该条件组合下这一项根本不成立（例如自取没有运费）。
// 另外还有“来源明确为零”的 value=0，它与“不适用”“尚未返回”都不同。
//
// 结算总额只能在同一口径下比较：两组都拿到数值、且分项集合相同。
// 任何一侧有未知项都不能补零，只能判定为不可比。

export const VALUE = 'value';
export const UNKNOWN = 'unknown';
export const NOT_APPLICABLE = 'not-applicable';

const YUAN = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

/**
 * 把页面上显示的金额解析成带口径的值。
 * @param {unknown} raw 页面原始值
 * @returns {{state: string, cents?: number, text: string}}
 */
export function parseMoney(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { state: UNKNOWN, text: String(raw) };
    return { state: VALUE, cents: Math.round(raw * 100), text: String(raw) };
  }
  const text = String(raw ?? '').trim();
  if (text === '') return { state: UNKNOWN, text };
  if (text === '尚未返回' || text === '待核算') return { state: UNKNOWN, text };
  if (text === '不适用') return { state: NOT_APPLICABLE, text };
  const match = YUAN.exec(text);
  if (!match) return { state: UNKNOWN, text };
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = Number(match[2]) * 100 + Number(fraction);
  return { state: VALUE, cents: match[1] === '-' ? -cents : cents, text };
}

/** 把解析后的金额写回人可复核的中文。 */
export function describeMoney(cell) {
  if (cell.state === VALUE) return `¥${(cell.cents / 100).toFixed(2)}`;
  if (cell.state === NOT_APPLICABLE) return '不适用';
  return '尚未返回';
}

/** 两笔金额是否可相减；只有同为明确数值时才可以。 */
export function subtractMoney(a, b) {
  if (a?.state !== VALUE || b?.state !== VALUE) return null;
  return a.cents - b.cents;
}

/** 某个字段是否属于金额字段。 */
export function isAmountField(field) {
  return typeof field === 'string' && field.endsWith('（元）');
}
