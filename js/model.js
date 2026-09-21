'use strict';
// Datový model: typy prvků, parametry, validace, stav aplikace, import/export.

const TYPES = {
  machine:    { label: 'Stroj',      tag: 'stroj',      icon: '⚙️', cat: 1 },
  kompletace: { label: 'Kompletace', tag: 'kompletace', icon: '🧩', cat: 3 },
  packing:    { label: 'Obal',       tag: 'obal',       icon: '📦', cat: 6 },
  tempering:  { label: 'Temperace',  tag: 'temperace',  icon: '🕐', cat: 2 },
  warehouse:  { label: 'Sklad',      tag: 'sklad',      icon: '🗄️', cat: 7 },
  textnode:   { label: 'Text',       tag: 'text',       icon: null, cat: 0 },
};
const hasType = (t) => typeof t === 'string' && Object.prototype.hasOwnProperty.call(TYPES, t);
const isMT = (n) => n.type === 'machine' || n.type === 'kompletace';

const SHAPE_KINDS = {
  square:  { label: 'Čtverec',  icon: '□', lock: true,  round: false },
  rect:    { label: 'Obdélník', icon: '▭', lock: false, round: false },
  circle:  { label: 'Kruh',     icon: '○', lock: true,  round: true },
  ellipse: { label: 'Elipsa',   icon: '⬭', lock: false, round: true },
};
const hasShapeKind = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(SHAPE_KINDS, k);

const PASTELS = [
  { name: 'Azurová',     hex: '#8FD5F7' },
  { name: 'Mátová',      hex: '#8EE0D2' },
  { name: 'Levandulová', hex: '#BDB8F5' },
  { name: 'Šalvějová',   hex: '#C3D8B4' },
  { name: 'Pískovcová',  hex: '#EFD49C' },
  { name: 'Růžová',      hex: '#F2B3D3' },
  { name: 'Broskvová',   hex: '#F5C0A3' },
  { name: 'Šedá',        hex: '#D4D4CB' },
];

const LIMITS = { fileBytes: 5 * 1024 * 1024, nodes: 1000, edges: 5000, shapes: 500, coord: 1e6 };

// ── Parametry: specifikace polí (popup + validace importu) ──
const F_NAME = { key: 'name', label: 'Název', kind: 'text', max: 80 };
const F_KUS  = { key: 'kusovnik', label: 'Kusovník', unit: 'ks vstupů / 1 výstup', kind: 'num', min: 1, max: 1000, int: true };
const MT_FIELDS = [
  { key: 'shiftH', label: 'Délka směny', unit: 'h', kind: 'num', min: 0.5, max: 24 },
  { key: 'shiftsWeek', label: 'Směn/týden', kind: 'num', min: 0, max: 21, int: true },
  { key: 'oee', label: 'OEE', unit: '%', kind: 'num', min: 1, max: 100 },
  { key: 'takt', label: 'Takt', unit: 's/cyklus', kind: 'num', min: 0.1, max: 86400 },
  { key: 'nasob', label: 'Násobnost', unit: 'ks/cyklus', kind: 'num', min: 1, max: 10000, int: true },
  { key: 'kapRelevant', label: 'Kapacitně relevantní', kind: 'check' },
  F_KUS,
];
const FIELDS = {
  machine: [F_NAME, { key: 'refs', label: 'Reference a podíl', unit: 'max. 4', kind: 'refs', maxItems: 4, max: 60 }, ...MT_FIELDS],
  kompletace: [F_NAME, ...MT_FIELDS],
  packing: [
    F_NAME,
    { key: 'group', label: 'Skupina obalů', unit: 'nepovinné', kind: 'text', max: 40 },
    { key: 'capacity', label: 'Kapacita obalu', unit: 'ks', kind: 'num', min: 1, max: 1e6, int: true },
    { key: 'count', label: 'Počet obalů', unit: 'ks', kind: 'num', min: 1, max: 1e5, int: true },
    F_KUS,
  ],
  tempering: [
    F_NAME,
    { key: 'hoursMin', label: 'Doba temperace', unit: 'hod', kind: 'num', min: 0, max: 1000 },
    { key: 'maxObals', label: 'Max. kapacita', unit: 'obalů', kind: 'num', min: 0, max: 1e5, int: true, minOff: 1 },
    F_KUS,
    { key: 'refCap', label: 'Kapacita pro reference', kind: 'refcaps', maxItems: 8, max: 60, min: 1, capMax: 1e5 },
  ],
  warehouse: [
    F_NAME,
    { key: 'capacity', label: 'Kapacita skladu', unit: 'obalů', kind: 'num', min: 0, max: 1e5, int: true, minOff: 1 },
    { key: 'refCap', label: 'Kapacita pro reference', kind: 'refcaps', maxItems: 8, max: 60, min: 1, capMax: 1e5 },
  ],
  textnode: [
    { key: 'content', label: 'Obsah', kind: 'textarea', max: 5000 },
    { key: 'fontSize', label: 'Velikost písma', unit: 'px', kind: 'num', min: 8, max: 96 },
    { key: 'color', label: 'Barva textu', kind: 'color', fallback: '#F5F5F1' },
    { key: 'bgColor', label: 'Barva pozadí', kind: 'color', fallback: '#262624' },
    { key: 'bold', label: 'Tučně', kind: 'check' },
    { key: 'italic', label: 'Kurzíva', kind: 'check' },
  ],
};

function defaultParams(type) {
  switch (type) {
    case 'machine':    return { name: 'Stroj', refs: [], shiftH: 12, shiftsWeek: 10, oee: 85, takt: 40, nasob: 6, kapRelevant: false, kusovnik: 1 };
    case 'kompletace': return { name: 'Kompletace', shiftH: 12, shiftsWeek: 10, oee: 85, takt: 45, nasob: 3, kapRelevant: false, kusovnik: 1 };
    case 'packing':    return { name: 'Obal', group: '', capacity: 350, count: 10, kusovnik: 1 };
    case 'tempering':  return { name: 'Temperace', hoursMin: 6, maxObals: 20, kusovnik: 1, refCap: { on: false, list: [] } };
    case 'warehouse':  return { name: 'Sklad', capacity: 50, refCap: { on: false, list: [] } };
    case 'textnode':   return { content: '', fontSize: 14, color: '', bgColor: '', bold: false, italic: false };
  }
  throw new Error('Neznámý typ prvku');
}

// Vrátí nový objekt jen se známými klíči, správnými typy a hodnotami v povoleném rozsahu.
function sanitizeParams(type, raw) {
  const out = defaultParams(type);
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const f of FIELDS[type]) {
    const v = src[f.key];
    if (v === undefined) continue;
    switch (f.kind) {
      case 'text':
      case 'textarea':
        if (typeof v === 'string' || typeof v === 'number') out[f.key] = String(v).slice(0, f.max);
        break;
      case 'num': {
        const x = Number(v);
        if (Number.isFinite(x)) out[f.key] = clamp(f.int ? Math.round(x) : x, f.min, f.max);
        break;
      }
      case 'check':
        out[f.key] = v === true;
        break;
      case 'color':
        out[f.key] = isHexColor(v) ? v : '';
        break;
      case 'refcaps':
        // { on, list: [{ name, cap }] } – vlastní kapacita skladu pro vybrané reference
        if (v && typeof v === 'object') {
          const list = Array.isArray(v.list) ? v.list : [];
          const seen = new Set();
          out[f.key] = {
            on: v.on === true,
            list: list.map((r) => {
              if (!r || typeof r !== 'object' || (typeof r.name !== 'string' && typeof r.name !== 'number')) return null;
              const name = String(r.name).trim().slice(0, f.max), cap = Number(r.cap);
              if (!name || seen.has(name) || !Number.isFinite(cap)) return null;
              seen.add(name);
              return { name, cap: clamp(Math.round(cap), f.min, f.capMax) };
            }).filter(Boolean).slice(0, f.maxItems),
          };
        }
        break;
      case 'refs':
        // Nový formát [{name, share}]; starší export měl jen pole názvů.
        if (Array.isArray(v)) {
          out[f.key] = v.map((r) => {
            if (typeof r === 'string' || typeof r === 'number') return { name: String(r).trim().slice(0, f.max), share: null };
            if (r && typeof r === 'object' && (typeof r.name === 'string' || typeof r.name === 'number')) {
              const s = Number(r.share);
              const share = r.share == null || r.share === '' || !Number.isFinite(s) ? null : clamp(s, 0, 100);
              return { name: String(r.name).trim().slice(0, f.max), share };
            }
            return null;
          }).filter((r) => r && r.name).slice(0, f.maxItems);
        }
        break;
    }
  }
  // Obecná kapacita smí být 0 jen se zapnutou kapacitou pro reference (minOff = minimum bez ní).
  for (const f of FIELDS[type]) {
    if (f.minOff != null && !(out.refCap && out.refCap.on) && out[f.key] < f.minOff) out[f.key] = f.minOff;
  }
  return out;
}

// ── Reference ──
// Podíly: vyplněné se berou, jak jsou; nevyplněné si rovným dílem rozdělí zbytek do 100 %.
// Výsledek je normalizovaný (součet w = 1).
function refShares(refs) {
  if (!refs || !refs.length) return [];
  const fixed = refs.filter((r) => r.share != null), free = refs.length - fixed.length;
  const sumFixed = fixed.reduce((s, r) => s + r.share, 0);
  const each = free ? Math.max(0, 100 - sumFixed) / free : 0;
  const list = refs.map((r) => ({ name: r.name, w: r.share != null ? r.share : each }));
  const tot = list.reduce((s, r) => s + r.w, 0);
  return list.map((r) => ({ name: r.name, w: tot > 0 ? r.w / tot : 1 / list.length }));
}
function refLabel(refs) {
  if (!refs || !refs.length) return '';
  if (refs.length === 1) return refs[0].name;
  return refShares(refs).map((r) => r.name + ' ' + Math.round(r.w * 100) + ' %').join(' · ');
}
const REF_NONE = '';
// Všechny reference definované na strojích v modelu (pro nabídku u skladu).
const knownRefs = () => [...new Set(S.nodes.flatMap((n) => (n.type === 'machine' && n.params.refs ? n.params.refs.map((r) => r.name) : [])))]
  .sort((a, b) => a.localeCompare(b, 'cs'));
const refName = (r) => (r === REF_NONE ? 'bez reference' : r);
// Stálá barva reference (kategoriální paleta, přidělená v pořadí, jak se reference objeví).
const REF_COLORS = new Map();
function refColor(ref) {
  if (ref === REF_NONE) return 'var(--idle-fill)';
  if (!REF_COLORS.has(ref)) REF_COLORS.set(ref, 'var(--cat-' + ((REF_COLORS.size % 8) + 1) + ')');
  return REF_COLORS.get(ref);
}

// ── Stav aplikace ──
const S = {
  nodes: [], edges: [], shapes: [],
  nid: 1, eid: 1, sid: 1,
  view: { x: 0, y: 0, k: 1 },
  sim: { running: false, paused: false, t: 0, timer: null },
  ui: {
    connect: false, csrc: null,       // režim spojů, vybraný zdroj
    draw: null, drawColor: PASTELS[0].hex,
    selShape: null, drag: null,
    statsOpen: false,
    packMax: new Map(),     // skupina obalů → max. počet plných obalů od startu
    mouse: { x: 0, y: 0 },
  },
};

const nodeById = (id) => S.nodes.find((n) => n.id === id);
const shapeById = (id) => S.shapes.find((s) => s.id === id);

function canConnect(from, to) {
  if (!from || !to || from.id === to.id) return false;
  if (from.type === 'textnode' || to.type === 'textnode') return false;
  return !S.edges.some((e) => e.from === from.id && e.to === to.id);
}

// ── Export ──
function serializeModel() {
  return {
    app: 'simulator-linky',
    version: 2,
    nodes: S.nodes.map((n) => ({
      id: n.id, type: n.type, x: n.x, y: n.y, active: n.active,
      params: JSON.parse(JSON.stringify(n.params)),
    })),
    edges: S.edges.map((e) => ({ from: e.from, to: e.to })),
    shapes: S.shapes.map((s) => ({ kind: s.kind, x: s.x, y: s.y, w: s.w, h: s.h, color: s.color, label: s.label })),
  };
}

// ── Import: přísná validace; neplatné položky se přeskočí a spočítají ──
function parseModel(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) {
    throw new Error('Soubor neobsahuje platný model (chybí seznam prvků).');
  }
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];
  const rawShapes = Array.isArray(data.shapes) ? data.shapes : [];
  if (data.nodes.length > LIMITS.nodes || rawEdges.length > LIMITS.edges || rawShapes.length > LIMITS.shapes) {
    throw new Error('Model je příliš velký (max. ' + LIMITS.nodes + ' prvků, ' + LIMITS.edges + ' spojů, ' + LIMITS.shapes + ' pozadí).');
  }
  const coord = (v) => { const x = Number(v); return Number.isFinite(x) ? clamp(x, -LIMITS.coord, LIMITS.coord) : null; };
  let skipped = 0;

  const nodes = [], types = new Map();
  for (const r of data.nodes) {
    const id = r && Number(r.id);
    const x = r && coord(r.x), y = r && coord(r.y);
    if (!r || !hasType(r.type) || !Number.isInteger(id) || id < 1 || id > 1e9 || types.has(id) || x === null || y === null) {
      skipped++; continue;
    }
    types.set(id, r.type);
    nodes.push({ id, type: r.type, x, y, active: r.active !== false, params: sanitizeParams(r.type, r.params) });
  }

  const edges = [], seen = new Set();
  for (const r of rawEdges) {
    const from = r && Number(r.from), to = r && Number(r.to);
    const key = from + '>' + to;
    if (!types.has(from) || !types.has(to) || from === to || seen.has(key)
        || types.get(from) === 'textnode' || types.get(to) === 'textnode') { skipped++; continue; }
    seen.add(key);
    edges.push({ from, to });
  }

  const shapes = [];
  for (const r of rawShapes) {
    const x = r && coord(r.x), y = r && coord(r.y), w = r && coord(r.w), hh = r && coord(r.h);
    if (!r || !hasShapeKind(r.kind) || x === null || y === null || w === null || hh === null) { skipped++; continue; }
    let sw = clamp(w, 10, 1e5), sh = clamp(hh, 10, 1e5);
    if (SHAPE_KINDS[r.kind].lock) sw = sh = Math.max(sw, sh);
    shapes.push({
      kind: r.kind, x, y, w: sw, h: sh,
      color: isHexColor(r.color) ? r.color : PASTELS[0].hex,
      label: typeof r.label === 'string' ? r.label.slice(0, 60) : '',
    });
  }
  return { nodes, edges, shapes, skipped };
}
