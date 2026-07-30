# Model Providers

Porter talks to models through a provider-neutral interface (`src/providers/types.ts`);
each `ProviderType` has an adapter under `src/providers/` translating to that
provider's wire format. This note covers the provider types that are easy to
misconfigure because more than one type can plausibly point at the same
kind of endpoint.

## Claude and Gemini behind a proxy gateway

Some deployments (e.g. Red Hat's internal `models-corp` gateway) put Claude
and Gemini behind Google Vertex AI, but the exact request shape varies:

- **Claude** — proxied via Vertex AI's native `streamRawPredict` format
  (`POST {base}/{tier}/models/{model}:streamRawPredict`, tier one of
  `sonnet`/`haiku`/`opus`, `anthropic_version: "vertex-2023-10-16"`). Use
  `provider_type: "vertex_claude"` with `tier` set — see `vertex_claude.ts`.
- **Gemini** — some gateways proxy the *native* Vertex `generateContent`
  format (`provider_type: "vertex_gemini"`, see `vertex_gemini.ts`); others
  (including models-corp) only expose Google's own OpenAI-compatibility shim
  at `POST {base}/v1beta/openai/chat/completions` with standard OpenAI
  request/response bodies. For the shim case, use
  `provider_type: "openai_compat"` with
  `chat_endpoint: "/v1beta/openai/chat/completions"` — `vertex_gemini` will
  hard-fail against a shim-only endpoint with a response-shape mismatch.

## `vertex_ai`: legacy auto-detect type

`provider_type: "vertex_ai"` exists for backward compatibility and guesses
Claude vs. Gemini from the configured model IDs or a `"claude"`/`"anthropic"`
substring in `base_url` (see `createProvider()`'s `case "vertex_ai"` in
`src/providers/mod.ts`). Prefer the explicit `vertex_claude`/`vertex_gemini`
types when configuring a model directly — they don't depend on that
heuristic matching your gateway's hostname convention.

## Extended thinking / reasoning (`chat_template_kwargs`)

For vLLM-hosted OpenAI-compatible models, opt into extended thinking by
setting `capabilities.reasoning: true` on the model config. This is a vLLM
convention (`chat_template_kwargs` in the request body), not an OpenAI one,
so it only applies on the default `/v1/chat/completions` endpoint — not on a
`chat_endpoint` override (e.g. a Gemini OpenAI-compat shim). Most model
families use `{"thinking": true}`; Qwen3 uses `{"enable_thinking": true}`
instead — `openai_compat.ts` already branches on this by model name.
