'use client';

import { useState, useEffect, useImperativeHandle, forwardRef } from 'react';

interface ChatHistory {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: Date;
}

interface StoredChatHistory extends Omit<ChatHistory, 'timestamp'> {
  timestamp: string;
}

interface ChatSidebarProps {
  onNewChat: () => void;
  onSelectChat: (conversationId: string) => void;
  currentConversationId?: string;
  userId?: string | null;
}

export interface ChatSidebarRef {
  addToHistory: (conversationId: string, title: string, lastMessage: string) => void;
}

const ChatSidebar = forwardRef<ChatSidebarRef, ChatSidebarProps>(({ onNewChat, onSelectChat, currentConversationId, userId }, ref) => {
  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load chat history from localStorage on mount - user-specific
  useEffect(() => {
    console.log('Sidebar: Loading chat history for userId:', userId);
    if (!userId) return;
    
    const storageKey = `chatHistory_${userId}`;
    const savedHistory = localStorage.getItem(storageKey);
    console.log('Sidebar: Found saved history:', savedHistory);
    if (savedHistory) {
      try {
        const parsed = (JSON.parse(savedHistory) as StoredChatHistory[]).map((item) => ({
          ...item,
          timestamp: new Date(item.timestamp)
        }));
        console.log('Sidebar: Parsed history:', parsed);
        setChatHistory(parsed);
      } catch (error: unknown) {
        console.error('Error parsing chat history:', error);
      }
    }
  }, [userId]);

  // Load conversation IDs from Rails backend and merge into sidebar list
  useEffect(() => {
    const fetchThreads = async () => {
      if (!userId) return;
      try {
        const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000';
        const resp = await fetch(`${base}/api/v1/chat_threads`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': userId
          }
        });
        if (!resp.ok) {
          console.warn('Sidebar: Failed to load backend chat threads');
          return;
        }
        const data = (await resp.json().catch(() => ({ threads: [] }))) as { threads?: unknown };
        const threads = Array.isArray(data?.threads) ? data.threads.filter((id): id is string => typeof id === 'string') : [];

        if (threads.length === 0) return;

        setChatHistory(prev => {
          const existingIds = new Set(prev.map(c => c.id));
          const now = new Date();
          const additions: ChatHistory[] = threads
            .filter(id => !existingIds.has(id))
            .map(id => ({
              id,
              title: `Conversation ${id.substring(0, 8)}...`,
              lastMessage: '',
              timestamp: now
            }));
          return additions.length ? [...additions, ...prev] : prev;
        });
      } catch (error: unknown) {
        console.warn('Sidebar: Error loading backend chat threads', error);
      }
    };

    fetchThreads();
  }, [userId]);


  // Save chat history to localStorage whenever it changes - user-specific
  useEffect(() => {
    if (!userId) return;
    
    const storageKey = `chatHistory_${userId}`;
    localStorage.setItem(storageKey, JSON.stringify(chatHistory));
  }, [chatHistory, userId]);

  const addToHistory = (conversationId: string, title: string, lastMessage: string) => {
    console.log('Sidebar: addToHistory called with:', { conversationId, title, lastMessage });
    setChatHistory(prev => {
      const existingIndex = prev.findIndex(chat => chat.id === conversationId);
      const newEntry = {
        id: conversationId,
        title,
        lastMessage,
        timestamp: new Date()
      };

      if (existingIndex >= 0) {
        // Update existing chat
        const updated = [...prev];
        updated[existingIndex] = newEntry;
        console.log('Sidebar: Updated existing chat at index', existingIndex);
        return updated;
      } else {
        // Add new chat at the beginning
        console.log('Sidebar: Adding new chat');
        return [newEntry, ...prev];
      }
    });
  };

  // Expose methods to parent component via ref
  useImperativeHandle(ref, () => ({
    addToHistory
  }));

  const deleteChat = (conversationId: string) => {
    setChatHistory(prev => prev.filter(chat => chat.id !== conversationId));
  };

  const formatTime = (date: Date) => {
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
    
    if (diffInHours < 24) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString();
    }
  };

  const truncateText = (text: string, maxLength: number = 80) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  };

  return (
    <div className={`bg-white text-gray-900 transition-all duration-300 ${
      isCollapsed ? 'w-12 sm:w-16' : 'w-64 sm:w-80'
    } flex flex-col h-screen border-r border-gray-200 shadow-lg`}>
      {/* Header */}
      <div className="p-3 sm:p-4 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center justify-between">
          {!isCollapsed && (
            <h2 className="text-sm sm:text-lg font-semibold flex items-center gap-2">
              <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Chat History
            </h2>
          )}
          <button
            type="button"
            onClick={() => setIsCollapsed(prev => !prev)}
            className="p-1 rounded hover:bg-gray-200 transition-colors text-gray-600"
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isCollapsed ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* New Chat Button */}
      <div className="p-3 sm:p-4">
        <button
          onClick={onNewChat}
          className={`w-full bg-black hover:bg-gray-900 text-white font-medium py-2 sm:py-3 px-3 sm:px-4 rounded-lg transition-all duration-200 flex items-center justify-center text-sm sm:text-base ${
            isCollapsed ? 'px-2' : ''
          } hover:scale-105 hover:shadow-lg`}
          title={isCollapsed ? 'New Chat' : ''}
        >
          <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {!isCollapsed && <span className="ml-2">New Chat</span>}
        </button>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto">
        {chatHistory.length === 0 ? (
          <div className="p-3 sm:p-4 text-center text-gray-500">
            {!isCollapsed && (
              <>
                <div className="w-12 h-12 sm:w-16 sm:h-16 mx-auto mb-3 bg-gray-100 rounded-full flex items-center justify-center">
                  <svg className="w-6 h-6 sm:w-8 sm:h-8 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <p className="text-xs sm:text-sm font-medium">No chat history yet</p>
                <p className="text-xs mt-1 flex items-center justify-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Start a new conversation!
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-1 p-1 sm:p-2">
            {chatHistory.map((chat, index) => (
              <div
                key={chat.id}
                className={`group relative p-2 sm:p-3 rounded-lg cursor-pointer transition-all duration-200 ${
                  currentConversationId === chat.id
                    ? 'bg-black text-white shadow-lg'
                    : 'bg-gray-50 hover:bg-gray-100 hover:shadow-md'
                } animate-in slide-in-from-left-4 fade-in`}
                style={{ animationDelay: `${index * 50}ms` }}
                onClick={() => onSelectChat(chat.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    {!isCollapsed && (
                      <>
                        <h3 className="text-xs sm:text-sm font-medium truncate flex items-center gap-2">
                          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                          {chat.title}
                        </h3>
                        <p className={`text-xs mt-1 truncate ${
                          currentConversationId === chat.id ? 'text-gray-200' : 'text-gray-600'
                        }`}>
                          {truncateText(chat.lastMessage)}
                        </p>
                        <p className={`text-xs mt-1 flex items-center gap-1 ${
                          currentConversationId === chat.id ? 'text-gray-300' : 'text-gray-500'
                        }`}>
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {formatTime(chat.timestamp)}
                        </p>
                      </>
                    )}
                  </div>
                  
                  {!isCollapsed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(chat.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-300 rounded transition-all duration-200 hover:scale-110"
                      title="Delete chat"
                    >
                      <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 sm:p-4 border-t border-gray-200">
        {!isCollapsed && (
            <div className="text-xs text-gray-600 text-center">
              
              <div className="flex items-center justify-center gap-2 mb-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <span className="font-medium">Needpedia Assistant</span>
            </div>
            <p className="flex items-center justify-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Powered by Lotte
            </p>
          </div>
        )}
      </div>
    </div>
  );
});

ChatSidebar.displayName = 'ChatSidebar';

export default ChatSidebar;
