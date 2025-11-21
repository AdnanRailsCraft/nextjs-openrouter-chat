export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ContentData {
  type: string;
  title: string;
  // Add other content fields as needed
}

export interface APIError {
  error: string;
  details?: unknown;
}