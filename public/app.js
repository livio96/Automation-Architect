/* Automation Architect — client */
const $ = s => document.querySelector(s);
const messagesEl = $("#messages"), form = $("#form"), input = $("#input"), sendBtn = $("#send"), statusEl = $("#status");
const STORE_KEY = "oia:session";
const PW_KEY = "oia:pw";

let messages = load();          // [{role, content}]
let streaming = false;
let latestDashboardData = null;
let templateCache = null;
let password = sessionStorage.getItem(PW_KEY) || "";

marked.setOptions({ breaks: true, gfm: true });

// ---------- boot ----------
(async function boot() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    $("#modelName").textContent = cfg.model;
    if (cfg.passwordRequired && !password) showPassword();
  } catch { $("#modelName").textContent = "unavailable"; }
  render();
})();

function showPassword() {
  $("#pw").style.display = "grid";
  $("#pwBtn").onclick = () => { password = $("#pwInput").value; sessionStorage.setItem(PW_KEY, password); $("#pw").style.display = "none"; };
  $("#pwInput").onkeydown = e => { if (e.key === "Enter") $("#pwBtn").click(); };
}

// ---------- persistence ----------
function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; } }
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(messages)); } catch {} }

// ---------- rendering ----------
function render() {
  $("#welcome").style.display = messages.length ? "none" : "block";
  [...messagesEl.querySelectorAll(".msg")].forEach(n => n.remove());
  latestDashboardData = null;
  messages.forEach((m, i) => messagesEl.appendChild(renderMsg(m, i)));
  updatePhases();
  $("#openDash").style.display = latestDashboardData ? "block" : "none";
  scrollBottom();
}

function renderMsg(m, i) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${m.role}`;
  wrap.dataset.i = i;
  const who = document.createElement("div"); who.className = "who"; who.textContent = m.role === "user" ? "You" : "Architect";
  const bubble = document.createElement("div"); bubble.className = "bubble";
  if (m.role === "user") bubble.textContent = m.content;
  else fillAssistant(bubble, m.content, false);
  wrap.append(who, bubble);
  return wrap;
}

function fillAssistant(bubble, text, live) {
  const data = extractDashboard(text);
  let shown = text;
  if (data) {
    latestDashboardData = data;
    shown = text.replace(/```json[\s\S]*?```/i, "").trim();
  }
  bubble.innerHTML = `<div class="markdown-body">${DOMPurify.sanitize(marked.parse(shown || (live ? "" : "")))}${live ? '<span class="typing"></span>' : ""}</div>`;
  if (data) bubble.appendChild(dashboardCard(data));
}

function dashboardCard(data) {
  const card = document.createElement("div");
  card.className = "dash-card";
  const n = data.opportunities?.length ?? 0, qw = data.summary?.quickWins ?? 0, hrs = data.summary?.hoursSaved ?? "–", r = data.summary?.readiness ?? "–";
  card.innerHTML = `<div><strong>Dashboard ready — ${escapeHtml(data.org?.name || "your process")}</strong><small>${n} opportunities · ${qw} quick wins · ~${hrs} hrs/week · readiness ${r}/100</small></div>
    <div class="actions"><button class="success" data-act="open">Open</button><button data-act="download">Download .html</button></div>`;
  card.querySelector('[data-act="open"]').onclick = () => buildDashboard(data, "open");
  card.querySelector('[data-act="download"]').onclick = () => buildDashboard(data, "download");
  return card;
}

function extractDashboard(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && obj.org && obj.summary && Array.isArray(obj.opportunities) && Array.isArray(obj.processes)) return obj;
  } catch {}
  return null;
}

async function buildDashboard(data, mode) {
  if (!templateCache) templateCache = await (await fetch("/dashboard-template.html")).text();
  const start = templateCache.indexOf("const DATA = {");
  const end = templateCache.indexOf("/* ===================== RENDERING");
  if (start < 0 || end < 0) return alert("Template missing DATA markers.");
  const html = templateCache.slice(0, start) + "const DATA = " + JSON.stringify(data, null, 1) + ";\n\n" + templateCache.slice(end);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  if (mode === "open") window.open(url, "_blank");
  else {
    const a = document.createElement("a");
    a.href = url; a.download = `automation-roadmap-${slug(data.org?.name)}-${data.generated || today()}.html`;
    document.body.appendChild(a); a.click(); a.remove();
  }
}

function updatePhases() {
  // Heuristic: the highest "Phase N" the architect has mentioned is the active one; earlier are done.
  let cur = 0;
  for (const m of messages) if (m.role === "assistant") {
    const found = [...m.content.matchAll(/Phase\s*([1-5])/gi)].map(x => +x[1]);
    if (found.length) cur = Math.max(cur, ...found);
  }
  if (latestDashboardData) cur = 6;
  document.querySelectorAll(".phase").forEach(p => {
    const n = +p.dataset.p;
    p.classList.toggle("done", n < cur);
    p.classList.toggle("active", n === cur);
  });
}

// ---------- chat ----------
form.onsubmit = async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || streaming) return;
  input.value = ""; autosize();
  messages.push({ role: "user", content: text }); save();
  render();
  await stream();
};

async function stream() {
  streaming = true; sendBtn.disabled = true; statusEl.textContent = "Thinking…";
  const assistant = { role: "assistant", content: "" };
  messages.push(assistant);
  const node = renderMsg(assistant, messages.length - 1);
  messagesEl.appendChild(node);
  const bubble = node.querySelector(".bubble");
  fillAssistant(bubble, "", true);
  scrollBottom();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Password": password },
      body: JSON.stringify({ messages: messages.slice(0, -1) })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      if (res.status === 401) { sessionStorage.removeItem(PW_KEY); password = ""; showPassword(); }
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", lastPaint = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) assistant.content += delta;
        } catch (e) { if (e.message && !/Unexpected|JSON/.test(e.message)) throw e; }
      }
      const now = performance.now();
      if (now - lastPaint > 80) { fillAssistant(bubble, assistant.content, true); scrollBottom(); lastPaint = now; }
    }
  } catch (err) {
    assistant.content += `\n\n> **Error:** ${err.message}`;
  } finally {
    fillAssistant(bubble, assistant.content, false);
    save(); updatePhases();
    $("#openDash").style.display = latestDashboardData ? "block" : "none";
    streaming = false; sendBtn.disabled = false; statusEl.textContent = "";
    scrollBottom();
  }
}

// ---------- side actions ----------
$("#newBtn").onclick = () => { if (!messages.length || confirm("Start a new session? The current transcript will be cleared from this browser.")) { messages = []; save(); render(); input.focus(); } };
$("#exportBtn").onclick = () => {
  if (!messages.length) return;
  const md = messages.map(m => `## ${m.role === "user" ? "You" : "Architect"}\n\n${m.content}`).join("\n\n---\n\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" })); a.download = `process-discovery-${today()}.md`; a.click();
};
$("#openDash").onclick = () => latestDashboardData && buildDashboard(latestDashboardData, "open");
$("#example").onclick = () => { input.value = $("#example").textContent.trim(); autosize(); input.focus(); };

// ---------- composer ----------
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
input.addEventListener("input", autosize);
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 220) + "px"; }

// ---------- utils ----------
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function today() { return new Date().toISOString().slice(0, 10); }
function slug(s) { return (s || "process").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
