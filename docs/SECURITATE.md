# Securitate și confidențialitate

Agentul are acces la hostingul, WordPress-ul, WHMCS-ul și Cloudflare-ul firmei, deci aplicația e construită pornind de la ideea că **orice cheie poate fi ținta unui atac** și că **textul venit din afară (tichete, pagini web, loguri) nu e de încredere**.

## Accesul la aplicație

- **Un singur cont** (al tău), creat la prima pornire cu un cod de instalare afișat doar pe server.
- **Parolă** (minim 12 caractere, stocată cu scrypt) **+ cod 2FA** (TOTP, cu protecție la reutilizarea codului) sau **Face ID** (passkey WebAuthn, legat de domeniul aplicației — nu poate fi „furat” printr-un site fals).
- **8 coduri de recuperare**, fiecare de unică folosință.
- **Sesiuni** în cookie `HttpOnly`, `Secure`, `SameSite=Strict`, valabile 30 de zile de la ultima folosire; le vezi și le închizi din Setări → Securitate cont.
- **Confirmare suplimentară** (Face ID sau cod 2FA, valabilă 5 minute) pentru: schimbarea cheilor API, a modelului AI, a regulilor de autonomie, descărcarea pluginului/hook-ului, aprobarea acțiunilor ireversibile.
- Blocare temporară după încercări greșite; limită de cereri pe minut.
- Protecții web: antet anti-CSRF + verificarea originii la orice modificare, Content-Security-Policy strictă, HSTS, `X-Frame-Options: DENY`, fără cache pentru datele API.

## Cheile API

- Criptate cu **AES-256-GCM**; cheia de criptare e derivată (HKDF) din `APP_SECRET_KEY`, care stă doar în `.env` pe server.
- Cheile introduse de tine (DeepSeek, WHMCS, DirectAdmin, Cloudflare) **nu sunt returnate niciodată** de aplicație — vezi doar dacă sunt setate și ultimele 4 caractere. Singurele chei care pot fi afișate sunt cele generate de aplicație pentru plugin și hook, și doar după confirmare.
- Recomandat: chei **cu permisiuni minime** și **restricționate la IP-ul VPS-ului** (vezi [INTEGRARI.md](INTEGRARI.md)).

## Ce poate face agentul (autonomie)

| Acțiune | În chat cu tine | La incidente (automat) | La tichete |
|---|---|---|---|
| Citire (loguri, stări, setări) | da | da | da |
| Reparații reversibile, cu backup înainte | da | da, dacă „Reparare automată” e pornită | doar propune |
| Ireversibile (restaurare backup, DNS, actualizări, ștergeri, cod PHP) | cu Face ID | cu Face ID | doar propune |
| Mesaje către clienți | după ce confirmi textul | nu | conform modului Tichete |

Regulile sunt aplicate în cod (`server/src/agent/policy.ts`), nu „rugăminți” către AI.

### Protecția împotriva manipulării (prompt injection)

- Tot ce vine din afară — tichete, pagini web, loguri, fișiere — e marcat ca **date nesigure** și nu poate da instrucțiuni agentului.
- Când agentul lucrează la un tichet, **nu are unelte de modificare**: poate doar citi și propune. Un client nu poate convinge agentul să șteargă, să modifice sau să trimită ceva.
- **Escaladarea e dublă**: pe lângă analiza AI, o regulă fixă detectează bani, anulări, modificări de cont și reclamații — acestea ajung mereu la tine, chiar în modul Automat.
- Limite anti-buclă: maximum 2 răspunsuri automate pe tichet pe zi, nu se răspunde la mesaje automate („out of office”), pauză automată la avalanșe de tichete.

### Modificări de fișiere

- Înainte de orice modificare pe hosting, agentul salvează o **copie a fișierului** (Setări → Jurnal → Copii de siguranță).
- Agentul nu poate scrie cod PHP fără aprobarea ta; „trusa de salvare” WordPress e un fișier generat din **șablon fix** (nu cod scris de AI) și se anulează ștergându-l.
- Agentul refuză să scrie înapoi un fișier care conține valori mascate (ca să nu strice, de exemplu, `wp-config.php`).

### Jurnal

Fiecare acțiune — a ta, a agentului și a sistemului — e înregistrată (Setări → Jurnal) și nu poate fi modificată din aplicație.

## Comunicarea cu WordPress și WHMCS

- Pluginul WordPress și hook-ul WHMCS folosesc **semnături HMAC-SHA256** cu o cheie secretă comună, marcaj de timp (±5 minute) și **nonce unic** (o cerere interceptată nu poate fi retrimisă).
- Pluginul blochează un IP după 20 de semnături greșite.
- Hook-ul WHMCS trimite doar identificatori, nu conținutul mesajelor sau date personale.
- Compatibilitatea semnăturilor Node ↔ PHP e verificată de testele automate.

## Date personale și AI (GDPR)

- Spre DeepSeek pleacă doar ce e necesar pentru sarcina curentă. Înainte de trimitere se **maschează automat**: parole, chei și tokenuri, chei private, secretele din `wp-config.php` / `configuration.php`, **CNP-uri** (validate), **numere de card** (validate Luhn), **IBAN-uri**.
- Numele și e-mailurile clienților din tichete **pot** ajunge la DeepSeek, care procesează datele pe servere din **China** (transfer în afara SEE). Recomandări:
  - menționează în Politica de confidențialitate că folosești un asistent AI pentru suport și monitorizare;
  - dacă preferi procesare în UE, schimbă „Adresa API” (Setări → AI → Avansat) cu un furnizor european compatibil cu API-ul DeepSeek;
  - modul **Oprit** la tichete împiedică trimiterea tichetelor către AI.
- Datele aplicației (conversații, jurnale, rapoarte) stau **doar pe VPS-ul tău**, în baza de date locală, cu copie zilnică.

## Recomandări

- Păstrează o copie a `.env` (conține `APP_SECRET_KEY`) într-un loc sigur, în afara serverului.
- Activează 2FA și pe conturile WHMCS, DirectAdmin și Cloudflare.
- Actualizează aplicația periodic (`sudo bash deploy/update.sh`).
- Dacă suspectezi o compromitere: șterge cheile din Setări → Integrări, revocă-le la sursă (WHMCS, DirectAdmin, Cloudflare, DeepSeek), schimbă parola, închide celelalte sesiuni și regenerează cheia pluginului și a hook-ului.
