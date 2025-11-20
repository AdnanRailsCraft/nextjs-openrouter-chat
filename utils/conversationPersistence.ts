import fs from 'fs/promises';
import path from 'path';
import { Message } from '@/types/chat';

const conversationsDir = path.join(process.cwd(), 'data', 'conversations');

const ensureDir = async () => {
  try {
    await fs.mkdir(conversationsDir, { recursive: true });
  } catch (error) {
    console.error('[ConversationPersistence] Failed to ensure directory', error);
  }
};

export interface StoredConversation {
  conversationId: string;
  messages: Message[];
  updatedAt: string;
}

export const saveConversationToDisk = async (conversationId: string, messages: Message[]) => {
  try {
    await ensureDir();
    const payload: StoredConversation = {
      conversationId,
      messages,
      updatedAt: new Date().toISOString()
    };
    const filePath = path.join(conversationsDir, `${conversationId}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[ConversationPersistence] Failed to save conversation ${conversationId}`, error);
  }
};

export const loadConversationFromDisk = async (conversationId: string): Promise<Message[] | null> => {
  try {
    const filePath = path.join(conversationsDir, `${conversationId}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: StoredConversation = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.messages)) {
      return parsed.messages as Message[];
    }
    return null;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.error(`[ConversationPersistence] Failed to load conversation ${conversationId}`, error);
    }
    return null;
  }
};

