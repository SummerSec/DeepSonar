import assert from "node:assert/strict";
import test from "node:test";
import { withProvisionTimeout } from "./dispatcher.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("provision timeout waits for aborted create to settle before releasing the caller", async () => {
  const provision = deferred<{ sandboxId: string }>();
  const timeoutStarted = deferred<void>();
  let returned = false;
  const result = withProvisionTimeout(
    provision.promise,
    1,
    "provision timed out",
    async () => timeoutStarted.resolve(),
    async () => {},
  ).finally(() => { returned = true; });

  await timeoutStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(returned, false);

  provision.reject(new Error("create aborted"));
  await assert.rejects(result, /provision timed out/);
  assert.equal(returned, true);
});

test("late provision success is destroyed before timeout reaches the caller", async () => {
  const provision = deferred<{ sandboxId: string }>();
  const timeoutStarted = deferred<void>();
  const destroyed: string[] = [];
  const result = withProvisionTimeout(
    provision.promise,
    1,
    "provision timed out",
    async () => timeoutStarted.resolve(),
    async (handle) => { destroyed.push(handle.sandboxId); },
  );

  await timeoutStarted.promise;
  provision.resolve({ sandboxId: "late-sandbox" });
  await assert.rejects(result, /provision timed out/);
  assert.deepEqual(destroyed, ["late-sandbox"]);
});
