# Probability Trainer — Backend (DeepSeek)
Endpoints:
- POST /gen-questions  { sections: [{id,title}], count } -> {questions: [...]}
- POST /check-answer   { question, userAnswer } -> { correct, explanation }

Env:
- DEEPSEEK_API_KEY  (обязательно)
- ALLOW_ORIGIN      (URL фронтенда для CORS)
- PORT              (Render выставит сам)

Start: `node server.js`
