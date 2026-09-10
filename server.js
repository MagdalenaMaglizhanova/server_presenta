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
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
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
    version: "1.3.0"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "presenta-live-server" });
});

// ---------------------------------------------------------
// LIVE SESSIONS
// ---------------------------------------------------------
/*
  sessions = {
    "ABC123": {
      presentationId: "presentation-1",
      currentSlide: 0,
      slides: [...],
      title: "...",
      teacherSocket: ws,
      clients: Set(),
      students: Map<ws, { name, joinedAt }>   // ← НОВО
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
    return res.status(400).json({ error: "presentationId is required" });
  }

  const sessionId = generateSessionId();

  sessions.set(sessionId, {
    presentationId,
    currentSlide: 0,
    slides: null,
    title: null,
    teacherSocket: null,
    clients: new Set(),
    students: new Map()   // 🔥 НОВО
  });

  console.log(`[SESSION] Created ${sessionId} for ${presentationId}`);

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
      connectedClients: session.clients.size,
      studentCount: session.students.size,   // 🔥 НОВО
      students: Array.from(session.students.values()).map(s => s.name), // 🔥 НОВО
      hasSlides: !!session.slides
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
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    sessionId: req.params.sessionId,
    presentationId: session.presentationId,
    currentSlide: session.currentSlide,
    connectedClients: session.clients.size,
    studentCount: session.students.size,       // 🔥 НОВО
    students: Array.from(session.students.values()), // 🔥 НОВО
    hasSlides: !!session.slides
  });
});

// ---------------------------------------------------------
// CHANGE SLIDE (REST)
// ---------------------------------------------------------

app.post("/api/sessions/:sessionId/slide", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const slide = Number(req.body.slide);

  if (!Number.isInteger(slide) || slide < 0) {
    return res.status(400).json({ error: "Invalid slide" });
  }

  session.currentSlide = slide;

  broadcast(session, {
    type: "SLIDE_CHANGED",
    slide
  });

  console.log(`[SLIDE] ${req.params.sessionId} → ${slide}`);

  res.json({ ok: true, slide });
});

// ---------------------------------------------------------
// DELETE / END SESSION
// ---------------------------------------------------------

app.delete("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  broadcast(session, { type: "SESSION_ENDED" });

  for (const client of session.clients) {
    try {
      client.close(1000, "Session ended");
    } catch (error) {
      console.error("[WS] Error closing client:", error.message);
    }
  }

  sessions.delete(req.params.sessionId);

  console.log(`[SESSION] Ended ${req.params.sessionId}`);

  res.json({ ok: true, sessionId: req.params.sessionId });
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
  // SEND CURRENT SESSION STATE (със слайдове, ако има)
  // -------------------------------------------------------

  send(socket, {
    type: "SESSION_STATE",
    presentationId: session.presentationId,
    slide: session.currentSlide,
    connectedClients: session.clients.size,
    studentCount: session.students.size,   // 🔥 НОВО
    students: Array.from(session.students.values()), // 🔥 НОВО
    slides: session.slides || undefined,
    title: session.title || undefined
  });

  // 🔥 Изпращаме списъка с ученици на новия клиент (ако има такива)
  if (session.students.size > 0) {
    send(socket, {
      type: "STUDENT_LIST",
      students: Array.from(session.students.values()),
      count: session.students.size
    });
  }

  // Ако има слайдове, веднага пращаме и PRESENTATION_DATA
  if (session.slides) {
    console.log(`📤 Изпращаме ${session.slides.length} слайда на нов клиент`);
    send(socket, {
      type: "PRESENTATION_DATA",
      slides: session.slides,
      title: session.title,
      slide: session.currentSlide
    });
  }

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
      handleMessage(session, socket, message);
    } catch (error) {
      console.error("[WS] Invalid message:", error.message);
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
    session.students.delete(socket);   // 🔥 НОВО: махаме и ученика

    // Ако учителят е излязъл – изчистваме teacherSocket
    if (session.teacherSocket === socket) {
      session.teacherSocket = null;
    }

    console.log(
      `[WS] Client disconnected → ${sessionId} | clients: ${session.clients.size} | students: ${session.students.size}`
    );

    broadcast(session, {
      type: "STUDENT_COUNT",
      count: session.clients.size
    });

    // 🔥 Изпращаме обновения списък с ученици
    broadcast(session, {
      type: "STUDENT_LIST",
      students: Array.from(session.students.values()),
      count: session.students.size
    });
  });

  // -------------------------------------------------------
  // ERROR
  // -------------------------------------------------------

  socket.on("error", (error) => {
    console.error(`[WS] Client error → ${sessionId}:`, error.message);
    session.clients.delete(socket);
    session.students.delete(socket);   // 🔥 НОВО
  });
});

// ---------------------------------------------------------
// HANDLE WEBSOCKET MESSAGES
// ---------------------------------------------------------

function handleMessage(session, socket, message) {
  if (!message || !message.type) return;

  switch (message.type) {

    // -----------------------------------------------------
    // TEACHER CHANGES SLIDE
    // -----------------------------------------------------

    case "SLIDE_CHANGED": {
      const slide = Number(message.slide);

      if (!Number.isInteger(slide) || slide < 0) {
        send(socket, { type: "ERROR", message: "Invalid slide" });
        return;
      }

      session.currentSlide = slide;

      if (message.slides && Array.isArray(message.slides)) {
        session.slides = message.slides;
        session.title = message.title || session.title;
        session.teacherSocket = socket;
      }

      broadcast(session, {
        type: "SLIDE_CHANGED",
        slide,
        slides: message.slides || undefined,
        title: message.title || undefined
      });

      console.log(`[WS SLIDE] → ${slide}`);
      break;
    }

    // -----------------------------------------------------
    // TEACHER SENDS PRESENTATION DATA
    // -----------------------------------------------------

    case "PRESENTATION_DATA": {
      if (!message.slides || !Array.isArray(message.slides)) {
        return;
      }

      session.slides = message.slides;
      session.title = message.title || null;
      session.teacherSocket = socket;

      console.log(
        `[WS] Учител изпрати ${message.slides.length} слайда за сесия`
      );

      broadcast(session, {
        type: "PRESENTATION_DATA",
        slides: message.slides,
        title: message.title,
        slide: session.currentSlide
      });

      break;
    }

    // -----------------------------------------------------
    // STUDENT REQUESTS PRESENTATION
    // -----------------------------------------------------

    case "REQUEST_PRESENTATION": {
      console.log(
        `[WS] Получена заявка за презентация от клиент в сесия`
      );

      if (session.slides) {
        send(socket, {
          type: "PRESENTATION_DATA",
          slides: session.slides,
          title: session.title,
          slide: session.currentSlide
        });
        console.log(`📤 Изпратени ${session.slides.length} слайда на клиент`);
      } else {
        if (session.teacherSocket && session.teacherSocket.readyState === 1) {
          send(session.teacherSocket, {
            type: "REQUEST_PRESENTATION"
          });
          console.log(`📤 Препредадена заявка към учителя`);
        } else {
          console.log(`⚠️ Няма учител в сесията и няма слайдове`);
        }
      }

      break;
    }

    // -----------------------------------------------------
    // STUDENT REACTION
    // -----------------------------------------------------

    case "REACTION": {
      if (!message.reaction) return;

      broadcast(session, {
        type: "REACTION",
        reaction: message.reaction,
        name: message.name || null   // 🔥 НОВО: име на ученика
      });

      console.log(`[REACTION] ${message.name || "?"}: ${message.reaction}`);
      break;
    }

    // -----------------------------------------------------
    // 🔥 STUDENT JOINED (с име)
    // -----------------------------------------------------

    case "STUDENT_JOINED": {
      // Записваме ученика с име в Map-а
      if (message.name && typeof message.name === "string") {
        session.students.set(socket, {
          name: message.name.trim(),
          joinedAt: message.joinedAt || Date.now()
        });

        console.log(
          `👤 Ученик влезе: ${message.name} | Общо ученици: ${session.students.size}`
        );
      }

      // Broadcast-ваме обновения списък на всички
      broadcast(session, {
        type: "STUDENT_LIST",
        students: Array.from(session.students.values()),
        count: session.students.size
      });

      // Също обновяваме и броя клиенти
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
      if (!message.questionId) return;

      broadcast(session, {
        type: "POLL_ANSWER",
        questionId: message.questionId,
        answer: message.answer,
        name: message.name || null   // 🔥 НОВО
      });
      break;
    }

    // -----------------------------------------------------
    // PING
    // -----------------------------------------------------

    case "PING": {
      send(socket, { type: "PONG" });
      break;
    }

    // -----------------------------------------------------
    // DEFAULT
    // -----------------------------------------------------

    default:
      console.log(`[WS] Unknown message type: ${message.type}`);
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
        console.error("[WS] Broadcast error:", error.message);
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
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.error("[WS] Send error:", error.message);
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
  console.log(" PRESENTA LIVE SERVER v1.3.0");
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
