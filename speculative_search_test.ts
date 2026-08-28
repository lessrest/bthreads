import { assertEquals } from "@std/assert"
import { blockedThenAcceptable } from "./speculative_search.ts"

Deno.test("blocked result is skipped and winner cancels outstanding hedge", async () => {
  const trace = await blockedThenAcceptable()

  assertEquals(trace.winner, "reliable")
  assertEquals(trace.events, [
    "available:fast-but-poor",
    "available:reliable",
    "observed-winner:fast-but-poor:reliable",
    "observed-winner:reliable:reliable",
    "observed-winner:slow-hedge:reliable",
    "winner:reliable",
  ])
  assertEquals(trace.finalized.sort(), [
    "fast-but-poor:completed",
    "reliable:completed",
    "slow-hedge:cancelled",
  ])
})
