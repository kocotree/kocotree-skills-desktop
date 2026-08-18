import type {
  CatalogEventDto,
  CatalogEventListener,
  CatalogEventType,
} from "./contracts";
import { apiUrl } from "./httpClient";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_EVENT_BUFFER_LENGTH = 64 * 1024;
const CATALOG_EVENT_TYPES = new Set<CatalogEventType>([
  "skill.created",
  "skill.updated",
  "skill.deleted",
]);

function parseCatalogEvent(block: string): CatalogEventDto | null {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;

  try {
    const parsed = JSON.parse(data) as Partial<CatalogEventDto>;
    if (
      typeof parsed.eventId !== "string"
      || typeof parsed.type !== "string"
      || !CATALOG_EVENT_TYPES.has(parsed.type as CatalogEventType)
      || typeof parsed.skillId !== "string"
      || typeof parsed.occurredAt !== "string"
    ) {
      return null;
    }
    return parsed as CatalogEventDto;
  } catch {
    return null;
  }
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

/** 使用现有 Bearer Token 建立可自动重连的 Skill 目录 SSE 流。 */
export class CatalogEventStream {
  private readonly listeners = new Set<CatalogEventListener>();
  private controller: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private authBlocked = false;

  constructor(
    private readonly getAccessToken: () => string | null,
    private readonly onUnauthorized: () => void,
  ) {}

  subscribe(listener: CatalogEventListener): () => void {
    this.listeners.add(listener);
    this.authBlocked = false;
    this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private ensureConnected(): void {
    if (
      this.listeners.size === 0
      || this.controller
      || this.reconnectTimer !== null
      || this.authBlocked
    ) {
      return;
    }
    void this.connect();
  }

  private async connect(): Promise<void> {
    const token = this.getAccessToken();
    if (!token) return;

    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(apiUrl("/api/skills/events"), {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) {
        this.authBlocked = true;
        this.onUnauthorized();
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`Catalog SSE failed: ${response.status}`);
      }

      this.reconnectAttempt = 0;
      this.publish({
        eventId: crypto.randomUUID(),
        type: "catalog.resync",
        skillId: null,
        occurredAt: new Date().toISOString(),
      });
      await this.readStream(response.body, controller.signal);
    } catch (reason) {
      if (!isAbortError(reason)) {
        console.warn("[KocotreeSkills] Skill 实时事件连接中断", reason);
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      if (
        this.listeners.size > 0
        && !this.authBlocked
        && !controller.signal.aborted
      ) {
        this.scheduleReconnect();
      }
    }
  }

  private async readStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = /\r?\n\r?\n/u.exec(buffer);
        while (separator?.index !== undefined) {
          const block = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const event = parseCatalogEvent(block);
          if (event) this.publish(event);
          separator = /\r?\n\r?\n/u.exec(buffer);
        }
        if (buffer.length > MAX_EVENT_BUFFER_LENGTH) buffer = "";
      }
    } finally {
      reader.releaseLock();
    }
  }

  private publish(event: CatalogEventDto): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (reason) {
        console.error("[KocotreeSkills] Skill 实时事件处理失败", reason);
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private stop(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.authBlocked = false;
  }
}
