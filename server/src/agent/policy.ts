import type { AgentContext, AppSettings } from '@datix/shared';
import type { AnyTool } from './tools/types';

/** Detalii suplimentare despre rulare (ex. o misiune programată căreia i-ai permis modificări). */
export interface PolicyExtras {
  missionAllowsChanges?: boolean;
}

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'approval'; stepUp: boolean; blocking: boolean; reason: string }
  | { action: 'deny'; reason: string };

/**
 * Matricea de autonomie:
 *
 * | risc / context        | tu (chat)                  | incident automat                    | tichet client          |
 * |-----------------------|----------------------------|-------------------------------------|------------------------|
 * | citire                | da                         | da                                  | da                     |
 * | modificare reversibilă| da (control total)         | da dacă „remediere automată”        | doar note/etichete; restul cere OK |
 * | ireversibilă          | OK cu Face ID (configurabil)| OK cu Face ID (configurabil)        | OK cu Face ID          |
 * | mesaj către client    | OK cu un tap               | nu                                  | prin fluxul de tichete |
 *
 * Misiunile programate (context „mission”) citesc liber; modificările reversibile se fac singure doar dacă
 * le-ai permis la crearea misiunii, altfel sunt trimise spre aprobare; cele ireversibile cer mereu Face ID,
 * iar mesajele către clienți nu sunt permise.
 *
 * Regula pentru tichete e fixă: textul clientului nu e de încredere (prompt injection).
 */
export function decide(tool: AnyTool, context: AgentContext, settings: AppSettings, extras: PolicyExtras = {}): PolicyDecision {
  if (!tool.contexts.includes(context)) return { action: 'deny', reason: 'Unealta nu e disponibilă în acest context.' };
  const a = settings.autonomy;
  switch (tool.risk) {
    case 'read':
      return { action: 'allow' };
    case 'write':
      if (context === 'owner') return { action: 'allow' };
      if (context === 'incident')
        return a.incidentAutoRemediate
          ? { action: 'allow' }
          : { action: 'approval', stepUp: false, blocking: true, reason: 'Remedierea automată e dezactivată în Setări → Autonomie.' };
      if (context === 'ticket')
        return tool.ticketSafe
          ? { action: 'allow' }
          : { action: 'approval', stepUp: false, blocking: false, reason: 'Acțiune propusă în urma unui tichet de client — necesită aprobarea ta.' };
      if (context === 'mission')
        return extras.missionAllowsChanges
          ? { action: 'allow' }
          : { action: 'approval', stepUp: false, blocking: false, reason: 'Acțiune propusă de o misiune programată — necesită aprobarea ta.' };
      return { action: 'deny', reason: 'Rapoartele nu pot modifica nimic.' };
    case 'irreversible':
      if (context === 'owner')
        return a.ownerConfirmIrreversible
          ? { action: 'approval', stepUp: true, blocking: true, reason: 'Acțiune ireversibilă — confirmă cu Face ID.' }
          : { action: 'allow' };
      if (context === 'incident')
        return a.incidentAllowIrreversible
          ? { action: 'allow' }
          : { action: 'approval', stepUp: true, blocking: true, reason: 'Acțiune ireversibilă în timpul unui incident — necesită aprobarea ta.' };
      if (context === 'ticket') return { action: 'approval', stepUp: true, blocking: false, reason: 'Acțiune ireversibilă propusă în urma unui tichet.' };
      if (context === 'mission') return { action: 'approval', stepUp: true, blocking: false, reason: 'Acțiune ireversibilă propusă de o misiune programată.' };
      return { action: 'deny', reason: 'Rapoartele nu pot modifica nimic.' };
    case 'customer_message':
      if (context === 'owner') return { action: 'approval', stepUp: false, blocking: true, reason: 'Mesaj către client — confirmă textul înainte de trimitere.' };
      return { action: 'deny', reason: 'Răspunsurile către clienți se trimit doar prin fluxul de tichete.' };
  }
}
