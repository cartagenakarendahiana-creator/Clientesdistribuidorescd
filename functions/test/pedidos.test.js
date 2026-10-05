const test = require('node:test');
const assert = require('node:assert');
const { atender, claveValida, ErrorApi } = require('../pedidos');

const catalogo = {
  distribuidores: [{ id: 'Imperio', nombre: 'Imperio', fecha: '2026-07-04' }, { id: 'Viejo', nombre: 'Viejo', fecha: null }, { id: 'Casa S.A', nombre: 'Casa S.A', fecha: '2026-06-01' }],
  productos: [
    { categoria: 'SÁBANAS', producto: 'Juego Silver', medida: '1x190', precio: 26000, pedidos: { Imperio: 10, Viejo: 3 } },
    { categoria: 'TOALLAS', producto: 'Toalla', medida: '70x140', precio: 15000, pedidos: { Imperio: 4, 'Casa S.A': 2 } },
  ],
};

// Base de datos falsa con ref/once/update/transaction como firebase-admin.
function dbFalsa(inicial) {
  const datos = structuredClone(inicial);
  const partes = (r) => r.split('/').filter(Boolean);
  const leer = (r) => partes(r).reduce((o, k) => (o ? o[k] : undefined), datos) ?? null;
  const escribir = (r, v) => {
    const ps = partes(r); let o = datos;
    for (const p of ps.slice(0, -1)) o = o[p] ||= {};
    if (v === null) delete o[ps.at(-1)]; else o[ps.at(-1)] = v;
  };
  const ref = (r = '') => ({
    once: async () => ({ val: () => structuredClone(leer(r)) }),
    update: async (c) => { for (const [k, v] of Object.entries(c)) escribir(r + '/' + k, structuredClone(v)); },
    transaction: async (fn) => { escribir(r, fn(structuredClone(leer(r)))); },
  });
  return { datos, ref };
}

function base() {
  return dbFalsa({
    casaDoradaDatos: {
      productOverrides: { 1: { precio: 16000 } },
      customProducts: [{ categoria: 'COBIJAS', producto: 'Cobija', medida: 'doble', precio: 50000 }],
      nuevosDistribuidores: [{ id: 'nuevo-1', nombre: 'Almacén Éxito.', fecha: '2026-09-30', vendedor: 'Ana' }],
      extras: [{ distId: 'nuevo-1', productoIdx: 2, cantidad: 2, precio: 48000, uid: 'u1' }, { distId: 'Imperio', productoIdx: 2, cantidad: 1, uid: 'u2' }],
      catalogOverrides: { Imperio: { 'cat-0': { cantidad: 12 }, 'cat-1': { eliminado: true } } },
      entregas: { Imperio: { 'cat-0': 12, 'extra-u2': 1 }, 'nuevo-1': { 'extra-u1': 1 }, 'Casa S%2EA': { 'cat-1': 2 } },
      distribuidoresEliminados: ['Viejo'],
      clientesInfo: { almacenexitosa: { nit: '900', telefono: '300', ciudad: 'Medellín', direccion: 'Cra 1' } },
      distNameOverrides: { 'nuevo-1': 'Almacén Éxito S.A' },
      distUrgenteOverrides: { 'nuevo-1': true },
      distribuidoresRegistry: ['Almacén Éxito S.A'],
      vendedoresRegistry: ['Ana'],
    },
  });
}
const llamar = (db, metodo, ruta, { query = {}, body } = {}) => atender({ db, catalogo, metodo, ruta, query, body });

test('lista productos con precios editados y productos nuevos', async () => {
  const r = await llamar(base(), 'GET', '/productos');
  assert.deepEqual(r.json.productos.map((p) => `${p.id}:${p.producto}:${p.precio}`), ['0:Juego Silver:26000', '1:Toalla:16000', '2:Cobija:50000']);
});

test('arma los pedidos como la app: ediciones, líneas borradas, extras, entregas y eliminados', async () => {
  const { json } = await llamar(base(), 'GET', '/pedidos');
  assert.deepEqual(json.pedidos.map((p) => p.id), ['Imperio', 'Casa S.A', 'nuevo-1'], 'el pedido eliminado no sale');
  // La app guarda "Casa S.A" como clave "Casa S%2EA" (encodeFirebaseKey): sus entregas se leen igual.
  assert.equal(json.pedidos[1].estado, 'entregado');
  const imp = json.pedidos[0];
  assert.deepEqual(imp.lineas.map((l) => `${l.linea}:${l.cantidad}x${l.precio}:${l.entregado}`), ['cat-0:12x26000:12', 'extra-u2:1x50000:1']);
  assert.equal(imp.estado, 'entregado');
  assert.deepEqual(imp.totales, { unidades: 13, entregadas: 13, pendientes: 0, valor: 362000, valorPendiente: 0 });
  const nuevo = json.pedidos[2];
  assert.equal(nuevo.cliente, 'Almacén Éxito S.A');
  assert.equal(nuevo.urgente, true);
  assert.equal(nuevo.nit, '900');
  assert.equal(nuevo.estado, 'pendiente');
  assert.deepEqual(nuevo.totales, { unidades: 2, entregadas: 1, pendientes: 1, valor: 96000, valorPendiente: 48000 });
});

test('filtros por estado, cliente y fechas; y consulta de un pedido', async () => {
  const db = base();
  assert.deepEqual((await llamar(db, 'GET', '/pedidos', { query: { estado: 'pendiente' } })).json.pedidos.map((p) => p.id), ['nuevo-1']);
  assert.deepEqual((await llamar(db, 'GET', '/pedidos', { query: { cliente: 'almacen exito' } })).json.pedidos.map((p) => p.id), ['nuevo-1']);
  assert.deepEqual((await llamar(db, 'GET', '/pedidos', { query: { desde: '2026-08-01', hasta: '2026-12-31' } })).json.pedidos.map((p) => p.id), ['nuevo-1']);
  assert.deepEqual((await llamar(db, 'GET', '/pedidos/Casa%20S.A')).json.pedido.totales.valor, 30000, 'línea original: precio del catálogo, como en la app');
  assert.equal((await llamar(db, 'GET', '/pedidos/Imperio')).json.pedido.cliente, 'Imperio');
  await assert.rejects(llamar(db, 'GET', '/pedidos/nada'), (e) => e instanceof ErrorApi && e.status === 404);
  await assert.rejects(llamar(db, 'GET', '/pedidos', { query: { desde: '30/09/2026' } }), (e) => e.status === 400);
});

test('crea un pedido como "+ Nuevo pedido": cliente existente, precio de lista y referencia sin duplicar', async () => {
  const db = base();
  const body = {
    cliente: 'ALMACEN EXITO S.A', vendedor: 'Pedro', fecha: '2026-10-05', urgente: true, observaciones: 'Entregar el viernes',
    referenciaExterna: 'OTRA-APP-77', telefono: '311',
    lineas: [{ productoId: 0, cantidad: 5 }, { productoId: 1, cantidad: 2, precio: 15500 }],
  };
  const r = await llamar(db, 'POST', '/pedidos', { body });
  assert.equal(r.status, 201);
  const p = r.json.pedido;
  assert.equal(p.cliente, 'Almacén Éxito S.A', 'usa el nombre del cliente que ya existe');
  assert.equal(p.vendedor, 'Pedro');
  assert.equal(p.urgente, true);
  assert.equal(p.observaciones[0].texto, 'Entregar el viernes');
  assert.deepEqual(p.lineas.map((l) => `${l.productoId}:${l.cantidad}x${l.precio}`), ['0:5x26000', '1:2x15500']);
  assert.equal(p.estado, 'pendiente');
  const d = db.datos.casaDoradaDatos;
  assert.equal(d.extras.length, 4, 'las líneas se agregan al final sin tocar las demás');
  assert.ok(d.extras.slice(2).every((x) => x.distId === p.id && x.uid));
  assert.deepEqual(d.clientesInfo.almacenexitosa, { nit: '900', telefono: '311', direccion: 'Cra 1', ciudad: 'Medellín' }, 'conserva lo que no se mandó');
  assert.deepEqual(d.distribuidoresRegistry, ['Almacén Éxito S.A'], 'no crea el cliente otra vez');
  assert.deepEqual(d.vendedoresRegistry, ['Ana', 'Pedro']);

  const otra = await llamar(db, 'POST', '/pedidos', { body });
  assert.equal(otra.status, 200);
  assert.equal(otra.json.creado, false);
  assert.equal(otra.json.pedido.id, p.id);
  assert.equal(d.nuevosDistribuidores.length, 2, 'el reintento no duplica el pedido');
});

test('cliente nuevo queda registrado; datos inválidos se rechazan sin guardar nada', async () => {
  const db = base();
  await llamar(db, 'POST', '/pedidos', { body: { cliente: 'Tienda Nueva', lineas: [{ productoId: 2, cantidad: 1 }] } });
  assert.deepEqual(db.datos.casaDoradaDatos.distribuidoresRegistry, ['Almacén Éxito S.A', 'Tienda Nueva']);
  const antes = JSON.stringify(db.datos);
  for (const body of [
    {}, { cliente: 'X' }, { cliente: 'X', lineas: [] },
    { cliente: 'X', lineas: [{ productoId: 99, cantidad: 1 }] },
    { cliente: 'X', lineas: [{ productoId: 0, cantidad: 0 }] },
    { cliente: 'X', lineas: [{ productoId: 0, cantidad: 1, precio: -5 }] },
    { cliente: 'X', fecha: '05-10-2026', lineas: [{ productoId: 0, cantidad: 1 }] },
  ]) {
    await assert.rejects(llamar(db, 'POST', '/pedidos', { body }), (e) => e.status === 400, JSON.stringify(body));
  }
  assert.equal(JSON.stringify(db.datos), antes);
  await assert.rejects(llamar(db, 'DELETE', '/pedidos/Imperio'), (e) => e.status === 404);
});

test('la clave se compara contra su SHA-256', () => {
  const hash = require('crypto').createHash('sha256').update('clave-larga-de-prueba').digest('hex');
  assert.equal(claveValida('clave-larga-de-prueba', hash), true);
  assert.equal(claveValida('otra', hash), false);
  assert.equal(claveValida('', hash), false);
  assert.equal(claveValida('clave-larga-de-prueba', ''), false);
});
