const express = require("express");
const http = require("http");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
const { GoogleAuth } = require("google-auth-library");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------
// SUPABASE
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
// ⭐ FIREBASE ADMIN (via REST API — no Admin SDK needed)
// ---------------------------------------------------------

let firebaseAuth = null;
let firebaseProjectId = process.env.FIREBASE_PROJECT_ID || null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let sa = process.env.FIREBASE_SERVICE_ACCOUNT;

    // Опитай base64 първо, после чист JSON
    try {
      const decoded = Buffer.from(sa, "base64").toString("utf8");
      if (decoded.trim().startsWith("{")) sa = decoded;
    } catch (_) {}

    const credentials = JSON.parse(sa);
    firebaseProjectId = credentials.project_id || firebaseProjectId;

    firebaseAuth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/datastore"],
    });

    console.log(`[FIREBASE] ✅ Конфигуриран | project: ${firebaseProjectId}`);
  } catch (err) {
    console.error("[FIREBASE] ❌ Грешка:", err.message);
    firebaseAuth = null;
  }
} else {
  console.warn("[FIREBASE] ⚠️ FIREBASE_SERVICE_ACCOUNT липсва — Firestore cleanup е изключен");
}

// ⭐ Update Firestore activeSessions/{sessionId} → status: "ended"
async function endSessionInFirestore(sessionId) {
  if (!firebaseAuth || !firebaseProjectId || !sessionId) return false;

  try {
    const client = await firebaseAuth.getClient();
    const { token } = await client.getAccessToken();

    const url =
      `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}` +
      `/databases/(default)/documents/activeSessions/${encodeURIComponent(sessionId)}` +
      `?updateMask.fieldPaths=status&updateMask.fieldPaths=endedAt&updateMask.fieldPaths=endedReason`;

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          status: { stringValue: "ended" },
          endedAt: { timestampValue: new Date().toISOString() },
          endedReason: { stringValue: "server_auto_end" },
        },
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[FIREBASE] ⚠️ Update failed (${res.status}):`, txt.slice(0, 200));
      return false;
    }

    console.log(`🔥 [FIREBASE] Session ${sessionId} → status: ended`);
    return true;
  } catch (err) {
    console.error("[FIREBASE] ❌ Error:", err.message);
    return false;
  }
}

// ⭐ Delete Firestore activeSessions/{sessionId} (по-чисто от update)
async function deleteSessionInFirestore(sessionId) {
  if (!firebaseAuth || !firebaseProjectId || !sessionId) return false;

  try {
    const client = await firebaseAuth.getClient();
    const { token } = await client.getAccessToken();

    const url =
      `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}` +
      `/databases/(default)/documents/activeSessions/${encodeURIComponent(sessionId)}`;

    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    // 404 е ОК — вече го няма
    if (res.status === 404) return true;

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[FIREBASE] ⚠️ Delete failed (${res.status}):`, txt.slice(0, 200));
      return false;
    }

    console.log(`🔥 [FIREBASE] Session ${sessionId} → DELETED`);
    return true;
  } catch (err) {
    console.error("[FIREBASE] ❌ Error:", err.message);
    return false;
  }
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
  process.env.FRONTEND_URL,
].filter(Boolean);

console.log("[CONFIG] Allowed origins:");
allowedOrigins.forEach((origin) => console.log(`  - ${origin}`));

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
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// ---------------------------------------------------------
// HEALTH
// ---------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    name: "Presenta Live Server",
    status: "online",
    version: "2.6.0",
    supabase: !!supabase,
    firebase: !!firebaseAuth,
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "presenta-live-server",
    version: "2.6.0",
    supabase: !!supabase,
    firebase: !!firebaseAuth,
  });
});

// ═════════════════════════════════════════════════════════
// 💾 PRESENTATIONS CRUD (непроменено)
// ═════════════════════════════════════════════════════════

app.post("/api/presentations", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });
  const { title, slides, courseId } = req.body;
  if (!title || !Array.isArray(slides))
    return res.status(400).json({ error: "title and slides are required" });

  try {
    const { data, error } = await supabase
      .from("presentations")
      .insert({ title, slides, course_id: courseId || null })
      .select()
      .single();
    if (error) throw error;
    console.log(`💾 Запазена презентация: ${data.id} | ${title}`);
    res.json(data);
  } catch (err) {
    console.error("[DB] Save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/presentations", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });
  try {
    const { data, error } = await supabase
      .from("presentations")
      .select("id, title, course_id, created_at, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    res.json({
      presentations: (data || []).map((p) => ({
        id: p.id,
        title: p.title,
        courseId: p.course_id || null,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(404).json({ error: "Presentation not found" });
  }
});

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
    res.json({
      id: data.id,
      title: data.title,
      slides: data.slides,
      courseId: data.course_id || null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/presentations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });
  try {
    const { error } = await supabase
      .from("presentations")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════
// 🎬 LIVE SESSIONS
// ═════════════════════════════════════════════════════════

const sessions = new Map();

// ⭐ Grace period преди auto-end при teacher disconnect
const TEACHER_DISCONNECT_GRACE_MS = 8000;

// ---------------------------------------------------------
// ⭐ Helper: end session (всички cleanup-и на едно място)
// ---------------------------------------------------------
async function endSessionInternal(sessionId, reason = "manual") {
  const session = sessions.get(sessionId);
  if (!session) return false;

  console.log(`[SESSION] Ending ${sessionId} | reason: ${reason}`);

  // Cancel any pending auto-end timer
  if (session.autoEndTimer) {
    clearTimeout(session.autoEndTimer);
    session.autoEndTimer = null;
  }

  // 1) Supabase
  if (supabase && session.dbSessionId) {
    try {
      await supabase
        .from("sessions")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", session.dbSessionId);
    } catch (err) {
      console.warn("[DB] End session error:", err.message);
    }
  }

  // 2) ⭐ Firestore — най-важното
  try {
    await endSessionInFirestore(sessionId);
  } catch (err) {
    console.warn("[FIREBASE] End session error:", err.message);
  }

  // 3) Broadcast SESSION_ENDED
  broadcast(session, { type: "SESSION_ENDED", reason });

  // 4) Close всички clients
  for (const client of session.clients) {
    try {
      client.close(1000, "Session ended");
    } catch (error) {
      console.error("[WS] Error closing client:", error.message);
    }
  }

  // 5) Изтрий от Map
  sessions.delete(sessionId);

  return true;
}

// ---------------------------------------------------------
// CREATE SESSION
// ---------------------------------------------------------

app.post("/api/sessions", async (req, res) => {
  const { presentationId, presentationTitle, totalSlides } = req.body;
  if (!presentationId)
    return res.status(400).json({ error: "presentationId is required" });

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
          total_slides: totalSlides || 0,
        })
        .select()
        .single();
      if (!error && data) dbSessionId = data.id;
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
    teacherSockets: new Set(), // ⭐ всички teacher sockets
    clients: new Set(),
    students: new Map(),
    studentAttention: new Map(),
    startedAt: startTime,
    autoEndTimer: null, // ⭐ timer за auto-end
  });

  console.log(`[SESSION] Created ${sessionId}`);
  res.json({ sessionId, presentationId, currentSlide: 0, dbSessionId });
});

// ---------------------------------------------------------
// LIST ACTIVE
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
      hasSlides: !!session.slides,
    });
  }
  res.json({ count: activeSessions.length, sessions: activeSessions });
});

// ---------------------------------------------------------
// GET ONE
// ---------------------------------------------------------

app.get("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId: req.params.sessionId,
    presentationId: session.presentationId,
    currentSlide: session.currentSlide,
    connectedClients: session.clients.size,
    studentCount: session.students.size,
    students: Array.from(session.students.values()),
    hasSlides: !!session.slides,
  });
});

// ---------------------------------------------------------
// ⭐ NEW: Lightweight verify endpoint (portfolio can poll)
// ---------------------------------------------------------

app.get("/api/sessions/:sessionId/verify", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  const alive = !!session;
  res.json({ alive, sessionId: req.params.sessionId });
});

// ---------------------------------------------------------
// CHANGE SLIDE (REST)
// ---------------------------------------------------------

app.post("/api/sessions/:sessionId/slide", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const slide = Number(req.body.slide);
  if (!Number.isInteger(slide) || slide < 0)
    return res.status(400).json({ error: "Invalid slide" });

  session.currentSlide = slide;
  broadcast(session, { type: "SLIDE_CHANGED", slide });
  res.json({ ok: true, slide });
});

// ---------------------------------------------------------
// DELETE / END SESSION (извиква се от клиента)
// ---------------------------------------------------------

app.delete("/api/sessions/:sessionId", async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  await endSessionInternal(req.params.sessionId, "manual");

  res.json({ ok: true, sessionId: req.params.sessionId });
});

// ---------------------------------------------------------
// ⭐ NEW: Force-end endpoint (portfolio can call if stuck)
// ---------------------------------------------------------

app.post("/api/sessions/:sessionId/force-end", async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (session) {
    await endSessionInternal(req.params.sessionId, "force");
  } else {
    // Опитай да изчистиш Firestore дори ако не е в Map
    await endSessionInFirestore(req.params.sessionId);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------
// WEBSOCKET
// ---------------------------------------------------------

const wss = new WebSocketServer({ server, path: "/ws" });

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

  socket.__role = null; // ⭐ "teacher" | "student" | null
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
    title: session.title || undefined,
  });

  if (session.students.size > 0) {
    send(socket, {
      type: "STUDENT_LIST",
      students: Array.from(session.students.values()),
      count: session.students.size,
    });
  }

  if (session.studentAttention && session.studentAttention.size > 0) {
    send(socket, {
      type: "STUDENT_ATTENTION_LIST",
      attention: getAttentionList(session),
    });
  }

  if (session.slides) {
    send(socket, {
      type: "PRESENTATION_DATA",
      slides: session.slides,
      title: session.title,
      slide: session.currentSlide,
    });
  }

  broadcast(session, { type: "STUDENT_COUNT", count: session.clients.size });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      handleMessage(session, socket, message);
    } catch (error) {
      console.error("[WS] Invalid message:", error.message);
      send(socket, { type: "ERROR", message: "Invalid message" });
    }
  });

  socket.on("close", async () => {
    const studentData = session.students.get(socket);
    const wasTeacher = socket.__role === "teacher";

    session.clients.delete(socket);
    session.students.delete(socket);

    if (wasTeacher) {
      session.teacherSockets.delete(socket);
    }

    if (session.teacherSocket === socket) {
      session.teacherSocket = null;
      // Fallback към друг teacher socket ако има
      if (session.teacherSockets.size > 0) {
        session.teacherSocket = Array.from(session.teacherSockets)[0];
      }
    }

    // ⭐ Ако беше teacher и няма повече teachers → schedule auto-end
    if (wasTeacher && session.teacherSockets.size === 0) {
      if (session.autoEndTimer) clearTimeout(session.autoEndTimer);

      const sid = sessionId; // capture
      session.autoEndTimer = setTimeout(async () => {
        const s = sessions.get(sid);
        if (!s) return;
        if (s.teacherSockets.size > 0) {
          console.log(`[SESSION] Teacher reconnected — auto-end canceled`);
          return;
        }
        console.log(`[SESSION] Teacher gone for ${TEACHER_DISCONNECT_GRACE_MS}ms → auto-ending`);
        await endSessionInternal(sid, "teacher_disconnected");
      }, TEACHER_DISCONNECT_GRACE_MS);

      console.log(
        `[WS] Teacher disconnected from ${sessionId} — auto-end scheduled in ${TEACHER_DISCONNECT_GRACE_MS}ms`
      );
    }

    // Student disconnect → cleanup attention
    if (studentData && session.studentAttention) {
      const wasTracked = session.studentAttention.has(studentData.name);
      session.studentAttention.delete(studentData.name);

      if (wasTracked && session.teacherSocket && session.teacherSocket.readyState === 1) {
        send(session.teacherSocket, {
          type: "STUDENT_ATTENTION",
          name: studentData.name,
          avatar: studentData.avatar,
          isFocused: false,
          disconnected: true,
          timestamp: Date.now(),
        });
      }
    }

    console.log(
      `[WS] Client disconnected → ${sessionId} | clients: ${session.clients.size} | students: ${session.students.size}`
    );

    broadcast(session, { type: "STUDENT_COUNT", count: session.clients.size });
    broadcast(session, {
      type: "STUDENT_LIST",
      students: Array.from(session.students.values()),
      count: session.students.size,
    });
  });

  socket.on("error", (error) => {
    console.error(`[WS] Client error → ${sessionId}:`, error.message);
  });
});

// ---------------------------------------------------------
// HANDLE MESSAGES
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

      // ⭐ Tag role
      socket.__role = "teacher";
      session.teacherSockets.add(socket);

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
        title: message.title || undefined,
      });
      break;
    }

    case "PRESENTATION_DATA": {
      if (!message.slides || !Array.isArray(message.slides)) return;

      // ⭐ Tag role
      socket.__role = "teacher";
      session.teacherSockets.add(socket);

      session.slides = message.slides;
      session.title = message.title || null;
      session.teacherSocket = socket;

      broadcast(session, {
        type: "PRESENTATION_DATA",
        slides: message.slides,
        title: message.title,
        slide: session.currentSlide,
      });
      break;
    }

    case "REQUEST_PRESENTATION": {
      if (session.slides) {
        send(socket, {
          type: "PRESENTATION_DATA",
          slides: session.slides,
          title: session.title,
          slide: session.currentSlide,
        });
      } else if (session.teacherSocket && session.teacherSocket.readyState === 1) {
        send(session.teacherSocket, { type: "REQUEST_PRESENTATION" });
      }
      break;
    }

    case "STUDENT_JOINED": {
      if (!message.name || typeof message.name !== "string") return;

      // ⭐ Tag role
      socket.__role = "student";
      session.teacherSockets.delete(socket);

      const studentData = {
        name: message.name.trim(),
        avatar: message.avatar || "🦊",
        joinedAt: message.joinedAt || Date.now(),
      };

      session.students.set(socket, studentData);

      if (supabase && session.dbSessionId) {
        supabase
          .from("viewers")
          .insert({
            session_id: session.dbSessionId,
            student_name: studentData.name,
            student_avatar: studentData.avatar,
          })
          .select()
          .single()
          .then(({ data, error }) => {
            if (!error && data) {
              const cur = session.students.get(socket);
              if (cur) session.students.set(socket, { ...cur, dbViewerId: data.id });
            }
          });
      }

      broadcast(session, {
        type: "STUDENT_LIST",
        students: Array.from(session.students.values()),
        count: session.students.size,
      });
      broadcast(session, { type: "STUDENT_COUNT", count: session.clients.size });
      break;
    }

    case "REACTION": {
      if (!message.reaction) return;

      broadcast(session, {
        type: "REACTION",
        reaction: message.reaction,
        name: message.name || null,
        avatar: message.avatar || null,
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
          .from("reactions")
          .insert({
            session_id: session.dbSessionId,
            viewer_id: viewerId,
            slide_index: message.slide ?? session.currentSlide,
            emoji: message.reaction,
          })
          .then(() => {});
      }
      break;
    }

    case "POLL_ANSWER": {
      const hasNewFormat = message.answerIndex !== undefined;
      const hasOldFormat = message.answer !== undefined;
      if (!hasNewFormat && !hasOldFormat) return;

      const slideIndex =
        message.slideIndex !== undefined ? message.slideIndex : session.currentSlide;
      const answerIndex =
        message.answerIndex !== undefined ? message.answerIndex : null;
      const answerText = message.answerText || message.answer || "";
      const questionText = message.question || "";
      const isCorrect =
        message.isCorrect !== undefined ? message.isCorrect : null;
      const slideType = message.slideType || "poll";

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
        timestamp: message.timestamp || Date.now(),
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
            is_correct: isCorrect,
          })
          .then(() => {});
      }
      break;
    }

    case "CODE_SUBMISSION": {
      if (typeof message.code !== "string") return;
      if (!message.name) return;

      const slideIndex =
        message.slideIndex !== undefined ? message.slideIndex : session.currentSlide;

      broadcast(session, {
        type: "CODE_SUBMISSION",
        slideIndex,
        name: message.name,
        avatar: message.avatar || null,
        code: message.code,
        timestamp: message.timestamp || Date.now(),
      });
      break;
    }

    case "STUDENT_ATTENTION": {
      if (!message.name) return;

      const isFocused = message.isFocused !== false;
      const timestamp = message.timestamp || Date.now();

      if (!session.studentAttention) session.studentAttention = new Map();

      session.studentAttention.set(message.name, {
        isFocused,
        avatar: message.avatar || null,
        timestamp,
      });

      if (session.teacherSocket && session.teacherSocket.readyState === 1) {
        send(session.teacherSocket, {
          type: "STUDENT_ATTENTION",
          name: message.name,
          avatar: message.avatar || null,
          isFocused,
          timestamp,
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
// BROADCAST / SEND
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
// HELPERS
// ---------------------------------------------------------

function getAttentionList(session) {
  if (!session.studentAttention) return [];
  const list = [];
  for (const [name, data] of session.studentAttention.entries()) {
    list.push({
      name,
      avatar: data.avatar,
      isFocused: data.isFocused,
      timestamp: data.timestamp,
    });
  }
  return list;
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ---------------------------------------------------------
// ⭐ PERIODIC CLEANUP — изчиства заседнали Firestore docs
// ---------------------------------------------------------

// На всеки 30 мин проверява дали има "стари" sessions и ги приключва
setInterval(async () => {
  if (!firebaseAuth) return;

  const now = Date.now();
  const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 часа

  for (const [sessionId, session] of sessions.entries()) {
    const age = now - new Date(session.startedAt).getTime();
    if (age > MAX_AGE_MS) {
      console.log(`[CLEANUP] Session ${sessionId} is ${Math.round(age / 60000)} min old — ending`);
      await endSessionInternal(sessionId, "stale");
    }
  }
}, 30 * 60 * 1000);

// ---------------------------------------------------------
// START
// ---------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("======================================");
  console.log(" PRESENTA LIVE SERVER v2.6.0");
  console.log("======================================");
  console.log(`Port: ${PORT}`);
  console.log(`Supabase: ${supabase ? "✅" : "⚠️"}`);
  console.log(`Firebase: ${firebaseAuth ? "✅" : "⚠️"}`);
  console.log("======================================");
});
