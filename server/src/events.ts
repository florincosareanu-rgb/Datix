import { EventEmitter } from 'node:events';
import type { ChatStreamEvent, ServerEvent } from '@datix/shared';

/** Magistrala de evenimente pentru actualizări live (SSE) în aplicație. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  emitChat(conversationId: string, event: ChatStreamEvent): void {
    this.emit({ type: 'chat', conversationId, event });
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
