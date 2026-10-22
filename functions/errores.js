// Error con código HTTP para responderle a la otra app (400 datos, 401 clave, 404 no existe, 503 apagada).
class ErrorApi extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}
module.exports = { ErrorApi };
