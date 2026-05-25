/**
 * Tool-calling shim for models without native tool support.
 *
 * Wraps a ModelProvider and, when tools are provided:
 * 1. Omits them from the API call
 * 2. Appends tool descriptions to the system prompt
 * 3. Parses the model's text output for JSON tool invocations
 *
 * This allows models like Llama-3.3-70B to participate in tool-using
 * workflows with best-effort reliability.
 */

import type {
  ChatResponse,
  ContentBlock,
  CreateMessageParams,
  ModelProvider,
  ToolDefinition,
} from "./types.ts";

let shimIdCounter = 0;

/**
 * Wrap a ModelProvider with text-based tool emulation.
 */
export class ToolShimProvider implements ModelProvider {
  readonly name: string;

  constructor(private inner: ModelProvider) {
    this.name = `${inner.name}+tool_shim`;
  }

  async createMessage(params: CreateMessageParams): Promise<ChatResponse> {
    if (!params.tools || params.tools.length === 0) {
      return this.inner.createMessage(params);
    }

    const toolDocs = formatToolDescriptions(params.tools);
    const augmentedSystem = `${params.system}\n\n${toolDocs}`;

    const response = await this.inner.createMessage({
      ...params,
      system: augmentedSystem,
      tools: undefined,
    });

    return parseToolCalls(response);
  }
}

function formatToolDescriptions(tools: ToolDefinition[]): string {
  const lines = [
    "## Available Tools",
    "",
    "You have the following tools available. To call a tool, respond with a JSON block in exactly this format:",
    "",
    "```json",
    '{"tool": "<tool_name>", "input": {<parameters>}}',
    "```",
    "",
    "You may call multiple tools by including multiple JSON blocks. After each tool call, you will receive the result.",
    "",
  ];

  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
    lines.push("");
    lines.push("Parameters:");
    for (const [name, schema] of Object.entries(tool.input_schema.properties)) {
      const s = schema as Record<string, unknown>;
      const required = tool.input_schema.required?.includes(name) ? " (required)" : "";
      lines.push(`- \`${name}\`${required}: ${s.description ?? s.type ?? "any"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const FENCED_JSON_PATTERN = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;
const XML_TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const BARE_JSON_PATTERN = /\{[^{}]*(?:"tool"|"name"|"action")\s*:\s*"[^"]*"[^{}]*\}/g;

/**
 * Try to extract a tool name and input from a parsed JSON object.
 * Handles multiple key naming conventions used by different models:
 * - {"tool": "...", "input": {...}}
 * - {"name": "...", "arguments": {...}}
 * - {"action": "...", "arguments": {...}}
 * - {"channel": "...", "message": "..."} → inferred as send_message
 * - {"path": "...", "content": "..."} → inferred as write_file
 * - {"command": "..."} → inferred as bash
 * - {"pattern": "...", "path": "..."} → inferred as grep
 */
function extractToolCall(parsed: Record<string, unknown>): { tool: string; input: Record<string, unknown> } | null {
  // Explicit tool name in the object
  const name = (parsed.tool ?? parsed.name ?? parsed.action) as string | undefined;
  if (name && typeof name === "string") {
    const input = (parsed.input ?? parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>;
    return { tool: name, input };
  }

  // Infer tool from parameter signatures (model output raw args without a tool name)
  if (typeof parsed.channel === "string" && typeof parsed.message === "string") {
    return { tool: "send_message", input: parsed };
  }
  if (typeof parsed.path === "string" && typeof parsed.content === "string") {
    return { tool: "write_file", input: parsed };
  }
  if (typeof parsed.command === "string" && Object.keys(parsed).length <= 2) {
    return { tool: "bash", input: parsed };
  }

  return null;
}

/**
 * Parse tool calls from text output. Handles:
 * - <tool_call>{"name":"...", "arguments":{...}}</tool_call> (Granite XML)
 * - ```json {"tool":"...", "input":{...}} ``` (fenced JSON)
 * - {"tool":"...", "input":{...}} (bare JSON)
 *
 * Exported so agent.ts can apply this to all responses as a fallback
 * when models emit tool calls as text despite having native support.
 */
export function parseToolCalls(response: ChatResponse): ChatResponse {
  const newContent: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const block of response.content) {
    if (block.type !== "text") {
      newContent.push(block);
      continue;
    }

    const text = block.text;

    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    let remainingText = text;

    // 1. Match <tool_call>...</tool_call> XML tags
    for (const match of text.matchAll(XML_TOOL_CALL_PATTERN)) {
      const jsonStr = match[1].trim();
      try {
        const call = extractToolCall(JSON.parse(jsonStr));
        if (call) { calls.push(call); remainingText = remainingText.replace(match[0], ""); continue; }
      } catch { /* try with newline sanitization */ }
      try {
        const sanitized = jsonStr.replace(/\n/g, "\\n");
        const call = extractToolCall(JSON.parse(sanitized));
        if (call) { calls.push(call); remainingText = remainingText.replace(match[0], ""); }
      } catch {
        // JSON is too malformed to parse — try to salvage by extracting
        // the action type and creating a simplified call
        const typeMatch = jsonStr.match(/"type"\s*:\s*"(\w+)"/);
        const contentMatch = jsonStr.match(/"content"\s*:\s*"([^"]{1,500})"/);
        const instrumentMatch = jsonStr.match(/"instrument"\s*:\s*"(\w+)"/);
        const targetMatch = jsonStr.match(/"target"\s*:\s*"([^"]+)"/);
        const summaryMatch = jsonStr.match(/"summary"\s*:\s*"([^"]+)"/);
        if (typeMatch) {
          const input: Record<string, unknown> = { type: typeMatch[1] };
          if (contentMatch) input.object = { content: contentMatch[1] };
          if (instrumentMatch) input.instrument = instrumentMatch[1];
          if (targetMatch) input.target = targetMatch[1];
          if (summaryMatch) input.summary = summaryMatch[1];
          calls.push({ tool: "action", input });
          remainingText = remainingText.replace(match[0], "");
        }
      }
    }

    // 2. Match ```json ... ``` fenced blocks
    for (const match of text.matchAll(FENCED_JSON_PATTERN)) {
      try {
        const call = extractToolCall(JSON.parse(match[1].trim()));
        if (call) { calls.push(call); remainingText = remainingText.replace(match[0], ""); }
      } catch { /* skip */ }
    }

    // 3. Try bare JSON objects
    if (calls.length === 0) {
      for (const match of text.matchAll(BARE_JSON_PATTERN)) {
        try {
          const call = extractToolCall(JSON.parse(match[0]));
          if (call) { calls.push(call); remainingText = remainingText.replace(match[0], ""); }
        } catch { /* skip */ }
      }
    }

    // 4. Detect tool({...}) calls with nested braces (multi-line aware)
    let actionSearch = true;
    while (actionSearch) {
      const startMatch = /\b(execute|file|message|memory|action)\s*\(\s*\{/.exec(remainingText);
      if (!startMatch) { actionSearch = false; break; }
      const startIdx = startMatch.index! + startMatch[0].length - 1;
      let depth = 1, i = startIdx + 1;
      while (i < remainingText.length && depth > 0) {
        if (remainingText[i] === '{') depth++;
        else if (remainingText[i] === '}') depth--;
        i++;
      }
      if (depth !== 0) { actionSearch = false; break; }
      const objEnd = i;
      const closeIdx = remainingText.indexOf(')', objEnd);
      if (closeIdx === -1) { actionSearch = false; break; }

      const raw = remainingText.slice(startIdx, objEnd);
      const fullMatch = remainingText.slice(startMatch.index!, closeIdx + 1);
      try {
        let cleaned = raw
          .replace(/`([^`]*)`/g, '"$1"')
          .replace(/,\s*([}\]])/g, '$1');
        cleaned = cleaned.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
        const input = JSON.parse(cleaned);
        calls.push({ tool: startMatch[1], input });
        remainingText = remainingText.replace(fullMatch, "");
      } catch {
        // Try salvage: extract key fields
        const typeMatch = raw.match(/"(?:type|operation|action|command)"\s*:\s*"([^"]+)"/);
        if (typeMatch) {
          const input: Record<string, unknown> = {};
          for (const fm of raw.matchAll(/"(\w+)"\s*:\s*"([^"]{1,500})"/g)) {
            input[fm[1]] = fm[2];
          }
          calls.push({ tool: startMatch[1], input });
        }
        remainingText = remainingText.replace(fullMatch, "");
      }
    }

    // 5. Detect tool_name({...}) function-call style
    const funcCallPattern = /\b(execute|file|message|memory|action|read_messages|send_message|read_file|write_file|edit_file|bash|glob|grep|list_dir|git)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
    for (const match of remainingText.matchAll(funcCallPattern)) {
      try {
        const input = JSON.parse(match[2]);
        calls.push({ tool: match[1], input });
        remainingText = remainingText.replace(match[0], "");
      } catch { /* skip malformed JSON */ }
    }

    // 6. Detect no-arg calls like "message()" or "read_messages()"
    const noArgPattern = /\b(execute|file|message|memory|action|read_messages|send_message|read_file|write_file|edit_file|bash|glob|grep|list_dir|git)\s*\(\s*\)/g;
    for (const match of remainingText.matchAll(noArgPattern)) {
      calls.push({ tool: match[1], input: {} });
      remainingText = remainingText.replace(match[0], "");
    }

    // Add any remaining text
    const trimmed = remainingText.trim();
    if (trimmed) {
      newContent.push({ type: "text", text: trimmed });
    }

    // Convert parsed tool calls to tool_use blocks
    for (const call of calls) {
      hasToolCalls = true;
      newContent.push({
        type: "tool_use",
        id: `shim_tc_${shimIdCounter++}`,
        name: call.tool,
        input: call.input,
      });
    }
  }

  return {
    content: newContent,
    stop_reason: hasToolCalls ? "tool_use" : response.stop_reason,
    usage: response.usage,
  };
}
