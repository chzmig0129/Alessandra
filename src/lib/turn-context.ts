import { AsyncLocalStorage } from "node:async_hooks";

export interface TurnAttachments {
  imageUrl?: string;
  lat?: number;
  lng?: number;
}

export interface TurnContext {
  conversationId: string;
  userId: string;
  attachments?: TurnAttachments;
}

const storage = new AsyncLocalStorage<TurnContext>();

export function runWithTurnContext<T>(ctx: TurnContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getTurnContext(): TurnContext | undefined {
  return storage.getStore();
}
