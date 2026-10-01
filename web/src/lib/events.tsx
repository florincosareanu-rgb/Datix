import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@datix/shared';

type Listener = (e: ServerEvent) => void;

interface EventsCtx {
  subscribe: (l: Listener) => () => void;
  connected: boolean;
}

const Ctx = createContext<EventsCtx>({ subscribe: () => () => {}, connected: false });

/** Conexiunea SSE cu serverul: actualizări live + reîmprospătarea datelor din cache. */
export function EventsProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const qc = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const invalidate = (e: ServerEvent) => {
      switch (e.type) {
        case 'monitor':
          qc.invalidateQueries({ queryKey: ['status'] });
          qc.invalidateQueries({ queryKey: ['monitor', e.monitor.id] });
          break;
        case 'incident':
          qc.invalidateQueries({ queryKey: ['incidents'] });
          qc.invalidateQueries({ queryKey: ['incident', e.incident.id] });
          qc.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'finding':
          qc.invalidateQueries({ queryKey: ['findings'] });
          qc.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'ticket_job':
          qc.invalidateQueries({ queryKey: ['tickets'] });
          qc.invalidateQueries({ queryKey: ['ticket', e.job.id] });
          qc.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'approval':
          qc.invalidateQueries({ queryKey: ['approvals'] });
          qc.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'notification':
          qc.invalidateQueries({ queryKey: ['notifications'] });
          break;
        case 'settings_changed':
          qc.invalidateQueries({ queryKey: ['settings'] });
          qc.invalidateQueries({ queryKey: ['status'] });
          qc.invalidateQueries({ queryKey: ['tickets-summary'] });
          break;
        case 'chat':
          if (e.event.type === 'run_finished' || e.event.type === 'title') qc.invalidateQueries({ queryKey: ['conversations'] });
          break;
      }
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/events', { withCredentials: true });
      es.onopen = () => setConnected(true);
      es.onmessage = (msg) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(msg.data) as ServerEvent;
        } catch {
          return;
        }
        invalidate(data);
        for (const l of listeners.current) l(data);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    // la revenirea în aplicație (iOS suspendă conexiunile în fundal) reîmprospătăm tot
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        qc.invalidateQueries();
        if (!es || es.readyState === EventSource.CLOSED) connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, qc]);

  const subscribe = (l: Listener) => {
    listeners.current.add(l);
    return () => listeners.current.delete(l);
  };

  return <Ctx.Provider value={{ subscribe, connected }}>{children}</Ctx.Provider>;
}

export function useServerEvents(listener: Listener, deps: unknown[] = []) {
  const { subscribe } = useContext(Ctx);
  useEffect(() => subscribe(listener), [subscribe, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useEventsConnected() {
  return useContext(Ctx).connected;
}
