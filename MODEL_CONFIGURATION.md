# Model Configuration Guide

## Overview
The application now supports configurable models through environment variables. This allows you to easily switch between different AI models that support function calling.

## Current Configuration

### Environment Variable
- **Variable Name**: `OPENROUTER_MODEL`
- **Default**: `mistralai/mistral-7b-instruct:free`
- **Location**: Set in `.env.local` file

### Supported Models

#### 1. Mistral 7B Instruct (Default)
- **Model ID**: `mistralai/mistral-7b-instruct:free`
- **Provider**: Mistral AI
- **Cost**: Free
- **Function Calling**: ✅ Supported
- **Notes**: Open-source model that supports function calling and tool use

#### 2. Qwen 2.5 Coder
- **Model ID**: `qwen/qwen-2.5-coder:free`
- **Provider**: Qwen
- **Cost**: Free
- **Function Calling**: ✅ Supported
- **Notes**: Good for function calling, optimized for code and tools

#### 3. Other Free Models
You can explore other free models with function calling support on [OpenRouter](https://openrouter.ai/models)

## How to Use

### Setting Up Environment Variable

1. Create or edit your `.env.local` file in the root directory:

```bash
# Use Mistral (default)
OPENROUTER_MODEL=mistralai/mistral-7b-instruct:free

# Or use Qwen
OPENROUTER_MODEL=qwen/qwen-2.5-coder:free
```

2. The model name will be used throughout the application automatically.

## Function Calling Support

The current model (`mistralai/mistral-7b-instruct:free`) **does support function calling**. The implementation includes:

- ✅ **find_content**: Search for content by type and query
- ✅ **create_content**: Create new content (subjects, problems, ideas)
- ✅ **edit_content**: Edit existing content

## Notes About MiniMax M2

MiniMax M2 is not available through OpenRouter at this time. If MiniMax models become available on OpenRouter in the future, you can add them using the same environment variable approach.

## Switching Models

To switch models, simply update the `OPENROUTER_MODEL` environment variable in your `.env.local` file and restart your development server:

```bash
npm run dev
```

The application will automatically use the new model for all chat requests.

## Finding Compatible Models

To find other models that support function calling:
1. Visit [OpenRouter Models](https://openrouter.ai/models)
2. Look for models with "Tools" or "Function Calling" support
3. Check if they're free or paid
4. Update your `OPENROUTER_MODEL` environment variable with the model ID

