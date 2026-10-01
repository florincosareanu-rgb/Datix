# Cum funcționează

## Imaginea de ansamblu

```
 iPhone (PWA)  ──HTTPS──▶  Caddy  ──▶  Server DAX (Node.js, un singur proces)
   chat, status,                         ├─ API + flux live (SSE)
   aprobări cu Face ID                   ├─ Agentul AI (bucla model → unelte → model)
   notificări push ◀── Web Push ─────────├─ Monitorizare (verificări la 5 s – 24 h)
                                         ├─ Incidente (deschidere, investigație, raport)
                                         ├─ Tichete (webhook + verificare periodică)
                                         ├─ Rapoarte, business, notificări
                                         └─ SQLite (date/datix.db, copie zilnică)
                                                │
         ┌───────────────┬───────────────┬──────┴────────┬───────────────┬──────────────┐
      DeepSeek         WHMCS        DirectAdmin       Cloudflare      WordPress      Internet
      (AI)          (API + hook)   (Login Key)        (API token)   (plugin Datix)  (HTTP, DNS,
                                                                                    TLS, RDAP…)
```

## Agentul

Agentul e o buclă: modelul (DeepSeek) primește contextul și lista de unelte, cere unelte, serverul le execută și îi trimite rezultatele, până la răspunsul final. Particularități:

- **Contexte** cu reguli diferite: chat cu tine, incident automat, tichet de client, raport (`server/src/agent/policy.ts`).
- **Unelte** declarate cu schemă (zod) și nivel de risc: citire, modificare reversibilă, ireversibilă, mesaj către client (`server/src/agent/tools/`). peste 80 de unelte: verificări web/DNS/SSL, WordPress, trusa de salvare, DirectAdmin, Cloudflare, WHMCS, reseller, cunoștințe, memorie.
- **Aprobări**: o unealtă riscantă devine o cerere de aprobare (card în chat + notificare); după aprobare (cu Face ID unde e cazul), rularea continuă de unde a rămas.
- **Mascare** a datelor sensibile și marcarea conținutului extern ca nesigur, înainte de a ajunge la model.
- **Cost**: fiecare cerere e contorizată (tokeni, cache, cost); buget lunar cu alertă și oprire opțională.

## Monitorizare și incidente

Verificări implicite (se pot pune pe pauză din Setări → Monitorizare):

| Verificare | Interval |
|---|---|
| datix.ro și my.datix.ro (HTTP, timp de răspuns, cuvânt-cheie, erori WordPress/PHP, pagini Cloudflare) | 1 min (configurabil) |
| Pagini suplimentare (din Setări → Site-uri) | 2 min |
| DNS (modificări, SPF/DMARC) | 15 min |
| Starea WordPress și a WHMCS (actualizări, cron, administratori) | 15 min |
| Tichete noi (plasă de siguranță; cu hook-ul WHMCS afli instant) | 2 min |
| Cifre de business, resursele contului DirectAdmin, atacuri blocate de Cloudflare | 1 h |
| Certificate SSL (prin Cloudflare: 6 h; direct pe server: 12 h), liste negre e-mail | 6–12 h |
| Expirarea domeniului (RDAP / WHOIS .ro), PageSpeed, vulnerabilități WordPress, scanarea de securitate | 24 h |

Când un site nu răspunde corect de 2 ori la rând se deschide un **incident**: primești notificare, iar agentul investighează imediat (direct pe server, ocolind Cloudflare, loguri de erori, captură de erori PHP), aplică reparații reversibile dacă ai permis asta, verifică revenirea și scrie **raportul post-incident**. Incidentul se închide după 2 verificări reușite; dacă durează, primești reamintiri (cu interval tot mai mare).

**Trusa de salvare WordPress** funcționează chiar și când WordPress e complet căzut: prin DirectAdmin se scrie un mu-plugin generat dintr-un șablon fix, care poate dezactiva temporar pluginuri, comuta pe o temă sigură, captura erorile PHP într-un fișier privat sau afișa pagina de mentenanță. Ștergerea fișierului anulează totul.

## Tichete

1. Tichet nou / răspuns de la client → hook-ul WHMCS anunță instant agentul (sau verificarea periodică îl găsește).
2. Agentul analizează (fără unelte de modificare): categorie, urgență, ton, ce vrea clientul; verifică problema (site, DNS, e-mail, servicii) și caută în baza de cunoștințe.
3. Reguli fixe + analiza AI decid escaladarea (bani, anulări, modificări de cont, reclamații, încredere scăzută).
4. După mod: **Oprit** — doar notificare; **Ciornă** — răspuns propus, îl trimiți tu; **Automat** — trimite singur răspunsurile sigure (opțional doar noaptea și în weekend), cu semnătura „Echipa Datix” și nota AI.

## Structura codului

```
server/src/
  agent/          bucla agentului, politici, aprobări, conversații, unelte
  auth/           parolă, 2FA, passkey-uri, sesiuni
  crypto/         criptarea cheilor, semnături HMAC
  db/             SQLite + migrații
  demo/           simulări pentru modul demo și teste
  http/           API (Fastify), webhook-uri, descărcări
  integrations/   WHMCS, DirectAdmin, Cloudflare, WordPress, PageSpeed, rețea
  knowledge/      baza de cunoștințe, memoria agentului, copii de fișiere
  llm/            clientul DeepSeek (streaming, cost, buget)
  monitoring/     verificări, incidente, constatări de securitate, business
  notifications/  Web Push
  reports/        raportul zilnic
  tickets/        fluxul de tichete
web/src/          aplicația PWA (React)
integrations/     pluginul WordPress, hook-ul WHMCS
```

## Dezvoltare

```bash
npm install
DEMO_MODE=true npm run dev     # server pe :3000, aplicația pe :5173
npm test                        # teste (unitare, flux agent, HTTP, compatibilitate PHP)
npm run typecheck && npm run build
```

În modul demo, din pagina **Status** poți porni scenariul „Simulează o cădere a datix.ro” și urmări cum agentul găsește și dezactivează pluginul defect.
