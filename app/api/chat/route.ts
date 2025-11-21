import { NextResponse } from 'next/server';
import { Message } from '@/types/chat';
import { SYSTEM_PROMPT } from '@/app/prompts/system';
import axios from 'axios';
import { conversationStore } from '@/utils/memory';
import { saveConversationToDisk } from '@/utils/conversationPersistence';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';

// Reuse connections to reduce handshake latency
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Short-lived cache for tool results to avoid duplicate backend calls
// Keyed by `${toolName}|${stableArgs}`
const toolResultCache: Map<string, { expiryMs: number; payload: unknown }> = new Map();
const TOOL_CACHE_TTL_MS = 5_000; // 5 seconds dedupe window

const openRouterClient = axios.create({
  baseURL: 'https://openrouter.ai/api/v1',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
  },
  httpAgent,
  httpsAgent,
  timeout: 60_000,
});

// Cache successful token checks briefly to avoid extra network hops
const tokenCheckCache: Map<string, { expiryMs: number; remaining: number }> = new Map();

// Limit the number of prior messages sent to the model to cut prompt latency
const MAX_CONTEXT_MESSAGES = Number(process.env.CHAT_MAX_CONTEXT || 16);
const MAX_STORED_MESSAGES = Number(process.env.CHAT_MAX_STORED || 64);

interface FindContentArgs {
  query: string;
  type?: string;
}

interface CreateContentArgs {
  title: string;
  description: string;
  content_type: string;
  parent_id?: string;
  confirm?: boolean;
}

interface EditContentArgs {
  content_id: string;
  changes: {
    title?: string;
    description?: string;
  };
  confirm?: boolean;
}

type FunctionArgs = FindContentArgs | CreateContentArgs | EditContentArgs;

interface FindContentResult {
  items: Array<{ title: string; type: string; id?: string; link?: string }>;
}

interface CreateContentResult {
  requires_confirmation?: boolean;
  preview?: {
    title: string;
    content_type: string;
    description: string;
    html: string;
    plain_text: string;
    parent_id?: string;
  };
  instructions?: string;
  post?: {
    link: string;
    title: string;
    content: string;
    post_type: string;
    curated: boolean;
    group_id?: string;
    disabled: boolean;
    private: boolean;
    problem?: string;
    subject?: string;
  };
}

interface EditContentResult {
  requires_confirmation?: boolean;
  preview?: {
    content_id: string;
    title?: string;
    description?: string;
    html?: string;
    plain_text?: string;
  };
  instructions?: string;
  post?: {
    link: string;
    title: string;
    content: string;
    post_type: string;
    curated: boolean;
    group_id?: string;
    disabled: boolean;
    private: boolean;
    problem?: string;
    subject?: string;
  };
}

type FunctionResult = FindContentResult | CreateContentResult | EditContentResult;

interface NeedpediaPost {
  id?: string | number;
  title?: string;
  post_type?: string;
  link?: string;
  url?: string;
  post_url?: string;
}

type NeedpediaContentBuckets = Partial<Record<'subjects' | 'problems' | 'ideas', NeedpediaPost[]>> & Record<string, NeedpediaPost[] | undefined>;
interface CreatePostPayload {
  post: {
    title: string;
    post_type: string;
    content: {
      body: string;
    };
    subject_id?: string;
    problem_id?: string;
  };
}

interface UpdatePostPayload {
  post: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const isNeedpediaPost = (value: unknown): value is NeedpediaPost => {
  if (!isRecord(value)) return false;
  return typeof value.title === 'string' || typeof value.post_type === 'string';
};

const normalizePostArray = (value: unknown): NeedpediaPost[] => {
  return Array.isArray(value) ? value.filter(isNeedpediaPost) : [];
};

type ToolFunction = (args: FunctionArgs) => Promise<FunctionResult>;
type ToolMap = Record<'find_content' | 'create_content' | 'edit_content', ToolFunction>;

type ToolResultMessage = Message & { role: 'tool'; tool_call_id: string; name: string };
type ExecutedToolResult = { name: keyof ToolMap; result: FunctionResult };
type UsageMetrics = {
  total_tokens?: number;
  total?: number;
  completion_tokens?: number;
};
type UsageEnvelope = { usage?: UsageMetrics };
type ErrorPayload = { error?: string | { message?: string } };

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const extractTokenCount = (usage?: UsageMetrics): number => {
  if (!usage) return 0;
  const total = usage.total_tokens ?? usage.total ?? usage.completion_tokens ?? 0;
  return Number.isFinite(total) ? Number(total) : 0;
};

const isFindContentArgs = (args: FunctionArgs): args is FindContentArgs => {
  return 'query' in args;
};

const isCreateContentArgs = (args: FunctionArgs): args is CreateContentArgs => {
  return 'title' in args && 'description' in args && 'content_type' in args;
};

const isEditContentArgs = (args: FunctionArgs): args is EditContentArgs => {
  return 'content_id' in args && 'changes' in args;
};

// Convert simple Markdown/plain text to minimal HTML suitable for rich text fields
const toRichHtml = (input: string): string => {
  const text = (input || '').replace(/\r\n/g, '\n');
  const lines = text.split(/\n/);
  const htmlParts: string[] = [];
  let listBuffer: string[] = [];
  const flushList = () => {
    if (listBuffer.length > 0) {
      htmlParts.push('<ul>');
      listBuffer.forEach(li => htmlParts.push(`<li>${li}</li>`));
      htmlParts.push('</ul>');
      listBuffer = [];
    }
  };
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const fmtInline = (s: string) => s
    // bold **text**
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // italic *text*
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // links
    .replace(/(https?:\/\/[^\s)]+)(?![^<]*>)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1<\/a>');
  lines.forEach(raw => {
    const line = raw.trimRight();
    if (!line.trim()) { flushList(); return; }
    const h3 = /^###\s+(.+)/.exec(line);
    if (h3) { flushList(); htmlParts.push(`<h3>${fmtInline(esc(h3[1]))}<\/h3>`); return; }
    const h2 = /^##\s+(.+)/.exec(line);
    if (h2) { flushList(); htmlParts.push(`<h2>${fmtInline(esc(h2[1]))}<\/h2>`); return; }
    const h1 = /^#\s+(.+)/.exec(line);
    if (h1) { flushList(); htmlParts.push(`<h1>${fmtInline(esc(h1[1]))}<\/h1>`); return; }
    const li = /^[-*]\s+(.+)/.exec(line);
    if (li) { listBuffer.push(fmtInline(esc(li[1]))); return; }
    flushList();
    htmlParts.push(`<p>${fmtInline(esc(line))}<\/p>`);
  });
  flushList();
  return htmlParts.join('\n');
};

const htmlToPlainText = (html: string): string => {
  if (!html) return '';
  let text = html;
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|h[1-6]|li|ul|ol|blockquote|section|article)\s*>/gi, '\n');
  text = text.replace(/<\s*(p|div|h[1-6]|li|ul|ol|blockquote|section|article)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'');
  text = text.split('\n').map(line => line.trimEnd()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
};

const getFunctions = (userToken?: string): ToolMap => ({
  'find_content': async (args: FunctionArgs): Promise<FindContentResult> => {
    if (!isFindContentArgs(args)) {
      throw new Error('Invalid arguments for content search');
    }

    const postType = (args.type || 'all').toLowerCase();
    const stableArgs = JSON.stringify({ query: args.query || '', type: postType });
    const cacheKey = `find_content|${stableArgs}`;
    const now = Date.now();
    const cached = toolResultCache.get(cacheKey);
    if (cached && cached.expiryMs > now) {
      return cached.payload as FindContentResult;
    }

    const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/posts`);
    url.searchParams.append('type', postType);
    url.searchParams.append('q[title_cont]', args.query);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`,
        ...(userToken ? { 'token': userToken } : {})
      }
    });

    const payload = await response.json().catch(() => ({} as { message?: string; content?: unknown }));
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} - ${payload?.message || response.statusText}`);
    }

    const content = payload?.content;
    let source: NeedpediaPost[] = [];
    if (Array.isArray(content)) {
      source = normalizePostArray(content);
    } else if (isRecord(content)) {
      const bucket = content as NeedpediaContentBuckets;
      if (postType === 'problem' || postType === 'problems') {
        source = normalizePostArray(bucket.problems);
      } else if (postType === 'idea' || postType === 'ideas') {
        source = normalizePostArray(bucket.ideas);
      } else {
        source = normalizePostArray(bucket.subjects);
      }

      if (source.length === 0) {
        const fallbackArray = Object.values(bucket).find(Array.isArray);
        source = normalizePostArray(fallbackArray);
      }
    }

    const items = source.map((item): FindContentResult['items'][number] => ({
      title: item.title || 'Untitled',
      type: item.post_type || postType,
      id: item.id !== undefined ? String(item.id) : undefined,
      link: item.link || item.url || item.post_url || undefined
    }));

    const result: FindContentResult = { items };
    toolResultCache.set(cacheKey, { expiryMs: now + TOOL_CACHE_TTL_MS, payload: result });
    return result;
  },
  'create_content': async (args: FunctionArgs): Promise<CreateContentResult> => {
    if (!isCreateContentArgs(args)) {
      throw new Error('Invalid arguments for content creation');
    }

    const htmlBody = toRichHtml(args.description || '');
    const plainText = htmlToPlainText(htmlBody);
    const previewPayload = {
      title: args.title,
      content_type: args.content_type,
      description: args.description,
      html: htmlBody,
      plain_text: plainText,
      parent_id: args.parent_id
    };

    if (!args.confirm) {
      return {
        requires_confirmation: true,
        preview: previewPayload,
        instructions: 'Please confirm this post before creation by calling create_content again with "confirm": true.'
      };
    }

    const postData: CreatePostPayload = {
      post: {
        title: args.title || '',
        post_type: args.content_type || '',
        content: {
          body: htmlBody
        }
      }
    };

    if (args.content_type === 'problem' && args.parent_id) {
      postData.post.subject_id = args.parent_id;
    } else if (args.content_type === 'idea' && args.parent_id) {
      postData.post.problem_id = args.parent_id;
    }

    const apiUrl = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/posts`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`,
        ...(userToken ? { 'token': userToken } : {})
      },
      body: JSON.stringify(postData)
    });

    const payload = await response.json().catch(() => ({} as { message?: string; content?: { post?: CreateContentResult['post'] } }));
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} - ${payload?.message || response.statusText}`);
    }

    return {
      post: payload.content?.post
    };
  },
  'edit_content': async (args: FunctionArgs): Promise<EditContentResult> => {
    if (!isEditContentArgs(args)) {
      throw new Error('Invalid arguments for content editing');
    }

    const { content_id, changes } = args;
    const { title, description } = changes;
    const html = description ? toRichHtml(description) : undefined;
    const plainText = html ? htmlToPlainText(html) : undefined;
    const previewPayload = {
      content_id,
      title,
      description,
      html,
      plain_text: plainText
    };

    if (!args.confirm) {
      return {
        requires_confirmation: true,
        preview: previewPayload,
        instructions: 'Please confirm this edit by calling edit_content again with "confirm": true.'
      };
    }

    const postData: UpdatePostPayload = {
      post: {}
    };

    if (title) postData.post.title = title;
    if (description && html) {
      postData.post.content = { body: html };
      postData.post.content_attributes = { body: html };
    }

    const apiUrl = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/posts/${content_id}/api_update`;
    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`,
        ...(userToken ? { 'token': userToken } : {})
      },
      body: JSON.stringify(postData)
    });

    const payload = await response.json().catch(() => ({} as { message?: string; content?: { post?: EditContentResult['post'] } }));
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} - ${payload?.message || response.statusText}`);
    }

    return {
      post: payload.content?.post
    };
  }
});

const replacePlaceholderLinksWithToolUrls = (text: string, toolResults: ExecutedToolResult[]): string => {
  if (!text) return text;
  const links = toolResults
    .filter(result => result.name === 'find_content')
    .flatMap(result => {
      const items = (result.result as FindContentResult)?.items ?? [];
      return items
        .map(item => item.link)
        .filter((link): link is string => typeof link === 'string' && link.trim().length > 0);
    });
  if (links.length === 0) return text;

  let linkIndex = 0;
  return text.replace(/\[([^\]]+)\]\(#\)/g, (match, label) => {
    if (linkIndex >= links.length) return match;
    const url = links[linkIndex++];
    return `[${label}](${url})`;
  });
};

// Define available tools
const availableTools = [
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
            description: 'The type of content to search for (subject, problem, idea, or all). Defaults to "all" if not specified.',
          }
        },
        required: ['query'],
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_content',
      description: 'Create new content (subject, problem, or idea)',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the content',
          },
          description: {
            type: 'string',
            description: 'The description/body of the content',
          },
          content_type: {
            type: 'string',
            description: 'The type of content: subject, problem, or idea',
          },
          parent_id: {
            type: 'string',
            description: 'The parent ID (subject_id for problems, problem_id for ideas)',
          },
          confirm: {
            type: 'boolean',
            description: 'Set to true only after the user reviews the preview and approves creation.'
          }
        },
        required: ['title', 'description', 'content_type'],
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_content',
      description: 'Edit existing content',
      parameters: {
        type: 'object',
        properties: {
          content_id: {
            type: 'string',
            description: 'The ID of the content to edit',
          },
          changes: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'New title for the content',
              },
              description: {
                type: 'string',
                description: 'New description for the content',
              }
            },
            description: 'The changes to apply to the content',
          },
          confirm: {
            type: 'boolean',
            description: 'Set to true only after the user reviews the edit preview and approves updating.'
          }
        },
        required: ['content_id', 'changes'],
      }
    }
  }
];

export async function POST(req: Request) {
  try {
    const {
      messages = [],
      conversationId,
      userToken
    } = await req.json() as {
      messages?: Message[];
      conversationId?: string;
      userToken?: string;
    };

    const id: string = conversationId || randomUUID();

    // Require user token and check available tokens before proceeding
    if (!userToken) {
      return NextResponse.json(
        { error: 'Unauthenticated: missing user token' },
        { status: 401 }
      );
    }

    // Token check with short-lived cache
    try {
      const cached = tokenCheckCache.get(userToken);
      const now = Date.now();
      if (!cached || cached.expiryMs < now) {
        const tokensCheckUrl = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/tokens`;
        const tokensResp = await fetch(tokensCheckUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`
          },
          body: JSON.stringify({ utoken: userToken })
        });

        if (!tokensResp.ok) {
          const err = (await tokensResp.json().catch(() => ({}))) as { message?: string };
          const msg = err?.message || 'Insufficient tokens';
          return NextResponse.json({ error: msg, tokens: 0 }, { status: 402 });
        }

        const tokensData = (await tokensResp.json().catch(() => ({}))) as { tokens?: number };
        const remaining = tokensData?.tokens ?? 0;
        if (!remaining || remaining <= 0) {
          return NextResponse.json({ error: 'Insufficient tokens', tokens: 0 }, { status: 402 });
        }
        // Cache positive result for 60s
        tokenCheckCache.set(userToken, { expiryMs: now + 60_000, remaining });
      }
    } catch (e: unknown) {
      return NextResponse.json({ error: 'Token verification failed' }, { status: 500 });
    }

    const existingHistory = conversationStore.get(id) || [];
    const hasSystem = existingHistory.some(m => m.role === 'system');

    const baseHistory: Message[] = hasSystem
      ? existingHistory
      : [{ role: 'system', content: SYSTEM_PROMPT }, ...existingHistory];

    // Reduce context size to speed up prompt and model latency
    const requestMessages: Message[] = (() => {
      const joined = [...baseHistory, ...messages];
      if (joined.length <= MAX_CONTEXT_MESSAGES) return joined;
      // Always keep system prompt at the start and trim the middle
      const system = joined[0]?.role === 'system' ? [joined[0]] : [];
      const tail = joined.slice(-Math.max(1, MAX_CONTEXT_MESSAGES - system.length));
      return [...system, ...tail];
    })();

    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OpenRouter API key is not configured');
    }

    // Use the model from environment variable, fallback to default
    const model = process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';
    
    // Track total tokens used across one logical response
    let usedTokens = 0;

    // First API call
    const response = await openRouterClient.post('/chat/completions', {
      model: model,
      messages: requestMessages,
      tools: availableTools,
      tool_choice: 'auto',
      extra_headers: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
        'X-Title': 'AI Chat Assistant',
      },
      extra_body: {},
    });

    // Capture usage from first call if present
    try {
      const usage = (response.data as UsageEnvelope)?.usage;
      usedTokens += extractTokenCount(usage);
    } catch {
      // Ignore usage parsing errors
    }

    if (!response.data?.choices?.[0]?.message) {
      throw new Error('Invalid response from OpenRouter API');
    }

    let assistantMessage: Message = response.data.choices[0].message;

    // Handle tool calls iteratively to allow multiple rounds until the model finishes
    const funcs = getFunctions(userToken);
    const executedToolResults: ExecutedToolResult[] = [];
    let safetyCounter = 0; // prevent infinite loops
    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0 && safetyCounter < 5) {
      safetyCounter++;
      const toolCalls = assistantMessage.tool_calls;
      const toolResults: ToolResultMessage[] = [];
      // Per-round dedupe to avoid executing the same tool with identical args more than once
      const roundMemo = new Map<string, { name: string; content: string }>();

      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const { name, arguments: argsString } = toolCall.function;

        const args = JSON.parse(argsString || '{}') as FunctionArgs;
        const stableArgs = JSON.stringify(args);
        const roundKey = `${name}|${stableArgs}`;

        try {
          if (roundMemo.has(roundKey)) {
            const cached = roundMemo.get(roundKey)!;
            toolResults.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: cached.name,
              content: cached.content
            });
          } else {
            const toolFunction = funcs[name as keyof typeof funcs];
            if (!toolFunction) {
              const unsupportedPayload = JSON.stringify({ error: `Unsupported tool: ${name}` });
              toolResults.push({
                tool_call_id: toolCall.id,
                role: 'tool',
                name,
                content: unsupportedPayload
              });
              continue;
            }

            const result = await toolFunction(args);
            executedToolResults.push({ name: name as keyof ToolMap, result });

            const payload = JSON.stringify(result);
            roundMemo.set(roundKey, { name, content: payload });
            toolResults.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name,
              content: payload
            });
          }
        } catch (error: unknown) {
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name,
            content: JSON.stringify({ error: getErrorMessage(error) })
          });
        }
      }

      const updatedMessages = [...requestMessages, assistantMessage, ...toolResults];
      const followupResponse = await openRouterClient.post('/chat/completions', {
        model,
        messages: updatedMessages,
        tools: availableTools,
        tool_choice: 'auto',
        extra_headers: {
          'HTTP-Referer': process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
          'X-Title': 'AI Chat Assistant',
        },
        extra_body: {},
      });
      assistantMessage = followupResponse.data.choices[0].message;

      // Capture usage from follow-up call(s)
      try {
        const usage = (followupResponse.data as UsageEnvelope)?.usage;
        usedTokens += extractTokenCount(usage);
      } catch {
        // Ignore usage parsing errors
      }
      
      // If the assistant message has no content and no more tool_calls, request a text response
      if (!assistantMessage.content && (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0)) {
        const finalResponse = await openRouterClient.post('/chat/completions', {
          model,
          messages: updatedMessages,
          tools: availableTools,
          tool_choice: 'none', // Force text response
          extra_headers: {
            'HTTP-Referer': process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
            'X-Title': 'AI Chat Assistant',
          },
          extra_body: {},
        });
        assistantMessage = finalResponse.data.choices[0].message;
        
        // Capture usage from final call
        try {
          const usage = (finalResponse.data as UsageEnvelope)?.usage;
          usedTokens += extractTokenCount(usage);
        } catch {
          // Ignore usage parsing errors
        }
        break; // Exit the loop after forcing a text response
      }
    }
    
    // Ensure assistant message has content - if still empty after all processing, provide a fallback
    if (!assistantMessage.content || assistantMessage.content.trim() === '') {
      assistantMessage = {
        ...assistantMessage,
        content: assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0
          ? 'I\'ve processed your request using the available tools. Please let me know if you need any additional information.'
          : 'I\'ve processed your request. Please let me know if you need any additional information.'
      };
    }

    assistantMessage = {
      ...assistantMessage,
      content: replacePlaceholderLinksWithToolUrls(assistantMessage.content, executedToolResults)
    };

    // Persist conversation: append incoming user messages and assistant response
    const toAppend: Message[] = [...messages];
    if (assistantMessage) {
      toAppend.push(assistantMessage);
    }
    const persistedHistory = conversationStore.append(id, toAppend, MAX_STORED_MESSAGES);
    saveConversationToDisk(id, persistedHistory).catch(() => {});

    // Best-effort token decrement after successful completion
    (async () => {
      try {
        const decUrl = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/tokens/decrease`;
        await fetch(decUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`
          },
          body: JSON.stringify({ utoken: userToken, decrement_by: Math.max(1, usedTokens || 0) })
        });
      } catch {
        // Ignored
      }
    })();

    return NextResponse.json({
      conversationId: id,
      choices: [{
        message: assistantMessage
      }],
      usedTokens: Math.max(0, usedTokens)
    });
  } catch (error: unknown) {
    const axiosError = axios.isAxiosError(error) ? error : undefined;
    const responseData = axiosError?.response?.data as ErrorPayload | undefined;
    return NextResponse.json(
      { 
        error: typeof responseData?.error === 'string' 
          ? responseData.error 
          : responseData?.error?.message || getErrorMessage(error)
      },
      { status: axiosError?.response?.status || 500 }
    );
  }
}