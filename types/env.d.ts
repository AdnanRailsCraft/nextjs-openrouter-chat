declare namespace NodeJS {
  interface ProcessEnv {
    OPENROUTER_API_KEY: string;
    NEXT_PUBLIC_WEATHER_API_KEY: string; // For our sample weather function
  }
}