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
const { sincronizar, avanzarHistorico: avanzarHistoricoCon, avanzarNotasCreditoHistorico, hoyColombia, sumarDias } = require('./sync');
const accesos = require('./accesos');

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

const tokenDe = (req) => String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '') || null;
function responderError(res, err) {
  if (err instanceof accesos.ErrorAcceso) {
    res.status(err.status).json({ ok: false, mensaje: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ ok: false, mensaje: 'Error del servidor. Intenta de nuevo.' });
}

// Botón "Sincronizar ahora" de la sección Ventas Siigo (solo administradores con sesión iniciada).
// No recibe datos: solo dispara la misma sincronización de los últimos días, como máximo una vez por minuto.
exports.sincronizarSiigoAhora = onRequest(
  { cors: true, secrets: SECRETOS, timeoutSeconds: 540, maxInstances: 1 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, mensaje: 'Usa POST.' });
      return;
    }
    try {
      const yo = await accesos.usuarioDelToken({ db: admin.database(), auth: admin.auth(), idToken: tokenDe(req) });
      if (yo.rol !== 'admin') throw new accesos.ErrorAcceso(403, 'Solo un administrador puede sincronizar.');
    } catch (err) {
      responderError(res, err);
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

// Primer ingreso de cada usuario después de pasar a Firebase Authentication: valida la contraseña de
// antes y le crea su cuenta. Después de eso la app entra directo con Firebase.
exports.migrarAcceso = onRequest({ cors: true, maxInstances: 2 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, mensaje: 'Usa POST.' });
    return;
  }
  try {
    const { usuario, clave } = req.body || {};
    res.json(await accesos.migrarAcceso({ db: admin.database(), auth: admin.auth(), usuario, clave }));
  } catch (err) {
    responderError(res, err);
  }
});

// Ventana "Usuarios" de la app (solo administradores).
exports.gestionarUsuarios = onRequest({ cors: true, maxInstances: 2 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, mensaje: 'Usa POST.' });
    return;
  }
  try {
    const { accion, usuario, clave, rol } = req.body || {};
    res.json(await accesos.gestionarUsuarios({ db: admin.database(), auth: admin.auth(), idToken: tokenDe(req), accion, usuario, clave, rol }));
  } catch (err) {
    responderError(res, err);
  }
});
