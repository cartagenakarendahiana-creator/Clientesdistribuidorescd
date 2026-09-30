const test = require('node:test');
const assert = require('node:assert');
const { facturarDespacho, construirFactura, itemsPendientes, verificarClave, limpiarNit, ErrorUsuario } = require('../facturar');

// Base de datos falsa con ref/once/set/update/transaction.
function dbFalsa(inicial = {}) {
  const datos = structuredClone(inicial);
  const leer = (ruta) => ruta.split('/').filter(Boolean).reduce((o, k) => (o ? o[k] : undefined), datos);
  const escribir = (partes, v) => {
    let o = datos;
    for (const p of partes.slice(0, -1)) o = o[p] ||= {};
    if (v === null) delete o[partes.at(-1)];
    else o[partes.at(-1)] = v;
  };
  const ref = (ruta = '') => ({
    once: async () => ({ val: () => structuredClone(leer(ruta) ?? null) }),
    set: async (v) => escribir(ruta.split('/').filter(Boolean), v),
    update: async (cambios) => {
      for (const [k, v] of Object.entries(cambios)) escribir([...ruta.split('/'), ...k.split('/')].filter(Boolean), v);
    },
    transaction: async (fn) => {
      const nuevo = fn(structuredClone(leer(ruta) ?? null));
      if (nuevo === undefined) return { committed: false };
      escribir(ruta.split('/').filter(Boolean), nuevo);
      return { committed: true };
    },
  });
  return { datos, ref };
}

const CONFIG = { documentoId: 11, vendedorId: 22, formaPagoId: 33, impuestoId: 44, ivaPct: 19, preciosIncluyenIva: true, diasCredito: 30 };

function datosBase() {
  return {
    casaDoradaDatos: {
      siigoFacturaConfig: CONFIG,
      siigoProductoMap: { 'Sabana doble · 140x190 cm': 'SAB-140', 'Cobija Ovejera · 190x215 cm': 'COB-1' },
      entregasLog: {
        'Imperio': [
          { id: 'e1', fecha: '2026-09-30', producto: 'Sabana doble', medida: '140x190 cm', delta: 10, precio: 30000 },
          { id: 'e2', fecha: '2026-09-30', producto: 'Sabana doble', medida: '140x190 cm', delta: -2, precio: 30000 },
          { id: 'e3', fecha: '2026-09-30', producto: 'Cobija Ovejera', medida: '190x215 cm', delta: 3, precio: 59500 },
          { id: 'e4', fecha: '2026-09-29', producto: 'Cobija Ovejera', medida: '190x215 cm', delta: 5, precio: 59500 },
        ],
      },
    },
  };
}

function clienteFalso(respuesta = { id: 'abc', name: 'FV-1-120', total: 416500 }) {
  const creadas = [];
  return {
    creadas,
    crearFactura: async (f) => {
      creadas.push(f);
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    },
  };
}

test('limpiarNit quita el dígito de verificación y los puntos', () => {
  assert.strictEqual(limpiarNit('900.123.456-7'), '900123456');
  assert.strictEqual(limpiarNit('71234567'), '71234567');
});

test('itemsPendientes suma por producto, resta correcciones y omite otras fechas y lo ya facturado', () => {
  const { items, ids } = itemsPendientes(datosBase().casaDoradaDatos.entregasLog.Imperio, '2026-09-30', { e3: true });
  assert.deepStrictEqual(ids, ['e1', 'e2']);
  assert.deepStrictEqual(items.map((i) => [i.clave, i.cantidad]), [['Sabana doble · 140x190 cm', 8]]);
});

test('construirFactura quita el IVA incluido y el pago cuadra con el total', () => {
  const { factura, total } = construirFactura({
    config: CONFIG, nit: '900.123.456-7', fechaFactura: '2026-09-30', fechaDespacho: '2026-09-30', cliente: 'Imperio',
    items: [{ clave: 'Sabana doble · 140x190 cm', cantidad: 8, precio: 30000 }],
    codigos: { 'sabana doble · 140x190 cm': 'SAB-140' },
  });
  assert.strictEqual(factura.customer.identification, '900123456');
  assert.strictEqual(factura.items[0].code, 'SAB-140');
  assert.ok(Math.abs(factura.items[0].price - 30000 / 1.19) < 1e-4);
  assert.deepStrictEqual(factura.items[0].taxes, [{ id: 44 }]);
  assert.ok(Math.abs(total - 240000) < 0.05);
  assert.strictEqual(factura.payments[0].value, total);
  assert.strictEqual(factura.payments[0].due_date, '2026-10-30');
  assert.deepStrictEqual(factura.stamp, { send: false }); // no se envía a la DIAN salvo que se configure
});

test('construirFactura avisa si falta configuración, NIT o código de Siigo', () => {
  const items = [{ clave: 'X · 1', cantidad: 1, precio: 100 }];
  assert.throws(() => construirFactura({ config: {}, nit: '1', items, codigos: { 'x · 1': 'X' } }), /Falta configurar/);
  assert.throws(() => construirFactura({ config: CONFIG, nit: '', items, codigos: { 'x · 1': 'X' } }), /NIT/);
  assert.throws(() => construirFactura({ config: CONFIG, nit: '1', items, codigos: {} }), /código de Siigo/);
});

test('facturarDespacho crea la factura, marca las entregas y no factura dos veces', async () => {
  const db = dbFalsa(datosBase());
  const client = clienteFalso();
  const r = await facturarDespacho({ client, db, distId: 'Imperio', fecha: '2026-09-30', nit: '900123456-7', cliente: 'Imperio', fechaHoy: '2026-09-30' });
  assert.strictEqual(r.numero, 'FV-1-120');
  assert.strictEqual(client.creadas.length, 1);
  assert.deepStrictEqual(client.creadas[0].items.map((i) => [i.code, i.quantity]), [['SAB-140', 8], ['COB-1', 3]]);
  const marcas = db.datos.siigo.facturacionApp.Imperio.entradas;
  assert.deepStrictEqual(Object.keys(marcas).sort(), ['e1', 'e2', 'e3']);
  assert.strictEqual(db.datos.siigo.facturacionApp.Imperio.bloqueo, undefined);
  await assert.rejects(
    facturarDespacho({ client, db, distId: 'Imperio', fecha: '2026-09-30', nit: '900123456', fechaHoy: '2026-09-30' }),
    /No hay entregas sin facturar/
  );
  assert.strictEqual(client.creadas.length, 1);
});

test('si Siigo no responde claro, la siguiente vez pide confirmar antes de reintentar', async () => {
  const db = dbFalsa(datosBase());
  const caido = Object.assign(new Error('timeout'), { status: 502 });
  await assert.rejects(
    facturarDespacho({ client: clienteFalso(caido), db, distId: 'Imperio', fecha: '2026-09-30', nit: '1', fechaHoy: '2026-09-30' }),
    /Revisa en Siigo/
  );
  await assert.rejects(
    facturarDespacho({ client: clienteFalso(), db, distId: 'Imperio', fecha: '2026-09-30', nit: '1', fechaHoy: '2026-09-30' }),
    (e) => e instanceof ErrorUsuario && e.requiereConfirmar
  );
  const ok = await facturarDespacho({ client: clienteFalso(), db, distId: 'Imperio', fecha: '2026-09-30', nit: '1', fechaHoy: '2026-09-30', forzar: true });
  assert.strictEqual(ok.numero, 'FV-1-120');
  assert.deepStrictEqual(db.datos.siigo.facturacionApp.Imperio.dudosas || {}, {});
});

test('si Siigo rechaza la factura (4xx) no queda marcada y se puede corregir y reintentar', async () => {
  const db = dbFalsa(datosBase());
  const rechazo = Object.assign(new Error('invalid customer'), { status: 400 });
  await assert.rejects(
    facturarDespacho({ client: clienteFalso(rechazo), db, distId: 'Imperio', fecha: '2026-09-30', nit: '1', fechaHoy: '2026-09-30' }),
    /no aceptó/
  );
  const app = (db.datos.siigo && db.datos.siigo.facturacionApp && db.datos.siigo.facturacionApp.Imperio) || {};
  assert.strictEqual(app.entradas, undefined);
  assert.strictEqual(app.dudosas, undefined);
});

test('verificarClave bloquea tras varios intentos fallidos', async () => {
  const db = dbFalsa();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(verificarClave({ db, claveEsperada: 'secreta', claveRecibida: 'mala', ahora: 1000 }), /incorrecta/);
  }
  await assert.rejects(verificarClave({ db, claveEsperada: 'secreta', claveRecibida: 'secreta', ahora: 2000 }), /Demasiados intentos/);
  await verificarClave({ db, claveEsperada: 'secreta', claveRecibida: 'secreta', ahora: 1000 + 16 * 60 * 1000 });
});
