import { behavioralThreadSystem } from "./bthreads.ts"
import { main, sleep } from "effection"

async function example() {
  await main(() =>
    behavioralThreadSystem(function* (thread, sync) {
      // Worker thread with timeout
      yield* thread("worker", function* () {
        const result = yield sync({
          wait: (e) => e === "timeout", // Can be interrupted by timeout
          exec: function* () {
            // Async operation to attempt
            yield* sleep(2000)
            return "completed"
          },
        })
        console.log("worker done", result)
      })

      // Timer thread
      yield* thread("timer", function* () {
        yield sync({
          exec: function* () {
            yield* sleep(1000)
            return "timeout"
          },
        })
        console.log("timer done")
      })
    })
  )
}

if (import.meta.main) {
  await example()
}
