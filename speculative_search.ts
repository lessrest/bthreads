import { behavioralThreadSystem } from "./bthreads.ts"
import { createChannel, ensure, run, withResolvers } from "effection"

export type SearchEvent =
  | { type: "candidate"; worker: string; score: number }
  | { type: "coordination-complete" }

export interface SearchTrace {
  winner: string
  events: string[]
  finalized: string[]
}

interface Worker {
  name: string
  score: number
  priority: number
}

/**
 * A deterministic hedged search. `releaseOrder` simulates completion order;
 * it is deliberately channel-driven rather than timer-driven.
 */
export async function speculativeSearch(
  workers: Worker[],
  releaseOrder: string[],
  minimumScore: number,
): Promise<SearchTrace> {
  const events: string[] = []
  const finalized: string[] = []
  let winner = ""

  await run(() =>
    behavioralThreadSystem<SearchEvent>(function* (thread, sync) {
      const ready = createChannel<string>()
      const readyMessages = yield* ready
      const produced = createChannel<string>()
      const producedMessages = yield* produced
      const gates = new Map(
        workers.map((worker) => [worker.name, createChannel<void>()]),
      )
      const policyEvaluated = new Map(
        workers.map((worker) => [worker.name, withResolvers<void>()]),
      )

      for (const worker of workers) {
        yield* thread(worker.name, function* () {
          let completed = false
          const selected = yield sync({
            wait: (event) => event.type === "candidate",
            exec: function* () {
              const gate = gates.get(worker.name)!
              const gateMessages = yield* gate
              yield* ensure(() => {
                finalized.push(
                  `${worker.name}:${completed ? "completed" : "cancelled"}`,
                )
              })
              yield* ready.send(worker.name)
              yield* gateMessages.next()
              events.push(`available:${worker.name}`)
              yield* produced.send(worker.name)
              completed = true
              return {
                type: "candidate",
                worker: worker.name,
                score: worker.score,
              }
            },
          })
          // Every worker explicitly waits for the winner. Selecting it halts
          // any still-running exec (the actual hedge cancellation).
          if (selected.type !== "candidate") return
          events.push(`observed-winner:${worker.name}:${selected.worker}`)
        }, worker.priority)
      }

      yield* thread("quality policy", function* () {
        yield sync({
          halt: (event) => {
            if (event.type !== "candidate" || event.score >= minimumScore) {
              return false
            }
            policyEvaluated.get(event.worker)!.resolve()
            return true
          },
        })
      }, 100)

      yield* thread("winner observer", function* () {
        const selected = yield sync({
          wait: (event) => event.type === "candidate",
        })
        if (selected.type !== "candidate") return
        winner = selected.worker
        events.push(`winner:${selected.worker}`)
      })

      yield* thread("deterministic coordinator", function* () {
        yield sync({
          // Selecting an acceptable candidate cancels this coordinator before
          // it can try to release workers that the winner also cancelled.
          wait: (event) => event.type === "candidate",
          exec: function* () {
            for (let index = 0; index < workers.length; index++) {
              yield* readyMessages.next()
            }
            for (const name of releaseOrder) {
              yield* gates.get(name)!.send()
              yield* producedMessages.next()
              // Rejected candidates are acknowledged by the policy before the
              // next worker is released. An accepted candidate is selected
              // instead, which interrupts this operation at this wait.
              yield* policyEvaluated.get(name)!.operation
            }
            return { type: "coordination-complete" }
          },
        })
      }, 0)
    })
  )

  return { winner, events, finalized }
}

export function blockedThenAcceptable(): Promise<SearchTrace> {
  return speculativeSearch(
    [
      { name: "fast-but-poor", score: 20, priority: 1 },
      { name: "reliable", score: 90, priority: 1 },
      { name: "slow-hedge", score: 95, priority: 1 },
    ],
    ["fast-but-poor", "reliable", "slow-hedge"],
    80,
  )
}
