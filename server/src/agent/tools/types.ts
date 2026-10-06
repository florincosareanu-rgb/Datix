import { z } from 'zod';
import type { AgentContext, IntegrationKey, RiskLevel } from '@datix/shared';
import type { Services } from '../../services';

export interface ToolContext {
  services: Services;
  context: AgentContext;
  runId: string;
  conversationId: string;
  signal?: AbortSignal;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Etichetă scurtă în română pentru interfață (ex. „Verific site-ul”). */
  label: string;
  /** Descriere pentru AI. */
  description: string;
  schema: S;
  risk: RiskLevel;
  /** Contextele în care unealta e disponibilă. */
  contexts: AgentContext[];
  /** Integrările necesare (unealta e ascunsă dacă lipsesc). */
  requires?: IntegrationKey[];
  /** Pentru context „ticket”: unealtă de scriere permisă fără aprobare (ex. notă internă). */
  ticketSafe?: boolean;
  /** Rezultatul conține conținut extern (pagini, loguri, mesaje) → încadrat ca date nesigure. */
  untrusted?: boolean;
  /** Descriere în română a acțiunii, pentru cardurile de aprobare. */
  summarize?: (args: z.infer<S>) => string;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export type AnyTool = ToolDef<z.ZodType>;

export const ALL_CONTEXTS: AgentContext[] = ['owner', 'incident', 'ticket', 'report', 'mission'];
/** Operațiuni: chat, incidente și misiuni programate (în misiuni, modificările trec prin politica de autonomie). */
export const OPS: AgentContext[] = ['owner', 'incident', 'mission'];
export const OWNER_ONLY: AgentContext[] = ['owner'];
export const READ_EVERYWHERE: AgentContext[] = ['owner', 'incident', 'ticket', 'mission'];
/** Citire pentru proprietar, rapoarte și misiuni (cifre de business). */
export const OWNER_REPORTS: AgentContext[] = ['owner', 'report', 'mission'];

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  return js;
}

/** Eroare pe care agentul o vede ca rezultat al uneltei (nu oprește rularea). */
export class ToolFailure extends Error {}
