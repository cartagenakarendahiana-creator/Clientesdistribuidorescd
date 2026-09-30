#!/usr/bin/env node
// Reporte general de Casa Dorada (día, semana o mes) a partir de la base de datos de la app.
// Lo usa el reporte diario automático, y también se puede correr a mano:
//   node reportes/reporte.mjs                → ayer
//   node reportes/reporte.mjs dia 2026-09-30
//   node reportes/reporte.mjs semana 2026-09-30   (lunes a domingo de esa fecha)
//   node reportes/reporte.mjs mes 2026-09
// Si la base de datos pide autenticación, pon el secreto de lectura en FIREBASE_DB_AUTH.

const DB_URL = process.env.FIREBASE_DB_URL || 'https://pedidos-nuevo-default-rtdb.firebaseio.com';
const TZ = 'America/Bogota';
const ETAPAS = [
  { key: 'Corte', label: 'Corte' },
  { key: 'Taller', label: 'Taller (Confección)' },
  { key: 'Ultrasonido', label: 'Ultrasonido' },
  { key: 'Confortadora', label: 'Confortadora' }
];

const lista = v => Array.isArray(v) ? v.filter(Boolean) : (v && typeof v === 'object' ? Object.values(v).filter(Boolean) : []);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-CO');
const fmtNum = n => Math.round(n || 0).toLocaleString('es-CO');
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function normEtapa(e){
  const t = norm(e);
  if(t.startsWith('taller') || t.includes('confeccion')) return 'Taller';
  if(t.startsWith('ultra')) return 'Ultrasonido';
  if(t.startsWith('confort')) return 'Confortadora';
  if(t.startsWith('corte')) return 'Corte';
  return e || 'Taller';
}
// Acepta YYYY-MM-DD o DD/MM/YYYY; devuelve YYYY-MM-DD o null.
function fechaIso(f){
  if(!f) return null;
  const s = String(f).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function hoyColombia(){
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = p.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function rango(tipo, ref){
  if(tipo === 'mes'){
    const [y, m] = ref.split('-').map(Number);
    return { desde: iso(new Date(y, m - 1, 1)), hasta: iso(new Date(y, m, 0)) };
  }
  const [y, m, d] = ref.split('-').map(Number);
  const f = new Date(y, m - 1, d);
  if(tipo === 'semana'){
    const lunes = new Date(f); lunes.setDate(f.getDate() - ((f.getDay() + 6) % 7));
    const dom = new Date(lunes); dom.setDate(lunes.getDate() + 6);
    return { desde: iso(lunes), hasta: iso(dom) };
  }
  return { desde: iso(f), hasta: iso(f) };
}
function anterior(tipo, r){
  const [y, m, d] = r.desde.split('-').map(Number);
  if(tipo === 'mes') return rango('mes', iso(new Date(y, m - 2, 1)).slice(0, 7));
  const f = new Date(y, m - 1, d); f.setDate(f.getDate() - (tipo === 'semana' ? 7 : 1));
  return rango(tipo, iso(f));
}

async function leer(ruta){
  const auth = process.env.FIREBASE_DB_AUTH ? `?auth=${encodeURIComponent(process.env.FIREBASE_DB_AUTH)}` : '';
  const res = await fetch(`${DB_URL}/casaDoradaDatos/${ruta}.json${auth}`);
  if(res.status === 401 || res.status === 403) throw new Error(`La base de datos no dejó leer "${ruta}" (HTTP ${res.status}): falta el permiso de lectura (FIREBASE_DB_AUTH).`);
  if(!res.ok) throw new Error(`No se pudo leer "${ruta}" (HTTP ${res.status}).`);
  return res.json();
}

function calcular(datos, r){
  const dentro = f => { const x = fechaIso(f); return x !== null && x >= r.desde && x <= r.hasta; };
  // Precio de servicio: el de cada registro; si no tiene, el de la lista de su etapa (nombre exacto).
  const precioLista = new Map();
  datos.servicios.forEach(s => { if(Number(s.precio) > 0 && s.etapa) precioLista.set(norm(s.servicio) + '|' + s.etapa, Number(s.precio)); });
  const etapas = {};
  ETAPAS.forEach(e => { etapas[e.key] = { unidades: 0, cobro: 0, registros: new Set(), productos: {} }; });
  datos.produccion.forEach(row => {
    if(!dentro(row.fecha)) return;
    const etapa = normEtapa(row.etapa);
    const e = etapas[etapa]; if(!e) return;
    const cant = Number(row.cantidad) || 0;
    const propio = row.precioServicio !== undefined && row.precioServicio !== null && row.precioServicio !== '' && isFinite(Number(row.precioServicio));
    const precio = propio ? Number(row.precioServicio) : (precioLista.get(norm(row.producto) + '|' + etapa) || 0);
    e.unidades += cant; e.cobro += cant * precio; e.registros.add(row.registroId || row.id);
    const k = row.producto || '—';
    e.productos[k] = e.productos[k] || { cantidad: 0, cobro: 0 };
    e.productos[k].cantidad += cant; e.productos[k].cobro += cant * precio;
  });
  const eliminados = new Set(datos.eliminados);
  const pedidos = datos.nuevos.filter(d => !eliminados.has(d.id) && dentro(datos.fechaOverrides[d.id] || d.fecha))
    .map(d => ({ nombre: datos.nombreOverrides[d.id] || d.nombre, vendedor: datos.vendedorOverrides[d.id] || d.vendedor || '' }));
  const despachos = datos.despachos.filter(x => dentro(x.fecha));
  const gastos = datos.gastos.filter(g => dentro(g.fecha));
  return {
    etapas, pedidos, despachos, gastos,
    unidades: ETAPAS.reduce((s, e) => s + etapas[e.key].unidades, 0),
    cobro: ETAPAS.reduce((s, e) => s + etapas[e.key].cobro, 0),
    valorDespachos: despachos.reduce((s, x) => s + (Number(x.valorFactura) || 0), 0),
    fletes: despachos.reduce((s, x) => s + (Number(x.valorFlete) || 0), 0),
    totalGastos: gastos.reduce((s, g) => s + (Number(g.valor) || 0), 0)
  };
}

function cambio(a, b){
  if(!a && !b) return 'igual';
  if(!b) return 'nuevo';
  const p = Math.round((a - b) / b * 100);
  return (p >= 0 ? '▲ ' : '▼ ') + Math.abs(p) + '%';
}

async function main(){
  const [tipoArg, refArg] = process.argv.slice(2);
  const tipo = ['dia', 'semana', 'mes'].includes(tipoArg) ? tipoArg : 'dia';
  let ref = refArg;
  if(!ref){
    const h = hoyColombia();
    if(tipo === 'mes'){ ref = iso(new Date(h.getFullYear(), h.getMonth() - 1, 1)).slice(0, 7); }
    else { h.setDate(h.getDate() - (tipo === 'semana' ? 7 : 1)); ref = iso(h); } // por defecto: el período anterior completo
  }
  const r = rango(tipo, ref), rAnt = anterior(tipo, r);
  const [produccion, servicios, despachos, gastos, nuevos, eliminados, fechaOv, nombreOv, vendOv] = await Promise.all([
    leer('plantaProduccionDiaria'), leer('plantaServiciosMaquila'), leer('despachos'), leer('plantaGastosAdicionales'),
    leer('nuevosDistribuidores'), leer('distribuidoresEliminados'), leer('distFechaOverrides'), leer('distNameOverrides'), leer('distVendedorOverrides')
  ]);
  const datos = {
    produccion: lista(produccion), servicios: lista(servicios), despachos: lista(despachos), gastos: lista(gastos),
    nuevos: lista(nuevos), eliminados: lista(eliminados),
    fechaOverrides: fechaOv || {}, nombreOverrides: nombreOv || {}, vendedorOverrides: vendOv || {}
  };
  const d = calcular(datos, r), p = calcular(datos, rAnt);
  const titulo = tipo === 'mes' ? `Mes ${r.desde.slice(0, 7)}` : tipo === 'semana' ? `Semana ${r.desde} a ${r.hasta}` : `Día ${r.desde}`;
  const out = [];
  out.push(`# Reporte Casa Dorada · ${titulo}`, '');
  out.push('## Resumen (vs. período anterior)');
  out.push(`- Unidades producidas: ${fmtNum(d.unidades)} (${cambio(d.unidades, p.unidades)})`);
  out.push(`- Cobro de servicios: ${fmt(d.cobro)} (${cambio(d.cobro, p.cobro)})`);
  out.push(`- Pedidos nuevos creados en la app: ${fmtNum(d.pedidos.length)}${d.pedidos.length ? ' — ' + d.pedidos.map(x => x.nombre + (x.vendedor ? ` (${x.vendedor})` : '')).join(', ') : ''}`);
  out.push(`- Despachos: ${fmtNum(d.despachos.length)} · facturado ${fmt(d.valorDespachos)} · fletes ${fmt(d.fletes)}`);
  out.push(`- Gastos adicionales: ${fmt(d.totalGastos)}`, '');
  out.push('## Producción por etapa');
  out.push('| Etapa | Registros | Unidades | Cobro del servicio |', '|---|---:|---:|---:|');
  ETAPAS.forEach(e => { const x = d.etapas[e.key]; out.push(`| ${e.label} | ${fmtNum(x.registros.size)} | ${fmtNum(x.unidades)} | ${fmt(x.cobro)} |`); });
  out.push(`| **Total** | | **${fmtNum(d.unidades)}** | **${fmt(d.cobro)}** |`, '');
  ETAPAS.forEach(e => {
    const filas = Object.entries(d.etapas[e.key].productos).sort((a, b) => b[1].cantidad - a[1].cantidad).slice(0, 10);
    if(!filas.length) return;
    out.push(`### ${e.label} · productos principales`);
    filas.forEach(([n, x]) => out.push(`- ${n}: ${fmtNum(x.cantidad)} u · ${fmt(x.cobro)}`));
    out.push('');
  });
  if(d.despachos.length){
    out.push('## Despachos');
    d.despachos.forEach(x => out.push(`- ${fechaIso(x.fecha) || ''} · ${x.cliente || ''}${x.ciudad ? ' (' + x.ciudad + ')' : ''} · ${fmt(Number(x.valorFactura) || 0)}${x.transportadora ? ' · ' + x.transportadora : ''}`));
    out.push('');
  }
  if(d.gastos.length){
    out.push('## Gastos adicionales');
    d.gastos.forEach(g => out.push(`- ${fechaIso(g.fecha) || ''} · ${g.concepto || ''}${g.etapa ? ' (' + normEtapa(g.etapa) + ')' : ''} · ${fmt(Number(g.valor) || 0)}`));
    out.push('');
  }
  if(!d.unidades && !d.despachos.length && !d.gastos.length && !d.pedidos.length) out.push('_No hubo movimientos registrados en este período._');
  console.log(out.join('\n'));
}

main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
