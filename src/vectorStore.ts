// Vector Store — embedding, storage, and retrieval for long-term chat memory
// Uses Cloudflare Workers AI (bge-base-en-v1.5) for embeddings and Vectorize for storage
// Uses Vectorize NAMESPACES (not metadata filters) to scope vectors by session/facts

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/** Shorten an ID to fit Vectorize's 64-byte vector ID limit. */
function shortId(id: string, maxLen: number = 48): string {
    return id.length > maxLen ? id.slice(0, maxLen) : id;
}

/**
 * Generate a 768-dimension text embedding via Workers AI.
 */
export async function embedText(ai: Ai, text: string): Promise<number[]> {
    const result: any = await ai.run(EMBEDDING_MODEL as any, {
        text: [text],
    });
    // Workers AI returns { data: [[...floats]] } for batch input
    return result.data[0];
}

/**
 * Generate embeddings for multiple texts via Workers AI.
 */
export async function embedTextBatch(ai: Ai, texts: string[]): Promise<number[][]> {
    const result: any = await ai.run(EMBEDDING_MODEL as any, {
        text: texts,
    });
    return result.data;
}

/**
 * Store a document context as vectorized chunks in the Vectorize index.
 * Uses the sessionId as a namespace so queries are scoped per session.
 */
export async function storeDocument(
    vectorize: Vectorize,
    ai: Ai,
    sessionId: string,
    filename: string,
    content: string
): Promise<void> {
    const CHUNK_SIZE = 1500;
    const OVERLAP = 200;
    const chunks: string[] = [];

    // Simple chunking with overlap
    let i = 0;
    while (i < content.length) {
        chunks.push(content.slice(i, i + CHUNK_SIZE));
        i += CHUNK_SIZE - OVERLAP;
    }

    // Process in batches (e.g., 20 chunks at a time) to avoid limits
    const BATCH_SIZE = 20;
    for (let batchIdx = 0; batchIdx < chunks.length; batchIdx += BATCH_SIZE) {
        const batchChunks = chunks.slice(batchIdx, batchIdx + BATCH_SIZE);

        // Ensure no chunk exceeds model limits (usually ~512 tokens / ~2000 chars)
        const textsToEmbed = batchChunks.map(c => c.slice(0, 2000));

        // Get embeddings for the batch
        const embeddings = await embedTextBatch(ai, textsToEmbed);

        const vectors = embeddings.map((embedding: number[], idx: number) => {
            const globalIdx = batchIdx + idx;
            const vectorId = `doc::${shortId(sessionId, 20)}::${shortId(filename, 20)}::${globalIdx}`;

            return {
                id: vectorId,
                values: embedding,
                namespace: sessionId,
                metadata: {
                    role: 'document',
                    content: `[Document: ${filename}]\n\n${batchChunks[idx]}`.slice(0, 8000),
                },
            };
        });

        await vectorize.insert(vectors);
    }
}

/**
 * Store a single chat message as a vector in the Vectorize index.
 * Uses the sessionId as a namespace so queries are scoped per session.
 */
export async function storeMessage(
    vectorize: Vectorize,
    ai: Ai,
    sessionId: string,
    messageIndex: number,
    role: string,
    content: string
): Promise<void> {
    // Truncate very long messages for embedding (model max is ~512 tokens)
    const textToEmbed = content.slice(0, 2000);
    const embedding = await embedText(ai, textToEmbed);

    const vectorId = `${shortId(sessionId)}::${messageIndex}`;

    await vectorize.insert([
        {
            id: vectorId,
            values: embedding,
            namespace: sessionId,
            metadata: {
                role,
                content: content.slice(0, 8000),
            },
        },
    ]);
}

/**
 * Query the vector index for the most relevant past messages
 * in a specific session, given a query string.
 */
export async function queryRelevantMessages(
    vectorize: Vectorize,
    ai: Ai,
    sessionId: string,
    queryText: string,
    topK: number = 5
): Promise<{ role: string; content: string; score: number }[]> {
    const queryEmbedding = await embedText(ai, queryText.slice(0, 2000));

    const results = await vectorize.query(queryEmbedding, {
        topK,
        returnMetadata: 'all',
        namespace: sessionId,
    });

    return results.matches
        .filter((m) => m.metadata && m.metadata.content)
        .map((m) => ({
            role: (m.metadata!.role as string) || 'user',
            content: m.metadata!.content as string,
            score: m.score,
        }));
}

/**
 * Delete all vectors for a given session from the index.
 */
export async function clearSessionVectors(
    vectorize: Vectorize,
    sessionId: string
): Promise<void> {
    try {
        const dummyVector = new Array(768).fill(0);
        const results = await vectorize.query(dummyVector, {
            topK: 100,
            namespace: sessionId,
        });

        if (results.matches.length > 0) {
            const ids = results.matches.map((m) => m.id);
            await vectorize.deleteByIds(ids);
        }
    } catch (err) {
        console.error('[vectorStore] clearSessionVectors error:', err);
    }
}

// ── Global Facts ────────────────────────────────────────────────
// Facts use a dedicated namespace so they are available across
// all conversations without needing metadata indexes.

const FACTS_NAMESPACE = '__global_facts__';

/**
 * Store a fact as a vector in the Vectorize index.
 * Facts are globally scoped (not tied to any chat session) and
 * are automatically retrieved in every conversation.
 */
export async function storeFact(
    vectorize: Vectorize,
    ai: Ai,
    factId: string,
    content: string
): Promise<void> {
    const textToEmbed = content.slice(0, 2000);
    const embedding = await embedText(ai, textToEmbed);

    const vectorId = `fact::${shortId(factId, 30)}`;

    await vectorize.insert([
        {
            id: vectorId,
            values: embedding,
            namespace: FACTS_NAMESPACE,
            metadata: {
                role: 'fact',
                content: content.slice(0, 8000),
            },
        },
    ]);
}

/**
 * Query the vector index for facts relevant to a given query string.
 * Returns facts ordered by semantic similarity.
 */
export async function queryRelevantFacts(
    vectorize: Vectorize,
    ai: Ai,
    queryText: string,
    topK: number = 3
): Promise<{ content: string; score: number }[]> {
    const queryEmbedding = await embedText(ai, queryText.slice(0, 2000));

    const results = await vectorize.query(queryEmbedding, {
        topK,
        returnMetadata: 'all',
        namespace: FACTS_NAMESPACE,
    });

    return results.matches
        .filter((m) => m.metadata && m.metadata.content)
        .map((m) => ({
            content: m.metadata!.content as string,
            score: m.score,
        }));
}

/**
 * Delete all stored facts from the vector index.
 */
export async function clearFacts(vectorize: Vectorize): Promise<void> {
    try {
        const dummyVector = new Array(768).fill(0);
        const results = await vectorize.query(dummyVector, {
            topK: 100,
            namespace: FACTS_NAMESPACE,
        });

        if (results.matches.length > 0) {
            const ids = results.matches.map((m) => m.id);
            await vectorize.deleteByIds(ids);
        }
    } catch (err) {
        console.error('[vectorStore] clearFacts error:', err);
    }
}

/**
 * List all stored facts.
 */
export async function listFacts(
    vectorize: Vectorize
): Promise<{ id: string; content: string }[]> {
    try {
        const dummyVector = new Array(768).fill(0);
        const results = await vectorize.query(dummyVector, {
            topK: 50,
            returnMetadata: 'all',
            namespace: FACTS_NAMESPACE,
        });

        return results.matches
            .filter((m) => m.metadata && m.metadata.content)
            .map((m) => ({
                id: m.id,
                content: m.metadata!.content as string,
            }));
    } catch (err) {
        console.error('[vectorStore] listFacts error:', err);
        return [];
    }
}

/**
 * Delete a single fact by its vector ID.
 */
export async function deleteFact(
    vectorize: Vectorize,
    factVectorId: string
): Promise<void> {
    await vectorize.deleteByIds([factVectorId]);
}

