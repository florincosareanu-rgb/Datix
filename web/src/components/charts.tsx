import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { MONITOR_STATUS_LABEL, type MonitorStatus } from '@datix/shared';
import { dateTime, ms } from '../lib/format';
import { StatusBadge } from './status';

// Grafice simple în SVG, conform regulilor de vizualizare: linii de 2px, coloane de maxim 24px
// cu capăt rotunjit, grilă discretă, tooltip la hover și focus, valori și în text (fără să depindă doar de culoare).

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e?.contentRect.width ?? 0)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.max(0, Math.min(x - 90, width - 180));
  return (
    <div className="pointer-events-none absolute z-10 w-[180px] rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-lg" style={{ left, top: Math.max(0, y) }}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------ banda de disponibilitate

const STRIP_COLOR: Record<MonitorStatus, string> = {
  up: 'var(--color-good)',
  degraded: 'var(--color-warning)',
  down: 'var(--color-critical)',
  unknown: 'var(--color-line-strong)',
  paused: 'var(--color-line-strong)',
};

export function UptimeStrip({ series, slots = 60 }: { series: Array<{ at: number; ms: number | null; status: MonitorStatus }>; slots?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const data = series.slice(-slots);
  const padded: Array<(typeof data)[number] | null> = [...Array(Math.max(0, slots - data.length)).fill(null), ...data];
  const gap = 2;
  const barW = width ? Math.max(2, (width - gap * (slots - 1)) / slots) : 0;
  const down = data.filter((d) => d.status === 'down').length;
  return (
    <div ref={ref} className="relative" role="img" aria-label={`Ultimele ${data.length} verificări: ${down} eșuate`}>
      <svg width={width} height={26} className="block">
        {padded.map((d, i) => (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={hover === i ? 0 : 2}
            width={barW}
            height={hover === i ? 26 : 22}
            rx={Math.min(2, barW / 2)}
            fill={d ? STRIP_COLOR[d.status] : 'var(--color-surface-3)'}
            opacity={d ? 1 : 0.6}
          />
        ))}
        {/* zone de interacțiune mai mari decât barele */}
        {padded.map((d, i) =>
          d ? (
            <rect
              key={`h${i}`}
              x={i * (barW + gap) - gap / 2}
              y={0}
              width={barW + gap}
              height={26}
              fill="transparent"
              tabIndex={0}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          ) : null,
        )}
      </svg>
      {hover != null && padded[hover] && (
        <Tooltip x={hover * (barW + gap)} y={32} width={width}>
          <div className="mb-1 font-semibold text-ink">{padded[hover]!.ms != null ? ms(padded[hover]!.ms) : '—'}</div>
          <StatusBadge status={padded[hover]!.status} />
          <div className="mt-1 text-ink-3">{dateTime(padded[hover]!.at)}</div>
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------ timp de răspuns (linie)

export function LatencyChart({ points, height = 180 }: { points: Array<{ at: number; ms: number | null; status: MonitorStatus }>; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const valid = points.filter((p) => p.ms != null) as Array<{ at: number; ms: number; status: MonitorStatus }>;
  const max = Math.max(...valid.map((p) => p.ms), 100);
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1]!;
  const t0 = points[0]?.at ?? 0;
  const t1 = points[points.length - 1]?.at ?? 1;
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => pad.t + ih - (v / yMax) * ih;

  const path = useMemo(() => {
    let d = '';
    let pen = false;
    for (const p of points) {
      if (p.ms == null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.ms).toFixed(1)}`;
      pen = true;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, height, yMax]);

  const area = valid.length ? `${path}L${x(valid[valid.length - 1]!.at).toFixed(1)},${pad.t + ih}L${x(valid[0]!.at).toFixed(1)},${pad.t + ih}Z` : '';

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - rect.left + pad.l;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(p.at) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  if (!points.length) return <div className="py-10 text-center text-sm text-ink-3">Încă nu există măsurători.</div>;
  const hp = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="relative">
      <svg width={width} height={height} className="block" role="img" aria-label="Timpul de răspuns în timp">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-chart-grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="tabular fill-ink-3 text-[10.5px]">
              {t >= 1000 ? `${t / 1000}s` : `${t}ms`}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--color-chart-axis)" strokeWidth={1} />
        {area && <path d={area} fill="var(--color-chart-1)" opacity={0.1} />}
        <path d={path} fill="none" stroke="var(--color-chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* căderile marcate pe axa de jos */}
        {points.map((p, i) =>
          p.status === 'down' ? <rect key={i} x={x(p.at) - 1.5} y={pad.t + ih - 4} width={3} height={4} rx={1} fill="var(--color-critical)" /> : null,
        )}
        <text x={pad.l} y={height - 4} className="fill-ink-3 text-[10.5px]">
          {dateTime(t0)}
        </text>
        <text x={width - pad.r} y={height - 4} textAnchor="end" className="fill-ink-3 text-[10.5px]">
          {dateTime(t1)}
        </text>
        {hp && hp.ms != null && (
          <>
            <line x1={x(hp.at)} x2={x(hp.at)} y1={pad.t} y2={pad.t + ih} stroke="var(--color-line-strong)" strokeWidth={1} />
            <circle cx={x(hp.at)} cy={y(hp.ms)} r={4.5} fill="var(--color-chart-1)" stroke="var(--color-surface)" strokeWidth={2} />
          </>
        )}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && (
        <Tooltip x={x(hp.at)} y={pad.t} width={width}>
          <div className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3 rounded bg-[var(--color-chart-1)]" />
            <span className="font-semibold text-ink">{hp.ms != null ? ms(hp.ms) : 'fără răspuns'}</span>
          </div>
          <div className="mt-1 text-ink-2">{MONITOR_STATUS_LABEL[hp.status]}</div>
          <div className="text-ink-3">{dateTime(hp.at)}</div>
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------ coloane (o singură serie)

export function ColumnChart({ data, height = 200, format }: { data: Array<{ label: string; value: number; title: string }>; height?: number; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 8, t: 10, b: 24 };
  const max = Math.max(...data.map((d) => d.value), 1);
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1]!;
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const slot = iw / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(3, slot - 2));
  const y = (v: number) => pad.t + ih - (v / yMax) * ih;
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(iw / 56)));

  const colPath = (cx: number, top: number, w: number) => {
    const r = Math.min(4, w / 2, pad.t + ih - top);
    const l = cx - w / 2;
    const b = pad.t + ih;
    if (b - top < 0.5) return '';
    return `M${l},${b}L${l},${top + r}Q${l},${top} ${l + r},${top}L${l + w - r},${top}Q${l + w},${top} ${l + w},${top + r}L${l + w},${b}Z`;
  };

  return (
    <div ref={ref} className="relative">
      <svg width={width} height={height} className="block" role="img" aria-label="Grafic pe zile">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-chart-grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="tabular fill-ink-3 text-[10.5px]">
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + slot * i + slot / 2;
          return (
            <g key={i}>
              <path d={colPath(cx, y(d.value), barW)} fill="var(--color-chart-1)" opacity={hover == null || hover === i ? 1 : 0.55} />
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[10.5px]">
                  {d.label}
                </text>
              )}
              <rect
                x={pad.l + slot * i}
                y={pad.t}
                width={slot}
                height={ih}
                fill="transparent"
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--color-chart-axis)" strokeWidth={1} />
      </svg>
      {hover != null && data[hover] && (
        <Tooltip x={pad.l + slot * hover + slot / 2} y={pad.t} width={width}>
          <div className="font-semibold text-ink">{format(data[hover]!.value)}</div>
          <div className="text-ink-3">{data[hover]!.title}</div>
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------ cifre

export function StatTile({ label, value, sub, tone, icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'critical' | 'warning'; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
        {icon}
        {label}
      </div>
      <div className="tabular mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">{value}</div>
      {sub && <div className={clsx('mt-0.5 text-xs', tone === 'good' ? 'text-good-ink' : tone === 'critical' ? 'text-critical-ink' : tone === 'warning' ? 'text-warning-ink' : 'text-ink-3')}>{sub}</div>}
    </div>
  );
}

/** Contor (meter) pentru resurse: umplere colorată după prag, pista în aceeași nuanță, mai deschisă. */
export function Meter({ label, valuePct, detail }: { label: string; valuePct: number | null; detail?: string }) {
  const v = valuePct ?? 0;
  const tone = v >= 90 ? 'critical' : v >= 80 ? 'warning' : 'accent';
  const fill = tone === 'critical' ? 'bg-critical' : tone === 'warning' ? 'bg-warning' : 'bg-accent';
  const track = tone === 'critical' ? 'bg-critical-soft' : tone === 'warning' ? 'bg-warning-soft' : 'bg-accent-soft';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-ink-2">{label}</span>
        <span className="font-semibold">{valuePct == null ? '—' : `${valuePct.toFixed(1).replace('.', ',')}%`}</span>
      </div>
      <div className={clsx('h-2 overflow-hidden rounded-full', track)}>
        <div className={clsx('h-full rounded-full', fill)} style={{ width: `${Math.min(100, v)}%` }} />
      </div>
      {detail && <div className="mt-1 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}
