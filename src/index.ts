import express from "express";
import http from "http";
import { Server as IoServer, Socket } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const SUPABASE_URL = "https://quzvazbyiokmoczuyqak.supabase.co";//process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1enZhemJ5aW9rbW9jenV5cWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUyMDAyOTEsImV4cCI6MjA3MDc3NjI5MX0.wZ3nG1j9z_88MVjNKxoGDUC41gMKBLLBSdIabgC1DaA";//process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PORT = Number(process.env.PORT || 4000);
const ORIGINS = "https://love-letter-game-green.vercel.app/";//process.env.ALLOWED_ORIGINS || "*";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Express + Socket.IO
const app = express();
app.use(cors({ origin: ORIGINS }));
const server = http.createServer(app);
const io = new IoServer(server, {
  cors: { origin: ORIGINS },
  path: "/socket.io"
});

// -- Helper types
type Card = { name: string; value: number };
type Player = {
  id: string; // socket id
  name: string;
  hand: Card[];
  tokens?: number;
  eliminated?: boolean;
  protected?: boolean;
};
type GameState = {
  id?: string; // db id
  code: string;
  players: Player[];
  deck: Card[];
  started?: boolean;
  currentPlayerIndex?: number;
  log: string[];
  chat: { sender: string; message: string; ts: number }[];
  burn?: Card | null;
};

// Utility: create a standard Love Letter deck
function createDeck(): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < 5; i++) cards.push({ name: "Guard", value: 1 });
  for (let i = 0; i < 2; i++) cards.push({ name: "Priest", value: 2 });
  for (let i = 0; i < 2; i++) cards.push({ name: "Baron", value: 3 });
  for (let i = 0; i < 2; i++) cards.push({ name: "Handmaid", value: 4 });
  for (let i = 0; i < 2; i++) cards.push({ name: "Prince", value: 5 });
  cards.push({ name: "King", value: 6 });
  cards.push({ name: "Countess", value: 7 });
  cards.push({ name: "Princess", value: 8 });
  return shuffle(cards);
}
function shuffle<T>(arr: T[]) {
  return arr.slice().sort(() => Math.random() - 0.5);
}

// Supabase helpers
async function upsertGameState(code: string, state: GameState) {
  // Upsert by code
  const { data, error } = await supabase
    .from("games")
    .upsert({ code, state }, { onConflict: "code" })
    .select()
    .limit(1);
  if (error) console.error("upsertGameState error", error);
  return data?.[0];
}

async function fetchGameByCode(code: string): Promise<{ id: string; state: GameState } | null> {
  const { data, error } = await supabase.from("games").select("*").eq("code", code).limit(1).maybeSingle();
  if (error) {
    console.error("fetchGameByCode error", error);
    return null;
  }
  if (!data) return null;
  return { id: data.id, state: data.state as GameState };
}

async function deleteGame(code: string) {
  await supabase.from("games").delete().eq("code", code);
}

// Create code helper
function makeCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Core game flow helpers (same rule logic as before)
function startRound(state: GameState) {
  state.deck = createDeck();
  state.burn = state.deck.pop() || null;
  state.players.forEach((p) => {
    p.hand = [state.deck.pop()!];
    p.eliminated = false;
    p.protected = false;
  });
  state.currentPlayerIndex = 0;
  state.log = [];
  // First player draws second card
  if (state.deck.length > 0) state.players[0].hand.push(state.deck.pop()!);
}

function determineWinnerByHands(players: Player[]) {
  const active = players.filter((p) => !p.eliminated && p.hand && p.hand.length > 0);
  if (active.length === 0) return null;
  active.sort((a, b) => b.hand[0].value - a.hand[0].value);
  return active[0];
}

function nextTurnServerSide(state: GameState) {
  const active = state.players.filter((p) => !p.eliminated);
  if (active.length <= 1) {
    const winner = active[0];
    if (winner) winner.tokens = (winner.tokens || 0) + 1;
    state.log.push(`${winner ? winner.name : "No one"} won the round (last player standing).`);
    startRound(state);
    return;
  }

  if ((state.deck || []).length === 0) {
    const winner = determineWinnerByHands(state.players);
    if (winner) {
      winner.tokens = (winner.tokens || 0) + 1;
      state.log.push(`${winner.name} won the round (highest card when deck empty).`);
    }
    startRound(state);
    return;
  }

  // advance to next non-eliminated player
  do {
    state.currentPlayerIndex = ((state.currentPlayerIndex || 0) + 1) % state.players.length;
  } while (state.players[state.currentPlayerIndex].eliminated);

  // expire protection
  if (state.players[state.currentPlayerIndex].protected) delete state.players[state.currentPlayerIndex].protected;

  // draw for current player
  const current = state.players[state.currentPlayerIndex];
  if (state.deck.length > 0) current.hand.push(state.deck.pop()!);
}

// Apply card effect (same semantics as earlier server)
function applyCardEffect(
  state: GameState,
  playerIndex: number,
  card: Card,
  targetSocketId: string | null,
  guessedCard: string | null,
  socket: Socket
) {
  const player = state.players[playerIndex];
  const targetIndex = targetSocketId ? state.players.findIndex((p) => p.id === targetSocketId) : -1;
  const target = targetIndex >= 0 ? state.players[targetIndex] : null;

  switch (card.name) {
    case "Guard":
      if (!target) {
        socket.emit("errorMsg", { message: "Guard requires a target." });
        return;
      }
      if (!guessedCard || guessedCard === "Guard") {
        socket.emit("errorMsg", { message: "Invalid guess for Guard." });
        return;
      }
      const actual = target.hand[0].name;
      if (actual === guessedCard) {
        target.eliminated = true;
        state.log.push(`${player.name} guessed ${guessedCard} correctly — ${target.name} is eliminated.`);
      } else {
        state.log.push(`${player.name} guessed ${guessedCard} — wrong.`);
      }
      break;

    case "Priest":
      if (!target) {
        socket.emit("errorMsg", { message: "Priest requires a target." });
        return;
      }
      io.to(player.id).emit("privateReveal", { targetId: target.id, card: target.hand[0] });
      state.log.push(`${player.name} used Priest on ${target.name}.`);
      break;

    case "Baron":
      if (!target) {
        socket.emit("errorMsg", { message: "Baron requires a target." });
        return;
      }
      {
        const myCard = player.hand[0];
        const theirCard = target.hand[0];
        if (myCard.value > theirCard.value) {
          target.eliminated = true;
          state.log.push(`${player.name} (${myCard.name}) beat ${target.name} (${theirCard.name}).`);
        } else if (myCard.value < theirCard.value) {
          player.eliminated = true;
          state.log.push(`${target.name} (${theirCard.name}) beat ${player.name} (${myCard.name}).`);
        } else {
          state.log.push(`${player.name} and ${target.name} tied with ${myCard.name}.`);
        }
      }
      break;

    case "Handmaid":
      player.protected = true;
      state.log.push(`${player.name} is protected until their next turn.`);
      break;

    case "Prince":
      if (!target) {
        socket.emit("errorMsg", { message: "Prince requires a target (can be yourself)." });
        return;
      }
      {
        const discarded = target.hand.pop()!;
        state.log.push(`${target.name} discarded ${discarded.name} due to Prince.`);
        if (discarded.name === "Princess") {
          target.eliminated = true;
          state.log.push(`${target.name} discarded the Princess and was eliminated.`);
        } else {
          if (state.deck.length > 0) target.hand = [state.deck.pop()!];
          else target.hand = [];
        }
      }
      break;

    case "King":
      if (!target) {
        socket.emit("errorMsg", { message: "King requires a target." });
        return;
      }
      {
        const tmp = player.hand[0];
        player.hand[0] = target.hand[0];
        target.hand[0] = tmp;
        state.log.push(`${player.name} swapped hands with ${target.name}.`);
      }
      break;

    case "Countess":
      state.log.push(`${player.name} discarded the Countess.`);
      break;

    case "Princess":
      player.eliminated = true;
      state.log.push(`${player.name} discarded the Princess and was eliminated.`);
      break;
  }
}

// Convert socket id to player's index helper
function findPlayerIndexBySocket(state: GameState, socketId: string) {
  return state.players.findIndex((p) => p.id === socketId);
}

// Socket.IO events
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // createGame -> create state and persist
  socket.on("createGame", async ({ playerName }: { playerName: string }, cb: (code?: string) => void) => {
    try {
      const code = makeCode();
      const state: GameState = {
        code,
        players: [{ id: socket.id, name: playerName, hand: [], tokens: 0, eliminated: false }],
        deck: [],
        started: false,
        currentPlayerIndex: 0,
        log: [],
        chat: [],
        burn: null
      };
      // persist
      await upsertGameState(code, state);
      // join socket room
      socket.join(code);
      // callback code to client
      cb && cb(code);
      // inform room participants
      io.to(code).emit("players", state.players);
      console.log("Game created", code, "by", playerName);
    } catch (err) {
      console.error("createGame error", err);
      cb && cb(undefined);
    }
  });

  // joinGame
  socket.on("joinGame", async ({ code, playerName }: { code: string; playerName: string }, cb: (ok?: boolean) => void) => {
    try {
      const gameRow = await fetchGameByCode(code);
      if (!gameRow) {
        cb && cb(false);
        return;
      }
      const state = gameRow.state;
      if (state.started) {
        cb && cb(false);
        return;
      }
      // add player if not present
      const found = state.players.find((p) => p.id === socket.id || p.name === playerName);
      if (!found) {
        state.players.push({ id: socket.id, name: playerName, hand: [], tokens: 0, eliminated: false });
      }
      // persist and join room
      await upsertGameState(code, state);
      socket.join(code);
      io.to(code).emit("players", state.players);
      cb && cb(true);
      console.log(`${playerName} joined ${code}`);
    } catch (err) {
      console.error("joinGame error", err);
      cb && cb(false);
    }
  });

  // sendChat
  socket.on("sendChat", async ({ code, message }: { code: string; message: string }) => {
    const g = await fetchGameByCode(code);
    if (!g) return;
    const state = g.state;
    const sender = state.players.find((p) => p.id === socket.id);
    if (!sender) return;
    const entry = { sender: sender.name, message, ts: Date.now() };
    state.chat.push(entry);
    await upsertGameState(code, state);
    io.to(code).emit("chat", entry);
  });

  // startGame
  socket.on("startGame", async (code: string) => {
    const g = await fetchGameByCode(code);
    if (!g) return;
    const state = g.state;
    if (state.started) return;
    state.started = true;
    startRound(state);
    await upsertGameState(code, state);
    io.to(code).emit("start", state);
    io.to(code).emit("update", state);
  });

  // playCard
  socket.on(
    "playCard",
    async ({
      code,
      cardIndex,
      targetId,
      guessedCard
    }: {
      code: string;
      cardIndex: number;
      targetId?: string | null;
      guessedCard?: string | null;
    }) => {
      const g = await fetchGameByCode(code);
      if (!g) {
        socket.emit("errorMsg", { message: "Game not found." });
        return;
      }
      const state = g.state;
      const playerIndex = findPlayerIndexBySocket(state, socket.id);
      if (playerIndex === -1) {
        socket.emit("errorMsg", { message: "Player not in game." });
        return;
      }
      if (playerIndex !== state.currentPlayerIndex) {
        socket.emit("errorMsg", { message: "Not your turn." });
        return;
      }
      const player = state.players[playerIndex];
      if (player.eliminated) {
        socket.emit("errorMsg", { message: "You are eliminated." });
        return;
      }
      if (cardIndex < 0 || cardIndex >= player.hand.length) {
        socket.emit("errorMsg", { message: "Invalid card index." });
        return;
      }

      // Countess enforcement
      const otherCard = player.hand.find((_, i) => i !== cardIndex);
      if (otherCard && otherCard.name === "Countess" && (player.hand[cardIndex].name === "King" || player.hand[cardIndex].name === "Prince")) {
        socket.emit("errorMsg", { message: "Rule: If you hold the Countess with King/Prince, you must discard the Countess." });
        return;
      }

      // Protection check
      if (targetId) {
        const target = state.players.find((p) => p.id === targetId);
        if (!target) {
          socket.emit("errorMsg", { message: "Target not found." });
          return;
        }
        if (target.protected) {
          socket.emit("errorMsg", { message: `${target.name} is protected by Handmaid.` });
          return;
        }
      }

      // Play the card
      const played = player.hand.splice(cardIndex, 1)[0];
      state.log.push(`${player.name} played ${played.name}.`);

      // Apply effect
      applyCardEffect(state, playerIndex, played, targetId || null, guessedCard || null, socket);

      // Advance turn and persist
      nextTurnServerSide(state);
      await upsertGameState(code, state);
      io.to(code).emit("update", state);
    }
  );

  // disconnect: we won't remove the player from DB; the state in Supabase remains
  socket.on("disconnect", () => {
    console.log("socket disconnected", socket.id);
    // Optionally: mark player offline in db players table (not implemented here)
  });
});

// Basic health endpoint
app.get("/", (_req, res) => res.send("Love Letter Socket server is running."));

server.listen(PORT, () => {
  console.log("Socket server listening on port", PORT);
});
