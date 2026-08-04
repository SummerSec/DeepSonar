import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { clearStreamForTests, streamSubscriberCount, subscribeStream } from "./stream-bus.js";
import { installWsCloseGuard, type WsCloseGuardSocket } from "./ws-early-close.js";

class FakeSocket extends EventEmitter implements WsCloseGuardSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;

  emitClose(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

test("early websocket close during delayed setup prevents a late subscription", async () => {
  clearStreamForTests();
  const socket = new FakeSocket();
  const guard = installWsCloseGuard(socket);
  const setup = new Promise<void>((resolve) => setTimeout(resolve, 5));
  socket.emitClose();
  await setup;

  assert.equal(guard.closed, true);
  if (guard.isOpen()) subscribeStream("delayed-job", () => {});
  assert.equal(streamSubscriberCount("delayed-job"), 0);
  guard.dispose();
});

test("early websocket close runs cleanup for a subscription created before the close", () => {
  clearStreamForTests();
  const socket = new FakeSocket();
  let unsubscribe = () => {};
  const guard = installWsCloseGuard(socket, () => unsubscribe());
  unsubscribe = subscribeStream("active-job", () => {});
  assert.equal(streamSubscriberCount("active-job"), 1);

  socket.emitClose();
  assert.equal(streamSubscriberCount("active-job"), 0);
  assert.equal(guard.closed, true);
  guard.dispose();
  clearStreamForTests();
});

