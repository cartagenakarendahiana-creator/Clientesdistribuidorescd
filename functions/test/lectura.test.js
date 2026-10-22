const test = require('node:test');
const assert = require('node:assert');
const { atender } = require('../pedidos');

const catalogo = { distribuidores: [{ id: 'Imperio', nombre: 'Imperio', fecha: '2026-07-04' }], productos: [{ categoria: 'SÁBANAS', producto: 'Juego Silver', medida: '1x190', precio: 26000, pedidos: { Imperio: 10 } }] };

function dbFalsa(inicial) {
  const datos = structuredClone(inicial);
  const leer = (r) => r.split('/').filter(Boolean).reduce((o, k) => (o ? o[k] : undefined), datos) ?? null;
  const ref = (r) => {
    const q = { desde: null, hasta: null };
    const api = {
      once: async () => ({ val: () => {
        let v = structuredClone(leer(r));
        if (v && (q.desde || q.hasta)) v = Object.fromEntries(Object.entries(v).filter(([k]) => (!q.desde || k >= q.desde) && (!q.hasta || k <= q.hasta)));
        return v;
      } }),
      orderByKey: () => api, startAt: (x) => { q.desde = x; return api; }, endAt: (x) => { q.hasta = x; return api; },
    };
    return api;
  };
  return { datos, ref };
}
const base = () => dbFalsa({
  casaDoradaDatos: {
    auth: { usuario: 'admin', hash: 'secreto' },
    despachos: [{ id: 'd1', fecha: '2026-09-19', cliente: 'Imperio', cajas: 2, yutes: 1, bultos: '', guiaFoto: 'fb' }, { id: 'd2', fecha: '2026-10-02', cliente: 'Otro', cajas: 1 }],
    facturas: [{ id: 'f1', fecha: '2026-09-23', cliente: 'Imperio', total: 100 }],
    plantaProduccionDiaria: [{ id: 'p1', fecha: '2026-09-24', etapa: 'Ultrasonido', producto: 'Acolchado', cantidad: 1500 }, { id: 'p2', fecha: '2026-09-25', etapa: 'Taller', producto: 'Sábana', cantidad: 10 }],
    plantaServiciosMaquila: [{ etapa: 'Taller', servicio: 'Sábana', precio: 900 }],
    insumosCostos: [{ insumo: 'Guata', proveedor: 'Indurtex', costo: 2700, fecha: '2026-10-13' }],
    plantaGastosAdicionales: [{ concepto: 'Mecánico', fecha: '2026-09-25', valor: 200000 }],
    plantaCostosFijos: [{ concepto: 'Arriendo', valorMensual: 4500000 }],
    vendedoresRegistry: ['Ana'],
    distribuidoresRegistry: ['Imperio', 'Cliente Sin Pedido'],
    clientesInfo: { imperio: { nit: '900', ciudad: 'Montería' } },
    distTipo: { Imperio: 'distribuidor' },
    entregas: { Imperio: { 'cat-0': 4 } },
  },
  siigo: {
    estado: { ultima: '2026-10-22' },
    catalogos: { clientes: { 900: { nit: '900', nombre: 'Imperio' } }, productos: { A1: { codigo: 'A1' } } },
    resumenDiario: { '2026-09-30': { total: 1 }, '2026-10-01': { total: 2 }, '2026-10-05': { total: 3 } },
    facturasDia: { '2026-10-01': { x: { numero: 'FV-1' } }, '2026-11-01': { y: { numero: 'FV-2' } } },
  },
  crm: { contactos: [{ nombre: 'Lina' }], equipo: [{ nombre: 'Sara' }] },
});
const get = (db, ruta, query = {}) => atender({ db, catalogo, metodo: 'GET', ruta, query });

test('lee despachos, facturas, producción, gastos, insumos y demás con filtros', async () => {
  const db = base();
  const d = (await get(db, '/despachos', { desde: '2026-09-01', hasta: '2026-09-30' })).json;
  assert.equal(d.total, 1);
  assert.equal(d.despachos[0].tieneFotoGuia, true);
  assert.equal(d.despachos[0].guiaFoto, undefined, 'la foto no sale');
  assert.equal((await get(db, '/despachos', { cliente: 'otro' })).json.total, 1);
  assert.equal((await get(db, '/facturas')).json.facturas[0].total, 100);
  assert.deepEqual((await get(db, '/produccion', { etapa: 'taller' })).json.produccion.map((x) => x.id), ['p2']);
  assert.equal((await get(db, '/gastos', { desde: '2026-09-01' })).json.total, 1);
  assert.equal((await get(db, '/costos-fijos')).json.costosFijos[0].valorMensual, 4500000);
  assert.equal((await get(db, '/precios-servicio', { etapa: 'Taller' })).json.total, 1);
  assert.equal((await get(db, '/insumos')).json.insumos[0].proveedor, 'Indurtex');
  assert.deepEqual((await get(db, '/vendedores')).json.vendedores, ['Ana']);
  await assert.rejects(get(db, '/despachos', { desde: '19-09-2026' }), (e) => e.status === 400);
});

test('clientes con datos de contacto y resumen de pedidos', async () => {
  const { clientes } = (await get(base(), '/clientes')).json;
  const imp = clientes.find((c) => c.cliente === 'Imperio');
  assert.deepEqual([imp.pedidos, imp.pendientes, imp.valorPendiente, imp.nit, imp.ciudad, imp.tipos.join()], [1, 6, 156000, '900', 'Montería', 'distribuidor']);
  assert.ok(clientes.some((c) => c.cliente === 'Cliente Sin Pedido' && c.pedidos === 0));
});

test('datos crudos por sección, sin la parte privada', async () => {
  const db = base();
  const { secciones } = (await get(db, '/datos')).json;
  assert.ok(secciones.includes('despachos') && !secciones.includes('auth'));
  assert.equal((await get(db, '/datos/insumosCostos')).json.datos.length, 1);
  await assert.rejects(get(db, '/datos/auth'), (e) => e.status === 404);
  await assert.rejects(get(db, '/datos/noExiste'), (e) => e.status === 404);
  const s = (await get(db, '/secciones')).json;
  assert.equal(s.datos.despachos, 2);
  assert.equal(s.datos.auth, undefined);
});

test('Siigo y CRM', async () => {
  const db = base();
  assert.equal((await get(db, '/siigo/estado')).json.estado.ultima, '2026-10-22');
  assert.equal((await get(db, '/siigo/clientes')).json.total, 1);
  assert.deepEqual(Object.keys((await get(db, '/siigo/ventas', { desde: '2026-10-01', hasta: '2026-10-31' })).json.dias), ['2026-10-01', '2026-10-05']);
  assert.deepEqual((await get(db, '/siigo/facturas', { desde: '2026-10-01', hasta: '2026-10-31' })).json.facturas.map((f) => f.numero), ['FV-1']);
  await assert.rejects(get(db, '/siigo/facturas', { desde: '2026-01-01', hasta: '2026-12-31' }), (e) => e.status === 400, 'máximo 62 días');
  await assert.rejects(get(db, '/siigo/ventas'), (e) => e.status === 400, 'pide el rango');
  const crm = (await get(db, '/crm')).json;
  assert.deepEqual([crm.contactos.length, crm.equipo.length], [1, 1]);
  await assert.rejects(get(db, '/no-existe'), (e) => e.status === 404);
});
