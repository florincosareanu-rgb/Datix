#!/usr/bin/env bash
# Actualizează Datix AI la ultima versiune de pe GitHub și repornește aplicația.
# Datele (data/) și configurarea (.env) rămân neschimbate; baza de date are copie zilnică în data/backups.
#
# Folosire: sudo bash deploy/update.sh

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Lipsește .env — rulează întâi deploy/install.sh" >&2; exit 1; }

echo "• Copie de siguranță a bazei de date…"
install -d -m 700 -o 1000 -g 1000 data/backups
if [ -f data/datix.db ]; then
  docker compose exec -T app node -e "
    const Database = require('better-sqlite3');
    const db = new Database('/data/datix.db');
    db.exec(\"VACUUM INTO '/data/backups/inainte-de-update-$(date +%Y%m%d-%H%M%S).db'\");
  " 2>/dev/null || cp data/datix.db "data/backups/inainte-de-update-$(date +%Y%m%d-%H%M%S).db"
fi

echo "• Descarc ultima versiune…"
git pull --ff-only

echo "• Reconstruiesc și repornesc…"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

echo "✓ Actualizat. Jurnal: docker compose logs -f app"
