# AI Chat App — Cloudflare Workers

A full-stack AI chat application running entirely on Cloudflare's edge, featuring LLM-powered conversations, persistent memory, token-aware context management, and RAG-based long-term recall via a vector database.

## Assignment Requirements

| Requirement | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B Instruct via Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| **Workflow / Coordination** | Durable Objects route each user session and coordinate AI calls, token budgeting, and RAG retrieval |
| **User Input (chat)** | Chat UI served directly from the Worker with multiple chat sessions, sidebar navigation, suggestion chips |
| **Memory / State** | Durable Object persistent storage for conversation history + Vectorize vector database for long-term semantic recall and global facts |

## Architecture

```
Browser ──► Worker (index.ts)
               │
               ├─► Serves HTML chat UI  (GET /)
               │
               └─► Routes by session ID to Durable Object  (POST /api/chat, /api/clear, /api/facts)
                        │
                        ├─► Loads message history from DO Storage
                        ├─► Stores message embedding in Vectorize (vectorStore.ts)
                        ├─► Queries Vectorize for relevant past messages (RAG)
                        ├─► Queries Vectorize for relevant global facts
                        ├─► Token-counts all context and trims to fit budget (tokenizer.ts)
                        ├─► Calls Workers AI (Llama 3.3)
                        └─► Persists updated history to DO Storage
```

## Key Features

### 🧠 Token-Aware Context Window Management
Instead of a hard message count limit, the app uses the **Llama 3 tokenizer** (`llama3-tokenizer-js`) to count tokens per message and dynamically trims the conversation history to fit the model's context window (24,000 tokens). This ensures maximum context utilisation without exceeding limits.

**How it works:** The system walks backwards from the newest message, summing token counts, and includes as many messages as fit within the remaining budget after accounting for the system prompt, recalled memories, and response tokens.

### 🔍 Retrieval-Augmented Generation (RAG)
Every user and assistant message is embedded using **Workers AI** (`bge-base-en-v1.5`) and stored in a **Cloudflare Vectorize** index. When a new message arrives, the system queries the vector database for semantically similar past messages and injects them as "recalled memory" into the prompt — allowing the AI to reference earlier parts of long conversations that may have been trimmed from the context window.

### 📌 Global Facts
Users can store facts that persist across **all** chat sessions. Facts are stored in the same Vectorize index with a special global session ID and are automatically retrieved and injected into every conversation based on semantic relevance.

### 💬 Multiple Chat Sessions
The sidebar allows creating, switching between, renaming, and deleting independent chat sessions. Each session has its own Durable Object instance, conversation history, and vector embeddings. Chat titles are auto-generated from the first user message.

## Quick Start

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Wrangler CLI (included in devDependencies)

### 1. Install dependencies

```bash
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Create the Vectorize index

Before deploying, create the Vectorize index that stores message embeddings:

```bash
npx wrangler vectorize create chat-memory-index --dimensions=768 --metric=cosine
```

### 4. Run locally

```bash
npm run dev
```

Open http://localhost:8787 — Workers AI calls are proxied to Cloudflare during local dev automatically.

### 5. Deploy to production

```bash
npm run deploy
```

Wrangler will output your live URL, e.g. `https://ai-chat-app.<your-subdomain>.workers.dev`

## File Structure

```
ai-chat-app/
├── src/
│   ├── index.ts          # Worker entry point + HTML/CSS/JS chat UI
│   ├── chatSession.ts    # Durable Object (memory, AI coordination, RAG)
│   ├── tokenizer.ts      # Llama 3 token counting + context trimming
│   ├── vectorStore.ts    # Vectorize embedding, storage, retrieval, and facts
│   └── env.d.ts          # TypeScript env bindings
├── wrangler.toml         # Cloudflare config (AI, DO, Vectorize bindings)
├── package.json
└── tsconfig.json
```

## How Memory Works

### Short-Term Memory (Durable Objects)
Each browser session is routed to a **Durable Object instance** keyed by session ID. The DO stores the full `messages[]` array in persistent KV storage and loads it on each request.

### Long-Term Memory (Vectorize RAG)
Every message is also embedded as a 768-dimensional vector and stored in **Cloudflare Vectorize**. When a new message arrives:

1. The message is embedded and stored in the vector index
2. A similarity query retrieves the top 5 most relevant past messages from the same session
3. A separate query retrieves the top 3 most relevant global facts
4. These are injected as "recalled memory" and "known facts" into the system prompt
5. The tokenizer trims the recent history to fit the remaining context budget
6. The full prompt (system + facts + recalled memory + recent history) is sent to Llama 3.3

### Context Budget Breakdown

| Component | Token Budget |
|---|---|
| System prompt | ~100 tokens |
| Global facts | up to 1,000 tokens |
| Recalled memory (RAG) | up to 2,000 tokens |
| Response | up to 1,024 tokens |
| Recent history | remaining (~20,000 tokens) |

## Customisation

- **Change the model**: Edit the model string in `chatSession.ts`. Options: `@cf/meta/llama-3.1-8b-instruct`, `@cf/google/gemma-3-12b-it`
- **Adjust context limits**: Change `MAX_CONTEXT_TOKENS`, `MAX_RESPONSE_TOKENS`, `MAX_RECALLED_TOKENS`, or `MAX_FACTS_TOKENS` in `chatSession.ts`
- **Change embedding model**: Edit `EMBEDDING_MODEL` in `vectorStore.ts`
- **Adjust RAG retrieval**: Change `RAG_TOP_K` and `FACTS_TOP_K` in `chatSession.ts`
- **Add a system persona**: Edit the `systemPrompt` in `chatSession.ts`
