/** Sumă în formatul românesc, cu prefixul/sufixul monedei din WHMCS („1.240,00 RON”). */
export function formatMoney(amount: number | null, prefix = '', suffix = ''): string {
  if (amount == null) return '—';
  const value = amount.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${prefix}${value}${suffix}`.trim();
}

/** „2026-10-14” → „14.10.2026”. */
export function formatDateRo(isoDate: string | null): string {
  if (!isoDate) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}

/** Valoarea anuală a unui serviciu după ciclul de facturare WHMCS. */
export function annualize(amount: number, cycle: string): number {
  const c = cycle.toLowerCase();
  if (c.includes('month')) return amount * 12;
  if (c.includes('quarter')) return amount * 4;
  if (c.includes('semi')) return amount * 2;
  if (c.includes('bienn')) return amount / 2;
  if (c.includes('trienn')) return amount / 3;
  if (c.includes('free') || c.includes('one')) return 0;
  return amount;
}
