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
};

export function wpIsBroken(): boolean {
  return demoState.wpFault && !demoState.rescueDisabled.has(demoState.faultyPlugin);
}
