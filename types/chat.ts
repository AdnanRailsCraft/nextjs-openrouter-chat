export interface Message {
  role: 'user' | 'assistant' | 'system' | 'function';
  content: string;
  function_call?: {
    name: string;
    arguments: string;
  };
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