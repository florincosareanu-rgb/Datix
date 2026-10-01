import { describe, expect, it } from 'vitest';
import { decide } from '../src/agent/policy';
import { getTool } from '../src/agent/tools';
import { defaultSettings } from '../src/settings/defaults';
import type { AppSettings } from '@datix/shared';

const base = defaultSettings('http://localhost:3000');
const settings = (patch: Partial<AppSettings['autonomy']> = {}): AppSettings => ({ ...base, autonomy: { ...base.autonomy, ...patch } });
const tool = (name: string) => {
  const t = getTool(name);
  if (!t) throw new Error(`unealta ${name} lipsește`);
  return t;
};

describe('matricea de autonomie', () => {
  it('citirile sunt permise peste tot unde unealta e disponibilă', () => {
    expect(decide(tool('check_website'), 'ticket', settings())).toEqual({ action: 'allow' });
    expect(decide(tool('check_website'), 'incident', settings())).toEqual({ action: 'allow' });
  });

  it('la incidente, reparațiile reversibile sunt automate doar dacă e activată remedierea automată', () => {
    expect(decide(tool('wp_rescue_disable_plugins'), 'incident', settings())).toEqual({ action: 'allow' });
    expect(decide(tool('wp_rescue_disable_plugins'), 'incident', settings({ incidentAutoRemediate: false }))).toMatchObject({ action: 'approval', blocking: true });
  });

  it('acțiunile ireversibile cer Face ID (în chat, configurabil)', () => {
    expect(decide(tool('da_restore_backup'), 'owner', settings())).toMatchObject({ action: 'approval', stepUp: true });
    expect(decide(tool('da_restore_backup'), 'owner', settings({ ownerConfirmIrreversible: false }))).toEqual({ action: 'allow' });
    expect(decide(tool('da_restore_backup'), 'incident', settings())).toMatchObject({ action: 'approval', stepUp: true });
  });

  it('un tichet de client nu poate declanșa singur modificări', () => {
    const r = decide(tool('wp_rescue_disable_plugins'), 'ticket', settings());
    expect(r.action === 'approval' || r.action === 'deny').toBe(true);
    expect(decide(tool('whmcs_reply_ticket'), 'ticket', settings()).action).toBe('deny');
  });

  it('mesajele către clienți din chat cer confirmarea textului', () => {
    expect(decide(tool('whmcs_reply_ticket'), 'owner', settings())).toMatchObject({ action: 'approval', stepUp: false });
  });

  it('rapoartele nu pot modifica nimic', () => {
    expect(decide(tool('wp_rescue_disable_plugins'), 'report', settings()).action).toBe('deny');
  });
});
