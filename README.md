# Datix AI

Agent AI de operațiuni pentru **datix.ro** (WordPress) și **my.datix.ro** (WHMCS), cu aplicație de chat instalabilă pe iPhone (PWA).

Vorbești cu el ca în Claude, iar în fundal agentul:

- **monitorizează** site-urile la fiecare minut: disponibilitate, viteză, conținut, SSL, DNS, expirarea domeniului, liste negre, scor PageSpeed;
- **rezolvă incidentele**: când pică site-ul, investighează imediat (direct și ocolind Cloudflare), citește erorile PHP, dezactivează temporar pluginul defect, verifică revenirea și scrie raportul post-incident;
- **păzește securitatea**: vulnerabilități WordPress cunoscute, integritatea fișierelor nucleului, cod malițios, administratori noi, autentificări suspecte, atacuri blocate de Cloudflare, antete de securitate;
- **răspunde la tichete** pe my.datix.ro, cu un comutator în 3 moduri: **Oprit / Ciornă / Automat** (opțional doar noaptea și în weekend). Banii, anulările, modificările de cont și reclamațiile ajung **mereu** la tine;
- îți arată **cifrele de business** din WHMCS (încasări, comenzi, facturi restante) și resursele contului de hosting;
- îți trimite **notificări pe iPhone** și un **raport zilnic**.

Acțiunile ireversibile (restaurarea unui backup, modificări DNS, actualizări, suspendări) se fac **doar cu aprobarea ta, confirmată cu Face ID**. Fiecare acțiune a agentului apare în jurnal.

## Componente

| Componentă | Ce face |
|---|---|
| `server/` | Serverul (Node.js 22, Fastify, SQLite): agentul, monitorizarea, tichetele, API-ul, notificările push |
| `web/` | Aplicația PWA (React): chat, status, incidente, securitate, tichete, business, setări |
| `shared/` | Tipurile comune server ↔ aplicație |
| `integrations/wordpress/datix-ai-connector/` | Pluginul WordPress „Datix AI Connector” |
| `integrations/whmcs/datix_ai.php` | Hook-ul WHMCS (tichete și evenimente instant) |
| `deploy/` | Instalare cu o comandă (Docker + HTTPS automat cu Caddy) |
| `docs/` | Documentația |

## Instalare

Pe un VPS mic (1 vCPU, 1 GB RAM, Ubuntu 24.04 / Debian 12), cu un subdomeniu (ex. `ai.datix.ro`) îndreptat spre el:

```bash
git clone https://github.com/florincosareanu-rgb/Datix.git /opt/datix-ai
cd /opt/datix-ai
sudo bash deploy/install.sh
```

Pașii compleți, inclusiv instalarea pe iPhone: **[docs/INSTALARE.md](docs/INSTALARE.md)**.
Conectarea DeepSeek, WHMCS, DirectAdmin, Cloudflare și WordPress: **[docs/INTEGRARI.md](docs/INTEGRARI.md)**.

## Încearcă local (mod demo)

Fără chei și fără servere reale — datele și AI-ul sunt simulate, dar fluxurile sunt cele adevărate (inclusiv scenariul în care site-ul cade și agentul îl repară):

```bash
npm install
DEMO_MODE=true npm run dev
```

Deschide http://localhost:5173. Codul de instalare apare în terminal.

## Dezvoltare

```bash
npm run typecheck   # verificarea tipurilor (server + aplicație)
npm test            # testele automate (inclusiv compatibilitatea semnăturilor cu codul PHP)
npm run build       # construiește aplicația și serverul
npm run php:lint    # verifică sintaxa pluginului WordPress și a hook-ului WHMCS
```

## Documentație

- [Instalare și actualizare](docs/INSTALARE.md)
- [Integrări](docs/INTEGRARI.md)
- [Securitate și confidențialitate](docs/SECURITATE.md)
- [Cum funcționează (arhitectură)](docs/ARHITECTURA.md)
