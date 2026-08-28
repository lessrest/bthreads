import { assertEquals } from "@std/assert"
import { run } from "effection"
import { runLatestOnlyAutocomplete } from "./autocomplete.ts"

Deno.test("autocomplete interrupts stale exec and emits only latest result", async () => {
  const outcome = await run(runLatestOnlyAutocomplete)

  assertEquals(outcome.cancelledQueries, ["den"])
  assertEquals(outcome.results, [{
    type: "result",
    query: "deno",
    suggestions: ["deno.land", "deno docs"],
  }])
})
