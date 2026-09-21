'use strict';
// Vykreslování: měřicí mřížka, spoje, DOM prvků a pozadí, animace toku.

const wrap = $('cw');
const gridCvs = $('grid'), gctx = gridCvs.getContext('2d');
const cvs = $('cvs'), ctx = cvs.getContext('2d');
const nl = $('nl'), bgl = $('bgl');

let COL = {};
function refreshColors() {
  COL = {
    dot: cssVar('--grid-dot'),
    edge: cssVar('--edge'),
    edgeOff: cssVar('--edge-inactive'),
    arrow: cssVar('--accent-solid'),
    link: cssVar('--success-fill'),
  };
}

// ── Souřadnice ──
const w2s = (x, y) => ({ x: x * S.view.k + S.view.x, y: y * S.view.k + S.view.y });
const s2w = (x, y) => ({ x: (x - S.view.x) / S.view.k, y: (y - S.view.y) / S.view.k });
function eventWorld(e) {
  const r = wrap.getBoundingClientRect();
  return s2w(e.clientX - r.left, e.clientY - r.top);
}
const portOut = (n) => ({ x: n.x + n.el.offsetWidth, y: n.y + n.el.offsetHeight / 2 });
const portIn = (n) => ({ x: n.x, y: n.y + n.el.offsetHeight / 2 });

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, hgt = wrap.clientHeight;
  for (const [c, cx] of [[gridCvs, gctx], [cvs, ctx]]) {
    c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr);
    c.style.width = w + 'px'; c.style.height = hgt + 'px';
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawGrid(); drawEdges();
}

function applyTransform() {
  const t = 'translate(' + S.view.x + 'px,' + S.view.y + 'px) scale(' + S.view.k + ')';
  nl.style.transform = t;
  bgl.style.transform = t;
  $('zoomHint').textContent = Math.round(S.view.k * 100) + '%';
  drawGrid(); drawEdges();
}

// Mřížka: jemná tečka po 8 px (ve světových jednotkách); při malém zoomu se nekreslí.
function drawGrid() {
  const w = wrap.clientWidth, hgt = wrap.clientHeight, k = S.view.k;
  gctx.clearRect(0, 0, w, hgt);
  const minor = 8 * k;
  if (minor < 6) return;
  const ox = mod(S.view.x, minor), oy = mod(S.view.y, minor);
  gctx.fillStyle = COL.dot;
  gctx.beginPath();
  for (let x = ox; x < w; x += minor) for (let y = oy; y < hgt; y += minor) gctx.rect(Math.round(x), Math.round(y), 1, 1);
  gctx.fill();
}

// Geometrie spoje (kubická Bézierova křivka ve světových souřadnicích) – sdílí kreslení i animace.
function edgeGeom(s, t) {
  const a = portOut(s), b = portIn(t);
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return { a, b, c1: { x: a.x + dx, y: a.y }, c2: { x: b.x - dx, y: b.y } };
}
function bezierAt(g, t) {
  const u = 1 - t, A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, D = t * t * t;
  return { x: A * g.a.x + B * g.c1.x + C * g.c2.x + D * g.b.x, y: A * g.a.y + B * g.c1.y + C * g.c2.y + D * g.b.y };
}

// ── Spoje ──
const edelPool = new Map();
function drawEdges() {
  ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
  const byId = new Map(S.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  for (const e of S.edges) {
    const s = byId.get(e.from), t = byId.get(e.to);
    if (!s || !t) continue;
    const { a, b, c1, c2 } = edgeGeom(s, t);
    const A = w2s(a.x, a.y), B = w2s(b.x, b.y), C1 = w2s(c1.x, c1.y), C2 = w2s(c2.x, c2.y);
    const on = s.active && t.active;

    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.bezierCurveTo(C1.x, C1.y, C2.x, C2.y, B.x, B.y);
    ctx.strokeStyle = on ? COL.edge : COL.edgeOff;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(on ? [5, 4] : [2, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    const ang = Math.atan2(B.y - C2.y, B.x - C2.x), L = 7;
    ctx.beginPath();
    ctx.moveTo(B.x, B.y);
    ctx.lineTo(B.x - L * Math.cos(ang - 0.4), B.y - L * Math.sin(ang - 0.4));
    ctx.lineTo(B.x - L * Math.cos(ang + 0.4), B.y - L * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = on ? COL.arrow : COL.edgeOff;
    ctx.fill();

    if (S.ui.connect) {
      // střed Bézierovy křivky (t = 0,5) ve světových souřadnicích
      const mx = 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x;
      const my = 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y;
      let btn = edelPool.get(e.id);
      if (!btn) {
        btn = h('button', { type: 'button', class: 'edel', title: 'Smazat spoj', 'aria-label': 'Smazat spoj', text: '×' });
        const id = e.id;
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); removeEdge(id); });
        nl.append(btn);
        edelPool.set(e.id, btn);
      }
      btn.style.left = (mx - 8) + 'px';
      btn.style.top = (my - 8) + 'px';
      seen.add(e.id);
    }
  }
  for (const [id, btn] of edelPool) {
    if (!seen.has(id)) { btn.remove(); edelPool.delete(id); }
  }
  if (S.ui.csrc) {
    const src = byId.get(S.ui.csrc);
    if (src) {
      const p = portOut(src), P = w2s(p.x, p.y);
      ctx.beginPath();
      ctx.moveTo(P.x, P.y);
      ctx.lineTo(S.ui.mouse.x, S.ui.mouse.y);
      ctx.strokeStyle = COL.link; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

// ── DOM prvků ──
const ST_LABEL = { idle: 'připraveno', run: 'běží', wait: 'čeká na vstup', block: 'blokováno', full: 'plno', off: 'neaktivní' };

function buildNodeEl(n) {
  const T = TYPES[n.type];
  const del = h('button', { type: 'button', class: 'ndel', title: 'Smazat prvek', 'aria-label': 'Smazat prvek', text: '×' });
  if (n.type === 'textnode') {
    const body = h('div', { class: 'node-text-body', 'data-placeholder': 'Sem napište text…' });
    n.el = h('div', { class: 'node node-text' }, [del, body]);
    n.ui = { del, body };
  } else {
    const act = h('input', { type: 'checkbox', 'aria-label': 'Prvek je aktivní' });
    const actWrap = h('label', { class: 'nact', title: 'Aktivní prvek – odškrtnutím ho vyřadíte z toku' }, act);
    const name = h('div', { class: 'nname' });
    const refs = n.type === 'machine' ? h('div', { class: 'nrefs', hidden: true }) : null;
    const kap = isMT(n) ? h('span', { class: 'nbadge kap', hidden: true, text: '★ kap.' }) : null;
    const bn = h('span', { class: 'nbadge bn', hidden: true, text: 'úzké místo' });
    const main = h('div', { class: 'nmain', text: '–' });
    const sec = h('div', { class: 'nsec' });
    const fill = h('div', { class: 'nbar-fill' });
    const stxt = h('span', { class: 'stxt', text: ST_LABEL.idle });
    n.el = h('div', { class: 'node st-idle t-' + n.type }, [
      actWrap, del,
      h('div', { class: 'nico', text: T.icon }),
      name, refs,
      h('div', { class: 'nmeta' }, [h('span', { class: 'ntype' }, [h('i', { class: 'tdot' }), T.tag]), kap, bn]),
      main, sec,
      h('div', { class: 'nbar' }, fill),
      h('div', { class: 'nstate' }, [h('i', { class: 'sdot' }), stxt]),
      h('div', { class: 'nport np-out', title: 'Výstup', dataset: { pt: 'out' } }),
      h('div', { class: 'nport np-in', title: 'Vstup', dataset: { pt: 'in' } }),
    ]);
    n.ui = { del, act, name, refs, kap, bn, main, sec, fill, stxt };
    n._st = 'idle';
  }
  n.el.dataset.id = n.id;
  placeNode(n);
}

function placeNode(n) {
  n.el.style.left = n.x + 'px';
  n.el.style.top = n.y + 'px';
}

// Promítne parametry (název, reference, štítky, aktivitu) do karty prvku.
function refreshNodeHeader(n) {
  const u = n.ui, p = n.params;
  if (n.type === 'textnode') {
    u.body.textContent = p.content;
    u.body.style.fontSize = p.fontSize + 'px';
    u.body.style.color = p.color || '';
    u.body.style.fontWeight = p.bold ? '700' : '400';
    u.body.style.fontStyle = p.italic ? 'italic' : 'normal';
    n.el.style.background = p.bgColor || '';
    return;
  }
  u.name.textContent = p.name || TYPES[n.type].label;
  u.name.title = u.name.textContent;
  if (u.refs) {
    const r = p.refs || [];
    u.refs.textContent = refLabel(r);
    u.refs.title = r.length ? 'Reference: ' + refLabel(r) : '';
    u.refs.hidden = r.length === 0;
  }
  if (u.kap) {
    u.kap.hidden = !p.kapRelevant;
    n.el.classList.toggle('kap-rel', !!p.kapRelevant);
  }
  u.act.checked = n.active;
  n.el.classList.toggle('inactive', !n.active);
  if (!n.active) setStatus(n, 'off');
  else if (n._st === 'off') setStatus(n, 'idle');
}

function setStatus(n, st, label) {
  if (!n.ui || !n.ui.stxt) return;
  const txt = label || ST_LABEL[st];
  if (n._st === st && n._stl === txt) return;
  n.el.classList.remove('st-' + n._st);
  n.el.classList.add('st-' + st);
  n.ui.stxt.textContent = txt;
  n._st = st; n._stl = txt;
}

// ── DOM pozadí ──
function buildShapeEl(s) {
  const lbl = h('span', { class: 'shape-lbl' });
  const del = h('button', { type: 'button', class: 'sdel', title: 'Smazat pozadí', 'aria-label': 'Smazat pozadí', text: '×' });
  const handle = h('div', { class: 'shandle', title: 'Změnit velikost' });
  s.el = h('div', { class: 'shape' }, [lbl, del, handle]);
  s.el.dataset.id = s.id;
  s.ui = { lbl, del, handle };
  layoutShape(s);
}

function layoutShape(s) {
  const st = s.el.style;
  st.left = s.x + 'px'; st.top = s.y + 'px';
  st.width = s.w + 'px'; st.height = s.h + 'px';
  st.setProperty('--shape-color', s.color);
  s.el.classList.toggle('round', SHAPE_KINDS[s.kind].round);
  if (s.ui) s.ui.lbl.textContent = s.label || '';
}

// ── Animace toku (Web Animations API, omezený počet) ──
let dotCount = 0;
const MAX_DOTS = 150;
function spawnDot(a, b) {
  if (dotCount >= MAX_DOTS || !a.el || !b.el || !a.el.isConnected || !b.el.isConnected) return;
  // Tečka jede po křivce spoje: keyframy z bodů Bézierovy křivky.
  const g = edgeGeom(a, b), STEPS = 16, frames = [];
  for (let i = 0; i <= STEPS; i++) {
    const p = bezierAt(g, i / STEPS);
    frames.push({ transform: 'translate(' + (p.x - g.a.x) + 'px,' + (p.y - g.a.y) + 'px) translate(-50%,-50%)' });
  }
  const el = h('div', { class: 'adot' });
  el.style.background = 'var(--cat-' + (TYPES[b.type].cat || 1) + ')';
  el.style.left = g.a.x + 'px';
  el.style.top = g.a.y + 'px';
  nl.append(el);
  dotCount++;
  const anim = el.animate(frames, { duration: 1200, easing: 'linear' });
  const done = () => { el.remove(); dotCount--; };
  anim.onfinish = done;
  anim.oncancel = done;
}
function clearDots() {
  nl.querySelectorAll('.adot').forEach((d) => d.getAnimations().forEach((a) => a.cancel()));
}

// ── Tooltip s detailem prvku (během simulace) ──
let tipNode = null;

function showTooltip(n) { tipNode = n; refreshTooltip(); }
function hideTooltip() { tipNode = null; $('tip').hidden = true; }

function refreshTooltip() {
  const tip = $('tip'), n = tipNode;
  if (!n || !n.el.isConnected || !n.rt || S.ui.drag || (S.sim.t <= 0 && !S.sim.running)) { tip.hidden = true; return; }
  const body = tooltipContent(n);
  if (!body) { tip.hidden = true; return; }
  tip.replaceChildren(...body);
  tip.hidden = false;
  const r = n.el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.right + 10;
  if (x + tw > window.innerWidth - 8) x = r.left - tw - 10;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = clamp(r.top, 8, Math.max(8, window.innerHeight - th - 8)) + 'px';
}

const ttSec = (text) => h('div', { class: 'tt-sec', text });
const ttEmpty = (text) => h('div', { class: 'tt-empty', text });
function ttRow(label, value, pct, color, cls) {
  const kids = [h('span', {}, label), h('b', { text: value })];
  if (pct != null) {
    const fill = h('i');
    fill.style.width = clamp(pct * 100, 0, 100) + '%';
    if (color) fill.style.background = color;
    kids.push(h('div', { class: 'tt-bar' }, fill));
  }
  return h('div', { class: 'tt-row' + (cls ? ' ' + cls : '') }, kids);
}
function ttRef(ref) {
  const dot = h('i', { class: 'rdot' });
  dot.style.background = refColor(ref);
  return [dot, refName(ref)];
}
const countBy = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
const sortRefs = (keys) => [...keys].sort((a, b) => (a === REF_NONE) - (b === REF_NONE) || a.localeCompare(b, 'cs'));

function tooltipContent(n) {
  const rt = n.rt, p = n.params, out = [h('div', { class: 'tt-h', text: p.name })];
  if (n.type === 'packing') {
    const cap = p.capacity;
    out.push(h('div', { class: 'tt-sub', text: 'kapacita obalu ' + fmt(cap) + ' ks · ' + p.count + ' obalů' }));
    out.push(ttSec('Rozplněné obaly'));
    if (!rt.open.size) out.push(ttEmpty('žádný obal se neplní'));
    for (const ref of sortRefs(rt.open.keys())) {
      const f = rt.open.get(ref);
      out.push(ttRow(ttRef(ref), fmt(f) + ' / ' + fmt(cap) + ' ks', f / cap, refColor(ref)));
    }
    out.push(ttSec('Obaly v oběhu'));
    const row = (label, v) => ttRow(label, String(v), v / p.count);
    out.push(row('Volné (prázdné)', rt.pool));
    out.push(row('Rozplněné', rt.open.size));
    out.push(row('Plné, čekají na odvoz', rt.waiting.length));
    if (rt.waiting.length) {
      const w = countBy(rt.waiting, (r) => r);
      if (w.size > 1 || !w.has(REF_NONE)) for (const ref of sortRefs(w.keys())) out.push(ttRow(ttRef(ref), String(w.get(ref)), null, null, 'tt-indent'));
    }
    out.push(row('V temperaci', rt.inTemp));
    out.push(row('Ve zpracování', rt.inCons));
    if (rt.inWh) out.push(row('Ve skladu', rt.inWh));
  } else if (isMT(n)) {
    out.push(h('div', { class: 'tt-sub', text: 'takt ' + fmtNum(p.takt) + ' s · ' + p.nasob + ' ks/cyklus · OEE ' + fmtNum(p.oee) + ' %' }));
    out.push(ttSec('Vyrobeno'));
    const total = bagTotal(rt.madeBy);
    if (!total) out.push(ttEmpty('zatím nic'));
    for (const ref of sortRefs(rt.madeBy.keys())) {
      const v = rt.madeBy.get(ref);
      out.push(ttRow(ttRef(ref), fmt(v) + ' ks · ' + Math.round(v / total * 100) + ' %', v / total, refColor(ref)));
    }
    if (rt.pieceBuf.size || rt.packQueue.length || rt.cur) {
      out.push(ttSec('Na vstupu'));
      for (const ref of sortRefs(rt.pieceBuf.keys())) out.push(ttRow(ttRef(ref), fmt(rt.pieceBuf.get(ref)) + ' ks'));
      if (rt.cur) out.push(ttRow(['Zpracovává obal ', ...ttRef(rt.cur.ref)], fmt(rt.cur.pcs) + ' ks'));
      if (rt.packQueue.length) out.push(ttRow('Obaly ve frontě', String(rt.packQueue.length)));
    }
  } else if (n.type === 'tempering' || n.type === 'warehouse') {
    const isT = n.type === 'tempering', items = isT ? rt.queue : rt.items;
    const rc = p.refCap, perRef = rc && rc.on, gen = genCap(n);
    const info = isT ? 'doba ' + fmtNum(p.hoursMin) + ' h · ' : '';
    const tail = isT ? '' : ' · vydáno ' + fmt(rt.outTotal);
    out.push(h('div', { class: 'tt-sub', text: info + 'kapacita ' + fmt(capTotal(n)) + ' obalů' + (perRef ? ' (po referencích)' : '') + tail }));
    out.push(ttSec(isT ? 'Obsazeno' : 'Obsah'));
    const c = countBy(items, (i) => i.ref);
    const pcsOf = (pred) => items.filter(pred).reduce((s2, i) => s2 + i.pcs, 0);
    const row = (label, k, cap, pred, color) =>
      ttRow(label, k + (cap != null ? ' / ' + fmt(cap) : '') + ' obalů · ' + fmt(pcsOf(pred)) + ' ks', cap ? k / cap : (cap === 0 ? 1 : k / gen), color);
    if (perRef) {
      // každá vypsaná reference se svým limitem + společná část pro ostatní
      for (const e of rc.list) out.push(row(ttRef(e.name), c.get(e.name) || 0, e.cap, (i) => i.ref === e.name, refColor(e.name)));
      const listed = new Set(rc.list.map((e) => e.name));
      out.push(row('Ostatní', items.filter((i) => !listed.has(i.ref)).length, gen, (i) => !listed.has(i.ref)));
    } else {
      if (!items.length) out.push(ttEmpty(isT ? 'prázdná' : 'prázdný'));
      for (const ref of sortRefs(c.keys())) out.push(row(ttRef(ref), c.get(ref), null, (i) => i.ref === ref, refColor(ref)));
    }
  } else {
    return null;
  }
  return out;
}
