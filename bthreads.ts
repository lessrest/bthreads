/**
 * A TypeScript implementation of behavioral threads (b-threads) with async operation support,
 * using Effection for structured concurrency.
 */
import {
  Operation,
  Task,
  Channel,
  Result,
  spawn,
  createChannel,
  call,
} from "npm:effection"

/**
 * The state of an executable operation in a thread
 */
export type Exec<Event> =
  | { state: "none" }
  | { state: "pending"; op: () => Operation<Event> }
  | { state: "running"; task: Task<void> }
  | { state: "done"; result: Result<Event> }

/**
 * Thread synchronization specification at a sync point
 */
export interface Sync<Event> {
  /** Events to request */
  post: Event[]
  /** Predicate for events to wait for */
  wait: (event: Event) => boolean
  /** Predicate for events to block */
  halt: (event: Event) => boolean
  /** Optional async operation to execute */
  exec: Exec<Event>
}

/**
 * A behavioral thread instance
 */
export interface Thread<Event> {
  name: string
  sync: Sync<Event>
  proc: Generator<Sync<Event>, void, Event>
  prio: number
}

/**
 * Configuration for creating a sync point
 */
export interface SyncOptions<Event> {
  /** Events to request */
  post?: Event[]
  /** Predicate for events to wait for */
  wait?: (event: Event) => boolean
  /** Predicate for events to block */
  halt?: (event: Event) => boolean
  /** Async operation to execute */
  exec?: () => Operation<Event>
}

/**
 * Creates a new sync point specification
 */
export function makeSyncSpec<Event>({
  post = [],
  wait = () => false,
  halt = () => false,
  exec,
}: Partial<SyncOptions<Event>>): Sync<Event> {
  return {
    post,
    wait,
    halt,
    exec: exec ? { state: "pending", op: exec } : { state: "none" },
  }
}

/**
 * Configuration for creating a behavioral thread
 */
export interface ThreadOptions<Event> {
  /** Thread name for debugging */
  name: string
  /** Thread priority (higher runs first) */
  prio?: number
  /** Thread behavior generator */
  behavior: () => Generator<Sync<Event>, void, Event>
}

/**
 * Creates a new behavioral thread
 */
function makeThread<Event>({
  name,
  prio = 1,
  behavior,
}: ThreadOptions<Event>): Thread<Event> {
  const proc = behavior()
  const { done, value: sync } = proc.next()
  return done ? createEmptyThread(name) : { name, prio, proc, sync }
}

/**
 * Creates an empty thread (useful for completion)
 */
function createEmptyThread<Event>(name: string): Thread<Event> {
  return {
    name,
    proc: (function* () {})(),
    sync: makeSyncSpec({}),
    prio: 0,
  }
}

/**
 * Starts a thread's pending operation if it has one.
 * The operation runs until either:
 * 1. It completes naturally, in which case its result becomes a post
 * 2. The thread receives an event it's waiting for, which halts the operation
 */
function* startThreadOperationIfNecessary<Event>(
  thread: Thread<Event>,
  completionChannel: Channel<void, void>
) {
  if (thread.sync.exec.state === "pending") {
    const operation = thread.sync.exec.op
    const operationTask = yield* spawn(function* () {
      try {
        const x = yield* operation()
        markExecutionAsDone(x)
      } catch (e: unknown) {
        console.error("Thread operation error", thread.name, e)
        markExecutionAsFailed(e)
      } finally {
        yield* completionChannel.send()
      }
    })

    markOperationAsRunning(operationTask)
  }

  function markOperationAsRunning(operationTask: Task<void>) {
    thread.sync.exec = { state: "running", task: operationTask }
  }

  function markExecutionAsFailed(e: unknown) {
    thread.sync.exec = {
      state: "done",
      result: { ok: false, error: e as Error },
    }
  }

  function markExecutionAsDone(x: Event) {
    thread.sync.exec = {
      state: "done",
      result: { ok: true, value: x },
    }
  }
}

/**
 * Core scheduling function that:
 * 1. Processes completed operations, turning their results into posts
 * 2. Selects the highest priority non-blocked requested event
 * 3. Advances threads that posted or were waiting for the selected event
 */
function* schedule<Event>(
  threads: Set<Thread<Event>>,
  notify: Channel<void, void>
): Operation<boolean> {
  let didWork = false

  // Handle completed operations
  for (const thread of threads) {
    if (thread.sync.exec.state === "done") {
      const { result } = thread.sync.exec
      if (result.ok) {
        thread.sync.exec = { state: "none" }
        thread.sync.post = [result.value]
      } else {
        const { done, value: sync } = thread.proc.throw(result.error)
        if (done) {
          threads.delete(thread)
        } else {
          thread.sync = sync
          yield* startThreadOperationIfNecessary(thread, notify)
        }
      }
      didWork = true
    }
  }

  // Select next event
  const selectedEvent = [...threads]
    .sort((a, b) => b.prio - a.prio)
    .flatMap((x) => x.sync.post)
    .find(
      (x) =>
        ![...threads].some((y) => {
          const halted = y.sync.halt(x)
          if (halted) {
            console.debug(x, "halted by", y.name)
          }
          return halted
        })
    )

  if (selectedEvent) {
    console.debug(`Selected event`, selectedEvent)
    // Advance threads affected by selected event
    for (const thread of threads) {
      const { post, wait, exec } = thread.sync
      if (post.includes(selectedEvent) || wait(selectedEvent)) {
        if (exec.state === "running") {
          yield* exec.task.halt()
          thread.sync.exec = { state: "none" }
        }

        const { done, value } = thread.proc.next(selectedEvent)
        if (done) {
          threads.delete(thread)
        } else {
          thread.sync = value
          yield* startThreadOperationIfNecessary(thread, notify)
        }
      }
    }
    didWork = true
  } else {
    console.debug("No event selected")
  }

  return didWork
}

/**
 * Creates and runs a system of behavioral threads.
 *
 * The system operation:
 * 1. Accepts a body that can spawn threads using the provided thread factory
 * 2. Maintains a set of active threads and their synchronization states
 * 3. Coordinates threads through a turn-based event selection process where:
 *    - Threads declare events they request, wait for, or block
 *    - The system selects a non-blocked requested event
 *    - Affected threads advance and may start new operations
 * 4. Supports async operations that can be interrupted by events
 *
 */
export function* behavioralThreadSystem<Event, V = void>(
  body: (
    addBehavioralThread: {
      (
        name: string,
        behavior: () => Generator<Sync<Event>, void, Event>
      ): Operation<void>
    },
    sync: typeof makeSyncSpec<Event>
  ) => Operation<V>
): Operation<V> {
  console.debug("Starting behavioral thread system")

  // This channel is used to notify the scheduler that a new thread has been created
  const heyThereIsANewPendingThread = createChannel<void>()

  // Set of threads that will be started
  const pendingThreads = new Set<Thread<Event>>()

  // Run the body with thread factory
  const result = yield* body(function* (
    name: string,
    behavior: () => Generator<Sync<Event>, void, Event>
  ) {
    console.debug(`Creating new thread: ${name}`)
    const thread = makeThread({ name, behavior })
    yield* startThreadOperationIfNecessary(
      thread,
      heyThereIsANewPendingThread
    )
    pendingThreads.add(thread)
    yield* heyThereIsANewPendingThread.send()
  },
  makeSyncSpec)

  let activeThreads = new Set<Thread<Event>>()

  // Main scheduling loop
  try {
    yield* call(function* () {
      console.debug("Starting scheduler")
      for (;;) {
        // Incorporate any new threads
        if (pendingThreads.size > 0) {
          console.debug(
            `Adding ${pendingThreads.size} new threads to active set`
          )
          activeThreads = new Set([...activeThreads, ...pendingThreads])
          pendingThreads.clear()
        }

        const pendingThreadNotifications = yield* heyThereIsANewPendingThread

        // Process until no more work to do
        for (;;) {
          console.debug(
            `Processing schedule iteration with ${activeThreads.size} active threads`
          )
          if (
            false ===
            (yield* schedule(activeThreads, heyThereIsANewPendingThread))
          ) {
            console.debug("No more work to do in current schedule iteration")
            break
          }
        }

        if (pendingThreads.size === 0) {
          console.debug("No more active or pending threads")
          break
        }

        console.log(
          Deno.inspect(
            { activeThreads, pendingThreads },
            { depth: 10, colors: true }
          )
        )

        console.debug("Checking for notifications")

        // Check if we're done
        const notificationsResult = yield* pendingThreadNotifications.next()
        if (notificationsResult.done) {
          console.debug("Notification channel closed")
          break
        } else {
          console.debug("Notification received")
        }
      }
      console.debug("Scheduler complete, sending completion notification")
    })
  } catch (e) {
    console.error("Scheduler error", e)
  } finally {
    console.debug("Cleaning up scheduler")
  }

  yield* heyThereIsANewPendingThread.close()
  return result
}
