// Copia el CATALOG (pedidos y productos originales escritos dentro de index.html) a functions/catalogo.json,
// para que la API de pedidos arme los pedidos igual que la app. Se ejecuta antes de publicar y de probar.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = html.match(/^const CATALOG = (\{.*\});\s*$/m);
if (!m) throw new Error('No se encontró "const CATALOG = {...};" en index.html');
const catalogo = JSON.parse(m[1]);
if (!Array.isArray(catalogo.distribuidores) || !Array.isArray(catalogo.productos)) throw new Error('CATALOG no tiene distribuidores y productos');
fs.writeFileSync(path.join(__dirname, '..', 'catalogo.json'), JSON.stringify(catalogo));
console.log(`catalogo.json: ${catalogo.distribuidores.length} pedidos y ${catalogo.productos.length} productos originales`);
