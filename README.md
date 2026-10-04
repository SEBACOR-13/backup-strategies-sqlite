# 🧱 BlockBackupLab — Completo, diferencial e incremental a nivel de bloque

[![CI/CD - GitHub Pages](https://github.com/SEBACOR-13/backup-strategies-sqlite/actions/workflows/deploy.yml/badge.svg)](https://github.com/SEBACOR-13/backup-strategies-sqlite/actions/workflows/deploy.yml)
[![Simulacro semanal de restauración](https://github.com/SEBACOR-13/backup-strategies-sqlite/actions/workflows/simulacro.yml/badge.svg)](https://github.com/SEBACOR-13/backup-strategies-sqlite/actions/workflows/simulacro.yml)

**Demo en vivo:** <https://sebacor-13.github.io/backup-strategies-sqlite/>

Simulador para comparar las políticas de respaldo **completo**, **diferencial** e **incremental**
sobre un archivo **SQLite real** (sql.js / WebAssembly). Los respaldos se calculan por **páginas de 4 KB**:
se obtiene el SHA-256 de cada página y solo se copian las que cambiaron, igual que las herramientas de
respaldo por bloques (pgBackRest *block incremental*, Litestream, Restic, Borg).

## Qué incluye

- Calendario simulado: cada día se registran movimientos de inventario y se ejecuta el respaldo programado.
- Tres políticas: *completo diario*, *completo dominical + diferencial*, *completo dominical + incremental*.
- Comparación en vivo del **almacenamiento** de cada política y de las **piezas** necesarias para restaurar.
- Cada respaldo se **comprime (gzip)** y se **cifra con AES-256-GCM** (clave derivada con PBKDF2-SHA-256, 600 000 iteraciones según OWASP).
- Desastres: `DELETE` sin `WHERE`, `DROP TABLE` y **ransomware** que cifra el archivo.
- Restauración desde los paquetes cifrados con verificación **SHA-256**, `PRAGMA integrity_check` y conteo de filas.
- Botón 🗑 para "perder" un respaldo y ver cómo se **rompe la cadena incremental**.
- Retención **GFS** (7 diarios, 4 semanales, 6 mensuales).

## Desarrollo

```bash
npm ci
npm test        # 11 pruebas: cadenas, cifrado, ransomware, políticas y GFS
npm run dev
npm run build
```

## Automatización

- `deploy.yml`: pruebas → build → **GitHub Pages** → prueba de humo, en cada push a `main`.
- `simulacro.yml`: cada lunes repite el simulacro de restauración completo.

## Autor

Sebastian Alejandro Cortez Apaza — Base de Datos II, Universidad Privada de Tacna (2026).

Licencia MIT.
