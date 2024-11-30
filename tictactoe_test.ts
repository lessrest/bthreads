import { behavioralThreadSystem } from "./bthreads.ts"
import { createTicTacToeGame, GameEvent } from "./tictactoe.ts"
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import { run } from "effection"
import { Sync } from "./bthreads.ts"

const TEST_OPTIONS = {
  timeout: 1000,
}

Deno.test({
  name: "basic tic tac toe gameplay",
  ...TEST_OPTIONS,
  fn: async () => {
    const events: GameEvent[] = []

    await run(() =>
      behavioralThreadSystem<GameEvent>(function* (thread, sync) {
        yield* createTicTacToeGame(thread, sync)

        // Simulate a game where X wins
        yield* thread("TestDriver", function* (): Generator<
          Sync<GameEvent>,
          void,
          GameEvent
        > {
          // X plays center
          yield sync({
            post: [{ type: "CLICK", position: { row: 1, col: 1 } }],
          })

          // O should play a corner
          const move1 = yield sync({
            wait: (e: GameEvent) => e.type === "MOVE" && e.move.type === "O",
          })
          events.push(move1)

          // X plays top-middle
          yield sync({
            post: [{ type: "CLICK", position: { row: 0, col: 1 } }],
          })

          // Wait for O's move
          const move2 = yield sync({
            wait: (e: GameEvent) => e.type === "MOVE" && e.move.type === "O",
          })
          events.push(move2)

          // X plays bottom-middle to win
          yield sync({
            post: [{ type: "CLICK", position: { row: 2, col: 1 } }],
          })

          // Wait for win detection
          const result = yield sync({
            wait: (e: GameEvent) => e.type === "X_WIN",
          })
          events.push(result)
        })
      })
    )

    // Verify game progression
    assertEquals(events.length, 3)
    assertEquals(events[2], { type: "X_WIN" })
  },
})
