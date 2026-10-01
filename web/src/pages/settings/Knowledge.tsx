import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Brain, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { dateTime } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, Textarea } from '../../components/ui';

interface KbDoc {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: number;
}

interface Memory {
  id: string;
  content: string;
  source: string | null;
  createdAt: number;
}

const TEMPLATES: Array<{ title: string; tags: string[]; content: string }> = [
  { title: 'Servicii și prețuri', tags: ['servicii', 'preturi'], content: 'Pachete de hosting:\n- …\n\nDomenii .ro: …\n\nWeb design / WordPress: …' },
  { title: 'Proceduri suport', tags: ['suport'], content: 'Program suport: …\nTimp de răspuns: …\nCum resetează clientul parola: …' },
  { title: 'Setări e-mail pentru clienți', tags: ['email'], content: 'Server IMAP: mail.domeniu.ro, port 993 (SSL)\nServer SMTP: mail.domeniu.ro, port 465 (SSL)\n…' },
];

function DocEditor({ doc, onClose }: { doc: Partial<KbDoc> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(doc?.title ?? '');
  const [tags, setTags] = useState((doc?.tags ?? []).join(', '));
  const [content, setContent] = useState(doc?.content ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        content,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      };
      return doc?.id ? api.put<KbDoc>(`/api/kb/${doc.id}`, body) : api.post<KbDoc>('/api/kb', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb'] });
      toast('Document salvat. Agentul îl folosește de acum la tichete.', 'good');
      onClose();
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={doc?.id ? 'Editează documentul' : 'Document nou'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Renunță
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={title.trim().length < 2 || !content.trim()} onClick={() => save.mutate()}>
            Salvează
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Titlu">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Etichete" hint="Separate prin virgulă.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="hosting, preturi" />
        </Field>
        <Field label="Conținut" hint="Scrie cum i-ai explica unui coleg nou. Nu pune parole sau date ale clienților.">
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-72 text-[13.5px]" maxLength={100_000} />
        </Field>
      </div>
    </Modal>
  );
}

export function KnowledgeTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<KbDoc> | null | false>(false);
  const docs = useQuery({ queryKey: ['kb'], queryFn: () => api.get<KbDoc[]>('/api/kb') });
  const memory = useQuery({ queryKey: ['memory'], queryFn: () => api.get<Memory[]>('/api/memory') });
  const delDoc = useMutation({
    mutationFn: (id: string) => api.del(`/api/kb/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kb'] }),
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const delMem = useMutation({
    mutationFn: (id: string) => api.del(`/api/memory/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title="Baza de cunoștințe"
          subtitle="Servicii, prețuri, proceduri. Agentul o citește ca să răspundă la tichete exact ca echipa Datix."
          icon={<BookOpen className="size-4" />}
          action={
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
              Adaugă
            </Button>
          }
        />
        {docs.data && !docs.data.length ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState title="Niciun document încă">Începe cu un șablon:</EmptyState>
            <div className="flex flex-wrap justify-center gap-2">
              {TEMPLATES.map((t) => (
                <Button key={t.title} size="sm" variant="secondary" onClick={() => setEditing(t)}>
                  {t.title}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="px-2 pb-2">
            {docs.data?.map((d) => (
              <li key={d.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-surface-2/50">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{d.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-ink-3">
                    {d.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                    <span>actualizat {dateTime(d.updatedAt)}</span>
                  </div>
                </div>
                <button className="rounded-lg p-2 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Editează" onClick={() => setEditing(d)}>
                  <Pencil className="size-4" />
                </button>
                <button className="rounded-lg p-2 text-ink-3 hover:bg-surface-3 hover:text-critical-ink" aria-label="Șterge" onClick={() => confirm(`Ștergi „${d.title}”?`) && delDoc.mutate(d.id)}>
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Ce a reținut agentul" subtitle="Notițe salvate de agent din conversațiile cu tine (ex. „backup-ul complet se face duminica”). Poți șterge orice." icon={<Brain className="size-4" />} />
        {memory.data && !memory.data.length ? (
          <p className="px-4 pb-4 text-sm text-ink-3 sm:px-5">Nimic încă. Îi poți spune în chat „ține minte că …”.</p>
        ) : (
          <ul className="px-2 pb-2">
            {memory.data?.map((m) => (
              <li key={m.id} className="flex items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-surface-2/50">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{m.content}</div>
                  <div className="text-xs text-ink-3">{dateTime(m.createdAt)}</div>
                </div>
                <button className="rounded-lg p-2 text-ink-3 hover:bg-surface-3 hover:text-critical-ink" aria-label="Șterge" onClick={() => delMem.mutate(m.id)}>
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing !== false && <DocEditor doc={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
