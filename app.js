import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm";

/* ───────────── 저장소 (브라우저 localStorage) ───────────── */
const PREFIX = "haru:";
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
    catch (e) { toast("저장에 실패했어요: " + e.message); }
  },
};

const state = {
  entries: store.get("entries", {}),   // { "YYYY-MM-DD": { text, mood, questions: [], answers: [], updatedAt } }
  chats: store.get("chats", {}),       // { "YYYY-MM-DD": [{ role, content, kind?, eventIds? }] }
  events: store.get("events", []),     // [{ id, title, date, time, endTime, note, source }]
  settings: { model: "claude-opus-5-5", apiKey: "", autoAdd: true, ...store.get("settings", {}) },
  diaryDate: today(),
  calMonth: firstOfMonth(new Date()),
  selectedDay: today(),
};
const save = {
  entries: () => store.set("entries", state.entries),
  chats: () => store.set("chats", state.chats),
  events: () => store.set("events", state.events),
  settings: () => store.set("settings", state.settings),
};

/* ───────────── 날짜 도우미 ───────────── */
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function today() { return ymd(new Date()); }
function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function prettyDate(s) {
  const d = parseYmd(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
}
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

/* ───────────── UI 도우미 ───────────── */
const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* ───────────── Claude API ───────────── */
const EVENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "짧은 일정 제목" },
    date: { type: "string", description: "YYYY-MM-DD 형식의 절대 날짜" },
    time: { type: "string", description: "시작 시각 HH:MM (24시간). 모르면 빈 문자열" },
    end_time: { type: "string", description: "종료 시각 HH:MM. 모르면 빈 문자열" },
    note: { type: "string", description: "장소·준비물 등 메모. 없으면 빈 문자열" },
  },
  required: ["title", "date", "time", "end_time", "note"],
  additionalProperties: false,
};
const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    events: { type: "array", items: EVENT_SCHEMA },
  },
  required: ["reply", "events"],
  additionalProperties: false,
};
const DIARY_SCHEMA = {
  type: "object",
  properties: {
    reflection: { type: "string" },
    events: { type: "array", items: EVENT_SCHEMA },
  },
  required: ["reflection", "events"],
  additionalProperties: false,
};
const QUESTIONS_SCHEMA = {
  type: "object",
  properties: { questions: { type: "array", items: { type: "string" } } },
  required: ["questions"],
  additionalProperties: false,
};

function client() {
  if (!state.settings.apiKey) {
    openSettings();
    throw new Error("먼저 설정에서 Claude API 키를 입력해 주세요.");
  }
  return new Anthropic({ apiKey: state.settings.apiKey, dangerouslyAllowBrowser: true });
}

async function askJson({ system, messages, schema, effort = "low" }) {
  const c = client();
  const model = state.settings.model;
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages,
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  let res;
  try {
    if (model.startsWith("claude-haiku")) {
      res = await c.messages.create(params);
    } else {
      // 안전 분류기가 거절하면 서버에서 다른 모델로 자동 재시도
      res = await c.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("API 키가 올바르지 않아요. 설정을 확인해 주세요.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("이 API 키로는 선택한 모델을 쓸 수 없어요.");
    if (e instanceof Anthropic.RateLimitError) throw new Error("요청이 너무 많아요. 잠시 후 다시 시도해 주세요.");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("네트워크에 연결할 수 없어요.");
    if (e instanceof Anthropic.APIStatusError) throw new Error(`API 오류 (${e.status}): ${e.message}`);
    throw e;
  }
  if (res.stop_reason === "refusal") throw new Error("AI가 이 요청에는 응답하지 않았어요.");
  if (res.stop_reason === "max_tokens") throw new Error("응답이 너무 길어 잘렸어요. 다시 시도해 주세요.");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("응답이 비어 있어요.");
  return JSON.parse(text);
}

function dateContext() {
  const t = today();
  const lines = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(t, i);
    lines.push(`${d} (${WEEK[parseYmd(d).getDay()]})`);
  }
  return `오늘은 ${prettyDate(t)}입니다. 앞으로 2주 날짜표: ${lines.join(", ")}`;
}

function upcomingEventsText() {
  const t = today();
  const list = state.events
    .filter((e) => e.date >= addDays(t, -1))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, 40)
    .map((e) => `- ${e.date} ${e.time || ""} ${e.title}`);
  return list.length ? list.join("\n") : "(없음)";
}

// 최근 기록 (일기 + 대화) 을 텍스트로
function recentRecords(days = 7) {
  const t = today();
  const parts = [];
  for (let i = days; i >= 0; i--) {
    const d = addDays(t, -i);
    const e = state.entries[d];
    const chat = state.chats[d] || [];
    const bits = [];
    if (e?.mood) bits.push(`기분: ${e.mood}`);
    (e?.questions || []).forEach((q, idx) => { if (e.answers?.[idx]) bits.push(`Q. ${q}\nA. ${e.answers[idx]}`); });
    if (e?.text) bits.push(`일기: ${e.text}`);
    const said = chat.filter((m) => m.role === "user").map((m) => m.content);
    if (said.length) bits.push(`대화에서 한 말:\n${said.join("\n")}`);
    if (bits.length) parts.push(`### ${prettyDate(d)}\n${bits.join("\n")}`);
  }
  return parts.length ? parts.join("\n\n") : "(아직 기록 없음)";
}

const EVENT_RULES = `일정 추출 규칙:
- 사용자가 앞으로 할 일(약속, 시험, 마감, 회의, 병원, 여행 등)을 구체적으로 언급했을 때만 events에 넣으세요. 이미 지난 일이나 막연한 바람은 넣지 마세요.
- "내일", "다음 주 금요일" 같은 상대 날짜는 날짜표를 보고 YYYY-MM-DD로 바꾸세요.
- 아래 "이미 등록된 일정"과 같은 일정은 다시 넣지 마세요.
- 일정이 없으면 빈 배열을 돌려주세요.`;

/* ───────────── 탭 ───────────── */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "calendar") renderCalendar();
  if (name === "chat") { renderChat(); $("#chatInput").focus(); }
  if (name === "diary") renderDiary();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* ───────────── 일정 공통 ───────────── */
function addEvents(list, source) {
  const added = [];
  for (const ev of list) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date) || !ev.title?.trim()) continue;
    const dup = state.events.some((x) => x.date === ev.date && x.title.trim() === ev.title.trim());
    if (dup) continue;
    const item = {
      id: uid(), title: ev.title.trim(), date: ev.date,
      time: /^\d{2}:\d{2}$/.test(ev.time) ? ev.time : "",
      endTime: /^\d{2}:\d{2}$/.test(ev.end_time ?? ev.endTime) ? (ev.end_time ?? ev.endTime) : "",
      note: ev.note || "", source,
    };
    state.events.push(item);
    added.push(item);
  }
  if (added.length) save.events();
  return added;
}
function removeEvent(id) {
  state.events = state.events.filter((e) => e.id !== id);
  save.events();
}
function eventLabel(e) {
  const d = parseYmd(e.date);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})${e.time ? " " + e.time : ""} ${e.title}`;
}

// AI가 찾은 일정 → 자동 추가 또는 제안 칩
function eventChips(found, source, onChange) {
  const wrap = el("div", { class: "ev-chips" });
  for (const ev of found) {
    const chip = el("span", { class: "ev-chip" });
    const draw = () => {
      chip.replaceChildren();
      const existing = ev.id && state.events.find((x) => x.id === ev.id);
      if (existing) {
        chip.classList.remove("removed");
        chip.append(`📅 ${eventLabel(existing)} 추가됨`,
          el("button", { type: "button", onclick: () => { removeEvent(ev.id); ev.id = null; draw(); onChange?.(); } }, "취소"));
      } else {
        chip.classList.add("removed");
        chip.append(`📅 ${eventLabel({ ...ev, time: ev.time })}`,
          el("button", { type: "button", onclick: () => { const [a] = addEvents([ev], source); if (a) ev.id = a.id; draw(); onChange?.(); } }, "추가"));
      }
    };
    draw();
    wrap.append(chip);
  }
  return wrap;
}
function handleFound(found, source) {
  // found: AI 결과 배열. 자동 추가 설정이면 바로 추가하고 id를 붙인다.
  const items = found.map((f) => ({ ...f }));
  if (state.settings.autoAdd) {
    for (const it of items) { const [a] = addEvents([it], source); if (a) it.id = a.id; }
  }
  return items;
}

/* ───────────── 일기 ───────────── */
function entry(d) {
  if (!state.entries[d]) state.entries[d] = { text: "", mood: "", questions: [], answers: [] };
  return state.entries[d];
}

function renderDiary() {
  const d = state.diaryDate;
  const e = state.entries[d] || { text: "", mood: "", questions: [], answers: [] };
  $("#diaryDate").textContent = prettyDate(d);
  $("#nextDay").disabled = d >= today();
  $("#diaryText").value = e.text || "";
  document.querySelectorAll("#moods button").forEach((b) => b.classList.toggle("on", b.dataset.mood === e.mood));
  $("#savedState").textContent = e.updatedAt ? `마지막 저장 ${new Date(e.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : "";
  $("#diaryResult").replaceChildren();
  $("#refreshQuestions").hidden = d !== today();
  renderQuestions();
  if (d === today() && !(e.questions || []).length && state.settings.apiKey) generateQuestions();
}

function renderQuestions() {
  const d = state.diaryDate;
  const e = state.entries[d];
  const ol = $("#questions");
  ol.replaceChildren();
  const qs = e?.questions || [];
  if (!qs.length) {
    $("#questionsHint").textContent = d === today()
      ? (state.settings.apiKey ? "질문을 만들고 있어요…" : "설정에서 API 키를 입력하면 최근 대화와 일기를 바탕으로 매일 질문을 만들어 드려요.")
      : "이 날은 질문이 없어요.";
    return;
  }
  $("#questionsHint").textContent = d === today() ? "최근 대화와 일기를 바탕으로 만든 질문이에요." : "";
  qs.forEach((q, i) => {
    const ta = el("textarea", { rows: 2, placeholder: "답을 적어 보세요" });
    ta.value = e.answers?.[i] || "";
    ta.addEventListener("input", () => {
      const en = entry(d);
      en.answers[i] = ta.value;
      en.updatedAt = Date.now();
      save.entries();
    });
    ol.append(el("li", {}, el("span", { class: "q" }, q), ta));
  });
}

let generating = false;
async function generateQuestions() {
  if (generating) return;
  generating = true;
  const btn = $("#refreshQuestions");
  btn.disabled = true;
  $("#questionsHint").textContent = "최근 기록을 읽고 질문을 만들고 있어요…";
  try {
    const out = await askJson({
      system: `당신은 사용자의 일기 쓰기를 돕는 다정한 친구입니다. ${dateContext()}
사용자의 최근 기록(일기, 대화)과 다가오는 일정을 읽고, 오늘 일기에 답할 질문 3개를 한국어로 만드세요.
- 최근에 언급된 구체적인 사건, 사람, 감정, 다가오는 일정과 연결된 질문을 우선하세요. (예: "어제 걱정하던 발표 준비는 어떻게 됐어요?")
- 기록이 거의 없으면 하루를 돌아보게 하는 일반 질문을 만드세요.
- 각 질문은 한 문장, 부담 없이 답할 수 있게.`,
      messages: [{
        role: "user",
        content: `## 최근 기록\n${recentRecords(7)}\n\n## 다가오는 일정\n${upcomingEventsText()}\n\n오늘의 질문 3개를 만들어 주세요.`,
      }],
      schema: QUESTIONS_SCHEMA,
      effort: "low",
    });
    const e = entry(today());
    e.questions = (out.questions || []).slice(0, 3);
    e.answers = [];
    save.entries();
    if (state.diaryDate === today()) renderQuestions();
  } catch (err) {
    $("#questionsHint").textContent = err.message;
  } finally {
    generating = false;
    btn.disabled = false;
  }
}

$("#refreshQuestions").addEventListener("click", () => {
  const e = state.entries[today()];
  if (e?.answers?.some(Boolean) && !confirm("새 질문을 만들면 지금 질문의 답이 지워져요. 계속할까요?")) return;
  generateQuestions();
});
$("#prevDay").addEventListener("click", () => { state.diaryDate = addDays(state.diaryDate, -1); renderDiary(); });
$("#nextDay").addEventListener("click", () => { if (state.diaryDate < today()) { state.diaryDate = addDays(state.diaryDate, 1); renderDiary(); } });
$("#goToday").addEventListener("click", () => { state.diaryDate = today(); renderDiary(); });

let typingTimer;
$("#diaryText").addEventListener("input", () => {
  clearTimeout(typingTimer);
  $("#savedState").textContent = "작성 중…";
  typingTimer = setTimeout(() => {
    const e = entry(state.diaryDate);
    e.text = $("#diaryText").value;
    e.updatedAt = Date.now();
    save.entries();
    $("#savedState").textContent = "자동 저장됨";
  }, 600);
});
document.querySelectorAll("#moods button").forEach((b) => b.addEventListener("click", () => {
  const e = entry(state.diaryDate);
  e.mood = e.mood === b.dataset.mood ? "" : b.dataset.mood;
  e.updatedAt = Date.now();
  save.entries();
  document.querySelectorAll("#moods button").forEach((x) => x.classList.toggle("on", x.dataset.mood === e.mood));
}));

$("#saveDiary").addEventListener("click", async () => {
  const d = state.diaryDate;
  const e = entry(d);
  e.text = $("#diaryText").value;
  e.updatedAt = Date.now();
  save.entries();
  $("#savedState").textContent = "저장됨";
  const answered = (e.questions || []).map((q, i) => e.answers?.[i] ? `Q. ${q}\nA. ${e.answers[i]}` : "").filter(Boolean).join("\n");
  if (!e.text.trim() && !answered) { toast("저장했어요."); return; }
  if (!state.settings.apiKey) { toast("저장했어요. API 키를 넣으면 일정도 찾아 드려요."); return; }

  const btn = $("#saveDiary");
  btn.disabled = true;
  btn.textContent = "일정 찾는 중…";
  const result = $("#diaryResult");
  result.replaceChildren();
  try {
    const out = await askJson({
      system: `당신은 사용자의 일기를 읽는 다정한 친구입니다. ${dateContext()}
이 일기는 ${prettyDate(d)}에 쓴 것입니다. 상대 날짜는 일기를 쓴 날 기준으로 해석하세요.
reflection: 일기에 대한 따뜻한 한두 문장 코멘트 (조언을 늘어놓지 말고 공감 위주).
${EVENT_RULES}`,
      messages: [{
        role: "user",
        content: `## 이미 등록된 일정\n${upcomingEventsText()}\n\n## 일기\n${answered}\n${e.text}`,
      }],
      schema: DIARY_SCHEMA,
      effort: "low",
    });
    const items = handleFound(out.events || [], "diary");
    result.append(el("div", { class: "reflection" }, out.reflection));
    if (items.length) result.append(eventChips(items, "diary"));
    toast(items.length ? `일정 ${items.length}개를 찾았어요.` : "저장했어요.");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "저장하고 일정 찾기";
  }
});

/* ───────────── 대화 ───────────── */
function chatLog() {
  const d = today();
  if (!state.chats[d]) state.chats[d] = [];
  return state.chats[d];
}

function renderChat() {
  $("#chatDate").textContent = prettyDate(today());
  const box = $("#messages");
  box.replaceChildren();
  const log = state.chats[today()] || [];
  if (!log.length) {
    box.append(el("p", { class: "empty" }, "오늘 있었던 일을 편하게 이야기해 주세요. 대화 속 일정은 캘린더에 기록되고, 내일의 질문에 반영돼요."));
  }
  for (const m of log) box.append(messageNode(m));
  box.scrollTop = box.scrollHeight;
}

function messageNode(m) {
  if (m.kind === "imported") {
    return el("div", { class: "msg imported" },
      el("details", {}, el("summary", {}, "📋 가져온 대화"), m.content.replace(/^\[가져온 대화\]\n/, "")));
  }
  const node = el("div", { class: `msg ${m.role}` }, m.content);
  if (m.events?.length) {
    node.append(eventChips(m.events, "chat", () => save.chats()));
  }
  return node;
}

let sending = false;
async function sendChat(text, kind) {
  if (sending || !text.trim()) return;
  sending = true;
  $("#sendBtn").disabled = true;
  const log = chatLog();
  const userMsg = { role: "user", content: text };
  if (kind) userMsg.kind = kind;
  log.push(userMsg);
  save.chats();
  renderChat();
  const typing = el("div", { class: "msg assistant typing" }, "생각하는 중…");
  $("#messages").append(typing);
  $("#messages").scrollTop = $("#messages").scrollHeight;

  try {
    const out = await askJson({
      system: `당신은 사용자의 하루 이야기를 들어 주는 다정한 일기 친구입니다. 한국어 반말이 아닌 부드러운 존댓말을 쓰세요. ${dateContext()}
- reply는 2~4문장. 공감하고, 하루를 더 돌아볼 수 있게 질문을 하나만 덧붙이세요.
- 사용자가 [가져온 대화]를 보냈다면 내용을 짧게 요약해 주고, 그 안의 일정을 찾으세요.
${EVENT_RULES}

## 최근 며칠의 기록 (참고)
${recentRecords(3)}

## 이미 등록된 일정
${upcomingEventsText()}`,
      messages: log.map((m) => ({ role: m.role, content: m.content })),
      schema: CHAT_SCHEMA,
      effort: "low",
    });
    const events = handleFound(out.events || [], "chat");
    log.push({ role: "assistant", content: out.reply, events });
    save.chats();
  } catch (err) {
    log.pop(); // 실패한 메시지는 되돌리고 입력창에 복구
    save.chats();
    if (!kind) $("#chatInput").value = text;
    toast(err.message);
  } finally {
    sending = false;
    $("#sendBtn").disabled = false;
    renderChat();
  }
}

$("#chatForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("#chatInput").value;
  $("#chatInput").value = "";
  sendChat(text);
});
$("#chatInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("#chatForm").requestSubmit();
  }
});
$("#importConv").addEventListener("click", () => { $("#importText").value = ""; $("#importDialog").showModal(); });
$("#importDialog").addEventListener("close", () => {
  const text = $("#importText").value.trim();
  if ($("#importDialog").returnValue === "ok" && text) sendChat(`[가져온 대화]\n${text}`, "imported");
});

/* ───────────── 캘린더 ───────────── */
function renderCalendar() {
  const m = state.calMonth;
  $("#monthLabel").textContent = `${m.getFullYear()}년 ${m.getMonth() + 1}월`;
  const grid = $("#calGrid");
  grid.replaceChildren();
  const start = new Date(m);
  start.setDate(1 - m.getDay());
  const t = today();
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = ymd(d);
    if (i >= 35 && d.getMonth() !== m.getMonth()) break;
    const evs = state.events.filter((e) => e.date === key).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
    const en = state.entries[key];
    const hasDiary = en && (en.text?.trim() || en.answers?.some(Boolean));
    const cls = ["day", d.getMonth() !== m.getMonth() && "other", key === t && "today", key === state.selectedDay && "selected"].filter(Boolean).join(" ");
    const cell = el("button", { class: cls, type: "button", onclick: () => { state.selectedDay = key; renderCalendar(); } },
      el("span", { class: "num" }, String(d.getDate()), hasDiary ? el("span", { class: "mark", title: "일기 있음" }, en.mood || "📝") : null),
      evs.slice(0, 2).map((e) => el("span", { class: "ev", title: e.title }, (e.time ? e.time + " " : "") + e.title)),
      evs.length > 2 ? el("span", { class: "more" }, `+${evs.length - 2}`) : null,
    );
    grid.append(cell);
  }
  renderDayPanel();
}

function googleLink(e) {
  const compact = (s) => s.replaceAll("-", "").replaceAll(":", "");
  let dates;
  if (e.time) {
    const end = e.endTime || addHour(e.time);
    dates = `${compact(e.date)}T${compact(e.time)}00/${compact(e.date)}T${compact(end)}00`;
  } else {
    dates = `${compact(e.date)}/${compact(addDays(e.date, 1))}`;
  }
  const p = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, details: e.note || "" });
  return `https://calendar.google.com/calendar/render?${p}`;
}
function addHour(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function renderDayPanel() {
  const key = state.selectedDay;
  $("#dayLabel").textContent = prettyDate(key);
  $("#evDate").value = key;
  const ul = $("#dayEvents");
  ul.replaceChildren();
  const evs = state.events.filter((e) => e.date === key).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  if (!evs.length) ul.append(el("li", { class: "meta" }, "등록된 일정이 없어요."));
  for (const e of evs) {
    const time = e.time ? `${e.time}${e.endTime ? "–" + e.endTime : ""}` : "종일";
    const src = { chat: "대화에서", diary: "일기에서", manual: "직접 추가" }[e.source] || "";
    ul.append(el("li", {},
      el("div", { class: "t" }, e.title),
      el("div", { class: "meta" }, `${time} · ${src}`),
      e.note ? el("div", { class: "meta" }, e.note) : null,
      el("div", { class: "acts" },
        el("a", { href: googleLink(e), target: "_blank", rel: "noopener" }, "구글 캘린더에 추가"),
        el("button", { type: "button", onclick: () => downloadIcs([e], `${e.date}-${e.title}.ics`) }, ".ics"),
        el("button", { type: "button", onclick: () => { if (confirm(`'${e.title}' 일정을 삭제할까요?`)) { removeEvent(e.id); renderCalendar(); } } }, "삭제"),
      ),
    ));
  }
}

$("#prevMonth").addEventListener("click", () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); });
$("#nextMonth").addEventListener("click", () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); });
$("#thisMonth").addEventListener("click", () => { state.calMonth = firstOfMonth(new Date()); state.selectedDay = today(); renderCalendar(); });
$("#openDayDiary").addEventListener("click", () => {
  state.diaryDate = state.selectedDay > today() ? today() : state.selectedDay;
  showTab("diary");
});
$("#eventForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const added = addEvents([{
    title: $("#evTitle").value, date: $("#evDate").value, time: $("#evTime").value,
    end_time: $("#evEnd").value, note: $("#evNote").value,
  }], "manual");
  if (!added.length) { toast("같은 날 같은 제목의 일정이 이미 있어요."); return; }
  state.selectedDay = added[0].date;
  const d = parseYmd(added[0].date);
  state.calMonth = firstOfMonth(d);
  ["#evTitle", "#evTime", "#evEnd", "#evNote"].forEach((s) => ($(s).value = ""));
  renderCalendar();
  toast("일정을 추가했어요.");
});

/* ───────────── .ics 내보내기 ───────────── */
function icsEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1"); }
function toIcs(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haru Diary//KO", "CALSCALE:GREGORIAN"];
  for (const e of events) {
    const d = e.date.replaceAll("-", "");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@haru-diary`, `DTSTAMP:${stamp}`);
    if (e.time) {
      lines.push(`DTSTART:${d}T${e.time.replace(":", "")}00`, `DTEND:${d}T${(e.endTime || addHour(e.time)).replace(":", "")}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(e.date, 1).replaceAll("-", "")}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.note) lines.push(`DESCRIPTION:${icsEscape(e.note)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadIcs(events, filename) { download(toIcs(events), filename, "text/calendar"); }
$("#exportIcs").addEventListener("click", () => {
  if (!state.events.length) { toast("내보낼 일정이 없어요."); return; }
  downloadIcs(state.events, `haru-diary-${today()}.ics`);
});

/* ───────────── 설정 & 백업 ───────────── */
function openSettings() {
  $("#apiKey").value = state.settings.apiKey;
  $("#model").value = state.settings.model;
  $("#autoAdd").checked = state.settings.autoAdd;
  if (!$("#settingsDialog").open) $("#settingsDialog").showModal();
}
$("#openSettings").addEventListener("click", openSettings);
$("#settingsDialog").addEventListener("close", () => {
  if ($("#settingsDialog").returnValue !== "save") return;
  const hadKey = !!state.settings.apiKey;
  state.settings.apiKey = $("#apiKey").value.trim();
  state.settings.model = $("#model").value;
  state.settings.autoAdd = $("#autoAdd").checked;
  save.settings();
  toast("설정을 저장했어요.");
  if (!hadKey && state.settings.apiKey && state.diaryDate === today()) renderDiary();
});
$("#exportJson").addEventListener("click", () => {
  const data = { version: 1, exportedAt: new Date().toISOString(), entries: state.entries, chats: state.chats, events: state.events };
  download(JSON.stringify(data, null, 2), `haru-diary-backup-${today()}.json`, "application/json");
});
$("#importJson").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.entries || !data.events) throw new Error("백업 파일 형식이 아니에요.");
    if (!confirm("백업을 불러오면 지금 브라우저의 기록과 합쳐집니다 (같은 날짜는 백업 내용으로 덮어씀). 계속할까요?")) return;
    Object.assign(state.entries, data.entries);
    Object.assign(state.chats, data.chats || {});
    const ids = new Set(state.events.map((e) => e.id));
    state.events.push(...data.events.filter((e) => !ids.has(e.id)));
    save.entries(); save.chats(); save.events();
    renderDiary();
    toast("백업을 불러왔어요.");
  } catch (err) {
    toast("불러오기 실패: " + err.message);
  }
});

/* ───────────── 시작 ───────────── */
renderDiary();
if (!state.settings.apiKey) setTimeout(() => toast("⚙️ 설정에서 Claude API 키를 입력하면 AI 기능을 쓸 수 있어요."), 600);
