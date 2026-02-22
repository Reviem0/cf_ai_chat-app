// Token counting and context-window trimming using the Llama 3 tokenizer
import llama3Tokenizer from 'llama3-tokenizer-js';

interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// Overhead tokens per message for chat-ML framing (e.g. <|start|>role\n … <|end|>)
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Count the number of tokens in a text string using the Llama 3 tokenizer.
 */
export function countTokens(text: string): number {
    return llama3Tokenizer.encode(text).length;
}

/**
 * Count tokens for a single chat message, including role/framing overhead.
 */
export function countMessageTokens(message: Message): number {
    return countTokens(message.content) + PER_MESSAGE_OVERHEAD;
}

/**
 * Given an array of messages and a token budget, return the largest suffix
 * of messages (newest first) that fits within the budget.
 *
 * This walks from the END of the array backwards, accumulating token counts.
 * Once adding the next-oldest message would exceed the budget, it stops.
 */
export function trimMessagesToFitContext(
    messages: Message[],
    maxTokens: number
): Message[] {
    let totalTokens = 0;
    let startIndex = messages.length; // will move backwards

    for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countMessageTokens(messages[i]);
        if (totalTokens + msgTokens > maxTokens) break;
        totalTokens += msgTokens;
        startIndex = i;
    }

    return messages.slice(startIndex);
}
