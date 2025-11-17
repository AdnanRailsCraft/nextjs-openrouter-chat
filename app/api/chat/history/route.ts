import { NextResponse } from 'next/server';
import { conversationStore } from '@/utils/memory';

export async function POST(req: Request) {
  try {
    const { conversationId } = await req.json();

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation ID is required' },
        { status: 400 }
      );
    }

    console.log('History API: Getting conversation history for', conversationId);
    
    const history = conversationStore.get(conversationId);
    
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

  } catch (error: any) {
    console.error('History API Error:', error);
    
    return NextResponse.json(
      { error: error.message || 'Failed to get conversation history' },
      { status: 500 }
    );
  }
}
