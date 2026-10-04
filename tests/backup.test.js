import initSqlJs from 'sql.js'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DESASTRES, cadenaDeRestauracion, compararPoliticas, crearBaseDemo, crearRespaldo, desempaquetar,
  empaquetar, hashesDePaginas, huella, ransomware, restaurar, retencionGFS, simularJornada, tamanoPagina,
} from '../src/backup.js'

let SQL
beforeAll(async () => { SQL = await initSqlJs() })

async function semana(politica) {
  const db = crearBaseDemo(SQL)
  const catalogo = []
  const estados = []
  for (let dia = 0; dia < 7; dia++) {
    if (dia > 0) simularJornada(db, dia)
    const tipo = dia === 0 ? 'completo' : politica
    catalogo.push(await crearRespaldo(db.export(), tipo, catalogo, dia))
    estados.push(huella(db))
  }
  return { db, catalogo, estados }
}

describe('respaldos a nivel de página', () => {
  it('lee el tamaño de página de la cabecera SQLite', () => {
    const db = crearBaseDemo(SQL)
    expect(tamanoPagina(db.export())).toBe(4096)
  })

  it('el incremental copia solo las páginas modificadas', async () => {
    const { catalogo } = await semana('incremental')
    const [completo, ...incs] = catalogo
    expect(completo.paginas.length).toBe(completo.numPaginas)
    for (const b of incs) expect(b.paginas.length).toBeLessThan(completo.numPaginas / 2)
  })

  it('el diferencial crece cada día y el incremental no', async () => {
    const { catalogo: dif } = await semana('diferencial')
    const tam = dif.slice(1).map((b) => b.paginas.length)
    expect(tam.at(-1)).toBeGreaterThan(tam[0])
    expect(dif.at(-1).padre).toBe(dif[0].id)
  })

  for (const politica of ['incremental', 'diferencial']) {
    it(`restaura cualquier día con la cadena ${politica}`, async () => {
      const { catalogo, estados } = await semana(politica)
      for (const [k, b] of catalogo.entries()) {
        const { archivo, ok, cadena } = await restaurar(catalogo, b.id)
        expect(ok).toBe(true)
        expect(cadena.length).toBe(politica === 'incremental' ? k + 1 : Math.min(k + 1, 2))
        expect(huella(new SQL.Database(archivo))).toEqual(estados[k])
      }
    })
  }

  it('si se pierde un eslabón incremental, la cadena posterior queda inservible', async () => {
    const { catalogo } = await semana('incremental')
    const sinEslabon = catalogo.filter((b) => b.dia !== 3)
    expect(() => cadenaDeRestauracion(sinEslabon, catalogo[5].id)).toThrow(/completo base/)
  })

  it('recupera la base tras un DELETE masivo y tras ransomware', async () => {
    const { db, catalogo, estados } = await semana('incremental')
    DESASTRES.delete_masivo.aplicar(db)
    expect(huella(db).movimientos.filas).toBe(0)
    expect(() => new SQL.Database(ransomware(db.export())).exec('SELECT 1 FROM movimientos')).toThrow()
    const { archivo, ok } = await restaurar(catalogo, catalogo.at(-1).id)
    expect(ok).toBe(true)
    expect(huella(new SQL.Database(archivo))).toEqual(estados.at(-1))
  })
})

describe('empaquetado seguro', () => {
  it('comprime, cifra y vuelve a abrir el respaldo', async () => {
    const db = crearBaseDemo(SQL)
    const b = await crearRespaldo(db.export(), 'completo', [])
    const { paquete, bytesComprimidos } = await empaquetar(b, 'frase-secreta')
    expect(bytesComprimidos).toBeLessThan(b.bytesCrudos)
    const abierto = await desempaquetar(paquete, 'frase-secreta')
    expect(abierto.paginas.length).toBe(b.paginas.length)
    expect(abierto.paginas[3].datos).toEqual(b.paginas[3].datos)
    expect(abierto.sha256Archivo).toBe(b.sha256Archivo)
  })

  it('rechaza una frase incorrecta o un paquete alterado', async () => {
    const db = crearBaseDemo(SQL)
    const { paquete } = await empaquetar(await crearRespaldo(db.export(), 'completo', []), 'correcta')
    await expect(desempaquetar(paquete, 'otra')).rejects.toThrow(/descifrar/)
    const alterado = paquete.slice()
    alterado[100] ^= 1
    await expect(desempaquetar(alterado, 'correcta')).rejects.toThrow(/descifrar/)
  })
})

describe('políticas y retención', () => {
  it('incremental ocupa menos que diferencial y este menos que completo diario', async () => {
    const db = crearBaseDemo(SQL)
    const historial = []
    for (let dia = 0; dia < 14; dia++) {
      if (dia > 0) simularJornada(db, dia)
      const bytes = db.export()
      historial.push({ dia, hashes: await hashesDePaginas(bytes), tamPagina: tamanoPagina(bytes) })
    }
    const c = compararPoliticas(historial)
    expect(c.incremental.total).toBeLessThan(c.diferencial.total)
    expect(c.diferencial.total).toBeLessThan(c.completo.total)
    expect(c.incremental.eslabones).toBeGreaterThan(c.diferencial.eslabones)
  })

  it('GFS conserva diarios recientes y domingos/meses antiguos', () => {
    const keep = retencionGFS(Array.from({ length: 120 }, (_, i) => i))
    expect(keep.has(119)).toBe(true)
    expect(keep.has(112)).toBe(true)
    expect(keep.has(0)).toBe(true)
    expect(keep.has(50)).toBe(false)
  })
})
