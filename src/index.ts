import { ChatSession } from './chatSession';
import { storeFact, clearFacts, listFacts, deleteFact, storeDocument } from './vectorStore';
import { LinkScraperWorkflow } from './scraperWorkflow';

export { ChatSession, LinkScraperWorkflow };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve the chat UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    // ── Chats List API (D1) ──────────────────────────────────────
    if (url.pathname === '/api/chats') {
      if (request.method === 'GET') {
        try {
          const { results } = await env.DB.prepare('SELECT id, title, created_at AS createdAt FROM chats ORDER BY created_at DESC').all();
          return Response.json({ chats: results });
        } catch (err: any) {
          // Auto-migrate tables if they don't exist (useful for local dev state mismatch)
          if (err?.message?.includes('no such table')) {
            try {
              await env.DB.batch([
                env.DB.prepare("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, context_template TEXT, instruct_mode TEXT, created_at INTEGER NOT NULL)"),
                env.DB.prepare("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)")
              ]);
              return Response.json({ chats: [] });
            } catch (initErr) {
              console.error('Failed to auto-init schema:', initErr);
            }
          }
          return Response.json({ error: 'Failed to list chats', detail: err?.message }, { status: 500 });
        }
      }

      if (request.method === 'POST') {
        const { id, title } = await request.json() as { id: string; title: string };
        try {
          await env.DB.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
            .bind(id, title, Date.now())
            .run();
          return Response.json({ ok: true });
        } catch (err: any) {
          return Response.json({ error: 'Failed to create chat', detail: err?.message }, { status: 500 });
        }
      }

      if (request.method === 'PATCH') {
        const { id, title } = await request.json() as { id: string; title: string };
        try {
          await env.DB.prepare('UPDATE chats SET title = ? WHERE id = ?')
            .bind(title, id)
            .run();
          return Response.json({ ok: true });
        } catch (err: any) {
          return Response.json({ error: 'Failed to update chat', detail: err?.message }, { status: 500 });
        }
      }

      if (request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });
        try {
          await env.DB.prepare('DELETE FROM chats WHERE id = ?').bind(id).run();

          // Also clear DO session to drop memory
          const doId = env.CHAT_SESSION.idFromName(id);
          const stub = env.CHAT_SESSION.get(doId);
          await stub.fetch(new Request('https://internal/clear', { method: 'POST' }));

          return Response.json({ ok: true });
        } catch (err: any) {
          return Response.json({ error: 'Failed to delete chat', detail: err?.message }, { status: 500 });
        }
      }
    }

    // Chat API endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const { message, sessionId } = await request.json() as { message: string; sessionId: string };

      if (!message || !sessionId) {
        return Response.json({ error: 'Missing message or sessionId' }, { status: 400 });
      }

      // Route to a Durable Object instance per session
      const id = env.CHAT_SESSION.idFromName(sessionId);
      const stub = env.CHAT_SESSION.get(id);

      const doRequest = new Request('https://internal/chat', {
        method: 'POST',
        body: JSON.stringify({ message }),
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
      });

      return stub.fetch(doRequest);
    }

    // Clear session history
    if (url.pathname === '/api/clear' && request.method === 'POST') {
      const { sessionId } = await request.json() as { sessionId: string };
      const id = env.CHAT_SESSION.idFromName(sessionId);
      const stub = env.CHAT_SESSION.get(id);

      const doRequest = new Request('https://internal/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
      });

      return stub.fetch(doRequest);
    }

    // ── Settings API ──────────────────────────────────────────────
    // GET /api/settings — get per-chat context template & instruct mode
    if (url.pathname === '/api/settings' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return Response.json({ error: 'Missing sessionId' }, { status: 400 });
      }
      const id = env.CHAT_SESSION.idFromName(sessionId);
      const stub = env.CHAT_SESSION.get(id);
      return stub.fetch(new Request('https://internal/settings', {
        method: 'GET',
        headers: { 'x-session-id': sessionId }
      }));
    }

    // POST /api/settings — update per-chat context template & instruct mode
    if (url.pathname === '/api/settings' && request.method === 'POST') {
      const body = await request.json() as { sessionId: string; contextTemplate?: string; instructMode?: string };
      if (!body.sessionId) {
        return Response.json({ error: 'Missing sessionId' }, { status: 400 });
      }
      const id = env.CHAT_SESSION.idFromName(body.sessionId);
      const stub = env.CHAT_SESSION.get(id);
      return stub.fetch(new Request('https://internal/settings', {
        method: 'POST',
        body: JSON.stringify({ contextTemplate: body.contextTemplate, instructMode: body.instructMode }),
        headers: { 'Content-Type': 'application/json', 'x-session-id': body.sessionId },
      }));
    }

    // ── Facts API ────────────────────────────────────────────────
    // GET /api/facts — list all stored facts
    if (url.pathname === '/api/facts' && request.method === 'GET') {
      try {
        const facts = await listFacts(env.VECTORIZE);
        return Response.json({ facts });
      } catch (err: any) {
        return Response.json({ error: 'Failed to list facts', detail: err?.message }, { status: 500 });
      }
    }

    // POST /api/facts — store a new fact in the vector DB
    if (url.pathname === '/api/facts' && request.method === 'POST') {
      const { fact } = await request.json() as { fact: string };
      if (!fact || !fact.trim()) {
        return Response.json({ error: 'Missing fact' }, { status: 400 });
      }

      try {
        const factId = 'fact-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await storeFact(env.VECTORIZE, env.AI, factId, fact.trim());
        return Response.json({ ok: true, factId });
      } catch (err: any) {
        console.error('Failed to store fact:', err);
        return Response.json({ error: 'Failed to store fact', detail: err?.message }, { status: 500 });
      }
    }

    // DELETE /api/facts — clear all OR delete single fact
    if (url.pathname === '/api/facts' && request.method === 'DELETE') {
      const factId = url.searchParams.get('id');
      try {
        if (factId) {
          await deleteFact(env.VECTORIZE, factId);
        } else {
          await clearFacts(env.VECTORIZE);
        }
        return Response.json({ ok: true });
      } catch (err: any) {
        console.error('Failed to delete fact(s):', err);
        return Response.json({ error: 'Failed to delete fact(s)', detail: err?.message }, { status: 500 });
      }
    }

    // POST /api/upload — upload file text
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      const { text, filename, sessionId } = await request.json() as { text: string; filename: string; sessionId: string };
      if (!text || !filename || !sessionId) {
        return Response.json({ error: 'Missing required fields' }, { status: 400 });
      }

      try {
        await storeDocument(env.VECTORIZE, env.AI, sessionId, filename, text);
        return Response.json({ ok: true });
      } catch (err: any) {
        console.error('Failed to store document:', err);
        return Response.json({ error: 'Failed to process document', detail: err?.message }, { status: 500 });
      }
    }

    // POST /api/scrape — trigger workflow for scraping links
    if (url.pathname === '/api/scrape' && request.method === 'POST') {
      const { urls, sessionId } = await request.json() as { urls: string[]; sessionId: string };
      if (!urls || urls.length === 0 || !sessionId) {
        return Response.json({ error: 'Missing required fields' }, { status: 400 });
      }

      try {
        for (const targetUrl of urls) {
          await env.SCRAPER_WORKFLOW.create({
            params: { url: targetUrl, sessionId }
          });
        }
        return Response.json({ ok: true });
      } catch (err: any) {
        console.error('Failed to trigger workflow:', err);
        return Response.json({ error: 'Failed to process URLs', detail: err?.message }, { status: 500 });
      }
    }

    // ── History API ───────────────────────────────────────────────
    // GET /api/history?sessionId=... — return stored messages for a session
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return Response.json({ error: 'Missing sessionId' }, { status: 400 });
      try {
        const { results } = await env.DB.prepare(
          'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC'
        ).bind(sessionId).all();
        return Response.json({ messages: results || [] });
      } catch (err: any) {
        return Response.json({ error: 'Failed to load history', detail: err?.message }, { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>AI Chat — Powered by Cloudflare Workers AI</title>
  <meta name="description" content="AI-powered chat application using Llama 3.3 on Cloudflare Workers AI with persistent memory via Durable Objects." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-tertiary: #1a1a28;
      --bg-glass: rgba(18, 18, 26, 0.7);
      --border: rgba(255, 255, 255, 0.06);
      --border-hover: rgba(255, 255, 255, 0.12);
      --text-primary: #e8e8f0;
      --text-secondary: #8888a0;
      --text-muted: #55556a;
      --accent: #f6821f;
      --accent-glow: rgba(246, 130, 31, 0.15);
      --accent-dark: #c86800;
      --user-bubble: rgba(99, 102, 241, 0.12);
      --user-border: rgba(99, 102, 241, 0.2);
      --user-text: #c7c8ff;
      --assistant-bubble: rgba(255, 255, 255, 0.03);
      --assistant-border: rgba(255, 255, 255, 0.06);
      --code-bg: rgba(0, 0, 0, 0.4);
      --radius: 16px;
      --radius-sm: 10px;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      height: 100dvh;
      display: flex;
      flex-direction: row;
      overflow: hidden;
    }

    /* ── App layout ──────────────────────────────────────────── */
    .app-wrapper {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .main-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      overflow: hidden;
      min-width: 0;
    }

    /* ── Sidebar ─────────────────────────────────────────────── */
    .sidebar {
      width: 280px;
      min-width: 280px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      z-index: 10;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .new-chat-btn {
      width: 100%;
      padding: 10px 16px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      border: none;
      border-radius: var(--radius-sm);
      color: white;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.25s ease;
      box-shadow: 0 2px 12px rgba(246, 130, 31, 0.2);
    }
    .new-chat-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(246, 130, 31, 0.35);
    }

    .chat-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .chat-list::-webkit-scrollbar { width: 4px; }
    .chat-list::-webkit-scrollbar-track { background: transparent; }
    .chat-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
    }

    .chat-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
      transition: all 0.2s ease;
      position: relative;
      border: 1px solid transparent;
    }
    .chat-item:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }
    .chat-item.active {
      background: var(--accent-glow);
      border-color: rgba(246, 130, 31, 0.2);
      color: var(--accent);
    }

    .chat-item-icon { flex-shrink: 0; font-size: 14px; }

    .chat-item-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-item-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .chat-item:hover .chat-item-actions { opacity: 1; }

    .chat-action-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      font-size: 12px;
      transition: all 0.2s ease;
      line-height: 1;
    }
    .chat-action-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
    }
    .chat-action-btn.delete:hover { color: #ef4444; }

    .sidebar-toggle {
      display: none;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 16px;
      transition: all 0.25s ease;
      line-height: 1;
    }
    .sidebar-toggle:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 9;
    }

    @media (max-width: 768px) {
      .sidebar {
        position: fixed;
        left: 0; top: 0; bottom: 0;
        transform: translateX(-100%);
      }
      .sidebar.open { transform: translateX(0); }
      .sidebar-toggle { display: block; }
      .sidebar-overlay.open { display: block; }
    }

    /* ── Ambient background glow ─────────────────────────────── */
    .main-area::before {
      content: '';
      position: fixed;
      top: -40%; left: -20%;
      width: 60%; height: 80%;
      background: radial-gradient(ellipse, rgba(246, 130, 31, 0.04) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    .main-area::after {
      content: '';
      position: fixed;
      bottom: -30%; right: -20%;
      width: 50%; height: 70%;
      background: radial-gradient(ellipse, rgba(99, 102, 241, 0.03) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    /* ── Header ──────────────────────────────────────────────── */
    header {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 820px;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      background: var(--bg-glass);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 600;
      font-size: 1rem;
      letter-spacing: -0.01em;
    }

    .logo-icon {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #f6821f 0%, #e06000 100%);
      border-radius: var(--radius-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 17px;
      box-shadow: 0 4px 16px rgba(246, 130, 31, 0.25);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .logo-icon:hover {
      transform: scale(1.05) rotate(-2deg);
      box-shadow: 0 6px 24px rgba(246, 130, 31, 0.35);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .badge {
      font-size: 11px;
      font-weight: 500;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 20px;
      color: var(--text-secondary);
      letter-spacing: 0.02em;
    }

    #clear-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 7px 16px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      font-weight: 500;
      transition: all 0.25s ease;
      letter-spacing: 0.01em;
    }
    #clear-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-glow);
      box-shadow: 0 0 20px rgba(246, 130, 31, 0.1);
    }

    /* ── Chat Container ──────────────────────────────────────── */
    #chat-container {
      position: relative;
      z-index: 1;
      flex: 1;
      width: 100%;
      max-width: 820px;
      overflow-y: auto;
      padding: 28px 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      scroll-behavior: smooth;
    }

    #chat-container::-webkit-scrollbar { width: 4px; }
    #chat-container::-webkit-scrollbar-track { background: transparent; }
    #chat-container::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
    }
    #chat-container::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    /* ── Messages ─────────────────────────────────────────────── */
    .message {
      display: flex;
      gap: 14px;
      animation: fadeSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes fadeSlideIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: none; }
    }

    .message.user { flex-direction: row-reverse; }

    .avatar {
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; flex-shrink: 0;
      border: 1px solid var(--border);
      transition: transform 0.2s ease;
    }
    .message:hover .avatar { transform: scale(1.05); }

    .message.user .avatar {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(99, 102, 241, 0.05));
    }
    .message.assistant .avatar {
      background: linear-gradient(135deg, rgba(246, 130, 31, 0.15), rgba(246, 130, 31, 0.05));
    }

    .bubble {
      max-width: 75%;
      padding: 14px 18px;
      border-radius: var(--radius);
      line-height: 1.7;
      font-size: 14px;
      letter-spacing: 0.01em;
      transition: background 0.2s ease;
    }

    .message.user .bubble {
      background: var(--user-bubble);
      border: 1px solid var(--user-border);
      border-bottom-right-radius: 4px;
      color: var(--user-text);
    }

    .message.assistant .bubble {
      background: var(--assistant-bubble);
      border: 1px solid var(--assistant-border);
      border-bottom-left-radius: 4px;
    }

    .bubble p { margin-bottom: 10px; }
    .bubble p:last-child { margin-bottom: 0; }
    .bubble code {
      background: var(--code-bg);
      padding: 2px 7px;
      border-radius: 5px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12.5px;
      border: 1px solid var(--border);
    }
    .bubble pre {
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--border);
      padding: 14px;
      border-radius: var(--radius-sm);
      overflow-x: auto;
      margin: 10px 0;
    }
    .bubble pre code {
      background: none;
      padding: 0;
      border: none;
      font-size: 12.5px;
    }
    .bubble ul, .bubble ol { padding-left: 20px; margin: 8px 0; }
    .bubble li { margin-bottom: 4px; }

    /* ── Typing indicator ──────────────────────────────────────── */
    .typing-indicator {
      display: flex; gap: 5px; align-items: center; padding: 6px 0;
    }
    .dot {
      width: 7px; height: 7px;
      background: var(--text-muted);
      border-radius: 50%;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse {
      0%, 80%, 100% { transform: scale(0.8); opacity: 0.4; }
      40% { transform: scale(1.2); opacity: 1; }
    }

    /* ── Empty state ──────────────────────────────────────────── */
    .empty-state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px;
      text-align: center;
      animation: fadeSlideIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .empty-state .big-icon {
      font-size: 56px;
      filter: drop-shadow(0 4px 20px rgba(246, 130, 31, 0.2));
    }
    .empty-state h2 {
      font-size: 1.3rem;
      color: var(--text-primary);
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .empty-state p {
      font-size: 13px;
      max-width: 340px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .suggestion-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-top: 8px;
      max-width: 500px;
    }
    .chip {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.25s ease;
    }
    .chip:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-glow);
      transform: translateY(-1px);
    }

    /* ── Input area ─────────────────────────────────────────────── */
    .input-wrapper {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 820px;
      padding: 0 24px 24px;
    }

    .memory-bar {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
      padding-bottom: 10px;
      letter-spacing: 0.02em;
    }
    .memory-bar span { color: var(--text-secondary); }

    .file-upload-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 20px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    .file-upload-btn:hover {
      color: var(--text-primary);
      transform: scale(1.05);
    }

    form {
      display: flex;
      gap: 10px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px 8px 8px 18px;
      transition: border-color 0.25s ease, box-shadow 0.25s ease;
    }
    form:focus-within {
      border-color: rgba(246, 130, 31, 0.3);
      box-shadow: 0 0 0 3px rgba(246, 130, 31, 0.06), 0 4px 24px rgba(0, 0, 0, 0.2);
    }

    #input {
      flex: 1;
      background: transparent;
      border: none;
      padding: 8px 0;
      color: var(--text-primary);
      font-size: 14px;
      resize: none;
      outline: none;
      max-height: 120px;
      font-family: inherit;
      line-height: 1.5;
    }
    #input::placeholder { color: var(--text-muted); }

    #send-btn {
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      border: none;
      border-radius: var(--radius-sm);
      padding: 0 18px;
      color: white;
      font-size: 18px;
      cursor: pointer;
      transition: all 0.25s ease;
      align-self: flex-end;
      height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 12px rgba(246, 130, 31, 0.2);
    }
    #send-btn:hover {
      transform: scale(1.03);
      box-shadow: 0 4px 20px rgba(246, 130, 31, 0.35);
    }
    #send-btn:active { transform: scale(0.97); }
    #send-btn:disabled {
      background: var(--bg-tertiary);
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
    }

    /* ── Responsive ────────────────────────────────────────────── */
    @media (max-width: 640px) {
      header { padding: 14px 16px; }
      #chat-container { padding: 20px 16px; }
      .input-wrapper { padding: 0 16px 16px; }
      .bubble { max-width: 85%; font-size: 13.5px; }
      .badge { display: none; }
    }

    /* ── Facts modal ──────────────────────────────────────────── */
    #facts-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 7px 16px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      font-weight: 500;
      transition: all 0.25s ease;
      letter-spacing: 0.01em;
    }
    #facts-btn:hover {
      border-color: #10b981;
      color: #10b981;
      background: rgba(16, 185, 129, 0.08);
      box-shadow: 0 0 20px rgba(16, 185, 129, 0.1);
    }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: 90%;
      max-width: 520px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
      animation: fadeSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .modal-header {
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-header h3 {
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: all 0.2s ease;
    }
    .modal-close:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
    }

    .modal-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
    }

    .fact-input-group {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .fact-input-group textarea {
      flex: 1;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 60px;
      line-height: 1.5;
      transition: border-color 0.2s ease;
    }
    .fact-input-group textarea:focus {
      border-color: rgba(16, 185, 129, 0.4);
    }
    .fact-input-group textarea::placeholder { color: var(--text-muted); }

    .add-fact-btn {
      align-self: flex-end;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      border: none;
      border-radius: var(--radius-sm);
      padding: 0 18px;
      color: white;
      font-size: 13px;
      font-family: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.25s ease;
      white-space: nowrap;
      box-shadow: 0 2px 12px rgba(16, 185, 129, 0.2);
    }
    .add-fact-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.35);
    }
    .add-fact-btn:disabled {
      background: var(--bg-tertiary);
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
    }

    .facts-info {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: rgba(16, 185, 129, 0.05);
      border: 1px solid rgba(16, 185, 129, 0.1);
      border-radius: var(--radius-sm);
    }

    .fact-status {
      text-align: center;
      font-size: 12px;
      padding: 8px;
      border-radius: var(--radius-sm);
      margin-top: 8px;
      animation: fadeSlideIn 0.3s ease;
    }
    .fact-status.success {
      color: #10b981;
      background: rgba(16, 185, 129, 0.08);
    }
    .fact-status.error {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.08);
    }

    .modal-footer {
      padding: 14px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
    }
    .clear-facts-btn {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 7px 16px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      font-weight: 500;
      transition: all 0.25s ease;
    }
    .clear-facts-btn:hover {
      background: rgba(239, 68, 68, 0.08);
      border-color: #ef4444;
    }

    /* ── Fact items ─────────────────────────────────────────── */
    .facts-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 12px;
    }
    .facts-list-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .fact-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      animation: fadeSlideIn 0.3s ease;
    }
    .fact-item-content {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.5;
      word-break: break-word;
    }
    .fact-item-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .fact-action {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 12px;
      transition: all 0.2s ease;
      line-height: 1;
    }
    .fact-action:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
    }
    .fact-action.delete:hover { color: #ef4444; }
    .fact-action.edit:hover { color: #10b981; }
    .facts-empty {
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      padding: 16px;
    }
    .facts-loading {
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      padding: 16px;
    }

    /* ── Right Panel (Settings) ───────────────────────────────── */
    .right-panel {
      position: fixed;
      right: 0;
      top: 0;
      bottom: 0;
      width: 340px;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      z-index: 50;
      transform: translateX(calc(100% - 24px));
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease;
      display: flex;
    }
    .right-panel:hover {
      transform: translateX(0);
      box-shadow: -8px 0 40px rgba(0, 0, 0, 0.5);
    }
    .right-panel-handle {
      width: 24px;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-tertiary);
      border-right: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      cursor: pointer;
    }
    .right-panel-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 24px 20px;
      overflow-y: auto;
      background: var(--bg-secondary);
    }

    .settings-field { margin-bottom: 18px; }
    .settings-field:last-child { margin-bottom: 0; }
    .settings-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }
    .settings-label-sub {
      display: block;
      font-size: 11px;
      font-weight: 400;
      text-transform: none;
      letter-spacing: normal;
      color: var(--text-muted);
      margin-top: 4px;
      line-height: 1.5;
    }
    .settings-textarea {
      width: 100%;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
      outline: none;
      min-height: 80px;
      line-height: 1.5;
      transition: border-color 0.2s ease;
    }
    .settings-textarea:focus {
      border-color: rgba(139, 92, 246, 0.4);
    }
    .settings-textarea::placeholder { color: var(--text-muted); }

    .settings-footer {
      padding: 14px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }
    .settings-save-btn {
      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
      border: none;
      border-radius: var(--radius-sm);
      padding: 8px 22px;
      color: white;
      font-size: 13px;
      font-family: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.25s ease;
      box-shadow: 0 2px 12px rgba(139, 92, 246, 0.2);
    }
    .settings-save-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(139, 92, 246, 0.35);
    }
    .settings-save-btn:disabled {
      background: var(--bg-tertiary);
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
    }
    .settings-reset-btn {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      font-weight: 500;
      transition: all 0.25s ease;
    }
    .settings-reset-btn:hover {
      background: rgba(239, 68, 68, 0.08);
      border-color: #ef4444;
    }
    .settings-status {
      text-align: center;
      font-size: 12px;
      padding: 8px;
      border-radius: var(--radius-sm);
      margin-top: 12px;
      animation: fadeSlideIn 0.3s ease;
    }
    .settings-status.success {
      color: #8b5cf6;
      background: rgba(139, 92, 246, 0.08);
    }
    .settings-status.error {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.08);
    }
  </style>
</head>
<body>
  <div class="sidebar-overlay" id="sidebar-overlay"></div>
  <div class="app-wrapper">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <button class="new-chat-btn" id="new-chat-btn">✦ New chat</button>
      </div>
      <div class="chat-list" id="chat-list"></div>
    </aside>

    <div class="main-area">
      <header>
        <div class="logo">
          <button class="sidebar-toggle" id="sidebar-toggle">☰</button>
          <div class="logo-icon">⚡</div>
          Workers AI Chat
        </div>
        <div class="header-right">
          <span class="badge">Llama 3.3 70B</span>
          <button id="facts-btn">📌 Facts</button>
          <button id="clear-btn">Clear history</button>
        </div>
      </header>

      <div id="chat-container">
        <div class="empty-state" id="empty-state">
          <div class="big-icon">🤖</div>
          <h2>Start a conversation</h2>
          <p>Powered by Llama 3.3 on Cloudflare Workers AI with persistent memory via Durable Objects.</p>
          <div class="suggestion-chips">
            <button class="chip" data-prompt="Explain how Cloudflare Workers work">How do Workers work?</button>
            <button class="chip" data-prompt="Write a JavaScript function that reverses a string">Reverse a string</button>
            <button class="chip" data-prompt="What are Durable Objects and why are they useful?">What are Durable Objects?</button>
            <button class="chip" data-prompt="Tell me a fun fact about AI">Fun AI fact</button>
          </div>
        </div>
      </div>

      <div class="input-wrapper">
        <div class="memory-bar" id="memory-bar"></div>
        <form id="chat-form">
          <label for="file-upload" class="file-upload-btn" title="Upload Document (.txt, .docx, .pdf, .zip)">📎</label>
          <input type="file" id="file-upload" accept=".txt,.docx,.pdf,.zip" style="display: none;">
          <textarea id="input" placeholder="Message the AI…" rows="1" autofocus></textarea>
          <button type="button" id="send-btn">➤</button>
        </form>
      </div>
    </div>
  </div>

  <!-- Rename modal -->
  <div class="modal-overlay" id="rename-modal">
    <div class="modal">
      <div class="modal-header">
        <h3>✏️ Rename Chat</h3>
        <button class="modal-close" id="rename-modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="settings-field">
          <input type="text" class="settings-textarea" id="rename-input" placeholder="Chat title" style="min-height: auto; width: 100%; box-sizing: border-box;" />
        </div>
      </div>
      <div class="settings-footer">
        <button class="settings-reset-btn" id="rename-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="rename-save-btn">Save</button>
      </div>
    </div>
  </div>

  <!-- Delete modal -->
  <div class="modal-overlay" id="delete-modal">
    <div class="modal">
      <div class="modal-header">
        <h3>🗑️ Delete Chat</h3>
        <button class="modal-close" id="delete-modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="facts-info" style="color: var(--text-primary); margin-bottom: 0;">
          Are you sure you want to delete this chat? This action cannot be undone.
        </div>
      </div>
      <div class="settings-footer">
        <button class="settings-reset-btn" id="delete-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="delete-confirm-btn" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">Delete</button>
      </div>
    </div>
  </div>

  <!-- Facts modal -->
  <div class="modal-overlay" id="facts-modal">
    <div class="modal">
      <div class="modal-header">
        <h3>📌 Manage Facts</h3>
        <button class="modal-close" id="facts-modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="facts-info">
          Facts are stored globally and automatically retrieved in every conversation.
          Use them to tell the AI things it should always know about you or your preferences.
        </div>
        <div class="fact-input-group">
          <textarea id="fact-input" placeholder="e.g. My name is Alex. I prefer Python over JavaScript. I work at Acme Corp." rows="3"></textarea>
          <button class="add-fact-btn" id="add-fact-btn">Add</button>
        </div>
        <div id="fact-status"></div>
        <div class="facts-list" id="facts-list">
          <div class="facts-loading">Loading facts…</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="clear-facts-btn" id="clear-facts-btn">🗑️ Clear all facts</button>
      </div>
    </div>
  </div>


  <!-- Right Panel (Settings) -->
  <aside class="right-panel" id="right-panel">
    <div class="right-panel-handle">
      <div style="writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 2px;">⚙️ SETTINGS</div>
    </div>
    <div class="right-panel-content">
      <h3 style="margin-bottom: 24px; font-weight: 600; font-size: 15px;">⚙️ Chat Settings</h3>
      <div class="settings-field">
        <label class="settings-label">
          Context Template
          <span class="settings-label-sub">Extra background context appended to the system prompt for this chat. Tell the AI what you're working on.</span>
        </label>
        <textarea class="settings-textarea" id="context-template-input" placeholder="e.g. I'm building a Python Flask web app." rows="4"></textarea>
      </div>
      <div class="settings-field">
        <label class="settings-label">
          Instruct Mode
          <span class="settings-label-sub">Behavioral instructions that change how the AI responds in this chat.</span>
        </label>
        <textarea class="settings-textarea" id="instruct-mode-input" placeholder="e.g. Be a senior code reviewer: be concise, critical, and focus on bugs and performance issues. Use bullet points." rows="4"></textarea>
      </div>
      <div id="settings-status"></div>
      
      <div style="margin-top: auto; padding-top: 24px; display: flex; flex-direction: column; gap: 10px;">
        <button class="settings-save-btn" id="settings-save-btn" style="width: 100%;">Save Settings</button>
        <button class="settings-reset-btn" id="settings-reset-btn" style="width: 100%;">🔄 Reset defaults</button>
      </div>
    </div>
  </aside>

  <script>
    // ── Chat Manager ─────────────────────────────────────────────
    const ACTIVE_CHAT_KEY = 'cf-active-chat';

    function generateId() {
      return 'session-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    async function loadChatList() {
      try {
        const res = await fetch('/api/chats');
        const data = await res.json();
        return data.chats || [];
      } catch {
        return [];
      }
    }

    async function createChat(chat) {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chat)
      });
    }

    async function updateChat(chat) {
      await fetch('/api/chats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: chat.id, title: chat.title })
      });
    }

    function getActiveId() {
      return localStorage.getItem(ACTIVE_CHAT_KEY);
    }

    function setActiveId(id) {
      localStorage.setItem(ACTIVE_CHAT_KEY, id);
    }

    let chatList = [];
    let sessionId = getActiveId();
    let messageCount = 0;
    let firstUserMessage = null;

    const container = document.getElementById('chat-container');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const fileUpload = document.getElementById('file-upload');
    const memoryBar = document.getElementById('memory-bar');
    const chatListEl = document.getElementById('chat-list');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    // ── Sidebar toggle (mobile) ─────────────────────────────────
    function toggleSidebar() {
      sidebar.classList.toggle('open');
      sidebarOverlay.classList.toggle('open');
    }
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', toggleSidebar);

    // ── Render sidebar chat list ────────────────────────────────
    function renderChatList() {
      chatListEl.innerHTML = '';
      chatList.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (chat.id === sessionId ? ' active' : '');
        item.innerHTML = \`
          <span class="chat-item-icon">💬</span>
          <span class="chat-item-title">\${escapeHtml(chat.title)}</span>
          <span class="chat-item-actions">
            <button class="chat-action-btn rename" title="Rename">✏️</button>
            <button class="chat-action-btn delete" title="Delete">🗑️</button>
          </span>\`;

        // Click to switch
        item.addEventListener('click', (e) => {
          if (e.target.closest('.chat-action-btn')) return;
          switchToChat(chat.id);
        });

        // Rename
        item.querySelector('.rename').addEventListener('click', (e) => {
          e.stopPropagation();
          openRenameModal(chat);
        });

        // Delete
        item.querySelector('.delete').addEventListener('click', (e) => {
          e.stopPropagation();
          openDeleteModal(chat);
        });

        chatListEl.appendChild(item);
      });
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    // ── Switch chat ─────────────────────────────────────────────
    async function switchToChat(id) {
      sessionId = id;
      setActiveId(id);
      messageCount = 0;
      firstUserMessage = null;

      // Show a brief loading placeholder while fetching history
      container.innerHTML = \`<div class="empty-state" id="empty-state" style="opacity:0.5">
        <div class="big-icon">⏳</div>
        <p>Loading conversation…</p>
      </div>\`;
      renderChatList();
      if (sidebar.classList.contains('open')) toggleSidebar();

      try {
        const res = await fetch(\`/api/history?sessionId=\${encodeURIComponent(id)}\`);
        const data = await res.json();
        const msgs = (data.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');

        container.innerHTML = '';
        if (msgs.length === 0) {
          container.innerHTML = \`<div class="empty-state" id="empty-state">
            <div class="big-icon">🤖</div>
            <h2>Start a conversation</h2>
            <p>Powered by Llama 3.3 on Cloudflare Workers AI with persistent memory via Durable Objects.</p>
            <div class="suggestion-chips">
              <button class="chip" data-prompt="Explain how Cloudflare Workers work">How do Workers work?</button>
              <button class="chip" data-prompt="Write a JavaScript function that reverses a string">Reverse a string</button>
              <button class="chip" data-prompt="What are Durable Objects and why are they useful?">What are Durable Objects?</button>
              <button class="chip" data-prompt="Tell me a fun fact about AI">Fun AI fact</button>
            </div>
          </div>\`;
          bindChips();
        } else {
          msgs.forEach(m => addMessage(m.role, m.content));
        }
      } catch (err) {
        console.error('Failed to load history:', err);
        container.innerHTML = \`<div class="empty-state" id="empty-state">
          <div class="big-icon">🤖</div>
          <h2>Start a conversation</h2>
          <p>Powered by Llama 3.3 on Cloudflare Workers AI with persistent memory via Durable Objects.</p>
          <div class="suggestion-chips">
            <button class="chip" data-prompt="Explain how Cloudflare Workers work">How do Workers work?</button>
            <button class="chip" data-prompt="Write a JavaScript function that reverses a string">Reverse a string</button>
            <button class="chip" data-prompt="What are Durable Objects and why are they useful?">What are Durable Objects?</button>
            <button class="chip" data-prompt="Tell me a fun fact about AI">Fun AI fact</button>
          </div>
        </div>\`;
        bindChips();
      }

      updateMemoryBar();
    }

    // ── New chat ────────────────────────────────────────────────
    async function createNewChat() {
      const chat = { id: generateId(), title: 'New chat' };
      chatList.unshift(chat);
      await createChat(chat);
      switchToChat(chat.id);
    }
    document.getElementById('new-chat-btn').addEventListener('click', createNewChat);

    // ── Delete chat ─────────────────────────────────────────────
    async function deleteChat(id) {
      await fetch('/api/chats?id=' + encodeURIComponent(id), { method: 'DELETE' });
      chatList = chatList.filter(c => c.id !== id);
      if (chatList.length === 0) {
        const fresh = { id: generateId(), title: 'New chat' };
        chatList.push(fresh);
        await createChat(fresh);
      }
      if (id === sessionId) {
        switchToChat(chatList[0].id);
      } else {
        renderChatList();
      }
    }

    // ── Auto-title ──────────────────────────────────────────────
    async function autoTitle(userMsg) {
      const chat = chatList.find(c => c.id === sessionId);
      if (chat && chat.title === 'New chat') {
        chat.title = userMsg.length > 40 ? userMsg.slice(0, 40) + '…' : userMsg;
        await updateChat(chat);
        renderChatList();
      }
    }

    function updateMemoryBar() {
      memoryBar.innerHTML = \`Session: <span>\${sessionId.slice(0, 18)}…</span>  ·  Messages: <span>\${messageCount}</span>  ·  Memory: <span>Durable Object + Vector DB</span>\`;
    }
    updateMemoryBar();

    function normalizeLink(link) {
      const markdownMatch = link.match(/\\[.*?\\]\\((.*?)\\)/);
      if (markdownMatch) return markdownMatch[1];
      if (link.startsWith('www.')) return \`https://\${link}\`;
      if (/^https?:\\/\\//.test(link)) return link;
      return \`https://\${link}\`;
    }

    function extractLinks(text) {
      const patterns = [
        /https?:\\/\\/[^\\s<>"{}|\\\\^\`\\[\\]]+/gi,
        /\\bwww\\.[a-z0-9-]+\\.[a-z]{2,}(?:\\/[^\\s<>"{}|\\\\^\`\\[\\]]*)?/gi,
        /\\[([^\\]]+)\\]\\(((?:https?:\\/\\/|www\\.)[^\\s)]+)\\)/gi,
        /\\b(?!www\\.)[a-z0-9-]+\\.[a-z]{2,4}(?:\\/[^\\s<>"{}|\\\\^\`\\[\\]]*)?(?=\\s|$)/gi,
      ];
      const links = new Set();
      patterns.forEach(pattern => {
        const matches = text.match(pattern) || [];
        matches.forEach(link => links.add(normalizeLink(link)));
      });
      return [...links];
    }

    function renderMessageWithLinks(text) {
      text = text.replace(
        /\\[([^\\]]+)\\]\\(((?:https?:\\/\\/|www\\.)[^\\s)]+)\\)/g,
        (_, label, url) => \`<a href="\${normalizeLink(url)}" target="_blank" style="color: var(--accent); text-decoration: underline;">\${label}</a>\`
      );

      text = text.replace(
        /(?<!["'=\\(])(?:https?:\\/\\/|www\\.)[^\\s<>"{}|\\\\^\`\\[\\]]+/gi,
        url => \`<a href="\${normalizeLink(url)}" target="_blank" style="color: var(--accent); text-decoration: underline;">\${url}</a>\`
      );

      return text;
    }

    // ── Markdown-like rendering ────────────────────────────────
    function renderMarkdown(text) {
      text = renderMessageWithLinks(text);
      return text
        .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
        .split('\\n\\n')
        .map(p => p.trim() ? \`<p>\${p.replace(/\\n/g, '<br>')}</p>\` : '')
        .join('');
    }

    function addMessage(role, content) {
      const es = document.getElementById('empty-state');
      if (es) es.remove();
      messageCount++;
      updateMemoryBar();

      const div = document.createElement('div');
      div.className = 'message ' + role;

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = role === 'user' ? '🧑' : '🤖';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      const formatted = renderMarkdown(content);
      bubble.innerHTML = formatted || \`<p>\${content}</p>\`;

      div.appendChild(avatar);
      div.appendChild(bubble);
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return div;
    }

    function addTyping() {
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.id = 'typing';
      div.innerHTML = \`
        <div class="avatar">🤖</div>
        <div class="bubble"><div class="typing-indicator">
          <div class="dot"></div><div class="dot"></div><div class="dot"></div>
        </div></div>\`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    // ── Send message ──────────────────────────────────────────
    async function sendMessage(message) {
      if (!message.trim()) return;

      const extracted = extractLinks(message);
      const validUrls = extracted.filter(url => {
        try { new URL(url); return true; } catch { return false; }
      });

      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;

      // Auto-title on first user message
      if (messageCount === 0) autoTitle(message);

      addMessage('user', message);

      if (validUrls.length > 0) {
        fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: validUrls, sessionId })
        }).then(res => {
          if (res.ok) {
            addMessage('assistant', \`✅ Background scraping started for **\${validUrls.length} link(s)**. They will be added to my memory shortly!\`);
          } else {
            addMessage('assistant', \`❌ **Error scraping links:** Failed to trigger scraper\`);
          }
        }).catch(err => {
          addMessage('assistant', \`❌ **Error scraping links:** \${err.message}\`);
        });
      }

      addTyping();

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sessionId }),
        });

        document.getElementById('typing')?.remove();

        if (!res.ok) throw new Error('Request failed');
        const data = await res.json();
        addMessage('assistant', data.response);
      } catch (err) {
        document.getElementById('typing')?.remove();
        addMessage('assistant', '⚠️ Something went wrong. Please try again.');
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    // ── Sidebar Modals ─────────────────────────────────────────

    const renameModal = document.getElementById('rename-modal');
    const renameInput = document.getElementById('rename-input');
    const renameSaveBtn = document.getElementById('rename-save-btn');
    
    let activeRenameChat = null;
    function openRenameModal(chat) {
      activeRenameChat = chat;
      renameInput.value = chat.title;
      renameModal.classList.add('open');
      renameInput.focus();
    }
    renameSaveBtn.addEventListener('click', async () => {
      if (!activeRenameChat) return;
      const newTitle = renameInput.value;
      if (newTitle && newTitle.trim() && newTitle.trim() !== activeRenameChat.title) {
        activeRenameChat.title = newTitle.trim();
        await updateChat(activeRenameChat);
        renderChatList();
      }
      renameModal.classList.remove('open');
    });
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        renameSaveBtn.click();
      }
    });

    document.getElementById('rename-cancel-btn').addEventListener('click', () => renameModal.classList.remove('open'));
    document.getElementById('rename-modal-close').addEventListener('click', () => renameModal.classList.remove('open'));
    renameModal.addEventListener('click', (e) => { if (e.target === renameModal) renameModal.classList.remove('open'); });

    const deleteModal = document.getElementById('delete-modal');
    const deleteConfirmBtn = document.getElementById('delete-confirm-btn');
    
    let activeDeleteChat = null;
    function openDeleteModal(chat) {
      activeDeleteChat = chat;
      deleteModal.classList.add('open');
    }
    deleteConfirmBtn.addEventListener('click', () => {
      if (!activeDeleteChat) return;
      deleteChat(activeDeleteChat.id);
      deleteModal.classList.remove('open');
    });
    document.getElementById('delete-cancel-btn').addEventListener('click', () => deleteModal.classList.remove('open'));
    document.getElementById('delete-modal-close').addEventListener('click', () => deleteModal.classList.remove('open'));
    deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) deleteModal.classList.remove('open'); });

    // ── Event listeners ────────────────────────────────────────

    // ── File Uploads ──────────────────────────────────────────
    fileUpload.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      // Reset input
      e.target.value = '';
      
      const filename = file.name;
      addMessage('user', \`📎 Uploading document: **\${filename}**...\`);
      addTyping();
      
      try {
        let extractedText = '';
        const ext = filename.split('.').pop().toLowerCase();
        
        if (ext === 'txt') {
          extractedText = await file.text();
        } else if (ext === 'docx') {
          const arrayBuffer = await file.arrayBuffer();
          const result = await mammoth.extractRawText({ arrayBuffer });
          extractedText = result.value;
        } else if (ext === 'pdf') {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          let text = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            text += pageText + '\\n\\n';
          }
          extractedText = text;
        } else if (ext === 'zip') {
          const zip = await JSZip.loadAsync(file);
          const textPromises = [];
          
          zip.forEach((relativePath, zipEntry) => {
            if (zipEntry.dir) return; // Ignore directories
            
            const entryExt = zipEntry.name.split('.').pop().toLowerCase();
            if (entryExt === 'txt') {
              textPromises.push(zipEntry.async('string'));
            } else if (entryExt === 'docx') {
              textPromises.push(zipEntry.async('arraybuffer').then(buffer => 
                mammoth.extractRawText({ arrayBuffer: buffer }).then(res => res.value)
              ));
            } else if (entryExt === 'pdf') {
              textPromises.push(zipEntry.async('arraybuffer').then(async buffer => {
                const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
                let text = '';
                for (let i = 1; i <= pdf.numPages; i++) {
                  const page = await pdf.getPage(i);
                  const content = await page.getTextContent();
                  text += content.items.map(item => item.str).join(' ') + '\\n\\n';
                }
                return text;
              }));
            }
          });
          
          const texts = await Promise.all(textPromises);
          extractedText = texts.join('\\n\\n');
        } else {
          throw new Error('Unsupported file type');
        }
        
        extractedText = extractedText.trim();
        if (!extractedText) {
          throw new Error('No text could be extracted from the file.');
        }

        // Send to backend
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: extractedText,
            filename: filename,
            sessionId: sessionId
          })
        });

        document.getElementById('typing')?.remove();

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to process document');
        }

        addMessage('assistant', \`✅ Successfully read **\${filename}** and added it to my memory! You can now ask me questions about it.\`);

      } catch (err) {
        console.error(err);
        document.getElementById('typing')?.remove();
        addMessage('assistant', \`❌ ** Error uploading \${filename}:** \${err.message} \`);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value.trim());
      }
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendMessage(input.value.trim());
    });


    // ── Suggestion chips ───────────────────────────────────────
    function bindChips() {
      document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const prompt = chip.getAttribute('data-prompt');
          if (prompt) sendMessage(prompt);
        });
      });
    }
    bindChips();

    // ── Clear history ──────────────────────────────────────────
    document.getElementById('clear-btn').addEventListener('click', async () => {
      await fetch('/api/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      container.innerHTML = \`<div class="empty-state" id="empty-state">
        <div class="big-icon">✨</div>
        <h2>Conversation cleared</h2>
        <p>Memory has been reset. Start a new conversation.</p>
      </div>\`;
      messageCount = 0;
      // Reset title
      const chat = chatList.find(c => c.id === sessionId);
      if (chat) { chat.title = 'New chat'; await updateChat(chat); renderChatList(); }
      updateMemoryBar();
    });

    // ── Facts modal ────────────────────────────────────────────
    const factsModal = document.getElementById('facts-modal');
    const factInput = document.getElementById('fact-input');
    const factStatus = document.getElementById('fact-status');
    const factsList = document.getElementById('facts-list');

    async function loadFacts() {
      factsList.innerHTML = '<div class="facts-loading">Loading facts…</div>';
      try {
        const res = await fetch('/api/facts');
        const data = await res.json();
        renderFacts(data.facts || []);
      } catch (err) {
        factsList.innerHTML = '<div class="facts-empty">Failed to load facts.</div>';
      }
    }

    function renderFacts(facts) {
      if (facts.length === 0) {
        factsList.innerHTML = '<div class="facts-empty">No facts stored yet. Add one above!</div>';
        return;
      }
      factsList.innerHTML = '<div class="facts-list-label">Stored Facts (' + facts.length + ')</div>';
      facts.forEach(function(f) {
        const item = document.createElement('div');
        item.className = 'fact-item';
        item.innerHTML =
          '<div class="fact-item-content">' + escapeHtml(f.content) + '</div>' +
          '<div class="fact-item-actions">' +
            '<button class="fact-action edit" title="Edit">✏️</button>' +
            '<button class="fact-action delete" title="Delete">🗑️</button>' +
          '</div>';

        // Delete single fact
        item.querySelector('.delete').addEventListener('click', async function() {
          if (!confirm('Delete this fact?')) return;
          try {
            await fetch('/api/facts?id=' + encodeURIComponent(f.id), { method: 'DELETE' });
            item.remove();
            loadFacts();
          } catch (err) {
            alert('Failed to delete fact.');
          }
        });

        // Edit fact: delete old, add updated
        item.querySelector('.edit').addEventListener('click', async function() {
          const newContent = prompt('Edit fact:', f.content);
          if (newContent === null || !newContent.trim()) return;
          try {
            await fetch('/api/facts?id=' + encodeURIComponent(f.id), { method: 'DELETE' });
            await fetch('/api/facts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fact: newContent.trim() }),
            });
            loadFacts();
          } catch (err) {
            alert('Failed to update fact.');
          }
        });

        factsList.appendChild(item);
      });
    }

    document.getElementById('facts-btn').addEventListener('click', () => {
      factsModal.classList.add('open');
      loadFacts();
    });

    document.getElementById('facts-modal-close').addEventListener('click', () => {
      factsModal.classList.remove('open');
    });

    factsModal.addEventListener('click', (e) => {
      if (e.target === factsModal) factsModal.classList.remove('open');
    });

    document.getElementById('add-fact-btn').addEventListener('click', async () => {
      const fact = factInput.value.trim();
      if (!fact) return;

      const btn = document.getElementById('add-fact-btn');
      btn.disabled = true;
      factStatus.textContent = '';

      try {
        const res = await fetch('/api/facts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fact }),
        });

        if (!res.ok) throw new Error('Failed');
        factInput.value = '';
        factStatus.className = 'fact-status success';
        factStatus.textContent = '✓ Fact stored!';
        loadFacts();
      } catch (err) {
        factStatus.className = 'fact-status error';
        factStatus.textContent = '✕ Failed to store fact. Please try again.';
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('clear-facts-btn').addEventListener('click', async () => {
      if (!confirm('Delete all stored facts? This cannot be undone.')) return;

      try {
        await fetch('/api/facts', { method: 'DELETE' });
        factStatus.className = 'fact-status success';
        factStatus.textContent = '✓ All facts cleared.';
        loadFacts();
      } catch (err) {
        factStatus.className = 'fact-status error';
        factStatus.textContent = '✕ Failed to clear facts.';
      }
    });

    // ── Right Panel (Settings) ─────────────────────────────────
    const rightPanel = document.getElementById('right-panel');
    const contextTemplateInput = document.getElementById('context-template-input');
    const instructModeInput = document.getElementById('instruct-mode-input');
    const settingsSaveBtn = document.getElementById('settings-save-btn');
    const settingsResetBtn = document.getElementById('settings-reset-btn');
    const settingsStatus = document.getElementById('settings-status');
    
    let lastLoadedSession = null;

    async function loadSettings() {
      if (lastLoadedSession === sessionId) return;
      contextTemplateInput.value = '';
      instructModeInput.value = '';
      settingsStatus.textContent = '';
      settingsStatus.className = 'settings-status';

      try {
        const res = await fetch('/api/settings?sessionId=' + encodeURIComponent(sessionId));
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        contextTemplateInput.value = data.contextTemplate || '';
        instructModeInput.value = data.instructMode || '';
        lastLoadedSession = sessionId;
      } catch (err) {
        settingsStatus.className = 'settings-status error';
        settingsStatus.textContent = '✕ Failed to load settings.';
      }
    }

    rightPanel.addEventListener('mouseenter', () => {
      loadSettings();
    });

    settingsSaveBtn.addEventListener('click', async () => {
      settingsSaveBtn.disabled = true;
      settingsStatus.className = 'settings-status';
      settingsStatus.textContent = 'Saving...';

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            contextTemplate: contextTemplateInput.value,
            instructMode: instructModeInput.value
          }),
        });
        if (!res.ok) throw new Error('Failed to save');
        settingsStatus.className = 'settings-status success';
        settingsStatus.textContent = '✓ Settings saved for this chat!';
      } catch (err) {
        settingsStatus.className = 'settings-status error';
        settingsStatus.textContent = '✕ Failed to save settings.';
      } finally {
        settingsSaveBtn.disabled = false;
      }
    });

    settingsResetBtn.addEventListener('click', async () => {
      if (!confirm('Clear your custom settings for this chat and return to default behavior?')) return;
      contextTemplateInput.value = '';
      instructModeInput.value = '';
      // Save the empty values
      settingsSaveBtn.click();
    });

    // ── Init ───────────────────────────────────────────────────
    async function initApp() {
      chatList = await loadChatList();
      if (chatList.length === 0) {
        const first = { id: generateId(), title: 'New chat' };
        await createChat(first);
        chatList.push(first);
        setActiveId(first.id);
      }
      if (!sessionId || !chatList.find(c => c.id === sessionId)) {
        sessionId = chatList[0].id;
        setActiveId(sessionId);
      }
      
      renderChatList();
      // Only do the visual switch if the active ID is already set, to populate UI state
      if (sessionId) {
        switchToChat(sessionId);
      }
    }
    
    initApp();
</script>
  </body>
  </html>`;
}
