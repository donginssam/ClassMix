import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { expect, it, vi } from "vitest";
import { subscribeToTauri } from "./tauriListener";

it("removes a listener that finishes registering after cleanup", async () => {
  let finishRegistration!: (stop: UnlistenFn) => void;
  const registration = new Promise<UnlistenFn>((resolve) => {
    finishRegistration = resolve;
  });
  const unlisten = vi.fn();
  const receive = vi.fn();
  let dispatch: EventCallback<string> | undefined;
  const dispose = subscribeToTauri<string>((listener) => {
    dispatch = listener;
    return registration;
  }, receive);
  const event = { event: "example", id: 1, payload: "value" };

  dispatch?.(event);
  expect(receive).toHaveBeenCalledExactlyOnceWith(event);
  dispose();
  dispatch?.(event);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(unlisten).not.toHaveBeenCalled();

  finishRegistration(unlisten);
  await registration;
  expect(unlisten).toHaveBeenCalledTimes(1);
});
