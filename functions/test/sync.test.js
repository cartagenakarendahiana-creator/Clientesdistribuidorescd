const test = require('node:test');
const assert = require('node:assert');
const { SiigoClient } = require('../siigo');
const { sincronizar, normalizarFactura, construirResumen, hoyColombia } = require('../sync');

// Base de datos falsa con la misma forma que firebase-admin (ref/once/update).
function dbFalsa() {
  const datos = {};
  const ref = (ruta = '') => ({
    once: async () => ({ val: () => ruta.split('/').filter(Boolean).reduce((o, k) => (o ? o[k] : undefined), datos) ?? null }),
    update: async (cambios) => {
      for (const [k, v] of Object.entries(cambios)) {
        const partes = [...ruta.split('/'), ...k.split('/')].filter(Boolean);
        let o = datos;
        for (const p of partes.slice(0, -1)) o = o[p] ||= {};
        o[partes.at(-1)] = v;
      }
    },
  });
  return { datos, ref };
}

// Siigo falso: responde según la ruta pedida y registra las llamadas.
function fetchFalso(rutas) {
  const llamadas = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    llamadas.push({ ruta: u.pathname, params: Object.fromEntries(u.searchParams), headers: opts.headers });
    const r = rutas[u.pathname];
    const body = typeof r === 'function' ? r(u.searchParams, llamadas) : r;
    if (body && body.__status) return { ok: false, status: body.__status, text: async () => 'error' };
    return { ok: true, status: 200, json: async () => body };
  };
  fn.llamadas = llamadas;
  return fn;
}

const factura = (id, fecha, cc, total, items, extra = {}) => ({
  id, name: `FV-1-${id}`, date: fecha, customer: { identification: '901759512' },
  cost_center: cc, seller: 7, total, balance: 0, items, ...extra,
});

test('normalizarFactura toma cantidades, valores y cliente', () => {
  const f = normalizarFactura(factura('a', '2026-09-01', 12, 119000, [
    { code: 'EDR-1', description: 'Edredón', quantity: 2, price: 50000, total: 119000 },
  ]));
  assert.equal(f.numero, 'FV-1-a');
  assert.equal(f.clienteNit, '901759512');
  assert.equal(f.items[0].cantidad, 2);
  assert.equal(f.items[0].valor, 119000);
  assert.equal(f.anulada, false);
});

test('construirResumen separa por centro de costo, suma global e ignora anuladas', () => {
  const fs = [
    factura('a', '2026-09-01', 12, 100, [{ code: 'P.1', quantity: 2, price: 50, total: 100 }]),
    factura('b', '2026-09-01', 13, 50, [{ code: 'P.1', quantity: 1, price: 50, total: 50 }]),
    factura('c', '2026-09-01', 12, 999, [{ code: 'X', quantity: 9, price: 111 }], { annulled: true }),
    factura('d', '2026-09-02', null, 30, [{ code: 'Y', quantity: 3, price: 10 }]),
  ].map(normalizarFactura);
  const r = construirResumen(fs, ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(r['2026-09-01'].global.ventas, 150);
  assert.equal(r['2026-09-01'].global.unidades, 3);
  assert.equal(r['2026-09-01'].cc_12.ventas, 100);
  assert.equal(r['2026-09-01'].cc_13.facturas, 1);
  assert.equal(r['2026-09-01'].global.productos.P_1.cantidad, 3); // clave sin punto
  assert.equal(r['2026-09-02'].sin_centro.unidades, 3);
  assert.equal(r['2026-09-02'].sin_centro.productos.Y.valor, 30);
  assert.equal(r['2026-09-03'].global.ventas, 0); // día sin ventas queda en cero
});

test('sincronizar pagina facturas, envía Partner-Id y guarda bajo siigo/', async () => {
  const pagina1 = Array.from({ length: 100 }, (_, i) => factura(`p1-${i}`, '2026-09-01', 12, 10, [{ code: 'A', quantity: 1, price: 10 }]));
  const pagina2 = [factura('p2-0', '2026-09-02', 13, 20, [{ code: 'B', quantity: 2, price: 10 }])];
  const fetchImpl = fetchFalso({
    '/auth': { access_token: 'tok', expires_in: 86400 },
    '/v1/cost-centers': [{ id: 12, code: '1', name: 'Corte', active: true }, { id: 13, code: '2', name: 'Confortadora' }],
    '/v1/users': { pagination: { total_results: 1 }, results: [{ id: 7, first_name: 'Ana', last_name: 'Ruiz' }] },
    '/v1/customers': { pagination: { total_results: 1 }, results: [{ identification: '901759512', name: ['Grupo The Arrow'] }] },
    '/v1/products': { pagination: { total_results: 1 }, results: [{ code: 'A', name: 'Almohada' }] },
    '/v1/invoices': (q) => ({ pagination: { total_results: 101 }, results: q.get('page') === '1' ? pagina1 : pagina2 }),
  });
  const client = new SiigoClient({ username: 'u', accessKey: 'k', partnerId: 'CasaDorada', fetchImpl });
  const db = dbFalsa();
  db.datos.casaDoradaDatos = { intacto: true };

  const res = await sincronizar({ client, db, desde: '2026-09-01', hasta: '2026-09-02', log: () => {} });

  assert.equal(res.facturas, 101);
  const inv = fetchImpl.llamadas.filter((l) => l.ruta === '/v1/invoices');
  assert.deepEqual(inv.map((l) => l.params.page), ['1', '2']);
  assert.equal(inv[0].params.date_start, '2026-09-01');
  assert.ok(fetchImpl.llamadas.every((l) => l.headers['Partner-Id'] === 'CasaDorada'));
  assert.equal(fetchImpl.llamadas.filter((l) => l.ruta === '/auth').length, 1); // token reutilizado

  const s = db.datos.siigo;
  assert.equal(Object.keys(s.facturas).length, 101);
  assert.equal(s.resumenDiario['2026-09-01'].cc_12.ventas, 1000);
  assert.equal(s.resumenDiario['2026-09-02'].cc_13.unidades, 2);
  assert.equal(s.catalogos.centrosCosto.cc_12.nombre, 'Corte');
  assert.equal(s.catalogos.vendedores['7'].nombre, 'Ana Ruiz');
  assert.equal(s.catalogos.clientes['901759512'].nombre, 'Grupo The Arrow');
  assert.equal(s.estado.catalogosHasta.length, 10);
  assert.deepEqual(db.datos.casaDoradaDatos, { intacto: true }); // no toca los datos de la app

  // Segunda corrida: clientes y productos se piden solo desde la última sincronización.
  await sincronizar({ client, db, desde: '2026-09-02', hasta: '2026-09-02', log: () => {} });
  const cust = fetchImpl.llamadas.filter((l) => l.ruta === '/v1/customers');
  assert.equal(cust.at(-1).params.updated_start, s.estado.catalogosHasta);
});

test('reintenta ante 429 y renueva el token ante 401', async () => {
  let n = 0;
  const fetchImpl = fetchFalso({
    '/auth': { access_token: 'tok', expires_in: 86400 },
    '/v1/cost-centers': () => (++n === 1 ? { __status: 401 } : n === 2 ? { __status: 429 } : [{ id: 1 }]),
  });
  const client = new SiigoClient({ username: 'u', accessKey: 'k', partnerId: 'p', fetchImpl });
  const orig = global.setTimeout;
  global.setTimeout = (fn) => orig(fn, 0); // sin esperas reales en la prueba
  try {
    assert.deepEqual(await client.centrosDeCosto(), [{ id: 1 }]);
  } finally {
    global.setTimeout = orig;
  }
  assert.equal(fetchImpl.llamadas.filter((l) => l.ruta === '/auth').length, 2);
});

test('registra el error en siigo/estado si Siigo falla', async () => {
  const fetchImpl = fetchFalso({ '/auth': { __status: 403 } });
  const client = new SiigoClient({ username: 'u', accessKey: 'k', partnerId: 'p', fetchImpl });
  const db = dbFalsa();
  await assert.rejects(sincronizar({ client, db, desde: '2026-09-01', hasta: '2026-09-01', log: () => {} }));
  assert.match(db.datos.siigo.estado.ultimoError.mensaje, /HTTP 403/);
});

test('hoyColombia usa UTC-5', () => {
  assert.equal(hoyColombia(new Date('2026-09-28T03:00:00Z')), '2026-09-27');
  assert.equal(hoyColombia(new Date('2026-09-28T06:00:00Z')), '2026-09-28');
});
