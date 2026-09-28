// Funciones en la nube de Casa Dorada.
//
// Credenciales (nunca en el código ni en index.html). Se configuran una vez con:
//   firebase functions:secrets:set SIIGO_USERNAME
//   firebase functions:secrets:set SIIGO_ACCESS_KEY
//   firebase functions:secrets:set SIIGO_PARTNER_ID

const { onSchedule } = require('firebase-functions/v2/scheduler');
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

// Cada 2 horas entre 6 a.m. y 8 p.m. (hora Colombia): el avance del día se ve casi en tiempo real.
exports.sincronizarSiigo = onSchedule(
  {
    schedule: '0 6-20/2 * * *',
    timeZone: 'America/Bogota',
    secrets: [SIIGO_USERNAME, SIIGO_ACCESS_KEY, SIIGO_PARTNER_ID],
    timeoutSeconds: 540,
    retryCount: 1,
  },
  async () => {
    const client = new SiigoClient({
      username: SIIGO_USERNAME.value(),
      accessKey: SIIGO_ACCESS_KEY.value(),
      partnerId: SIIGO_PARTNER_ID.value(),
    });
    const hasta = hoyColombia();
    await sincronizar({ client, db: admin.database(), desde: sumarDias(hasta, -DIAS_ATRAS), hasta });
  }
);
