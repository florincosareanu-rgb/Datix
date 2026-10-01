# Integrări

Toate cheile se introduc **în aplicație** (Setări → AI / Integrări). Se salvează **criptat** pe serverul agentului și nu mai pot fi citite înapoi din aplicație. Nu le trimite niciodată pe chat sau pe e-mail.

Peste tot unde se poate, **restricționează cheile la IP-ul VPS-ului** pe care rulează agentul (îl vezi cu `curl -4 ifconfig.me` pe VPS).

După fiecare integrare apasă **„Testează conexiunea”** — mesajul îți spune exact ce lipsește.

---

## DeepSeek (AI)

1. Creează cont pe [platform.deepseek.com](https://platform.deepseek.com).
2. **Top up** — încarcă un credit mic (ex. 5 $). Agentul consumă de obicei câțiva cenți pe zi.
3. **API keys → Create new API key** → copiază cheia (`sk-…`).
4. În aplicație: **Setări → AI (DeepSeek) → Cheie API** → Salvează → Testează conexiunea.

Setări recomandate (implicite):

- Model: **DeepSeek V4 Flash** (rapid, foarte ieftin). Pentru analize grele poți alege V4 Pro.
- Buget lunar: 10 $ (primești notificare la 80%; opțional, agentul se oprește la buget — monitorizarea continuă oricum).

> **Confidențialitate:** DeepSeek procesează cererile pe servere din China. Înainte de trimitere, agentul maschează automat parole, chei, CNP-uri, carduri și IBAN-uri. Detalii în [SECURITATE.md](SECURITATE.md).

---

## WHMCS (my.datix.ro)

### 1. Rol API cu permisiuni minime

WHMCS → **Configurare (⚙) → System Settings → API Roles → Create API Role**, nume „Datix AI”. Bifează **doar** acțiunile:

| Pentru | Acțiuni |
|---|---|
| Tichete | `GetTickets`, `GetTicket`, `AddTicketReply`, `AddTicketNote`, `UpdateTicket`, `GetSupportDepartments` |
| Clienți (context la tichete) | `GetClients`, `GetClientsDetails`, `GetClientsProducts`, `GetClientsDomains` |
| Business | `GetStats`, `GetInvoices`, `GetOrders` |
| Securitate și stare | `WhmcsDetails`, `GetActivityLog`, `GetAdminUsers` |

Agentul **nu** are acces la plăți, rambursări, ștergeri sau modificări de servicii — chiar dacă i s-ar cere.

### 2. Datele de acces API

**System Settings → Manage API Credentials → Generate New API Credential**: alege administratorul și rolul „Datix AI” → copiază **Identifier** și **Secret** în aplicație (Setări → Integrări → WHMCS).

### 3. Restricția de IP

**System Settings → General Settings → Security → API IP Access Restriction** → adaugă IP-ul VPS-ului.

### 4. Setări în aplicație

- Adresa WHMCS: `https://my.datix.ro`
- „Răspunde ca utilizatorul admin”: numele de utilizator al adminului sub care apar răspunsurile.
- Activ: pornit → **Testează conexiunea** (îți arată versiunea WHMCS și departamentele).

### 5. Hook-ul WHMCS (recomandat)

Fără hook, agentul verifică tichetele la 2 minute. Cu hook, află **instant** de tichete noi și răspunsuri, autentificări de admin, comenzi, plăți, cereri de anulare și de rularea cron-ului WHMCS.

1. Aplicația → Setări → Integrări → WHMCS → **Descarcă hook-ul WHMCS** (fișierul `datix_ai.php` conține deja adresa și cheia).
2. Încarcă fișierul în folderul **`includes/hooks/`** al WHMCS (prin DirectAdmin → File Manager, de ex. `/domains/my.datix.ro/public_html/includes/hooks/`).
3. Gata — după următoarea rulare a cron-ului, pe pagina Status verificarea „WHMCS” arată „cron: acum X min”.

Hook-ul trimite doar identificatori (ID tichet, ID client), nu conținutul mesajelor; fiecare cerere este semnată.

---

## DirectAdmin (hostingul datix.ro și my.datix.ro)

Cu DirectAdmin, agentul poate citi logurile de erori, face backup, lucra cu fișierele (cu copie de siguranță înainte de orice modificare) și aplica „trusa de salvare” WordPress când site-ul e căzut.

### Login Key (nu folosi parola contului)

DirectAdmin → **Login Keys** (la utilizator, în secțiunea „Advanced Features”) → **Create Key**:

- Nume: `datix-ai`; valoare: apasă „Generate”; expirare: fără (sau 1 an); utilizări: nelimitat.
- **Allowed IPs:** IP-ul VPS-ului.
- **Comenzi permise** — bifează doar:
  - `CMD_API_LOGIN_TEST`, `CMD_API_SHOW_DOMAINS`, `CMD_API_SHOW_USER_CONFIG`, `CMD_API_SHOW_USER_USAGE`
  - `CMD_API_DNS_CONTROL`, `CMD_API_POP`, `CMD_API_DATABASES`, `CMD_API_SSL`, `CMD_API_SITE_BACKUP`
  - pentru fișiere (managerul nou de fișiere): `filemanager` și `filemanager-actions`

Copiază cheia în aplicație → Setări → Integrări → DirectAdmin, împreună cu:

- Adresa panoului, cu port: ex. `https://server.furnizor.ro:2222`
- Utilizatorul DirectAdmin
- Folderul WordPress: implicit `/domains/datix.ro/public_html`
- Folderul WHMCS: implicit `/domains/my.datix.ro/public_html` (schimbă dacă WHMCS e într-un subfolder)

Testul îți spune dacă accesul la fișiere funcționează.

> Ce poate face agentul fără să te întrebe (doar la incidente, dacă „Reparare automată” e pornită): să citească loguri și fișiere, să activeze captura erorilor PHP, să dezactiveze temporar un plugin defect, să pornească modul mentenanță. Restaurarea unui backup, scrierea de cod PHP sau ștergerile cer **mereu** aprobarea ta cu Face ID.

---

## Pluginul WordPress „Datix AI Connector”

1. Aplicația → Setări → Integrări → WordPress → **Descarcă pluginul WordPress** (arhiva conține deja cheia și adresa agentului; descărcarea activează și integrarea).
2. WordPress (datix.ro/wp-admin) → **Module → Adaugă → Încarcă modul** → alege arhiva → **Activează**.
3. În aplicație: **Testează conexiunea**.

Pluginul adaugă în WordPress pagina **Setări → Datix AI** (stare conexiune, protecții, mod mentenanță, jurnal de securitate).

Ce oferă agentului: starea WordPress, pluginuri și actualizări, audit de securitate (integritatea nucleului, fișiere PHP în uploads, cod malițios), jurnal de autentificări, alerte instant (admin nou, rol schimbat, atac de tip „brute force”, plugin instalat, temă schimbată, fișier de nucleu modificat), golirea cache-ului, modul mentenanță, protecții (XML-RPC, ascunderea utilizatorilor, editorul de fișiere).

Alternativ, cheia se poate pune în `wp-config.php`:

```php
define('DATIX_AI_SECRET', 'cheia-din-aplicatie');   // Setări → Integrări → WordPress → „Arată cheia pluginului”
define('DATIX_AI_AGENT_URL', 'https://ai.datix.ro');
```

---

## Cloudflare

Cloudflare → **My Profile → API Tokens → Create Token → Custom token**:

| Permisiune | Nivel | De ce |
|---|---|---|
| Zone → Zone | Read | identificarea zonei |
| Zone → Zone Settings | Edit | modul „Sub atac” / nivelul de securitate, citirea setărilor SSL |
| Zone → Cache Purge | Purge | golirea cache-ului după reparații |
| Zone → DNS | Read (sau Edit) | verificarea DNS; „Edit” doar dacă vrei ca agentul să poată propune modificări (cu aprobarea ta) |
| Zone → Analytics | Read | atacurile blocate de firewall |

- **Zone Resources:** Include → Specific zone → `datix.ro`.
- **Client IP Address Filtering:** IP-ul VPS-ului.
- Nu folosi „Global API Key”.

În aplicație: Setări → Integrări → Cloudflare → zona `datix.ro` + tokenul → Testează conexiunea.

---

## Google PageSpeed (opțional)

Funcționează și fără cheie, dar Google limitează numărul de verificări. Pentru o cheie gratuită: Google Cloud Console → APIs & Services → activează **PageSpeed Insights API** → Credentials → **Create API key** (restricționează cheia la PageSpeed Insights API).

---

## DirectAdmin Reseller (pentru site-urile clienților — mai târziu)

Funcția e gata, dar **dezactivată** până cumperi pachetul de reseller. Atunci:

1. În panoul de reseller: **Login Keys → Create Key**, limitată la IP-ul VPS-ului, cu comenzile `CMD_API_LOGIN_TEST`, `CMD_API_SHOW_USERS`, `CMD_API_SHOW_USER_CONFIG`, `CMD_API_SHOW_USER_USAGE`, `CMD_API_SHOW_USER_DOMAINS` (și `CMD_API_SELECT_USERS` dacă vrei ca agentul să poată propune suspendări — mereu cu aprobarea ta).
2. Aplicația → Setări → Integrări → **DirectAdmin Reseller**: adresa panoului, utilizatorul, cheia → **Activ** → Testează conexiunea.

Agentul va urmări conturile clienților (spațiu, trafic, conturi suspendate) și le va putea verifica site-urile la cerere.

---

## iPhone: aplicația și notificările

1. Safari → `https://ai.datix.ro` → **Distribuie → Adaugă la ecranul principal**.
2. Deschide **Datix AI** de pe ecranul principal → **Setări → Notificări → Activează notificările** → Permite.
3. **Setări → Securitate cont → Adaugă acest dispozitiv** pentru Face ID (dacă nu l-ai activat la configurare).

Ce notificări primești (le alegi din Setări → Notificări): site căzut / revenit, aprobări cerute de agent, tichete care au nevoie de tine, probleme de securitate grave, raportul zilnic.
