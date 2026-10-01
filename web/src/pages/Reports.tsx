import { Link, useRoute } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FilePlus2, FileText } from 'lucide-react';
import type { ReportDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { dateOnly, dateTime } from '../lib/format';
import { Badge, Button, Card, EmptyState, ErrorBox, Loading, Page, PageHeader } from '../components/ui';
import { Markdown } from '../components/Markdown';

const KIND_LABEL: Record<ReportDTO['kind'], string> = { daily: 'Zilnic', weekly: 'Săptămânal', incident: 'Incident' };

export function ReportsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['reports'], queryFn: () => api.get<ReportDTO[]>('/api/reports') });
  const generate = useMutation({
    mutationFn: () => api.post<ReportDTO>('/api/reports/daily'),
    onSuccess: () => {
      toast('Raportul a fost generat.', 'good');
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <Page>
      <PageHeader
        title="Rapoarte"
        subtitle="Raportul zilnic: disponibilitate, incidente, securitate, tichete, business și costul AI."
        actions={
          <Button size="sm" variant="primary" icon={<FilePlus2 className="size-4" />} loading={generate.isPending} onClick={() => generate.mutate()}>
            Generează acum
          </Button>
        }
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<FileText className="size-8" />} title="Niciun raport încă">
            Primul raport se generează automat dimineață (ora se schimbă din Setări → Notificări). Îl poți genera și acum.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {data.map((r) => (
            <Link key={r.id} href={`/rapoarte/${r.id}`} className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0 hover:bg-surface-2/50 sm:px-5">
              <FileText className="size-5 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.title}</div>
                <div className="text-[13px] text-ink-3">
                  {dateTime(r.periodStart)} – {dateTime(r.periodEnd)}
                </div>
              </div>
              <Badge>{KIND_LABEL[r.kind]}</Badge>
            </Link>
          ))}
        </Card>
      )}
    </Page>
  );
}

export function ReportDetailPage() {
  const [, params] = useRoute('/rapoarte/:id');
  const id = params?.id ?? '';
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['report', id], queryFn: () => api.get<ReportDTO>(`/api/reports/${id}`) });
  if (isLoading) return <Loading />;
  if (error || !data)
    return (
      <Page>
        <ErrorBox error={error} onRetry={() => refetch()} />
      </Page>
    );
  return (
    <Page>
      <Link href="/rapoarte" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" /> Rapoarte
      </Link>
      <PageHeader title={data.title} subtitle={`${KIND_LABEL[data.kind]} · generat ${dateOnly(data.createdAt)}`} />
      <Card>
        <div className="prose-chat px-4 py-5 sm:px-6">
          <Markdown text={data.content} />
        </div>
      </Card>
    </Page>
  );
}
