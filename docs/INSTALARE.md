# Instalare

Durata: aproximativ 20 de minute.

## De ce ai nevoie

1. **Un VPS mic**, separat de hostingul site-ului: 1 vCPU, 1 GB RAM, 10 GB disc, Ubuntu 24.04 / 22.04 sau Debian 12. Orice furnizor (Hetzner, DigitalOcean, un VPS din România etc.).
   - De ce separat: dacă hostingul site-ului are o problemă, agentul trebuie să rămână în picioare ca să o vadă și să o repare.
2. **Un subdomeniu** pentru aplicație, de exemplu `ai.datix.ro`, cu o înregistrare DNS de tip **A** către IP-ul VPS-ului.
   - În Cloudflare: lasă la început norul **gri** („DNS only”), ca certificatul HTTPS să se emită fără probleme. Îl poți face portocaliu ulterior (SSL/TLS → „Full (strict)”).
3. **Un iPhone cu iOS 16.4 sau mai nou** (pentru notificări).

## 1. Instalarea pe VPS

Conectează-te la VPS (`ssh root@IP-UL-VPS`) și rulează:

```bash
apt update && apt install -y git
git clone https://github.com/florincosareanu-rgb/Datix.git /opt/datix-ai
cd /opt/datix-ai
sudo bash deploy/install.sh
```

> **Depozit privat?** Creează pe GitHub un token „fine-grained” doar cu permisiunea *Contents: Read-only* pentru acest depozit și clonează cu
> `git clone https://TOKEN@github.com/florincosareanu-rgb/Datix.git /opt/datix-ai`.

Scriptul:

- instalează Docker (dacă lipsește);
- te întreabă domeniul (ex. `ai.datix.ro`) și e-mailul pentru certificat;
- generează fișierul `.env` cu **cheia principală de criptare** (`APP_SECRET_KEY`);
- pornește aplicația și Caddy (HTTPS automat, reînnoit singur);
- îți afișează adresa de configurare: `https://ai.datix.ro/setup?token=…`.

> **Important:** salvează o copie a fișierului `/opt/datix-ai/.env` într-un loc sigur (de ex. managerul de parole). Fără `APP_SECRET_KEY`, cheile API salvate în aplicație nu mai pot fi citite.

## 2. Prima configurare (de pe iPhone)

1. Deschide în **Safari** adresa afișată la final (`https://ai.datix.ro/setup?token=…`).
2. Creează contul: nume, e-mail, parolă (minim 12 caractere).
3. Scanează codul QR cu o aplicație de autentificare (pe iPhone: aplicația **Parole** → Coduri de verificare, sau Google/Microsoft Authenticator) și introdu codul.
4. **Salvează codurile de recuperare** (fiecare merge o singură dată, dacă pierzi telefonul).
5. Activează **Face ID**.

## 3. Aplicația pe ecranul principal + notificări

1. În Safari: butonul **Distribuie** → **Adaugă la ecranul principal**.
2. Deschide **Datix AI** de pe ecranul principal (nu din Safari).
3. **Setări → Notificări → Activează notificările** → Permite.
4. Apasă „Trimite o notificare de test”.

## 4. Conectarea serviciilor

Urmează **[INTEGRARI.md](INTEGRARI.md)**, în ordinea:

1. DeepSeek (creierul agentului)
2. WHMCS + hook-ul WHMCS
3. DirectAdmin
4. Pluginul WordPress
5. Cloudflare
6. (opțional) PageSpeed; Reseller — când îl cumperi

## Actualizare

```bash
cd /opt/datix-ai
sudo bash deploy/update.sh
```

Face o copie a bazei de date, descarcă ultima versiune și repornește aplicația. Datele și setările rămân.

## Copii de siguranță

- Baza de date are **copie automată în fiecare noapte** (03:40) în `/opt/datix-ai/data/backups/` (ultimele 14).
- Recomandat: copiază periodic `data/` și `.env` și în afara serverului.

**Restaurare:**

```bash
cd /opt/datix-ai
docker compose stop app
cp data/backups/FISIERUL-DORIT.db data/datix.db
rm -f data/datix.db-wal data/datix.db-shm
docker compose start app
```

## Comenzi utile

```bash
docker compose ps              # starea
docker compose logs -f app     # jurnalul aplicației
docker compose restart app     # repornire
docker compose down            # oprire
```

## Probleme frecvente

| Problemă | Soluție |
|---|---|
| Certificatul HTTPS nu se emite | Verifică înregistrarea A a domeniului (trebuie să indice IP-ul VPS-ului) și că porturile 80/443 sunt deschise. Cu Cloudflare, lasă norul gri până se emite certificatul. Vezi `docker compose logs caddy`. |
| Face ID nu apare | Face ID merge doar pe adresa finală HTTPS (nu pe IP). Verifică `APP_URL` din `.env`. |
| Nu primesc notificări | Aplicația trebuie deschisă de pe ecranul principal, iOS 16.4+, notificări permise în Configurări → Notificări → Datix AI. |
| Am uitat parola | Te autentifici cu Face ID sau cu parola + un cod de recuperare, apoi o schimbi din Setări → Securitate cont. |
| Am pierdut telefonul | Parolă + cod de recuperare, apoi șterge vechiul passkey din Setări → Securitate cont. |

## Variabile din `.env`

| Variabilă | Rol |
|---|---|
| `DOMAIN`, `ACME_EMAIL` | Domeniul și e-mailul pentru certificatul HTTPS |
| `APP_URL` | Adresa publică (ex. `https://ai.datix.ro`) |
| `APP_SECRET_KEY` | Cheia principală de criptare — nu o schimba după instalare |
| `SETUP_TOKEN` | Codul pentru prima configurare |
| `TZ` | Fusul orar (implicit `Europe/Bucharest`) |
| `DEEPSEEK_API_KEY` etc. | Opțional — alternativă la introducerea cheilor din aplicație |
