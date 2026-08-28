import { behavioralThreadSystem } from "./bthreads.ts"

import { assertEquals } from "@std/assert"
import { run, sleep } from "effection"

const TEST_OPTIONS = {
  timeout: 5000,
}

Deno.test({
  name: "basic event coordination",
  ...TEST_OPTIONS,
  fn: async () => {
    const events: string[] = []
    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("producer", function* () {
          yield sync({ post: ["event1"] })
          console.log("posted event1")
          yield sync({ post: ["event2"] })
          console.log("posted event2")
        })

        yield* thread("consumer", function* () {
          yield sync({ wait: (e) => e === "event1" })
          console.log("received event1")
          events.push("received event1")
          yield sync({ wait: (e) => e === "event2" })
          console.log("received event2")
          events.push("received event2")
        })

        console.log("started threads")
      })
    )

    console.log(events)

    assertEquals(events, ["received event1", "received event2"])
  },
})

Deno.test({
  name: "async operation completion is scheduled as an event",
  ...TEST_OPTIONS,
  fn: async () => {
    const events: number[] = []

    await run(() =>
      behavioralThreadSystem<number>(function* (thread, sync) {
        yield* thread("async producer", function* () {
          const event = yield sync({
            exec: function* () {
              yield* sleep(1)
              return 42
            },
          })
          events.push(event)
        })
      })
    )

    assertEquals(events, [42])
  },
})
