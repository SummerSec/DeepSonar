/**
 * Process-local bridge between a running Agent Job and the Platform Tool API.
 *
 * The registry deliberately has no database or event-ingestion dependency.
 * The executor owns the lifecycle of a registration and can bind the handler
 * to its existing `onSemanticEvent`/terminal-delay logic. HTTP routes only
 * perform capability and input checks before invoking this bridge.
 */

export interface PlatformRuntimeHandlerContext {
  jobId: string;
  projectId: string;
  canvasId: string | null;
  operationId: string;
  input: unknown;
  eventId: string;
  tokenId: string;
  idempotencyKey: string | null;
}

export type PlatformRuntimeHandler = (context: PlatformRuntimeHandlerContext) => Promise<unknown> | unknown;
export type PlatformControlHandler = PlatformRuntimeHandler;

export interface PlatformRuntimeHandlerRegistration {
  jobId: string;
  operations: readonly string[];
  registeredAt: number;
}

export interface PlatformOperationRejection {
  statusCode: 409 | 422 | 429;
  errorCode: string;
  retryable: boolean;
  path?: string;
}

export class PlatformRuntimeHandlerError extends Error {
  readonly code: "HANDLER_NOT_REGISTERED" | "OPERATION_HANDLER_NOT_REGISTERED" | "OPERATION_REJECTED" | "HANDLER_FAILED";

  constructor(
    code: PlatformRuntimeHandlerError["code"],
    message: string,
    readonly rejection?: PlatformOperationRejection,
  ) {
    super(message);
    this.name = "PlatformRuntimeHandlerError";
    this.code = code;
  }
}

type HandlerMap = Map<string, PlatformRuntimeHandler>;

export interface RuntimeHandlerRegistry {
  register(jobId: string, handler: PlatformRuntimeHandler, operationIds?: readonly string[]): PlatformRuntimeHandlerRegistration;
  register(jobId: string, handlers: Readonly<Record<string, PlatformRuntimeHandler>>): PlatformRuntimeHandlerRegistration;
  unregister(jobId: string, operationId?: string): boolean;
  invoke(context: PlatformRuntimeHandlerContext): Promise<unknown>;
  invoke(
    jobId: string,
    operationId: string,
    input: unknown,
    eventId: string,
    metadata?: Pick<PlatformRuntimeHandlerContext, "projectId" | "canvasId" | "tokenId" | "idempotencyKey">,
  ): Promise<unknown>;
  list(jobId: string): readonly string[];
  list(): readonly PlatformRuntimeHandlerRegistration[];
}

function asJobId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("jobId is required");
  return value.trim();
}

function operationNames(handlers: HandlerMap): string[] {
  return [...handlers.keys()].sort();
}

class InMemoryRuntimeHandlerRegistry implements RuntimeHandlerRegistry {
  private readonly handlers = new Map<string, HandlerMap>();
  private readonly registeredAt = new Map<string, number>();

  register(jobId: string, handlerOrMap: PlatformRuntimeHandler | Readonly<Record<string, PlatformRuntimeHandler>>, operationIds?: readonly string[]): PlatformRuntimeHandlerRegistration {
    const id = asJobId(jobId);
    const handlers: HandlerMap = new Map();
    if (typeof handlerOrMap === "function") {
      const names = operationIds && operationIds.length > 0 ? [...new Set(operationIds)] : ["*"];
      for (const name of names) {
        if (typeof name !== "string" || name.length === 0) throw new TypeError("operation id is required");
        handlers.set(name, handlerOrMap);
      }
    } else if (handlerOrMap && typeof handlerOrMap === "object") {
      for (const [operationId, handler] of Object.entries(handlerOrMap)) {
        if (typeof handler !== "function") throw new TypeError(`handler for ${operationId} must be a function`);
        handlers.set(operationId, handler);
      }
    } else {
      throw new TypeError("runtime handler is required");
    }
    if (handlers.size === 0) throw new TypeError("at least one runtime handler is required");
    this.handlers.set(id, handlers);
    const timestamp = Date.now();
    this.registeredAt.set(id, timestamp);
    return { jobId: id, operations: operationNames(handlers), registeredAt: timestamp };
  }

  unregister(jobId: string, operationId?: string): boolean {
    const id = asJobId(jobId);
    const handlers = this.handlers.get(id);
    if (!handlers) return false;
    if (operationId === undefined) {
      this.handlers.delete(id);
      this.registeredAt.delete(id);
      return true;
    }
    const removed = handlers.delete(operationId);
    if (handlers.size === 0) {
      this.handlers.delete(id);
      this.registeredAt.delete(id);
    }
    return removed;
  }

  async invoke(
    contextOrJobId: PlatformRuntimeHandlerContext | string,
    operationId?: string,
    input?: unknown,
    eventId?: string,
    metadata?: Pick<PlatformRuntimeHandlerContext, "projectId" | "canvasId" | "tokenId" | "idempotencyKey">,
  ): Promise<unknown> {
    const context: PlatformRuntimeHandlerContext = typeof contextOrJobId === "string"
      ? {
          jobId: asJobId(contextOrJobId),
          operationId: operationId ?? "",
          input,
          eventId: eventId ?? "",
          projectId: metadata?.projectId ?? "",
          canvasId: metadata?.canvasId ?? null,
          tokenId: metadata?.tokenId ?? "",
          idempotencyKey: metadata?.idempotencyKey ?? null,
        }
      : contextOrJobId;
    const handlers = this.handlers.get(asJobId(context.jobId));
    if (!handlers) throw new PlatformRuntimeHandlerError("HANDLER_NOT_REGISTERED", "runtime handler is not registered");
    const handler = handlers.get(context.operationId) ?? handlers.get("*");
    if (!handler) throw new PlatformRuntimeHandlerError("OPERATION_HANDLER_NOT_REGISTERED", "operation handler is not registered");
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof PlatformRuntimeHandlerError) throw error;
      throw new PlatformRuntimeHandlerError("HANDLER_FAILED", "runtime handler failed");
    }
  }

  list(jobId: string): readonly string[];
  list(): readonly PlatformRuntimeHandlerRegistration[];
  list(jobId?: string): readonly string[] | readonly PlatformRuntimeHandlerRegistration[] {
    if (jobId !== undefined) {
      const handlers = this.handlers.get(asJobId(jobId));
      if (!handlers) return [];
      return operationNames(handlers);
    }
    return [...this.handlers.entries()].map(([id, handlers]) => ({
      jobId: id,
      operations: operationNames(handlers),
      registeredAt: this.registeredAt.get(id) ?? 0,
    }));
  }
}

/** Singleton shared by Scheduler routes and the current real-Job executor. */
export const platformRuntimeHandlerRegistry: RuntimeHandlerRegistry = new InMemoryRuntimeHandlerRegistry();

export const runtimeHandlerRegistry = platformRuntimeHandlerRegistry;

export function registerRuntimeHandler(
  jobId: string,
  handler: PlatformRuntimeHandler,
  operationIds?: readonly string[],
): PlatformRuntimeHandlerRegistration;
export function registerRuntimeHandler(
  jobId: string,
  handlers: Readonly<Record<string, PlatformRuntimeHandler>>,
): PlatformRuntimeHandlerRegistration;
export function registerRuntimeHandler(
  jobId: string,
  handlerOrMap: PlatformRuntimeHandler | Readonly<Record<string, PlatformRuntimeHandler>>,
  operationIds?: readonly string[],
): PlatformRuntimeHandlerRegistration {
  return platformRuntimeHandlerRegistry.register(jobId, handlerOrMap as never, operationIds);
}

export function unregisterRuntimeHandler(jobId: string, operationId?: string): boolean {
  return platformRuntimeHandlerRegistry.unregister(jobId, operationId);
}

export function invokeRuntimeHandler(context: PlatformRuntimeHandlerContext): Promise<unknown>;
export function invokeRuntimeHandler(
  jobId: string,
  operationId: string,
  input: unknown,
  eventId: string,
  metadata?: Pick<PlatformRuntimeHandlerContext, "projectId" | "canvasId" | "tokenId" | "idempotencyKey">,
): Promise<unknown>;
export function invokeRuntimeHandler(
  contextOrJobId: PlatformRuntimeHandlerContext | string,
  operationId?: string,
  input?: unknown,
  eventId?: string,
  metadata?: Pick<PlatformRuntimeHandlerContext, "projectId" | "canvasId" | "tokenId" | "idempotencyKey">,
): Promise<unknown> {
  if (typeof contextOrJobId === "string") {
    if (typeof operationId !== "string" || typeof eventId !== "string") {
      throw new TypeError("operationId and eventId are required");
    }
    return platformRuntimeHandlerRegistry.invoke(contextOrJobId, operationId, input, eventId, metadata);
  }
  return platformRuntimeHandlerRegistry.invoke(contextOrJobId);
}

export function listRuntimeHandlers(jobId?: string): readonly string[] | readonly PlatformRuntimeHandlerRegistration[] {
  return jobId === undefined ? platformRuntimeHandlerRegistry.list() : platformRuntimeHandlerRegistry.list(jobId);
}

// Explicit platform-prefixed aliases keep the executor integration stable if
// another runtime package already exports a generic runtime handler helper.
export const registerPlatformRuntimeHandler = registerRuntimeHandler;
export const unregisterPlatformRuntimeHandler = unregisterRuntimeHandler;
export const invokePlatformRuntimeHandler = invokeRuntimeHandler;
export const listPlatformRuntimeHandlers = listRuntimeHandlers;
