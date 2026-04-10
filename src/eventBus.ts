import type { InboundMessageReceivedEvent, OutboundMessageRequestedEvent } from "./events.js";

type EventHandler<TEvent> = (event: TEvent) => void | Promise<void>;

export interface EventBus {
  publishInboundMessage(event: InboundMessageReceivedEvent): Promise<void>;
  publishOutboundMessage(event: OutboundMessageRequestedEvent): Promise<void>;
  subscribeInboundMessage(handler: EventHandler<InboundMessageReceivedEvent>): () => void;
  subscribeOutboundMessage(handler: EventHandler<OutboundMessageRequestedEvent>): () => void;
}

export function createInMemoryEventBus(): EventBus {
  const inboundHandlers = new Set<EventHandler<InboundMessageReceivedEvent>>();
  const outboundHandlers = new Set<EventHandler<OutboundMessageRequestedEvent>>();

  return {
    async publishInboundMessage(event) {
      for (const handler of inboundHandlers) {
        await handler(event);
      }
    },
    async publishOutboundMessage(event) {
      for (const handler of outboundHandlers) {
        await handler(event);
      }
    },
    subscribeInboundMessage(handler) {
      inboundHandlers.add(handler);
      return () => inboundHandlers.delete(handler);
    },
    subscribeOutboundMessage(handler) {
      outboundHandlers.add(handler);
      return () => outboundHandlers.delete(handler);
    }
  };
}
