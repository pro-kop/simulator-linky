'use strict';
// Ukázková linka načtená při startu (stejná jako v původní verzi).

function loadDemo() {
  const mk = (type, x, y, ov) => createNode(type, x, y, Object.assign(defaultParams(type), ov));
  const BM = { shiftH: 12, shiftsWeek: 10, oee: 85, kapRelevant: false, kusovnik: 1 };
  const BS = { takt: 45, nasob: 6 }, BA = { takt: 22.5, nasob: 3 }, BK = { takt: 45, nasob: 3 };
  const M = (x, y, o) => mk('machine', x, y, Object.assign({}, BM, o));
  const K = (x, y, o) => mk('kompletace', x, y, Object.assign({}, BM, BK, o));

  const s1 = M(40, 110, Object.assign({}, BS, { name: 'Stroj 1' }));
  const s1a = M(200, 20, Object.assign({}, BA, { name: 'Stroj 1a' }));
  const s1b = M(200, 200, Object.assign({}, BA, { name: 'Stroj 1b' }));
  const s2 = M(40, 430, Object.assign({}, BS, { name: 'Stroj 2' }));
  const s2a = M(200, 340, Object.assign({}, BA, { name: 'Stroj 2a' }));
  const s2b = M(200, 520, Object.assign({}, BA, { name: 'Stroj 2b' }));
  const s3 = M(40, 750, Object.assign({}, BS, { name: 'Stroj 3' }));
  const s3a = M(200, 660, Object.assign({}, BA, { name: 'Stroj 3a' }));
  const s3b = M(200, 840, Object.assign({}, BA, { name: 'Stroj 3b' }));
  const s4 = M(40, 1070, Object.assign({}, BS, { name: 'Stroj 4' }));
  const s4a = M(200, 980, Object.assign({}, BA, { name: 'Stroj 4a' }));
  const s4b = M(200, 1160, Object.assign({}, BA, { name: 'Stroj 4b' }));
  const k1 = K(380, 180, { name: 'Kompletace 1', kusovnik: 2, kapRelevant: true });
  const k2 = K(380, 360, { name: 'Kompletace 2', kusovnik: 2, kapRelevant: true });
  const k4 = K(380, 820, { name: 'Kompletace 4', kusovnik: 2, kapRelevant: true });
  const k5 = K(380, 1000, { name: 'Kompletace 5', kusovnik: 2, kapRelevant: true });
  const o1 = mk('packing', 555, 180, { name: 'Obal 1' });
  const o2 = mk('packing', 555, 360, { name: 'Obal 2' });
  const o3 = mk('packing', 555, 820, { name: 'Obal 3' });
  const o4 = mk('packing', 555, 1000, { name: 'Obal 4' });
  const t1 = mk('tempering', 730, 580, { name: 'Temperace 1', hoursMin: 6, maxObals: 20 });
  const t2 = mk('tempering', 900, 580, { name: 'Temperace 2', hoursMin: 1, maxObals: 10 });
  const k3 = K(1070, 580, { name: 'Kompletace 3', kusovnik: 1 });

  [[s1, s1a], [s1, s1b], [s2, s2a], [s2, s2b], [s3, s3a], [s3, s3b], [s4, s4a], [s4, s4b],
   [s1a, k1], [s2a, k1], [s1b, k2], [s2b, k2], [s3a, k4], [s4a, k4], [s3b, k5], [s4b, k5],
   [k1, o1], [k2, o2], [k4, o3], [k5, o4], [o1, t1], [o2, t1], [o3, t1], [o4, t1], [t1, t2], [t2, k3],
  ].forEach(([a, b]) => addEdge(a.id, b.id));
  drawEdges();
}
