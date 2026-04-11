export type ServiceReadiness = "idle" | "starting" | "ready" | "stopping" | "stopped" | "error";

export interface ServiceStatus {
  name: string;
  readiness: ServiceReadiness;
  detail: string | null;
}

export interface ServiceHost {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ServiceStatus;
}

export function createServiceHost(params: {
  name: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}): ServiceHost {
  let readiness: ServiceReadiness = "idle";
  let detail: string | null = null;

  return {
    name: params.name,
    async start() {
      if (readiness === "ready") {
        return;
      }

      readiness = "starting";
      detail = null;

      try {
        await params.start?.();
        readiness = "ready";
      } catch (error) {
        readiness = "error";
        detail = formatError(error);
        throw error;
      }
    },
    async stop() {
      if (readiness === "stopped" || readiness === "idle") {
        readiness = "stopped";
        return;
      }

      readiness = "stopping";

      try {
        await params.stop?.();
        readiness = "stopped";
      } catch (error) {
        readiness = "error";
        detail = formatError(error);
        throw error;
      }
    },
    getStatus() {
      return {
        name: params.name,
        readiness,
        detail
      };
    }
  };
}

export function createServiceCoordinator(hosts: ServiceHost[]) {
  return {
    async startAll() {
      const startedHosts: ServiceHost[] = [];

      for (const host of hosts) {
        try {
          await host.start();
          startedHosts.push(host);
        } catch (error) {
          const startupError = error instanceof Error ? error : new Error(String(error));
          const rollbackErrors: Error[] = [];

          for (const startedHost of [...startedHosts].reverse()) {
            try {
              await startedHost.stop();
            } catch (rollbackError) {
              rollbackErrors.push(
                rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
              );
            }
          }

          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [startupError, ...rollbackErrors],
              `Service host startup failed at ${host.name} and rollback was incomplete.`
            );
          }

          throw startupError;
        }
      }
    },
    async stopAll() {
      const errors: Error[] = [];

      for (const host of [...hosts].reverse()) {
        try {
          await host.stop();
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more service hosts failed to stop cleanly.");
      }
    },
    getStatuses(): ServiceStatus[] {
      return hosts.map((host) => host.getStatus());
    }
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
