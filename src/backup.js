// Núcleo de BlockBackupLab: respaldos completos, diferenciales e incrementales a nivel de página (bloque)
// sobre archivos SQLite reales, con compresión, cifrado AES-256-GCM y verificación SHA-256.
// No usa el DOM: se prueba en Node (Vitest) y se usa tal cual en el navegador.

export const TABLAS = ['almacenes', 'productos', 'movimientos']

export function crearBaseDemo(SQL) {
  const db = new SQL.Database()
  db.exec(`
    PRAGMA page_size = 4096;
    CREATE TABLE almacenes (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, ciudad TEXT NOT NULL);
    CREATE TABLE productos (
      id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL,
      precio REAL NOT NULL CHECK (precio > 0), stock INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE movimientos (
      id INTEGER PRIMARY KEY, producto_id INTEGER NOT NULL REFERENCES productos(id),
      almacen_id INTEGER NOT NULL REFERENCES almacenes(id), tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida')),
      cantidad INTEGER NOT NULL, fecha TEXT NOT NULL, nota TEXT
    );
    CREATE INDEX ix_mov_producto ON movimientos(producto_id);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4)
      INSERT INTO almacenes SELECT i, 'Almacén ' || i,
        CASE i WHEN 1 THEN 'Tacna' WHEN 2 THEN 'Arequipa' WHEN 3 THEN 'Lima' ELSE 'Puno' END FROM n;
  `)
  db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO productos SELECT i, printf('SKU-%05d', i), 'Producto ' || i, 5 + (i * 37) % 400, 50 + (i * 13) % 200 FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
      INSERT INTO movimientos SELECT i, 1 + (i * 7) % 300, 1 + i % 4, CASE WHEN i % 3 = 0 THEN 'salida' ELSE 'entrada' END,
        1 + i % 9, date('2026-01-01', '+' || (i % 270) || ' days'), 'Carga inicial ' || hex(randomblob(8)) FROM n;
  `)
  return db
}

/** Jornada de trabajo: nuevos movimientos (crecen al final) y actualizaciones de stock (cambian páginas viejas). */
export function simularJornada(db, dia, movimientos = 120) {
  const ins = db.prepare(`INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, fecha, nota)
                          VALUES (?, ?, ?, ?, date('2026-10-01', '+' || ? || ' days'), ?)`)
  db.exec('BEGIN')
  for (let k = 0; k < movimientos; k++) {
    const p = 1 + ((dia * 31 + k * 17) % 300)
    ins.run([p, 1 + (k % 4), k % 3 ? 'entrada' : 'salida', 1 + (k % 7), dia, `Día ${dia} · operación ${k + 1}`])
  }
  ins.free()
  db.exec(`UPDATE productos SET stock = stock + 1 WHERE id % 50 = ${dia % 50}`)
  db.exec('COMMIT')
}

export const DESASTRES = {
  delete_masivo: { titulo: 'DELETE FROM movimientos (sin WHERE)', aplicar: (db) => db.exec('DELETE FROM movimientos') },
  drop_tabla: { titulo: 'DROP TABLE productos', aplicar: (db) => db.exec('PRAGMA foreign_keys = OFF; DROP TABLE productos') },
}

/** Simula ransomware: sobrescribe bytes del archivo; el resultado deja de ser una base SQLite válida. */
export function ransomware(bytes) {
  const copia = new Uint8Array(bytes)
  for (let i = 0; i < copia.length; i += 1024) copia[i] ^= 0xa5
  return copia
}

export function huella(db) {
  const out = {}
  for (const t of TABLAS) {
    try {
      const [r] = db.exec(`SELECT count(*), coalesce(sum(id), 0) FROM ${t}`)
      out[t] = { filas: r.values[0][0], suma: r.values[0][1] }
    } catch {
      out[t] = { filas: null, suma: null }
    }
  }
  return out
}

export async function sha256(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Tamaño de página leído de la cabecera del archivo SQLite (offset 16, big-endian; 1 significa 65536). */
export function tamanoPagina(bytes) {
  const v = (bytes[16] << 8) | bytes[17]
  return v === 1 ? 65536 : v
}

export function dividirPaginas(bytes) {
  const tam = tamanoPagina(bytes)
  const paginas = []
  for (let off = 0; off < bytes.length; off += tam) paginas.push(bytes.subarray(off, off + tam))
  return { tam, paginas }
}

/** Huella de cada página: permite saber qué bloques cambiaron sin guardar copias completas. */
export async function hashesDePaginas(bytes) {
  const { paginas } = dividirPaginas(bytes)
  return Promise.all(paginas.map((p) => sha256(p)))
}

let contador = 0

/**
 * Crea un respaldo a partir del archivo actual.
 *  - completo: todas las páginas.
 *  - diferencial: páginas distintas a las del último COMPLETO.
 *  - incremental: páginas distintas a las del respaldo ANTERIOR (de cualquier tipo).
 */
export async function crearRespaldo(bytes, tipo, catalogo, dia = 0) {
  const { tam, paginas } = dividirPaginas(bytes)
  const hashes = await hashesDePaginas(bytes)
  let base = null
  if (tipo === 'diferencial') base = [...catalogo].reverse().find((b) => b.tipo === 'completo')
  if (tipo === 'incremental') base = catalogo.at(-1)
  if (tipo !== 'completo' && !base) throw new Error(`Un respaldo ${tipo} necesita un respaldo completo previo.`)

  const cambiadas = []
  hashes.forEach((h, i) => {
    if (!base || base.hashes[i] !== h) cambiadas.push(i)
  })
  contador += 1
  return {
    id: `${tipo[0].toUpperCase()}${String(contador).padStart(3, '0')}`,
    tipo, dia, fecha: new Date().toISOString(),
    padre: base?.id ?? null,
    tamPagina: tam,
    numPaginas: paginas.length,
    hashes,
    sha256Archivo: await sha256(bytes),
    paginas: cambiadas.map((i) => ({ i, datos: paginas[i].slice() })),
    bytesCrudos: cambiadas.length * tam,
  }
}

/** Respaldos necesarios para restaurar `id`: la cadena completa → (diferencial) o → incrementales. */
export function cadenaDeRestauracion(catalogo, id) {
  const porId = new Map(catalogo.map((b) => [b.id, b]))
  const cadena = []
  let actual = porId.get(id)
  if (!actual) throw new Error(`No existe el respaldo ${id}.`)
  while (actual) {
    cadena.unshift(actual)
    actual = actual.padre ? porId.get(actual.padre) : null
    if (cadena.length > catalogo.length) throw new Error('Cadena de respaldos circular.')
  }
  if (cadena[0].tipo !== 'completo') throw new Error('Falta el respaldo completo base de la cadena.')
  return cadena
}

/** Reconstruye el archivo aplicando la cadena en orden y verifica su SHA-256. */
export async function restaurar(catalogo, id) {
  const cadena = cadenaDeRestauracion(catalogo, id)
  const objetivo = cadena.at(-1)
  const archivo = new Uint8Array(objetivo.numPaginas * objetivo.tamPagina)
  for (const b of cadena) {
    for (const p of b.paginas) {
      if (p.i < objetivo.numPaginas) archivo.set(p.datos, p.i * b.tamPagina)
    }
  }
  const ok = (await sha256(archivo)) === objetivo.sha256Archivo
  return { archivo, cadena, ok }
}

/* ---------- Empaquetado: serialización, compresión y cifrado ---------- */

async function transformar(bytes, stream) {
  const salida = new Blob([bytes]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(salida).arrayBuffer())
}

export const comprimir = (bytes) => transformar(bytes, new CompressionStream('gzip'))
export const descomprimir = (bytes) => transformar(bytes, new DecompressionStream('gzip'))

async function derivarClave(frase, sal) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(frase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: sal, iterations: 600000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Serializa un respaldo a binario: cabecera JSON + páginas concatenadas. */
export function serializar(b) {
  const { paginas, ...meta } = b
  const cab = new TextEncoder().encode(JSON.stringify({ ...meta, indices: paginas.map((p) => p.i) }))
  const out = new Uint8Array(4 + cab.length + paginas.length * b.tamPagina)
  new DataView(out.buffer).setUint32(0, cab.length)
  out.set(cab, 4)
  paginas.forEach((p, k) => out.set(p.datos, 4 + cab.length + k * b.tamPagina))
  return out
}

export function deserializar(bin) {
  const largo = new DataView(bin.buffer, bin.byteOffset).getUint32(0)
  const { indices, ...meta } = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + largo)))
  const ini = 4 + largo
  return { ...meta, paginas: indices.map((i, k) => ({ i, datos: bin.slice(ini + k * meta.tamPagina, ini + (k + 1) * meta.tamPagina) })) }
}

/** gzip + AES-256-GCM (clave PBKDF2). Formato: "BBL1" | sal(16) | iv(12) | texto cifrado. */
export async function empaquetar(b, frase) {
  const comprimido = await comprimir(serializar(b))
  const sal = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await derivarClave(frase, sal), comprimido))
  const out = new Uint8Array(4 + 16 + 12 + cifrado.length)
  out.set(new TextEncoder().encode('BBL1'), 0)
  out.set(sal, 4)
  out.set(iv, 20)
  out.set(cifrado, 32)
  return { paquete: out, bytesComprimidos: comprimido.length }
}

export async function desempaquetar(paquete, frase) {
  if (new TextDecoder().decode(paquete.subarray(0, 4)) !== 'BBL1') throw new Error('Formato de paquete desconocido.')
  const sal = paquete.subarray(4, 20)
  const iv = paquete.subarray(20, 32)
  let plano
  try {
    plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await derivarClave(frase, sal), paquete.subarray(32))
  } catch {
    throw new Error('No se pudo descifrar: frase incorrecta o paquete alterado (AES-GCM detecta cualquier cambio).')
  }
  return deserializar(await descomprimir(new Uint8Array(plano)))
}

/* ---------- Políticas ---------- */

export const POLITICAS = {
  completo: { titulo: 'Completo diario', tipoDelDia: () => 'completo' },
  diferencial: { titulo: 'Completo el domingo + diferencial diario', tipoDelDia: (d) => (d % 7 === 0 ? 'completo' : 'diferencial') },
  incremental: { titulo: 'Completo el domingo + incremental diario', tipoDelDia: (d) => (d % 7 === 0 ? 'completo' : 'incremental') },
}

/**
 * Compara el almacenamiento de las tres políticas a partir de las huellas de página de cada día
 * (sin tener que ejecutar tres veces la simulación).
 */
export function compararPoliticas(historial) {
  const res = {}
  for (const [clave, pol] of Object.entries(POLITICAS)) {
    let total = 0
    let ultimoCompleto = null
    let anterior = null
    const pasos = []
    historial.forEach(({ dia, hashes, tamPagina }) => {
      const tipo = pol.tipoDelDia(dia)
      const base = tipo === 'completo' || !ultimoCompleto ? null : tipo === 'diferencial' ? ultimoCompleto : anterior
      const n = base ? hashes.filter((h, i) => base[i] !== h).length : hashes.length
      if (!base) ultimoCompleto = hashes
      total += n * tamPagina
      anterior = hashes
      pasos.push(n)
    })
    // Eslabones a leer para restaurar el último día con esta política
    const ult = historial.length - 1
    let eslabones = 0
    if (ult >= 0) {
      const tipo = pol.tipoDelDia(historial[ult].dia)
      if (tipo === 'completo') eslabones = 1
      else if (tipo === 'diferencial') eslabones = 2
      else eslabones = (historial[ult].dia % 7) + 1
    }
    res[clave] = { total, pasos, eslabones }
  }
  return res
}

/** Retención GFS: conserva los últimos N diarios, semanales y mensuales (días simulados). */
export function retencionGFS(dias, { diarios = 7, semanales = 4, mensuales = 6 } = {}) {
  const orden = [...dias].sort((a, b) => b - a)
  const keep = new Set(orden.slice(0, diarios))
  const semanas = new Set()
  const meses = new Set()
  for (const d of orden) {
    const s = Math.floor(d / 7)
    if (d % 7 === 0 && !semanas.has(s) && semanas.size < semanales) { semanas.add(s); keep.add(d) }
    const m = Math.floor(d / 30)
    if (!meses.has(m) && meses.size < mensuales && d % 30 === 0) { meses.add(m); keep.add(d) }
  }
  return keep
}
