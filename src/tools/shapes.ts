/**
 * Generate SHACL shapes from tool definitions for pre-execution validation.
 *
 * Each tool becomes a NodeShape with property constraints derived from
 * its input_schema. Tool calls are validated against these shapes before
 * execution, enabling auto-repair of common model mistakes.
 */

import type { ToolDefinition } from "../providers/types.ts";

const PORTER = "https://porter.chapeaux.io/vocab#";
const SH = "http://www.w3.org/ns/shacl#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

export interface ToolCallValidation {
  valid: boolean;
  toolName: string;
  repairedName?: string;
  repairedParams?: Record<string, unknown>;
  violations: string[];
}

export function validateToolCall(
  name: string,
  params: Record<string, unknown>,
  tools: ToolDefinition[],
): ToolCallValidation {
  const toolNames = tools.map(t => t.name);
  const normalizedInput = name.toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_.]/g, "");

  // Find exact match
  let matchedTool = tools.find(t => t.name === name);
  let repairedName: string | undefined;

  if (!matchedTool) {
    // Case-insensitive match
    matchedTool = tools.find(t => t.name.toLowerCase() === normalizedInput);
    if (matchedTool) repairedName = matchedTool.name;
  }

  if (!matchedTool) {
    // Substring containment — only if exactly one tool matches
    const candidates = tools.filter(t =>
      normalizedInput.includes(t.name.toLowerCase()) ||
      t.name.toLowerCase().includes(normalizedInput)
    );
    if (candidates.length === 1) {
      matchedTool = candidates[0];
      repairedName = matchedTool.name;
    }
  }

  if (!matchedTool) {
    return {
      valid: false,
      toolName: name,
      violations: [
        `Tool '${name}' not found.`,
        `Available tools: ${toolNames.join(", ")}`,
      ],
    };
  }

  // Validate params against input_schema
  const schema = matchedTool.input_schema;
  const violations: string[] = [];
  const repairedParams = { ...params };

  if (schema?.required) {
    for (const req of schema.required) {
      if (!(req in repairedParams)) {
        // Try fuzzy property match
        const paramKeys = Object.keys(repairedParams);
        const fuzzyKey = paramKeys.find(k =>
          k.toLowerCase().replace(/[\s\-]/g, "_") === req.toLowerCase()
        );
        if (fuzzyKey) {
          repairedParams[req] = repairedParams[fuzzyKey];
          delete repairedParams[fuzzyKey];
        } else {
          violations.push(`Missing required parameter: '${req}'`);
        }
      }
    }
  }

  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (key in repairedParams && prop && typeof prop === "object") {
        const propSchema = prop as { type?: string };
        const value = repairedParams[key];
        // Type coercion
        if (propSchema.type === "number" || propSchema.type === "integer") {
          if (typeof value === "string") {
            const num = Number(value);
            if (!isNaN(num)) repairedParams[key] = num;
          }
        } else if (propSchema.type === "boolean") {
          if (typeof value === "string") {
            repairedParams[key] = value === "true" || value === "1";
          }
        } else if (propSchema.type === "string") {
          if (typeof value !== "string") {
            repairedParams[key] = String(value);
          }
        }
      }
    }
  }

  const wasRepaired = repairedName !== undefined ||
    JSON.stringify(repairedParams) !== JSON.stringify(params);

  return {
    valid: violations.length === 0,
    toolName: repairedName || name,
    repairedName,
    repairedParams: wasRepaired ? repairedParams : undefined,
    violations,
  };
}

export function toolsToTurtle(tools: ToolDefinition[]): string {
  const lines = [
    `@prefix sh: <${SH}> .`,
    `@prefix porter: <${PORTER}> .`,
    `@prefix xsd: <${XSD}> .`,
    "",
    `porter:ToolNameConstraint a sh:NodeShape ;`,
    `  sh:targetClass porter:ToolCall ;`,
    `  sh:property [`,
    `    sh:path porter:toolName ;`,
    `    sh:in (${tools.map(t => `"${t.name}"`).join(" ")})`,
    `  ] .`,
    "",
  ];

  for (const tool of tools) {
    const safeName = tool.name.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`porter:Tool_${safeName} a sh:NodeShape ;`);
    lines.push(`  sh:targetClass porter:ToolCall ;`);

    if (tool.input_schema?.properties) {
      for (const [prop, schema] of Object.entries(tool.input_schema.properties)) {
        const s = schema as { type?: string; description?: string };
        const xsdType = s.type === "number" || s.type === "integer" ? "xsd:integer"
          : s.type === "boolean" ? "xsd:boolean"
          : "xsd:string";
        const required = tool.input_schema.required?.includes(prop);
        lines.push(`  sh:property [`);
        lines.push(`    sh:path porter:${prop} ;`);
        lines.push(`    sh:datatype ${xsdType} ;`);
        lines.push(`    sh:minCount ${required ? 1 : 0}`);
        lines.push(`  ] ;`);
      }
    }

    lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, " .");
    lines.push("");
  }

  return lines.join("\n");
}
