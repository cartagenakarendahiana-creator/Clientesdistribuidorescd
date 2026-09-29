// Funciones en la nube de Casa Dorada.
//
// Credenciales (nunca en el código ni en index.html). Se configuran una vez con:
//   firebase functions:secrets:set SIIGO_USERNAME
//   firebase functions:secrets:set SIIGO_ACCESS_KEY
//   firebase functions:secrets:set SIIGO_PARTNER_ID

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { SiigoClient } = require('./siigo');
const { sincronizar, hoyColombia, sumarDias } = require('./sync');

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

function sincronizarUltimosDias() {
  const client = new SiigoClient({
    username: SIIGO_USERNAME.value(),
    accessKey: SIIGO_ACCESS_KEY.value(),
    partnerId: SIIGO_PARTNER_ID.value(),
  });
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
    await sincronizarUltimosDias();
  }
);

// Botón "Sincronizar ahora" de la sección Ventas Siigo. No recibe datos: solo dispara la misma
// sincronización de los últimos días, como máximo una vez por minuto.
exports.sincronizarSiigoAhora = onRequest(
  { cors: true, secrets: SECRETOS, timeoutSeconds: 300, maxInstances: 1 },
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
      const r = await sincronizarUltimosDias();
      res.json({ ok: true, mensaje: `${r.facturas} facturas sincronizadas.`, ...r });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, mensaje: String(err.message || err) });
    }
  }
);
