import { setTimeout } from 'node:timers/promises';

const page = `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>雪岸行 · 报价确认</title>
<style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:42rem;color:#21282a}label{display:block;margin:1rem 0}input,select,button{font:inherit}dt{font-weight:600}dd{margin:.25rem 0 .75rem}output{display:block;border-top:1px solid #a5b4b8;padding-top:.5rem;min-height:11rem}</style>
<h1>雪岸行报价确认</h1><form>
<label>买家条件 <select name="subject"><option>普通</option><option>会员</option></select></label>
<label>商品 <select name="sku"><option>K2</option><option>K3</option></select></label>
<label>数量 <input name="quantity" type="number" min="1" max="9" value="1"></label>
<label>取货 <select name="fulfillment"><option>到店</option><option>送货</option></select></label>
<label><input name="benefit" type="checkbox"> 领取包邮权益</label>
<button type="button">查看报价</button></form>
<output aria-live="polite"><dl id="quote"></dl></output>
<script>
const form = document.querySelector('form');
let change = Number(sessionStorage.getItem('quoteChange') || 0);
const draft = JSON.parse(sessionStorage.getItem('checkoutDraft') || '{}');
for (const name of ['subject','sku','quantity','fulfillment']) {
  if (draft[name]) form.elements[name].value = draft[name];
}
form.elements.benefit.checked = draft.benefit === 'on';
async function quote() {
  const values = new URLSearchParams(new FormData(form));
  sessionStorage.setItem('checkoutDraft', JSON.stringify(Object.fromEntries(values)));
  sessionStorage.setItem('quoteChange', String(++change));
  values.set('seq', String(change));
  document.querySelector('#quote').textContent = '正在核算';
  const result = await (await fetch('/checkout/quote?' + values)).json();
  const list = document.querySelector('#quote');
  list.replaceChildren();
  for (const [label,value] of Object.entries(result)) {
    const term = document.createElement('dt');
    const data = document.createElement('dd');
    term.textContent = label;
    data.textContent = value;
    list.append(term,data);
  }
}
form.addEventListener('change', quote);
form.querySelector('button').addEventListener('click', quote);
</script>`;

export function makePortal(sendJson) {
  return async (request, response, url, stage) => {
    if (!url.pathname.startsWith('/checkout')) return false;
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: '报价服务仅供查看' });
      return true;
    }
    if (url.pathname === '/checkout') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
      return true;
    }
    if (url.pathname === '/checkout/quote') {
      const params = url.searchParams;
      const fulfillment = params.get('fulfillment') ?? '到店';
      const subject = params.get('subject') ?? '普通';
      const sku = params.get('sku') ?? 'K2';
      const quantity = Number(params.get('quantity') ?? 1);
      const benefit = params.has('benefit');
      if (fulfillment === '送货') await setTimeout(450);
      const price = (sku === 'K2' ? 37 : 46) * quantity - (subject === '会员' ? 4 : 0);
      const shipping = fulfillment === '到店' ? '不适用' : (benefit ? 0 : (stage === 1 ? '尚未返回' : 9));
      sendJson(response, 200, {
        '商户': '雪岸行', '商品': sku, '数量': quantity, '买家条件': subject, '取货方式': fulfillment,
        '权益': benefit ? '已选' : '未选', '权益条件': '仅用于本篮子配送', '货架规则': 'R' + (stage >= 3 ? 2 : 1),
        '篮子版本': params.get('seq') ?? '0', '货款（元）': price, '运费（元）': shipping,
        '报价（元）': shipping === '尚未返回' ? '待核算' : price + (Number(shipping) || 0),
        '计价币种': 'CNY', '起效时刻': new Date().toISOString(),
        '截止时刻': new Date(Date.now() + (stage === 4 && subject === '普通' ? 900 : 60_000)).toISOString(),
      });
      return true;
    }
    sendJson(response, 404, { error: '未找到报价页' });
    return true;
  };
}
