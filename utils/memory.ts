import { Message } from '@/types/chat';

type ConversationHistory = Message[];

class InMemoryConversationStore {
  private store: Map<string, ConversationHistory> = new Map();

  get(conversationId: string): ConversationHistory | undefined {
    return this.store.get(conversationId);
  }

  set(conversationId: string, history: ConversationHistory): void {
    this.store.set(conversationId, history);
  }

  append(conversationId: string, messages: Message[], maxMessages?: number): ConversationHistory {
    const current = this.store.get(conversationId) ?? [];
    const updated = [...current, ...messages];
    const trimmed = maxMessages && maxMessages > 0
      ? updated.slice(-maxMessages)
      : updated;
    this.store.set(conversationId, trimmed);
    return trimmed;
  }
}

export const conversationStore = new InMemoryConversationStore();


