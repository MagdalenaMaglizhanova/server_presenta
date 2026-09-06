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

const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:5173";

app.use(
  cors({
    origin: FRONTEND_URL
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
    version: "1.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
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
    `[WS] Client connected → ${sessionId}`
  );

  // Immediately send current state
  send(socket, {
    type: "SESSION_STATE",
    presentationId: session.presentationId,
    slide: session.currentSlide
  });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      handleMessage(session, socket, message);

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

  socket.on("close", () => {
    session.clients.delete(socket);

    console.log(
      `[WS] Client disconnected → ${sessionId}`
    );
  });

  socket.on("error", () => {
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

    // -----------------------------------------------
    // TEACHER CHANGES SLIDE
    // -----------------------------------------------

    case "SLIDE_CHANGED": {

      const slide = Number(message.slide);

      if (!Number.isInteger(slide) || slide < 0) {
        return;
      }

      session.currentSlide = slide;

      broadcast(session, {
        type: "SLIDE_CHANGED",
        slide
      });

      break;
    }

    // -----------------------------------------------
    // STUDENT REACTION
    // -----------------------------------------------

    case "REACTION": {

      if (!message.reaction) {
        return;
      }

      broadcast(session, {
        type: "REACTION",
        reaction: message.reaction
      });

      break;
    }

    // -----------------------------------------------
    // STUDENT JOINED
    // -----------------------------------------------

    case "STUDENT_JOINED": {

      broadcast(session, {
        type: "STUDENT_COUNT",
        count: session.clients.size
      });

      break;
    }

    // -----------------------------------------------
    // POLL ANSWER
    // -----------------------------------------------

    case "POLL_ANSWER": {

      broadcast(session, {
        type: "POLL_ANSWER",
        questionId: message.questionId,
        answer: message.answer
      });

      break;
    }

    // -----------------------------------------------
    // PING
    // -----------------------------------------------

    case "PING": {

      send(socket, {
        type: "PONG"
      });

      break;
    }

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

      client.send(data);
    }
  }
}

// ---------------------------------------------------------
// SEND
// ---------------------------------------------------------

function send(socket, message) {

  if (socket.readyState === 1) {

    socket.send(
      JSON.stringify(message)
    );
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
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log("");
  console.log("HTTP:");
  console.log(`http://localhost:${PORT}`);
  console.log("");
  console.log("WebSocket:");
  console.log(`ws://localhost:${PORT}/ws`);
  console.log("======================================");
});
