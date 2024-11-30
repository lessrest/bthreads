import { Sync } from "./bthreads.ts"

// Types for our game events
export type Position = { row: number; col: number }
export type Move = { type: "X" | "O"; position: Position }
export type GameEvent =
  | { type: "MOVE"; move: Move }
  | { type: "X_WIN" }
  | { type: "O_WIN" }
  | { type: "DRAW" }
  | { type: "CLICK"; position: Position }

// Helper to create move events
const X = (row: number, col: number): GameEvent => ({
  type: "MOVE",
  move: { type: "X", position: { row, col } },
})

const O = (row: number, col: number): GameEvent => ({
  type: "MOVE",
  move: { type: "O", position: { row, col } },
})

// Game state tracking
class GameState {
  private board: Array<Array<"X" | "O" | null>> = [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ]

  makeMove(move: Move) {
    if (this.isValidMove(move.position)) {
      this.board[move.position.row][move.position.col] = move.type
      return true
    }
    return false
  }

  isValidMove(pos: Position): boolean {
    return this.board[pos.row][pos.col] === null
  }

  checkWin(player: "X" | "O"): boolean {
    // Check rows
    for (let row = 0; row < 3; row++) {
      if (this.board[row].every((cell) => cell === player)) return true
    }

    // Check columns
    for (let col = 0; col < 3; col++) {
      if (this.board.every((row) => row[col] === player)) return true
    }

    // Check diagonals
    if (
      this.board[0][0] === player &&
      this.board[1][1] === player &&
      this.board[2][2] === player
    )
      return true

    if (
      this.board[0][2] === player &&
      this.board[1][1] === player &&
      this.board[2][0] === player
    )
      return true

    return false
  }

  isFull(): boolean {
    return this.board.every((row) => row.every((cell) => cell !== null))
  }
}

export function* createTicTacToeGame(thread: any, sync: any) {
  const gameState = new GameState()

  // Enforce turns
  yield* thread("EnforceTurns", function* (): Generator<
    Sync<GameEvent>,
    void,
    GameEvent
  > {
    while (true) {
      // Wait for X's move
      yield sync({
        wait: (e: GameEvent) => e.type === "MOVE" && e.move.type === "X",
        halt: (e: GameEvent) => e.type === "MOVE" && e.move.type === "O",
      })

      // Wait for O's move
      yield sync({
        wait: (e: GameEvent) => e.type === "MOVE" && e.move.type === "O",
        halt: (e: GameEvent) => e.type === "MOVE" && e.move.type === "X",
      })
    }
  })

  // Handle square taken logic
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      yield* thread(`SquareTaken(${row},${col})`, function* (): Generator<
        Sync<GameEvent>,
        void,
        GameEvent
      > {
        while (true) {
          // Wait for any move on this square
          yield sync({
            wait: (e: GameEvent) =>
              e.type === "MOVE" &&
              e.move.position.row === row &&
              e.move.position.col === col,
          })

          // Block all future moves on this square
          yield sync({
            halt: (e: GameEvent) =>
              e.type === "MOVE" &&
              e.move.position.row === row &&
              e.move.position.col === col,
          })
        }
      })
    }
  }

  // Detect wins
  yield* thread("DetectWins", function* (): Generator<
    Sync<GameEvent>,
    void,
    GameEvent
  > {
    while (true) {
      const event = yield sync({
        wait: (e: GameEvent) => e.type === "MOVE",
      })

      if (event.type === "MOVE") {
        if (gameState.makeMove(event.move)) {
          if (gameState.checkWin("X")) {
            yield sync({ post: [{ type: "X_WIN" }] })
            return
          }
          if (gameState.checkWin("O")) {
            yield sync({ post: [{ type: "O_WIN" }] })
            return
          }
          if (gameState.isFull()) {
            yield sync({ post: [{ type: "DRAW" }] })
            return
          }
        }
      }
    }
  })

  // Handle user clicks for X moves
  yield* thread("HandleClicks", function* (): Generator<
    Sync<GameEvent>,
    void,
    GameEvent
  > {
    while (true) {
      const event = yield sync({
        wait: (e: GameEvent) => e.type === "CLICK",
      })

      if (event.type === "CLICK") {
        yield sync({
          post: [X(event.position.row, event.position.col)],
        })
      }
    }
  })

  // Wait for win and block further moves
  yield* thread("WaitForWin", function* (): Generator<
    Sync<GameEvent>,
    void,
    GameEvent
  > {
    yield sync({
      wait: (e: GameEvent) => e.type === "X_WIN" || e.type === "O_WIN",
    })

    yield sync({
      halt: (e: GameEvent) => e.type === "MOVE",
    })
  })

  // Simple AI for O moves
  yield* thread("SimpleAI", function* (): Generator<
    Sync<GameEvent>,
    void,
    GameEvent
  > {
    while (true) {
      // Wait for X's move
      yield sync({
        wait: (e: GameEvent) => e.type === "MOVE" && e.move.type === "X",
      })

      yield sync({
        post: [
          // Try center first
          O(1, 1),
          // Try corners
          O(0, 0),
          O(0, 2),
          O(2, 0),
          O(2, 2),
          // Try sides
          O(0, 1),
          O(1, 0),
          O(1, 2),
          O(2, 1),
        ],
      })
    }
  })
}
