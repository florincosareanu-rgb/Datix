import { useEffect } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInfoDTO } from '@datix/shared';
import { api, setUnauthorizedHandler } from './lib/api';
import { EventsProvider } from './lib/events';
import { StepUpProvider } from './lib/stepup';
import { Loading } from './components/ui';
import { Shell } from './layout/Shell';
import { SetupPage } from './pages/Setup';
import { LoginPage } from './pages/Login';
import { ChatPage } from './pages/Chat';
import { StatusPage } from './pages/Status';
import { IncidentsPage, IncidentDetailPage } from './pages/Incidents';
import { SecurityPage } from './pages/Security';
import { TicketsPage, TicketDetailPage } from './pages/Tickets';
import { BusinessPage } from './pages/Business';
import { ReportsPage, ReportDetailPage } from './pages/Reports';
import { ApprovalsPage } from './pages/Approvals';
import { SettingsPage } from './pages/settings/Settings';
import { MorePage } from './pages/More';
import { MonitorDetailPage } from './pages/MonitorDetail';

export function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.get<SessionInfoDTO>('/api/auth/session'), staleTime: 60_000 });
  const [location, navigate] = useLocation();

  useEffect(() => {
    setUnauthorizedHandler(() => qc.invalidateQueries({ queryKey: ['session'] }));
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  useEffect(() => {
    if (session.data?.agentName) document.title = session.data.agentName;
  }, [session.data?.agentName]);

  if (session.isLoading) return <Loading label="Pornesc DAX…" />;
  if (session.error || !session.data) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-2">
        Nu mă pot conecta la server. Verifică internetul și reîncearcă.
        <button className="ml-2 underline" onClick={() => session.refetch()}>
          Reîncearcă
        </button>
      </div>
    );
  }

  const s = session.data;
  if (s.setupRequired) {
    return <SetupPage session={s} />;
  }
  if (!s.authenticated) {
    if (location !== '/login') navigate('/login', { replace: true });
    return <LoginPage />;
  }
  if (location === '/login' || location === '/setup') return <Redirect to="/" />;

  return (
    <EventsProvider enabled>
      <StepUpProvider>
        <Shell session={s}>
          <Switch>
            <Route path="/" component={ChatPage} />
            <Route path="/chat/:id" component={ChatPage} />
            <Route path="/status" component={StatusPage} />
            <Route path="/monitor/:id" component={MonitorDetailPage} />
            <Route path="/incidente" component={IncidentsPage} />
            <Route path="/incidente/:id" component={IncidentDetailPage} />
            <Route path="/securitate" component={SecurityPage} />
            <Route path="/tichete" component={TicketsPage} />
            <Route path="/tichete/:id" component={TicketDetailPage} />
            <Route path="/business" component={BusinessPage} />
            <Route path="/rapoarte" component={ReportsPage} />
            <Route path="/rapoarte/:id" component={ReportDetailPage} />
            <Route path="/aprobari" component={ApprovalsPage} />
            <Route path="/setari" component={SettingsPage} />
            <Route path="/setari/:tab" component={SettingsPage} />
            <Route path="/mai-mult" component={MorePage} />
            <Route>
              <Redirect to="/" />
            </Route>
          </Switch>
        </Shell>
      </StepUpProvider>
    </EventsProvider>
  );
}
