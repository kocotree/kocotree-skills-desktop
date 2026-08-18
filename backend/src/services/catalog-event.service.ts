import { randomUUID } from "node:crypto";

export type CatalogEventType =
  | "skill.created"
  | "skill.updated"
  | "skill.deleted";

export interface CatalogEvent {
  eventId: string;
  type: CatalogEventType;
  skillId: string;
  occurredAt: string;
}

type CatalogEventListener = (event: CatalogEvent) => void;

const listeners = new Set<CatalogEventListener>();

export const catalogEventService = {
  publish(type: CatalogEventType, skillId: string): CatalogEvent {
    const event: CatalogEvent = {
      eventId: randomUUID(),
      type,
      skillId,
      occurredAt: new Date().toISOString(),
    };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 单个断开的 SSE 客户端不能阻塞业务事务后的事件分发。
      }
    }
    return event;
  },

  subscribe(listener: CatalogEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
