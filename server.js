const express = require("express");
const http = require("http");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("[SUPABASE] ✅ Клиентът е конфигуриран");
  } catch (err) {
    console.error("[SUPABASE] ❌ Грешка при createClient:", err.message);
    supabase = null;
  }
} else {
  console.warn("[SUPABASE] ⚠️ Липсват credentials – DB функциите са изключени");
}

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://presenta-rose.vercel.app",
  "https://presenta-rose.vercel.app/",
  "https://magcommunity.vercel.app",
  "https://magcommunity.vercel.app/",
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
    version: "2.5.0",
    supabase: !!supabase
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "presenta-live-server",
    version: "2.5.0",
    supabase: !!supabase
  });
});

// ═════════════════════════════════════════════════════════
// 💾 PRESENTATIONS CRUD
// ═════════════════════════════════════════════════════════

// ---------------------------------------------------------
// SAVE / CREATE PRESENTATION
// ---------------------------------------------------------

app.post("/api/presentations", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  const { title, slides, courseId } = req.body;

  if (!title || !Array.isArray(slides)) {
    return res.status(400).json({ error: "title and slides are required" });
  }

  try {
    const { data, error } = await supabase
      .from("presentations")
      .insert({
        title,
        slides,
        course_id: courseId || null,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`💾 Запазена презентация: ${data.id} | ${title} | course: ${courseId || "—"}`);
    res.json(data);
  } catch (err) {
    console.error("[DB] Save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// LIST ALL PRESENTATIONS
// ---------------------------------------------------------

app.get("/api/presentations", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  try {
    const { data, error } = await supabase
      .from("presentations")
      .select("id, title, course_id, created_at, updated_at")
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const presentations = (data || []).map((p) => ({
      id: p.id,
      title: p.title,
      courseId: p.course_id || null,
      created_at: p.created_at,
      updated_at: p.updated_at,
    }));

    res.json({ presentations });
  } catch (err) {
    console.error("[DB] List error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// GET ONE PRESENTATION (with slides)
// ---------------------------------------------------------

app.get("/api/presentations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  try {
    const { data, error } = await supabase
      .from("presentations")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) throw error;

    res.json({
      id: data.id,
      title: data.title,
      slides: data.slides,
      courseId: data.course_id || null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (err) {
    console.error("[DB] Get error:", err.message);
    res.status(404).json({ error: "Presentation not found" });
  }
});

// ---------------------------------------------------------
// UPDATE PRESENTATION
// ---------------------------------------------------------

app.put("/api/presentations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  const { title, slides, courseId } = req.body;

  try {
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (slides !== undefined) updates.slides = slides;
    if (courseId !== undefined) updates.course_id = courseId || null;

    const { data, error } = await supabase
      .from("presentations")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💾 Обновена презентация: ${data.id} | ${data.title} | course: ${data.course_id || "—"}`);
    res.json({
      id: data.id,
      title: data.title,
      slides: data.slides,
      courseId: data.course_id || null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (err) {
    console.error("[DB] Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// DELETE PRESENTATION
// ---------------------------------------------------------

app.delete("/api/presentations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  try {
    const { error } = await supabase
      .from("presentations")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    console.log(`🗑️ Изтрита презентация: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DB] Delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════
// 🎬 LIVE SESSIONS
// ═════════════════════════════════════════════════════════

const sessions = new Map();

// ---------------------------------------------------------
// CREATE SESSION (start presentation)
// ---------------------------------------------------------

app.post("/api/sessions", async (req, res) => {
  const { presentationId, presentationTitle, totalSlides } = req.body;

  if (!presentationId) {
    return res.status(400).json({ error: "presentationId is required" });
  }

  const sessionId = generateSessionId();
  const startTime = new Date().toISOString();

  let dbSessionId = null;
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("sessions")
        .insert({
          session_code: sessionId,
          presentation_id: presentationId,
          presentation_title: presentationTitle || null,
          total_slides: totalSlides || 0
        })
        .select()
        .single();

      if (!error && data) {
        dbSessionId = data.id;
        console.log(`💾 Записана сесия в DB: ${dbSessionId}`);
      } else if (error) {
        console.warn("[DB] Session save error:", error.message);
      }
    } catch (err) {
      console.warn("[DB] Session save skipped:", err.message);
    }
  }

  sessions.set(sessionId, {
    presentationId,
    presentationTitle: presentationTitle || null,
    dbSessionId,
    currentSlide: 0,
    slides: null,
    title: null,
    teacherSocket: null,
    clients: new Set(),
    students: new Map(),
    studentAttention: new Map(), // ⭐ NEW: name → { isFocused, avatar, timestamp }
    startedAt: startTime
  });

  console.log(`[SESSION] Created ${sessionId} for ${presentationId}`);

  res.json({
    sessionId,
    presentationId,
    currentSlide: 0,
    dbSessionId
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
      studentCount: session.students.size,
      students: Array.from(session.students.values()),
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
    studentCount: session.students.size,
    students: Array.from(session.students.values()),
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

app.delete("/api/sessions/:sessionId", async (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  if (supabase && session.dbSessionId) {
    try {
      await supabase
        .from("sessions")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", session.dbSessionId);
      console.log(`💾 Записан край на сесия ${session.dbSessionId}`);
    } catch (err) {
      console.warn("[DB] End session error:", err.message);
    }
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
  const url = new URL(request.url, `http://${request.headers.host}`);
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

  console.log(`[WS] Client connected → ${sessionId} | clients: ${session.clients.size}`);

  send(socket, {
    type: "SESSION_STATE",
    presentationId: session.presentationId,
    slide: session.currentSlide,
    connectedClients: session.clients.size,
    studentCount: session.students.size,
    students: Array.from(session.students.values()),
    slides: session.slides || undefined,
    title: session.title || undefined
  });

  if (session.students.size > 0) {
    send(socket, {
      type: "STUDENT_LIST",
      students: Array.from(session.students.values()),
      count: session.students.size
    });
  }

  // ⭐ Изпращаме текущия attention snapshot на новия клиент
  if (session.studentAttention && session.studentAttention.size > 0) {
    send(socket, {
      type: "STUDENT_ATTENTION_LIST",
      attention: getAttentionList(session)
    });
  }

  if (session.slides) {
    console.log(`📤 Изпращаме ${session.slides.length} слайда на нов клиент`);
    send(socket, {
      type: "PRESENTATION_DATA",
      slides: session.slides,
      title: session.title,
      slide: session.currentSlide
    });
  }

  broadcast(session, {
    type: "STUDENT_COUNT",
    count: session.clients.size
  });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      handleMessage(session, socket, message);
    } catch (error) {
      console.error("[WS] Invalid message:", error.message);
      send(socket, { type: "ERROR", message: "Invalid message" });
    }
  });

  socket.on("close", () => {
    // ⭐ Намери името на ученика преди да го изтрием
    const studentData = session.students.get(socket);

    session.clients.delete(socket);
    session.students.delete(socket);

    if (session.teacherSocket === socket) {
      session.teacherSocket = null;
    }

    // ⭐ Изчисти attention status-а и уведоми учителя
    if (studentData && session.studentAttention) {
      const wasTracked = session.studentAttention.has(studentData.name);
      session.studentAttention.delete(studentData.name);

      if (wasTracked && session.teacherSocket && session.teacherSocket.readyState === 1) {
        send(session.teacherSocket, {
          type: "STUDENT_ATTENTION",
          name: studentData.name,
          avatar: studentData.avatar,
          isFocused: false,
          disconnected: true, // ⭐ флаг за да знае клиента че е disconnect
          timestamp: Date.now()
        });
      }
    }

    console.log(`[WS] Client disconnected → ${sessionId} | clients: ${session.clients.size} | students: ${session.students.size}`);

    broadcast(session, {
      type: "STUDENT_COUNT",
      count: session.clients.size
    });

    broadcast(session, {
      type: "STUDENT_LIST",
      students: Array.from(session.students.values()),
      count: session.students.size
    });
  });

  socket.on("error", (error) => {
    console.error(`[WS] Client error → ${sessionId}:`, error.message);
    session.clients.delete(socket);
    session.students.delete(socket);
  });
});

// ---------------------------------------------------------
// HANDLE WEBSOCKET MESSAGES
// ---------------------------------------------------------

function handleMessage(session, socket, message) {
  if (!message || !message.type) return;

  switch (message.type) {

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

    case "PRESENTATION_DATA": {
      if (!message.slides || !Array.isArray(message.slides)) return;

      session.slides = message.slides;
      session.title = message.title || null;
      session.teacherSocket = socket;

      console.log(`[WS] Учител изпрати ${message.slides.length} слайда за сесия`);

      broadcast(session, {
        type: "PRESENTATION_DATA",
        slides: message.slides,
        title: message.title,
        slide: session.currentSlide
      });

      break;
    }

    case "REQUEST_PRESENTATION": {
      console.log(`[WS] Получена заявка за презентация`);

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
          send(session.teacherSocket, { type: "REQUEST_PRESENTATION" });
          console.log(`📤 Препредадена заявка към учителя`);
        }
      }

      break;
    }

    case "STUDENT_JOINED": {
      if (message.name && typeof message.name === "string") {
        const studentData = {
          name: message.name.trim(),
          avatar: message.avatar || "🦊",
          joinedAt: message.joinedAt || Date.now()
        };

        session.students.set(socket, studentData);

        console.log(`👤 ${studentData.avatar} ${studentData.name} влезе | Общо: ${session.students.size}`);

        if (supabase && session.dbSessionId) {
          supabase
            .from("viewers")
            .insert({
              session_id: session.dbSessionId,
              student_name: studentData.name,
              student_avatar: studentData.avatar
            })
            .select()
            .single()
            .then(({ data, error }) => {
              if (error) {
                console.warn("[DB] Viewer save error:", error.message);
              } else {
                const current = session.students.get(socket);
                if (current) {
                  session.students.set(socket, { ...current, dbViewerId: data.id });
                }
                console.log(`💾 Viewer записан в DB: ${data.id}`);
              }
            });
        }
      }

      broadcast(session, {
        type: "STUDENT_LIST",
        students: Array.from(session.students.values()),
        count: session.students.size
      });

      broadcast(session, {
        type: "STUDENT_COUNT",
        count: session.clients.size
      });

      break;
    }

    case "REACTION": {
      if (!message.reaction) return;

      broadcast(session, {
        type: "REACTION",
        reaction: message.reaction,
        name: message.name || null,
        avatar: message.avatar || null
      });

      console.log(`[REACTION] ${message.avatar || ""} ${message.name || "?"}: ${message.reaction}`);

      if (supabase && session.dbSessionId) {
        let viewerId = null;
        for (const [, student] of session.students.entries()) {
          if (student.name === message.name) {
            viewerId = student.dbViewerId;
            break;
          }
        }

        supabase
          .from("reactions")
          .insert({
            session_id: session.dbSessionId,
            viewer_id: viewerId,
            slide_index: message.slide ?? session.currentSlide,
            emoji: message.reaction
          })
          .then(({ error }) => {
            if (error) {
              console.warn("[DB] Reaction save error:", error.message);
            }
          });
      }

      break;
    }

    case "POLL_ANSWER": {
      const hasNewFormat = message.answerIndex !== undefined;
      const hasOldFormat = message.answer !== undefined;

      if (!hasNewFormat && !hasOldFormat) return;

      const slideIndex =
        message.slideIndex !== undefined
          ? message.slideIndex
          : session.currentSlide;

      const answerIndex =
        message.answerIndex !== undefined ? message.answerIndex : null;

      const answerText =
        message.answerText || message.answer || "";

      const questionText = message.question || "";

      const isCorrect =
        message.isCorrect !== undefined ? message.isCorrect : null;

      const slideType = message.slideType || "poll";

      console.log(
        `📝 Отговор: ${message.avatar || ""} ${message.name || "?"} → слайд ${slideIndex}, опция ${answerIndex ?? "?"}${
          isCorrect !== null ? ` (${isCorrect ? "✅ верен" : "❌ грешен"})` : ""
        }`
      );

      broadcast(session, {
        type: "POLL_ANSWER",
        slideIndex,
        answerIndex,
        answerText,
        question: questionText,
        isCorrect,
        slideType,
        name: message.name || null,
        avatar: message.avatar || null,
        timestamp: message.timestamp || Date.now()
      });

      if (supabase && session.dbSessionId) {
        let viewerId = null;
        for (const [, student] of session.students.entries()) {
          if (student.name === message.name) {
            viewerId = student.dbViewerId;
            break;
          }
        }

        supabase
          .from("answers")
          .insert({
            session_id: session.dbSessionId,
            viewer_id: viewerId,
            slide_index: slideIndex,
            question: questionText,
            answer_index: answerIndex,
            answer_text: answerText,
            is_correct: isCorrect
          })
          .then(({ error }) => {
            if (error) {
              console.warn("[DB] Answer save error:", error.message);
            } else {
              console.log(`💾 Отговор записан в DB (slide ${slideIndex})`);
            }
          });
      }

      break;
    }

    // ═══════════════════════════════════════════════════════
    // 💻 CODE SUBMISSION — ученик пише код, broadcast към всички
    // ═══════════════════════════════════════════════════════
    case "CODE_SUBMISSION": {
      if (typeof message.code !== "string") return;
      if (!message.name) return;

      const slideIndex =
        message.slideIndex !== undefined
          ? message.slideIndex
          : session.currentSlide;

      console.log(
        `💻 ${message.avatar || ""} ${message.name} пише на слайд ${slideIndex} (${message.code.length} chars)`
      );

      broadcast(session, {
        type: "CODE_SUBMISSION",
        slideIndex,
        name: message.name,
        avatar: message.avatar || null,
        code: message.code,
        timestamp: message.timestamp || Date.now()
      });

      break;
    }

    // ═══════════════════════════════════════════════════════
    // 👁️ STUDENT_ATTENTION — ученик влиза/излиза от таба
    // Пазим статуса и препращаме САМО на учителя
    // ═══════════════════════════════════════════════════════
    case "STUDENT_ATTENTION": {
      if (!message.name) return;

      const isFocused = message.isFocused !== false;
      const timestamp = message.timestamp || Date.now();

      // ⭐ Пазим последния статус в session state
      if (!session.studentAttention) {
        session.studentAttention = new Map();
      }

      session.studentAttention.set(message.name, {
        isFocused,
        avatar: message.avatar || null,
        timestamp
      });

      console.log(
        `👁️ ${message.avatar || ""} ${message.name} → ${isFocused ? "✅ focused" : "⚠️ DISTRACTED"}`
      );

      // ⭐ Изпращаме САМО на учителя (учениците нямат нужда от този broadcast)
      if (session.teacherSocket && session.teacherSocket.readyState === 1) {
        send(session.teacherSocket, {
          type: "STUDENT_ATTENTION",
          name: message.name,
          avatar: message.avatar || null,
          isFocused,
          timestamp
        });
      }

      break;
    }

    case "PING": {
      send(socket, { type: "PONG" });
      break;
    }

    default:
      console.log(`[WS] Unknown message type: ${message.type}`);
  }
}

// ---------------------------------------------------------
// BROADCAST & SEND
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
// ⭐ ATTENTION HELPERS
// ---------------------------------------------------------

function getAttentionList(session) {
  if (!session.studentAttention) return [];

  const list = [];
  for (const [name, data] of session.studentAttention.entries()) {
    list.push({
      name,
      avatar: data.avatar,
      isFocused: data.isFocused,
      timestamp: data.timestamp
    });
  }
  return list;
}

// ---------------------------------------------------------
// SESSION ID
// ---------------------------------------------------------

function generateSessionId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ---------------------------------------------------------
// START
// ---------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("======================================");
  console.log(" PRESENTA LIVE SERVER v2.5.0");
  console.log("======================================");
  console.log(`Port: ${PORT}`);
  console.log("");
  console.log("Supabase:");
  console.log(`  ${supabase ? "✅ Connected" : "⚠️ Not configured"}`);
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
