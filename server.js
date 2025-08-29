// server.js — Unique Auto Trader (single-file app)

// Load dependencies
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config(); // to load secrets if you add .env later

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory database (paper trades, positions, orders, reports)
let state = {
  mode: {
    crypto: "paper",  // or "live"
    stocks: "paper"
  },
  fxRate: 83.0, // USD to INR (default, can update via API)
  orders: [],
  positions: {},
  reports: []
};

// Serve static HTML/JS from a single endpoint
app.get('/', (req, res) => {
  res.send(generateHTML());
});
// ---------- Helpers ----------
const fetchJson = async (url, opts={}) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

const usdToInr = (usd) => Number((usd * state.fxRate).toFixed(2));

// Update USD/INR once a minute
async function refreshFx() {
  try {
    const j = await fetchJson('https://api.exchangerate.host/latest?base=USD&symbols=INR');
    const rate = Number(j?.rates?.INR);
    if (rate) state.fxRate = rate;
  } catch (_) { /* keep old rate */ }
}
setInterval(refreshFx, 60_000);
refreshFx();

// Fetch a price (crypto via CoinGecko, stocks via AlphaVantage if key present)
async function getPrice(venue, symbol) {
  if (venue === 'crypto') {
    // symbol is a coingecko id: bitcoin, ethereum, solana
    const q = new URL('https://api.coingecko.com/api/v3/coins/markets');
    q.searchParams.set('vs_currency', 'usd');
    q.searchParams.set('ids', symbol);
    const arr = await fetchJson(q.toString());
    const p = Number(arr?.[0]?.current_price || 0);
    if (!p) throw new Error('No crypto price');
    const spread = p * 0.0006;
    return { price: +p.toFixed(2), bid: +(p - spread/2).toFixed(2), ask: +(p + spread/2).toFixed(2) };
  } else if (venue === 'stock') {
    const key = process.env.ALPHAVANTAGE_KEY || '';
    if (!key) throw new Error('ALPHAVANTAGE_KEY missing (add in Replit Secrets)');
    const q = new URL('https://www.alphavantage.co/query');
    q.searchParams.set('function','GLOBAL_QUOTE');
    q.searchParams.set('symbol', symbol);
    q.searchParams.set('apikey', key);
    const j = await fetchJson(q.toString());
    const p = Number(j?.['Global Quote']?.['05. price'] || 0);
    if (!p) throw new Error('No stock price');
    const spread = p * 0.0008;
    return { price: +p.toFixed(2), bid: +(p - spread/2).toFixed(2), ask: +(p + spread/2).toFixed(2) };
  }
  throw new Error('Unknown venue');
}

// ---------- Minimal indicators & recommendation ----------
function sma(list, n){ if (list.length < n) return null; return list.slice(-n).reduce((a,b)=>a+b,0)/n; }
function simpleReco(prices){
  // BUY if last > SMA(8); SELL if last < SMA(8); else HOLD
  if (!prices || prices.length < 8) return { action: 'HOLD', reason: 'Not enough data' };
  const last = prices[prices.length - 1];
  const s = sma(prices, 8);
  if (last > s) return { action: 'BUY', reason: 'Price > SMA(8)' };
  if (last < s) return { action: 'SELL/SHORT', reason: 'Price < SMA(8)' };
  return { action: 'HOLD', reason: 'Near SMA(8)' };
}

// ---------- API: price & mode ----------
app.get('/api/price', async (req, res) => {
  try {
    const venue = String(req.query.venue || 'crypto');
    const symbol = String(req.query.symbol || 'bitcoin');
    const tick = await getPrice(venue, symbol);
    res.json({ ok: true, venue, symbol, fx: state.fxRate, ...tick });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/mode', (_req, res) => res.json({ ok:true, mode: state.mode }));
app.post('/api/mode', express.json(), (req, res) => {
  const { crypto, stocks } = req.body || {};
  if (crypto) state.mode.crypto = crypto;
  if (stocks) state.mode.stocks = stocks;
  res.json({ ok:true, mode: state.mode });
});

// ---------- WebSocket streaming (subscribe to symbols) ----------
const clients = new Map(); // ws -> { subs: Set<string> }

wss.on('connection', (ws) => {
  clients.set(ws, { subs: new Set() });

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'subscribe' && Array.isArray(msg.items)) {
        const set = clients.get(ws).subs;
        set.clear();
        for (const it of msg.items) {
          if (it?.venue && it?.symbol) set.add(`${it.venue}:${it.symbol}`);
        }
        ws.send(JSON.stringify({ type:'subscribed', items:[...set] }));
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => clients.delete(ws));
});

// broadcast ticks every 3 seconds
setInterval(async () => {
  // aggregate all requested (venue:symbol)
  const wanted = new Set();
  for (const { subs } of clients.values()) for (const k of subs) wanted.add(k);
  if (!wanted.size) return;

  for (const key of wanted) {
    const [venue, symbol] = key.split(':');
    try {
      const tick = await getPrice(venue, symbol);
      const frame = { type:'tick', venue, symbol, fx: state.fxRate, ...tick, ts: Date.now() };
      for (const [ws, info] of clients) {
        if (ws.readyState === 1 && info.subs.has(key)) ws.send(JSON.stringify(frame));
      }
    } catch (e) {
      const err = { type:'error', venue, symbol, message: e.message, ts: Date.now() };
      for (const [ws, info] of clients) {
        if (ws.readyState === 1 && info.subs.has(key)) ws.send(JSON.stringify(err));
      }
    }
  }
}, 3000);
// ---------- Paper trading (FIFO lots with minor units) ----------
const toMinor = (x, dp=2) => Math.round(Number(x) * Math.pow(10, dp));
const fromMinor = (m, dp=2) => (m / Math.pow(10, dp)).toFixed(dp);

function submitOrder({ venue, symbol, side, qty, price, mode='paper' }) {
  const o = { id: state.orders.length+1, ts: Date.now(), venue, symbol, side, qty: Number(qty), price: Number(price), mode };
  state.orders.push(o);
  return o;
}

function ensureBook(key) {
  state.positions[key] = state.positions[key] || { lots: [], realizedMinor: 0 };
  return state.positions[key];
}

function fillPaper(order) {
  const key = `${order.venue}:${order.symbol}`;
  const book = ensureBook(key);
  const pxMinor = toMinor(order.price);
  const feeMinor = toMinor(order.price * order.qty * 0.0005);

  let realized = 0;
  if (order.side === 'BUY' || order.side === 'COVER') {
    book.lots.push({ qty: order.qty, priceMinor: pxMinor, feeMinor });
  } else {
    // SELL/SHORT: close FIFO
    let remain = order.qty;
    while (remain > 0 && book.lots.length) {
      const lot = book.lots[0];
      const closeQty = Math.min(remain, lot.qty);
      realized += (pxMinor - lot.priceMinor) * closeQty;
      lot.qty -= closeQty;
      remain -= closeQty;
      if (lot.qty === 0) book.lots.shift();
    }
    realized -= feeMinor;
    book.realizedMinor += realized;
  }
  const fill = { ...order, fee: fromMinor(feeMinor), realized: fromMinor(realized) };
  state.reports.push(fill);
  return fill;
}

function positionsSummary() {
  const out = {};
  for (const [key, book] of Object.entries(state.positions)) {
    const qty = book.lots.reduce((a,b)=>a+b.qty,0);
    const costMinor = book.lots.reduce((a,b)=>a+b.priceMinor*b.qty,0);
    const avgMinor = qty ? Math.round(costMinor/qty) : 0;
    out[key] = { qty, avgPrice: Number(fromMinor(avgMinor)) };
  }
  return out;
}

// ---------- REST: paper orders & reports ----------
app.post('/api/paper/order', express.json(), async (req, res) => {
  try {
    const { venue, symbol, side, qty } = req.body || {};
    if (!venue || !symbol || !side || !qty) return res.status(400).json({ ok:false, error:'Missing fields' });
    const { price } = await getPrice(venue, symbol);
    const order = submitOrder({ venue, symbol, side, qty: Number(qty), price, mode:'paper' });
    const fill  = fillPaper(order);
    res.json({ ok:true, order, fill });
  } catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/reports', (req,res) => {
  const f = Number(req.query.from || 0);
  const t = Number(req.query.to || Date.now());
  const type = String(req.query.type || 'all');
  const within = (x) => x.ts >= f && x.ts <= t;
  const payload = {};
  if (type === 'orders' || type === 'all') payload.orders = state.orders.filter(within);
  if (type === 'fills'  || type === 'all') payload.fills  = state.reports.filter(within);
  if (type === 'positions' || type === 'all') payload.positions = positionsSummary();
  // realized across all books
  const realizedMinor = Object.values(state.positions).reduce((a,b)=>a+(b.realizedMinor||0),0);
  payload.realizedMinor = realizedMinor;
  res.json({ ok:true, ...payload });
});

// ---------- Single-file UI ----------
function generateHTML(){
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unique Auto Trader</title>
<style>
:root{--bg:#0b1220;--card:#0f182a;--text:#e5e7eb;--muted:#93a3b8;--accent:#22d3ee;--good:#10b981;--bad:#ef4444}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto;background:#0b1220;color:var(--text)}
header{padding:12px 16px;border-bottom:1px solid #1f2a3a;background:#0c1423;position:sticky;top:0}h1{font-size:18px;margin:0}
.wrap{max-width:1100px;margin:0 auto;padding:14px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.tab{padding:9px 12px;border:1px solid #213049;border-radius:10px;background:#0f172a;color:#cbd5e1;cursor:pointer}
.tab.active{background:linear-gradient(90deg,#0ea5b7,#22d3ee);color:#07121a;border-color:transparent}
.card{border:1px solid #213049;background:#0e1525;border-radius:14px;padding:12px;margin-bottom:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.kpi .box{border:1px solid #1f2a3a;border-radius:12px;background:#0f182a;padding:10px}
.kpi .t{font-size:12px;color:#9db0c9}.kpi .v{font-size:20px}
input,select,button{background:#0f172a;color:#e5e7eb;border:1px solid #26344a;border-radius:10px;padding:8px 10px}
button.primary{background:linear-gradient(90deg,#0ea5b7,#22d3ee);border:0;color:#06121a} .hidden{display:none}
.log{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#0a1120;border:1px solid #1f2a3a;padding:10px;border-radius:10px;max-height:250px;overflow:auto;white-space:pre-wrap}
.pill{padding:2px 8px;border-radius:999px;border:1px solid #2a3a52}
.grid{display:grid;grid-template-columns:1fr;gap:12px}@media(min-width:1000px){.grid{grid-template-columns:1.2fr .8fr}}
</style>
</head>
<body>
<header>
  <h1>Unique Auto Trader — Paper Demo</h1>
  <div style="color:var(--muted);font-size:12px">Switch Live later via Settings once keys are added in Replit Secrets.</div>
</header>
<div class="wrap">
  <nav>
    <div class="tab active" data-tab="summary">Summary</div>
    <div class="tab" data-tab="crypto">Crypto</div>
    <div class="tab" data-tab="stocks">Stocks (India)</div>
    <div class="tab" data-tab="orders">Orders</div>
    <div class="tab" data-tab="reports">Reports</div>
    <div class="tab" data-tab="settings">Settings</div>
  </nav>

  <section id="summary" class="card">
    <div class="kpi">
      <div class="box"><div class="t">Crypto Mode</div><div class="v" id="kModeC">Paper</div></div>
      <div class="box"><div class="t">Stocks Mode</div><div class="v" id="kModeS">Paper</div></div>
      <div class="box"><div class="t">USD/INR</div><div class="v" id="kFx">—</div></div>
      <div class="box"><div class="t">Realized P/L</div><div class="v" id="kRPL">$0.00</div></div>
    </div>
  </section>

  <div class="grid">
    <section id="crypto" class="card hidden">
      <h3 style="margin:6px 0 10px">Crypto <span class="pill" id="cModePill">Paper</span></h3>
      <div class="row">
        <select id="cSymbol">
          <option value="bitcoin">bitcoin (BTC)</option>
          <option value="ethereum">ethereum (ETH)</option>
          <option value="solana">solana (SOL)</option>
        </select>
        <button id="cStart" class="primary">Start Stream</button>
        <button id="cStop">Stop</button>
        <button id="cReco">Recommendation</button>
      </div>
      <div class="kpi" style="margin-top:10px">
        <div class="box"><div class="t">Last</div><div class="v" id="cLast">—</div></div>
        <div class="box"><div class="t">Bid</div><div class="v" id="cBid">—</div></div>
        <div class="box"><div class="t">Ask</div><div class="v" id="cAsk">—</div></div>
        <div class="box"><div class="t">Last (INR)</div><div class="v" id="cLastInr">—</div></div>
      </div>
      <div class="row" style="margin-top:8px">
        <input type="number" id="cQty" min="0.001" step="0.001" value="0.01"/>
        <button id="cBuy">Buy</button>
        <button id="cSell">Sell</button>
      </div>
      <div class="log" id="cLog"></div>
    </section>

    <section id="stocks" class="card hidden">
      <h3 style="margin:6px 0 10px">Stocks (India) <span class="pill" id="sModePill">Paper</span></h3>
      <div class="row">
        <input id="sSymbol" placeholder="RELIANCE.NS / RELIANCE.BSE" style="min-width:260px"/>
        <button id="sStart" class="primary">Start Stream</button>
        <button id="sStop">Stop</button>
        <button id="sReco">Recommendation</button>
      </div>
      <div class="kpi" style="margin-top:10px">
        <div class="box"><div class="t">Last</div><div class="v" id="sLast">—</div></div>
        <div class="box"><div class="t">Bid</div><div class="v" id="sBid">—</div></div>
        <div class="box"><div class="t">Ask</div><div class="v" id="sAsk">—</div></div>
        <div class="box"><div class="t">Last (INR)</div><div class="v" id="sLastInr">—</div></div>
      </div>
      <div class="row" style="margin-top:8px">
        <input type="number" id="sQty" min="1" step="1" value="10"/>
        <button id="sBuy">Buy</button>
        <button id="sSell">Sell</button>
      </div>
      <div class="log" id="sLog"></div>
    </section>

    <section id="orders" class="card hidden"><h3>Orders</h3><div class="log" id="oLog"></div></section>
    <section id="reports" class="card hidden">
      <h3>Reports</h3>
      <div class="row">
        <label>From <input type="datetime-local" id="rFrom"></label>
        <label>To <input type="datetime-local" id="rTo"></label>
        <select id="rType">
          <option value="all">All</option>
          <option value="orders">Orders</option>
          <option value="fills">Fills</option>
          <option value="positions">Positions</option>
        </select>
        <button id="rRun" class="primary">Run</button>
      </div>
      <div class="log" id="rLog"></div>
    </section>
  </div>

  <section id="settings" class="card hidden">
    <h3>Settings</h3>
    <div class="row">
      <label>Crypto Mode
        <select id="modeCrypto"><option value="paper">Paper</option><option value="live">Live</option></select>
      </label>
      <label>Stocks Mode
        <select id="modeStocks"><option value="paper">Paper</option><option value="live">Live</option></select>
      </label>
      <button id="save" class="primary">Save</button>
    </div>
  </section>
</div>

<script>
const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);
const subs = new Set(); const fx = { usdInr: 83.0 }; const mode = { crypto:'paper', stocks:'paper' };
function $(id){ return document.getElementById(id); }
function fmtUSD(x){ return '$'+Number(x||0).toFixed(2); }
function fmtINR(x){ return '₹'+Number(x||0).toFixed(2); }
function log(el, ...args){ el.textContent = [args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' '), el.textContent].filter(Boolean).join('\\n'); }

// Tabs
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.card').forEach(s=>s.classList.add('hidden'));
    t.classList.add('active');
    document.getElementById(t.dataset.tab).classList.remove('hidden');
  };
});

// Mode
fetch('/api/mode').then(r=>r.json()).then(j=>{
  if(j.ok){ mode.crypto=j.mode.crypto; mode.stocks=j.mode.stocks;
    $('modeCrypto').value=mode.crypto; $('modeStocks').value=mode.stocks;
    $('kModeC').textContent=cap(mode.crypto); $('kModeS').textContent=cap(mode.stocks);
    $('cModePill').textContent=cap(mode.crypto); $('sModePill').textContent=cap(mode.stocks);
  }
});
function cap(x){ return x[0].toUpperCase()+x.slice(1); }

// FX refresh via /api/price responses
function updateFx(v){ if(!v) return; fx.usdInr=v; $('kFx').textContent=v.toFixed(4); }

// WebSocket
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type==='tick'){
    updateFx(m.fx);
    const usd=m.price, inr=usd*fx.usdInr;
    const last=fmtUSD(usd), bid=fmtUSD(m.bid), ask=fmtUSD(m.ask), lastInr=fmtINR(inr);
    if (m.venue==='crypto'){ $('cLast').textContent=last; $('cBid').textContent=bid; $('cAsk').textContent=ask; $('cLastInr').textContent=lastInr; }
    else { $('sLast').textContent=last; $('sBid').textContent=bid; $('sAsk').textContent=ask; $('sLastInr').textContent=lastInr; }
  }
};

// Subscribe helper
function sendSubs(){ ws.send(JSON.stringify({ type:'subscribe', items: Array.from(subs).map(s=>{ const [venue,symbol]=s.split(':'); return { venue, symbol }; }) })); }

// Crypto controls
$('cStart').onclick = ()=>{ const id=$('cSymbol').value; subs.add('crypto:'+id); sendSubs(); log($('cLog'),'Subscribed',id); };
$('cStop').onclick  = ()=>{ const id=$('cSymbol').value; subs.delete('crypto:'+id); sendSubs(); log($('cLog'),'Unsubscribed',id); };
$('cReco').onclick  = async ()=>{ const id=$('cSymbol').value; const r=await fetch('/api/price?venue=crypto&symbol='+id).then(r=>r.json()); log($('cLog'),'Price',r); };

// Stocks controls
$('sStart').onclick = ()=>{ const s=$('sSymbol').value.trim(); if(!s) return; subs.add('stock:'+s); sendSubs(); log($('sLog'),'Subscribed',s); };
$('sStop').onclick  = ()=>{ const s=$('sSymbol').value.trim(); subs.delete('stock:'+s); sendSubs(); log($('sLog'),'Unsubscribed',s); };
$('sReco').onclick  = async ()=>{ const s=$('sSymbol').value.trim(); if(!s) return; const r=await fetch('/api/price?venue=stock&symbol='+encodeURIComponent(s)).then(r=>r.json()); log($('sLog'),'Price',r); };

// Trades (paper)
$('cBuy').onclick  = ()=> trade('crypto','BUY', Number($('cQty').value||0.01), $('cSymbol').value);
$('cSell').onclick = ()=> trade('crypto','SELL',Number($('cQty').value||0.01), $('cSymbol').value);
$('sBuy').onclick  = ()=> trade('stock','BUY', Number($('sQty').value||1), $('sSymbol').value.trim());
$('sSell').onclick = ()=> trade('stock','SELL',Number($('sQty').value||1), $('sSymbol').value.trim());
async function trade(venue, side, qty, symbol){
  const box = venue==='crypto'?$('cLog'):$('sLog');
  try{
    const r = await fetch('/api/paper/order', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ venue, symbol, side, qty }) }).then(r=>r.json());
    log(box, side, symbol, r);
    refreshOrdersAndPL();
  }catch(e){ log(box,'Trade error',String(e)); }
}

// Reports + Orders
async function refreshOrdersAndPL(){
  const j = await fetch('/api/reports?type=all').then(r=>r.json());
  $('oLog').textContent = JSON.stringify(j.orders||[], null, 2);
  $('kRPL').textContent = '$'+Number((j.realizedMinor||0)/100).toFixed(2);
}
$('rRun').onclick = async ()=>{
  const f=$('rFrom').value?new Date($('rFrom').value).getTime():0;
  const t=$('rTo').value?new Date($('rTo').value).getTime():Date.now();
  const typ=$('rType').value;
  const j=await fetch('/api/reports?from='+f+'&to='+t+'&type='+typ).then(r=>r.json());
  $('rLog').textContent = JSON.stringify(j,null,2);
};

// Settings
$('save').onclick = async ()=>{
  const payload = { crypto:$('modeCrypto').value, stocks:$('modeStocks').value };
  const r = await fetch('/api/mode', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) }).then(r=>r.json());
  if (r.ok){ alert('Modes saved'); $('kModeC').textContent=cap(r.mode.crypto); $('kModeS').textContent=cap(r.mode.stocks); $('cModePill').textContent=cap(r.mode.crypto); $('sModePill').textContent=cap(r.mode.stocks); }
};

refreshOrdersAndPL();
</script>
</body></html>`;
}

// ---------- Start server ----------
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('Server http://localhost:'+PORT);
});
