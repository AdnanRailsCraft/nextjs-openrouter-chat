declare namespace NodeJS {
  interface ProcessEnv {
    OPENROUTER_API_KEY: string;
    OPENROUTER_MODEL: string; // The model to use for the chat
    NEXT_PUBLIC_API_BASE_URL?: string;
    POST_TOKEN?: string;
  }
}