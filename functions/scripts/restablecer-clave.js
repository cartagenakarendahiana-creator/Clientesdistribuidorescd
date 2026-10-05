// Pone una contraseña nueva a un usuario de la app y prueba que con ella se pueda entrar.
// Lo usa el workflow "Restablecer contraseña de un usuario" (la clave llega por el secreto de GitHub
// CLAVE_RESTABLECER; nunca se imprime).
//
//   GOOGLE_APPLICATION_CREDENTIALS=... CLAVE_RESTABLECER=... node scripts/restablecer-clave.js admin

const admin = require('firebase-admin');
const { asegurarAccesos, guardarCuenta, claveDe, emailDe } = require('../accesos');

const API_KEY = 'AIzaSyBj9rIuZdFCff0GoEUweLGEx9MRJ-CX9uc';
const SITIO = 'https://pedidodistribuidores.netlify.app/';

async function main() {
  const usuario = String(process.argv[2] || '').trim();
  const clave = process.env.CLAVE_RESTABLECER || '';
  if (!usuario) throw new Error('Falta el usuario.');
  if (clave.length < 6) throw new Error('El secreto CLAVE_RESTABLECER no existe o tiene menos de 6 caracteres.');
  admin.initializeApp({ databaseURL: 'https://pedidos-nuevo-default-rtdb.firebaseio.com' });
  const db = admin.database(), auth = admin.auth();
  await asegurarAccesos(db);
  const c = claveDe(usuario);
  const x = (await db.ref(`accesos/usuarios/${c}`).once('value')).val();
  if (!x || x.activo === false) {
    const lista = Object.values((await db.ref('accesos/usuarios').once('value')).val() || {}).filter(Boolean).map((u) => u.usuario);
    throw new Error(`No existe el usuario "${usuario}". Usuarios guardados: ${lista.join(', ') || '(ninguno)'}`);
  }
  console.log(`::notice::Usuario "${x.usuario}" (${x.rol}). Cuenta de Firebase antes: ${x.uid ? 'sí' : 'no (aún no había entrado)'}.`);
  await guardarCuenta({ db, auth, c, x, clave });
  console.log('Contraseña nueva guardada.');

  // Prueba de ingreso igual que la app (con el sitio como origen, por si la clave de API tiene restricciones).
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: SITIO, Origin: SITIO.slice(0, -1) },
    body: JSON.stringify({ email: emailDe(x.usuario), password: clave, returnSecureToken: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.idToken) console.log(`::notice::Prueba de ingreso OK: "${x.usuario}" ya puede entrar con la contraseña nueva.`);
  else {
    console.log(`::error::Prueba de ingreso FALLÓ: ${(j.error && j.error.message) || 'HTTP ' + r.status}`);
    process.exitCode = 1;
  }
}

// firebase-admin deja la conexión abierta: se cierra el proceso al terminar.
main().then(() => process.exit(process.exitCode || 0)).catch((err) => { console.error('::error::' + err.message); process.exit(1); });
