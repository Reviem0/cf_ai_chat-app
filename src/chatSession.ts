// ChatSession Durable Object
// Handles per-session memory and LLM coordination
// Uses token-based context window trimming + Vectorize RAG for long-term memory

import { countMessageTokens, trimMessagesToFitContext } from './tokenizer';
import { storeMessage, queryRelevantMessages, queryRelevantFacts, clearSessionVectors } from './vectorStore';

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Cloudflare Workers AI context limit for llama-3.3-70b-instruct-fp8-fast
const MAX_CONTEXT_TOKENS = 24_000;
const MAX_RESPONSE_TOKENS = 1_024;
// Reserve tokens for recalled memory from vector search
const MAX_RECALLED_TOKENS = 2_000;
// Reserve tokens for global facts
const MAX_FACTS_TOKENS = 1_000;
// Number of similar past messages to retrieve from vector DB
const RAG_TOP_K = 5;
// Number of relevant facts to retrieve
const FACTS_TOP_K = 3;

export class ChatSession {
  private state: DurableObjectState;
  private env: Env;
  private messages: Message[] = [];
  private contextTemplate: string = '';
  private instructMode: string = '';
  private loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async ensureLoaded(sessionId: string) {
    if (this.loaded) return;
    try {
      const chat = await this.env.DB.prepare('SELECT context_template, instruct_mode FROM chats WHERE id = ?')
        .bind(sessionId)
        .first<{ context_template: string | null; instruct_mode: string | null }>();

      if (chat) {
        this.contextTemplate = chat.context_template || '';
        this.instructMode = chat.instruct_mode || '';
      }

      const { results } = await this.env.DB.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .bind(sessionId)
        .all();

      if (results) {
        this.messages = results.map(r => ({ role: r.role as any, content: r.content as string }));
      }
    } catch (e) {
      console.error('[d1] load error:', e);
    }
    this.loaded = true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = request.headers.get('x-session-id');

    if (!sessionId) {
      return new Response('Missing x-session-id header', { status: 400 });
    }

    // Load persisted data from storage on first access
    await this.ensureLoaded(sessionId);

    // ── POST /chat ──────────────────────────────────────────────
    if (url.pathname === '/chat' && request.method === 'POST') {
      const { message } = await request.json() as { message: string };

      // Build system prompt
      let systemContent = `You are a helpful, concise AI assistant powered by Llama 3.3 running on Cloudflare Workers AI.
You have memory of this conversation via Cloudflare Durable Objects and long-term memory via a vector database.
If "recalled memory" is provided below, use it to reference earlier parts of the conversation the user may be asking about.
If "known facts" are provided, treat them as established truths the user has previously stored.
Be direct, accurate, and friendly. Format code in markdown code blocks when relevant.
Current UTC time: ${new Date().toUTCString()}`;

      // Inject per-chat instruct mode
      if (this.instructMode.trim()) {
        systemContent += `\n\nInstruct mode (follow these behavioral instructions):\n${this.instructMode}`;
      }

      // Inject per-chat context template
      if (this.contextTemplate.trim()) {
        systemContent += `\n\nAdditional context provided by the user for this conversation:\n${this.contextTemplate}`;
      }

      const systemPrompt: Message = {
        role: 'system',
        content: systemContent,
      };

      // Append user message
      this.messages.push({ role: 'user', content: message });
      const currentMsgIndex = this.messages.length - 1;

      try {
        await this.env.DB.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
          .bind(sessionId, 'user', message, Date.now())
          .run();
      } catch (err) {
        console.error('[d1] Failed to store user message:', err);
      }

      // ── Store user message in vector DB ─────────────────────
      try {
        await storeMessage(
          this.env.VECTORIZE,
          this.env.AI,
          this.state.id.toString(),
          currentMsgIndex,
          'user',
          message
        );
      } catch (err) {
        console.error('[vector-store] Failed to store user message:', err);
      }

      // ── RAG: Retrieve relevant past messages ────────────────
      let recalledContext = '';
      try {
        const relevant = await queryRelevantMessages(
          this.env.VECTORIZE,
          this.env.AI,
          this.state.id.toString(),
          message,
          RAG_TOP_K
        );

        // Filter out the current message itself (it was just inserted)
        // and only include messages with a reasonable similarity score
        const filtered = relevant.filter(
          (r) => r.score < 0.99 && r.content !== message
        );

        if (filtered.length > 0) {
          const recalledLines = filtered.map(
            (r) => `[${r.role}]: ${r.content}`
          );
          recalledContext = recalledLines.join('\n');
        }
      } catch (err) {
        console.error('[vector-store] Failed to query relevant messages:', err);
      }

      // ── RAG: Retrieve relevant global facts ─────────────────
      let factsContext = '';
      try {
        const facts = await queryRelevantFacts(
          this.env.VECTORIZE,
          this.env.AI,
          message,
          FACTS_TOP_K
        );

        if (facts.length > 0) {
          factsContext = facts.map((f) => `• ${f.content}`).join('\n');
        }
      } catch (err) {
        console.error('[vector-store] Failed to query facts:', err);
      }

      // ── Token-based context trimming ────────────────────────
      const systemTokens = countMessageTokens(systemPrompt);

      // Build recalled memory message if we have context
      let recalledMessage: Message | null = null;
      let recalledTokens = 0;
      if (recalledContext) {
        recalledMessage = {
          role: 'system',
          content: `Recalled memory from earlier in this conversation:\n${recalledContext}`,
        };
        recalledTokens = Math.min(
          countMessageTokens(recalledMessage),
          MAX_RECALLED_TOKENS
        );
      }

      // Build facts message if we have facts
      let factsMessage: Message | null = null;
      let factsTokens = 0;
      if (factsContext) {
        factsMessage = {
          role: 'system',
          content: `Known facts stored by the user:\n${factsContext}`,
        };
        factsTokens = Math.min(
          countMessageTokens(factsMessage),
          MAX_FACTS_TOKENS
        );
      }

      const availableForHistory =
        MAX_CONTEXT_TOKENS - MAX_RESPONSE_TOKENS - systemTokens - recalledTokens - factsTokens;
      const trimmed = trimMessagesToFitContext(this.messages, availableForHistory);

      console.log(
        `[context-window] system=${systemTokens}tok, ` +
        `recalled=${recalledTokens}tok (${recalledContext ? 'yes' : 'none'}), ` +
        `facts=${factsTokens}tok (${factsContext ? 'yes' : 'none'}), ` +
        `history=${this.messages.length}msgs→${trimmed.length}msgs, ` +
        `budget=${availableForHistory}tok`
      );

      // Build final messages array: system → facts → recalled → recent history
      const finalMessages: Message[] = [systemPrompt];
      if (factsMessage) {
        finalMessages.push(factsMessage);
      }
      if (recalledMessage) {
        finalMessages.push(recalledMessage);
      }
      finalMessages.push(...trimmed);

      try {
        // Call Workers AI — Llama 3.3 70B Instruct
        const aiResponse: any = await this.env.AI.run(
          '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any,
          {
            messages: finalMessages,
            max_tokens: MAX_RESPONSE_TOKENS,
            temperature: 0.7,
          }
        );

        const assistantMessage: string =
          aiResponse?.response || 'Sorry, I could not generate a response.';

        // Persist assistant reply
        this.messages.push({ role: 'assistant', content: assistantMessage });

        // Save to durable storage
        try {
          await this.env.DB.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
            .bind(sessionId, 'assistant', assistantMessage, Date.now())
            .run();
        } catch (err) {
          console.error('[d1] Failed to store assistant message:', err);
        }

        // ── Store assistant message in vector DB ──────────────
        try {
          await storeMessage(
            this.env.VECTORIZE,
            this.env.AI,
            this.state.id.toString(),
            this.messages.length - 1,
            'assistant',
            assistantMessage
          );
        } catch (err) {
          console.error('[vector-store] Failed to store assistant message:', err);
        }

        return Response.json({
          response: assistantMessage,
          messageCount: this.messages.length,
        });
      } catch (err: any) {
        console.error('Workers AI error:', err);
        return Response.json(
          { error: 'AI inference failed', detail: err?.message },
          { status: 500 }
        );
      }
    }

    // ── POST /clear ─────────────────────────────────────────────
    if (url.pathname === '/clear' && request.method === 'POST') {
      this.messages = [];
      try {
        await this.env.DB.prepare('DELETE FROM messages WHERE session_id = ?').bind(sessionId).run();
      } catch (err) {
        console.error('[d1] Failed to clear messages:', err);
      }

      // Clear vectors for this session from Vectorize
      try {
        await clearSessionVectors(
          this.env.VECTORIZE,
          this.state.id.toString()
        );
      } catch (err) {
        console.error('[vector-store] Failed to clear session vectors:', err);
      }

      return Response.json({ ok: true });
    }

    // ── GET /settings ──────────────────────────────────────────
    if (url.pathname === '/settings' && request.method === 'GET') {
      return Response.json({
        contextTemplate: this.contextTemplate,
        instructMode: this.instructMode,
      });
    }

    // ── POST /settings ─────────────────────────────────────────
    if (url.pathname === '/settings' && request.method === 'POST') {
      const body = await request.json() as {
        contextTemplate?: string;
        instructMode?: string;
      };

      if (typeof body.contextTemplate === 'string') {
        this.contextTemplate = body.contextTemplate;
        try {
          await this.env.DB.prepare('UPDATE chats SET context_template = ? WHERE id = ?').bind(this.contextTemplate, sessionId).run();
        } catch (e) { console.error(e); }
      }
      if (typeof body.instructMode === 'string') {
        this.instructMode = body.instructMode;
        try {
          await this.env.DB.prepare('UPDATE chats SET instruct_mode = ? WHERE id = ?').bind(this.instructMode, sessionId).run();
        } catch (e) { console.error(e); }
      }

      return Response.json({
        ok: true,
        contextTemplate: this.contextTemplate,
        instructMode: this.instructMode,
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}
