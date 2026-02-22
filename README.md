# AI Chat App — Cloudflare Workers

A full-stack AI chat application running entirely on Cloudflare's edge, featuring LLM-powered conversations, persistent memory, token-aware context management, and RAG-based long-term recall via a vector database.

## Key Features

- **LLM**: Llama 3.3 70B Instruct via Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
- **Memory & Storage**: 
  - **Cloudflare D1**: Stores chat sessions and short-term conversation history.
  - **Cloudflare Vectorize**: Vector database for long-term semantic recall, global facts, and uploaded documents.
  - **Durable Objects**: Coordinates AI calls, RAG retrieval, and token budgeting per session.
- **Workflows**: Cloudflare Workflows are used for background tasks like scraping, cleaning, and embedding URLs shared in the chat.
- **RAG & Uploads**: Upload `.txt`, `.docx`, and `.zip` files. Their content is chunked, vectorized, and automatically retrieved when relevant to the conversation.
- **Token-Aware Window Management**: Dynamically trims conversation history to fit within the Llama 3 context limits, using the `llama3-tokenizer-js` package.

## Architecture

```text
Browser ──► Worker (index.ts)
               │
               ├─► Serves HTML chat UI (GET /)
               │
               └─► Routes by session ID to Durable Object (POST /api/chat)
                        │
                        ├─► Fetches/Stores message history in D1 Database
                        ├─► Embeds messages/files & stores in Vectorize
                        ├─► Queries Vectorize for semantic context (RAG)
                        ├─► Triggers Workflows for background tasks (e.g. link scraping)
                        ├─► Calls Workers AI (Llama 3.3 70B)
                        └─► Returns generated response
```

## Setup & Running Instructions

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)

### 1. Install dependencies

```bash
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Setup Cloudflare Resources

You'll need properly configured infrastructure to support the memory, database, and background workflows.

**A. D1 Database**
Create a new database and update your `wrangler.toml` with the generated `database_id` and `preview_database_id`.
```bash
npx wrangler d1 create chat-db
```
Apply the database schema:
```bash
npx wrangler d1 execute chat-db --remote --file=./schema.sql
```

**B. Vectorize Index**
Create the Vectorize index to store message and document embeddings:
```bash
npx wrangler vectorize create chat-memory-index --dimensions=768 --metric=cosine
```

### 4. Run Locally

Because the application relies on Cloudflare Vectorize and D1 bindings, it is highly recommended to run the local development server in remote mode so it can communicate directly with your Cloudflare infrastructure:

```bash
npm run dev -- --remote
# OR: npx wrangler dev --remote
```

Open http://localhost:8787 in your browser to try it out. 
*(Note: Calls to Workers AI and Vector DB are proxied to Cloudflare during remote local dev.)*

### 5. Deploy to Production

Deploy the application to your Cloudflare account, including the Workflows and Worker:

```bash
npm run deploy
```

Wrangler will output your live URL (e.g., `https://ai-chat-app.<your-subdomain>.workers.dev`).

## File Structure

```text
ai-chat-app/
├── src/
│   ├── index.ts           # Worker entry point + HTML/CSS/JS chat UI
│   ├── chatSession.ts     # Durable Object (memory, AI coordination, RAG)
│   ├── tokenizer.ts       # Llama 3 token counting + context trimming
│   ├── vectorStore.ts     # Vectorize embedding, storage, retrieval, and facts
│   ├── scraperWorkflow.ts # Cloudflare Workflow for extracting web content
│   └── env.d.ts           # TypeScript environment bindings
├── schema.sql             # Schema for D1 Database
├── wrangler.toml          # Cloudflare config (AI, D1, DO, Vectorize, Workflows)
├── package.json
└── tsconfig.json
```

## How Memory & Context works

### Short-Term Memory (D1 & Durable Objects)
Messages and chat session metadata are stored in a Cloudflare D1 SQL database. A Durable Object coordinates interactions for each specific chat session to prevent conflict or double-processing. 

### Long-Term Memory (Vectorize RAG)
Every message, uploaded file, and global fact is stored as an embedding (768-dimensional vector) within Cloudflare Vectorize.

When a user submits a prompt:
1. The message is embedded.
2. The system queries Vectorize for the top 5 most relevant past messages/documents and top 3 global facts.
3. These are injected into the system prompt as "recalled memory".
4. The token count is measured. The recent history is dynamically trimmed to fit the context budget.
5. The combined, token-budgeted prompt is sent to Workers AI `llama-3.3-70b-instruct-fp8-fast`.

### Customization

- **Change the model**: Edit the model string in `chatSession.ts`. Options include `@cf/meta/llama-3.1-8b-instruct`.
- **Adjust limits**: Update `MAX_CONTEXT_TOKENS`, `MAX_RESPONSE_TOKENS`, `MAX_RECALLED_TOKENS` in `chatSession.ts`.
- **Change the embedding model**: Edit `EMBEDDING_MODEL` in `vectorStore.ts`.
