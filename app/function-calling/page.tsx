'use client';

import { useState, useEffect } from 'react';
import Chat from '../components/Chat';

const FunctionCalling = () => {
    const [token, setToken] = useState<string | null>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const userToken = params.get('user_token');
        setToken(userToken);

        if (!userToken) {
            console.warn('No user token found in URL parameters');
        }
    }, []);

    return (
        <main className="min-h-screen p-8 bg-gray-100">
            <div className="container mx-auto">
                <div className="flex flex-col lg:flex-row gap-8">
                    <div className="w-full">
                        <Chat userId={token} />
                    </div>
                </div>
            </div>
        </main>
    );
};

export default FunctionCalling;