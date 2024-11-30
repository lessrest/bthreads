# Behavioral Threads with Async Operations

A TypeScript implementation of behavioral programming that adds support for
interruptible async operations, built on the
[Effection](https://frontside.com/effection/) structured concurrency library.

## What are Behavioral Threads?

Behavioral threads (b-threads) are a programming model introduced by David
Harel for coordinating concurrent behaviors through synchronization points. At
each sync point, threads declare:

- Events they want to REQUEST
- Events they are willing to WAIT for
- Events they want to BLOCK

The system then coordinates these threads by:

1. Collecting all requested events
2. Filtering out blocked events
3. Selecting a remaining event (favoring higher priority threads)
4. Advancing all threads that requested or waited for the selected event

This creates a powerful model for expressing complex behaviors as a collection
of simple, independent threads that coordinate through events.

## Async Extension

This library extends behavioral threads with support for async operations that
can be interrupted by events. At each sync point, a thread can:

- Declare standard b-thread synchronization (request/wait/block)
- Start an async operation that runs until either:
  - It completes naturally, producing an event
  - The thread receives an event it was waiting for

```typescript
// Example: Worker with timeout
yield sync({
  wait: (e) => e === "timeout", // Can be interrupted by timeout
  exec: function* () {
    // Async operation to attempt
    yield* expensiveOperation()
    return "completed" // Only reaches here if not interrupted
  },
})
```

This creates a clean way to integrate async operations with behavioral
synchronization, enabling patterns like:

- Operations with deadlines/timeouts
- Cancellable background work
- Operations that can be interrupted by user actions
- Multi-stage operations with pause/resume

## Usage

```typescript
import { system, sync, main } from "behavioral-threads"

await main(() =>
  system(function* (thread, sync) {
    // Worker thread that can be interrupted
    yield* thread("worker", function* () {
      while (true) {
        const result = yield sync({
          wait: (e) => e === "timeout", // Can be interrupted
          exec: function* () {
            // Async work
            yield* suspend(1000)
            return "completed"
          },
        })

        // Post result as new event
        yield sync({
          post: [result === "timeout" ? "timed-out" : "completed"],
        })
      }
    })

    // Timer thread that enforces deadlines
    yield* thread("timer", function* () {
      while (true) {
        yield sync({
          exec: function* () {
            yield* suspend(2000)
            return "timeout"
          },
        })
      }
    })
  })
)
```

## Key Features

- **Event-Based Coordination**: Threads coordinate through named events
- **Priority System**: Higher priority threads' requests take precedence
- **Structured Concurrency**: Built on Effection for reliable cleanup
- **Async Operations**: Can run async work that integrates with event system
- **Clean Cancellation**: Running operations are properly cleaned up when
  interrupted

## Common Patterns

### Timeouts/Deadlines

```typescript
yield sync({
  wait: (e) => e === "timeout",
  exec: function* () {
    yield* longRunningOperation()
    return "success"
  },
})
```

### Background Work

```typescript
yield sync({
  wait: (e) => e === "cancel",
  exec: function* () {
    while (true) {
      yield* doSomeWork()
      yield* suspend(1000)
    }
  },
})
```

### Multi-Stage Operations

```typescript
yield sync({
  wait: (e) => e === "pause",
  exec: function* () {
    yield* stage1()
    return "stage1-complete"
  }
})

if (/* not paused */) {
  yield sync({
    wait: (e) => e === "pause",
    exec: function* () {
      yield* stage2()
      return "all-complete"
    }
  })
}
```

## Design Philosophy

This library aims to maintain the simplicity and power of behavioral
programming while adding carefully designed support for async operations. Key
principles:

1. **Clean Integration**: Async operations feel like a natural extension of
   b-thread synchronization
2. **Predictable Timing**: Operations only run after sync conditions are met
3. **Reliable Cleanup**: Uses structured concurrency for robust resource
   management
4. **Simple Mental Model**: Async ops are just another way threads can
   generate events

## Prior Art

- [BP.js](https://bpjs.readthedocs.io/): Original JavaScript implementation of
  behavioral programming
- [Effection](https://frontside.com/effection/): Structured concurrency for
  JavaScript
- [Behavioral Programming](https://www.wisdom.weizmann.ac.il/~harel/papers/Behavioral%20Programming.pdf):
  Original paper by David Harel et al.
