export function truncate(value: string, max: number, suffix = '\n…[trunchiat]'): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Păstrează ultimele `maxLines` linii (pentru loguri). */
export function tailLines(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines) return value;
  return lines.slice(-maxLines).join('\n');
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Ultimele 4 caractere, pentru a arăta ce cheie e salvată fără a o expune. */
export function secretHint(value: string): string {
  if (value.length <= 6) return '••••';
  return `••••${value.slice(-4)}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    // WHMCS poate întoarce sume formatate, ex. "1.234,56 RON" sau "€12.00"
    const cleaned = value.replace(/[^\d.,-]/g, '');
    if (!cleaned) return null;
    let normalized = cleaned;
    if (cleaned.includes(',') && cleaned.includes('.')) {
      normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
    } else if (cleaned.includes(',')) {
      const parts = cleaned.split(',');
      normalized = parts.length === 2 && (parts[1]?.length ?? 0) <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
    }
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function pluralRo(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
