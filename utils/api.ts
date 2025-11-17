import { APIError, ToolCall } from '@/types/api';

export const makeAPIRequest = async (url: string, method: string, token: string | null, body?: any) => {
  try {
    console.log(`Making ${method} request to: ${url}`);

    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (token) {
      headers.token = token;
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('API Error Response:', {
        status: response.status,
        statusText: response.statusText,
        body: errorData
      });
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('API Response:', data);
    return data;
  } catch (error) {
    console.error('Request error:', error);
    throw error;
  }
};

export const handleToolCall = async (
  toolCall: ToolCall,
  token: string | null,
  setError: (error: string) => void
) => {
  if (!token) {
    console.warn('No token available');
    return;
  }

  try {
    if (toolCall?.function?.name === "find_content") {
      const { query, type } = JSON.parse(toolCall.function.arguments);
      const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/v1/posts`);
      url.searchParams.append('type', type);
      url.searchParams.append('q[title_cont]', query);

      const data = await makeAPIRequest(url.toString(), 'GET', token);
      return JSON.stringify(data);
    }
  } catch (error) {
    console.error('Tool call handler error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    setError(errorMessage);
    throw error;
  }
};