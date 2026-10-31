/**
 * Scheduler side of the managed Gateway proxy upstream (#685).
 *
 * Bridge deployments keep Scheduler on the business network only. The managed
 * proxy lives on sandbox-side networks and reaches Scheduler through a Unix
 * socket on a shared named volume, so no service-name lookup is involved and
 * multiple per-network DNS servers cannot disagree about the upstream.
 *
 * This is a byte-level relay to Scheduler's own TCP listener on loopback, so
 * every route, auth check and Job token rule stays exactly the same as TCP.
 * Path filtering (only /gateway and /control/v1) remains in the proxy.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

export type GatewayUpstreamSocketServer = {
  path: string;
  close: () => Promise<void>;
};

/** Loopback target for the relay; a wildcard listen address maps to loopback. */
export function relayTargetHost(listenHost: string): string {
  const host = listenHost.trim();
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

function removeStaleSocket(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Recreated Scheduler containers leave the old socket file behind on the
  // volume; anything else at this path is not ours to delete.
  if (!stat.isSocket()) throw new Error(`${path} 已存在且不是 Unix socket，拒绝覆盖`);
  rmSync(path, { force: true });
}

export async function startGatewayUpstreamSocket(input: {
  dir: string;
  socketName: string;
  targetHost: string;
  targetPort: number;
}): Promise<GatewayUpstreamSocketServer> {
  mkdirSync(input.dir, { recursive: true });
  const path = join(input.dir, input.socketName);
  removeStaleSocket(path);
  const sockets = new Set<net.Socket>();
  // allowHalfOpen: a client FIN after the request must not cut off the response.
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ host: input.targetHost, port: input.targetPort, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    const teardown = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("close", teardown);
    upstream.on("close", teardown);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The proxy image may run as a different uid; the volume is only shared with it.
  chmodSync(path, 0o666);
  return {
    path,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
