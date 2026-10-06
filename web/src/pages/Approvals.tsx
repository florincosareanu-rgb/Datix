import { useState } from 'react';
import { Link } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, MessageSquare } from 'lucide-react';
import type { ApprovalDTO } from '@datix/shared';
import { api } from '../lib/api';
import { ApprovalCard } from '../components/ApprovalCard';
import { Card, EmptyState, ErrorBox, Loading, Page, PageHeader, Segmented } from '../components/ui';

const CONTEXT_LABEL: Record<ApprovalDTO['context'], string> = {
  owner: 'din chat',
  incident: 'la un incident',
  ticket: 'la un tichet',
  report: 'la un raport',
  mission: 'într-o misiune programată',
};

export function ApprovalsPage() {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['approvals', filter],
    queryFn: () => api.get<ApprovalDTO[]>(`/api/approvals${filter === 'pending' ? '?status=pending' : ''}`),
  });
  return (
    <Page>
      <PageHeader
        title="Aprobări"
        subtitle="Acțiunile riscante (ireversibile sau mesaje către clienți) așteaptă OK-ul tău, confirmat cu Face ID."
        actions={
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: 'În așteptare' },
              { value: 'all', label: 'Istoric' },
            ]}
          />
        }
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<CheckSquare className="size-8" />} title={filter === 'pending' ? 'Nimic de aprobat' : 'Nicio aprobare încă'}>
            Când agentul vrea să facă ceva ireversibil (ex. restaurare backup, modificare DNS), îți cere aici aprobarea și primești notificare.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((a) => (
            <div key={a.id}>
              <ApprovalCard
                approval={a}
                onDecided={() => {
                  qc.invalidateQueries({ queryKey: ['approvals'] });
                  qc.invalidateQueries({ queryKey: ['status'] });
                }}
              />
              <div className="mt-1 flex items-center gap-2 px-1 text-xs text-ink-3">
                <span>Cerută {CONTEXT_LABEL[a.context]}</span>
                {a.conversationId && (
                  <Link href={`/chat/${a.conversationId}`} className="inline-flex items-center gap-1 underline">
                    <MessageSquare className="size-3" /> vezi conversația
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
