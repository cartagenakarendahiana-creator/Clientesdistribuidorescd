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

## API de pedidos (para conectar otras apps)

Dirección: `https://us-central1-pedidos-nuevo.cloudfunctions.net/apiPedidos`

Cada llamada lleva el encabezado `Authorization: Bearer <clave>`. La clave se guarda **solo** como secreto de
GitHub `API_PEDIDOS_CLAVE` (Settings → Secrets and variables → Actions); al publicar se guarda únicamente su
SHA-256. Sin ese secreto la API responde 503. Para cambiar la clave: cambia el secreto y vuelve a correr
"Publicar funciones de Siigo". Úsala desde el servidor de la otra app, no desde código que corra en el navegador
del cliente (ahí cualquiera la vería).

| Método y ruta | Qué hace |
|---|---|
| `GET /productos` | Productos con su `id`, categoría, medida y precio de lista. |
| `GET /pedidos` | Todos los pedidos. Filtros opcionales: `?estado=pendiente\|entregado\|sin_productos`, `cliente=`, `vendedor=`, `desde=AAAA-MM-DD`, `hasta=AAAA-MM-DD` (fecha del pedido). |
| `GET /pedidos/{id}` | Un pedido. |
| `POST /pedidos` | Crea un pedido (como "+ Nuevo pedido" en la app). |

Cada pedido trae: `id, cliente, nit, telefono, ciudad, direccion, fecha, vendedor, fechaDespacho, urgente,
observaciones[], referenciaExterna, estado, totales{unidades, entregadas, pendientes, valor, valorPendiente},
lineas[{linea, productoId, categoria, producto, medida, cantidad, precio, subtotal, entregado, pendiente}]`.

Crear un pedido:

```bash
curl -X POST https://us-central1-pedidos-nuevo.cloudfunctions.net/apiPedidos/pedidos \
  -H "Authorization: Bearer $CLAVE" -H "Content-Type: application/json" \
  -d '{
    "cliente": "Tiendas la Ganga Pamplona",
    "vendedor": "Julian Aristizabal",
    "fecha": "2026-10-05",
    "fechaDespacho": "2026-10-12",
    "urgente": false,
    "observaciones": "Entregar en la mañana",
    "referenciaExterna": "OTRA-APP-1234",
    "nit": "", "telefono": "", "ciudad": "", "direccion": "",
    "lineas": [ { "productoId": 65, "cantidad": 3 }, { "productoId": 0, "cantidad": 2, "precio": 25000 } ]
  }'
```

- Obligatorios: `cliente` y `lineas` (cada una con `productoId` de `GET /productos` y `cantidad`). Sin `precio`
  se usa el precio de lista.
- Si el cliente ya existe (aunque cambien tildes o mayúsculas) se usa ese cliente; si no, se crea.
- `referenciaExterna` (recomendado): el número del pedido en la otra app. Si se manda dos veces el mismo, no
  se duplica: responde 200 con el pedido ya creado (201 cuando lo crea).
- La API no edita ni borra pedidos; eso se sigue haciendo en la app.
- Errores: `{ "ok": false, "mensaje": "..." }` con 400 (datos), 401 (clave), 404 (no existe) o 503 (API apagada).
