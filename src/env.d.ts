// Type declarations for Cloudflare Workers environment bindings

interface Env {
  AI: Ai;
  CHAT_SESSION: DurableObjectNamespace;
  DB: D1Database;
  VECTORIZE: Vectorize;
  SCRAPER_WORKFLOW: Workflow;
}
