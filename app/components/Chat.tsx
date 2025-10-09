'use client';

import { useState } from 'react';
import { Message } from '@/types/chat';
import { ToolCall } from '@/types/api';

interface ChatProps {
  toolCallHandler?: (toolCall: ToolCall) => Promise<string | undefined>;
}

export default function Chat({ toolCallHandler }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const sendMessage = async (userMessage: Message) => {
    setError('');
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [...messages, userMessage],
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send message');
      }

      const assistantMessage = data.choices[0].message;
      setMessages(prev => [...prev, userMessage, assistantMessage]);

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
      await sendMessage(userMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-gray-50 rounded-lg shadow-lg">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 my-8">
            <p className="text-lg font-medium">Welcome to AI Chat Assistant!</p>
            <p className="mt-2">Start a conversation by sending a message below.</p>
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`relative p-4 rounded-2xl shadow-sm max-w-[80%] ${
                message.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-white text-gray-800'
              }`}
            >
              <div className="text-sm opacity-75 mb-1">
                {message.role === 'user' ? 'You' : 'AI Assistant'}
              </div>
              <div className="prose prose-sm max-w-none whitespace-pre-wrap">
                {message.content}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-center items-center p-4">
            <div className="flex items-center space-x-2 text-gray-500">
              <div className="w-3 h-3 rounded-full bg-gray-300 animate-bounce"></div>
              <div className="w-3 h-3 rounded-full bg-gray-300 animate-bounce delay-100"></div>
              <div className="w-3 h-3 rounded-full bg-gray-300 animate-bounce delay-200"></div>
            </div>
          </div>
        )}
      </div>
      
      <div className="border-t bg-white p-4 rounded-b-lg">
        {error && (
          <div className="mb-4 p-3 text-sm text-red-500 bg-red-50 rounded-lg">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            className="flex-1 p-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-800 placeholder-gray-400"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}