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
empezando por el mes actual y yendo hacia atrás, hasta encontrar 3 meses seguidos sin facturas
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
