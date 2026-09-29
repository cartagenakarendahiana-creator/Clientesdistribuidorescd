// Sincronización Siigo -> Firebase Realtime Database.
//
// Todo se guarda bajo el nodo raíz `siigo/`, separado de `casaDoradaDatos`
// (la app guarda ese nodo completo con set(), así que no debe tocarse desde aquí).
//
//   siigo/facturasDia/{AAAA-MM-DD}/{idSiigo}    facturas normalizadas, agrupadas por fecha del documento
//   siigo/facturasIndice/{idSiigo}              fecha en la que está guardada cada factura
//   siigo/resumenDiario/{AAAA-MM-DD}/{centro}   totales del día por centro de costo
//        ...incluye `global` (todos los centros) y, dentro de cada centro,
//        `productos/{codigo}`, `clientes/{nit}` y `vendedores/{id}` con cantidad y valor
//   siigo/catalogos/{centrosCosto|vendedores|clientes|productos}
//   siigo/estado                                última sincronización y errores
//
// El filtro de fechas de la API de Siigo compara contra la fecha y hora de CREACIÓN de la factura,
// no contra la fecha del documento. Por eso se piden las facturas creadas en una ventana amplia y el
// resumen de cada día se reconstruye a partir de todas las facturas guardadas con esa fecha.

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

  nodo.vendedores = nodo.vendedores || {};
  const ven = (nodo.vendedores[claveSegura(factura.vendedor ?? 'sin_vendedor')] ||= { id: factura.vendedor ?? null, facturas: 0, valor: 0 });
  ven.facturas += 1;
  ven.valor = redondear(ven.valor + factura.total);

  const cli = (nodo.clientes[claveSegura(factura.clienteNit)] ||= { nit: factura.clienteNit, facturas: 0, valor: 0 });
  cli.facturas += 1;
  cli.valor = redondear(cli.valor + factura.total);

  for (const it of factura.items || []) { // Firebase no guarda arreglos vacíos
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

// Resumen de UN día a partir de todas sus facturas.
function construirDia(facturas) {
  const dia = { global: { ventas: 0, facturas: 0, unidades: 0 } };
  for (const f of facturas) {
    if (f.anulada) continue;
    agregarA(dia.global, f);
    agregarA((dia[claveCentro(f.centroCosto)] ||= { ventas: 0, facturas: 0, unidades: 0 }), f);
  }
  return dia;
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

// Días extra que se piden a Siigo después de `hasta`: su filtro usa fecha y hora de creación en UTC
// y, con solo la fecha, deja por fuera lo creado durante el día (y lo de la noche en Colombia).
const MARGEN_DIAS_FIN = 2;

// Sincroniza las facturas CREADAS entre `desde` y `hasta` (AAAA-MM-DD) y reconstruye el resumen de
// cada fecha de documento afectada. `db` es un Database de firebase-admin.
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

    const updates = {};
    updates['siigo/catalogos/centrosCosto'] = indexar(centros, (c) => c.id !== undefined && claveCentro(c.id), (c) => ({
      id: c.id,
      codigo: c.code || '',
      nombre: c.name || '',
      activo: c.active !== false,
    }));
    updates['siigo/catalogos/vendedores'] = indexar(vendedores, (u) => u.id, (u) => ({
      id: u.id,
      nombre: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '',
      activo: u.active !== false,
    }));
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

    const traidas = (await client.facturas(desde, sumarDias(hasta, MARGEN_DIAS_FIN)))
      .map(normalizarFactura)
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha));

    // Fechas afectadas: las de las facturas traídas y, si alguna cambió de fecha, la anterior.
    const indice = (await db.ref('siigo/facturasIndice').once('value')).val() || {};
    const afectadas = new Set();
    for (const f of traidas) {
      const id = claveSegura(f.id);
      afectadas.add(f.fecha);
      if (indice[id] && indice[id] !== f.fecha) afectadas.add(indice[id]);
      updates[`siigo/facturasIndice/${id}`] = f.fecha;
    }

    for (const fecha of afectadas) {
      const guardadas = (await db.ref(`siigo/facturasDia/${fecha}`).once('value')).val() || {};
      for (const f of traidas) {
        const id = claveSegura(f.id);
        if (f.fecha === fecha) guardadas[id] = f;
        else delete guardadas[id]; // cambió de fecha
      }
      updates[`siigo/facturasDia/${fecha}`] = guardadas;
      updates[`siigo/resumenDiario/${fecha}`] = construirDia(Object.values(guardadas));
    }

    // Versión anterior guardaba las facturas sin agrupar en siigo/facturas: ya no se usa.
    if (estado.version !== 2) updates['siigo/facturas'] = null;

    updates['siigo/estado'] = {
      version: 2,
      ultimaSincronizacion: inicio,
      rango: { desde, hasta },
      facturas: traidas.length,
      diasActualizados: afectadas.size,
      // Fecha de Colombia (no UTC) y un día de traslape, para no saltarse clientes/productos creados esa noche.
      catalogosHasta: sumarDias(hoyColombia(new Date(inicio)), -1),
      ultimoError: null,
    };
    await db.ref().update(updates);
    log(`Siigo: ${traidas.length} facturas sincronizadas (creadas ${desde} a ${hasta}), ${afectadas.size} días actualizados.`);
    return { facturas: traidas.length, dias: afectadas.size, clientes: clientes.length, productos: productos.length };
  } catch (err) {
    await estadoRef.update({ ultimoError: { fecha: inicio, mensaje: String(err.message || err) } });
    throw err;
  }
}

// Carga del HISTÓRICO sin tener que correr nada a mano: en cada corrida se trae uno o más meses
// hacia atrás (empezando por el mes actual), hasta encontrar 3 meses seguidos sin facturas o
// llegar a HISTORICO_LIMITE. El avance queda en `siigo/historico`.
const HISTORICO_LIMITE = '2018-01-01';
const MESES_VACIOS_PARA_TERMINAR = 3;

async function avanzarHistorico({ client, db, tiempoMaxMs = 240000, log = console.log, hoy = hoyColombia() }) {
  const t0 = Date.now();
  const ref = db.ref('siigo/historico');
  let h = (await ref.once('value')).val() || {};
  const inicioMesSiguiente = sumarDias(`${hoy.slice(0, 7)}-01`, 32).slice(0, 7) + '-01';
  let meses = 0;
  while (!h.completo && Date.now() - t0 < tiempoMaxMs && meses < 6) {
    const base = h.cargadoDesde || inicioMesSiguiente; // primer día del último mes ya cargado
    const finMes = sumarDias(base, -1);
    const iniMes = `${finMes.slice(0, 7)}-01`;
    if (iniMes < HISTORICO_LIMITE) {
      h = { ...h, completo: true };
      await ref.set(h);
      break;
    }
    const r = await sincronizar({ client, db, desde: iniMes, hasta: finMes, log });
    const vacios = r.facturas ? 0 : (Number(h.mesesVacios) || 0) + 1;
    h = {
      cargadoDesde: iniMes,
      mesesVacios: vacios,
      completo: vacios >= MESES_VACIOS_PARA_TERMINAR,
      facturas: (Number(h.facturas) || 0) + r.facturas,
      actualizado: new Date().toISOString(),
    };
    await ref.set(h);
    log(`Siigo histórico: ${iniMes.slice(0, 7)} cargado (${r.facturas} facturas).`);
    meses++;
  }
  return h;
}


module.exports = {
  sincronizar,
  avanzarHistorico,
  normalizarFactura,
  construirDia,
  rangoFechas,
  hoyColombia,
  sumarDias,
  claveSegura,
  claveCentro,
};
