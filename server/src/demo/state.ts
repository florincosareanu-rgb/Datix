// Starea comună a simulării (modul demo).

export const demoState = {
  /** Când e activ, site-ul WordPress simulat afișează „eroare critică” din cauza unui plugin defect. */
  wpFault: false,
  /** Pluginul care provoacă eroarea în scenariul demo. */
  faultyPlugin: 'elementor',
  /** Pluginurile dezactivate prin trusa de salvare (fișierul mu-plugin simulat). */
  rescueDisabled: new Set<string>(),
  securityLevel: 'medium',
  maintenance: false,
  /** Pluginul a cărui actualizare „strică” site-ul (scenariul de actualizări sigure). */
  updateFault: null as string | null,
  /** Versiunile salvate în copiile de siguranță ale actualizărilor (rulare → plugin → versiune). */
  snapshots: new Map<string, Record<string, string>>(),
  /** E-mailurile sosite în căsuța de monitorizare simulată. */
  mailboxInbox: [] as Array<{ subject: string; at: number }>,
  /** Rapoartele DMARC simulate au fost deja livrate. */
  dmarcDelivered: false,
};

export function wpIsBroken(): boolean {
  if (demoState.updateFault && !demoState.rescueDisabled.has(demoState.updateFault)) return true;
  return demoState.wpFault && !demoState.rescueDisabled.has(demoState.faultyPlugin);
}
