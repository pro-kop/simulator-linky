'use strict';
// Simulace toku materiálu.
//
// Role prvků:
//   - producent = stroj bez vstupního spoje (vyrábí z „ničeho" v taktu)
//   - konzument = stroj se vstupem nebo kompletace (zpracovává volné kusy / obaly)
//   - obal      = pool prázdných obalů, plní se kusy a plné posílá dál
//   - temperace = drží obaly/dávky po dobu temperace, kapacita v obalech
//   - sklad     = buffer obalů (FIFO), kapacita v obalech; přijímá jen obaly/dávky, ne volné kusy.
//                 Plný blokuje předchozí prvek; stroje si z něj berou obal, až ho potřebují,
//                 temperaci/obalu ho sklad posílá sám.
// Neaktivní prvek (checkbox) je z toku vyřazen: nic nepřijímá, nic nevysílá, netiká,
// nepočítá se do statistik. Role (producent/konzument) se ale určuje ze všech spojů,
// takže větev za neaktivním prvkem čeká na vstup.

const TICK_MS = 100;
const NO_TARGETS = [];
const G = { out: new Map(), whIn: new Map(), hasIn: new Set() };

function buildGraph() {
  G.out.clear(); G.whIn.clear(); G.hasIn.clear();
  const byId = new Map(S.nodes.map((n) => [n.id, n]));
  for (const e of S.edges) {
    G.hasIn.add(e.to);
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || !a.active || !b.active || !a.rt || !b.rt) continue;
    if (!G.out.has(a.id)) G.out.set(a.id, []);
    G.out.get(a.id).push(b);
    if (a.type === 'warehouse' && isMT(b)) {
      if (!G.whIn.has(b.id)) G.whIn.set(b.id, []);
      G.whIn.get(b.id).push(a);
    }
  }
}
const outsOf = (n) => G.out.get(n.id) || NO_TARGETS;
const isProducer = (n) => n.type === 'machine' && !G.hasIn.has(n.id);

function initRt(n) {
  switch (n.type) {
    case 'machine':
    case 'kompletace':
      n.rt = { made: 0, nextAt: Infinity, pieceBuf: 0, packQueue: [], cur: null, outBuf: 0, outPacks: [], rr: 0, blocked: false };
      break;
    case 'packing':
      n.rt = { pool: n.params.count, filling: false, fill: 0, waiting: 0, inTemp: 0, inCons: 0, inWh: 0, rr: 0 };
      break;
    case 'tempering':
      n.rt = { occ: 0, queue: [], rr: 0, blocked: false };
      break;
    case 'warehouse':
      n.rt = { items: [], inTotal: 0, outTotal: 0, rr: 0 };
      break;
    default:
      n.rt = null;
  }
}
function resetAllRt() { S.nodes.forEach(initRt); }

function wake(m) { if (m.rt.nextAt === Infinity) m.rt.nextAt = S.sim.t; }

// ── Evidence obalů: kde se právě nachází (temperace / kompletace / sklad / zpět v poolu) ──
const LOC_KEY = { temp: 'inTemp', cons: 'inCons', wh: 'inWh' };
function moveObal(item, to) {
  if (item.packNodeId != null) {
    const pk = nodeById(item.packNodeId);
    if (pk && pk.type === 'packing' && pk.rt) {
      const from = LOC_KEY[item.loc];
      if (from) pk.rt[from] = Math.max(0, pk.rt[from] - 1);
      if (LOC_KEY[to]) pk.rt[LOC_KEY[to]]++;
      else if (to === 'pool') pk.rt.pool++;
    }
  }
  item.loc = to === 'pool' ? null : to;
}

// Naplní obal kusy; vrací počet skutečně umístěných kusů (0, když chybí prázdný obal).
function fillPacking(pack, n) {
  const pr = pack.rt, cap = pack.params.capacity;
  let placed = 0;
  while (placed < n) {
    if (!pr.filling) {
      if (pr.pool <= 0) break;
      pr.pool--; pr.filling = true; pr.fill = 0;
    }
    const g = Math.min(n - placed, cap - pr.fill);
    pr.fill += g; placed += g;
    if (pr.fill >= cap) { pr.waiting++; pr.filling = false; pr.fill = 0; }
  }
  if (pr.waiting > 0) flushPack(pack);
  return placed;
}

// Předá obal/dávku (item) prvku t. Vrací true, pokud byl item celý předán.
function sendPack(t, item) {
  switch (t.type) {
    case 'tempering': {
      if (t.rt.occ >= t.params.maxObals) return false;
      t.rt.occ++;
      const it = { pcs: item.pcs, cap: item.cap, packNodeId: item.packNodeId, loc: item.loc, readyAt: S.sim.t + t.params.hoursMin * 3600 };
      moveObal(it, 'temp');
      t.rt.queue.push(it);
      return true;
    }
    case 'machine':
    case 'kompletace':
      if (item.packNodeId == null) {
        t.rt.pieceBuf += item.pcs;          // volná dávka bez obalu
      } else {
        const it = { pcs: item.pcs, cap: item.cap, packNodeId: item.packNodeId, loc: item.loc, out: 0 };
        moveObal(it, 'cons');
        t.rt.packQueue.push(it);
      }
      wake(t);
      return true;
    case 'warehouse': {
      if (t.rt.items.length >= t.params.capacity) return false;
      const it = { pcs: item.pcs, cap: item.cap, packNodeId: item.packNodeId, loc: item.loc };
      moveObal(it, 'wh');
      t.rt.items.push(it);
      t.rt.inTotal++;
      return true;
    }
    case 'packing': {
      const got = fillPacking(t, item.pcs);   // přebalení (z temperace)
      item.pcs -= got;
      if (item.pcs > 0) return false;
      moveObal(item, 'pool');
      return true;
    }
  }
  return false;
}

// Plné obaly čekající u „Obalu" pošle navazujícím prvkům (round-robin).
function flushPack(pack) {
  const pr = pack.rt;
  if (pr.waiting <= 0) return;
  const targets = outsOf(pack).filter((t) => t.type !== 'packing');
  if (!targets.length) return;               // konec linky: plné obaly zůstávají, pool se vyčerpá
  let guard = 0;
  while (pr.waiting > 0 && guard++ < 10000) {
    let sent = false;
    for (const t of rotated(targets, pr.rr)) {
      if (pr.waiting <= 0) break;
      const item = { pcs: pack.params.capacity, cap: pack.params.capacity, packNodeId: pack.id, loc: null };
      if (sendPack(t, item)) { pr.waiting--; sent = true; spawnDot(pack, t); }
    }
    pr.rr = (pr.rr + 1) % targets.length;
    if (!sent) break;
  }
}

// Kolik volných kusů přijme prvek t (hromadně). Dávky do temperace se sbírají v `lots`.
function acceptPieces(t, n, lots) {
  switch (t.type) {
    case 'machine':
    case 'kompletace':
      t.rt.pieceBuf += n; wake(t);
      return n;
    case 'packing':
      return fillPacking(t, n);
    case 'tempering':
      if (lots.has(t)) { lots.set(t, lots.get(t) + n); return n; }
      if (t.rt.occ < t.params.maxObals) { t.rt.occ++; lots.set(t, n); return n; }
      return 0;
  }
  return 0;
}

// Rozdělí volné kusy mezi navazující prvky rovnoměrně (celé kusy, round-robin).
// Vrací počet kusů, které nikdo nepřijal (zdroj je pak blokovaný).
function routePieces(from, pieces) {
  const all = outsOf(from);
  const targets = all.filter((t) => t.type !== 'warehouse');   // sklad přijímá jen obaly
  if (!targets.length) return all.length ? pieces : 0;         // jen sklad → blokace; nic → konec linky
  const lots = new Map(), hit = new Set();
  let left = pieces, active = rotated(targets, from.rt.rr), guard = 0;
  while (left > 0 && active.length && guard++ < 1000) {
    const share = Math.max(1, Math.floor(left / active.length));
    const next = [];
    for (const t of active) {
      if (left <= 0) break;
      const want = Math.min(share, left);
      const got = acceptPieces(t, want, lots);
      left -= got;
      if (got > 0) hit.add(t);
      if (got === want) next.push(t);
    }
    active = next;
  }
  for (const [temp, pcs] of lots) {
    temp.rt.queue.push({ pcs, cap: pcs, packNodeId: null, loc: null, readyAt: S.sim.t + temp.params.hoursMin * 3600 });
  }
  from.rt.rr = (from.rt.rr + 1) % targets.length;
  hit.forEach((t) => spawnDot(from, t));
  return left;
}

// Konzument si ze skladu na vstupu vezme další obal, až nemá co zpracovávat.
function pullWarehouse(m, need) {
  const rt = m.rt, srcs = G.whIn.get(m.id);
  if (!srcs || rt.cur || rt.packQueue.length || rt.pieceBuf >= need) return;
  for (const w of rotated(srcs, rt.rr)) {
    if (!w.rt.items.length) continue;
    const item = w.rt.items.shift();
    w.rt.outTotal++;
    if (item.packNodeId == null) {
      rt.pieceBuf += item.pcs;           // dávka bez obalu (např. z temperace)
    } else {
      item.out = 0;
      moveObal(item, 'cons');
      rt.packQueue.push(item);
    }
    spawnDot(w, m);
    return;
  }
}

// Kam může konzument poslat obal s hotovými výrobky: temperace nebo sklad.
const packTargets = (m) => outsOf(m).filter((t) => t.type === 'tempering' || t.type === 'warehouse');
const hasPackDown = (m) => packTargets(m).length > 0;

// Vyprázdní výstup stroje (kusy + obaly směřující do temperace/skladu). true = nic nezůstalo.
function flushOutputs(m) {
  const rt = m.rt;
  while (rt.outPacks.length) {
    const item = rt.outPacks[0];
    const targets = packTargets(m);
    if (!targets.length) { moveObal(item, 'pool'); rt.outBuf += item.pcs; rt.outPacks.shift(); continue; }
    let ok = false;
    for (const t of rotated(targets, rt.rr)) {
      if (sendPack(t, item)) { ok = true; spawnDot(m, t); rt.rr = (rt.rr + 1) % targets.length; break; }
    }
    if (!ok) break;
    rt.outPacks.shift();
  }
  if (rt.outBuf > 0) rt.outBuf = routePieces(m, rt.outBuf);
  return rt.outBuf === 0 && rt.outPacks.length === 0;
}

// Dokončený obal u konzumenta: pokračuje s výrobky do temperace/skladu, nebo se vrací do poolu.
function finishPack(m, c) {
  if (c.packNodeId != null && hasPackDown(m)) {
    m.rt.outPacks.push({ pcs: c.out, cap: c.out, packNodeId: c.packNodeId, loc: c.loc });
  } else {
    moveObal(c, 'pool');
    m.rt.outBuf += c.out;
  }
}

function effTakt(p) { return p.takt / (p.oee / 100); }

function tickProducer(m) {
  const rt = m.rt, p = m.params, now = S.sim.t, effT = effTakt(p);
  if (rt.nextAt === Infinity) rt.nextAt = now;
  rt.blocked = false;
  if (!flushOutputs(m)) { rt.blocked = true; rt.nextAt = Math.max(rt.nextAt, now); return; }
  let guard = 0;
  while (rt.nextAt <= now && guard++ < 5000) {
    rt.made += p.nasob;
    rt.outBuf += p.nasob;
    rt.nextAt += effT;
    if (!flushOutputs(m)) { rt.blocked = true; rt.nextAt = Math.max(rt.nextAt, now); break; }
  }
}

function tickConsumer(m) {
  const rt = m.rt, p = m.params, now = S.sim.t, effT = effTakt(p);
  const kus = p.kusovnik, need = p.nasob * kus;
  rt.blocked = false;
  if (!flushOutputs(m)) {
    rt.blocked = true;
    if (rt.nextAt !== Infinity) rt.nextAt = Math.max(rt.nextAt, now);
    return;
  }
  pullWarehouse(m, need);
  if (rt.nextAt === Infinity && (rt.cur || rt.packQueue.length || rt.pieceBuf >= kus)) rt.nextAt = now;
  let guard = 0;
  while (rt.nextAt <= now && guard++ < 5000) {
    if (!rt.cur && rt.packQueue.length && rt.pieceBuf < need) rt.cur = rt.packQueue.shift();
    if (rt.cur && rt.cur.pcs <= 0) { const c = rt.cur; rt.cur = null; finishPack(m, c); continue; }
    if (rt.cur) {
      const c = rt.cur, consume = Math.min(need, c.pcs), out = Math.floor(consume / kus);
      c.pcs -= consume;
      rt.pieceBuf += consume - out * kus;       // zbytek do kusovníku se nepropadne
      rt.made += out;
      if (c.packNodeId != null && hasPackDown(m)) c.out += out; else rt.outBuf += out;
      rt.nextAt += effT;
      if (c.pcs <= 0) { rt.cur = null; finishPack(m, c); }
    } else if (rt.pieceBuf >= kus) {
      const take = Math.min(need, Math.floor(rt.pieceBuf / kus) * kus), out = take / kus;
      rt.pieceBuf -= take;
      rt.made += out; rt.outBuf += out;
      rt.nextAt += effT;
    } else {
      rt.nextAt = Infinity;
      break;
    }
    if (!flushOutputs(m)) { rt.blocked = true; rt.nextAt = Math.max(rt.nextAt, now); break; }
    pullWarehouse(m, need);
  }
}

function tickTempering(temp) {
  const rt = temp.rt, now = S.sim.t, targets = outsOf(temp);
  rt.blocked = false;
  rt.queue = rt.queue.filter((item) => {
    if (item.readyAt > now) return true;
    if (!targets.length) { moveObal(item, 'pool'); rt.occ = Math.max(0, rt.occ - 1); return false; }
    for (const t of rotated(targets, rt.rr)) {
      if (sendPack(t, item)) {
        rt.occ = Math.max(0, rt.occ - 1);
        rt.rr = (rt.rr + 1) % targets.length;
        spawnDot(temp, t);
        return false;
      }
    }
    rt.blocked = true;    // hotový obal nemá kam jít – zůstává a drží místo
    return true;
  });
}

// Sklad posílá obaly (FIFO) temperaci / obalu / dalšímu skladu; stroje si berou samy (pullWarehouse).
function tickWarehouse(w) {
  const rt = w.rt;
  const targets = outsOf(w).filter((t) => !isMT(t));
  if (!targets.length) return;
  while (rt.items.length) {
    const item = rt.items[0];
    let ok = false;
    for (const t of rotated(targets, rt.rr)) {
      if (sendPack(t, item)) { ok = true; spawnDot(w, t); rt.rr = (rt.rr + 1) % targets.length; break; }
    }
    if (!ok) break;
    rt.items.shift();
    rt.outTotal++;
  }
}

function tick() {
  try {
    S.sim.t += Number($('spd').value) * TICK_MS / 1000;
    buildGraph();
    const act = S.nodes.filter((n) => n.active && n.rt);
    act.filter((n) => n.type === 'tempering').forEach(tickTempering);
    act.filter((n) => n.type === 'packing').forEach(flushPack);
    act.filter((n) => n.type === 'warehouse').forEach(tickWarehouse);
    act.filter(isProducer).forEach(tickProducer);
    act.filter((n) => isMT(n) && !isProducer(n)).forEach(tickConsumer);
    updateUI();
  } catch (err) {
    stopSim();
    console.error(err);
    showWarning('⚠ Chyba simulace: ' + err.message, 'crit');
  }
}

// ── Zobrazení stavu ──
function updateUI() {
  const now = S.sim.t, simH = now / 3600;
  $('clock').textContent = '⏱ ' + fmtT(now);

  for (const n of S.nodes) {
    if (!n.rt || !n.ui) continue;
    const rt = n.rt, u = n.ui;
    let main = '–', sec = '', pct = 0, st = 'idle', label;
    if (isMT(n)) {
      main = fmt(rt.made) + ' ks';
      if (isProducer(n)) {
        const pk = outsOf(n).find((x) => x.type === 'packing');
        if (pk) { sec = 'obal: ' + fmt(pk.rt.fill) + '/' + fmt(pk.params.capacity); pct = pk.rt.fill / pk.params.capacity; }
        st = rt.blocked ? 'block' : 'run';
      } else {
        const q = rt.packQueue.length;
        if (rt.cur) { sec = 'v obalu: ' + fmt(rt.cur.pcs) + ' | fronta: ' + q; pct = rt.cur.cap > 0 ? rt.cur.pcs / rt.cur.cap : 0; }
        else if (rt.pieceBuf > 0) sec = 'buf: ' + fmt(rt.pieceBuf) + ' | fronta: ' + q;
        else sec = 'čeká | fronta: ' + q;
        st = rt.blocked ? 'block' : (rt.nextAt !== Infinity ? 'run' : 'wait');
      }
      // Volné kusy mají za strojem jen sklad → sklad je nepřijme (bere jen obaly).
      const outs = outsOf(n);
      if (rt.blocked && rt.outBuf > 0 && outs.length && outs.every((t) => t.type === 'warehouse')) label = 'sklad bere jen obaly';
    } else if (n.type === 'packing') {
      const cap = n.params.capacity;
      main = rt.filling ? fmt(rt.fill) + ' / ' + fmt(cap) + ' ks' : 'čeká: ' + rt.waiting;
      sec = 'vol: ' + rt.pool + ' | temp: ' + rt.inTemp + ' | k: ' + rt.inCons + (rt.inWh ? ' | sk: ' + rt.inWh : '');
      pct = rt.filling ? rt.fill / cap : 0;
      if (rt.filling) st = 'run';
      else if (rt.pool <= 0) { st = 'wait'; label = 'bez prázdných obalů'; }
    } else if (n.type === 'tempering') {
      const mx = n.params.maxObals;
      main = rt.occ + ' / ' + mx + ' obalů';
      const nxt = rt.queue.length ? Math.min(...rt.queue.map((q) => q.readyAt)) : null;
      sec = nxt !== null ? '~' + fmtD(Math.max(0, nxt - now)) : 'prázdná';
      pct = rt.occ / mx;
      if (rt.blocked) { st = 'block'; label = 'nemá kam předat'; }
      else if (rt.occ >= mx) { st = 'full'; label = 'plná'; }
      else if (rt.occ > 0) st = 'run';
    } else if (n.type === 'warehouse') {
      const cap = n.params.capacity, cnt = rt.items.length;
      const pcs = rt.items.reduce((s, i) => s + i.pcs, 0);
      main = fmt(cnt) + ' / ' + fmt(cap) + ' obalů';
      sec = 'obsah: ' + fmt(pcs) + ' ks | výdej: ' + fmt(rt.outTotal);
      pct = cnt / cap;
      if (cnt >= cap) { st = 'full'; label = 'plný'; }
      else if (cnt > 0) { st = 'run'; label = 'zásoba'; }
      else label = 'prázdný';
    }
    if (!n.active) { st = 'off'; label = undefined; }
    u.main.textContent = main;
    u.sec.textContent = sec;
    u.fill.style.width = clamp(pct * 100, 0, 100) + '%';
    setStatus(n, st, label);
  }

  // Úzké místo: nejpomalejší aktivní producent – jen pokud je znatelně pomalejší než nejrychlejší
  // (při shodě se neoznačuje nic; původní verze označila prvního v pořadí).
  const producers = S.nodes.filter((n) => n.active && n.rt && isProducer(n));
  S.nodes.forEach((n) => { if (n.ui && n.ui.bn) n.ui.bn.hidden = true; });
  if (producers.length > 1 && simH > 0.1) {
    let bn = producers[0], top = 0;
    for (const m of producers) {
      if (m.rt.made < bn.rt.made) bn = m;
      top = Math.max(top, m.rt.made);
    }
    if (bn.rt.made < top * 0.99) bn.ui.bn.hidden = false;
  }

  updateStats(producers, simH);
  updateWarnings(producers);
}

// Statistiky – vzorce beze změny oproti původní verzi (viz report k bodu 6),
// jen se nezapočítávají neaktivní prvky.
const STAT_IDS = ['sv-h1', 'sv-h12', 'sv-h24', 'sv-takt', 'sv-d5', 'sv-d6', 'sv-d7'];
function updateStats(producers, simH) {
  const kap = S.nodes.filter((n) => n.active && isMT(n) && n.params.kapRelevant);
  if (!kap.length) { STAT_IDS.forEach((id) => { $(id).textContent = '—'; }); return; }
  const rateH = kap.reduce((s, m) => s + 3600 / m.params.takt * m.params.nasob * (m.params.oee / 100), 0);
  const h24 = rateH * 24;
  $('sv-h1').textContent = fmt(rateH);
  $('sv-h12').textContent = fmt(rateH * 12);
  $('sv-h24').textContent = fmt(h24);
  $('sv-d5').textContent = fmt(h24 * 5);
  $('sv-d6').textContent = fmt(h24 * 6);
  $('sv-d7').textContent = fmt(h24 * 7);
  const kp = kap.filter((n) => n.rt && isProducer(n) && n.rt.made > 0);
  if (simH > 0.01 && kp.length) {
    const tv = kp.map((m) => S.sim.t / (m.rt.made / m.params.nasob));
    $('sv-takt').textContent = (tv.reduce((a, b) => a + b, 0) / tv.length).toFixed(1) + ' s';
  } else {
    $('sv-takt').textContent = '—';
  }
}

function showWarning(text, level) {
  const wb = $('wb');
  if (!text) { wb.hidden = true; return; }
  wb.textContent = text;
  wb.className = level;
  wb.hidden = false;
}

function updateWarnings(producers) {
  const act = S.nodes.filter((n) => n.active && n.rt);
  const blocked = producers.find((n) => n.rt.blocked);
  const queue = act.find((n) => isMT(n) && !isProducer(n) && n.rt.packQueue.length > 10);
  const tFull = act.find((n) => n.type === 'tempering' && n.rt.occ >= n.params.maxObals);
  const wFull = act.find((n) => n.type === 'warehouse' && n.rt.items.length >= n.params.capacity);
  if (blocked) showWarning('⚠ ' + blocked.params.name + ' zablokován – navazující prvky nepřijímají (obaly / sklad / temperace)', 'crit');
  else if (queue) showWarning('⚠ Fronta u ' + queue.params.name + ' roste', 'warn');
  else if (tFull) showWarning('⚠ ' + tFull.params.name + ' je plná', 'warn');
  else if (wFull) showWarning('⚠ ' + wFull.params.name + ' je plný', 'warn');
  else showWarning(null);
}

// ── Ovládání ──
function startSim() {
  if (S.sim.running && !S.sim.paused) return;
  if (!S.sim.paused) { resetAllRt(); S.sim.t = 0; clearDots(); }
  S.sim.running = true; S.sim.paused = false;
  $('btnStart').hidden = true; $('btnPause').hidden = false;
  S.sim.timer = setInterval(tick, TICK_MS);
}
function pauseSim() {
  if (!S.sim.running || S.sim.paused) return;
  S.sim.paused = true;
  clearInterval(S.sim.timer); S.sim.timer = null;
  $('btnPause').hidden = true; $('btnStart').hidden = false;
  $('btnStart').textContent = '▶ Pokračovat';
}
function stopSim() {
  S.sim.running = false; S.sim.paused = false;
  clearInterval(S.sim.timer); S.sim.timer = null;
  $('btnPause').hidden = true; $('btnStart').hidden = false;
  $('btnStart').textContent = '▶ Start';
}
function resetDisplay() {
  S.sim.t = 0;
  $('clock').textContent = '⏱ 0:00:00';
  for (const n of S.nodes) {
    if (!n.ui || !n.ui.main) continue;
    n.ui.main.textContent = '–';
    n.ui.sec.textContent = '';
    n.ui.fill.style.width = '0%';
    n.ui.bn.hidden = true;
    setStatus(n, n.active ? 'idle' : 'off');
  }
  clearDots();
  showWarning(null);
  STAT_IDS.forEach((id) => { $(id).textContent = '—'; });
}
function resetSim() { stopSim(); resetAllRt(); resetDisplay(); }
