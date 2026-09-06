const express = require("express");
const http = require("http");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  process.env.FRONTEND_URL
].filter(Boolean);

console.log("[CONFIG] Allowed origins:");
allowedOrigins.forEach((origin) => {
  console.log(`  - ${origin}`);
});

// ---------------------------------------------------------
// CORS
// ---------------------------------------------------------

app.use(
  cors({
    origin: (origin, callback) => {
      // Разрешаваме заявки без Origin
      // (например Postman, curl, health checks)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);

      return callback(
        new Error(`CORS blocked for origin: ${origin}`)
      );
    },

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

app.use(express.json());

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    name: "Presenta Live Server",
    status: "online",
    version: "1.1.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "presenta-live-server"
  });
});

// ---------------------------------------------------------
// LIVE SESSIONS
// ---------------------------------------------------------

/*
  sessions = {
    "ABC123": {
      presentationId: "presentation-1",
      currentSlide: 0,
      clients: Set()
    }
  }
*/

const sessions = new Map();

// ---------------------------------------------------------
// CREATE SESSION
// ---------------------------------------------------------

app.post("/api/sessions", (req, res) => {
  const { presentationId } = req.body;

  if (!presentationId) {
    return res.status(400).json({
      error: "presentationId is required"
    });
  }

  const sessionId = generateSessionId();

  sessions.set(sessionId, {
    presentationId,
    currentSlide: 0,
    clients: new Set()
  });

  console.log(
    `[SESSION] Created ${sessionId} for ${presentationId}`
  );

  res.json({
    sessionId,
    presentationId,
    currentSlide: 0
  });
});

// ---------------------------------------------------------
// LIST ACTIVE SESSIONS
// ---------------------------------------------------------

app.get("/api/sessions", (req, res) => {
  const activeSessions = [];

  for (const [sessionId, session] of sessions.entries()) {
    activeSessions.push({
      sessionId,
      presentationId: session.presentationId,
      currentSlide: session.currentSlide,
      connectedClients: session.clients.size
    });
  }

  res.json({
    count: activeSessions.length,
    sessions: activeSessions
  });
});

// ---------------------------------------------------------
// GET SESSION STATE
// ---------------------------------------------------------

app.get("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      error: "Session not found"
    });
  }

  res.json({
    sessionId: req.params.sessionId,
    presentationId: session.presentationId,
    currentSlide: session.currentSlide,
    connectedClients: session.clients.size
  });
});

// ---------------------------------------------------------
// CHANGE SLIDE
// ---------------------------------------------------------

app.post("/api/sessions/:sessionId/slide", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      error: "Session not found"
    });
  }

  const slide = Number(req.body.slide);

  if (!Number.isInteger(slide) || slide < 0) {
    return res.status(400).json({
      error: "Invalid slide"
    });
  }

  session.currentSlide = slide;

  broadcast(session, {
    type: "SLIDE_CHANGED",
    slide
  });

  console.log(
    `[SLIDE] ${req.params.sessionId} → ${slide}`
  );

  res.json({
    ok: true,
    slide
  });
});

// ---------------------------------------------------------
// DELETE / END SESSION
// ---------------------------------------------------------

app.delete("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      error: "Session not found"
    });
  }

  broadcast(session, {
    type: "SESSION_ENDED"
  });

  for (const client of session.clients) {
    try {
      client.close(1000, "Session ended");
    } catch (error) {
      console.error("[WS] Error closing client:", error.message);
    }
  }

  sessions.delete(req.params.sessionId);

  console.log(
    `[SESSION] Ended ${req.params.sessionId}`
  );

  res.json({
    ok: true,
    sessionId: req.params.sessionId
  });
});

// ---------------------------------------------------------
// WEBSOCKET
// ---------------------------------------------------------

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

wss.on("connection", (socket, request) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    socket.close(1008, "Session required");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    socket.close(1008, "Session not found");
    return;
  }

  session.clients.add(socket);

  console.log(
    `[WS] Client connected → ${sessionId} | clients: ${session.clients.size}`
  );

  // -------------------------------------------------------
  // SEND CURRENT SESSION STATE
  // -------------------------------------------------------

  send(socket, {
    type: "SESSION_STATE",
    presentationId: session.presentationId,
    slide: session.currentSlide,
    connectedClients: session.clients.size
  });

  // Notify everyone about updated client count
  broadcast(session, {
    type: "STUDENT_COUNT",
    count: session.clients.size
  });

  // -------------------------------------------------------
  // MESSAGE
  // -------------------------------------------------------

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      handleMessage(
        session,
        socket,
        message
      );

    } catch (error) {
      console.error(
        "[WS] Invalid message:",
        error.message
      );

      send(socket, {
        type: "ERROR",
        message: "Invalid message"
      });
    }
  });

  // -------------------------------------------------------
  // CLOSE
  // -------------------------------------------------------

  socket.on("close", () => {
    session.clients.delete(socket);

    console.log(
      `[WS] Client disconnected → ${sessionId} | clients: ${session.clients.size}`
    );

    broadcast(session, {
      type: "STUDENT_COUNT",
      count: session.clients.size
    });
  });

  // -------------------------------------------------------
  // ERROR
  // -------------------------------------------------------

  socket.on("error", (error) => {
    console.error(
      `[WS] Client error → ${sessionId}:`,
      error.message
    );

    session.clients.delete(socket);
  });
});

// ---------------------------------------------------------
// HANDLE WEBSOCKET MESSAGES
// ---------------------------------------------------------

function handleMessage(session, socket, message) {

  if (!message || !message.type) {
    return;
  }

  switch (message.type) {

    // -----------------------------------------------------
    // TEACHER CHANGES SLIDE
    // -----------------------------------------------------

    case "SLIDE_CHANGED": {

      const slide = Number(message.slide);

      if (!Number.isInteger(slide) || slide < 0) {
        send(socket, {
          type: "ERROR",
          message: "Invalid slide"
        });

        return;
      }

      session.currentSlide = slide;

      broadcast(session, {
        type: "SLIDE_CHANGED",
        slide
      });

      console.log(
        `[WS SLIDE] → ${slide}`
      );

      break;
    }

    // -----------------------------------------------------
    // STUDENT REACTION
    // -----------------------------------------------------

    case "REACTION": {

      if (!message.reaction) {
        return;
      }

      broadcast(session, {
        type: "REACTION",
        reaction: message.reaction
      });

      console.log(
        `[REACTION] ${message.reaction}`
      );

      break;
    }

    // -----------------------------------------------------
    // STUDENT JOINED
    // -----------------------------------------------------

    case "STUDENT_JOINED": {

      broadcast(session, {
        type: "STUDENT_COUNT",
        count: session.clients.size
      });

      break;
    }

    // -----------------------------------------------------
    // POLL ANSWER
    // -----------------------------------------------------

    case "POLL_ANSWER": {

      if (!message.questionId) {
        return;
      }

      broadcast(session, {
        type: "POLL_ANSWER",
        questionId: message.questionId,
        answer: message.answer
      });

      break;
    }

    // -----------------------------------------------------
    // PING
    // -----------------------------------------------------

    case "PING": {

      send(socket, {
        type: "PONG"
      });

      break;
    }

    // -----------------------------------------------------
    // DEFAULT
    // -----------------------------------------------------

    default:

      console.log(
        `[WS] Unknown message type: ${message.type}`
      );
  }
}

// ---------------------------------------------------------
// BROADCAST
// ---------------------------------------------------------

function broadcast(session, message) {

  const data = JSON.stringify(message);

  for (const client of session.clients) {

    if (client.readyState === 1) {

      try {
        client.send(data);
      } catch (error) {
        console.error(
          "[WS] Broadcast error:",
          error.message
        );
      }
    }
  }
}

// ---------------------------------------------------------
// SEND
// ---------------------------------------------------------

function send(socket, message) {

  if (socket.readyState === 1) {

    try {
      socket.send(
        JSON.stringify(message)
      );
    } catch (error) {
      console.error(
        "[WS] Send error:",
        error.message
      );
    }
  }
}

// ---------------------------------------------------------
// SESSION ID
// ---------------------------------------------------------

function generateSessionId() {

  return Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase();
}

// ---------------------------------------------------------
// START
// ---------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {

  console.log("");
  console.log("======================================");
  console.log(" PRESENTA LIVE SERVER");
  console.log("======================================");
  console.log(`Port: ${PORT}`);

  console.log("");
  console.log("Allowed origins:");

  allowedOrigins.forEach((origin) => {
    console.log(`  ✓ ${origin}`);
  });

  console.log("");
  console.log("HTTP:");
  console.log(`http://localhost:${PORT}`);

  console.log("");
  console.log("WebSocket:");
  console.log(`ws://localhost:${PORT}/ws`);

  console.log("======================================");
});
