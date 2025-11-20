import { NextResponse } from 'next/server';
import { Message } from '@/types/chat';
import { SYSTEM_PROMPT } from '@/app/prompts/system';
import axios from 'axios';
import { conversationStore } from '@/utils/memory';
import { saveConversationToDisk } from '@/utils/conversationPersistence';
import { randomUUID } from 'crypto';
import { ToolCall } from '@/types/api';
import http from 'http';
import https from 'https';

// Reuse connections to reduce handshake latency
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Short-lived cache for tool results to avoid duplicate backend calls
// Keyed by `${toolName}|${stableArgs}`
const toolResultCache: Map<string, { expiryMs: number; payload: any }> = new Map();
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

const isFindContentArgs = (args: FunctionArgs): args is FindContentArgs => {
  return 'query' in args;
};

const isCreateContentArgs = (args: FunctionArgs): args is CreateContentArgs => {
  return 'title' in args && 'description' in args && 'content_type' in args;
};

const isEditContentArgs = (args: FunctionArgs): args is EditContentArgs => {
  return 'content_id' in args && 'changes' in args;
};

// Store for user tokens (in a real app, use a more secure storage)
const userTokens: Map<string, string> = new Map();

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

const logContentPreview = (label: string, content?: string) => {
  const text = (content || '').trim();
  if (!text) {
    console.log(`   ${label}: <empty>`);
    return;
  }
  const maxLength = 600;
  const truncated = text.length > maxLength;
  const preview = truncated ? `${text.slice(0, maxLength)}…` : text;
  console.log(`   ${label} (${text.length} chars):`);
  preview.split('\n').forEach(line => console.log(`      ${line}`));
  if (truncated) {
    console.log(`      …(truncated)`);
  }
};

const getFunctions = (userToken?: string, token?: string) => ({
  'find_content': async (args: FunctionArgs): Promise<FindContentResult> => {
    if (!isFindContentArgs(args)) {
      throw new Error('Invalid arguments for content search');
    }
    
    // Default to "all" if type is not specified
    const postType = args.type || 'all';
    
    console.log(`\n🔍 [find_content] Starting search`);
    console.log(`   Query: "${args.query}"`);
    console.log(`   Type: "${postType}"`);
    console.log(`   User Token: ${userToken ? 'Present' : 'Not provided'}`);
    
    // In-memory dedupe to prevent repeated identical calls in quick succession
    const stableArgs = JSON.stringify({ query: args.query || '', type: postType.toLowerCase() });
    const cacheKey = `find_content|${stableArgs}`;
    const now = Date.now();
    const cached = toolResultCache.get(cacheKey);
    if (cached && cached.expiryMs > now) {
      console.log(`   🗂️ Using cached result for find_content`);
      return cached.payload as FindContentResult;
    }
    
    // Make API call to Needpedia backend
    const url = new URL(`${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/posts`);
    url.searchParams.append('type', postType);
    url.searchParams.append('q[title_cont]', args.query);

    console.log(`   🔗 API URL: ${url.toString()}`);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`,
        ...(userToken ? { 'token': userToken } : {})
      },
    });

    console.log(`   📡 Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`   ❌ API error:`, errorData);
      throw new Error(`API request failed: ${response.status} - ${errorData.message || response.statusText}`);
    }

    const data = await response.json();
    const t = postType.toLowerCase();
    let source: any[] = [];

    // Support both response shapes:
    // 1) { status, message, content: [ ...items ] }
    // 2) { status, message, content: { subjects: [], problems: [], ideas: [] } }
    const content = data?.content;
    if (Array.isArray(content)) {
      source = content;
    } else if (content && typeof content === 'object') {
      if (t === 'problem' || t === 'problems') {
        source = Array.isArray((content as any).problems) ? (content as any).problems : [];
      } else if (t === 'idea' || t === 'ideas') {
        source = Array.isArray((content as any).ideas) ? (content as any).ideas : [];
      } else {
        source = Array.isArray((content as any).subjects) ? (content as any).subjects : [];
      }
      // Fallback: if specific buckets are empty but content object looks like a flat item
      if (!Array.isArray(source) || source.length === 0) {
        // Some backends may return a single item object; normalize to array
        if (content && !Array.isArray(content)) {
          const maybeArray = (Object.values(content as any).find(v => Array.isArray(v)) as any[]) || [];
          if (maybeArray.length > 0) {
            source = maybeArray;
          }
        }
      }
    } else {
      source = [];
    }

    const items = source.map((item: any) => ({
      title: item.title,
      type: item.post_type || t,
      id: item.id,
      link: item.link || item.url || item.post_url || undefined
    }));
    
    console.log(`   ✅ Found ${items.length} items`);
    const result: FindContentResult = { items };
    toolResultCache.set(cacheKey, { expiryMs: now + TOOL_CACHE_TTL_MS, payload: result });
    return result;
  },
  'create_content': async (args: FunctionArgs): Promise<CreateContentResult> => {
    if (!isCreateContentArgs(args)) {
      throw new Error('Invalid arguments for content creation');
    }

    console.log(`\n✍️  [create_content] Creating new post`);
    console.log(`   Title: "${args.title}"`);
    console.log(`   Type: "${args.content_type}"`);
    console.log(`   Parent ID: ${args.parent_id || 'None'}`);
    console.log(`   User Token: ${userToken ? 'Present' : 'Not provided'}`);

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
      console.log(`   ⚠️  Confirmation not provided. Returning preview instead of creating post.`);
      logContentPreview('Raw description', args.description);
      logContentPreview('HTML body preview', htmlBody);
      logContentPreview('Plain text preview', plainText);
      return {
        requires_confirmation: true,
        preview: previewPayload,
        instructions: 'Please confirm this post before creation by calling create_content again with "confirm": true.'
      };
    }

    logContentPreview('Raw description', args.description);

    const postData: any = {
      post: {
        title: args.title || '',
        post_type: args.content_type || '',
        content: {
          // Backend expects rich text; convert description to HTML
          body: htmlBody
        }
      }
    };
    logContentPreview('HTML body preview', postData.post.content.body);
    logContentPreview('Plain text preview', plainText);

    if (args.content_type === "problem" && args.parent_id) {
      postData.post.subject_id = args.parent_id;
    } else if (args.content_type === "idea" && args.parent_id) {
      postData.post.problem_id = args.parent_id;
    }

    console.log(`   📦 Request body:`, JSON.stringify(postData, null, 2));
    const apiUrl = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/api/v1/posts`;
    console.log(`   🔗 API URL: ${apiUrl}`);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.POST_TOKEN || ''}`,
        ...(userToken ? { 'token': userToken } : {})
      },
      body: JSON.stringify(postData)
    });

    console.log(`   📡 Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`   ❌ API error:`, errorData);
      throw new Error(`API request failed: ${response.status} - ${errorData.message || response.statusText}`);
    }

    const data = await response.json();
    console.log(`   ✅ Post created successfully`);
    console.log(`   📝 Post data:`, JSON.stringify(data.content?.post, null, 2));
    
    return {
      post: data.content.post
    };
  },
  'edit_content': async (args: FunctionArgs): Promise<EditContentResult> => {
    if (!isEditContentArgs(args)) {
      throw new Error('Invalid arguments for content editing');
    }

    const { content_id, changes } = args;
    const { title, description } = changes;

    console.log(`\n✏️  [edit_content] Editing post`);
    console.log(`   Post ID: ${content_id}`);
    console.log(`   New title: ${title || 'Unchanged'}`);
    console.log(`   New description: ${description ? 'Updated' : 'Unchanged'}`);
    console.log(`   User Token: ${userToken ? 'Present' : 'Not provided'}`);

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
      console.log(`   ⚠️  Confirmation not provided. Returning edit preview instead of updating post.`);
      if (description) {
        logContentPreview('New description (raw)', description);
        logContentPreview('New description (HTML)', html);
        logContentPreview('New description (plain text)', plainText);
      }
      return {
        requires_confirmation: true,
        preview: previewPayload,
        instructions: 'Please confirm this edit by calling edit_content again with "confirm": true.'
      };
    }

    const postData: any = {
      post: {}
    };

    if (title) postData.post.title = title;
    if (description) {
      postData.post.content = { body: html };
      // Some backends expect nested attributes naming
      postData.post.content_attributes = { body: html };
      logContentPreview('New description (raw)', description);
      logContentPreview('New description (HTML)', html);
      logContentPreview('New description (plain text)', plainText);
    }

    console.log(`   📦 Request body:`, JSON.stringify(postData, null, 2));
    const apiUrl = `${process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}/posts/${content_id}/api_update`;
    console.log(`   🔗 API URL: ${apiUrl}`);

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

    console.log(`   📡 Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`   ❌ API error:`, errorData);
      throw new Error(`API request failed: ${response.status} - ${errorData.message || response.statusText}`);
    }

    const data = await response.json();
    console.log(`   ✅ Post updated successfully`);
    console.log(`   📝 Updated post:`, JSON.stringify(data.content?.post, null, 2));
    
    return {
      post: data.content.post
    };
  }
});

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
    const { messages = [], conversationId, userToken } = await req.json();

    console.log('Chat API Request:', { 
      messageCount: messages?.length, 
      conversationId,
      hasApiKey: !!process.env.OPENROUTER_API_KEY,
      apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
      hasUserToken: !!userToken
    });

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
          const err = await tokensResp.json().catch(() => ({} as any));
          const msg = err?.message || 'Insufficient tokens';
          return NextResponse.json({ error: msg, tokens: 0 }, { status: 402 });
        }

        const tokensData = await tokensResp.json().catch(() => ({} as any));
        const remaining = tokensData?.tokens ?? 0;
        if (!remaining || remaining <= 0) {
          return NextResponse.json({ error: 'Insufficient tokens', tokens: 0 }, { status: 402 });
        }
        // Cache positive result for 60s
        tokenCheckCache.set(userToken, { expiryMs: now + 60_000, remaining });
      }
    } catch (e: any) {
      console.error('Token check error:', e);
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
    
    console.log(`Using model: ${model}`);

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

    console.log('OpenRouter Response:', {
      hasChoices: !!response.data?.choices,
      choiceCount: response.data?.choices?.length,
      message: response.data?.choices?.[0]?.message,
      hasToolCalls: !!response.data?.choices?.[0]?.message?.tool_calls
    });

    // Capture usage from first call if present
    try {
      const usage = (response.data as any)?.usage;
      if (usage) {
        const total = Number(usage.total_tokens || usage.total || usage.completion_tokens || 0);
        usedTokens += isNaN(total) ? 0 : total;
      }
    } catch (_) {}

    if (!response.data?.choices?.[0]?.message) {
      throw new Error('Invalid response from OpenRouter API');
    }

    let assistantMessage: Message = response.data.choices[0].message;

    // Handle tool calls iteratively to allow multiple rounds until the model finishes
    const funcs = getFunctions(userToken);
    let safetyCounter = 0; // prevent infinite loops
    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0 && safetyCounter < 5) {
      safetyCounter++;
      console.log(`\n🔧 Tool Calls Detected: Processing ${assistantMessage.tool_calls.length} tool call(s)`);
      const toolCalls = assistantMessage.tool_calls;
      const toolResults: any[] = [];
      // Per-round dedupe to avoid executing the same tool with identical args more than once
      const roundMemo = new Map<string, { name: string; content: string }>();

      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const { name, arguments: argsString } = toolCall.function;

        console.log(`\n📞 Function Call #${i + 1}:`);
        console.log(`  Function Name: ${name}`);
        console.log(`  Tool Call ID: ${toolCall.id}`);
        console.log(`  Arguments: ${argsString}`);

        const args = JSON.parse(argsString || '{}');
        const stableArgs = JSON.stringify(args);
        const roundKey = `${name}|${stableArgs}`;

        try {
          if (roundMemo.has(roundKey)) {
            console.log(`  ♻️ Reusing result for duplicate call: ${name}`);
            const cached = roundMemo.get(roundKey)!;
            toolResults.push({
              tool_call_id: toolCall.id,
              role: 'tool' as const,
              name: cached.name,
              content: cached.content
            });
          } else {
            console.log(`  ➡️  Calling function: ${name}`);
            console.log(`  📝 Function arguments:`, JSON.stringify(args, null, 2));

            const startTime = Date.now();
            const result = await (funcs as any)[name](args);
            const duration = Date.now() - startTime;

            console.log(`  ✅ Function '${name}' completed successfully in ${duration}ms`);
            console.log(`  📤 Result:`, JSON.stringify(result, null, 2));

            const payload = JSON.stringify(result);
            roundMemo.set(roundKey, { name, content: payload });
            toolResults.push({
              tool_call_id: toolCall.id,
              role: 'tool' as const,
              name,
              content: payload
            });
          }
        } catch (error: any) {
          console.error(`  ❌ Error executing function '${name}':`, error);
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            name,
            content: JSON.stringify({ error: error?.message || 'Unknown tool error' })
          });
        }
      }

      console.log(`\n✅ All ${toolCalls.length} tool calls completed. Sending results back to model.`);

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
        const usage = (followupResponse.data as any)?.usage;
        if (usage) {
          const total = Number(usage.total_tokens || usage.total || usage.completion_tokens || 0);
          usedTokens += isNaN(total) ? 0 : total;
        }
      } catch (_) {}
      
      // If the assistant message has no content and no more tool_calls, request a text response
      if (!assistantMessage.content && (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0)) {
        console.log(`\n⚠️  Assistant message has no content after tool calls. Requesting final response.`);
        // Request one more time to get a text response
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
          const usage = (finalResponse.data as any)?.usage;
          if (usage) {
            const total = Number(usage.total_tokens || usage.total || usage.completion_tokens || 0);
            usedTokens += isNaN(total) ? 0 : total;
          }
        } catch (_) {}
        break; // Exit the loop after forcing a text response
      }
    }
    
    // Ensure assistant message has content - if still empty after all processing, provide a fallback
    if (!assistantMessage.content || assistantMessage.content.trim() === '') {
      console.log(`\n⚠️  Assistant message has no content after all processing. Using fallback message.`);
      assistantMessage = {
        ...assistantMessage,
        content: assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0
          ? 'I\'ve processed your request using the available tools. Please let me know if you need any additional information.'
          : 'I\'ve processed your request. Please let me know if you need any additional information.'
      };
    }

    // Persist conversation: append incoming user messages and assistant response
    const toAppend: Message[] = [...messages];
    if (assistantMessage) {
      toAppend.push(assistantMessage);
    }
    const persistedHistory = conversationStore.append(id, toAppend, MAX_STORED_MESSAGES);
    saveConversationToDisk(id, persistedHistory).catch((error) => {
      console.error('Failed to persist conversation to disk', error);
    });

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
      } catch (e) {
        console.error('Token decrement error:', e);
      }
    })();

    return NextResponse.json({
      conversationId: id,
      choices: [{
        message: assistantMessage
      }],
      usedTokens: Math.max(0, usedTokens)
    });
  } catch (error: any) {
    console.error('Chat API Error:', {
      message: error.message,
      response: error.response?.data
    });
    
    return NextResponse.json(
      { 
        error: typeof error.response?.data?.error === 'string' 
          ? error.response.data.error 
          : error.response?.data?.error?.message || error.message 
      },
      { status: error.response?.status || 500 }
    );
  }
}