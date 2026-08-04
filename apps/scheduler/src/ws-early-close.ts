/**
 * Install a close/error guard before any asynchronous WebSocket setup work.
 *
 * Fastify's upgrade handler can spend time in database/evidence reads.  A
 * client may close during that window, before the normal stream cleanup
 * listener is installed.  The guard records that state and invokes the final
 * cleanup once it becomes available, preventing a late subscription leak.
 */
export interface WsCloseGuardSocket {
  readonly OPEN: number;
  readonly readyState: number;
  on(event: "close" | "error", listener: () => void): unknown;
  off(event: "close" | "error", listener: () => void): unknown;
}

export interface WsCloseGuard {
  readonly closed: boolean;
  isOpen(): boolean;
  dispose(): void;
}

export function installWsCloseGuard(
  socket: WsCloseGuardSocket,
  onClose?: () => void,
): WsCloseGuard {
  let closed = socket.readyState !== socket.OPEN;
  let disposed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  socket.on("close", markClosed);
  socket.on("error", markClosed);
  return {
    get closed() {
      return closed;
    },
    isOpen: () => !closed && socket.readyState === socket.OPEN,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      socket.off("close", markClosed);
      socket.off("error", markClosed);
    },
  };
}

