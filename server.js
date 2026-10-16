import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config (all overridable in Render → Environment) ----
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-fable-5.1";
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 16000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_PASSWORD = process.env.APP_PASSWORD || ""; // optional shared password for the UI

const SYSTEM_PROMPT = readFileSync(path.join(__dirname, "prompt", "system-prompt.md"), "utf8");

if (!OPENROUTER_API_KEY) {
  console.warn("WARNING: OPENROUTER_API_KEY is not set. /api/chat will fail until it is.");
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Optional gate: if APP_PASSWORD is set, the client must send it as X-App-Password.
function auth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.get("x-app-password") === APP_PASSWORD) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.get("/api/config", (req, res) => {
  res.json({ model: MODEL, passwordRequired: Boolean(APP_PASSWORD) });
});

// Streams OpenRouter's SSE straight through to the browser.
app.post("/api/chat", auth, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] required" });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server missing OPENROUTER_API_KEY" });
  }

  // Keep only role/content, cap history length defensively.
  const history = messages
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-80)
    .map(m => ({ role: m.role, content: m.content }));

  // Abort the upstream call if the browser disconnects. (Listen on res, not req:
  // in Node 18+ req 'close' fires as soon as the body is read.)
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });

  let upstream;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": APP_URL,
        "X-Title": "Automation Architect"
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: MAX_TOKENS,
        temperature: 0.4,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history]
      })
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    return res.status(502).json({ error: `Upstream connection failed: ${err.message}` });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return res.status(upstream.status).json({ error: `OpenRouter ${upstream.status}: ${text.slice(0, 500)}` });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (!controller.signal.aborted) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Automation Architect listening on ${PORT} using ${MODEL}`);
});
