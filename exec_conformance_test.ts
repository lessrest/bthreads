import { behavioralThreadSystem } from "./bthreads.ts"
import { assertEquals, assertRejects } from "@std/assert"
import { ensure, run, withResolvers } from "effection"

const TEST_OPTIONS = { timeout: 5000 }

Deno.test({
  name:
    "a selected event interrupts every matching exec and waits for cleanup",
  ...TEST_OPTIONS,
  fn: async () => {
    const firstStarted = withResolvers<void>()
    const secondStarted = withResolvers<void>()
    const never = withResolvers<string>()
    const finalized: string[] = []
    const observed: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        for (
          const [name, started] of [
            ["first", firstStarted] as const,
            ["second", secondStarted] as const,
          ]
        ) {
          yield* thread(name, function* () {
            const event = yield sync({
              wait: (event) => event === "stop",
              exec: function* () {
                yield* ensure(() => {
                  finalized.push(name)
                })
                started.resolve()
                return yield* never.operation
              },
            })
            observed.push(`${name}:${event}`)
          })
        }

        yield* thread("stop source", function* () {
          yield sync({
            exec: function* () {
              yield* firstStarted.operation
              yield* secondStarted.operation
              return "stop"
            },
          })
        })
      })
    )

    assertEquals(finalized.sort(), ["first", "second"])
    assertEquals(observed.sort(), ["first:stop", "second:stop"])
  },
})

Deno.test({
  name: "an exec failure is thrown into its b-thread and can be recovered",
  ...TEST_OPTIONS,
  fn: async () => {
    const failure = new Error("operation failed")
    const caught: unknown[] = []
    const observed: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("recovering worker", function* () {
          try {
            yield sync({
              exec: function* () {
                throw failure
              },
            })
          } catch (error) {
            caught.push(error)
          }
          yield sync({ post: ["recovered"] })
        })

        yield* thread("observer", function* () {
          observed.push(
            yield sync({ wait: (event) => event === "recovered" }),
          )
        })
      })
    )

    assertEquals(caught, [failure])
    assertEquals(observed, ["recovered"])
  },
})

Deno.test({
  name: "an uncaught exec failure rejects the system",
  ...TEST_OPTIONS,
  fn: async () => {
    await assertRejects(
      () =>
        run(() =>
          behavioralThreadSystem<string>(function* (thread, sync) {
            yield* thread("failing worker", function* () {
              yield sync({
                exec: function* () {
                  throw new Error("exec failed")
                },
              })
            })
          })
        ),
      Error,
      "exec failed",
    )
  },
})

Deno.test({
  name:
    "a blocked exec result remains pending and is selected after unblocking",
  ...TEST_OPTIONS,
  fn: async () => {
    const resultWasBlocked = withResolvers<void>()
    const observed: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("worker", function* () {
          yield sync({
            exec: function* () {
              return "result"
            },
          })
        })

        yield* thread("temporary policy", function* () {
          yield sync({
            wait: (event) => event === "unblock",
            halt: (event) => {
              if (event === "result") resultWasBlocked.resolve()
              return event === "result"
            },
          })
        }, 10)

        yield* thread("unblock source", function* () {
          yield sync({
            exec: function* () {
              yield* resultWasBlocked.operation
              return "unblock"
            },
          })
        })

        yield* thread("observer", function* () {
          observed.push(yield sync({ wait: (event) => event === "result" }))
        })
      })
    )

    assertEquals(observed, ["result"])
  },
})

Deno.test({
  name:
    "selecting an immediate post halts a concurrent exec before advancing",
  ...TEST_OPTIONS,
  fn: async () => {
    const started = withResolvers<void>()
    const never = withResolvers<string>()
    const trace: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("worker", function* () {
          const event = yield sync({
            post: ["immediate"],
            exec: function* () {
              yield* ensure(() => {
                trace.push("exec finalized")
              })
              started.resolve()
              return yield* never.operation
            },
          })
          trace.push(`selected ${event}`)
        })

        // Do not let the scheduler select the post until the exec is running.
        yield* started.operation
      })
    )

    assertEquals(trace, ["exec finalized", "selected immediate"])
  },
})

Deno.test({
  name: "exec completion preserves existing posts at its sync point",
  ...TEST_OPTIONS,
  fn: async () => {
    const resultWasBlocked = withResolvers<void>()
    const selected: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("worker", function* () {
          selected.push(
            yield sync({
              post: ["original"],
              exec: function* () {
                return "exec result"
              },
            }),
          )
        })

        yield* thread("temporary policy", function* () {
          yield sync({
            wait: (event) => event === "unblock",
            halt: (event) => {
              if (event === "exec result") resultWasBlocked.resolve()
              return event === "original" || event === "exec result"
            },
          })
        }, 10)

        yield* thread("unblock source", function* () {
          yield sync({
            exec: function* () {
              yield* resultWasBlocked.operation
              return "unblock"
            },
          })
        })
      })
    )

    // Existing posts retain declaration order ahead of the delayed request.
    assertEquals(selected, ["original"])
  },
})

Deno.test({
  name:
    "thread priority orders exec results pending in the same scheduler turn",
  ...TEST_OPTIONS,
  fn: async () => {
    type Event = { type: "result"; worker: string } | { type: "unblock" }
    const blockedWorkers = new Set<string>()
    const bothResultsBlocked = withResolvers<void>()
    const observed: string[] = []

    await run(() =>
      behavioralThreadSystem<Event>(function* (thread, sync) {
        for (const [name, priority] of [["low", 1], ["high", 10]] as const) {
          yield* thread(name, function* () {
            yield sync({
              exec: function* () {
                return { type: "result", worker: name }
              },
            })
          }, priority)
        }

        yield* thread("temporary policy", function* () {
          yield sync({
            wait: (event) => event.type === "unblock",
            halt: (event) => {
              if (event.type !== "result") return false
              blockedWorkers.add(event.worker)
              if (blockedWorkers.size === 2) bothResultsBlocked.resolve()
              return true
            },
          })
        })

        yield* thread("unblock source", function* () {
          yield sync({
            exec: function* () {
              yield* bothResultsBlocked.operation
              return { type: "unblock" }
            },
          })
        })

        yield* thread("observer", function* () {
          for (let index = 0; index < 2; index++) {
            const event = yield sync({
              wait: (event) => event.type === "result",
            })
            if (event.type === "result") observed.push(event.worker)
          }
        })
      })
    )

    assertEquals(observed, ["high", "low"])
  },
})

Deno.test({
  name: "falsy exec results are selectable events",
  ...TEST_OPTIONS,
  fn: async () => {
    const expected: unknown[] = [0, false, "", undefined]
    const observed: unknown[] = []

    await run(() =>
      behavioralThreadSystem<unknown>(function* (thread, sync) {
        yield* thread("worker", function* () {
          for (const result of expected) {
            observed.push(
              yield sync({
                exec: function* () {
                  return result
                },
              }),
            )
          }
        })
      })
    )

    assertEquals(observed, expected)
  },
})

Deno.test({
  name: "halting the system finalizes its running exec operations",
  ...TEST_OPTIONS,
  fn: async () => {
    const started = Promise.withResolvers<void>()
    const never = withResolvers<string>()
    const finalized: string[] = []

    const task = run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("worker", function* () {
          yield sync({
            exec: function* () {
              yield* ensure(() => {
                finalized.push("worker")
              })
              started.resolve()
              return yield* never.operation
            },
          })
        })
      })
    )

    await started.promise
    await task.halt()

    assertEquals(finalized, ["worker"])
  },
})

Deno.test({
  name: "natural quiescence closes suspended b-thread generators",
  ...TEST_OPTIONS,
  fn: async () => {
    const finalized: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("waiting thread", function* () {
          try {
            yield sync({ wait: () => true })
          } finally {
            finalized.push("waiting thread")
          }
        })
      })
    )

    assertEquals(finalized, ["waiting thread"])
  },
})

Deno.test({
  name: "system failure closes sibling b-thread generators",
  ...TEST_OPTIONS,
  fn: async () => {
    const finalized: string[] = []

    await assertRejects(() =>
      run(() =>
        behavioralThreadSystem<string>(function* (thread, sync) {
          yield* thread("waiting sibling", function* () {
            try {
              yield sync({ wait: () => true })
            } finally {
              finalized.push("waiting sibling")
            }
          })

          yield* thread("failing thread", function* () {
            yield sync({ post: ["fail"] })
            throw new Error("behavior failed")
          })
        })
      )
    )

    assertEquals(finalized, ["waiting sibling"])
  },
})

Deno.test({
  name: "halting the system closes suspended b-thread generators",
  ...TEST_OPTIONS,
  fn: async () => {
    const started = Promise.withResolvers<void>()
    const never = withResolvers<string>()
    const finalized: string[] = []

    const task = run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("worker", function* () {
          try {
            yield sync({
              exec: function* () {
                started.resolve()
                return yield* never.operation
              },
            })
          } finally {
            finalized.push("worker")
          }
        })
      })
    )

    await started.promise
    await task.halt()

    assertEquals(finalized, ["worker"])
  },
})

Deno.test({
  name:
    "an exec teardown failure rejects instead of advancing on interruption",
  ...TEST_OPTIONS,
  fn: async () => {
    const started = withResolvers<void>()
    const never = withResolvers<string>()

    await assertRejects(
      () =>
        run(() =>
          behavioralThreadSystem<string>(function* (thread, sync) {
            yield* thread("worker", function* () {
              yield sync({
                wait: (event) => event === "stop",
                exec: function* () {
                  try {
                    started.resolve()
                    return yield* never.operation
                  } finally {
                    throw new Error("exec teardown failed")
                  }
                },
              })
            })

            yield* thread("stop source", function* () {
              yield sync({
                exec: function* () {
                  yield* started.operation
                  return "stop"
                },
              })
            })
          })
        ),
      Error,
      "exec teardown failed",
    )
  },
})

Deno.test({
  name: "a teardown failure does not prevent sibling exec cleanup",
  ...TEST_OPTIONS,
  fn: async () => {
    const bothStarted = Promise.withResolvers<void>()
    const never = withResolvers<string>()
    const finalized: string[] = []
    let started = 0

    const task = run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        for (const name of ["failing", "sibling"]) {
          yield* thread(name, function* () {
            yield sync({
              exec: function* () {
                try {
                  started++
                  if (started === 2) bothStarted.resolve()
                  return yield* never.operation
                } finally {
                  finalized.push(name)
                  if (name === "failing") {
                    throw new Error("teardown failed")
                  }
                }
              },
            })
          })
        }
      })
    )

    await bothStarted.promise
    await assertRejects(() => task.halt(), Error, "teardown failed")

    assertEquals(finalized.sort(), ["failing", "sibling"])
  },
})

Deno.test({
  name: "a throwing generator finalizer does not prevent sibling cleanup",
  ...TEST_OPTIONS,
  fn: async () => {
    const finalized: string[] = []

    await assertRejects(
      () =>
        run(() =>
          behavioralThreadSystem<string>(function* (thread, sync) {
            yield* thread("throwing", function* () {
              try {
                yield sync({ wait: () => true })
              } finally {
                finalized.push("throwing")
                throw new Error("generator cleanup failed")
              }
            })

            yield* thread("sibling", function* () {
              try {
                yield sync({ wait: () => true })
              } finally {
                finalized.push("sibling")
              }
            })
          })
        ),
      Error,
      "generator cleanup failed",
    )

    assertEquals(finalized.sort(), ["sibling", "throwing"])
  },
})

Deno.test({
  name: "yielding from a b-thread finalizer is a cleanup contract error",
  ...TEST_OPTIONS,
  fn: async () => {
    await assertRejects(
      () =>
        run(() =>
          behavioralThreadSystem<string>(function* (thread, sync) {
            yield* thread("invalid finalizer", function* () {
              try {
                yield sync({ wait: () => true })
              } finally {
                yield sync({ post: ["invalid async cleanup"] })
              }
            })
          })
        ),
      Error,
      'B-thread "invalid finalizer" yielded during synchronous cleanup',
    )
  },
})

Deno.test({
  name: "body failure closes b-threads created before scheduling starts",
  ...TEST_OPTIONS,
  fn: async () => {
    const finalized: string[] = []

    await assertRejects(
      () =>
        run(() =>
          behavioralThreadSystem<string>(function* (thread, sync) {
            yield* thread("pending", function* () {
              try {
                yield sync({ wait: () => true })
              } finally {
                finalized.push("pending")
              }
            })
            throw new Error("body failed")
          })
        ),
      Error,
      "body failed",
    )

    assertEquals(finalized, ["pending"])
  },
})

Deno.test({
  name: "cleanup errors retain the primary system failure",
  ...TEST_OPTIONS,
  fn: async () => {
    const error = await assertRejects(
      () =>
        run(() =>
          behavioralThreadSystem<string>(function* (thread, sync) {
            yield* thread("bad cleanup", function* () {
              try {
                yield sync({ wait: (event) => event === "never" })
              } finally {
                throw new Error("cleanup failed")
              }
            })

            yield* thread("failing", function* () {
              yield sync({ post: ["fail"] })
              throw new Error("primary failure")
            })
          })
        ),
      AggregateError,
      "Behavioral thread system and cleanup failed",
    )

    assertEquals(
      error.errors.map((item) => (item as Error).message),
      ["primary failure", "cleanup failed"],
    )
  },
})

Deno.test({
  name: "exec failure abandons ordinary posts from the same sync point",
  ...TEST_OPTIONS,
  fn: async () => {
    const observed: string[] = []

    await run(() =>
      behavioralThreadSystem<string>(function* (thread, sync) {
        yield* thread("worker", function* () {
          try {
            yield sync({
              post: ["ordinary"],
              exec: function* () {
                throw new Error("expected failure")
              },
            })
          } catch {
            yield sync({ post: ["recovered"] })
          }
        })

        yield* thread("ordinary post blocker", function* () {
          yield sync({ halt: (event) => event === "ordinary" })
        })

        yield* thread("observer", function* () {
          observed.push(
            yield sync({ wait: (event) => event === "recovered" }),
          )
        })
      })
    )

    assertEquals(observed, ["recovered"])
  },
})
