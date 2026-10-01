#!/usr/bin/env node
// Arma el reporte de Casa Dorada en PDF (tablas numeradas por secciones, igual que "Reportes" en la app)
// y lo envía por correo con Brevo.
//
//   node reportes/enviar-reporte.mjs                  → reporte de ayer, enviado por correo
//   node reportes/enviar-reporte.mjs dia hoy          → reporte de hoy
//   node reportes/enviar-reporte.mjs semana | mes     → semana o mes anterior
//   ... --solo-pdf reporte.pdf                        → solo genera el PDF (no envía)
//
// Variables de entorno (se configuran en el entorno, nunca en el código):
//   BREVO_API_KEY      clave de API de Brevo (obligatoria para enviar)
//   BREVO_REMITENTE    correo remitente verificado en Brevo (por defecto el primer destinatario)
//   REPORTE_DESTINOS   correos separados por coma (por defecto jarist35@gmail.com,jarist35@hotmail.com)
// Si Node no sale a internet por el proxy del entorno, ejecútalo con NODE_USE_ENV_PROXY=1.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import { periodoDesdeArgs, leerDatos, calcular, ETAPAS, fmt, fmtNum, normEtapa, norm } from './reporte.mjs';

const DESTINOS_POR_DEFECTO = 'jarist35@gmail.com,jarist35@hotmail.com';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLORES = { Corte: '#B65B2E', Taller: '#9E7B3B', Ultrasonido: '#4C7A52', Confortadora: '#6B8CAE' };
const SERVICIOS_FIJOS = ['SERVICIO DE ACOLCHADO ULTRASONIDO', 'SERVICIO DE CONFORTEADO'];

function titulo(tipo, r){
  const larga = (iso, o) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('es-CO', o); };
  let t;
  if(tipo === 'mes') t = 'mes de ' + larga(r.desde, { month: 'long', year: 'numeric' });
  else if(tipo === 'semana') t = 'semana del ' + larga(r.desde, { day: 'numeric', month: 'long' }) + ' al ' + larga(r.hasta, { day: 'numeric', month: 'long', year: 'numeric' });
  else t = larga(r.desde, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const fCorta = f => { const [y, m, d] = String(f || '').split('-').map(Number); return y ? new Date(y, m - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : ''; };

// Categoría de cada producto: la del Inventario (Precios de servicio guarda categoría y medida de cada uno).
function buscadorCategoria(datos){
  const mapa = new Map(), orden = new Map();
  const poner = (nombre, cat) => { const k = norm(nombre); if(k && cat && !mapa.has(k)) mapa.set(k, cat); if(cat && !orden.has(cat)) orden.set(cat, orden.size + 1); };
  datos.custom.forEach(p => { poner([p.producto, p.medida].filter(Boolean).join(' · '), (p.categoria || '').trim()); poner(p.producto, (p.categoria || '').trim()); });
  datos.servicios.forEach(s => poner(s.servicio, (s.categoria || '').trim()));
  const claves = [...mapa.keys()].sort((a, b) => b.length - a.length);
  const categoria = n => {
    if(SERVICIOS_FIJOS.some(s => String(n).toUpperCase().startsWith(s))) return 'Servicios';
    const t = norm(n);
    return mapa.get(t) || mapa.get(claves.find(k => t.startsWith(k))) || 'Otros';
  };
  return { categoria, orden: c => c === 'Servicios' ? 0 : (orden.get(c) || (c === 'Otros' ? 99999 : 90000)) };
}

function variacion(a, b){
  if(!a && !b) return '<span class="v">—</span>';
  if(!b) return '<span class="v sube">nuevo</span>';
  const p = Math.round((a - b) / b * 100);
  return `<span class="v ${p >= 0 ? 'sube' : 'baja'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
}

function construirHtml({ tipo, r, d, p, datos }){
  const nombreTipo = { dia: 'Reporte diario', semana: 'Reporte semanal', mes: 'Reporte mensual' }[tipo];
  const txtAnt = { dia: 'Día anterior', semana: 'Semana anterior', mes: 'Mes anterior' }[tipo];
  const cat = buscadorCategoria(datos);
  let n = 0;
  const sec = (t, cuerpo, cuenta) => `<section><h3><span class="num">${++n}</span>${t}${cuenta !== undefined ? ` <span class="cuenta">${cuenta}</span>` : ''}</h3>${cuerpo}</section>`;
  const vacio = t => `<div class="vacio">${t}</div>`;
  const generado = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const pct = (x, t) => t ? Math.round(x / t * 100) + '%' : '—';

  let html = `<div class="header"><div><div class="marca">CASA DORADA</div><h2>${nombreTipo}</h2><div class="periodo">${esc(titulo(tipo, r))}</div></div><div class="gen">Generado el<br>${esc(generado)}</div></div>`;
  const filas = [
    ['Unidades producidas', fmtNum(d.unidades), fmtNum(p.unidades), variacion(d.unidades, p.unidades)],
    ['Cobro de servicios', fmt(d.cobro), fmt(p.cobro), variacion(d.cobro, p.cobro)],
    ['Pedidos nuevos', `${fmtNum(d.pedidos.length)} · ${fmt(d.pedidos.reduce((s, x) => s + x.valor, 0))}`, `${fmtNum(p.pedidos.length)} · ${fmt(p.pedidos.reduce((s, x) => s + x.valor, 0))}`, variacion(d.pedidos.reduce((s, x) => s + x.valor, 0), p.pedidos.reduce((s, x) => s + x.valor, 0))],
    ['Despachos', `${fmtNum(d.despachos.length)} · ${fmt(d.valorDespachos)}`, `${fmtNum(p.despachos.length)} · ${fmt(p.valorDespachos)}`, variacion(d.valorDespachos, p.valorDespachos)],
    ['Fletes', fmt(d.fletes), fmt(p.fletes), variacion(d.fletes, p.fletes)],
    ['Gastos adicionales', fmt(d.totalGastos), fmt(p.totalGastos), variacion(d.totalGastos, p.totalGastos)]
  ];
  html += sec('Resumen', `<table><thead><tr><th class="n">#</th><th>Indicador</th><th class="r">Este período</th><th class="r">${txtAnt}</th><th class="r">Variación</th></tr></thead><tbody>
    ${filas.map((f, k) => `<tr><td class="n">${k + 1}</td><td><b>${f[0]}</b></td><td class="r"><b>${f[1]}</b></td><td class="r">${f[2]}</td><td class="r">${f[3]}</td></tr>`).join('')}</tbody></table>`);

  html += sec('Producción por etapa', `<table><thead><tr><th class="n">#</th><th>Etapa</th><th class="r">Registros</th><th class="r">Unidades</th><th class="r">% del total</th><th class="r">Cobro del servicio</th><th class="r">Precio prom.</th><th class="r">${txtAnt}</th><th class="r">Variación</th></tr></thead><tbody>
    ${ETAPAS.map((e, k) => { const x = d.etapas[e.key], y = p.etapas[e.key]; return `<tr><td class="n">${k + 1}</td><td><span class="punto" style="background:${COLORES[e.key]}"></span>${esc(e.label)}</td><td class="r">${fmtNum(x.registros.size)}</td><td class="r">${fmtNum(x.unidades)}</td><td class="r">${pct(x.unidades, d.unidades)}</td><td class="r">${fmt(x.cobro)}</td><td class="r">${x.unidades ? fmt(x.cobro / x.unidades) : '—'}</td><td class="r">${fmtNum(y.unidades)}</td><td class="r">${variacion(x.unidades, y.unidades)}</td></tr>`; }).join('')}
    <tr class="total"><td></td><td>Total</td><td class="r">${fmtNum(ETAPAS.reduce((s, e) => s + d.etapas[e.key].registros.size, 0))}</td><td class="r">${fmtNum(d.unidades)}</td><td class="r">100%</td><td class="r">${fmt(d.cobro)}</td><td class="r">${d.unidades ? fmt(d.cobro / d.unidades) : '—'}</td><td class="r">${fmtNum(p.unidades)}</td><td class="r">${variacion(d.unidades, p.unidades)}</td></tr></tbody></table>`);

  const numSec = n + 1;
  let sub = 0, prod = '';
  ETAPAS.forEach(e => {
    const lista = Object.entries(d.etapas[e.key].productos).map(([nombre, x]) => ({ nombre, ...x, cat: cat.categoria(nombre) }));
    if(!lista.length) return;
    lista.sort((a, b) => cat.orden(a.cat) - cat.orden(b.cat) || a.cat.localeCompare(b.cat, 'es') || b.cantidad - a.cantidad);
    let previa = null, k = 0;
    const cuerpo = lista.map(x => {
      let fila = '';
      if(x.cat !== previa){ previa = x.cat; fila += `<tr class="cat"><td colspan="5">${esc(x.cat)} <span>(${lista.filter(y => y.cat === x.cat).length})</span></td></tr>`; }
      return fila + `<tr><td class="n">${++k}</td><td>${esc(x.nombre)}</td><td class="r">${fmtNum(x.cantidad)}</td><td class="r">${x.cantidad && x.cobro ? fmt(x.cobro / x.cantidad) : '—'}</td><td class="r">${x.cobro ? fmt(x.cobro) : '—'}</td></tr>`;
    }).join('');
    prod += `<div class="sub"><h4>${numSec}.${++sub} <span class="punto" style="background:${COLORES[e.key]}"></span>${esc(e.label)} <span class="cuenta">${lista.length} producto${lista.length > 1 ? 's' : ''}</span></h4>
      <table><thead><tr><th class="n">#</th><th>Producto</th><th class="r">Unidades</th><th class="r">Precio servicio</th><th class="r">Cobro</th></tr></thead><tbody>${cuerpo}
      <tr class="total"><td></td><td>Total ${esc(e.label)}</td><td class="r">${fmtNum(d.etapas[e.key].unidades)}</td><td></td><td class="r">${fmt(d.etapas[e.key].cobro)}</td></tr></tbody></table></div>`;
  });
  html += sec('Productos por etapa', prod || vacio('Sin producción registrada en este período.'));

  const valorPed = d.pedidos.reduce((s, x) => s + x.valor, 0);
  html += sec('Pedidos nuevos', d.pedidos.length ? `<table><thead><tr><th class="n">#</th><th>Cliente</th><th>Vendedor</th><th>Fecha</th><th class="r">Unidades</th><th class="r">Valor</th></tr></thead><tbody>
    ${d.pedidos.map((x, k) => `<tr><td class="n">${k + 1}</td><td>${esc(x.nombre)}</td><td>${esc(x.vendedor || '—')}</td><td class="f">${fCorta(x.fecha)}</td><td class="r">${fmtNum(x.unidades)}</td><td class="r">${fmt(x.valor)}</td></tr>`).join('')}
    <tr class="total"><td></td><td colspan="3">Total</td><td class="r">${fmtNum(d.pedidos.reduce((s, x) => s + x.unidades, 0))}</td><td class="r">${fmt(valorPed)}</td></tr></tbody></table>` : vacio('Sin pedidos nuevos en este período.'), fmtNum(d.pedidos.length));

  html += sec('Despachos', d.despachos.length ? `<table><thead><tr><th class="n">#</th><th>Fecha</th><th>Cliente</th><th>Ciudad</th><th>Transportadora</th><th class="r">Valor factura</th><th class="r">Flete</th><th class="r">% flete</th></tr></thead><tbody>
    ${d.despachos.map((x, k) => { const vf = Number(x.valorFactura) || 0, fl = Number(x.valorFlete) || 0; return `<tr><td class="n">${k + 1}</td><td class="f">${fCorta(x.fecha)}</td><td>${esc(x.cliente)}</td><td>${esc(x.ciudad)}</td><td>${esc(x.transportadora)}</td><td class="r">${fmt(vf)}</td><td class="r">${fmt(fl)}</td><td class="r">${vf ? (fl / vf * 100).toFixed(1) + '%' : '—'}</td></tr>`; }).join('')}
    <tr class="total"><td></td><td colspan="4">Total</td><td class="r">${fmt(d.valorDespachos)}</td><td class="r">${fmt(d.fletes)}</td><td class="r">${d.valorDespachos ? (d.fletes / d.valorDespachos * 100).toFixed(1) + '%' : '—'}</td></tr></tbody></table>` : vacio('Sin despachos en este período.'), fmtNum(d.despachos.length));

  html += sec('Gastos adicionales', d.gastos.length ? `<table><thead><tr><th class="n">#</th><th>Fecha</th><th>Concepto</th><th>Etapa</th><th class="r">Valor</th></tr></thead><tbody>
    ${d.gastos.map((g, k) => `<tr><td class="n">${k + 1}</td><td class="f">${fCorta(g.fecha)}</td><td>${esc(g.concepto)}</td><td>${esc(g.etapa ? normEtapa(g.etapa) : '—')}</td><td class="r">${fmt(Number(g.valor) || 0)}</td></tr>`).join('')}
    <tr class="total"><td></td><td colspan="3">Total</td><td class="r">${fmt(d.totalGastos)}</td></tr></tbody></table>` : vacio('Sin gastos adicionales en este período.'), fmtNum(d.gastos.length));

  const css = `body{font-family:Inter,Arial,sans-serif;color:#2B2621;font-size:10.5px;margin:0}
  .header{display:flex;justify-content:space-between;align-items:center;background:#7A5B22;color:#fff;padding:12px 16px;border-radius:6px;margin-bottom:12px}
  .marca{font-size:9px;letter-spacing:2px;font-weight:700;opacity:.85}.header h2{margin:2px 0;font-size:19px}.periodo{font-size:12px}.gen{font-size:9.5px;text-align:right;opacity:.85}
  section{margin-bottom:14px}h3{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding-bottom:5px;font-size:13.5px;border-bottom:2px solid #C9A96B;break-after:avoid}
  .num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#7A5B22;color:#fff;font-size:11px;font-weight:800}
  .sub{margin:8px 0 12px}h4{margin:0 0 4px;font-size:12px;color:#5A4A2E;break-after:avoid}
  .cuenta{background:#F4ECDD;color:#7A5B22;border-radius:999px;padding:1px 8px;font-size:10px;font-weight:700}
  .punto{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle}
  table{width:100%;border-collapse:collapse;border:1px solid #E6DCC8}th{background:#F4ECDD;color:#5A4A2E;font-size:8.5px;text-transform:uppercase;letter-spacing:.3px;text-align:left;padding:5px 7px}
  td{padding:4px 7px;border-bottom:1px solid #EFE7D8}tr{break-inside:avoid}tbody tr:nth-child(even):not(.cat):not(.total) td{background:#FCFAF6}
  .n{width:24px;text-align:center;color:#8A7F6A}.r{text-align:right;font-variant-numeric:tabular-nums}.f{white-space:nowrap}
  tr.cat td{background:#F7F1E6;color:#7A5B22;font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}tr.cat span{font-weight:500;opacity:.7}
  tr.total td{font-weight:800;border-top:2px solid #C9A96B;background:#FBF6EC}
  .v{font-weight:700;color:#8A7F6A;white-space:nowrap}.v.sube{color:#2F6B3A}.v.baja{color:#B65B2E}.vacio{color:#8A7F6A;padding:4px 2px}
  .pie{text-align:center;font-size:9px;color:#8A7F6A;margin-top:6px}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${css}</style></head><body>${html}<div class="pie">Casa Dorada · ${nombreTipo} · ${esc(titulo(tipo, r))}</div></body></html>`;
}

async function generarPdf(html, ruta){
  const require = createRequire(import.meta.url);
  let playwright;
  try{ playwright = require('playwright'); }
  catch{ playwright = require('/opt/node22/lib/node_modules/playwright'); }
  const opciones = fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
  const navegador = await playwright.chromium.launch(opciones);
  try{
    const pagina = await navegador.newPage();
    await pagina.setContent(html, { waitUntil: 'load' });
    const pdf = await pagina.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    if(ruta) fs.writeFileSync(ruta, pdf);
    return pdf;
  }finally{ await navegador.close(); }
}

async function enviar({ pdf, nombreArchivo, asunto, resumenHtml }){
  const clave = process.env.BREVO_API_KEY;
  if(!clave) throw new Error('Falta BREVO_API_KEY en las variables del entorno (clave de API de Brevo).');
  const destinos = (process.env.REPORTE_DESTINOS || DESTINOS_POR_DEFECTO).split(',').map(s => s.trim()).filter(Boolean);
  const remitente = process.env.BREVO_REMITENTE || destinos[0];
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': clave, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Casa Dorada · Reportes', email: remitente },
      to: destinos.map(email => ({ email })),
      subject: asunto,
      htmlContent: resumenHtml,
      attachment: [{ name: nombreArchivo, content: Buffer.from(pdf).toString('base64') }]
    })
  });
  const texto = await res.text();
  if(res.status === 401) throw new Error('Brevo rechazó la clave de API (HTTP 401). Revisa BREVO_API_KEY.');
  if(!res.ok) throw new Error(`Brevo no envió el correo (HTTP ${res.status}): ${texto}`);
  return destinos;
}

async function main(){
  const args = process.argv.slice(2);
  const iSolo = args.indexOf('--solo-pdf');
  const rutaSolo = iSolo >= 0 ? (args[iSolo + 1] || 'reporte.pdf') : null;
  const periodoArgs = args.filter((a, i) => a !== '--solo-pdf' && (iSolo < 0 || i !== iSolo + 1));
  const { tipo, r, rAnt } = periodoDesdeArgs(periodoArgs);
  const datos = await leerDatos();
  const d = calcular(datos, r), p = calcular(datos, rAnt);
  const html = construirHtml({ tipo, r, d, p, datos });
  const pdf = await generarPdf(html, rutaSolo);
  const nombreTipo = { dia: 'Reporte diario', semana: 'Reporte semanal', mes: 'Reporte mensual' }[tipo];
  if(rutaSolo){ console.log(`PDF generado: ${rutaSolo} (${titulo(tipo, r)})`); return; }
  const asunto = `Casa Dorada · ${nombreTipo} · ${titulo(tipo, r)}`;
  const resumenHtml = `<p>Hola,</p><p>Adjunto el <b>${nombreTipo.toLowerCase()}</b> de Casa Dorada (${esc(titulo(tipo, r))}).</p>
    <ul><li>Unidades producidas: <b>${fmtNum(d.unidades)}</b></li><li>Cobro de servicios: <b>${fmt(d.cobro)}</b></li>
    <li>Pedidos nuevos: <b>${fmtNum(d.pedidos.length)}</b></li><li>Despachos: <b>${fmtNum(d.despachos.length)}</b> · ${fmt(d.valorDespachos)}</li>
    <li>Gastos adicionales: <b>${fmt(d.totalGastos)}</b></li></ul><p>El detalle completo está en el PDF adjunto.</p>`;
  const destinos = await enviar({ pdf, nombreArchivo: `Reporte-${tipo}-${r.desde}.pdf`, asunto, resumenHtml });
  console.log(`Reporte enviado a: ${destinos.join(', ')} (${titulo(tipo, r)})`);
}

main().catch(err => { console.error('ERROR: ' + err.message); process.exit(1); });
