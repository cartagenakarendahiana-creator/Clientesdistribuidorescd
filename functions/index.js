// Funciones en la nube de Casa Dorada.
//
// Credenciales (nunca en el código ni en index.html). Se configuran una vez con:
//   firebase functions:secrets:set SIIGO_USERNAME
//   firebase functions:secrets:set SIIGO_ACCESS_KEY
//   firebase functions:secrets:set SIIGO_PARTNER_ID

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { SiigoClient } = require('./siigo');
const pedidosApi = require('./pedidos');
const { sincronizar, avanzarHistorico: avanzarHistoricoCon, avanzarNotasCreditoHistorico, hoyColombia, sumarDias } = require('./sync');

admin.initializeApp();

const SIIGO_USERNAME = defineSecret('SIIGO_USERNAME');
const SIIGO_ACCESS_KEY = defineSecret('SIIGO_ACCESS_KEY');
const SIIGO_PARTNER_ID = defineSecret('SIIGO_PARTNER_ID');

// Días hacia atrás que se vuelven a leer en cada corrida, para recoger facturas
// elaboradas con fecha anterior o editadas después.
const DIAS_ATRAS = 3;

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
    try {
      await avanzarNotasCreditoHistorico({ client, db: admin.database(), tiempoMaxMs: 120000 });
    } catch (err) {
      console.error('Siigo notas crédito históricas:', err);
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

// API de pedidos para conectar otras apps (ver functions/README.md → "API de pedidos").
// La clave NO está aquí: el workflow de publicación guarda solo su SHA-256 (del secreto de GitHub
// API_PEDIDOS_CLAVE) en API_PEDIDOS_CLAVE_HASH. Sin ese secreto la API responde 503.
const API_PEDIDOS_CLAVE_HASH = defineString('API_PEDIDOS_CLAVE_HASH', { default: '' });
let catalogo = null;
exports.apiPedidos = onRequest({ cors: false, maxInstances: 2, timeoutSeconds: 60 }, async (req, res) => {
  try {
    const hash = API_PEDIDOS_CLAVE_HASH.value();
    if (!hash) throw new pedidosApi.ErrorApi(503, 'La API de pedidos no está activada todavía.');
    const clave = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!pedidosApi.claveValida(clave, hash)) throw new pedidosApi.ErrorApi(401, 'Clave de la API incorrecta (encabezado Authorization: Bearer <clave>).');
    catalogo = catalogo || require('./catalogo.json');
    const r = await pedidosApi.atender({
      db: admin.database(), catalogo, metodo: req.method, ruta: req.path, query: req.query || {}, body: req.body,
    });
    res.status(r.status).json({ ok: true, ...r.json });
  } catch (err) {
    if (err instanceof pedidosApi.ErrorApi) {
      res.status(err.status).json({ ok: false, mensaje: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ ok: false, mensaje: 'Error del servidor. Intenta de nuevo.' });
  }
});
