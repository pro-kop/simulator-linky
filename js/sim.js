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
//
// Reference: každý kus i obal nese štítek reference (REF_NONE = bez reference).
//   - stroj s referencemi označí svůj výstup (více referencí → střídání podle podílu),
//   - stroj bez reference a kompletace štítek převezmou ze vstupu,
//   - kusovník platí zvlášť pro každou referenci (2 L → 1 L, 2 P → 1 P), reference se nemíchají,
//   - obal plní pro každou referenci vlastní obal (prázdné obaly jsou ve společném poolu).
// Bez vyplněných referencí jede všechno pod REF_NONE, tj. stejně jako dřív.
//
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

// ── Množství po referencích (Map: reference → počet kusů) ──
function bagAdd(bag, ref, n) { if (n > 0) bag.set(ref, (bag.get(ref) || 0) + n); }
function bagSub(bag, ref, n) {
  const v = (bag.get(ref) || 0) - n;
  if (v > 0) bag.set(ref, v); else bag.delete(ref);
}
function bagTotal(bag) { let s = 0; for (const v of bag.values()) s += v; return s; }

// Stroj s referencemi: kterou referenci dělá tento cyklus / obal (vyhlazené střídání podle podílu).
function pickRef(m) {
  const refs = m.params.refs;
  if (m.type !== 'machine' || !refs || !refs.length) return null;
  const plan = refShares(refs), cnt = m.rt.refCycles;
  let total = 0;
  for (let i = 0; i < plan.length; i++) total += cnt[i] || 0;
  let best = 0, bestScore = -Infinity;
  plan.forEach((r, i) => {
    const score = r.w * (total + 1) - (cnt[i] || 0);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  cnt[best] = (cnt[best] || 0) + 1;
  return plan[best].name;
}
// Výstupní reference: vlastní reference stroje, jinak převezme vstupní.
function stampRef(m, inRef) {
  const r = pickRef(m);
  return r === null ? inRef : r;
}
function record(m, ref, out) {
  if (out <= 0) return;
  m.rt.made += out;
  bagAdd(m.rt.madeBy, ref, out);
}

function initRt(n) {
  switch (n.type) {
    case 'machine':
    case 'kompletace':
      n.rt = {
        made: 0, madeBy: new Map(), refCycles: [], nextAt: Infinity,
        pieceBuf: new Map(), packQueue: [], cur: null, outBuf: new Map(), outPacks: [], rr: 0, blocked: false,
      };
      break;
    case 'packing':
      // open: reference → počet kusů v rozplněném obalu; waiting: reference plných obalů čekajících na odvoz
      n.rt = { pool: n.params.count, open: new Map(), waiting: [], inTemp: 0, inCons: 0, inWh: 0, rr: 0 };
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

const copyItem = (item, extra) => Object.assign(
  { pcs: item.pcs, cap: item.cap, packNodeId: item.packNodeId, loc: item.loc, ref: item.ref }, extra);

// Naplní obal kusy dané reference (každá reference má svůj rozplněný obal).
// Vrací počet skutečně umístěných kusů (0, když chybí prázdný obal).
function fillPacking(pack, n, ref) {
  const pr = pack.rt, cap = pack.params.capacity;
  let placed = 0;
  while (placed < n) {
    let f = pr.open.get(ref);
    if (f === undefined) {
      if (pr.pool <= 0) break;
      pr.pool--; f = 0;
    }
    const g = Math.min(n - placed, cap - f);
    f += g; placed += g;
    if (f >= cap) { pr.open.delete(ref); pr.waiting.push(ref); } else pr.open.set(ref, f);
  }
  if (pr.waiting.length) flushPack(pack);
  return placed;
}

// Předá obal/dávku (item) prvku t. Vrací true, pokud byl item celý předán.
function sendPack(t, item) {
  switch (t.type) {
    case 'tempering': {
      if (t.rt.occ >= t.params.maxObals) return false;
      t.rt.occ++;
      const it = copyItem(item, { readyAt: S.sim.t + t.params.hoursMin * 3600 });
      moveObal(it, 'temp');
      t.rt.queue.push(it);
      return true;
    }
    case 'machine':
    case 'kompletace':
      if (item.packNodeId == null) {
        bagAdd(t.rt.pieceBuf, item.ref, item.pcs);     // volná dávka bez obalu
      } else {
        const it = copyItem(item, { out: 0 });
        moveObal(it, 'cons');
        t.rt.packQueue.push(it);
      }
      wake(t);
      return true;
    case 'warehouse': {
      if (t.rt.items.length >= t.params.capacity) return false;
      const it = copyItem(item);
      moveObal(it, 'wh');
      t.rt.items.push(it);
      t.rt.inTotal++;
      return true;
    }
    case 'packing': {
      const got = fillPacking(t, item.pcs, item.ref);   // přebalení (z temperace/skladu)
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
  if (!pr.waiting.length) return;
  const targets = outsOf(pack).filter((t) => t.type !== 'packing');
  if (!targets.length) return;               // konec linky: plné obaly zůstávají, pool se vyčerpá
  const cap = pack.params.capacity;
  let guard = 0;
  while (pr.waiting.length && guard++ < 10000) {
    let sent = false;
    for (const t of rotated(targets, pr.rr)) {
      if (!pr.waiting.length) break;
      const item = { pcs: cap, cap, packNodeId: pack.id, loc: null, ref: pr.waiting[0] };
      if (sendPack(t, item)) { pr.waiting.shift(); sent = true; spawnDot(pack, t); }
    }
    pr.rr = (pr.rr + 1) % targets.length;
    if (!sent) break;
  }
}

// Kolik volných kusů dané reference přijme prvek t. Dávky do temperace se sbírají v `lots`.
function acceptPieces(t, n, ref, lots) {
  switch (t.type) {
    case 'machine':
    case 'kompletace':
      bagAdd(t.rt.pieceBuf, ref, n); wake(t);
      return n;
    case 'packing':
      return fillPacking(t, n, ref);
    case 'tempering': {
      const key = t.id + '|' + ref;
      const lot = lots.get(key);
      if (lot) { lot.pcs += n; return n; }
      if (t.rt.occ < t.params.maxObals) { t.rt.occ++; lots.set(key, { t, ref, pcs: n }); return n; }
      return 0;
    }
  }
  return 0;
}

// Rozdělí volné kusy (bag) mezi navazující prvky rovnoměrně, každou referenci zvlášť.
// Co nikdo nepřijme, zůstane v bagu (zdroj je pak blokovaný).
function routePieces(from, bag) {
  const all = outsOf(from);
  const targets = all.filter((t) => t.type !== 'warehouse');   // sklad přijímá jen obaly
  if (!targets.length) { if (!all.length) bag.clear(); return; } // nic → konec linky; jen sklad → blokace
  const lots = new Map(), hit = new Set();
  for (const [ref, n0] of [...bag]) {
    let left = n0, active = rotated(targets, from.rt.rr), guard = 0;
    while (left > 0 && active.length && guard++ < 1000) {
      const share = Math.max(1, Math.floor(left / active.length));
      const next = [];
      for (const t of active) {
        if (left <= 0) break;
        const want = Math.min(share, left);
        const got = acceptPieces(t, want, ref, lots);
        left -= got;
        if (got > 0) hit.add(t);
        if (got === want) next.push(t);
      }
      active = next;
    }
    if (left > 0) bag.set(ref, left); else bag.delete(ref);
  }
  for (const lot of lots.values()) {
    lot.t.rt.queue.push({ pcs: lot.pcs, cap: lot.pcs, packNodeId: null, loc: null, ref: lot.ref, readyAt: S.sim.t + lot.t.params.hoursMin * 3600 });
  }
  from.rt.rr = (from.rt.rr + 1) % targets.length;
  hit.forEach((t) => spawnDot(from, t));
}

// Konzument si ze skladu na vstupu vezme další obal, až nemá co zpracovávat.
function pullWarehouse(m, need) {
  const rt = m.rt, srcs = G.whIn.get(m.id);
  if (!srcs || rt.cur || rt.packQueue.length || bagTotal(rt.pieceBuf) >= need) return;
  for (const w of rotated(srcs, rt.rr)) {
    if (!w.rt.items.length) continue;
    const item = w.rt.items.shift();
    w.rt.outTotal++;
    if (item.packNodeId == null) {
      bagAdd(rt.pieceBuf, item.ref, item.pcs);   // dávka bez obalu (např. z temperace)
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
    if (!targets.length) { moveObal(item, 'pool'); bagAdd(rt.outBuf, item.ref, item.pcs); rt.outPacks.shift(); continue; }
    let ok = false;
    for (const t of rotated(targets, rt.rr)) {
      if (sendPack(t, item)) { ok = true; spawnDot(m, t); rt.rr = (rt.rr + 1) % targets.length; break; }
    }
    if (!ok) break;
    rt.outPacks.shift();
  }
  if (rt.outBuf.size) routePieces(m, rt.outBuf);
  return rt.outBuf.size === 0 && rt.outPacks.length === 0;
}

// Dokončený obal u konzumenta: pokračuje s výrobky do temperace/skladu, nebo se vrací do poolu.
function finishPack(m, c) {
  if (c.packNodeId != null && hasPackDown(m)) {
    m.rt.outPacks.push({ pcs: c.out, cap: c.out, packNodeId: c.packNodeId, loc: c.loc, ref: c.outRef });
  } else {
    moveObal(c, 'pool');
    bagAdd(m.rt.outBuf, c.outRef, c.out);
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
    const ref = stampRef(m, REF_NONE);
    record(m, ref, p.nasob);
    bagAdd(rt.outBuf, ref, p.nasob);
    rt.nextAt += effT;
    if (!flushOutputs(m)) { rt.blocked = true; rt.nextAt = Math.max(rt.nextAt, now); break; }
  }
}

// Reference připravená ke zpracování z volných kusů: ta s největší zásobou (aspoň 1 výstup).
function readyRef(bag, kus) {
  let best = null, bestN = 0;
  for (const [ref, n] of bag) if (n >= kus && n > bestN) { best = ref; bestN = n; }
  return best;
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
  if (rt.nextAt === Infinity && (rt.cur || rt.packQueue.length || readyRef(rt.pieceBuf, kus) !== null)) rt.nextAt = now;
  let guard = 0;
  while (rt.nextAt <= now && guard++ < 5000) {
    if (!rt.cur && rt.packQueue.length && bagTotal(rt.pieceBuf) < need) {
      rt.cur = rt.packQueue.shift();
      rt.cur.outRef = stampRef(m, rt.cur.ref);    // obal je vždy jedné reference
    }
    if (rt.cur && rt.cur.pcs <= 0) { const c = rt.cur; rt.cur = null; finishPack(m, c); continue; }
    if (rt.cur) {
      const c = rt.cur, consume = Math.min(need, c.pcs), out = Math.floor(consume / kus);
      c.pcs -= consume;
      bagAdd(rt.pieceBuf, c.ref, consume - out * kus);   // zbytek do kusovníku se nepropadne
      record(m, c.outRef, out);
      if (c.packNodeId != null && hasPackDown(m)) c.out += out; else bagAdd(rt.outBuf, c.outRef, out);
      rt.nextAt += effT;
      if (c.pcs <= 0) { rt.cur = null; finishPack(m, c); }
    } else {
      const ref = readyRef(rt.pieceBuf, kus);
      if (ref === null) { rt.nextAt = Infinity; break; }
      const take = Math.min(need, Math.floor(rt.pieceBuf.get(ref) / kus) * kus), out = take / kus;
      bagSub(rt.pieceBuf, ref, take);
      const oref = stampRef(m, ref);
      record(m, oref, out);
      bagAdd(rt.outBuf, oref, out);
      rt.nextAt += effT;
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
const bagText = (bag) => [...bag].map(([r, n]) => refName(r) + ' ' + fmt(n)).join(', ');

function updateUI() {
  const now = S.sim.t, simH = now / 3600;
  $('clock').textContent = '⏱ ' + fmtT(now);

  for (const n of S.nodes) {
    if (!n.rt || !n.ui) continue;
    const rt = n.rt, u = n.ui;
    let main = '–', sec = '', pct = 0, st = 'idle', label, tip = '';
    if (isMT(n)) {
      main = fmt(rt.made) + ' ks';
      if (rt.madeBy.size > 1 || (rt.madeBy.size === 1 && !rt.madeBy.has(REF_NONE))) tip = 'Vyrobeno: ' + bagText(rt.madeBy);
      if (isProducer(n)) {
        const pk = outsOf(n).find((x) => x.type === 'packing');
        if (pk) {
          const f = Math.max(0, ...pk.rt.open.values());
          sec = 'obal: ' + fmt(f) + '/' + fmt(pk.params.capacity);
          pct = f / pk.params.capacity;
        }
        st = rt.blocked ? 'block' : 'run';
      } else {
        const q = rt.packQueue.length, pb = bagTotal(rt.pieceBuf);
        if (rt.cur) { sec = 'v obalu: ' + fmt(rt.cur.pcs) + ' | fronta: ' + q; pct = rt.cur.cap > 0 ? rt.cur.pcs / rt.cur.cap : 0; }
        else if (pb > 0) sec = 'buf: ' + fmt(pb) + ' | fronta: ' + q;
        else sec = 'čeká | fronta: ' + q;
        st = rt.blocked ? 'block' : (rt.nextAt !== Infinity ? 'run' : 'wait');
      }
      // Volné kusy mají za strojem jen sklad → sklad je nepřijme (bere jen obaly).
      const outs = outsOf(n);
      if (rt.blocked && rt.outBuf.size && outs.length && outs.every((t) => t.type === 'warehouse')) label = 'sklad bere jen obaly';
    } else if (n.type === 'packing') {
      const cap = n.params.capacity, open = [...rt.open.values()];
      if (open.length === 1) main = fmt(open[0]) + ' / ' + fmt(cap) + ' ks';
      else if (open.length > 1) main = open.length + ' rozplněné obaly';
      else main = 'čeká: ' + rt.waiting.length;
      sec = 'vol: ' + rt.pool + ' | temp: ' + rt.inTemp + ' | k: ' + rt.inCons + (rt.inWh ? ' | sk: ' + rt.inWh : '');
      pct = open.length ? Math.max(...open) / cap : 0;
      if (rt.open.size > 1 || (rt.open.size === 1 && !rt.open.has(REF_NONE))) tip = 'Rozplněno: ' + bagText(rt.open);
      if (open.length) st = 'run';
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
    u.main.title = tip;
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
  updateRefStats(simH);
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

// Vyrobeno podle reference – výstup kapacitně relevantních prvků ze simulace.
// Zobrazí se jen tehdy, když se v toku reference opravdu objevují.
function updateRefStats(simH) {
  const box = $('refStats');
  const sum = new Map();
  for (const n of S.nodes) {
    if (n.active && n.rt && isMT(n) && n.params.kapRelevant) for (const [r, v] of n.rt.madeBy) bagAdd(sum, r, v);
  }
  if (!sum.size || (sum.size === 1 && sum.has(REF_NONE))) { box.hidden = true; return; }
  const refs = [...sum.keys()].sort((a, b) => (a === REF_NONE) - (b === REF_NONE) || a.localeCompare(b, 'cs'));
  const chips = refs.map((r) => {
    const v = sum.get(r);
    return h('span', { class: 'rchip' }, [
      h('b', { text: refName(r) }),
      fmt(v) + ' ks' + (simH > 0.01 ? ' · ' + fmt(v / simH) + ' ks/h' : ''),
    ]);
  });
  box.replaceChildren(h('span', { class: 'rlbl', text: 'Vyrobeno podle reference (★ kap., simulace):' }), ...chips);
  box.hidden = false;
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
    n.ui.main.title = '';
    n.ui.sec.textContent = '';
    n.ui.fill.style.width = '0%';
    n.ui.bn.hidden = true;
    setStatus(n, n.active ? 'idle' : 'off');
  }
  clearDots();
  showWarning(null);
  STAT_IDS.forEach((id) => { $(id).textContent = '—'; });
  $('refStats').hidden = true;
}
function resetSim() { stopSim(); resetAllRt(); resetDisplay(); }
