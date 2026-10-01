import type { EscalationReason } from '@datix/shared';

// Plasă de siguranță deterministă: chiar dacă AI-ul greșește, aceste subiecte ajung la proprietar.
// Textul e normalizat (fără diacritice, litere mici) înainte de potrivire.

export const normalizeText = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ș|ş/g, 's')
    .replace(/ț|ţ/g, 't');

const PATTERNS: Record<Exclude<EscalationReason, 'low_confidence' | 'auto_reply_limit' | 'other'>, RegExp> = {
  money:
    /\b(factur\w*|plat(a|ii|ile|esc|it|iti|ita)\b|platit\w*|ramburs\w*|refund\w*|invoice\w*|payment\w*|chargeback|reducer\w*|discount\w*|banii|chitant\w*|restant\w*|scadent\w*|credit (in cont|returnat)|bani (inapoi|returnati))/,
  cancellation:
    /\b(anul(ez|ati|eaza|are|area|at)\w*|reziliez|reziliere\w*|cancel\w*|terminate\w*|(sterg|stergeti|sterge)\w* (contul|datele|site-ul|serviciul)|inchid\w* (contul|serviciul)|renunt\w*|(mut|mutam|transfer\w*) (la|catre) (alt|un alt) (furnizor|hosting|provider))/,
  account_change:
    /\b(reset\w* (a )?parol\w*|reset\w* (the |my )?password|parol\w* nou\w*|schimb\w* parol\w*|restaur\w*|restore\w*|nameserver\w*|servere(le)? de nume|modific\w* (dns|zona dns|inregistrar\w* dns)|schimb\w* dns|change (the )?dns|cod(ul)? epp|epp code|auth ?code|cod(ul)? de autorizare|transfer\w* (de |al )?domeniu\w*|upgrade\w*|downgrade\w*|schimb\w* (de )?pachet\w*|schimb\w* (adresa de )?e-?mail(ul)? (contului|de cont))/,
  complaint_legal:
    /\b(reclama(t|tie|tia|tii)\w*|plangere\w*|nemultumit\w*|inacceptabil\w*|bataie de joc|avocat\w*|instant(a|e)\b|anpc|gdpr|date(le)? personale|protectia datelor|despagubir\w*|lawyer|legal action|complaint\w*|teapa|inselat\w*|fraud\w*|ma plang|va dau in judecata)/,
};

export function detectEscalation(text: string): EscalationReason[] {
  const t = normalizeText(text);
  return (Object.keys(PATTERNS) as Array<keyof typeof PATTERNS>).filter((k) => PATTERNS[k].test(t));
}

/** Răspunsuri automate (out-of-office etc.) — nu le răspundem automat, ca să evităm buclele. */
export function looksLikeAutoReply(subject: string, body: string): boolean {
  const t = normalizeText(`${subject}\n${body.slice(0, 500)}`);
  return /(out of office|auto(matic)?[ -]?reply|autoreply|raspuns automat|sunt in concediu|i am (currently )?out of|vacation|mailer-daemon|delivery status notification|undeliverable|nu pot raspunde momentan)/.test(t);
}
