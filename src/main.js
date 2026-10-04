import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import {
  DESASTRES, POLITICAS, TABLAS, cadenaDeRestauracion, compararPoliticas, crearBaseDemo, crearRespaldo,
  desempaquetar, empaquetar, huella, ransomware, restaurar, retencionGFS, simularJornada, tamanoPagina,
} from './backup.js'

const $ = (s) => document.querySelector(s)
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const kb = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`)
const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

let SQL
const estado = { db: null, dia: 0, catalogo: [], historial: [], estados: new Map(), danada: null }

function log(texto, tipo = '') {
  const li = document.createElement('li')
  li.className = tipo
  li.innerHTML = `<b>Día ${estado.dia}</b> ${texto}`
  $('#bitacora').prepend(li)
}

async function ocupado(fn) {
  document.querySelectorAll('button').forEach((b) => (b.disabled = true))
  try {
    await fn()
  } catch (e) {
    log(`❌ ${escapar(e.message)}`, 'error')
  } finally {
    document.querySelectorAll('button').forEach((b) => (b.disabled = false))
  }
}

function reiniciar() {
  estado.db?.close()
  estado.db = crearBaseDemo(SQL)
  estado.dia = 0
  estado.catalogo = []
  estado.historial = []
  estado.estados = new Map()
  estado.danada = null
  $('#bitacora').innerHTML = ''
  $('#resultado').innerHTML = ''
  $('#cadena').innerHTML = ''
  log('Base <code>inventario.db</code> creada: 4 almacenes, 300 productos y 6 000 movimientos.', 'ok')
  pintar()
}

/** Respaldo programado del cierre del día según la política elegida. */
async function respaldoDelDia() {
  if (estado.danada) throw new Error('La base está dañada: restaure antes de continuar.')
  const bytes = estado.db.export()
  const politica = POLITICAS[$('#sel-politica').value]
  let tipo = politica.tipoDelDia(estado.dia)
  if (!estado.catalogo.some((b) => b.tipo === 'completo')) tipo = 'completo'
  const t0 = performance.now()
  const b = await crearRespaldo(bytes, tipo, estado.catalogo, estado.dia)
  const { paquete, bytesComprimidos } = await empaquetar(b, $('#txt-frase').value)
  b.paquete = paquete
  b.bytesComprimidos = bytesComprimidos
  b.ms = Math.round(performance.now() - t0)
  estado.catalogo.push(b)
  estado.historial.push({ dia: estado.dia, hashes: b.hashes, tamPagina: tamanoPagina(bytes) })
  estado.estados.set(b.id, huella(estado.db))
  log(`💾 ${b.id} ${tipo}: ${b.paginas.length}/${b.numPaginas} páginas → ${kb(paquete.length)} cifrado (${b.ms} ms).`, 'ok')
}

async function avanzarDia() {
  if (estado.danada) throw new Error('La base está dañada: restaure antes de continuar.')
  if (estado.catalogo.length) {
    estado.dia += 1
    simularJornada(estado.db, estado.dia)
  }
  await respaldoDelDia()
}

function pintar() {
  $('#dia').textContent = estado.dia
  $('#dia-nombre').textContent = DIAS[estado.dia % 7]

  const h = estado.danada ? null : huella(estado.db)
  $('#tabla-huella tbody').innerHTML = TABLAS.map((t) => {
    const f = h?.[t]?.filas
    return `<tr class="${f == null || f === 0 ? 'mal' : ''}"><td>${t}</td><td>${f ?? '—'}</td></tr>`
  }).join('')
  const bytes = estado.danada ?? estado.db.export()
  $('#ind-tam').textContent = kb(bytes.length)
  $('#ind-pag').textContent = Math.ceil(bytes.length / 4096)
  const sana = !estado.danada && TABLAS.every((t) => h[t].filas)
  $('#ind-estado').textContent = estado.danada ? 'Cifrada (ransomware)' : sana ? 'Sana' : 'Dañada'
  $('#ind-estado-c').classList.toggle('alerta', !sana)

  const ult = estado.catalogo.at(-1)
  if (ult) {
    const copiadas = new Set(ult.paginas.map((p) => p.i))
    $('#mapa').innerHTML = Array.from({ length: ult.numPaginas }, (_, i) =>
      `<i class="${copiadas.has(i) ? 'c' : 's'}" title="Página ${i + 1}"></i>`).join('')
  } else {
    $('#mapa').innerHTML = ''
  }

  const conservar = retencionGFS(estado.catalogo.map((b) => b.dia), { diarios: 7, semanales: 4, mensuales: 6 })
  $('#tabla-catalogo tbody').innerHTML = estado.catalogo.length
    ? estado.catalogo.map((b) => `
      <tr>
        <td><code>${b.id}</code></td><td>${b.dia} <small>${DIAS[b.dia % 7].slice(0, 3)}</small></td>
        <td><span class="chip ${b.tipo}">${b.tipo}</span></td><td>${b.padre ?? '—'}</td>
        <td><div class="barra"><span style="width:${(100 * b.paginas.length) / b.numPaginas}%"></span></div>${b.paginas.length}/${b.numPaginas}</td>
        <td>${kb(b.bytesCrudos)}</td><td>${kb(b.paquete.length)}</td>
        <td>${conservar.has(b.dia) ? '✔ conservar' : '<span class="tenue">expira</span>'}</td>
        <td class="mini"><button data-perder="${b.id}" title="Simular que este archivo se perdió o se corrompió">🗑</button></td>
      </tr>`).reverse().join('')
    : '<tr class="vacio"><td colspan="9">Avanza un día para crear el primer respaldo.</td></tr>'

  const sel = $('#sel-restaurar')
  const previo = sel.value
  sel.innerHTML = estado.catalogo.map((b) => `<option value="${b.id}">Día ${b.dia} (${DIAS[b.dia % 7]}) · ${b.id} ${b.tipo}</option>`).reverse().join('')
  // Si llegaron respaldos nuevos se propone el más reciente; si no, se respeta la elección del usuario.
  if (sel.dataset.n === String(estado.catalogo.length) && [...sel.options].some((o) => o.value === previo)) sel.value = previo
  sel.dataset.n = estado.catalogo.length
  pintarCadena()
  pintarComparacion()
}

function pintarCadena() {
  const id = $('#sel-restaurar').value
  if (!id) {
    $('#cadena').innerHTML = ''
    return
  }
  try {
    const cadena = cadenaDeRestauracion(estado.catalogo, id)
    $('#cadena').innerHTML = `<small>Piezas necesarias (${cadena.length}):</small>` +
      cadena.map((b) => `<span class="eslabon ${b.tipo}">${b.id}<small>día ${b.dia}</small></span>`).join('<span class="flecha">→</span>')
  } catch (e) {
    $('#cadena').innerHTML = `<span class="roto">⛓️‍💥 ${escapar(e.message)}</span>`
  }
}

function pintarComparacion() {
  if (!estado.historial.length) {
    $('#comparacion').innerHTML = '<p class="ayuda">Aún no hay datos.</p>'
    return
  }
  const c = compararPoliticas(estado.historial)
  const max = Math.max(...Object.values(c).map((x) => x.total))
  const actual = $('#sel-politica').value
  $('#comparacion').innerHTML = Object.entries(POLITICAS).map(([k, p]) => `
    <div class="comp ${k === actual ? 'actual' : ''}">
      <div class="comp-titulo">${p.titulo}${k === actual ? ' <small>(en uso)</small>' : ''}</div>
      <div class="barra grande"><span class="${k}" style="width:${(100 * c[k].total) / max}%"></span></div>
      <div class="comp-datos"><b>${kb(c[k].total)}</b> almacenados · restaurar hoy requiere <b>${c[k].eslabones}</b> pieza(s)</div>
    </div>`).join('')
}

$('#btn-dia').addEventListener('click', () => ocupado(async () => { await avanzarDia(); pintar() }))
$('#btn-semana').addEventListener('click', () => ocupado(async () => {
  for (let i = 0; i < 7; i++) await avanzarDia()
  pintar()
}))
$('#btn-reiniciar').addEventListener('click', () => ocupado(async () => reiniciar()))
$('#sel-politica').addEventListener('change', () => {
  log(`Política cambiada a: <b>${POLITICAS[$('#sel-politica').value].titulo}</b>.`)
  pintarComparacion()
})
$('#sel-restaurar').addEventListener('change', pintarCadena)

$('#btn-desastre').addEventListener('click', () => ocupado(async () => {
  const clave = $('#sel-desastre').value
  if (clave === 'ransomware') {
    estado.danada = ransomware(estado.db.export())
    log('💥 <b>Ransomware</b>: el archivo de la base quedó cifrado e ilegible.', 'error')
  } else {
    if (estado.danada) throw new Error('La base ya está dañada.')
    DESASTRES[clave].aplicar(estado.db)
    log(`💥 <b>${DESASTRES[clave].titulo}</b>.`, 'error')
  }
  pintar()
}))

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-perder]')
  if (!btn) return
  estado.catalogo = estado.catalogo.filter((b) => b.id !== btn.dataset.perder)
  log(`🗑 El respaldo <code>${btn.dataset.perder}</code> se perdió (disco dañado, borrado por error…).`, 'error')
  pintar()
})

$('#btn-restaurar').addEventListener('click', () => ocupado(async () => {
  const id = $('#sel-restaurar').value
  if (!id) throw new Error('No hay respaldos.')
  const t0 = performance.now()
  // Se trabaja con los paquetes cifrados, como si vinieran del almacenamiento externo.
  const cadena = cadenaDeRestauracion(estado.catalogo, id)
  const abiertos = []
  for (const b of cadena) abiertos.push(await desempaquetar(b.paquete, $('#txt-frase').value))
  const { archivo, ok } = await restaurar(abiertos, id)
  const ms = Math.round(performance.now() - t0)
  if (!ok) throw new Error('El SHA-256 del archivo reconstruido no coincide con el original.')
  const nueva = new SQL.Database(archivo)
  const [integridad] = nueva.exec('PRAGMA integrity_check')
  const esperada = estado.estados.get(id)
  const obtenida = huella(nueva)
  const coincide = JSON.stringify(esperada) === JSON.stringify(obtenida)
  estado.db?.close()
  estado.db = nueva
  estado.danada = null
  const dia = cadena.at(-1).dia
  $('#resultado').innerHTML = `
    <div class="veredicto ${coincide ? 'bien' : 'mal'}">${coincide ? '✔' : '✖'} Base restaurada al cierre del día ${dia}</div>
    <ul class="checks">
      <li>✔ ${cadena.length} paquete(s) descifrados con AES-256-GCM y descomprimidos</li>
      <li>✔ SHA-256 del archivo reconstruido idéntico al original</li>
      <li>${integridad.values[0][0] === 'ok' ? '✔' : '✖'} <code>PRAGMA integrity_check</code>: ${escapar(integridad.values[0][0])}</li>
      <li>${coincide ? '✔' : '✖'} Filas por tabla iguales a las del día ${dia}</li>
      <li>⏱ RTO medido: <b>${ms} ms</b></li>
    </ul>`
  log(`♻️ Restaurado el día ${dia} con ${cadena.length} pieza(s) en ${ms} ms.`, 'ok')
  pintar()
}))

async function iniciar() {
  SQL = await initSqlJs({ locateFile: () => wasmUrl })
  $('#sel-politica').innerHTML = Object.entries(POLITICAS).map(([k, p]) => `<option value="${k}">${p.titulo}</option>`).join('')
  $('#sel-politica').value = 'incremental'
  $('#sel-desastre').innerHTML = [
    ...Object.entries(DESASTRES).map(([k, d]) => `<option value="${k}">${d.titulo}</option>`),
    '<option value="ransomware">Ransomware cifra el archivo</option>',
  ].join('')
  reiniciar()
}

iniciar().catch((e) => log(`No se pudo iniciar SQLite: ${escapar(e.message)}`, 'error'))
