// Lectura de TODA la información para la API (solo lectura; crear pedidos está en pedidos.js).
//
//   GET /secciones                       qué se puede leer y cuántos registros hay
//   GET /clientes                        clientes con sus datos de contacto y resumen de pedidos
//   GET /despachos   ?desde&hasta&cliente
//   GET /facturas    ?desde&hasta&cliente
//   GET /produccion  ?desde&hasta&etapa
//   GET /gastos      ?desde&hasta        gastos adicionales
//   GET /costos-fijos                    centro de costos
//   GET /precios-servicio ?etapa
//   GET /insumos                         costo de insumos (historial de precios)
//   GET /vendedores
//   GET /datos  y  GET /datos/{seccion}  cualquier sección de casaDoradaDatos, tal cual
//   GET /siigo/estado | /siigo/clientes | /siigo/productos | /siigo/vendedores
//   GET /siigo/ventas    ?desde&hasta     resumen de ventas por día (máximo 400 días)
//   GET /siigo/facturas  ?desde&hasta     facturas de Siigo (máximo 62 días)
//   GET /crm                             contactos y equipo comercial del CRM

const { ErrorApi } = require('./errores');

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
// Partes de casaDoradaDatos que nunca salen por la API.
const PRIVADAS = new Set(['auth', 'usuarios']);

const lista = (v) => Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined)
  : (v && typeof v === 'object' ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]).filter((x) => x !== null && x !== undefined) : []);
const decodificarClave = (k) => String(k).replace(/%(25|2E|23|24|2F|5B|5D)/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
function decodificar(val) {
  if (Array.isArray(val)) return val.map(decodificar);
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[decodificarClave(k)] = decodificar(val[k]);
    return out;
  }
  return val;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const fechaIso = (f) => { const t = String(f || '').slice(0, 10); return FECHA.test(t) ? t : ''; };

async function seccion(db, nombre) {
  return decodificar((await db.ref(`casaDoradaDatos/${nombre}`).once('value')).val());
}

function revisarRango(q, maxDias) {
  for (const c of ['desde', 'hasta']) if (q[c] && !FECHA.test(q[c])) throw new ErrorApi(400, `"${c}" debe tener el formato AAAA-MM-DD.`);
  if (maxDias) {
    if (!q.desde || !q.hasta) throw new ErrorApi(400, `Indica "desde" y "hasta" (AAAA-MM-DD), máximo ${maxDias} días.`);
    const dias = (Date.parse(q.hasta) - Date.parse(q.desde)) / 86400000;
    if (dias < 0) throw new ErrorApi(400, '"desde" debe ser antes de "hasta".');
    if (dias > maxDias) throw new ErrorApi(400, `Máximo ${maxDias} días por consulta.`);
  }
}
// Filtro común: fecha dentro del rango y texto en el campo del cliente.
function filtrar(items, q, { campoCliente = 'cliente', campoFecha = 'fecha', extra } = {}) {
  revisarRango(q);
  const k = q.cliente ? norm(q.cliente) : '';
  return items.filter((x) => {
    const f = fechaIso(x[campoFecha]);
    if (q.desde && !(f && f >= q.desde)) return false;
    if (q.hasta && !(f && f <= q.hasta)) return false;
    if (k && !norm(x[campoCliente]).includes(k)) return false;
    return extra ? extra(x) : true;
  });
}
const respuesta = (nombre, items) => ({ status: 200, json: { total: items.length, [nombre]: items } });

// Clientes: los registrados y los que tienen pedidos, con su información de contacto y un resumen.
function clientesDe(d, pedidos) {
  const porClave = new Map();
  const poner = (nombre) => { const k = norm(nombre); if (k && !porClave.has(k)) porClave.set(k, { cliente: String(nombre).trim(), pedidos: 0, pendientes: 0, valorPendiente: 0, ultimoPedido: null, tipos: new Set() }); return porClave.get(k); };
  lista(d.distribuidoresRegistry).forEach(poner);
  pedidos.forEach((p) => {
    const c = poner(p.cliente);
    c.pedidos++;
    c.pendientes += p.totales.pendientes;
    c.valorPendiente += p.totales.valorPendiente;
    if (p.tipo) c.tipos.add(p.tipo);
    const f = fechaIso(p.fecha);
    if (f && (!c.ultimoPedido || f > c.ultimoPedido)) c.ultimoPedido = f;
  });
  const info = d.clientesInfo || {};
  return [...porClave.entries()].map(([k, c]) => {
    const i = info[k] || {};
    return { ...c, tipos: [...c.tipos], nit: i.nit || '', telefono: i.telefono || '', ciudad: i.ciudad || '', direccion: i.direccion || '' };
  }).sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'));
}

// Rutas de lectura. Devuelve null si la ruta no es de lectura (para que siga el enrutador de pedidos).
async function leer({ db, partes, query, armarPedidosConDatos }) {
  const [r0, r1] = partes;
  if (r0 === 'secciones' && partes.length === 1) {
    const datos = decodificar((await db.ref('casaDoradaDatos').once('value')).val()) || {};
    const cuenta = (v) => Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : (v === null || v === undefined ? 0 : 1));
    return { status: 200, json: {
      rutas: ['/productos', '/pedidos', '/clientes', '/despachos', '/facturas', '/produccion', '/gastos', '/costos-fijos', '/precios-servicio', '/insumos', '/vendedores', '/datos/{seccion}', '/siigo/ventas', '/siigo/facturas', '/siigo/clientes', '/siigo/productos', '/siigo/vendedores', '/siigo/estado', '/crm'],
      datos: Object.fromEntries(Object.keys(datos).filter((k) => !PRIVADAS.has(k)).sort().map((k) => [k, cuenta(datos[k])])),
    } };
  }
  if (r0 === 'clientes' && partes.length === 1) {
    const { d, pedidos } = await armarPedidosConDatos();
    const k = query.cliente ? norm(query.cliente) : '';
    return respuesta('clientes', clientesDe(d, pedidos).filter((c) => !k || norm(c.cliente).includes(k)));
  }
  if (r0 === 'despachos' && partes.length === 1) {
    // La foto de la guía no sale aquí (vive aparte); se indica si la tiene.
    const items = lista(await seccion(db, 'despachos')).map(({ guiaFoto, ...x }) => ({ ...x, tieneFotoGuia: !!guiaFoto }));
    return respuesta('despachos', filtrar(items, query));
  }
  if (r0 === 'facturas' && partes.length === 1) return respuesta('facturas', filtrar(lista(await seccion(db, 'facturas')), query));
  if (r0 === 'produccion' && partes.length === 1) {
    const etapa = query.etapa ? norm(query.etapa) : '';
    return respuesta('produccion', filtrar(lista(await seccion(db, 'plantaProduccionDiaria')), query, { campoCliente: 'producto', extra: (x) => !etapa || norm(x.etapa).startsWith(etapa) }));
  }
  if (r0 === 'gastos' && partes.length === 1) return respuesta('gastos', filtrar(lista(await seccion(db, 'plantaGastosAdicionales')), query, { campoCliente: 'concepto' }));
  if (r0 === 'costos-fijos' && partes.length === 1) return respuesta('costosFijos', lista(await seccion(db, 'plantaCostosFijos')));
  if (r0 === 'precios-servicio' && partes.length === 1) {
    const etapa = query.etapa ? norm(query.etapa) : '';
    return respuesta('preciosServicio', lista(await seccion(db, 'plantaServiciosMaquila')).filter((x) => !etapa || norm(x.etapa).startsWith(etapa)));
  }
  if (r0 === 'insumos' && partes.length === 1) return respuesta('insumos', filtrar(lista(await seccion(db, 'insumosCostos')), query, { campoCliente: 'insumo' }));
  if (r0 === 'vendedores' && partes.length === 1) return respuesta('vendedores', lista(await seccion(db, 'vendedoresRegistry')));
  if (r0 === 'datos') {
    if (partes.length === 1) {
      const datos = (await db.ref('casaDoradaDatos').once('value')).val() || {};
      return { status: 200, json: { secciones: Object.keys(datos).map(decodificarClave).filter((k) => !PRIVADAS.has(k)).sort() } };
    }
    if (partes.length === 2) {
      if (PRIVADAS.has(r1) || !/^[A-Za-z0-9_]+$/.test(r1)) throw new ErrorApi(404, 'No existe esa sección.');
      const val = await seccion(db, r1);
      if (val === null || val === undefined) throw new ErrorApi(404, 'No existe esa sección (consulta GET /datos).');
      return { status: 200, json: { seccion: r1, datos: val } };
    }
  }
  if (r0 === 'siigo' && partes.length === 2) {
    if (r1 === 'estado') return { status: 200, json: { estado: (await db.ref('siigo/estado').once('value')).val() } };
    if (['clientes', 'productos', 'vendedores'].includes(r1)) {
      const items = Object.values((await db.ref(`siigo/catalogos/${r1}`).once('value')).val() || {});
      return respuesta(r1, items);
    }
    if (r1 === 'ventas' || r1 === 'facturas') {
      revisarRango(query, r1 === 'ventas' ? 400 : 62);
      const nodo = r1 === 'ventas' ? 'siigo/resumenDiario' : 'siigo/facturasDia';
      const porDia = (await db.ref(nodo).orderByKey().startAt(query.desde).endAt(query.hasta).once('value')).val() || {};
      if (r1 === 'ventas') return { status: 200, json: { desde: query.desde, hasta: query.hasta, dias: porDia } };
      const facturas = Object.entries(porDia).flatMap(([fecha, fs]) => Object.values(fs || {}).map((f) => ({ fecha, ...f })));
      return respuesta('facturas', facturas);
    }
  }
  if (r0 === 'crm' && partes.length === 1) {
    const crm = (await db.ref('crm').once('value')).val() || {};
    return { status: 200, json: { contactos: lista(crm.contactos), equipo: lista(crm.equipo), importado: crm.importado || null } };
  }
  return null;
}

module.exports = { leer, clientesDe, decodificar };
