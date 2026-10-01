import { describe, expect, it } from 'vitest';
import { detectEscalation, looksLikeAutoReply } from '../src/tickets/escalation';

describe('escaladarea obligatorie a tichetelor', () => {
  it.each([
    ['Am plătit factura de ieri dar serviciul e tot suspendat', 'money'],
    ['Vreau rambursarea banilor pentru luna trecută', 'money'],
    ['Doresc să anulez abonamentul de hosting', 'cancellation'],
    ['Vă rog să ștergeți contul meu și toate datele', 'cancellation'],
    ['Puteți schimba nameserverele domeniului meu?', 'account_change'],
    ['Am nevoie de codul EPP pentru transfer', 'account_change'],
    ['Este inacceptabil, depun plângere la ANPC', 'complaint_legal'],
    ['Vă dau în judecată pentru pierderile suferite', 'complaint_legal'],
  ])('„%s” → %s', (text, reason) => {
    expect(detectEscalation(text)).toContain(reason);
  });

  it('nu escaladează problemele tehnice obișnuite', () => {
    expect(detectEscalation('Site-ul nu se încarcă, apare eroarea 500 de azi dimineață')).toEqual([]);
    expect(detectEscalation('Cum configurez e-mailul în Outlook?')).toEqual([]);
  });

  it('recunoaște răspunsurile automate (fără bucle de răspunsuri)', () => {
    expect(looksLikeAutoReply('Out of Office: re: tichet', '')).toBe(true);
    expect(looksLikeAutoReply('Re: tichet', 'Sunt în concediu până pe 10.')).toBe(true);
    expect(looksLikeAutoReply('Problema cu site-ul', 'Nu merge formularul de contact.')).toBe(false);
  });
});
