import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { storeDocument } from './vectorStore';

type ScraperParams = {
    url: string;
    sessionId: string;
};

export class LinkScraperWorkflow extends WorkflowEntrypoint<Env, ScraperParams> {
    async run(event: WorkflowEvent<ScraperParams>, step: WorkflowStep) {
        const { url, sessionId } = event.payload;

        // Step 1: Fetch the web page
        const html = await step.do('fetch-web-page', async () => {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Chat-Scraper/1.0',
                },
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
            }
            return await response.text();
        });

        // Step 2: Clean the HTML
        const cleanedText = await step.do('clean-html', async () => {
            // Very basic HTML cleaning:
            // Remove head, script, style tags and their contents
            let text = html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ');
            text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
            text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');

            // Remove remaining HTML tags
            text = text.replace(/<[^>]+>/g, ' ');

            // Decode basic HTML entities
            text = text.replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");

            // Normalize whitespace
            text = text.replace(/\s+/g, ' ').trim();

            if (!text) {
                throw new Error(`No extractable text found at ${url}`);
            }

            return text;
        });

        // Step 3 & 4: Chunk and generate embeddings
        await step.do('chunk-and-embed', async () => {
            const filename = new URL(url).pathname.split('/').pop() || url;
            // We pass `this.env.VECTORIZE` and `this.env.AI` using the workflow's env
            await storeDocument(this.env.VECTORIZE, this.env.AI, sessionId, filename, cleanedText);
        });
    }
}
