'use client';

import { useState, useEffect } from 'react';
import { ToolCall } from '@/types/api';
import Chat from '@/components/Chat';
import { makeAPIRequest, handleToolCall } from '@/utils/api';

const FunctionCalling = () => {
    const [token, setToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const userToken = params.get('user_token');
        setToken(userToken);

        if (!userToken) {
            console.warn('No user token found in URL parameters');
        }
    }, []);

    const toolCallHandler = async (toolCall: ToolCall) => {
        if (!token) {
            console.error('No token available');
            return;
        }

        try {
            return await handleToolCall(toolCall, token, setError);
        } catch (error) {
            console.error('Tool call handler error:', error);
            setError(error instanceof Error ? error.message : 'Unknown error occurred');
        }
    };

    return (
        <main className="min-h-screen p-8 bg-gray-100">
            <div className="container mx-auto">
                <div className="flex flex-col lg:flex-row gap-8">
                    <div className="w-full">
                        <Chat toolCallHandler={toolCallHandler} />
                    </div>
                </div>
            </div>
        </main>
    );
};

export default FunctionCalling;