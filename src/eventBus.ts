import { StringCodec, connect, type NatsConnection, type Subscription } from "nats";

import type { AppConfig } from "./config.js";
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
  close(): Promise<void>;
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
    },
    async close() {}
  };
}

export async function createNatsEventBus(params: {
  servers: string | string[];
  name?: string;
}): Promise<EventBus> {
  const connection = await connect({
    servers: params.servers,
    name: params.name ?? "dot-event-bus"
  });
  const codec = StringCodec();
  const subscriptions = new Set<Subscription>();

  const subscribe = <TEvent extends DotEvent>(eventType: TEvent["eventType"], handler: EventHandler<TEvent>) => {
    const subscription = connection.subscribe(eventType, {
      callback: (error, message) => {
        if (error) {
          throw error;
        }

        void Promise.resolve(handler(deserializeEvent<TEvent>(codec.decode(message.data)))).catch((handlerError) => {
          setImmediate(() => {
            throw handlerError;
          });
        });
      }
    });

    subscriptions.add(subscription);

    return () => {
      subscription.unsubscribe();
      subscriptions.delete(subscription);
    };
  };

  const subscribeAll = (handler: EventHandler<DotEvent>) => {
    const subscription = connection.subscribe(">", {
      callback: (error, message) => {
        if (error) {
          throw error;
        }

        void Promise.resolve(handler(deserializeEvent(codec.decode(message.data)))).catch((handlerError) => {
          setImmediate(() => {
            throw handlerError;
          });
        });
      }
    });

    subscriptions.add(subscription);

    return () => {
      subscription.unsubscribe();
      subscriptions.delete(subscription);
    };
  };

  const publish = async <TEvent extends DotEvent>(event: TEvent) => {
    connection.publish(event.eventType, codec.encode(JSON.stringify(event)));
    await connection.flush();
  };

  return {
    publish,
    subscribe,
    subscribeAll,
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
    },
    async close() {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      subscriptions.clear();
      await connection.drain();
      await connection.closed();
    }
  };
}

export async function createConfiguredEventBus(config: Pick<AppConfig, "EVENT_BUS_ADAPTER" | "NATS_URL">): Promise<EventBus> {
  if (config.EVENT_BUS_ADAPTER === "nats") {
    return createNatsEventBus({
      servers: config.NATS_URL,
      name: "dot-bootstrap"
    });
  }

  return createInMemoryEventBus();
}

function deserializeEvent<TEvent extends DotEvent = DotEvent>(raw: string): TEvent {
  return JSON.parse(raw) as TEvent;
}
