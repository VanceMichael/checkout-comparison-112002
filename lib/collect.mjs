// 结算页报价的浏览器取证。
//
// 每个组使用独立的浏览器上下文：草稿、篮子版本计数、页面会话互不共享。
// 只通过页面上可见的控件改变条件，读取页面上可见的确认信息，不提交订单。
//
// 页面控件每次变化都会异步重算报价，旧请求可能晚于新请求返回并覆盖页面。
// 因此每次读取都绑定当前表单条件，而不是只信任某个 seq：
//   - 页面可见的买家条件/商品/数量/取货/权益必须与当前表单逐项一致；
//   - 可见篮子版本不早于目标请求；
//   - 没有其他条件的报价请求仍在途（它随时可能晚回并覆盖页面）；
//   - 页面已安静一小段时间。
// 目标报价显示过之后若又被旧条件的报价覆盖，立即隔离这次读取、关闭上下文，
// 在不超出本轮剩余时间的前提下重新采一次。晚回的旧配送报价不会污染证据，
// 也不会耗尽整轮预算。
//
// 额外保留的网络事件序列（requests）会写入隔离记录，供复核员判断是哪一次读取被丢弃。

import { makeEvidence, checkAgainstPlan } from './evidence.mjs';

const QUOTE_SELECTOR = '#quote';
const FORM_SELECTOR = 'form';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读取当前页面上可见的报价行、会话条件与加载状态。 */
export async function readPage(page) {
  return page.evaluate(({ quoteSelector, formSelector }) => {
    const list = document.querySelector(quoteSelector);
    const rows = [];
    if (list) {
      let index = 0;
      for (const child of list.children) {
        if (child.tagName !== 'DT') continue;
        const value = child.nextElementSibling;
        rows.push({
          label: child.textContent.trim(),
          value: value && value.tagName === 'DD' ? value.textContent.trim() : '',
          index,
        });
        index += 1;
      }
    }
    const form = document.querySelector(formSelector);
    return {
      url: location.href,
      title: document.title,
      loading: list ? list.textContent.trim() === '正在核算' : true,
      rows,
      form: form ? Object.fromEntries(new FormData(form)) : {},
      draft: sessionStorage.getItem('checkoutDraft'),
      quoteChange: sessionStorage.getItem('quoteChange'),
      visibleBasketVersion: rows.find((row) => row.label === '篮子版本')?.value ?? null,
      visibleText: list ? list.textContent.trim() : '',
    };
  }, { quoteSelector: QUOTE_SELECTOR, formSelector: FORM_SELECTOR });
}

function versionOf(rows) {
  return rows.find((row) => row.label === '篮子版本')?.value ?? null;
}

/** 把表单值排成稳定签名，用来判断某次报价请求是否属于当前条件。 */
export function signatureOf(values) {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function parseQuoteUrl(raw) {
  try {
    const url = new URL(raw);
    if (!url.pathname.endsWith('/checkout/quote')) return null;
    const seq = Number(url.searchParams.get('seq'));
    if (!Number.isInteger(seq)) return null;
    const conditions = {};
    for (const [key, value] of url.searchParams) {
      if (key !== 'seq') conditions[key] = value;
    }
    return { seq, conditions, signature: signatureOf(conditions) };
  } catch {
    return null;
  }
}

/**
 * 记录本页所有报价请求的发出与返回顺序，用于识别晚回的旧报价。
 * 只观察网络事件，不修改页面脚本；同时记录任何试图改变来源的请求。
 */
export function trackQuoteRequests(page, baseUrl = null) {
  const entries = [];
  const mutations = [];
  const bySeq = new Map();
  const record = (request, respondedAt, status, failed = false) => {
    if (baseUrl && request.method() !== 'GET' && request.url().startsWith(baseUrl)) {
      mutations.push({ method: request.method(), url: request.url(), at: Date.now() });
    }
    const parsed = parseQuoteUrl(request.url());
    if (!parsed) return;
    let entry = bySeq.get(parsed.seq);
    if (!entry) {
      entry = { ...parsed, url: request.url(), requestedAt: Date.now(), respondedAt: null };
      bySeq.set(parsed.seq, entry);
      entries.push(entry);
    }
    if (respondedAt !== null) {
      entry.respondedAt = respondedAt;
      entry.status = status;
      entry.failed = failed;
    }
  };
  const onRequest = (request) => record(request, null, null);
  const onResponse = (response) => record(response.request(), Date.now(), response.status());
  const onFailed = (request) => record(request, Date.now(), null, true);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  return {
    entries,
    mutations,
    pending: () => entries.filter((entry) => entry.respondedAt === null),
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
    },
  };
}

/**
 * 按监测计划在页面上设置条件；只碰可见控件。
 * 取货方式最后设置，避免先触发一轮慢的配送核算。
 */
export async function applyConditions(page, conditions) {
  await page.getByLabel('买家条件').selectOption(conditions.subject);
  await page.getByLabel('商品').selectOption(conditions.sku);
  const quantity = page.getByLabel('数量');
  await quantity.fill(String(conditions.quantity));
  await quantity.press('Tab');
  await page.getByLabel('领取包邮权益').setChecked(Boolean(conditions.benefit));
  await page.getByLabel('取货').selectOption(conditions.fulfillment);
}

/** 用页面报价行反推表单字段，判断可见报价是否确实属于当前表单条件。 */
export function rowsMatchForm(rows, form) {
  const get = (label) => rows.find((row) => row.label === label)?.value;
  const want = {
    买家条件: form.subject,
    商品: form.sku,
    数量: String(form.quantity ?? ''),
    取货方式: form.fulfillment,
    权益: form.benefit === 'on' ? '已选' : '未选',
  };
  const problems = [];
  for (const [label, value] of Object.entries(want)) {
    const actual = get(label);
    if (actual !== undefined && actual !== value) problems.push({ label, expected: value, actual });
  }
  return problems;
}

/**
 * 让当前表单条件发出一份报价，返回目标版本。
 * 同一表单条件下可能因控件变化已发出多次请求；取最新一次为本次目标。
 * 不重复点击按钮，避免同条件请求互相竞争。
 */
export async function requestQuote(page, tracker, deadline) {
  const form = (await readPage(page)).form;
  const expected = signatureOf(form);
  if (!tracker.entries.some((entry) => entry.signature === expected)) {
    await page.getByRole('button', { name: '查看报价' }).click();
    const begin = Date.now();
    while (Date.now() - begin < Math.min(3000, Math.max(0, deadline - Date.now()))) {
      if (tracker.entries.some((entry) => entry.signature === expected)) break;
      await sleep(10);
    }
  }
  const matching = tracker.entries
    .filter((entry) => entry.signature === expected)
    .sort((a, b) => a.seq - b.seq);
  if (matching.length === 0) throw new Error('确认页没有发出当前条件下的报价请求');
  return { target: matching[matching.length - 1], expected };
}

/**
 * 等待页面稳定显示属于当前条件的报价。
 *
 * 页面只有一份报价列表，任何请求（包括其他条件的旧请求）返回都会覆盖它。
 * 因此在接受之前必须同时满足：
 *   - 页面可见的报价字段与当前表单条件一致；
 *   - 可见篮子版本不早于目标版本；
 *   - 没有其他条件的请求仍在途（它随时可能晚回并覆盖页面）；
 *   - 页面已安静一小段时间。
 * 若最后可见的报价不属于当前条件，说明被晚回的旧报价覆盖，交回重采。
 */
async function waitForStableTarget(page, tracker, target, form, timeoutAt, quietMs = 200) {
  let lastKey = null;
  let lastChange = Date.now();
  let sawGood = false;
  while (Date.now() < timeoutAt) {
    const snapshot = await readPage(page);
    if (!snapshot.loading && snapshot.rows.length > 0) {
      const version = versionOf(snapshot.rows);
      const mismatches = rowsMatchForm(snapshot.rows, form);
      const key = `${version}|${mismatches.length ? 'stale' : 'ok'}`;
      if (key !== lastKey) {
        lastKey = key;
        lastChange = Date.now();
      }
      if (mismatches.length === 0 && Number(version) >= target.seq) sawGood = true;
      if (sawGood && mismatches.length > 0) {
        // 目标报价已经显示过，随后被其他条件的报价覆盖：晚回污染，立刻隔离。
        return { snapshot: null, ok: false, stale: true, visibleVersion: version, visibleProblems: mismatches };
      }
      const pendingOther = tracker.pending().filter((entry) => entry.signature !== target.signature);
      const acceptable =
        mismatches.length === 0 &&
        Number(version) >= target.seq &&
        pendingOther.length === 0 &&
        Date.now() - lastChange >= quietMs;
      if (acceptable) {
        return { snapshot, ok: true, stale: false, visibleVersion: version };
      }
    }
    await sleep(20);
  }
  const last = await readPage(page);
  return {
    snapshot: null,
    ok: false,
    stale: false,
    visibleVersion: versionOf(last.rows),
    visibleProblems: rowsMatchForm(last.rows, form),
  };
}

/**
 * 在单个隔离上下文中采集一组报价。
 * @returns {Promise<{evidence: object|null, quarantine: object[], attempts: number, reason?: string}>}
 */
export async function collectSide({
  browser,
  baseUrl,
  side,
  conditions,
  plan,
  deadline,
  maxAttempts = 3,
  attemptTimeoutMs = 10_000,
  beforeCollect = null,
}) {
  const quarantine = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (deadline - Date.now() < 500) {
      quarantine.push({ side, attempt, kind: 'budget-exhausted' });
      break;
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const tracker = trackQuoteRequests(page, baseUrl);
    try {
      await page.goto(baseUrl + '/checkout', { waitUntil: 'domcontentloaded' });
      if (beforeCollect) await beforeCollect({ side, attempt, page, context });
      await applyConditions(page, conditions);

      const attemptDeadline = Math.min(deadline, Date.now() + attemptTimeoutMs);
      const { target, expected } = await requestQuote(page, tracker, attemptDeadline);
      const reading = await waitForStableTarget(page, tracker, target, (await readPage(page)).form, attemptDeadline);
      if (!reading.snapshot) {
        const stale = reading.stale || (reading.visibleProblems && reading.visibleProblems.length > 0);
        quarantine.push({
          side,
          attempt,
          kind: stale ? 'late-old-quote-overwrote-page' : 'target-not-rendered',
          targetSeq: target.seq,
          visibleAfter: reading.visibleVersion,
          visibleProblems: reading.visibleProblems,
          requests: tracker.entries,
        });
        continue;
      }
      const snapshot = reading.snapshot;
      // 页面最终可见的版本可能比锁定目标更新（同条件下的重复请求），以页面为准。
      const acceptedSeq = Number(reading.visibleVersion);

      // 其他条件的旧报价若在本轮页面被接受之后才返回，同样属于污染，隔离。
      const acceptedEntry = tracker.entries.find((entry) => entry.seq === acceptedSeq);
      const lateStale = tracker.entries.filter(
        (entry) =>
          entry.signature !== expected &&
          entry.respondedAt !== null &&
          acceptedEntry &&
          entry.respondedAt > acceptedEntry.respondedAt,
      );
      if (lateStale.length) {
        quarantine.push({
          side,
          attempt,
          kind: 'late-old-quote',
          targetSeq: target.seq,
          acceptedSeq,
          lateSeqs: lateStale.map((entry) => entry.seq),
          visibleAfter: reading.visibleVersion,
          requests: tracker.entries,
        });
        continue;
      }

      const observedAt = Date.now();
      const evidence = makeEvidence({
        side,
        rows: snapshot.rows,
        session: {
          side,
          conditions,
          form: snapshot.form,
          draft: snapshot.draft,
          quoteChange: snapshot.quoteChange,
          basketVersion: String(acceptedSeq),
        },
        context: {
          url: snapshot.url,
          title: snapshot.title,
          selector: QUOTE_SELECTOR,
          visibleBasketVersion: versionOf(snapshot.rows),
          visibleText: snapshot.visibleText,
        },
        observedAt,
      });
      const problems = checkAgainstPlan(evidence, plan, side);
      if (problems.length) {
        quarantine.push({ side, attempt, kind: 'conditions-not-as-visible', problems });
        continue;
      }
      if (tracker.mutations.length) {
        quarantine.push({ side, attempt, kind: 'unexpected-mutation', mutations: tracker.mutations });
        continue;
      }
      return { evidence, quarantine, attempts: attempt };
    } catch (error) {
      quarantine.push({ side, attempt, kind: 'browser-error', message: String(error?.message ?? error) });
    } finally {
      tracker.stop();
      await context.close();
    }
  }
  return { evidence: null, quarantine, attempts: Math.min(maxAttempts, quarantine.length || 1), reason: 'no-stable-reading' };
}
