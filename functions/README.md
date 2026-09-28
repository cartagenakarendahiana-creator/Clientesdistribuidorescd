# Casa Dorada · Conexión con Siigo

Función en la nube que lee las facturas de venta de Siigo y las guarda en Firebase,
listas para los tableros de metas, rankings y el informe diario con IA.

Corre sola **cada 2 horas entre 6 a.m. y 8 p.m. (hora Colombia)** y vuelve a leer los
últimos 3 días para recoger facturas elaboradas con fecha anterior o editadas.

## Qué guarda en Firebase (nodo `siigo/`, aparte de los datos de la app)

| Ruta | Contenido |
|---|---|
| `siigo/facturas/{id}` | Número, fecha, NIT del cliente, centro de costo, vendedor, total, saldo, ítems |
| `siigo/resumenDiario/{AAAA-MM-DD}/global` | Ventas, # facturas y unidades del día (todos los centros) |
| `siigo/resumenDiario/{AAAA-MM-DD}/cc_{id}` | Lo mismo por centro de costo (`sin_centro` si la factura no tiene) |
| `.../productos/{código}` y `.../clientes/{nit}` | Cantidad y valor por producto y por cliente, dentro de cada día y centro |
| `siigo/catalogos/...` | Centros de costo, vendedores, clientes y productos de Siigo |
| `siigo/estado` | Última sincronización y último error |

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

### Cargar el histórico

La función programada solo lee los últimos días. Para traer meses anteriores, en tu computador:

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
