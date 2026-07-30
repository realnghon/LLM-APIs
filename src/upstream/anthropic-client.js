'use strict';

const crypto = require('crypto');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { generateText, streamText } = require('ai');

function textForSdk(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map(part => part?.type === 'text' && typeof part.text === 'string'
    ? part.text
    : JSON.stringify(part ?? '')).join('');
}

function contentForSdk(message) {
  if (message.role !== 'user' || !Array.isArray(message.content)) return textForSdk(message.content);
  return message.content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'image_url') {
      const image = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof image === 'string' && image) return { type: 'image', image };
    }
    return { type: 'text', text: JSON.stringify(part ?? '') };
  });
}

function messagesForSdk(messages) {
  return (messages || [])
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: contentForSdk(message),
    }));
}

function systemForSdk(messages) {
  return (messages || [])
    .filter(message => message.role === 'system')
    .map(message => textForSdk(message.content))
    .join('\n');
}

function tokenUsage(usage = {}) {
  const promptTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.totalTokens ?? (promptTokens + completionTokens)),
  };
}

function providerFor(account) {
  return createAnthropic({
    baseURL: String(account.base_url).replace(/\/+$/, ''),
    apiKey: account.api_key,
  });
}

function callOptions(account, body, upstreamModel, signal) {
  const options = {
    model: providerFor(account)(upstreamModel),
    messages: messagesForSdk(body.messages),
    maxOutputTokens: Number(body.max_tokens || body.max_completion_tokens || 4096),
    ...(signal ? { abortSignal: signal } : {}),
  };
  const system = systemForSdk(body.messages);
  if (system) options.system = system;
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.top_p !== undefined) options.topP = body.top_p;
  if (body.stop !== undefined) options.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return options;
}

function openAIResponse(result, requestedModel) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.text || '' },
      finish_reason: result.finishReason === 'length' ? 'length' : 'stop',
      logprobs: null,
    }],
    usage: tokenUsage(result.usage),
  };
}

function streamResponse(result, requestedModel) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = payload => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      try {
        for await (const text of result.textStream) {
          send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        }
        const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
        send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason === 'length' ? 'length' : 'stop' }], usage: tokenUsage(usage) });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

async function proxyAnthropic({ account, body, requestedModel, upstreamModel, signal }) {
  const options = callOptions(account, body, upstreamModel, signal);
  if (body.stream === true) return streamResponse(streamText(options), requestedModel);
  const result = await generateText(options);
  return Response.json(openAIResponse(result, requestedModel));
}

module.exports = { proxyAnthropic, tokenUsage };
