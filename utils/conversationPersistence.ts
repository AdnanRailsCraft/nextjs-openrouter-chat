import fs from 'fs/promises';
import path from 'path';
import { Message } from '@/types/chat';

const conversationsDir = path.join(process.cwd(), 'data', 'conversations');

const ensureDir = async () => {
  try {
    await fs.mkdir(conversationsDir, { recursive: true });
  } catch {
    // Ignore directory creation errors
  }
};

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => {
  return typeof error === 'object' && error !== null && 'code' in error;
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
  } catch {
    // Ignore save failures
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
  } catch (error: unknown) {
    const isMissingFile = isErrnoException(error) && error.code === 'ENOENT';
    if (!isMissingFile) {
      // Ignore other failures silently
    }
    return null;
  }
};

