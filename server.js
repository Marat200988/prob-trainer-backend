import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || "*",
  })
);

// === helpers ===============================================================

const DS_MODEL = process.env.DS_MODEL || "deepseek-chat"; // быстрее, чем reasoner
const DS_API_KEY = process.env.DEEPSEEK_API_KEY;

const toText = (v) => {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    const cand =
      v.text ?? v.label ?? v.value ?? v.content ?? v.title ?? v.name;
    return typeof cand === "string" || typeof cand === "number"
      ? String(cand)
      : JSON.stringify(v);
  }
  return String(v ?? "");
};

function normalizeQuestion(q) {
  const letters = ["A","B","C","D","E","F","G","H","I"];

  // options: массив/словарь → [{key,text}]
  let options = [];
  if (Array.isArray(q.options)) {
    options = q.options.map((o, i) => {
      if (o && typeof o === "object") {
        const key = o.key ?? o.id ?? letters[i] ?? String(i + 1);
        return { key: String(key), text: toText(o.text ?? o) };
      }
      return { key: letters[i] ?? String(i + 1), text: toText(o) };
    });
  } else if (q.options && typeof q.options === "object") {
    options = Object.entries(q.options).map(([k, v]) => ({
      key: String(k),
      text: toText(v),
    }));
  }

  return {
    id: q.id ?? q.qid ?? crypto.randomUUID(),
    section_id: q.section_id ?? q.section ?? "",
    title: toText(q.title ?? ""),
    question: toText(q.question ?? ""),
    content_md: toText(q.content_md ?? q.content ?? ""),
    type: q.type ?? "mcq",
    options,
    answer:
      typeof q.answer === "string" ? q.answer : toText(q.answer ?? ""),
    explanation_md: toText(q.explanation_md ?? q.explanation ?? ""),
  };
}

// очень простой in-memory cache
const CACHE = {
  questions: [],
  at: 0,
};

// === endpoints =============================================================

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/gen-questions", async (req, res) => {
  try {
    const { sections = [], count = 6, language = "ru" } = req.body || {};
    console.log("INFO: gen-questions body:", JSON.stringify({ sections, count }));

    const sys = [
      "Ты – генератор тренировочных задач по вероятности.",
      "Отвечай СТРОГО JSON по примеру ниже, без лишнего текста, без комментариев и добавления что-то ещё.",
      "Схема ответа:",
      "{",
      '  "questions": [',
      "    {",
      '      "id": "q1",',
      '      "section_id": "bayes",',
      '      "title": "Короткий заголовок",',
      '      "question": "Формулировка задачи",',
      '      "content_md": "Доп. контент (может быть пустым)",',
      '      "type": "mcq",',
      '      "options": { "A": "вариант", "B": "вариант", "C": "вариант", "D": "вариант" },',
      '      "answer": "A",',
      '      "explanation_md": "Краткое объяснение"',
      "    }",
      "  ]",
      "}",
      "Все значения — строки. !Отвечай строго по примеру!",
    ].join("\n");

    const user = [
      `Язык: ${language}.`,
      `Нужно сгенерировать ${count} вопросов. Разделы:`,
      JSON.stringify(sections),
      "Темы — базовые вероятности, Байес, матожидание, хвостовые риски, интуитивные ловушки.",
    ].join("\n");

    const dsResp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DS_API_KEY}`,
      },
      body: JSON.stringify({
        model: DS_MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 0.4,
      }),
    });

    console.log("INFO: DeepSeek status =", dsResp.status);
    const text = await dsResp.text();
    console.log("INFO: DeepSeek raw body (head) =", text.slice(0, 500));

    if (!dsResp.ok) {
      return res.status(502).json({ error: "DeepSeek error", body: text });
    }

    // иногда модель оборачивает JSON в ```json ... ```
    const match = text.match(/```json\s*([\s\S]*?)```/i);
    const jsonText = match ? match[1] : text;

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({ error: "JSON parse fail", body: text });
    }

    const questions = Array.isArray(data?.questions) ? data.questions : [];
    const normalized = questions.map(normalizeQuestion);

    CACHE.questions = normalized;
    CACHE.at = Date.now();

    console.log("DEBUG: cached", normalized.length, "questions");
    res.json(normalized);
  } catch (err) {
    console.error("ERROR /gen-questions:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/check-answer", async (req, res) => {
  try {
    const { qid, userAnswer, confidence } = req.body || {};
    const q = CACHE.questions.find((x) => x.id === qid);
    if (!q) return res.status(404).json({ error: "question not found" });

    const correct = String(userAnswer).trim() === String(q.answer).trim();

    // опционально считаем Brier, если фронт передал confidence [0..1]
    let brier = undefined;
    if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
      const p = confidence;
      const y = correct ? 1 : 0;
      brier = (p - y) * (p - y);
    }

    res.json({
      correct,
      correctAnswer: q.answer,
      brier,
      explanation_md: q.explanation_md || "",
    });
  } catch (err) {
    console.error("ERROR /check-answer:", err);
    res.status(500).json({ error: String(err) });
  }
});

// === start ================================================================

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server listening on port", port);
  console.log("Model:", DS_MODEL);
});
