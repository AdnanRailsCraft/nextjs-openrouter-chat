export interface Message {
  role: 'user' | 'assistant' | 'system' | 'function' | 'tool';
  content: string;
  reasoning?: string;
  function_call?: {
    name: string;
    arguments: string;
  };
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatFunction {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, {
      type: string;
      description: string;
    }>;
    required: string[];
  };
}

export interface ChatResponse {
  id: string;
  choices: {
    message: Message;
    finish_reason: string;
  }[];
}