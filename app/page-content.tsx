'use client';

import { useState, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Chat from './components/Chat';
import ChatSidebar, { ChatSidebarRef } from './components/ChatSidebar';

export default function PageContent() {
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>();
  const [userId, setUserId] = useState<string | null>(null);
  const [sidebarLockedOff, setSidebarLockedOff] = useState<boolean>(false);
  const [showSidebar, setShowSidebar] = useState<boolean>(false);
  const sidebarRef = useRef<ChatSidebarRef>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);

  // Extract user ID and sidebar preference from URL params
  useEffect(() => {
    setMounted(true);
    const sidebarParam = searchParams?.get('sidebar');
    const userToken = searchParams?.get('user_token');
    setUserId(userToken || null);
    setSidebarLockedOff(sidebarParam === 'false');
    if (sidebarParam === 'false') {
      setShowSidebar(false);
    } else if (sidebarParam === 'true') {
      setShowSidebar(true);
    } else {
      // No explicit URL override; prefer persisted value, then screen size
      try {
        const persisted = window.localStorage.getItem('np_sidebar_open');
        if (persisted === 'true') setShowSidebar(true);
        else if (persisted === 'false') setShowSidebar(false);
        else setShowSidebar(window.innerWidth >= 768);
      } catch {
        setShowSidebar(typeof window !== 'undefined' ? window.innerWidth >= 768 : false);
      }
    }
  }, [searchParams]);

  // Persist sidebar state
  useEffect(() => {
    try {
      window.localStorage.setItem('np_sidebar_open', showSidebar ? 'true' : 'false');
    } catch {}
  }, [showSidebar]);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSidebar(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close on route/search changes (useful when navigating)
  useEffect(() => {
    // Keep lock state synced with URL param
    const urlParam = searchParams?.get('sidebar');
    setSidebarLockedOff(urlParam === 'false');
    if (urlParam === 'false') setShowSidebar(false);

    // Only auto-close on small screens
    if (mounted && typeof window !== 'undefined' && window.innerWidth < 768) {
      setShowSidebar(false);
    }

  }, [pathname, searchParams, mounted]);

  const handleNewChat = () => {
    setCurrentConversationId(undefined);
  };

  const handleSelectChat = (conversationId: string) => {
    setCurrentConversationId(conversationId);
  };

  const handleConversationChange = (conversationId: string, title: string, lastMessage: string) => {
    // Update the current conversation ID
    setCurrentConversationId(conversationId);

    // Add to chat history in sidebar
    if (sidebarRef.current) {
      sidebarRef.current.addToHistory(conversationId, title, lastMessage);
    }
  };

  // If URL locks sidebar off, show only the chat panel
  if (sidebarLockedOff) {
    return (
      <div className="h-screen w-full bg-gray-50">
        <Chat
          conversationId={currentConversationId}
          onConversationChange={handleConversationChange}
          noBorder={false}
          userId={userId}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Desktop sidebar (md and up) */}
      <div className="hidden md:block">
        <ChatSidebar
          ref={sidebarRef}
          onNewChat={handleNewChat}
          onSelectChat={handleSelectChat}
          currentConversationId={currentConversationId}
          userId={userId}
        />
      </div>

      {/* Mobile overlay sidebar */}
      {mounted && showSidebar && (
        <div className="fixed md:hidden inset-0 z-40">
          {/* Backdrop with fade */}
          <div
            className="absolute inset-0 bg-black/30 transition-opacity duration-200 opacity-100"
            onClick={() => setShowSidebar(false)}
            aria-hidden="true"
          />
          {/* Sliding panel */}
          <div className="relative h-full w-[80%] max-w-[20rem] transition-transform duration-300 translate-x-0">
            <ChatSidebar
              ref={sidebarRef}
              onNewChat={() => { setShowSidebar(false); handleNewChat(); }}
              onSelectChat={(id) => { setShowSidebar(false); handleSelectChat(id); }}
              currentConversationId={currentConversationId}
              userId={userId}
            />
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden shadow-lg border border-gray-200">
        {!sidebarLockedOff && (
          <header className="bg-white border-b border-gray-200 px-3 sm:px-4 md:px-6 py-2 sm:py-3 md:py-4 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* Mobile hamburger (hidden when sidebar=false is forced via URL) */}
                {!sidebarLockedOff && (
                  <button
                    type="button"
                    className="md:hidden inline-flex items-center justify-center p-2 rounded-md border border-gray-300 hover:bg-gray-100 text-gray-700"
                    aria-label="Toggle sidebar"
                    onClick={() => setShowSidebar((v) => !v)}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </button>
                )}
                <div>
                  <h1 className="text-base sm:text-lg md:text-xl font-semibold text-gray-800 flex items-center gap-2">
                    <svg className="w-5 h-5 sm:w-6 sm:h-6 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.663M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Needpedia Assistant
                  </h1>
                  <p className="text-xs sm:text-sm text-gray-600 flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Powered by Lotte - Your AI librarian
                  </p>
                </div>
              </div>
            </div>
          </header>
        )}

        <div className="flex-1 p-2 sm:p-3 md:p-6 min-h-0">
          <Chat
            conversationId={currentConversationId}
            onConversationChange={handleConversationChange}
            userId={userId}
          />
        </div>
      </main>
    </div>
  );
}