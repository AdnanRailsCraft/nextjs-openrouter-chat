import { NextResponse } from 'next/server';
import { conversationStore } from '@/utils/memory';
import { loadConversationFromDisk } from '@/utils/conversationPersistence';
import { Message } from '@/types/chat';

const getBackendMessages = async (conversationId: string, userToken?: string): Promise<Message[] | null> => {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000';
  const url = `${baseUrl}/api/v1/chat_threads/${conversationId}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(userToken ? { 'Authorization': userToken, 'token': userToken } : {}),
        ...(process.env.POST_TOKEN ? { 'X-Internal-Auth': process.env.POST_TOKEN } : {})
      }
    });

    if (!response.ok) {
      console.warn(`History API: Backend returned ${response.status} for ${conversationId}`);
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!data) return null;

    const messages: Message[] =
      data?.messages ||
      data?.chat_thread?.messages ||
      data?.thread?.messages ||
      data?.conversation?.messages ||
      [];

    if (Array.isArray(messages) && messages.length) {
      console.log(`History API: Retrieved ${messages.length} messages from backend for ${conversationId}`);
      return messages;
    }
    return null;
  } catch (error) {
    console.warn(`History API: Failed to load backend messages for ${conversationId}`, error);
    return null;
  }
};

export async function POST(req: Request) {
  try {
    const { conversationId, userToken } = await req.json();

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation ID is required' },
        { status: 400 }
      );
    }

    console.log('History API: Getting conversation history for', conversationId);
    let history = conversationStore.get(conversationId);

    if (!history || history.length === 0) {
      const backendHistory = await getBackendMessages(conversationId, userToken);
      if (backendHistory && backendHistory.length > 0) {
        history = backendHistory;
        conversationStore.set(conversationId, backendHistory);
      }
    }

    if (!history || history.length === 0) {
      const diskHistory = await loadConversationFromDisk(conversationId);
      if (diskHistory && diskHistory.length > 0) {
        history = diskHistory;
        conversationStore.set(conversationId, diskHistory);
      }
    }
    
    if (!history || history.length === 0) {
      console.log('History API: No history found for', conversationId);
      return NextResponse.json(
        { messages: [] },
        { status: 200 }
      );
    }

    console.log('History API: Found history with', history.length, 'messages');
    
    // Filter out system messages for display
    const displayMessages = history.filter(msg => msg.role !== 'system');
    
    return NextResponse.json({
      messages: displayMessages,
      conversationId: conversationId
    });

  } catch (error: unknown) {
    console.error('History API Error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get conversation history';
    
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
