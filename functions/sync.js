// Sincronización Siigo -> Firebase Realtime Database.
//
// Todo se guarda bajo el nodo raíz `siigo/`, separado de `casaDoradaDatos`
// (la app guarda ese nodo completo con set(), así que no debe tocarse desde aquí).
//
//   siigo/facturas/{idSiigo}                    factura normalizada
//   siigo/resumenDiario/{AAAA-MM-DD}/{centro}   totales del día por centro de costo
//        ...incluye `global` (todos los centros) y, dentro de cada centro,
//        `productos/{codigo}` y `clientes/{nit}` con cantidad y valor
//   siigo/catalogos/{centrosCosto|vendedores|clientes|productos}
//   siigo/estado                                última sincronización y errores

const CENTRO_SIN_ASIGNAR = 'sin_centro';

// Firebase no admite . # $ [ ] / en las claves.
const claveSegura = (v) => String(v ?? '').trim().replace(/[.#$[\]/]/g, '_') || 'sin_dato';

const claveCentro = (id) => (id === undefined || id === null || id === '' ? CENTRO_SIN_ASIGNAR : `cc_${claveSegura(id)}`);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const redondear = (n) => Math.round(n * 100) / 100;

function fechaISO(d) {
  return d.toISOString().slice(0, 10);
}

// Fecha de hoy en Colombia (UTC-5, sin horario de verano).
function hoyColombia(ahora = new Date()) {
  return fechaISO(new Date(ahora.getTime() - 5 * 3600 * 1000));
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return fechaISO(d);
}

function nombreCliente(c) {
  if (!c) return '';
  if (c.commercial_name) return c.commercial_name;
  if (Array.isArray(c.name)) return c.name.filter(Boolean).join(' ');
  return c.name || '';
}

function normalizarFactura(f) {
  const items = (f.items || []).map((it) => {
    const cantidad = num(it.quantity);
    const valor = it.total !== undefined ? num(it.total) : cantidad * num(it.price);
    return {
      codigo: it.code || '',
      descripcion: it.description || '',
      cantidad,
      precio: num(it.price),
      descuento: num(it.discount),
      valor: redondear(valor),
    };
  });
  return {
    id: f.id,
    numero: f.name || [f.prefix, f.number].filter(Boolean).join('-'),
    fecha: String(f.date || '').slice(0, 10),
    clienteNit: f.customer ? String(f.customer.identification || '') : '',
    centroCosto: f.cost_center ?? null,
    vendedor: f.seller ?? null,
    total: num(f.total),
    saldo: num(f.balance),
    anulada: f.annulled === true,
    items,
    actualizada: (f.metadata && (f.metadata.last_updated || f.metadata.created)) || null,
  };
}

function agregarA(nodo, factura) {
  nodo.ventas = redondear(num(nodo.ventas) + factura.total);
  nodo.facturas = num(nodo.facturas) + 1;
  nodo.productos = nodo.productos || {};
  nodo.clientes = nodo.clientes || {};

  const cli = (nodo.clientes[claveSegura(factura.clienteNit)] ||= { nit: factura.clienteNit, facturas: 0, valor: 0 });
  cli.facturas += 1;
  cli.valor = redondear(cli.valor + factura.total);

  for (const it of factura.items) {
    nodo.unidades = redondear(num(nodo.unidades) + it.cantidad);
    const p = (nodo.productos[claveSegura(it.codigo || it.descripcion)] ||= {
      codigo: it.codigo,
      descripcion: it.descripcion,
      cantidad: 0,
      valor: 0,
    });
    p.cantidad = redondear(p.cantidad + it.cantidad);
    p.valor = redondear(p.valor + it.valor);
  }
}

// Construye el resumen de cada día a partir de TODAS las facturas de ese día.
function construirResumen(facturas, fechas) {
  const resumen = {};
  for (const fecha of fechas) resumen[fecha] = { global: { ventas: 0, facturas: 0, unidades: 0 } };
  for (const f of facturas) {
    if (f.anulada || !resumen[f.fecha]) continue;
    const dia = resumen[f.fecha];
    agregarA(dia.global, f);
    agregarA((dia[claveCentro(f.centroCosto)] ||= { ventas: 0, facturas: 0, unidades: 0 }), f);
  }
  return resumen;
}

function rangoFechas(desde, hasta) {
  const fechas = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) fechas.push(d);
  return fechas;
}

function indexar(lista, clave, mapear) {
  const out = {};
  for (const x of lista || []) {
    const k = clave(x);
    if (k) out[claveSegura(k)] = mapear(x);
  }
  return out;
}

// Sincroniza las facturas con fecha entre `desde` y `hasta` (AAAA-MM-DD, inclusive)
// y reconstruye el resumen diario de esas fechas. `db` es un Database de firebase-admin.
async function sincronizar({ client, db, desde, hasta, log = console.log }) {
  const inicio = new Date().toISOString();
  const estadoRef = db.ref('siigo/estado');
  const estado = (await estadoRef.once('value')).val() || {};

  try {
    // Catálogos: centros de costo y vendedores completos; clientes y productos incrementales.
    const [centros, vendedores] = await Promise.all([client.centrosDeCosto(), client.vendedores()]);
    const clientesDesde = estado.catalogosHasta || undefined;
    const clientes = await client.clientes(clientesDesde);
    const productos = await client.productos(clientesDesde);

    const catalogos = {
      'siigo/catalogos/centrosCosto': indexar(centros, (c) => c.id !== undefined && claveCentro(c.id), (c) => ({
        id: c.id,
        codigo: c.code || '',
        nombre: c.name || '',
        activo: c.active !== false,
      })),
      'siigo/catalogos/vendedores': indexar(vendedores, (u) => u.id, (u) => ({
        id: u.id,
        nombre: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '',
        activo: u.active !== false,
      })),
    };
    const updates = {};
    for (const [ruta, valor] of Object.entries(catalogos)) updates[ruta] = valor;
    for (const [k, c] of Object.entries(indexar(clientes, (c) => c.identification, (c) => ({
      nit: String(c.identification),
      nombre: nombreCliente(c),
      ciudad: (c.address && c.address.city && c.address.city.city_name) || '',
    })))) updates[`siigo/catalogos/clientes/${k}`] = c;
    for (const [k, p] of Object.entries(indexar(productos, (p) => p.code, (p) => ({
      codigo: p.code,
      nombre: p.name || '',
      activo: p.active !== false,
    })))) updates[`siigo/catalogos/productos/${k}`] = p;

    // Facturas del rango: se reemplaza el resumen completo de cada día.
    const facturas = (await client.facturas(desde, hasta)).map(normalizarFactura);
    for (const f of facturas) updates[`siigo/facturas/${claveSegura(f.id)}`] = f;
    const fechas = rangoFechas(desde, hasta);
    const resumen = construirResumen(facturas, fechas);
    for (const fecha of fechas) updates[`siigo/resumenDiario/${fecha}`] = resumen[fecha];

    updates['siigo/estado'] = {
      ultimaSincronizacion: inicio,
      rango: { desde, hasta },
      facturas: facturas.length,
      catalogosHasta: inicio.slice(0, 10),
      ultimoError: null,
    };
    await db.ref().update(updates);
    log(`Siigo: ${facturas.length} facturas sincronizadas (${desde} a ${hasta}).`);
    return { facturas: facturas.length, clientes: clientes.length, productos: productos.length };
  } catch (err) {
    await estadoRef.update({ ultimoError: { fecha: inicio, mensaje: String(err.message || err) } });
    throw err;
  }
}

module.exports = {
  sincronizar,
  normalizarFactura,
  construirResumen,
  rangoFechas,
  hoyColombia,
  sumarDias,
  claveSegura,
  claveCentro,
};
