// 门户行为测试：这些是取证工具依赖的“可见事实”，不能靠猜。
//
// 1. 确认页的控件修改确实触发异步报价；旧配送报价晚回时会覆盖页面。
// 2. 每个隔离上下文有自己的草稿与篮子版本，上一会话的草稿不会带进本轮。
// 3. 工具只发 GET：不触碰任何下单/控制接口；门户本身也拒绝非 GET。
// 4. 刷新会从草稿恢复表单，但不会重放上一会话的报价，必须重新计算。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { start, sendJson } from '../source-server.mjs';
import { makePortal } from '../portal.mjs';
import { trackQuoteRequests } from '../lib/collect.mjs';

async function withSite(t) {
  const { server, url } = await start({ portal: makePortal(sendJson) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return { url, browser };
}

test('确认页控件触发异步报价，旧配送报价可能晚回覆盖页面', async (t) => {
  const { url, browser } = await withSite(t);
  const page = await browser.newPage();
  await page.goto(url + '/checkout');
  const tracker = trackQuoteRequests(page, url);
  t.after(() => tracker.stop());

  // 送货报价要 450ms 才返回；在它返回前就切回“到店”，让旧报价晚回。
  const deliverySent = page.waitForRequest(
    (request) => request.url().includes('/checkout/quote?') && request.url().includes('fulfillment=%E9%80%81%E8%B4%A7'),
  );
  const deliveryDone = page.waitForResponse(
    (response) => response.url().includes('/checkout/quote?') && response.url().includes('fulfillment=%E9%80%81%E8%B4%A7'),
  );
  await page.getByLabel('取货').selectOption('送货');
  await deliverySent;
  await page.getByLabel('取货').selectOption('到店');
  await page.getByText('不适用', { exact: true }).waitFor();
  const store = tracker.entries.filter((entry) => entry.conditions.fulfillment === '到店').at(-1);
  const delivery = tracker.entries.find((entry) => entry.conditions.fulfillment === '送货');
  assert.ok(delivery && store && store.seq > delivery.seq);

  // 站点故意让送货报价晚于到店报价返回：页面先显示到店，随后被旧报价覆盖。
  await deliveryDone;
  await page.getByText('尚未返回', { exact: true }).waitFor();
  assert.ok(delivery.respondedAt > store.respondedAt, '乱序返回是演练站的可观察事实');
  assert.equal(await page.getByLabel('取货').inputValue(), '到店', '表单仍是到店，但页面已被旧报价覆盖');
  assert.deepEqual(tracker.mutations, [], '读取过程不应发出任何写请求');
});

test('两个隔离上下文各自持有草稿，上一会话的草稿不会带进本轮', async (t) => {
  const { url, browser } = await withSite(t);
  const first = await browser.newContext();
  const second = await browser.newContext();
  t.after(() => Promise.all([first.close(), second.close()]));

  const a = await first.newPage();
  await a.goto(url + '/checkout');
  await a.getByLabel('买家条件').selectOption('会员');
  await a.getByText('不适用', { exact: true }).waitFor();
  await a.waitForTimeout(150);
  assert.match(await a.evaluate(() => sessionStorage.getItem('checkoutDraft')), /会员/);

  const b = await second.newPage();
  await b.goto(url + '/checkout');
  assert.equal(await b.getByLabel('买家条件').inputValue(), '普通', '新会话不应继承上一会话的草稿');
  assert.equal(await b.evaluate(() => sessionStorage.getItem('checkoutDraft')), null);
});

test('确认页拒绝非 GET 请求', async (t) => {
  const { url } = await withSite(t);
  const response = await fetch(url + '/checkout', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.match((await response.json()).error, /仅供查看/);
});

test('刷新从草稿恢复表单，但不重放旧报价', async (t) => {
  const { url, browser } = await withSite(t);
  const page = await browser.newPage();
  await page.goto(url + '/checkout');
  const tracker = trackQuoteRequests(page, url);
  t.after(() => tracker.stop());

  await page.getByLabel('商品').selectOption('K3');
  await page.getByText('不适用', { exact: true }).waitFor();
  await page.waitForTimeout(150);
  assert.match(await page.locator('#quote').innerText(), /K3/);
  const versionBefore = await page.evaluate(() => sessionStorage.getItem('quoteChange'));
  const requestsBefore = tracker.entries.length;

  await page.reload();
  assert.equal(await page.getByLabel('商品').inputValue(), 'K3');
  assert.equal((await page.locator('#quote').innerText()).trim(), '', '刷新后报价区应为空');
  await page.waitForTimeout(250);
  assert.equal(tracker.entries.length, requestsBefore, '刷新本身不应重放旧报价');

  const sent = page.waitForRequest((request) => request.url().includes('/checkout/quote?'));
  await page.getByRole('button', { name: '查看报价' }).click();
  await sent;
  await page.getByText('不适用', { exact: true }).waitFor();
  const versionAfter = await page.evaluate(() => sessionStorage.getItem('quoteChange'));
  assert.equal(Number(versionAfter), Number(versionBefore) + 1);
  assert.match(await page.locator('#quote').innerText(), new RegExp(`篮子版本\\s*${versionAfter}`));
});
