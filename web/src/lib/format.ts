const rtf = new Intl.RelativeTimeFormat('ro', { numeric: 'auto' });

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'acum câteva secunde';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return dateTime(ts);
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

export function dateOnly(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(ts));
}

export function duration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} zile ${h % 24} h`;
}

export function ms(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

/** Numere compacte: 1.284 / 12,9 mii / 4,2 mil. */
export function compact(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('ro-RO', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 10_000 ? 1 : 2 }).format(n);
}

export function money(n: number | null | undefined, prefix = '', suffix = ''): string {
  if (n == null) return '—';
  return `${prefix}${new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2, minimumFractionDigits: n % 1 ? 2 : 0 }).format(n)}${suffix}`;
}

export function usd(n: number): string {
  return `${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)} $`;
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—';
  return `${n.toFixed(n === 100 ? 0 : digits).replace('.', ',')}%`;
}
