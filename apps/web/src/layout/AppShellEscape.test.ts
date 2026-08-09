import assert from "node:assert/strict";
import test from "node:test";
import { consumeAppShellEscape } from "./AppShell";

function escapeEvent() {
  return {
    key: "Escape",
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

test("Escape consumes the top AppShell overlay before canvas selection", () => {
  const event = escapeEvent();
  const actions: string[] = [];

  const consumed = consumeAppShellEscape(
    event,
    { commandOpen: true, menuOpen: true },
    () => actions.push("command"),
    () => actions.push("menu"),
  );

  assert.equal(consumed, true);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(actions, ["command"]);

  const menuEvent = escapeEvent();
  const menuActions: string[] = [];
  const menuConsumed = consumeAppShellEscape(
    menuEvent,
    { commandOpen: false, menuOpen: true },
    () => menuActions.push("command"),
    () => menuActions.push("menu"),
  );

  assert.equal(menuConsumed, true);
  assert.equal(menuEvent.defaultPrevented, true);
  assert.deepEqual(menuActions, ["menu"]);
});

test("Escape remains available to CanvasView when AppShell has no overlay", () => {
  const event = escapeEvent();
  const actions: string[] = [];

  const consumed = consumeAppShellEscape(
    event,
    { commandOpen: false, menuOpen: false },
    () => actions.push("command"),
    () => actions.push("menu"),
  );

  assert.equal(consumed, false);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(actions, []);
});
