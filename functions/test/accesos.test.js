const test = require('node:test');
const assert = require('node:assert');
const { migrarAcceso, gestionarUsuarios, emailDe, hashLegado, ErrorAcceso } = require('../accesos');

function dbFalsa(inicial = {}) {
  const datos = structuredClone(inicial);
  const ref = (ruta = '') => ({
    once: async () => ({ val: () => ruta.split('/').filter(Boolean).reduce((o, k) => (o ? o[k] : undefined), datos) ?? null }),
    update: async (cambios) => {
      for (const [k, v] of Object.entries(cambios)) {
        const partes = [...ruta.split('/'), ...k.split('/')].filter(Boolean);
        let o = datos;
        for (const p of partes.slice(0, -1)) o = o[p] ||= {};
        if (v === null) delete o[partes.at(-1)]; else o[partes.at(-1)] = v;
      }
    },
  });
  return { datos, ref };
}

// Firebase Auth falso: cuentas por uid, tokens = "tok:<uid>".
function authFalso() {
  const cuentas = {};
  let n = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    cuentas,
    async createUser({ email, password }) {
      if (Object.values(cuentas).some((c) => c.email === email)) throw err('auth/email-already-exists');
      const uid = 'uid' + (++n);
      cuentas[uid] = { email, password };
      return { uid };
    },
    async updateUser(uid, { password }) {
      if (!cuentas[uid]) throw err('auth/user-not-found');
      cuentas[uid].password = password;
    },
    async getUserByEmail(email) {
      const uid = Object.keys(cuentas).find((u) => cuentas[u].email === email);
      if (!uid) throw err('auth/user-not-found');
      return { uid };
    },
    async deleteUser(uid) { delete cuentas[uid]; },
    async setCustomUserClaims(uid, claims) { cuentas[uid].claims = claims; },
    async verifyIdToken(t) {
      const uid = String(t).replace('tok:', '');
      if (!cuentas[uid]) throw err('auth/invalid-id-token');
      return { uid };
    },
  };
}

const tokenDe = (auth, usuario) => 'tok:' + Object.keys(auth.cuentas).find((u) => auth.cuentas[u].email === emailDe(usuario));

function baseLegada() {
  return dbFalsa({
    casaDoradaDatos: {
      clientes: { a: 1 },
      auth: { usuario: 'admin', salt: 's1', hash: hashLegado('s1', 'Clave123') },
      usuarios: [{ usuario: 'maria', rol: 'trabajador', salt: 's2', hash: hashLegado('s2', 'maria123'), activo: true }],
    },
  });
}

test('el primer ingreso migra los usuarios al nodo privado y crea la cuenta con la misma contraseña', async () => {
  const db = baseLegada(), auth = authFalso();
  await migrarAcceso({ db, auth, usuario: 'admin', clave: 'Clave123' });
  assert.equal(db.datos.casaDoradaDatos.auth, undefined, 'ya no queda la contraseña cifrada a la vista');
  assert.equal(db.datos.casaDoradaDatos.usuarios, undefined);
  assert.deepEqual(db.datos.casaDoradaDatos.clientes, { a: 1 }, 'no toca los demás datos');
  const admin = Object.values(db.datos.accesos.usuarios).find((x) => x.usuario === 'admin');
  assert.equal(admin.rol, 'admin');
  assert.ok(admin.uid && !admin.hash && !admin.salt, 'migrado: sin la contraseña vieja');
  assert.equal(auth.cuentas[admin.uid].password, 'Clave123');
  assert.equal(auth.cuentas[admin.uid].email, emailDe('admin'));
  assert.deepEqual(db.datos.accesos.uids[admin.uid], { usuario: 'admin', rol: 'admin' });
  assert.deepEqual(auth.cuentas[admin.uid].claims, { rol: 'admin', usuario: 'admin' });
  const maria = Object.values(db.datos.accesos.usuarios).find((x) => x.usuario === 'maria');
  assert.ok(maria.hash && !maria.uid, 'maria espera su primer ingreso');
});

test('contraseña equivocada o usuario ya migrado no crean cuentas', async () => {
  const db = baseLegada(), auth = authFalso();
  await assert.rejects(migrarAcceso({ db, auth, usuario: 'maria', clave: 'mala' }), (e) => e instanceof ErrorAcceso && e.status === 401);
  await migrarAcceso({ db, auth, usuario: 'maria', clave: 'maria123' });
  // Ya migrada: la contraseña vieja no sirve para reescribir la cuenta.
  await assert.rejects(migrarAcceso({ db, auth, usuario: 'maria', clave: 'maria123' }), (e) => e.status === 401);
  await assert.rejects(migrarAcceso({ db, auth, usuario: 'nadie', clave: 'x' }), (e) => e.status === 401);
  assert.equal(Object.keys(auth.cuentas).length, 1);
});

test('una segunda migración no pisa al administrador ya migrado', async () => {
  const db = baseLegada(), auth = authFalso();
  await migrarAcceso({ db, auth, usuario: 'admin', clave: 'Clave123' });
  delete db.datos.accesos.migrado; // como si otra llamada simultánea no hubiera visto la marca
  await migrarAcceso({ db, auth, usuario: 'maria', clave: 'maria123' });
  const admin = Object.values(db.datos.accesos.usuarios).find((x) => x.usuario === 'admin');
  assert.ok(admin.uid, 'sigue migrado');
  await assert.rejects(migrarAcceso({ db, auth, usuario: 'admin', clave: 'CasaDorada2026' }), (e) => e.status === 401);
});

test('administración de usuarios: solo administradores, crear, cambiar clave y eliminar', async () => {
  const db = baseLegada(), auth = authFalso();
  await migrarAcceso({ db, auth, usuario: 'admin', clave: 'Clave123' });
  await migrarAcceso({ db, auth, usuario: 'maria', clave: 'maria123' });
  const tAdmin = tokenDe(auth, 'admin'), tMaria = tokenDe(auth, 'maria');

  await assert.rejects(gestionarUsuarios({ db, auth, idToken: tMaria, accion: 'listar' }), (e) => e.status === 403);
  await assert.rejects(gestionarUsuarios({ db, auth, idToken: null, accion: 'listar' }), (e) => e.status === 401);

  await gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'crear', usuario: 'reportes', clave: 'lectura1', rol: 'lector' });
  await assert.rejects(gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'crear', usuario: 'reportes', clave: 'otra123', rol: 'lector' }), (e) => e.status === 409);
  await assert.rejects(gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'crear', usuario: 'x', clave: '123', rol: 'admin' }), (e) => e.status === 400);
  const { usuarios } = await gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'listar' });
  assert.deepEqual(usuarios.map((u) => `${u.usuario}:${u.rol}`), ['admin:admin', 'maria:trabajador', 'reportes:lector']);

  await gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'clave', usuario: 'maria', clave: 'nueva123' });
  assert.equal(auth.cuentas[tMaria.slice(4)].password, 'nueva123');

  await assert.rejects(gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'eliminar', usuario: 'admin' }), (e) => e.status === 400);
  await gestionarUsuarios({ db, auth, idToken: tAdmin, accion: 'eliminar', usuario: 'maria' });
  assert.equal(auth.cuentas[tMaria.slice(4)], undefined);
  assert.equal(db.datos.accesos.uids[tMaria.slice(4)], undefined, 'las reglas ya no la dejan entrar');
  await assert.rejects(gestionarUsuarios({ db, auth, idToken: tMaria, accion: 'listar' }), (e) => e.status === 401);
});
