// Facturación en Siigo de lo despachado a un cliente en un día.
//
// La app guarda cada entrega en casaDoradaDatos/entregasLog/{pedido} (fecha, producto, cantidad,
// precio). Esta función toma las entregas de ese pedido y ese día que todavía no se han facturado,
// arma la factura con la configuración elegida en la app (tipo de factura, vendedor, forma de pago,
// impuesto) y el código de Siigo de cada producto, y la crea en Siigo.
//
// Lo que ya se facturó queda marcado en siigo/facturacionApp/{pedido}/entradas/{idEntrega}, fuera de
// los datos de la app, para que la app no lo pise al guardar.

const crypto = require('node:crypto');

// Mismo formato de claves que usa la app (encodeFirebaseKey en index.html).
const codificarClave = (k) => String(k).replace(/[%.#$/[\]]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const decodificarClave = (k) => String(k).replace(/%(25|2E|23|24|2F|5B|5D)/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const lista = (v) => (Array.isArray(v) ? v.filter(Boolean) : v && typeof v === 'object' ? Object.values(v).filter(Boolean) : []);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const claveProducto = (producto, medida) => [producto, medida].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');

const INTENTOS_MAX = 5;
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const BLOQUEO_MS = 3 * 60 * 1000;

// NIT sin dígito de verificación ni puntos (Siigo lo pide así).
function limpiarNit(nit) {
  const s = String(nit || '').trim();
  const sinDv = s.includes('-') ? s.slice(0, s.lastIndexOf('-')) : s;
  return sinDv.replace(/\D/g, '');
}

function sumarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function mismaClave(a, b) {
  const x = crypto.createHash('sha256').update(String(a || '')).digest();
  const y = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(x, y);
}

// Entregas de ese día aún sin facturar, sumadas por producto (una entrega corregida hacia abajo resta).
function itemsPendientes(entregas, fecha, facturadas) {
  const porClave = new Map();
  const ids = [];
  for (const e of lista(entregas)) {
    if (e.fecha !== fecha || !e.id || facturadas[e.id]) continue;
    const delta = Number(e.delta) || 0;
    if (!delta) continue;
    ids.push(e.id);
    const clave = claveProducto(e.producto, e.medida);
    const it = porClave.get(clave) || { clave, producto: e.producto || '', medida: e.medida || '', cantidad: 0, precio: Number(e.precio) || 0 };
    it.cantidad += delta;
    if (Number(e.precio) > 0) it.precio = Number(e.precio);
    porClave.set(clave, it);
  }
  return { items: [...porClave.values()].filter((i) => i.cantidad > 0), ids };
}

// Arma el cuerpo de la factura para la API de Siigo y el total que se cobra.
function construirFactura({ config, nit, items, codigos, fechaFactura, fechaDespacho, cliente }) {
  const faltan = [];
  if (!config || !config.documentoId) faltan.push('tipo de factura');
  if (!config || !config.vendedorId) faltan.push('vendedor');
  if (!config || !config.formaPagoId) faltan.push('forma de pago');
  if (faltan.length) throw new ErrorUsuario(`Falta configurar la facturación de Siigo: ${faltan.join(', ')}.`);
  const identificacion = limpiarNit(nit);
  if (!identificacion) throw new ErrorUsuario('El cliente no tiene NIT o cédula. Agrégalo antes de facturar.');
  if (!items.length) throw new ErrorUsuario('No hay entregas sin facturar para ese cliente en esa fecha.');
  const sinCodigo = items.filter((i) => !codigos[norm(i.clave)]);
  if (sinCodigo.length) throw new ErrorUsuario(`Estos productos no tienen código de Siigo asignado: ${sinCodigo.map((i) => i.clave).join('; ')}.`);
  const sinPrecio = items.filter((i) => !(i.precio > 0));
  if (sinPrecio.length) throw new ErrorUsuario(`Estos productos no tienen precio: ${sinPrecio.map((i) => i.clave).join('; ')}.`);

  const conIva = !!config.impuestoId;
  const iva = conIva ? (Number(config.ivaPct) || 0) / 100 : 0;
  let total = 0;
  const lineas = items.map((i) => {
    // Siigo recibe el precio SIN impuesto; si en la app el precio ya incluye IVA, se le quita.
    const precio = config.preciosIncluyenIva && iva ? Math.round((i.precio / (1 + iva)) * 1e6) / 1e6 : i.precio;
    const subtotal = r2(i.cantidad * precio);
    total += subtotal + (iva ? r2(subtotal * iva) : 0);
    const linea = { code: codigos[norm(i.clave)], description: i.clave, quantity: i.cantidad, price: precio, discount: 0 };
    if (conIva) linea.taxes = [{ id: Number(config.impuestoId) }];
    return linea;
  });
  total = r2(total);
  const factura = {
    document: { id: Number(config.documentoId) },
    date: fechaFactura,
    customer: { identification: identificacion, branch_office: 0 },
    seller: Number(config.vendedorId),
    stamp: { send: !!config.enviarDian },
    mail: { send: !!config.enviarCorreo },
    observations: `Despacho del ${fechaDespacho}${cliente ? ' · ' + cliente : ''} (creada desde la app Casa Dorada)`,
    items: lineas,
    payments: [{ id: Number(config.formaPagoId), value: total, due_date: sumarDias(fechaFactura, Number(config.diasCredito) || 0) }],
  };
  if (config.centroCostoId) factura.cost_center = Number(config.centroCostoId);
  return { factura, total };
}

class ErrorUsuario extends Error {}

// Revisa la clave de facturación con límite de intentos fallidos.
async function verificarClave({ db, claveEsperada, claveRecibida, ahora = Date.now() }) {
  if (!claveEsperada) throw new ErrorUsuario('La clave de facturación no está configurada en el servidor.');
  const ref = db.ref('siigo/facturacionIntentos');
  const reg = (await ref.once('value')).val() || {};
  const vigente = reg.desde && ahora - reg.desde < VENTANA_INTENTOS_MS;
  if (vigente && reg.fallidos >= INTENTOS_MAX) throw new ErrorUsuario('Demasiados intentos con clave incorrecta. Espera 15 minutos.');
  if (!mismaClave(claveRecibida, claveEsperada)) {
    await ref.set({ desde: vigente ? reg.desde : ahora, fallidos: (vigente ? reg.fallidos || 0 : 0) + 1 });
    throw new ErrorUsuario('Clave de facturación incorrecta.');
  }
}

// Factura en Siigo lo despachado a un pedido en una fecha. Devuelve { numero, total, items }.
async function facturarDespacho({ client, db, distId, fecha, nit, cliente, fechaHoy, forzar = false, ahora = Date.now() }) {
  if (!distId || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) throw new ErrorUsuario('Faltan el pedido o la fecha del despacho.');
  const dist = codificarClave(distId);
  const base = `siigo/facturacionApp/${dist}`;

  // Bloqueo para que dos clics (o dos equipos) no creen la misma factura dos veces.
  const bloqueo = await db.ref(`${base}/bloqueo`).transaction((actual) => {
    if (actual && ahora - (actual.desde || 0) < BLOQUEO_MS) return undefined; // ya hay una en curso
    return { desde: ahora, fecha };
  });
  if (!bloqueo.committed) throw new ErrorUsuario('Ya se está creando una factura para este cliente. Espera un momento.');

  try {
    // Si la vez anterior Siigo no respondió claro, puede que la factura sí se haya creado.
    const dudosa = (await db.ref(`${base}/dudosas/${fecha}`).once('value')).val();
    if (dudosa && !forzar) {
      const e = new ErrorUsuario(`El intento anterior (${dudosa.cuando || ''}) no tuvo respuesta clara de Siigo. Revisa en Siigo si esa factura se creó. Si NO se creó, confirma para intentar de nuevo.`);
      e.requiereConfirmar = true;
      throw e;
    }
    const [entregas, facturadas, config, mapa] = await Promise.all([
      db.ref(`casaDoradaDatos/entregasLog/${dist}`).once('value').then((s) => s.val()),
      db.ref(`${base}/entradas`).once('value').then((s) => s.val() || {}),
      db.ref('casaDoradaDatos/siigoFacturaConfig').once('value').then((s) => s.val()),
      db.ref('casaDoradaDatos/siigoProductoMap').once('value').then((s) => s.val() || {}),
    ]);
    const codigos = {};
    for (const [k, v] of Object.entries(mapa)) if (v) codigos[norm(decodificarClave(k))] = String(v);

    const { items, ids } = itemsPendientes(entregas, fecha, facturadas);
    const { factura, total } = construirFactura({ config, nit, items, codigos, fechaFactura: fechaHoy, fechaDespacho: fecha, cliente });

    let creada;
    try {
      creada = await client.crearFactura(factura);
    } catch (err) {
      // 4xx: Siigo rechazó la factura (no se creó). Otro error: no se sabe si se creó.
      if (err.status >= 400 && err.status < 500) throw new ErrorUsuario(`Siigo no aceptó la factura: ${err.message}`);
      await db.ref(`${base}/dudosas/${fecha}`).set({ cuando: new Date(ahora).toISOString(), mensaje: String(err.message || err) });
      throw new ErrorUsuario(`No hubo respuesta clara de Siigo (${err.message}). Revisa en Siigo si la factura se creó antes de volver a intentar.`);
    }
    const numero = creada.name || (creada.prefix ? `${creada.prefix}-${creada.number}` : String(creada.number || creada.id || ''));
    const idFactura = String(creada.id || numero);
    const updates = {};
    for (const id of ids) updates[`${base}/entradas/${codificarClave(id)}`] = { factura: idFactura, numero };
    updates[`${base}/dudosas/${fecha}`] = null;
    updates[`${base}/facturas/${codificarClave(idFactura)}`] = {
      numero, idSiigo: creada.id || null, fechaDespacho: fecha, fechaFactura: fechaHoy, total: Number(creada.total) || total,
      items: items.map((i) => ({ producto: i.clave, cantidad: i.cantidad, precio: i.precio })), creada: new Date(ahora).toISOString(),
    };
    await db.ref().update(updates);
    return { numero, total: Number(creada.total) || total, items: items.length };
  } finally {
    await db.ref(`${base}/bloqueo`).set(null);
  }
}

module.exports = { facturarDespacho, construirFactura, itemsPendientes, verificarClave, limpiarNit, codificarClave, ErrorUsuario };
