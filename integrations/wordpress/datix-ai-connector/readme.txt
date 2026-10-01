=== Datix AI Connector ===
Contributors: datix
Tags: monitoring, security, maintenance, ai
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.2
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Conectează site-ul WordPress la agentul Datix AI.

== Description ==

Pluginul permite agentului Datix AI să:

* verifice starea WordPress (versiuni, actualizări, setări de siguranță, cron, cache);
* listeze, activeze și dezactiveze pluginuri și să ruleze actualizări (cu aprobarea ta în aplicație);
* facă un audit de securitate: integritatea nucleului, fișiere PHP în uploads, fișiere modificate recent, cod malițios cunoscut;
* păstreze un jurnal de securitate (autentificări, administratori noi, schimbări de rol, pluginuri, teme) și să îți trimită alerte instant;
* pornească modul mentenanță și să golească cache-ul.

Securitate:

* Toate rutele sunt POST și cer o semnătură HMAC-SHA256 cu cheia secretă comună, marcaj de timp (±5 minute) și nonce unic (anti-reluare).
* După 20 de încercări greșite de pe un IP, accesul e blocat 10 minute.
* Fără cheia corectă, nimeni nu poate folosi aceste funcții.

== Installation ==

1. În aplicația Datix AI: Setări → Integrări → WordPress → „Descarcă pluginul WordPress” (arhiva conține deja cheia și adresa agentului).
2. În WordPress: Module → Adaugă → Încarcă modul → alege arhiva → Activează.
3. În aplicația Datix AI apasă „Testează conexiunea”.

Alternativ, poți defini cheia în wp-config.php:

    define('DATIX_AI_SECRET', 'cheia-din-aplicatie');
    define('DATIX_AI_AGENT_URL', 'https://ai.datix.ro');

== Changelog ==

= 1.0.0 =
* Prima versiune.
