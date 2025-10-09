'use client';

import { useState, useEffect } from 'react';
import { WeatherData, ToolCall } from '@/types/api';
import Chat from '@/components/Chat';
import WeatherWidget from '@/components/WeatherWidget';
import { makeAPIRequest, handleToolCall } from '@/utils/api';

const FunctionCalling = () => {
    const [weatherData, setWeatherData] = useState<WeatherData>({});
    const [token, setToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const isEmpty = Object.keys(weatherData).length === 0;

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
            return await handleToolCall(toolCall, token, setWeatherData, setError);
        } catch (error) {
            console.error('Tool call handler error:', error);
            setError(error instanceof Error ? error.message : 'Unknown error occurred');
        }
    };

    return (
        <main className="min-h-screen p-8 bg-gray-100">
            <div className="container mx-auto">
                <div className="flex flex-col lg:flex-row gap-8">
                    <div className="lg:w-1/3">
                        <WeatherWidget
                            location={weatherData.location || "---"}
                            temperature={weatherData.temperature?.toString() || "---"}
                            conditions={weatherData.conditions || "Sunny"}
                            isEmpty={isEmpty}
                        />
                    </div>
                    <div className="lg:w-2/3">
                        <Chat toolCallHandler={toolCallHandler} />
                    </div>
                </div>
            </div>
        </main>
    );
};

export default FunctionCalling;