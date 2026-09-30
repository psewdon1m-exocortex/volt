import assert from "node:assert/strict";
import test from "node:test";

import { normalize } from "../src/service-logs.js";

test("service log statuses have stable labels and tones", () => {
  assert.deepEqual(
    [201, 304, 503, "completed", "warning", "info"].map(status => {
      const event = normalize({ id: status, status });
      return [event.outcome, event.tone];
    }),
    [
      ["SUCCESS", "success"],
      ["NOT-MODIFIED", "neutral"],
      ["ERROR", "error"],
      ["COMPLETED", "success"],
      ["WARNING", "warning"],
      ["INFO", "neutral"],
    ],
  );
});

test("service log normalization preserves a stable cursor and safe target label", () => {
  assert.deepEqual(
    normalize({ event_id: "event-7", sequence: 42, action: "Rotated", target: { id: "client-2" }, occurred_at: "2026-09-30T08:00:00Z" }),
    {
      outcome: "INFO",
      tone: "neutral",
      id: "event-7",
      cursor: 42,
      timestamp: "2026-09-30T08:00:00Z",
      body: "Rotated · client-2",
    },
  );
});
