import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResult, type LlmStreamEvent, type LlmToolCall } from './types';

// Client DeepSeek (API compatibil OpenAI), cu streaming SSE scris direct peste fetch,
// ca să tratăm corect câmpurile specifice DeepSeek: `reasoning_content`, `thinking`,
// `reasoning_effort`, `prompt_cache_hit_tokens`.

/** Modelele V4 au modul de gândire activ implicit și cer `reasoning_content` la fiecare mesaj al asistentului. */
export function isDeepSeekV4(model: string): boolean {
  return model.includes('deepseek-v4') || model.startsWith('deepseek-flash') || model.startsWith('deepseek-pro');
}

/** Pregătește istoricul conform regulilor DeepSeek pentru `reasoning_content`. */
export function prepareMessages(messages: LlmMessage[], model: string, thinking: boolean): LlmMessage[] {
  const v4 = isDeepSeekV4(model);
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  return messages.map((m, i) => {
    if (m.role !== 'assistant') return m;
    const out: LlmMessage = { role: 'assistant', content: m.content ?? '' };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (v4) out.reasoning_content = m.reasoning_content ?? '';
    else if (thinking && i > lastUser && m.reasoning_content) out.reasoning_content = m.reasoning_content;
    return out;
  });
}

const ERRORS: Record<number, string> = {
  400: 'Cerere invalidă către DeepSeek',
  401: 'Cheia API DeepSeek nu e validă. Verific-o în Setări → AI.',
  402: 'Contul DeepSeek nu mai are credit. Reîncarcă soldul pe platform.deepseek.com.',
  422: 'Parametri invalizi pentru DeepSeek (verifică numele modelului în Setări → AI).',
  429: 'DeepSeek limitează temporar cererile (prea multe cereri).',
  500: 'Eroare internă la DeepSeek.',
  502: 'DeepSeek nu răspunde corect (502).',
  503: 'Serverele DeepSeek sunt supraîncărcate momentan.',
  504: 'DeepSeek nu a răspuns în timp util (504).',
};

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.deepseek.com',
    private readonly opts: { maxRetries?: number; idleTimeoutMs?: number } = {},
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(this.url('/models'), {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new LlmError(ERRORS[res.status] ?? `DeepSeek HTTP ${res.status}`, res.status);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id);
  }

  private buildBody(req: LlmRequest): Record<string, unknown> {
    const thinking = req.thinking ?? true;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: prepareMessages(req.messages, req.model, thinking),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens ?? 16_000,
      thinking: { type: thinking ? 'enabled' : 'disabled' },
    };
    if (thinking && req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    if (!thinking && req.temperature != null) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    if (req.json) body.response_format = { type: 'json_object' };
    return body;
  }

  async stream(req: LlmRequest, onEvent: (e: LlmStreamEvent) => void, signal?: AbortSignal): Promise<LlmResult> {
    const maxRetries = this.opts.maxRetries ?? 2;
    let attempt = 0;
    for (;;) {
      let emitted = false;
      try {
        return await this.streamOnce(req, (e) => {
          emitted = true;
          onEvent(e);
        }, signal);
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(`Conexiune eșuată la DeepSeek: ${(err as Error).message}`, null, true);
        if (signal?.aborted) throw new LlmError('Rulare anulată.', null, false);
        // reîncercăm doar dacă nu am trimis deja text parțial în interfață
        if (!e.retryable || emitted || attempt >= maxRetries) throw e;
        attempt++;
        await new Promise((r) => setTimeout(r, 1500 * attempt * attempt));
      }
    }
  }

  private async streamOnce(req: LlmRequest, onEvent: (e: LlmStreamEvent) => void, signal?: AbortSignal): Promise<LlmResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const idleMs = this.opts.idleTimeoutMs ?? 120_000;
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('idle')), idleMs);
    };

    try {
      resetIdle();
      const res = await fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(this.buildBody(req)),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let detail = '';
        try {
          detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
          detail = text.slice(0, 200);
        }
        const retryable = [429, 500, 502, 503, 504].includes(res.status);
        throw new LlmError(`${ERRORS[res.status] ?? `DeepSeek HTTP ${res.status}`}${detail ? ` (${detail})` : ''}`, res.status, retryable);
      }

      const result: LlmResult = {
        model: req.model,
        content: '',
        reasoning: '',
        toolCalls: [],
        finishReason: 'unknown',
        usage: { promptTokens: 0, cacheHitTokens: 0, completionTokens: 0, reasoningTokens: 0 },
      };
      const calls = new Map<number, LlmToolCall>();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleData = (data: string) => {
        if (data === '[DONE]') return;
        let chunk: {
          error?: { message?: string; code?: string };
          model?: string;
          choices?: Array<{
            delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number };
          } | null;
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (chunk.error) throw new LlmError(`DeepSeek: ${chunk.error.message ?? 'eroare în flux'}`, null, false);
        if (chunk.model) result.model = chunk.model;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) {
          result.reasoning += delta.reasoning_content;
          onEvent({ type: 'reasoning_delta', text: delta.reasoning_content });
        }
        if (delta?.content) {
          result.content += delta.content;
          onEvent({ type: 'text_delta', text: delta.content });
        }
        for (const tc of delta?.tool_calls ?? []) {
          let call = calls.get(tc.index);
          if (!call) {
            call = { id: tc.id ?? `call_${tc.index}_${Date.now()}`, type: 'function', function: { name: '', arguments: '' } };
            calls.set(tc.index, call);
          }
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) {
            const wasEmpty = !call.function.name;
            call.function.name += tc.function.name;
            if (wasEmpty) onEvent({ type: 'tool_call_started', index: tc.index, id: call.id, name: call.function.name });
          }
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
        }
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
        if (chunk.usage) {
          const u = chunk.usage;
          result.usage = {
            promptTokens: u.prompt_tokens ?? 0,
            cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
          };
        }
      };

      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (!line || line.startsWith(':')) continue; // comentarii keep-alive
          if (line.startsWith('data:')) handleData(line.slice(5).trim());
        }
      }
      if (buffer.trim().startsWith('data:')) handleData(buffer.trim().slice(5).trim());

      result.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.function.name);
      if (result.finishReason === 'insufficient_system_resource') {
        throw new LlmError('DeepSeek a întrerupt răspunsul din lipsă de resurse. Încearcă din nou.', null, true);
      }
      return result;
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new LlmError('DeepSeek nu a mai trimis date (conexiune blocată).', null, true);
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
