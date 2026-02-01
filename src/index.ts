import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

interface Env {
  DB: D1Database;
  AI: Ai;
  WORKFLOW: Workflow;
}

interface FeedbackPayload {
  text: string;
}

// --- Workflow ---

export class FeedbackAnalysisWorkflow extends WorkflowEntrypoint<Env, FeedbackPayload> {
  async run(event: WorkflowEvent<FeedbackPayload>, step: WorkflowStep) {
    const { text } = event.payload;

    const category = await step.do("categorize", async () => {
      const res = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "Categorize the following user feedback into exactly one of: Bugs, Feature Requests, Billing. Respond with ONLY the category name.",
          },
          { role: "user", content: text },
        ],
      });
      const raw = (res as { response?: string }).response?.trim() ?? "Bugs";
      const valid = ["Bugs", "Feature Requests", "Billing"];
      return valid.includes(raw) ? raw : "Bugs";
    });

    const sentiment = await step.do("sentiment", async () => {
      const res = await this.env.AI.run(
        "@cf/huggingface/distilbert-sst-2-int8",
        { text }
      );

      let scores: { label: string; score: number }[] = [];
      if (Array.isArray(res)) {
        scores = res as { label: string; score: number }[];
      } else if ((res as any).result) {
        scores = (res as any).result;
      }

      const positive = scores.find((r) => r.label === "POSITIVE");
      const negative = scores.find((r) => r.label === "NEGATIVE");
      if (positive) return positive.score;
      if (negative) return 1 - negative.score;
      return 0.5;
    });

    await step.do("persist", async () => {
      await this.env.DB.prepare(
        "INSERT INTO feedback (raw_text, category, sentiment) VALUES (?, ?, ?)"
      )
        .bind(text, category, sentiment)
        .run();
    });
  }
}

// --- Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Ingest endpoint
    if (url.pathname === "/api/feedback" && request.method === "POST") {
      let body: FeedbackPayload;
      try {
        body = await request.json<FeedbackPayload>();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (!body.text || typeof body.text !== "string") {
        return Response.json({ error: "Missing 'text' field" }, { status: 400 });
      }
      await env.WORKFLOW.create({ params: { text: body.text } });
      return Response.json({ accepted: true }, { status: 202 });
    }

    // Dashboard endpoint
    if (url.pathname === "/" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, raw_text, category, sentiment, created_at FROM feedback ORDER BY id DESC LIMIT 50"
      ).all<{ id: number; raw_text: string; category: string; sentiment: number; created_at: string }>();

      const total = results.length;
      const urgent = results.filter(r => r.sentiment < 0.3).length;
      const bugs = results.filter(r => r.category === "Bugs").length;

      const rows = results
        .map((r) => {
          const isUrgent = r.sentiment < 0.3;
          const urgencyClass = isUrgent ? "urgent-row" : "";
          const badgeClass = isUrgent ? "badge-critical" : "badge-normal";
          const badgeText = isUrgent ? "CRITICAL" : "Normal";

          return `<tr class="${urgencyClass}">
            <td>#${r.id}</td>
            <td class="text-cell">${esc(r.raw_text)}</td>
            <td><span class="tag">${esc(r.category)}</span></td>
            <td><span class="badge ${badgeClass}">${badgeText} (${r.sentiment.toFixed(2)})</span></td>
            <td class="time">${esc(r.created_at)}</td>
          </tr>`;
        })
        .join("\n");

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PulsePoint AI</title>
<style>
  :root { --bg: #0f1117; --card: #1f2937; --text: #f3f4f6; --accent: #f59e0b; --danger: #ef4444; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, 'Segoe UI', sans-serif; padding: 40px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 30px; }
  .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 40px; }
  .stat-card { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid #374151; }
  .stat-value { font-size: 32px; font-weight: 700; margin-top: 10px; }
  .stat-label { color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .danger-text { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; }
  th { background: #111827; padding: 16px; text-align: left; font-size: 12px; text-transform: uppercase; color: #9ca3af; }
  td { padding: 16px; border-bottom: 1px solid #374151; font-size: 14px; }
  .urgent-row { background: rgba(239, 68, 68, 0.1); }
  .badge { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge-critical { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
  .badge-normal { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
  .tag { background: #374151; padding: 4px 10px; border-radius: 99px; font-size: 12px; }
  .text-cell { max-width: 450px; }
  button { background: var(--accent); color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: 600; }
</style>
</head><body>
<div class="header">
  <h1>PulsePoint AI</h1>
  <button onclick="window.location.reload()">Refresh Data</button>
</div>
<div class="stats-grid">
  <div class="stat-card"><div class="stat-label">Total Volume</div><div class="stat-value">${total}</div></div>
  <div class="stat-card" style="border-bottom: 4px solid var(--danger)"><div class="stat-label danger-text">Critical Incidents</div><div class="stat-value danger-text">${urgent}</div></div>
  <div class="stat-card"><div class="stat-label">Bug Reports</div><div class="stat-value">${bugs}</div></div>
</div>
<table><thead><tr><th>ID</th><th>Content</th><th>Category</th><th>Sentiment</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

function esc(s: string): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
