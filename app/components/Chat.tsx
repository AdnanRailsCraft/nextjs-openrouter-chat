'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Message } from '@/types/chat';
import { ToolCall } from '@/types/api';

interface ChatProps {
  toolCallHandler?: (toolCall: ToolCall) => Promise<string | undefined>;
  conversationId?: string;
  onConversationChange?: (conversationId: string, title: string, lastMessage: string) => void;
  noBorder?: boolean;
  userId?: string | null;
}

// Helper function to filter out reasoning/thinking content
const filterReasoning = (content: string): string => {
  if (!content) return content;
  
  // If there's a stray closing </think>, drop everything before it (inclusive)
  // This ensures we only keep the visible answer after hidden reasoning
  const closingThinkIdx = content.toLowerCase().indexOf('</think>');
  if (closingThinkIdx !== -1) {
    content = content.slice(closingThinkIdx + '</think>'.length);
  }

  // Remove content within <think>...</think> blocks (case-insensitive, multiline)
  let filtered = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // Remove other common reasoning patterns
  filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  filtered = filtered.replace(/<reasoning[^>]*>[\s\S]*?<\/reasoning>/gi, '');
  
  // Remove content between <!-- think --> and <!-- /think --> (comment-based thinking)
  filtered = filtered.replace(/<!--\s*think\s*-->[\s\S]*?<!--\s*\/think\s*-->/gi, '');
  
  // Remove lines that are entirely reasoning content (common in some models)
  filtered = filtered.split('\n').filter(line => {
    const lowerLine = line.toLowerCase().trim();
    return !lowerLine.startsWith('thinking:') && 
           !lowerLine.startsWith('[reasoning') &&
           !lowerLine.startsWith('internal:') &&
           !lowerLine.includes('[thinking]');
  }).join('\n');
  
  // Clean up multiple consecutive newlines (max 2)
  filtered = filtered.replace(/\n{3,}/g, '\n\n');
  
  // Clean up any extra whitespace at start/end
  return filtered.trim();
};

// Helper function to convert URLs in text to clickable links
const linkify = (content: string): React.ReactNode => {
  if (!content) return content;
  
  // URL regex pattern - matches http, https, and other URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  
  while ((match = urlRegex.exec(content)) !== null) {
    // Add text before URL
    if (match.index > lastIndex) {
      parts.push(content.substring(lastIndex, match.index));
    }
    
    // Add clickable link
    const url = match[0];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all hover:opacity-80"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    );
    
    lastIndex = urlRegex.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(content.substring(lastIndex));
  }
  
  return parts.length > 0 ? parts : content;
};

// Ensure we always have some visible assistant content
const ensureVisibleContent = (raw: string): string => {
  const initial = raw || '';
  const filtered = filterReasoning(initial);
  if (filtered && filtered.trim().length > 0) return filtered;
  // Fallback: strip any XML-like tags and return text
  const stripped = initial.replace(/<[^>]+>/g, '').trim();
  return stripped;
};

// Apply basic inline markdown formatting (bold, italic) and linkify
const applyInlineFormatting = (text: string): React.ReactNode[] => {
  if (!text) return [];
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  const nodes: React.ReactNode[] = [];
  tokens.forEach((token, idx) => {
    if (!token) return;
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      const inner = token.slice(2, -2);
      const linked = linkify(inner);
      nodes.push(
        <strong key={`b-${idx}`}>{linked}</strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      const inner = token.slice(1, -1);
      const linked = linkify(inner);
      nodes.push(
        <em key={`i-${idx}`}>{linked}</em>
      );
    } else {
      const linked = linkify(token);
      // linkify may return string or array
      if (Array.isArray(linked)) {
        linked.forEach((n, i) => nodes.push(<React.Fragment key={`t-${idx}-${i}`}>{n}</React.Fragment>));
      } else {
        nodes.push(<React.Fragment key={`t-${idx}`}>{linked}</React.Fragment>);
      }
    }
  });
  return nodes;
};

// Render basic Markdown blocks: headings, lists, and paragraphs
const renderMessageContent = (raw: string): React.ReactNode => {
  const content = raw || '';
  const lines = content.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length > 0) {
      elements.push(
        <ul className="list-disc pl-5 my-2" key={`ul-${elements.length}`}>
          {listBuffer.map((item, i) => (
            <li key={`li-${elements.length}-${i}`} className="my-1">{applyInlineFormatting(item)}</li>
          ))}
        </ul>
      );
      listBuffer = [];
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trimEnd();
    if (/^\s*$/.test(trimmed)) {
      flushList();
      return;
    }

    // Headings
    const h3 = /^###\s+(.+)/.exec(trimmed);
    if (h3) { flushList(); elements.push(<h3 key={`h3-${elements.length}`} className="text-base font-semibold mt-3">{applyInlineFormatting(h3[1])}</h3>); return; }
    const h2 = /^##\s+(.+)/.exec(trimmed);
    if (h2) { flushList(); elements.push(<h2 key={`h2-${elements.length}`} className="text-lg font-semibold mt-4">{applyInlineFormatting(h2[1])}</h2>); return; }
    const h1 = /^#\s+(.+)/.exec(trimmed);
    if (h1) { flushList(); elements.push(<h1 key={`h1-${elements.length}`} className="text-xl font-bold mt-5">{applyInlineFormatting(h1[1])}</h1>); return; }

    // Unordered list item
    const li = /^[-*]\s+(.+)/.exec(trimmed);
    if (li) {
      listBuffer.push(li[1]);
      return;
    }

    // Paragraph
    flushList();
    elements.push(<p key={`p-${elements.length}`} className="my-2">{applyInlineFormatting(trimmed)}</p>);
  });

  flushList();
  return elements.length > 0 ? elements : applyInlineFormatting(content);
};

export default function Chat({ toolCallHandler, conversationId, onConversationChange, noBorder = false, userId }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(conversationId);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Debug: Log when component mounts and props change
  useEffect(() => {
    console.log('Chat: Component mounted/updated with props:', { 
      conversationId, 
      hasOnConversationChange: !!onConversationChange 
    });
  }, [conversationId, onConversationChange]);

  // Reset messages when conversation changes
  useEffect(() => {
    if (conversationId !== currentConversationId) {
      console.log('Chat: Conversation changed from', currentConversationId, 'to', conversationId);
      if (conversationId) {
        // Load conversation history from server
        loadConversationHistory(conversationId);
      } else {
        // New conversation - clear messages
        setMessages([]);
      }
      setCurrentConversationId(conversationId);
    }
  }, [conversationId, currentConversationId]);

  // Auto-scroll to the bottom when messages change
  useEffect(() => {
    try {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch (_) {}
  }, [messages, isLoading]);

  const loadConversationHistory = async (conversationId: string) => {             
    try {
      console.log('Chat: Loading conversation history for', conversationId);
      // For now, we'll use the server-side memory to get conversation history
      // The server already stores conversation history in the conversationStore
      // We need to make a request to get the conversation history
      const response = await fetch('/api/chat/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversationId }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log('Chat: Loaded conversation history:', data.messages);
        
        // Filter out thinking/reasoning content from all assistant messages
        const filteredMessages = data.messages?.map((msg: Message) => {
          if (msg.role !== 'assistant') return msg;
          const rawContent = msg.content || (msg as any)?.reasoning || '';
          return { ...msg, content: ensureVisibleContent(rawContent) };
        }) || [];
        
        setMessages(filteredMessages);
      } else {
        console.log('Chat: No conversation history found, starting fresh');
        setMessages([]);
      }
    } catch (error) {
      console.error('Chat: Error loading conversation history:', error);
      setMessages([]);
    }
  };

  const sendMessage = async (userMessage: Message) => {
    setError('');
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [userMessage],
          conversationId: currentConversationId,
          userToken: userId || undefined,
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        const errorMessage = typeof data.error === 'string' 
          ? data.error 
          : data.error?.message || JSON.stringify(data.error) || 'Failed to send message';
        throw new Error(errorMessage);
      }

      let assistantMessage = data.choices[0].message;

      // Normalize assistant content: fall back to reasoning if content is empty
      if (assistantMessage?.role === 'assistant') {
        const rawContent = assistantMessage.content || (assistantMessage as any)?.reasoning || '';
        assistantMessage = {
          ...assistantMessage,
          content: ensureVisibleContent(rawContent)
        };
      }
      
      // Append only the assistant message because the user message was optimistically added
      setMessages(prev => [...prev, assistantMessage]);

      // Notify sidebar about token usage to update HP bar immediately
      try {
        const used = Number(data.usedTokens || 0);
        if (!isNaN(used) && used > 0) {
          window.dispatchEvent(new CustomEvent('np_tokens_used', { detail: { used } }));
        }
      } catch (_) {}

      // Update conversation ID if it's new
      if (data.conversationId && data.conversationId !== currentConversationId) {
        setCurrentConversationId(data.conversationId);

        // Persist the conversation/thread id to Rails backend
        try {
          await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/chat_threads`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Backend resolves user/guest via Authorization header
              'Authorization': userId || ''
            },
            body: JSON.stringify({
              chat_thread: { thread_id: data.conversationId },
              // Some backend logic references params[:thread_id]
              thread_id: data.conversationId
            })
          });
        } catch (e) {
          console.warn('Failed to persist chat_thread', e);
        }
      }

      // Always notify parent component about conversation update
      if (onConversationChange && data.conversationId) {
        const title = userMessage.content.substring(0, 50) + (userMessage.content.length > 50 ? '...' : '');
        const filteredContent = ensureVisibleContent(assistantMessage.content || '');
        const lastMessage = filteredContent.substring(0, 100) + (filteredContent.length > 100 ? '...' : '');
        console.log('Chat: Notifying conversation change:', { conversationId: data.conversationId, title, lastMessage });
        onConversationChange(data.conversationId, title, lastMessage);
      }

    } catch (err: any) {
      console.error('Chat error:', err);
      setError(err.message || 'Failed to send message. Please try again.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      role: 'user',
      content: input.trim(),
    };

    setInput('');
    setIsLoading(true);
    try {
      // Optimistically render the user's message immediately
      const nextMessages = [...messages, userMessage];
      setMessages(nextMessages);
      await sendMessage(userMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Enter to send message
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (input.trim() && !isLoading) {
          handleSubmit(e as any);
        }
      }
      // Escape to clear input
      if (e.key === 'Escape') {
        setInput('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [input, isLoading]);

  return (
    <div className={`flex flex-col h-full bg-gray-50 ${noBorder ? '' : 'rounded-lg shadow-xl border border-gray-200'}`}>
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 my-6 sm:my-8">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
            </div>
            <p className="text-base sm:text-lg font-medium flex items-center justify-center gap-2">
              <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              Welcome to Needpedia!
            </p>
            <p className="mt-2 text-sm sm:text-base">I'm Lotte, your AI librarian. I can help you create ideas, browse content, and navigate Needpedia.</p>
            <p className="mt-4 text-xs sm:text-sm font-medium flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Try asking me to:
            </p>
            <ul className="mt-2 text-xs sm:text-sm space-y-2">
              <li className="flex items-center justify-center gap-2">
                <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Create a new idea about bike lanes
              </li>
              <li className="flex items-center justify-center gap-2">
                <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Search for existing ideas about climate change
              </li>
              <li className="flex items-center justify-center gap-2">
                <svg className="w-3 h-3 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                Help you navigate subjects and problems
              </li>
            </ul>
          </div>
        )}
        <div className="space-y-3 sm:space-y-4">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-4 fade-in duration-300`}
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <div
                className={`relative p-3 sm:p-4 rounded-2xl shadow-sm max-w-[90%] sm:max-w-[85%] break-words transition-all duration-200 hover:shadow-md ${
                  message.role === 'user'
                    ? 'bg-black text-white hover:bg-gray-900'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-gray-300'
                }`}
                style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}
              >
                <div className="text-xs sm:text-sm opacity-75 mb-1 sm:mb-2 flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    {message.role === 'user' ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    ) : (
                      // Robot icon for assistant/system
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4V2m-6 9H4m16 0h-2M7 10h10a2 2 0 012 2v4a4 4 0 01-4 4H9a4 4 0 01-4-4v-4a2 2 0 012-2zm2 4h6m-7 3h8M9 7a3 3 0 106 0 3 3 0 00-6 0z" />
                      </svg>
                    )}
                    <span>{message.role === 'user' ? 'You' : 'Lotte'}</span>
                  </div>
                  <span className="text-xs opacity-50 flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className={`prose prose-sm max-w-none break-words overflow-wrap-anywhere whitespace-pre-wrap leading-relaxed text-sm sm:text-base ${message.role === 'user' ? 'prose-invert' : ''}`}>
                  {renderMessageContent(message.content)}
                </div>
              </div>
            </div>
          ))}
        </div>
        {isLoading && (
          <div className="flex justify-start animate-in slide-in-from-bottom-4 fade-in duration-300">
            <div className="relative p-3 sm:p-4 rounded-2xl shadow-sm bg-white border border-gray-200 max-w-[90%] sm:max-w-[85%] text-gray-800">
              <div className="text-xs sm:text-sm opacity-75 mb-2 flex items-center gap-2">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span>Lotte</span>
                <span className="text-xs opacity-50 flex items-center gap-1" aria-live="polite" aria-label="Assistant is typing">
                  <svg className="w-3 h-3 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </span>
              </div>
              <div className="flex items-center space-x-1">
                <div className="w-2 h-2 rounded-full bg-gray-700 animate-bounce"></div>
                <div className="w-2 h-2 rounded-full bg-gray-700 animate-bounce delay-100"></div>
                <div className="w-2 h-2 rounded-full bg-gray-700 animate-bounce delay-200"></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      
      <div className="border-t bg-white p-3 sm:p-4 rounded-b-lg">
        {error && (
          <div className="mb-3 sm:mb-4 p-2 sm:p-3 text-xs sm:text-sm text-red-500 bg-red-50 rounded-lg flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3">
          <div className="flex-1 relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message... (Ctrl+Enter to send, Esc to clear)"
              className="w-full p-2 sm:p-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-700 focus:border-transparent transition-all text-gray-800 placeholder-gray-400 text-sm sm:text-base pr-10 bg-white"
              disabled={isLoading}
              autoComplete="off"
              spellCheck="true"
            />
            {input && (
              <button
                type="button"
                onClick={() => setInput('')}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 hover:bg-gray-100 rounded-full transition-colors"
                title="Clear input"
              >
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-4 sm:px-6 py-2 sm:py-3 bg-black text-white font-medium rounded-lg hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-700 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm sm:text-base flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            <span className="hidden sm:inline">Send</span>
          </button>
        </form>
      </div>
    </div>
  );
}