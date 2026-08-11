#!/usr/bin/env bash
# Radar de Empleo — scan diario + push a GitHub Pages (corre en segebre-server)
# Instalación: crontab -e →  0 12 * * *  ~/job-radar-cron.sh >> ~/worker-logs/job-radar-cron.log 2>&1
# (12:00 UTC = 07:00 Bogotá)
set -euo pipefail
REPO="$HOME/job-radar"
cd "$REPO"
git pull --ff-only
node scanner/scan.mjs
if ! git diff --quiet -- data/; then
  git add data/jobs.json data/seen.json data/scan-report.json
  git commit -m "scan $(TZ=America/Bogota date +%F)"
  git push
  echo "[$(date -u +%FT%TZ)] scan pushed"
else
  echo "[$(date -u +%FT%TZ)] scan sin cambios"
fi
