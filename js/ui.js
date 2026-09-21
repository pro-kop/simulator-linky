'use strict';
// Editor: prvky, spoje, pozadí, popupy, ovládání myší/klávesnicí, import/export.

// ── Prvky ──
function createNode(type, x, y, params, id, active) {
  const nodeId = id || S.nid++;
  if (nodeId >= S.nid) S.nid = nodeId + 1;
  const n = { id: nodeId, type, x, y, active: active !== false, params: params || defaultParams(type), rt: null, el: null, ui: null };
  buildNodeEl(n);
  bindNode(n);
  nl.append(n.el);
  S.nodes.push(n);
  initRt(n);
  refreshNodeHeader(n);
  drawEdges();
  return n;
}

function bindNode(n) {
  const el = n.el;
  const isCtl = (t) => t.closest('.nport, .ndel, .nact');
  if (n.type !== 'textnode') {
    el.addEventListener('mouseenter', () => showTooltip(n));
    el.addEventListener('mouseleave', hideTooltip);
  }
  el.addEventListener('mousedown', (e) => {
    hideTooltip();
    if (e.button !== 0 || S.ui.draw || S.ui.connect || isCtl(e.target)) return;
    const w = eventWorld(e);
    S.ui.drag = { kind: 'node', n, ox: w.x - n.x, oy: w.y - n.y };
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('dblclick', (e) => { if (!isCtl(e.target) && !S.ui.draw) openNodePopup(n); });
  el.addEventListener('click', (e) => {
    const port = e.target.closest('.nport');
    if (!port || !S.ui.connect) return;
    e.stopPropagation();
    handlePort(n, port.dataset.pt);
  });
  n.ui.del.addEventListener('click', (e) => { e.stopPropagation(); deleteNode(n); });
  if (n.ui.act) {
    n.ui.act.parentElement.addEventListener('mousedown', (e) => e.stopPropagation());
    n.ui.act.addEventListener('change', () => setActive(n, n.ui.act.checked));
  }
}

function setActive(n, on) {
  n.active = !!on;
  // Po znovuaktivaci stroj navazuje od aktuálního času – nedohání cykly za dobu vypnutí.
  if (n.active && n.rt && isMT(n) && n.rt.nextAt !== Infinity) n.rt.nextAt = Math.max(n.rt.nextAt, S.sim.t);
  refreshNodeHeader(n);
  drawEdges();
  updateStats();
}

function deleteNode(n) {
  hideTooltip();
  S.nodes = S.nodes.filter((x) => x !== n);
  S.edges = S.edges.filter((e) => e.from !== n.id && e.to !== n.id);
  if (S.ui.csrc === n.id) S.ui.csrc = null;
  if (POP.target === n) closePopup();
  n.el.remove();
  drawEdges();
  updateStats();
}

function addEdge(from, to) {
  if (!canConnect(nodeById(from), nodeById(to))) return false;
  S.edges.push({ id: S.eid++, from, to });
  return true;
}
function removeEdge(id) {
  S.edges = S.edges.filter((e) => e.id !== id);
  drawEdges();
}

function handlePort(n, pt) {
  if (pt === 'out') {
    const prev = nodeById(S.ui.csrc);
    if (prev) prev.el.classList.remove('csrc');
    S.ui.csrc = n.id;
    n.el.classList.add('csrc');
  } else if (pt === 'in' && S.ui.csrc && S.ui.csrc !== n.id) {
    addEdge(S.ui.csrc, n.id);
    cancelLink();
  }
  drawEdges();
}
function cancelLink() {
  const src = nodeById(S.ui.csrc);
  if (src) src.el.classList.remove('csrc');
  S.ui.csrc = null;
}

function setConnectMode(on) {
  S.ui.connect = on;
  cancelLink();
  $('cmb').classList.toggle('on', on);
  wrap.classList.toggle('connect', on);
  drawEdges();
}

// ── Pozadí ──
function createShape(d, select) {
  const s = { id: S.sid++, kind: d.kind, x: d.x, y: d.y, w: d.w, h: d.h, color: d.color, label: d.label || '', el: null, ui: null };
  buildShapeEl(s);
  bindShape(s);
  bgl.append(s.el);
  S.shapes.push(s);
  if (select) selectShape(s);
  return s;
}

function bindShape(s) {
  s.el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || S.ui.draw) return;       // v režimu kreslení nechá událost plátnu
    if (e.target === s.ui.del) { e.stopPropagation(); return; }
    const w = eventWorld(e);
    if (e.target === s.ui.handle) {
      S.ui.drag = { kind: 'resize', s };
    } else if (S.ui.selShape === s) {
      S.ui.drag = { kind: 'shape', s, ox: w.x - s.x, oy: w.y - s.y };
    } else {
      return;                                      // nevybraný tvar: tažení posouvá plátno, klik vybere
    }
    e.preventDefault(); e.stopPropagation();
  });
  s.ui.del.addEventListener('click', (e) => { e.stopPropagation(); deleteShape(s); });
  s.el.addEventListener('dblclick', () => { if (!S.ui.draw) openShapePopup(s); });
}

function selectShape(s) {
  if (S.ui.selShape && S.ui.selShape.el) S.ui.selShape.el.classList.remove('sel');
  S.ui.selShape = s || null;
  if (s) s.el.classList.add('sel');
}

function deleteShape(s) {
  if (S.ui.selShape === s) S.ui.selShape = null;
  if (POP.target === s) closePopup();
  S.shapes = S.shapes.filter((x) => x !== s);
  s.el.remove();
}

function setDrawMode(kind) {
  S.ui.draw = kind || null;
  wrap.classList.toggle('drawing', !!kind);
  document.querySelectorAll('.bg-kind').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  if (kind) { setConnectMode(false); selectShape(null); }
}

// Obdélník tažení od (x0,y0) k (x1,y1); čtverec/kruh drží stejnou šířku a výšku.
function dragRect(kind, x0, y0, x1, y1) {
  let w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
  if (SHAPE_KINDS[kind].lock) w = hh = Math.max(w, hh);
  return { x: x1 < x0 ? x0 - w : x0, y: y1 < y0 ? y0 - hh : y0, w, h: hh };
}

// ── Popup ──
const POP = { target: null, onSave: null };

function openPopup(title, rows, onSave, target) {
  $('ptitle').textContent = title;
  $('pfields').replaceChildren(...rows);
  POP.onSave = onSave;
  POP.target = target;
  $('pop').hidden = false;
  $('ov').hidden = false;
  const first = $('pfields').querySelector('input[type=text], textarea');
  if (first) first.focus();
}
function closePopup() {
  $('pop').hidden = true;
  $('ov').hidden = true;
  $('pfields').replaceChildren();
  POP.onSave = null;
  POP.target = null;
}
function savePopup() {
  if (POP.onSave && POP.onSave() !== false) closePopup();
}

// Jedno pole formuláře podle specifikace z FIELDS. Vrací { el, key, read() }.
function fieldRow(f, value) {
  const id = 'pf-' + f.key;
  const label = f.label + (f.unit ? ' (' + f.unit + ')' : '');
  const err = h('div', { class: 'pf-err' });
  let control, read;

  switch (f.kind) {
    case 'text': {
      const inp = h('input', { type: 'text', id, maxlength: f.max, autocomplete: 'off' });
      inp.value = value == null ? '' : String(value);
      control = inp;
      read = () => ({ value: inp.value.trim().slice(0, f.max) });
      break;
    }
    case 'textarea': {
      const ta = h('textarea', { id, maxlength: f.max, placeholder: 'Sem napište text…' });
      ta.value = value || '';
      control = ta;
      read = () => ({ value: ta.value.slice(0, f.max) });
      break;
    }
    case 'num': {
      const inp = h('input', { type: 'text', id, inputmode: 'decimal', autocomplete: 'off' });
      inp.value = String(value);
      control = inp;
      read = () => {
        const raw = inp.value.trim().replace(',', '.');
        const v = Number(raw);
        if (raw === '' || !Number.isFinite(v) || v < f.min || v > f.max || (f.int && !Number.isInteger(v))) {
          return { error: 'Zadejte ' + (f.int ? 'celé ' : '') + 'číslo v rozsahu ' + fmtNum(f.min) + ' – ' + fmtNum(f.max) + '.' };
        }
        return { value: v };
      };
      break;
    }
    case 'check': {
      const cb = h('input', { type: 'checkbox', id });
      cb.checked = !!value;
      const row = h('div', { class: 'pf' }, h('label', { class: 'pf-check' }, [cb, f.label]));
      return { el: row, key: f.key, read: () => ({ value: cb.checked }) };
    }
    case 'color': {
      const col = h('input', { type: 'color', id });
      col.value = value || f.fallback;
      const none = h('input', { type: 'checkbox' });
      none.checked = !value;
      col.addEventListener('input', () => { none.checked = false; });
      control = h('div', { class: 'pf-color-row' }, [col, h('label', { class: 'pf-check' }, [none, 'bez barvy'])]);
      read = () => ({ value: none.checked ? '' : col.value });
      break;
    }
    case 'refcaps': {
      // Zaškrtnutím se zapne vlastní kapacita pro vybrané reference; ostatní sdílí obecnou kapacitu.
      const v = value || { on: false, list: [] };
      const on = h('input', { type: 'checkbox', id });
      on.checked = !!v.on;
      const dl = h('datalist', { id: id + '-names' }, knownRefs().map((r) => h('option', { value: r })));
      const list = h('div', { class: 'refs' });
      const rows = [];
      const lastFilled = () => { const r = rows[rows.length - 1]; return !r || r.name.value.trim() !== ''; };
      const add = (r) => {
        const i = rows.length + 1;
        const name = h('input', { type: 'text', maxlength: f.max, autocomplete: 'off', list: id + '-names', placeholder: 'Reference ' + i, 'aria-label': 'Reference ' + i });
        const cap = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'obalů', 'aria-label': 'Kapacita reference ' + i + ' v obalech' });
        name.value = (r && r.name) || '';
        cap.value = r && r.cap != null ? String(r.cap) : '';
        name.addEventListener('input', () => { if (lastFilled() && rows.length < f.maxItems) add(null); });
        rows.push({ name, cap });
        list.append(h('div', { class: 'ref-row' }, [name, cap]));
      };
      v.list.forEach(add);
      const detail = h('div', { class: 'refcap-detail' }, [
        list, dl,
        h('div', { class: 'pf-note', text: 'Plná kapacita reference zastaví jen tuto referenci. Ostatní reference (i bez reference) sdílí obecnou kapacitu výše – ta může být 0, pak se přijímají jen vypsané reference.' }),
      ]);
      const sync = () => {
        detail.hidden = !on.checked;
        if (on.checked && !rows.length) knownRefs().slice(0, f.maxItems).forEach((n) => add({ name: n }));
        if (rows.length < f.maxItems && lastFilled()) add(null);
      };
      on.addEventListener('change', sync);
      sync();
      control = h('div', {}, [h('label', { class: 'pf-check' }, [on, f.label]), detail]);
      read = () => {
        const out = [], seen = new Set();
        for (const r of rows) {
          const nm = r.name.value.trim().slice(0, f.max);
          if (!nm) continue;
          if (seen.has(nm)) return { error: 'Reference „' + nm + '“ je uvedena dvakrát.' };
          seen.add(nm);
          const c = Number(r.cap.value.trim());
          if (!on.checked && r.cap.value.trim() === '') continue;
          if (!Number.isInteger(c) || c < f.min || c > f.capMax) return { error: 'Kapacitu reference „' + nm + '“ zadejte jako celé číslo 1 – ' + fmtNum(f.capMax) + ' obalů.' };
          out.push({ name: nm, cap: c });
        }
        if (on.checked && !out.length) return { error: 'Zadejte alespoň jednu referenci s kapacitou, nebo volbu vypněte.' };
        return { value: { on: on.checked, list: out } };
      };
      const row = h('div', { class: 'pf' }, [control, err]);
      return {
        el: row, key: f.key,
        read: () => { const r = read(); err.textContent = r.error || ''; row.classList.toggle('err', !!r.error); return r; },
      };
    }
    case 'refs': {
      // Řádek = název reference + podíl v %. Prázdný podíl = rovným dílem ze zbytku do 100 %.
      const list = h('div', { class: 'refs', id });
      const rows = [];
      const lastFilled = () => { const r = rows[rows.length - 1]; return !r || r.name.value.trim() !== ''; };
      const add = (v) => {
        const i = rows.length + 1;
        const name = h('input', { type: 'text', maxlength: f.max, autocomplete: 'off', placeholder: 'Reference ' + i, 'aria-label': 'Reference ' + i });
        const share = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'auto %', 'aria-label': 'Podíl reference ' + i + ' v %' });
        name.value = (v && v.name) || '';
        share.value = v && v.share != null ? String(v.share) : '';
        name.addEventListener('input', () => { if (lastFilled() && rows.length < f.maxItems) add(null); });
        rows.push({ name, share });
        list.append(h('div', { class: 'ref-row' }, [name, share]));
      };
      (value || []).forEach((v) => add(v));
      if (rows.length < f.maxItems && lastFilled()) add(null);
      control = h('div', {}, [list, h('div', { class: 'pf-note', text: 'Prázdný podíl = zbytek do 100 % rovným dílem.' })]);
      read = () => {
        const out = [];
        for (const r of rows) {
          const nm = r.name.value.trim().slice(0, f.max);
          if (!nm) continue;
          const raw = r.share.value.trim().replace(',', '.').replace('%', '').trim();
          let share = null;
          if (raw !== '') {
            share = Number(raw);
            if (!Number.isFinite(share) || share < 0 || share > 100) return { error: 'Podíl „' + nm + '“ zadejte jako číslo 0 – 100 %.' };
          }
          out.push({ name: nm, share });
        }
        const fixed = out.filter((r) => r.share != null), sum = fixed.reduce((s, r) => s + r.share, 0);
        if (sum > 100.001) return { error: 'Součet podílů je ' + fmtNum(sum) + ' % – nesmí přesáhnout 100 %.' };
        if (out.length > 1 && fixed.length === out.length && Math.abs(sum - 100) > 0.001) {
          return { error: 'Součet podílů je ' + fmtNum(sum) + ' % – musí být 100 % (nebo nechte některý prázdný).' };
        }
        return { value: out.slice(0, f.maxItems) };
      };
      break;
    }
  }
  const row = h('div', { class: 'pf' }, [h('label', { for: id, text: label }), control, err]);
  return {
    el: row, key: f.key,
    setError: (msg) => { err.textContent = msg; row.classList.add('err'); },
    read: () => {
      const r = read();
      err.textContent = r.error || '';
      row.classList.toggle('err', !!r.error);
      return r;
    },
  };
}

function openNodePopup(n) {
  const rows = FIELDS[n.type].map((f) => fieldRow(f, n.params[f.key]));
  const onSave = () => {
    const vals = {};
    let ok = true;
    for (const r of rows) {
      const res = r.read();
      if (res.error) ok = false; else vals[r.key] = res.value;
    }
    // Obecná kapacita 0 je povolená jen se zapnutou kapacitou pro reference.
    for (const r of rows) {
      const f = FIELDS[n.type].find((x) => x.key === r.key);
      if (ok && f.minOff != null && !(vals.refCap && vals.refCap.on) && vals[f.key] < f.minOff) {
        r.setError('Bez kapacity pro reference musí být alespoň ' + f.minOff + '. Hodnotu 0 lze zadat jen se zapnutou „Kapacitou pro reference“.');
        ok = false;
      }
    }
    if (!ok) return false;
    Object.assign(n.params, vals);
    refreshNodeHeader(n);
    drawEdges();
    updateStats();
    return true;
  };
  openPopup('Parametry – ' + TYPES[n.type].label, rows.map((r) => r.el), onSave, n);
}

// Výběr barvy: pastelové vzorky + vlastní barva.
function swatchPicker(initial, onChange) {
  let current = initial;
  const box = h('div', { class: 'swatches' });
  const custom = h('input', { type: 'color', class: 'sw-custom', title: 'Vlastní barva', 'aria-label': 'Vlastní barva' });
  const mark = () => {
    let known = false;
    box.querySelectorAll('.sw').forEach((b) => {
      const on = b.dataset.hex.toLowerCase() === current.toLowerCase();
      b.classList.toggle('on', on);
      if (on) known = true;
    });
    custom.classList.toggle('on', !known);
  };
  for (const p of PASTELS) {
    const b = h('button', { type: 'button', class: 'sw', title: p.name, 'aria-label': p.name, dataset: { hex: p.hex } });
    b.style.background = p.hex;
    b.addEventListener('click', () => { current = p.hex; mark(); onChange(current); });
    box.append(b);
  }
  custom.value = current;
  custom.addEventListener('input', () => { current = custom.value; mark(); onChange(current); });
  box.append(custom);
  mark();
  return box;
}

function openShapePopup(s) {
  let kind = s.kind, color = s.color;
  const seg = h('div', { class: 'seg' });
  for (const k of Object.keys(SHAPE_KINDS)) {
    const K = SHAPE_KINDS[k];
    const b = h('button', { type: 'button', class: 'bg-kind' + (k === kind ? ' on' : ''), title: K.label, 'aria-label': K.label, dataset: { kind: k } },
      [h('span', { class: 'ki', text: K.icon })]);
    b.addEventListener('click', () => {
      kind = k;
      seg.querySelectorAll('.bg-kind').forEach((x) => x.classList.toggle('on', x === b));
    });
    seg.append(b);
  }
  const lbl = h('input', { type: 'text', id: 'pf-shape-label', maxlength: 60, autocomplete: 'off', placeholder: 'např. Hala A' });
  lbl.value = s.label || '';
  const rows = [
    h('div', { class: 'pf' }, [h('div', { class: 'pf-lbl', text: 'Tvar' }), seg]),
    h('div', { class: 'pf' }, [h('div', { class: 'pf-lbl', text: 'Barva' }), swatchPicker(color, (c) => { color = c; })]),
    h('div', { class: 'pf' }, [h('label', { for: 'pf-shape-label', text: 'Popisek (nepovinné)' }), lbl]),
  ];
  openPopup('Pozadí', rows, () => {
    s.kind = kind;
    if (SHAPE_KINDS[kind].lock) s.w = s.h = Math.max(s.w, s.h);
    s.color = isHexColor(color) ? color : PASTELS[0].hex;
    s.label = lbl.value.trim().slice(0, 60);
    layoutShape(s);
    return true;
  }, s);
}

// ── Model: vyčištění, import, export ──
function clearModel() {
  hideTooltip();
  S.nodes.forEach((n) => n.el.remove());
  S.shapes.forEach((s) => s.el.remove());
  S.nodes = []; S.edges = []; S.shapes = [];
  S.nid = 1; S.eid = 1; S.sid = 1;
  S.ui.csrc = null; S.ui.selShape = null;
  clearDots();
  closePopup();
}

function loadModel(m) {
  stopSim();
  clearModel();
  m.shapes.forEach((s) => createShape(s, false));
  m.nodes.forEach((n) => createNode(n.type, n.x, n.y, n.params, n.id, n.active));
  m.edges.forEach((e) => addEdge(e.from, e.to));
  resetAllRt();
  resetDisplay();
  drawEdges();
}

function exportModel() {
  const blob = new Blob([JSON.stringify(serializeModel(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'linka-model-' + new Date().toISOString().slice(0, 10) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importFile(file) {
  if (!file) return;
  if (file.size > LIMITS.fileBytes) { alert('Soubor je příliš velký (max. 5 MB).'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    let m;
    try {
      m = parseModel(JSON.parse(reader.result));
    } catch (err) {
      alert('Model nelze načíst: ' + (err instanceof SyntaxError ? 'soubor není platný JSON.' : err.message));
      return;
    }
    loadModel(m);
    alert('Model načten: ' + m.nodes.length + ' prvků, ' + m.edges.length + ' spojů, ' + m.shapes.length + ' pozadí.'
      + (m.skipped ? '\nPřeskočeno neplatných položek: ' + m.skipped + '.' : ''));
  };
  reader.onerror = () => alert('Soubor se nepodařilo přečíst.');
  reader.readAsText(file);
}

// ── Téma ──
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('simulator-linky.theme', theme); } catch (e) { /* ignore */ }
  $('btnTheme').textContent = theme === 'dark' ? '☀️' : '🌙';
  refreshColors();
  drawGrid();
  drawEdges();
}

// ── Události ──
function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function bindUI() {
  // Ovládání simulace
  $('btnStart').addEventListener('click', startSim);
  $('btnPause').addEventListener('click', pauseSim);
  $('btnStop').addEventListener('click', stopSim);
  $('btnReset').addEventListener('click', resetSim);
  $('btnExport').addEventListener('click', exportModel);
  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
  $('btnTheme').addEventListener('click', () => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  $('btnTheme').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  $('cmb').addEventListener('click', () => setConnectMode(!S.ui.connect));

  // Paleta prvků (drag & drop)
  document.querySelectorAll('#palette .pal-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.dataset.type);   // nutné pro Firefox
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!hasType(type)) return;
    const w = eventWorld(e);
    createNode(type, w.x - 66, w.y - 55);
  });

  // Pozadí: rozbalovací nabídka tvarů + výchozí barva
  const kinds = $('bgKinds');
  for (const k of Object.keys(SHAPE_KINDS)) {
    const K = SHAPE_KINDS[k];
    const b = h('button', { type: 'button', class: 'bg-kind', dataset: { kind: k }, title: K.label + ' – táhni na plátně' },
      [h('span', { class: 'ki', text: K.icon }), K.label]);
    b.addEventListener('click', () => setDrawMode(S.ui.draw === k ? null : k));
    kinds.append(b);
  }
  $('bgSwatches').append(swatchPicker(S.ui.drawColor, (c) => { S.ui.drawColor = c; }));
  $('bgToggle').addEventListener('click', () => {
    const open = $('bgTools').hidden;
    $('bgTools').hidden = !open;
    $('bgToggle').setAttribute('aria-expanded', String(open));
    if (!open) setDrawMode(null);
  });

  // Nápověda – defaultně skrytá
  $('infoToggle').addEventListener('click', () => {
    const open = $('hint').hidden;
    $('hint').hidden = !open;
    $('infoToggle').setAttribute('aria-expanded', String(open));
  });

  // Popup
  $('psave').addEventListener('click', savePopup);
  $('pcancel').addEventListener('click', closePopup);
  $('ov').addEventListener('click', closePopup);

  // Plátno: zoom
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    hideTooltip();
    const r = wrap.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = clamp(S.view.k * (e.deltaY > 0 ? 0.9 : 1.1), 0.2, 3);
    S.view.x = mx - (mx - S.view.x) * (k / S.view.k);
    S.view.y = my - (my - S.view.y) * (k / S.view.k);
    S.view.k = k;
    applyTransform();
  }, { passive: false });

  // Plátno: posun / kreslení pozadí / výběr pozadí
  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (S.ui.draw) {
      const w = eventWorld(e);
      const prev = h('div', { class: 'shape preview' });
      prev.style.setProperty('--shape-color', S.ui.drawColor);
      prev.classList.toggle('round', SHAPE_KINDS[S.ui.draw].round);
      bgl.append(prev);
      S.ui.drag = { kind: 'draw', x0: w.x, y0: w.y, el: prev, rect: null };
      e.preventDefault();
      return;
    }
    if (e.target.closest('.node, .edel')) return;
    const shapeEl = e.target.closest('.shape');
    S.ui.drag = {
      kind: 'pan', sx: e.clientX, sy: e.clientY, px: S.view.x, py: S.view.y, moved: false,
      shape: shapeEl ? shapeById(Number(shapeEl.dataset.id)) : null,
    };
    wrap.classList.add('panning');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    S.ui.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    const d = S.ui.drag;
    if (!d) { if (S.ui.csrc) drawEdges(); return; }
    const w = eventWorld(e);
    switch (d.kind) {
      case 'pan': {
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        S.view.x = d.px + dx; S.view.y = d.py + dy;
        applyTransform();
        break;
      }
      case 'node':
        d.n.x = w.x - d.ox; d.n.y = w.y - d.oy;
        placeNode(d.n);
        drawEdges();
        break;
      case 'shape':
        d.s.x = w.x - d.ox; d.s.y = w.y - d.oy;
        layoutShape(d.s);
        break;
      case 'resize': {
        let nw = Math.max(10, w.x - d.s.x), nh = Math.max(10, w.y - d.s.y);
        if (SHAPE_KINDS[d.s.kind].lock) nw = nh = Math.max(nw, nh);
        d.s.w = nw; d.s.h = nh;
        layoutShape(d.s);
        break;
      }
      case 'draw': {
        const rc = dragRect(S.ui.draw, d.x0, d.y0, w.x, w.y);
        d.rect = rc;
        Object.assign(d.el.style, { left: rc.x + 'px', top: rc.y + 'px', width: rc.w + 'px', height: rc.h + 'px' });
        break;
      }
    }
  });

  window.addEventListener('mouseup', () => {
    const d = S.ui.drag;
    if (!d) return;
    S.ui.drag = null;
    wrap.classList.remove('panning');
    if (d.kind === 'pan' && !d.moved) selectShape(d.shape);    // klik: vybere tvar / zruší výběr
    if (d.kind === 'draw') {
      d.el.remove();
      if (d.rect && d.rect.w >= 8 && d.rect.h >= 8) {
        createShape({ kind: S.ui.draw, x: d.rect.x, y: d.rect.y, w: d.rect.w, h: d.rect.h, color: S.ui.drawColor }, true);
      }
      setDrawMode(null);
    }
  });

  // Klávesnice
  document.addEventListener('keydown', (e) => {
    if (!$('pop').hidden) {
      if (e.key === 'Escape') closePopup();
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); savePopup(); }
      return;
    }
    if (isTyping(e.target)) return;
    if (e.key === 'Escape') {
      setDrawMode(null);
      cancelLink();
      selectShape(null);
      drawEdges();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.ui.selShape) {
      e.preventDefault();
      deleteShape(S.ui.selShape);
    }
  });

  new ResizeObserver(resizeCanvases).observe(wrap);
}
