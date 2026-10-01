#!/usr/bin/env bash
# Instalează DAX pe un VPS Ubuntu/Debian curat, cu Docker și HTTPS automat (Caddy).
#
# Folosire (din folderul proiectului):
#   sudo bash deploy/install.sh
#
# Ce face:
#   1. instalează Docker (dacă lipsește);
#   2. te întreabă domeniul aplicației (ex. dax.datix.ro) și e-mailul pentru certificat;
#   3. creează fișierul .env cu o cheie de criptare generată aleator;
#   4. pornește aplicația și îți afișează adresa pentru prima configurare.
# Rularea repetată e sigură: păstrează .env și datele existente.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Rulează cu sudo: sudo bash deploy/install.sh"
[ -f "$ROOT/docker-compose.yml" ] || fail "Rulează scriptul din folderul proiectului DAX."

bold "DAX — instalare"

# ------------------------------------------------------------------ 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  info "Instalez Docker…"
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; }
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "Lipsește „docker compose”. Instalează pluginul docker-compose-plugin și reîncearcă."
systemctl enable --now docker >/dev/null 2>&1 || true
info "Docker: $(docker --version)"

# ------------------------------------------------------------------ 2. configurare (.env)
# N octeți aleatori, în hex (2N caractere)
random_key() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

if [ ! -f .env ]; then
  read -r -p "  Domeniul aplicației [dax.datix.ro]: " DOMAIN
  DOMAIN="${DOMAIN:-dax.datix.ro}"
  read -r -p "  E-mail pentru certificatul HTTPS [contact@datix.ro]: " ACME_EMAIL
  ACME_EMAIL="${ACME_EMAIL:-contact@datix.ro}"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "Domeniu invalid: $DOMAIN"

  cp .env.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" .env
  sed -i "s|^APP_URL=.*|APP_URL=https://${DOMAIN}|" .env
  sed -i "s|^APP_SECRET_KEY=.*|APP_SECRET_KEY=$(random_key 32)|" .env
  sed -i "s|^SETUP_TOKEN=.*|SETUP_TOKEN=$(random_key 12)|" .env
  chmod 600 .env
  info "Am creat .env (cheia de criptare e generată aleator — păstrează o copie a fișierului într-un loc sigur)."
else
  info "Folosesc .env existent."
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${APP_SECRET_KEY:-}" ] || fail "APP_SECRET_KEY lipsește din .env."

# ------------------------------------------------------------------ 3. verificări
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -n "$PUBLIC_IP" ] && [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  warn "Domeniul ${DOMAIN} indică spre „${DNS_IP:-nimic}”, iar serverul are IP-ul ${PUBLIC_IP}."
  warn "Creează în DNS (ex. Cloudflare) o înregistrare A: ${DOMAIN} → ${PUBLIC_IP} (fără proxy portocaliu la început)."
  warn "Certificatul HTTPS se obține automat după ce DNS-ul e corect."
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
  info "Firewall: am deschis porturile 80 și 443."
fi

# aplicația rulează în container ca utilizatorul „node” (uid 1000)
install -d -m 700 -o 1000 -g 1000 data data/backups
chown -R 1000:1000 data

# ------------------------------------------------------------------ 4. pornire
info "Construiesc și pornesc aplicația (prima dată durează câteva minute)…"
docker compose up -d --build

info "Aștept să pornească…"
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[ "${READY:-0}" = 1 ] || { docker compose logs --tail 50 app; fail "Aplicația nu a pornit. Vezi mesajele de mai sus."; }

echo
bold "Gata! DAX rulează."
echo
echo "  1. Deschide pe iPhone, în Safari:"
echo "       https://${DOMAIN}/setup?token=${SETUP_TOKEN}"
echo "     (codul de instalare: ${SETUP_TOKEN})"
echo "  2. Creează contul, scanează codul 2FA și activează Face ID."
echo "  3. Distribuie → Adaugă la ecranul principal, apoi activează notificările din Setări."
echo "  4. În Setări: cheia DeepSeek, WHMCS, DirectAdmin, Cloudflare și pluginul WordPress."
echo
echo "  Actualizare ulterioară:  sudo bash deploy/update.sh"
echo "  Jurnal:                  docker compose logs -f app"
echo
