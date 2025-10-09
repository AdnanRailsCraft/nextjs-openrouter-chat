import { NextResponse } from 'next/server';
import { Message } from '@/types/chat';
import axios from 'axios';

const openRouterClient = axios.create({
  baseURL: 'https://openrouter.ai/api/v1',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
  }
});

interface WeatherArgs {
  location: string;
}

interface ContentArgs {
  query: string;
  type: string;
}

type FunctionArgs = WeatherArgs | ContentArgs;

interface WeatherResult {
  temperature: number;
  unit: string;
  description: string;
  location: string;
}

interface ContentResult {
  items: Array<{ title: string; type: string }>;
}

type FunctionResult = WeatherResult | ContentResult;

const isWeatherArgs = (args: FunctionArgs): args is WeatherArgs => {
  return 'location' in args;
};

const isContentArgs = (args: FunctionArgs): args is ContentArgs => {
  return 'query' in args && 'type' in args;
};

const functions: Record<string, (args: FunctionArgs) => Promise<FunctionResult>> = {
  'get_current_weather': async (args: FunctionArgs): Promise<WeatherResult> => {
    if (!isWeatherArgs(args)) {
      throw new Error('Invalid arguments for weather function');
    }
    return {
      temperature: 22,
      unit: "celsius",
      description: "Sunny",
      location: args.location
    };
  },
  'find_content': async (args: FunctionArgs): Promise<ContentResult> => {
    if (!isContentArgs(args)) {
      throw new Error('Invalid arguments for content search');
    }
    return {
      items: [{ title: `Content about ${args.query}`, type: args.type }]
    };
  }
};

// Define available tools
const availableTools = [
  {
    type: 'function',
    function: {
      name: 'get_current_weather',
      description: 'Get the current weather in a given location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The city and country/state, e.g., "London, UK"',
          }
        },
        required: ['location'],
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_content',
      description: 'Search for content by type and query',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query for finding content',
          },
          type: {
            type: 'string',
            description: 'The type of content to search for',
          }
        },
        required: ['query', 'type'],
      }
    }
  }
];

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OpenRouter API key is not configured');
    }

    const response = await openRouterClient.post('/chat/completions', {
      model: 'qwen/qwen-2.5-72b-instruct:free',
      messages: messages,
      extra_headers: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'AI Chat Assistant',
      },
      extra_body: {},
    });

    if (!response.data?.choices?.[0]?.message) {
      throw new Error('Invalid response from OpenRouter API');
    }

    return NextResponse.json(response.data);
  } catch (error: any) {
    console.error('Chat API Error:', {
      message: error.message,
      response: error.response?.data
    });
    
    return NextResponse.json(
      { error: error.response?.data?.error || error.message },
      { status: error.response?.status || 500 }
    );
  }
}