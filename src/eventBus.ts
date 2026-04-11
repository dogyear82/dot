import type { DotEvent, InboundMessageReceivedEvent, OutboundMessageRequestedEvent } from "./events.js";

type EventHandler<TEvent extends DotEvent = DotEvent> = (event: TEvent) => void | Promise<void>;

export interface EventBus {
  publish<TEvent extends DotEvent>(event: TEvent): Promise<void>;
  subscribe<TEvent extends DotEvent>(eventType: TEvent["eventType"], handler: EventHandler<TEvent>): () => void;
  subscribeAll(handler: EventHandler<DotEvent>): () => void;
  publishInboundMessage(event: InboundMessageReceivedEvent): Promise<void>;
  publishOutboundMessage(event: OutboundMessageRequestedEvent): Promise<void>;
  subscribeInboundMessage(handler: EventHandler<InboundMessageReceivedEvent>): () => void;
  subscribeOutboundMessage(handler: EventHandler<OutboundMessageRequestedEvent>): () => void;
}

export function createInMemoryEventBus(): EventBus {
  const handlersByTopic = new Map<string, Set<EventHandler>>();
  const allHandlers = new Set<EventHandler>();

  const subscribe = <TEvent extends DotEvent>(eventType: TEvent["eventType"], handler: EventHandler<TEvent>) => {
    const typedHandler = handler as EventHandler;
    const handlers = handlersByTopic.get(eventType) ?? new Set<EventHandler>();
    handlers.add(typedHandler);
    handlersByTopic.set(eventType, handlers);
    return () => {
      handlers.delete(typedHandler);
      if (handlers.size === 0) {
        handlersByTopic.delete(eventType);
      }
    };
  };

  const publish = async <TEvent extends DotEvent>(event: TEvent) => {
    const handlers = handlersByTopic.get(event.eventType);

    if (handlers) {
      for (const handler of handlers) {
        await handler(event);
      }
    }

    for (const handler of allHandlers) {
      await handler(event);
    }
  };

  return {
    publish,
    subscribe,
    subscribeAll(handler) {
      allHandlers.add(handler);
      return () => allHandlers.delete(handler);
    },
    publishInboundMessage(event) {
      return publish(event);
    },
    publishOutboundMessage(event) {
      return publish(event);
    },
    subscribeInboundMessage(handler) {
      return subscribe("inbound.message.received", handler);
    },
    subscribeOutboundMessage(handler) {
      return subscribe("outbound.message.requested", handler);
    }
  };
}
