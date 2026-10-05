// Accesos de Casa Dorada con Firebase Authentication.
//
// Cada usuario de la app (ej. "maria") es una cuenta de Firebase Auth con un correo interno que nadie
// usa para escribir: u<40 letras del SHA-256 del usuario>@usuarios.casadorada.app. La app calcula el
// mismo correo y entra con la contraseña de siempre.
//
// Lo privado vive en el nodo `accesos/` (las reglas no dejan leerlo desde la app):
//   accesos/usuarios/{clave} = { usuario, rol, activo, uid, principal?, salt?, hash?, password? }
//   accesos/uids/{uid}       = { usuario, rol }   ← lo que miran las reglas; cada quien lee solo el suyo
// salt/hash (o password, si nunca se cifró) son la contraseña de antes: sirven una sola vez para crear la
// cuenta de Firebase la primera vez que esa persona entra, y luego se borran.

const crypto = require('crypto');

const DOMINIO = 'usuarios.casadorada.app';
const ROLES = ['admin', 'trabajador', 'lector'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const claveDe = (usuario) => sha256(String(usuario).trim()).slice(0, 40);
const emailDe = (usuario) => `u${claveDe(usuario)}@${DOMINIO}`;
// Mismo cifrado que usaba la app (hashClave en index.html).
const hashLegado = (salt, clave) => sha256(String(salt) + '|' + String(clave));

class ErrorAcceso extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

// La primera vez copia los usuarios que estaban dentro de casaDoradaDatos (visibles para cualquiera) al
// nodo privado y los borra de allí.
async function asegurarAccesos(db) {
  const migrado = (await db.ref('accesos/migrado').once('value')).val();
  if (migrado) return;
  const [auth, usuarios, existentes] = await Promise.all([
    db.ref('casaDoradaDatos/auth').once('value').then((s) => s.val()),
    db.ref('casaDoradaDatos/usuarios').once('value').then((s) => s.val()),
    db.ref('accesos/usuarios').once('value').then((s) => s.val() || {}),
  ]);
  const updates = {};
  const agregar = (x, extra) => {
    if (!x || !x.usuario) return;
    const c = claveDe(x.usuario);
    if (updates[`accesos/usuarios/${c}`] || existentes[c]) return; // nunca pisa un usuario ya migrado
    const fila = { usuario: String(x.usuario).trim(), activo: x.activo !== false, ...extra };
    if (x.hash) { fila.salt = x.salt || ''; fila.hash = x.hash; } else if (x.password) fila.password = String(x.password);
    updates[`accesos/usuarios/${c}`] = fila;
  };
  // Sin administrador guardado (base nueva) queda el de fábrica de la app; nunca si ya hay usuarios migrados.
  if (auth) agregar(auth, { rol: 'admin', principal: true });
  else if (!Object.keys(existentes).length) agregar({ usuario: 'admin', password: 'CasaDorada2026' }, { rol: 'admin', principal: true });
  const lista = Array.isArray(usuarios) ? usuarios : Object.values(usuarios || {});
  lista.forEach((x) => x && agregar(x, { rol: ROLES.includes(x.rol) ? x.rol : 'trabajador' }));
  updates['accesos/migrado'] = new Date().toISOString();
  updates['casaDoradaDatos/auth'] = null;
  updates['casaDoradaDatos/usuarios'] = null;
  await db.ref().update(updates);
}

async function leerUsuario(db, usuario) {
  const c = claveDe(usuario);
  return { c, x: (await db.ref(`accesos/usuarios/${c}`).once('value')).val() };
}

// Crea (o actualiza) la cuenta de Firebase de un usuario con esa contraseña y deja su rol para las reglas.
async function guardarCuenta({ db, auth, c, x, clave }) {
  const email = emailDe(x.usuario);
  let uid = x.uid;
  if (uid) {
    try { await auth.updateUser(uid, { password: clave, disabled: false }); } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      uid = null;
    }
  }
  if (!uid) {
    try { uid = (await auth.createUser({ email, password: clave, displayName: x.usuario })).uid; } catch (err) {
      if (err.code !== 'auth/email-already-exists') throw err;
      uid = (await auth.getUserByEmail(email)).uid;
      await auth.updateUser(uid, { password: clave, disabled: false });
    }
  }
  // El rol viaja en la sesión (la app lo lee de ahí); las reglas además lo confirman en accesos/uids.
  await auth.setCustomUserClaims(uid, { rol: x.rol, usuario: x.usuario });
  await db.ref().update({
    [`accesos/usuarios/${c}`]: { usuario: x.usuario, rol: x.rol, activo: true, uid, ...(x.principal ? { principal: true } : {}), creado: x.creado || new Date().toISOString() },
    [`accesos/uids/${uid}`]: { usuario: x.usuario, rol: x.rol },
  });
  return uid;
}

// Primer ingreso después del cambio: valida la contraseña de antes y crea la cuenta de Firebase.
async function migrarAcceso({ db, auth, usuario, clave }) {
  usuario = String(usuario || '').trim();
  clave = String(clave || '');
  if (!usuario || !clave) throw new ErrorAcceso(400, 'Escribe usuario y contraseña.');
  await asegurarAccesos(db);
  const { c, x } = await leerUsuario(db, usuario);
  const legado = x && x.activo !== false && !x.uid && (x.hash ? hashLegado(x.salt, clave) === x.hash : (x.password !== undefined && x.password === clave));
  if (!legado) throw new ErrorAcceso(401, 'Usuario o contraseña incorrectos.');
  await guardarCuenta({ db, auth, c, x, clave });
  return { ok: true };
}

async function usuarioDelToken({ db, auth, idToken }) {
  if (!idToken) throw new ErrorAcceso(401, 'Inicia sesión otra vez.');
  let dec;
  try { dec = await auth.verifyIdToken(idToken); } catch (err) { throw new ErrorAcceso(401, 'La sesión venció: inicia sesión otra vez.'); }
  const yo = (await db.ref(`accesos/uids/${dec.uid}`).once('value')).val();
  if (!yo) throw new ErrorAcceso(403, 'Este usuario ya no tiene acceso.');
  return { uid: dec.uid, ...yo };
}

// Usuarios (solo administradores): listar, crear, cambiar contraseña, eliminar.
async function gestionarUsuarios({ db, auth, idToken, accion, usuario, clave, rol }) {
  const yo = await usuarioDelToken({ db, auth, idToken });
  if (yo.rol !== 'admin') throw new ErrorAcceso(403, 'Solo un administrador puede manejar usuarios.');
  await asegurarAccesos(db);
  const todos = (await db.ref('accesos/usuarios').once('value')).val() || {};
  if (accion === 'listar') {
    const usuarios = Object.values(todos)
      .filter((x) => x && x.activo !== false)
      .map((x) => ({ usuario: x.usuario, rol: x.rol, principal: !!x.principal, pendiente: !x.uid }))
      .sort((a, b) => (b.principal - a.principal) || a.usuario.localeCompare(b.usuario));
    return { ok: true, usuarios };
  }
  usuario = String(usuario || '').trim();
  if (!usuario) throw new ErrorAcceso(400, 'Escribe el usuario.');
  const { c, x } = await leerUsuario(db, usuario);
  if (accion === 'crear') {
    if (x && x.activo !== false) throw new ErrorAcceso(409, 'Ese usuario ya existe.');
    if (!ROLES.includes(rol)) throw new ErrorAcceso(400, 'Rol no válido.');
    if (String(clave || '').length < 6) throw new ErrorAcceso(400, 'La contraseña debe tener mínimo 6 caracteres.');
    await guardarCuenta({ db, auth, c, x: { usuario, rol, uid: x && x.uid }, clave: String(clave) });
    return { ok: true };
  }
  if (!x || x.activo === false) throw new ErrorAcceso(404, 'Ese usuario no existe.');
  if (accion === 'clave') {
    if (String(clave || '').length < 6) throw new ErrorAcceso(400, 'La contraseña debe tener mínimo 6 caracteres.');
    await guardarCuenta({ db, auth, c, x, clave: String(clave) });
    return { ok: true };
  }
  if (accion === 'eliminar') {
    if (x.principal) throw new ErrorAcceso(400, 'El administrador principal no se puede eliminar.');
    if (x.uid && x.uid === yo.uid) throw new ErrorAcceso(400, 'No te puedes eliminar a ti mismo.');
    if (x.uid) {
      try { await auth.deleteUser(x.uid); } catch (err) { if (err.code !== 'auth/user-not-found') throw err; }
    }
    await db.ref().update({ [`accesos/usuarios/${c}`]: null, ...(x.uid ? { [`accesos/uids/${x.uid}`]: null } : {}) });
    return { ok: true };
  }
  throw new ErrorAcceso(400, 'Acción no válida.');
}

module.exports = { guardarCuenta, emailDe, claveDe, hashLegado, asegurarAccesos, migrarAcceso, gestionarUsuarios, usuarioDelToken, ErrorAcceso, ROLES };
