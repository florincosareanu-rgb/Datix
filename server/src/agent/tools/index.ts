import type { AgentContext } from '@datix/shared';
import type { Integrations } from '../../integrations';
import type { AnyTool } from './types';
import { statusTools } from './status';
import { netTools } from './net';
import { wordpressTools, rescueTools } from './wordpress';
import { directadminTools } from './directadmin';
import { cloudflareTools } from './cloudflare';
import { whmcsTools } from './whmcs';
import { resellerTools } from './reseller';
import { submitTools } from './submit';

export const ALL_TOOLS: AnyTool[] = [
  ...statusTools,
  ...netTools,
  ...wordpressTools,
  ...rescueTools,
  ...directadminTools,
  ...cloudflareTools,
  ...whmcsTools,
  ...resellerTools,
  ...submitTools,
] as AnyTool[];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AnyTool | undefined {
  return BY_NAME.get(name);
}

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.label ?? name;
}

/** Uneltele disponibile într-un context, ținând cont de integrările configurate. */
export function toolsFor(context: AgentContext, integrations: Integrations): AnyTool[] {
  return ALL_TOOLS.filter((t) => t.contexts.includes(context) && (t.requires ?? []).every((k) => integrations.isConfigured(k)));
}
