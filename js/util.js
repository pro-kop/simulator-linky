'use strict';
// Obecné pomocné funkce – bez závislosti na stavu aplikace.

const $ = (id) => document.getElementById(id);

// Bezpečné vytváření DOM: texty jdou vždy přes textContent / text nody, nikdy přes innerHTML.
function h(tag, props, children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  if (children != null) {
    for (const c of [].concat(children)) if (c != null && c !== false) el.append(c);
  }
  return el;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mod = (a, n) => ((a % n) + n) % n;
const isHexColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fmt(n) { return Math.round(n).toLocaleString('cs-CZ'); }
function fmtNum(n) { return n.toLocaleString('cs-CZ', { maximumFractionDigits: 2 }); }
function fmtT(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
function fmtD(s) {
  if (s <= 0) return '0 min';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + ' min';
}

// Rotace pole – rovnoměrné (round-robin) rozdělování mezi navazující prvky.
function rotated(arr, start) {
  if (arr.length < 2) return arr;
  const s = start % arr.length;
  return arr.slice(s).concat(arr.slice(0, s));
}
