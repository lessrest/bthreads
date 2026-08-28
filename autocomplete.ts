import { behavioralThreadSystem } from "./bthreads.ts"
import { createChannel, Operation } from "effection"

export type AutocompleteEvent =
  | { type: "query"; value: string }
  | { type: "result"; query: string; suggestions: string[] }

export interface AutocompleteRun {
  results: Extract<AutocompleteEvent, { type: "result" }>[]
  cancelledQueries: string[]
}

const isQuery = (
  event: AutocompleteEvent,
): event is Extract<AutocompleteEvent, { type: "query" }> =>
  event.type === "query"

/**
 * A deterministic, latest-only autocomplete run.
 *
 * The input b-thread is the system's external-input boundary. Its second
 * operation waits until the first request has started before posting the
 * replacement query. The first request deliberately remains pending, so the
 * replacement demonstrates that an event matched by `wait` halts `exec`.
 */
export function* runLatestOnlyAutocomplete(): Operation<AutocompleteRun> {
  const firstRequestStarted = createChannel<void>()
  const starts = yield* firstRequestStarted
  const neverCompleteStaleRequest = createChannel<void>()
  const staleGate = yield* neverCompleteStaleRequest

  const results: AutocompleteRun["results"] = []
  const cancelledQueries: string[] = []

  yield* behavioralThreadSystem<AutocompleteEvent>(function* (thread, sync) {
    yield* thread("query input", function* () {
      yield sync({
        exec: function* () {
          return { type: "query", value: "den" }
        },
      })
      yield sync({
        exec: function* () {
          yield* starts.next()
          return { type: "query", value: "deno" }
        },
      })
    })

    yield* thread("latest request", function* () {
      let event = yield sync({ wait: isQuery })

      while (isQuery(event)) {
        const query = event.value
        event = yield sync({
          wait: isQuery,
          exec: function* () {
            let completed = false
            try {
              if (query === "den") {
                yield* firstRequestStarted.send()
                yield* staleGate.next()
              }
              completed = true
              return {
                type: "result",
                query,
                suggestions: [`${query}.land`, `${query} docs`],
              }
            } finally {
              if (!completed) cancelledQueries.push(query)
            }
          },
        })
      }
    })

    yield* thread("result view", function* () {
      const event = yield sync({ wait: (event) => event.type === "result" })
      if (event.type === "result") results.push(event)
    })
  })

  return { results, cancelledQueries }
}
