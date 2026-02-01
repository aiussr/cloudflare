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
      const positive = (res as { result?: { label: string; score: number }[] })
        .result?.find((r) => r.label === "POSITIVE");
      return positive ? positive.score : 0.5;
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

    // Presentation endpoint
    if (url.pathname === "/" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, raw_text, category, sentiment, created_at FROM feedback ORDER BY id DESC LIMIT 20"
      ).all<{ id: number; raw_text: string; category: string; sentiment: number; created_at: string }>();

      const rows = results
        .map((r) => {
          const style = r.sentiment < 0.3 ? ' style="background:red;color:white"' : "";
          return `<tr${style}><td>${r.id}</td><td>${esc(r.raw_text)}</td><td>${esc(r.category)}</td><td>${r.sentiment.toFixed(2)}</td><td>${esc(r.created_at)}</td></tr>`;
        })
        .join("\n");

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PulsePoint Feedback</title>
<style>table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}</style>
</head><body>
<h1>PulsePoint Feedback</h1>
<table><thead><tr><th>ID</th><th>Text</th><th>Category</th><th>Sentiment</th><th>Created</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;

      return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
