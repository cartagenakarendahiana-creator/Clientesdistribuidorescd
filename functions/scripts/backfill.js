// Carga el histórico de facturas de Siigo en Firebase, mes por mes.
//
// Uso (desde la carpeta functions/):
//   SIIGO_USERNAME=... SIIGO_ACCESS_KEY=... SIIGO_PARTNER_ID=... \
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json \
//   npm run backfill -- 2026-01-01 2026-09-30

const admin = require('firebase-admin');
const { SiigoClient } = require('../siigo');
const { sincronizar, sumarDias } = require('../sync');

async function main() {
  const [desde, hasta] = process.argv.slice(2);
  const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!esFecha(desde) || !esFecha(hasta) || desde > hasta) {
    console.error('Uso: npm run backfill -- AAAA-MM-DD AAAA-MM-DD');
    process.exit(1);
  }
  admin.initializeApp({ databaseURL: 'https://pedidos-nuevo-default-rtdb.firebaseio.com' });
  const client = new SiigoClient({
    username: process.env.SIIGO_USERNAME,
    accessKey: process.env.SIIGO_ACCESS_KEY,
    partnerId: process.env.SIIGO_PARTNER_ID,
  });
  // Tramos de un mes para no armar actualizaciones demasiado grandes.
  for (let ini = desde; ini <= hasta; ) {
    const finMes = sumarDias(`${ini.slice(0, 7)}-01`, 32).slice(0, 7) + '-01';
    const fin = sumarDias(finMes, -1) < hasta ? sumarDias(finMes, -1) : hasta;
    await sincronizar({ client, db: admin.database(), desde: ini, hasta: fin });
    ini = sumarDias(fin, 1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
