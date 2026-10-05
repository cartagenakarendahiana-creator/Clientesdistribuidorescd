// API de pedidos de Casa Dorada: arma los pedidos igual que la app (index.html: getAllDistributors,
// getOrderLines, getEntregado) y crea pedidos nuevos igual que "+ Nuevo pedido".
//
// Los pedidos viejos vienen de CATALOG (escrito dentro de index.html); al publicar las funciones se copia
// a functions/catalogo.json con scripts/extraer-catalogo.js. Lo demás está en casaDoradaDatos.

const crypto = require('crypto');

class ErrorApi extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

// Secciones de casaDoradaDatos que se necesitan para armar los pedidos.
const SECCIONES = [
  'nuevosDistribuidores', 'extras', 'entregas', 'productOverrides', 'customProducts', 'catalogOverrides',
  'distNameOverrides', 'distVendedorOverrides', 'distDespachoOverrides', 'distFechaOverrides', 'clientesInfo',
  'distObservaciones', 'distUrgenteOverrides', 'distribuidoresEliminados', 'distribuidoresRegistry',
];

const lista = (v) => Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined)
  : (v && typeof v === 'object' ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]).filter((x) => x !== null && x !== undefined) : []);
// La app codifica . # $ / [ ] % en las claves (encodeFirebaseKey).
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
const clienteKey = (nombre) => String(nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function leerDatos(db) {
  const vals = await Promise.all(SECCIONES.map((s) => db.ref(`casaDoradaDatos/${s}`).once('value').then((x) => x.val())));
  const d = {};
  SECCIONES.forEach((s, i) => { d[s] = decodificar(vals[i]); });
  return d;
}

function productos(catalogo, d) {
  const ov = d.productOverrides || {};
  const base = catalogo.productos.map((p, idx) => (ov[idx] ? { ...p, ...ov[idx] } : p));
  return [...base, ...lista(d.customProducts)].map((p, id) => ({
    id, categoria: p.categoria || '', producto: p.producto || '', medida: p.medida || '', precio: Number(p.precio) || 0,
  }));
}

function observacionesDe(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((o) => ({ texto: o.texto || '', fecha: o.fecha || null }));
  if (raw && typeof raw === 'object') return lista(raw).map((o) => ({ texto: o.texto || '', fecha: o.fecha || null }));
  if (typeof raw === 'string' && raw.trim()) return [{ texto: raw, fecha: null }];
  return [];
}

function lineasDe(catalogo, d, prods, distId) {
  const lineas = [];
  const ovDist = (d.catalogOverrides || {})[distId] || {};
  catalogo.productos.forEach((p, idx) => {
    const cant = p.pedidos && p.pedidos[distId];
    if (!cant) return;
    const key = 'cat-' + idx;
    const ov = ovDist[key];
    if (ov && ov.eliminado) return;
    let productoId = idx, cantidad = cant, precio = p.precio;
    if (ov) {
      if (ov.productoIdx !== undefined) productoId = ov.productoIdx;
      if (ov.cantidad !== undefined) cantidad = ov.cantidad;
      if (ov.precio !== undefined) precio = ov.precio;
    }
    lineas.push({ key, productoId, cantidad, precio });
  });
  lista(d.extras).forEach((ex, i) => {
    if (ex.distId !== distId) return;
    const uid = ex.uid !== undefined && ex.uid !== null ? ex.uid : String(i);
    const prod = prods[ex.productoIdx];
    lineas.push({ key: 'extra-' + uid, productoId: ex.productoIdx, cantidad: ex.cantidad, precio: ex.precio ?? (prod ? prod.precio : 0) });
  });
  const entregas = (d.entregas || {})[distId] || {};
  return lineas.map((l) => {
    const prod = prods[l.productoId] || { categoria: '', producto: '(producto eliminado)', medida: '' };
    const cantidad = Number(l.cantidad) || 0, precio = Number(l.precio) || 0, entregado = Number(entregas[l.key]) || 0;
    return {
      linea: l.key, productoId: l.productoId, categoria: prod.categoria, producto: prod.producto, medida: prod.medida,
      cantidad, precio, subtotal: cantidad * precio, entregado, pendiente: Math.max(0, cantidad - entregado),
    };
  });
}

function armarPedidos(catalogo, d) {
  const prods = productos(catalogo, d);
  const eliminados = new Set(lista(d.distribuidoresEliminados));
  const base = catalogo.distribuidores.map((x) => ({ id: x.id, nombre: x.nombre, fecha: x.fecha }));
  const nuevos = lista(d.nuevosDistribuidores).map((x) => ({
    id: x.id, nombre: x.nombre, fecha: x.fecha, vendedor: x.vendedor, fechaDespacho: x.fechaDespacho, referenciaExterna: x.referenciaExterna, creadoPorApi: x.creadoPorApi,
  }));
  const pick = (mapa, id) => (d[mapa] || {})[id];
  return [...base, ...nuevos].filter((x) => x && x.id && !eliminados.has(x.id)).map((x) => {
    const nombre = pick('distNameOverrides', x.id) || x.nombre;
    const info = (d.clientesInfo || {})[clienteKey(nombre)] || {};
    const lineas = lineasDe(catalogo, d, prods, x.id);
    const unidades = lineas.reduce((a, l) => a + l.cantidad, 0);
    const pendientes = lineas.reduce((a, l) => a + l.pendiente, 0);
    return {
      id: x.id,
      cliente: nombre,
      nit: info.nit || '', telefono: info.telefono || '', ciudad: info.ciudad || '', direccion: info.direccion || '',
      fecha: pick('distFechaOverrides', x.id) || x.fecha || null,
      vendedor: pick('distVendedorOverrides', x.id) || x.vendedor || '',
      fechaDespacho: pick('distDespachoOverrides', x.id) || x.fechaDespacho || null,
      urgente: !!pick('distUrgenteOverrides', x.id),
      observaciones: observacionesDe(pick('distObservaciones', x.id)),
      referenciaExterna: x.referenciaExterna || null,
      estado: !lineas.length ? 'sin_productos' : (pendientes > 0 ? 'pendiente' : 'entregado'),
      totales: {
        unidades, entregadas: unidades - pendientes, pendientes,
        valor: lineas.reduce((a, l) => a + l.subtotal, 0),
        valorPendiente: lineas.reduce((a, l) => a + l.pendiente * l.precio, 0),
      },
      lineas,
    };
  });
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// Revisa lo que manda la otra app y lo deja listo para guardar.
function validarNuevoPedido(body, prods) {
  if (!body || typeof body !== 'object') throw new ErrorApi(400, 'Envía el pedido en JSON.');
  const cliente = texto(body.cliente, 200);
  if (!cliente) throw new ErrorApi(400, 'Falta "cliente".');
  for (const c of ['fecha', 'fechaDespacho']) {
    if (body[c] && !FECHA.test(String(body[c]))) throw new ErrorApi(400, `"${c}" debe tener el formato AAAA-MM-DD.`);
  }
  if (!Array.isArray(body.lineas) || !body.lineas.length) throw new ErrorApi(400, 'Falta "lineas" (al menos un producto).');
  if (body.lineas.length > 300) throw new ErrorApi(400, 'Máximo 300 líneas por pedido.');
  const lineas = body.lineas.map((l, i) => {
    const productoId = Number(l && l.productoId);
    if (!Number.isInteger(productoId) || !prods[productoId]) throw new ErrorApi(400, `Línea ${i + 1}: "productoId" no existe (consulta GET /productos).`);
    const cantidad = Number(l.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new ErrorApi(400, `Línea ${i + 1}: "cantidad" debe ser mayor que 0.`);
    let precio = prods[productoId].precio;
    if (l.precio !== undefined && l.precio !== null && l.precio !== '') {
      precio = Number(l.precio);
      if (!Number.isFinite(precio) || precio < 0) throw new ErrorApi(400, `Línea ${i + 1}: "precio" no es válido.`);
    }
    return { productoId, cantidad, precio };
  });
  return {
    cliente,
    vendedor: texto(body.vendedor, 120),
    fecha: body.fecha ? String(body.fecha) : null,
    fechaDespacho: body.fechaDespacho ? String(body.fechaDespacho) : null,
    urgente: body.urgente === true,
    observaciones: texto(body.observaciones, 2000),
    referenciaExterna: texto(body.referenciaExterna, 120) || null,
    info: { nit: texto(body.nit, 40), telefono: texto(body.telefono, 80), ciudad: texto(body.ciudad, 80), direccion: texto(body.direccion, 200) },
    lineas,
  };
}

const uidLinea = () => 'u' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const indiceSiguiente = (actual) => Array.isArray(actual) ? actual.length
  : (actual && typeof actual === 'object' ? Math.max(-1, ...Object.keys(actual).map(Number).filter(Number.isInteger)) + 1 : 0);

// Agrega un elemento al final de una lista de casaDoradaDatos sin pisar lo que otro equipo guarde a la vez.
async function agregarALista(db, seccion, items) {
  const ref = db.ref(`casaDoradaDatos/${seccion}`);
  await ref.transaction((actual) => {
    let i = indiceSiguiente(actual);
    const out = Array.isArray(actual) ? actual.slice() : { ...(actual || {}) };
    items.forEach((it) => { out[i++] = it; });
    return out;
  });
}

async function crearPedido({ db, catalogo, body }) {
  const d = await leerDatos(db);
  const prods = productos(catalogo, d);
  const p = validarNuevoPedido(body, prods);
  const pedidos = armarPedidos(catalogo, d);
  if (p.referenciaExterna) {
    const ya = pedidos.find((x) => x.referenciaExterna === p.referenciaExterna);
    if (ya) return { creado: false, pedido: ya }; // la otra app reintentó: no se duplica
  }
  // Mismo cliente aunque cambien tildes o mayúsculas (como nombreClienteCanonico en la app).
  const k = clienteKey(p.cliente);
  const existente = lista(d.distribuidoresRegistry).find((n) => clienteKey(n) === k)
    || pedidos.slice().reverse().map((x) => x.cliente).find((n) => clienteKey(n) === k);
  const nombre = existente || p.cliente;
  const id = 'api-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');

  await agregarALista(db, 'nuevosDistribuidores', [{
    id, nombre, fecha: p.fecha, vendedor: p.vendedor, fechaDespacho: p.fechaDespacho, creadoPorApi: true,
    ...(p.referenciaExterna ? { referenciaExterna: p.referenciaExterna } : {}),
  }]);
  await agregarALista(db, 'extras', p.lineas.map((l) => ({ distId: id, productoIdx: l.productoId, cantidad: l.cantidad, precio: l.precio, uid: uidLinea() })));

  const updates = {};
  if (p.urgente) updates[`distUrgenteOverrides/${id}`] = true;
  if (p.observaciones) updates[`distObservaciones/${id}`] = [{ texto: p.observaciones, fecha: new Date().toISOString() }];
  if (k && (p.info.nit || p.info.telefono || p.info.ciudad || p.info.direccion)) {
    const actual = (d.clientesInfo || {})[k] || {};
    updates[`clientesInfo/${k}`] = {
      nit: p.info.nit || actual.nit || '', telefono: p.info.telefono || actual.telefono || '',
      direccion: p.info.direccion || actual.direccion || '', ciudad: p.info.ciudad || actual.ciudad || '',
    };
  }
  if (Object.keys(updates).length) await db.ref('casaDoradaDatos').update(updates);
  if (!existente) await agregarALista(db, 'distribuidoresRegistry', [nombre]);
  if (p.vendedor && !lista(d.vendedoresRegistry).includes(p.vendedor)) {
    const vr = (await db.ref('casaDoradaDatos/vendedoresRegistry').once('value')).val();
    if (!lista(vr).includes(p.vendedor)) await agregarALista(db, 'vendedoresRegistry', [p.vendedor]);
  }
  const pedido = armarPedidos(catalogo, await leerDatos(db)).find((x) => x.id === id);
  return { creado: true, pedido };
}

function filtrarPedidos(pedidos, q) {
  const k = q.cliente ? clienteKey(q.cliente) : '';
  return pedidos.filter((x) => {
    if (k && !clienteKey(x.cliente).includes(k)) return false;
    if (q.estado && x.estado !== q.estado) return false;
    if (q.vendedor && clienteKey(x.vendedor) !== clienteKey(q.vendedor)) return false;
    if (q.desde && !(x.fecha && FECHA.test(x.fecha) && x.fecha >= q.desde)) return false;
    if (q.hasta && !(x.fecha && FECHA.test(x.fecha) && x.fecha <= q.hasta)) return false;
    return true;
  });
}

// Compara la clave que manda la otra app con el SHA-256 guardado (nunca la clave misma).
function claveValida(clave, hashEsperado) {
  if (!clave || !hashEsperado || !/^[0-9a-f]{64}$/i.test(hashEsperado)) return false;
  const a = crypto.createHash('sha256').update(String(clave), 'utf8').digest();
  return crypto.timingSafeEqual(a, Buffer.from(hashEsperado, 'hex'));
}

// Enrutador: /productos, /pedidos, /pedidos/{id}
async function atender({ db, catalogo, metodo, ruta, query, body }) {
  const partes = String(ruta || '/').split('/').filter(Boolean).map(decodeURIComponent);
  if (partes[0] === 'productos' && partes.length === 1 && metodo === 'GET') {
    return { status: 200, json: { productos: productos(catalogo, await leerDatos(db)) } };
  }
  if (partes[0] === 'pedidos' && partes.length === 1 && metodo === 'GET') {
    for (const c of ['desde', 'hasta']) if (query[c] && !FECHA.test(query[c])) throw new ErrorApi(400, `"${c}" debe tener el formato AAAA-MM-DD.`);
    if (query.estado && !['pendiente', 'entregado', 'sin_productos'].includes(query.estado)) throw new ErrorApi(400, '"estado" puede ser pendiente, entregado o sin_productos.');
    const pedidos = filtrarPedidos(armarPedidos(catalogo, await leerDatos(db)), query);
    return { status: 200, json: { total: pedidos.length, pedidos } };
  }
  if (partes[0] === 'pedidos' && partes.length === 2 && metodo === 'GET') {
    const pedido = armarPedidos(catalogo, await leerDatos(db)).find((x) => x.id === partes[1]);
    if (!pedido) throw new ErrorApi(404, 'No existe ese pedido.');
    return { status: 200, json: { pedido } };
  }
  if (partes[0] === 'pedidos' && partes.length === 1 && metodo === 'POST') {
    const r = await crearPedido({ db, catalogo, body });
    return { status: r.creado ? 201 : 200, json: r };
  }
  throw new ErrorApi(404, 'Ruta no encontrada. Usa GET /productos, GET /pedidos, GET /pedidos/{id} o POST /pedidos.');
}

module.exports = { atender, armarPedidos, productos, crearPedido, claveValida, ErrorApi, clienteKey };
