// Funciones en la nube de Casa Dorada.
//
// Credenciales (nunca en el código ni en index.html). Se configuran una vez con:
//   firebase functions:secrets:set SIIGO_USERNAME
//   firebase functions:secrets:set SIIGO_ACCESS_KEY
//   firebase functions:secrets:set SIIGO_PARTNER_ID
//   firebase functions:secrets:set FACTURACION_CLAVE   (clave que se pide en la app para facturar)

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { SiigoClient } = require('./siigo');
const { sincronizar, avanzarHistorico: avanzarHistoricoCon, hoyColombia, sumarDias } = require('./sync');
const { facturarDespacho, verificarClave, ErrorUsuario } = require('./facturar');

admin.initializeApp();

const SIIGO_USERNAME = defineSecret('SIIGO_USERNAME');
const SIIGO_ACCESS_KEY = defineSecret('SIIGO_ACCESS_KEY');
const SIIGO_PARTNER_ID = defineSecret('SIIGO_PARTNER_ID');

// Días hacia atrás que se vuelven a leer en cada corrida, para recoger facturas
// elaboradas con fecha anterior o editadas después.
const DIAS_ATRAS = 3;

const FACTURACION_CLAVE = defineSecret('FACTURACION_CLAVE');

const SECRETOS = [SIIGO_USERNAME, SIIGO_ACCESS_KEY, SIIGO_PARTNER_ID];

// Espera mínima entre dos sincronizaciones pedidas con el botón de la app.
const ESPERA_MANUAL_MS = 60 * 1000;

function nuevoCliente() {
  return new SiigoClient({
    username: SIIGO_USERNAME.value(),
    accessKey: SIIGO_ACCESS_KEY.value(),
    partnerId: SIIGO_PARTNER_ID.value(),
  });
}

function avanzarHistorico({ client = nuevoCliente(), tiempoMaxMs } = {}) {
  return avanzarHistoricoCon({ client, db: admin.database(), tiempoMaxMs });
}

function sincronizarUltimosDias(client = nuevoCliente()) {
  const hasta = hoyColombia();
  return sincronizar({ client, db: admin.database(), desde: sumarDias(hasta, -DIAS_ATRAS), hasta });
}

// Cada 30 minutos entre 6:00 a.m. y 9:30 p.m. (hora Colombia): las ventas del día se ven casi al momento.
exports.sincronizarSiigo = onSchedule(
  {
    schedule: '*/30 6-21 * * *',
    timeZone: 'America/Bogota',
    secrets: SECRETOS,
    timeoutSeconds: 540,
    retryCount: 1,
  },
  async () => {
    const client = nuevoCliente();
    await sincronizarUltimosDias(client);
    try {
      await avanzarHistorico({ client, tiempoMaxMs: 300000 });
    } catch (err) {
      console.error('Siigo histórico:', err); // no afecta la sincronización del día
    }
  }
);

// Botón "Sincronizar ahora" de la sección Ventas Siigo. No recibe datos: solo dispara la misma
// sincronización de los últimos días, como máximo una vez por minuto.
exports.sincronizarSiigoAhora = onRequest(
  { cors: true, secrets: SECRETOS, timeoutSeconds: 540, maxInstances: 1 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, mensaje: 'Usa POST.' });
      return;
    }
    const estado = (await admin.database().ref('siigo/estado').once('value')).val() || {};
    const ultima = Date.parse(estado.ultimaSincronizacion || '') || 0;
    if (Date.now() - ultima < ESPERA_MANUAL_MS) {
      res.json({ ok: true, mensaje: 'Ya se sincronizó hace menos de un minuto.' });
      return;
    }
    try {
      const client = nuevoCliente();
      const r = await sincronizarUltimosDias(client);
      let h = null;
      try {
        h = await avanzarHistorico({ client, tiempoMaxMs: 150000 });
      } catch (err) {
        console.error('Siigo histórico:', err);
      }
      const extra = h && !h.completo && h.cargadoDesde ? ` Histórico cargado desde ${h.cargadoDesde.slice(0, 7)}; sigue cargando.` : '';
      res.json({ ok: true, mensaje: `${r.facturas} facturas sincronizadas.${extra}`, ...r });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, mensaje: String(err.message || err) });
    }
  }
);

// Opciones para configurar la facturación desde la app: tipos de factura, formas de pago, impuestos,
// vendedores y centros de costo de Siigo. Solo lectura.
exports.siigoOpcionesFactura = onRequest(
  { cors: true, secrets: SECRETOS, timeoutSeconds: 120, maxInstances: 2 },
  async (req, res) => {
    try {
      const client = nuevoCliente();
      const [docs, pagos, impuestos, vendedores, centros] = await Promise.all([
        client.tiposDeFactura(), client.formasDePago(), client.impuestos(), client.vendedores(), client.centrosDeCosto(),
      ]);
      const arr = (v) => (Array.isArray(v) ? v : (v && v.results) || []);
      res.json({
        ok: true,
        documentos: arr(docs).filter((d) => d.active !== false).map((d) => ({ id: d.id, nombre: `${d.code || ''} ${d.name || ''}`.trim(), electronica: !!d.electronic_type })),
        pagos: arr(pagos).filter((p) => p.active !== false).map((p) => ({ id: p.id, nombre: p.name || '', tipo: p.type || '' })),
        impuestos: arr(impuestos).filter((t) => t.active !== false).map((t) => ({ id: t.id, nombre: t.name || '', tipo: t.type || '', porcentaje: Number(t.percentage) || 0 })),
        vendedores: arr(vendedores).filter((u) => u.active !== false).map((u) => ({ id: u.id, nombre: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '' })),
        centros: arr(centros).filter((c) => c.active !== false).map((c) => ({ id: c.id, nombre: `${c.code || ''} ${c.name || ''}`.trim() })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, mensaje: String(err.message || err) });
    }
  }
);

// Botón "Facturar en Siigo" del pedido de un cliente: crea en Siigo la factura de lo despachado ese día.
// Pide la clave de facturación (secreto FACTURACION_CLAVE), así nadie más puede crear facturas.
exports.facturarDespachoSiigo = onRequest(
  { cors: true, secrets: [...SECRETOS, FACTURACION_CLAVE], timeoutSeconds: 120, maxInstances: 1 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, mensaje: 'Usa POST.' });
      return;
    }
    const b = req.body || {};
    try {
      const db = admin.database();
      await verificarClave({ db, claveEsperada: FACTURACION_CLAVE.value(), claveRecibida: b.clave });
      const r = await facturarDespacho({
        client: nuevoCliente(), db, distId: b.distId, fecha: b.fecha, nit: b.nit, cliente: b.cliente,
        fechaHoy: hoyColombia(), forzar: b.forzar === true,
      });
      res.json({ ok: true, mensaje: `Factura ${r.numero} creada en Siigo.`, ...r });
    } catch (err) {
      if (err instanceof ErrorUsuario) {
        res.status(400).json({ ok: false, mensaje: err.message, requiereConfirmar: !!err.requiereConfirmar });
        return;
      }
      console.error(err);
      res.status(500).json({ ok: false, mensaje: String(err.message || err) });
    }
  }
);
