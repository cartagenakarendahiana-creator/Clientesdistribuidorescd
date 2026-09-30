// Cliente mínimo para la API de Siigo Nube (https://api.siigo.com).
// Autenticación, listados paginados con reintentos ante límite de peticiones y creación de facturas.

const BASE_URL = 'https://api.siigo.com';
const PAGE_SIZE = 100; // máximo que acepta Siigo por página
const MAX_REINTENTOS = 5;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

class SiigoClient {
  constructor({ username, accessKey, partnerId, fetchImpl = fetch }) {
    if (!username || !accessKey || !partnerId) {
      throw new Error('Faltan credenciales de Siigo (usuario, access key o Partner-Id).');
    }
    this.username = username;
    this.accessKey = accessKey;
    this.partnerId = partnerId;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenVence = 0;
  }

  async autenticar() {
    if (this.token && Date.now() < this.tokenVence) return this.token;
    // Si varias peticiones piden token a la vez, comparten la misma solicitud.
    this.pidiendoToken ||= this.pedirToken().finally(() => {
      this.pidiendoToken = null;
    });
    return this.pidiendoToken;
  }

  async pedirToken() {
    const res = await this.fetch(`${BASE_URL}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Partner-Id': this.partnerId },
      body: JSON.stringify({ username: this.username, access_key: this.accessKey }),
    });
    if (!res.ok) {
      throw new Error(`Siigo rechazó la autenticación (HTTP ${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    this.token = data.access_token;
    // Renovamos 5 minutos antes de que venza (Siigo entrega expires_in en segundos).
    const segundos = Number(data.expires_in) || 3600;
    this.tokenVence = Date.now() + Math.max(60, segundos - 300) * 1000;
    return this.token;
  }

  async get(ruta, params = {}) {
    const url = new URL(`${BASE_URL}/${ruta}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    for (let intento = 0; ; intento++) {
      const token = await this.autenticar();
      const res = await this.fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Partner-Id': this.partnerId,
          'Content-Type': 'application/json',
        },
      });
      if (res.ok) return res.json();
      if (res.status === 401 && intento === 0) {
        this.token = null; // token vencido: pedir uno nuevo y reintentar
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && intento < MAX_REINTENTOS) {
        await esperar(Math.min(60000, 2000 * 2 ** intento));
        continue;
      }
      throw new Error(`Siigo GET ${ruta} falló (HTTP ${res.status}): ${await res.text()}`);
    }
  }

  // Crea un documento (POST). Solo reintenta si Siigo responde 429 (límite de peticiones: la
  // factura no se creó); ante otros errores NO reintenta, para no crear facturas repetidas.
  async post(ruta, body) {
    for (let intento = 0; ; intento++) {
      const token = await this.autenticar();
      const res = await this.fetch(`${BASE_URL}/${ruta}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Partner-Id': this.partnerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      if (res.status === 401 && intento === 0) {
        this.token = null; // token vencido: Siigo no procesó la petición
        continue;
      }
      if (res.status === 429 && intento < MAX_REINTENTOS) {
        await esperar(Math.min(60000, 2000 * 2 ** intento));
        continue;
      }
      const err = new Error(`Siigo POST ${ruta} falló (HTTP ${res.status}): ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
  }

  // Recorre todas las páginas de un listado y devuelve los resultados juntos.
  async listarTodo(ruta, params = {}) {
    const todos = [];
    for (let page = 1; ; page++) {
      const data = await this.get(ruta, { ...params, page, page_size: PAGE_SIZE });
      const resultados = Array.isArray(data) ? data : data.results || [];
      todos.push(...resultados);
      const total = data.pagination ? Number(data.pagination.total_results) : resultados.length;
      if (Array.isArray(data) || resultados.length < PAGE_SIZE || todos.length >= total) break;
    }
    return todos;
  }

  facturas(fechaInicio, fechaFin) {
    return this.listarTodo('v1/invoices', { date_start: fechaInicio, date_end: fechaFin });
  }

  clientes(actualizadosDesde) {
    return this.listarTodo('v1/customers', { updated_start: actualizadosDesde });
  }

  productos(actualizadosDesde) {
    return this.listarTodo('v1/products', { updated_start: actualizadosDesde });
  }

  centrosDeCosto() {
    return this.get('v1/cost-centers');
  }

  vendedores() {
    return this.listarTodo('v1/users');
  }

  tiposDeFactura() {
    return this.get('v1/document-types', { type: 'FV' });
  }

  formasDePago() {
    return this.get('v1/payment-types', { document_type: 'FV' });
  }

  impuestos() {
    return this.get('v1/taxes');
  }

  crearFactura(factura) {
    return this.post('v1/invoices', factura);
  }
}

module.exports = { SiigoClient };
