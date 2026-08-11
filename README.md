# Radar de Empleo

Página estática de búsqueda de empleo (multinacionales con presencia en Colombia) + scanner que la actualiza a diario vía Workday public API.

- `index.html` — la página (GitHub Pages)
- `scanner/scan.mjs` — scanner (Node ≥18, sin dependencias)
- `data/` — vacantes y reporte del último scan

Los datos personales del usuario (tracker, perfil) viven únicamente en localStorage del navegador.
