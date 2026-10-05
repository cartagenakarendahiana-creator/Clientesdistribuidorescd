# Casa Dorada · Conexión con Siigo

Función en la nube que lee las facturas de venta de Siigo y las guarda en Firebase,
listas para los tableros de metas, rankings y el informe diario con IA.

Corre sola **cada 30 minutos entre 6:00 a.m. y 9:30 p.m. (hora Colombia)** y vuelve a leer
las facturas creadas en los últimos 3 días. También se puede disparar con el botón
**"Sincronizar ahora"** de la sección *Clientes → Ventas Siigo* (máximo una vez por minuto).

> El filtro de fechas de la API de Siigo usa la fecha y hora de **creación** de la factura.
> Por eso se piden facturas con 2 días de margen y cada día se resume por la **fecha del documento**,
> incluyendo facturas elaboradas después con fecha anterior.

## Qué guarda en Firebase (nodo `siigo/`, aparte de los datos de la app)

| Ruta | Contenido |
|---|---|
| `siigo/facturasDia/{AAAA-MM-DD}/{id}` | Facturas por fecha: número, NIT del cliente, centro de costo, vendedor, total, saldo, ítems |
| `siigo/facturasIndice/{id}` | Fecha en la que quedó guardada cada factura |
| `siigo/resumenDiario/{AAAA-MM-DD}/global` | Ventas, # facturas y unidades del día (todos los centros) |
| `siigo/resumenDiario/{AAAA-MM-DD}/cc_{id}` | Lo mismo por centro de costo (`sin_centro` si la factura no tiene) |
| `.../productos/{código}`, `.../clientes/{nit}`, `.../vendedores/{id}` | Cantidad y valor por producto, cliente y vendedor, dentro de cada día y centro |
| `siigo/catalogos/...` | Centros de costo, vendedores, clientes y productos de Siigo |
| `siigo/estado` | Última sincronización y último error |
| `siigo/historico` | Hasta qué mes va cargado el histórico y si ya terminó |

No escribe en `casaDoradaDatos`.

## Publicar sin terminal (desde GitHub)

El repositorio trae el botón **Actions → "Publicar funciones de Siigo" → "Run workflow"**, que publica
las funciones desde GitHub. También se ejecuta solo cada vez que se une a `main` un cambio en `functions/`.
Necesita, una sola vez:

1. **Clave de Firebase:** en la consola de Firebase (proyecto `pedidos-nuevo`) → ⚙️ *Configuración del proyecto* →
   *Cuentas de servicio* → **Generar nueva clave privada**. Se descarga un archivo `.json`.
2. **Permisos de esa cuenta:** en [Google Cloud → IAM](https://console.cloud.google.com/iam-admin/iam?project=pedidos-nuevo),
   busca la cuenta `firebase-adminsdk-…@pedidos-nuevo.iam.gserviceaccount.com`, pulsa el lápiz y agrégale los roles
   **Editor**, **Cloud Functions Admin** (*Administrador de Cloud Functions*) y **Secret Manager Secret Accessor** (*Usuario con acceso a secretos de Secret Manager*).
3. **Secreto en GitHub:** en GitHub → *Settings* → *Secrets and variables* → *Actions* → **New repository secret**.
   Nombre: `FIREBASE_SERVICE_ACCOUNT`. Valor: todo el contenido del archivo `.json` (ábrelo con el Bloc de notas,
   copia y pega). Después borra el archivo de tu computador.
4. **Publicar:** *Actions* → *Publicar funciones de Siigo* → **Run workflow**. Si termina en verde, ya quedó.

Las claves de Siigo (`SIIGO_USERNAME`, `SIIGO_ACCESS_KEY`, `SIIGO_PARTNER_ID`) deben estar ya guardadas en
Firebase (ver abajo). Si nunca se configuraron, la publicación falla indicando cuál falta.

## Puesta en marcha (una sola vez)

Requisitos: plan **Blaze** de Firebase en el proyecto `pedidos-nuevo` y
[Firebase CLI](https://firebase.google.com/docs/cli) instalada (`npm i -g firebase-tools`).

```bash
firebase login
cd functions && npm install && cd ..

# Credenciales de la API de Siigo (se guardan cifradas en Google Cloud, no en el código)
firebase functions:secrets:set SIIGO_USERNAME      # usuario API de Siigo (correo)
firebase functions:secrets:set SIIGO_ACCESS_KEY    # access key generada en Siigo
firebase functions:secrets:set SIIGO_PARTNER_ID    # Partner-Id registrado ante Siigo

firebase deploy --only functions
```

Se publican dos funciones: `sincronizarSiigo` (automática) y `sincronizarSiigoAhora` (botón de la app).

### Al actualizar desde la primera versión

La primera versión dejaba por fuera lo facturado el mismo día. Después de volver a publicar
(`firebase deploy --only functions`), **vuelve a cargar el histórico** con el comando de abajo
para que los días anteriores queden recalculados con la corrección.

### Cargar el histórico

**Ya no hace falta hacer nada a mano:** en cada corrida la función también carga meses anteriores,
empezando por el mes actual y yendo hacia atrás, hasta encontrar 6 meses seguidos sin facturas
(o llegar a 2018). El avance queda en `siigo/historico` y se ve en *Ventas Siigo*. El botón
"Sincronizar ahora" también avanza el histórico.

Si prefieres cargarlo todo de una vez desde tu computador:

1. En Firebase → Configuración del proyecto → Cuentas de servicio → *Generar nueva clave privada*.
   Guárdala como `functions/service-account.json` (está en `.gitignore`; no la subas).
2. Ejecuta:

```bash
cd functions
SIIGO_USERNAME=... SIIGO_ACCESS_KEY=... SIIGO_PARTNER_ID=... \
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json \
npm run backfill -- 2026-01-01 2026-09-30
```

### Probar sin conectarse a Siigo

```bash
cd functions && npm test
```

## Pendiente de validar con datos reales

- **Qué valor cuenta como "venta":** hoy se usa el `total` de la factura (con impuestos) y, por
  producto, el `total` de cada ítem. Si prefieres medir sin IVA, se ajusta en `sync.js`.
- **Facturas anuladas:** se excluyen si Siigo las marca con `annulled: true`. Hay que confirmarlo
  con la primera sincronización real.
- **Notas crédito / devoluciones:** todavía no se restan.

## Accesos seguros (Firebase Authentication)

Cada usuario de la app es una cuenta de Firebase Authentication (correo interno calculado del nombre de
usuario; se sigue entrando con usuario y contraseña). Las contraseñas ya no se guardan en la base de datos.

- `migrarAcceso`: la primera vez que cada persona entra después del cambio, revisa su contraseña de antes y le
  crea la cuenta. Los usuarios pasan al nodo privado `accesos/` y se borran de `casaDoradaDatos`.
- `gestionarUsuarios`: ventana "Usuarios" (solo administradores): listar, crear, cambiar contraseña, eliminar.
  Roles: `admin`, `trabajador`, `lector` (solo lectura, para el reporte diario).
- `database.rules.json`: solo usuarios con sesión leen `casaDoradaDatos` (admin y trabajador pueden guardar);
  `siigo/` solo lo leen admin y lector. Se publica a mano con el workflow "Publicar reglas de la base de datos".

Pasos, en orden:
1. Firebase → Authentication → Comenzar → "Correo electrónico/contraseña" → Habilitar.
2. Unir el cambio a main (publica la app y las funciones).
3. Entrar una vez con el administrador y crear el usuario de "Solo lectura" para el reporte.
4. GitHub → Actions → "Publicar reglas de la base de datos" → Run workflow.
