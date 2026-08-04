import assert from "node:assert/strict";
import test from "node:test";
import { WsSendQueue, type WsSendSocket } from "./ws-send-queue.js";

function fakeSocket(): WsSendSocket & { sent: string[]; callbacks: Array<(error?: Error) => void>; closed?: [number, string] } {
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    callbacks: [] as Array<(error?: Error) => void>,
    closed: undefined as [number, string] | undefined,
    send(data: string, callback: (error?: Error) => void) {
      this.sent.push(data);
      this.callbacks.push(callback);
    },
    close(code: number, reason: string) {
      this.closed = [code, reason] as [number, string];
      this.readyState = 3;
    },
  };
  return socket;
}

test("slow websocket uses one-flight callbacks and closes on queue overflow", () => {
  const socket = fakeSocket();
  const queue = new WsSendQueue(socket, { maxItems: 2, maxBytes: 1024 });
  assert.equal(queue.enqueue({ n: 1 }), true);
  assert.equal(socket.sent.length, 1);
  // The first callback is intentionally withheld: synchronous send() must not
  // drain later frames and a slow client must hit the hard queue bound.
  assert.equal(queue.enqueue({ n: 2 }), true);
  assert.equal(queue.enqueue({ n: 3 }), false);
  assert.deepEqual(socket.closed, [1013, "stream backpressure"]);
});

test("send callback releases the single-flight gate", () => {
  const socket = fakeSocket();
  const queue = new WsSendQueue(socket, { maxItems: 4, maxBytes: 1024 });
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  assert.equal(socket.sent.length, 1);
  socket.callbacks.shift()?.();
  assert.equal(socket.sent.length, 2);
});
