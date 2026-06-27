# Static Deployment Guide

Porter can be built as a static site and deployed to any static host — GitHub Pages, Cloudflare Pages, Netlify, S3+CloudFront, or even a Solid Pod. No server, no containers, no backend required for basic operation.

## Build

```bash
deno task build:static
```

This produces a `dist/` directory with all UI assets, linked data vocabulary files, and runtime configuration.

## Deployment Targets

### GitHub Pages

```bash
deno task build:static
cp -r dist/* docs/
git add docs/
git commit -m "deploy static UI"
git push
```

In the repository settings, set GitHub Pages source to the `/docs` folder on the `main` branch.

### Cloudflare Pages

In the Cloudflare dashboard:
- **Build command:** `deno task build:static`
- **Build output directory:** `dist`
- **Environment:** Add `DENO_VERSION=2.9.0` if using the Deno buildpack

### Netlify

```bash
deno task build:static
```

The build script generates `dist/_redirects` with `/* /index.html 200` for SPA routing. Netlify picks this up automatically.

### S3 + CloudFront

```bash
deno task build:static
aws s3 sync dist/ s3://your-bucket-name/ --delete
```

Configure CloudFront to serve `index.html` as the default error page for SPA routing.

### Solid Pod

Upload `dist/` contents to `{pod}/porter-app/`:

```bash
for file in dist/*; do
  curl -X PUT "{POD_URL}/porter-app/$(basename $file)" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: $(file --mime-type -b $file)" \
    --data-binary @"$file"
done
```

Porter served from your own Pod — fully self-hosted with no third-party infrastructure.

## Runtime Modes

The static build injects two `<meta>` tags in `index.html` that control how Porter operates:

### Browser Mode (default)

```html
<meta name="porter-mode" content="browser">
```

Everything runs in the browser. No backend needed.

- **Authentication:** Solid OIDC login (browser-native popup flow)
- **Storage:** User's Solid Pod (teams, agents, models, credentials, session state)
- **Model API:** Direct `fetch` to provider APIs (Ollama, OpenAI, Vertex AI)
- **Tools:** MCP servers via Streamable HTTP, Pod workspace for file operations
- **Knowledge graph:** Sparq WASM in a Web Worker
- **Message bus:** `BroadcastChannel` between Web Workers

### Connected Mode

```html
<meta name="porter-mode" content="connected">
<meta name="porter-api" content="https://porter.example.com">
```

Static UI connects to a Porter API server for features that need server-side execution.

- **Sessions:** Created and managed by the API server
- **Model proxying:** API server handles CORS-blocked providers (Anthropic)
- **AP federation:** Requires a public HTTP server
- **WebSocket bus:** Proxied through the API server at `/ws`

To set this mode, edit `dist/index.html` after building:

```bash
sed -i 's/content="browser"/content="connected"/' dist/index.html
sed -i 's|<meta name="porter-api" content="">|<meta name="porter-api" content="https://porter.example.com">|' dist/index.html
```

## What Works Without a Backend

| Feature | Browser Mode | Connected Mode |
|---------|-------------|----------------|
| Team builder | Yes | Yes |
| Agent library | Yes (Pod storage) | Yes |
| Model setup | Yes (auto-detect from env) | Yes |
| MCP servers | Yes (Streamable HTTP) | Yes |
| Sessions (local models) | Yes (Ollama, WebLLM) | Yes |
| Sessions (cloud models) | Partial (CORS-permitting providers) | Yes (server proxies) |
| Pod workspace | Yes | Yes |
| Local filesystem tools | Via CLI bridge | Via CLI bridge or server |
| Knowledge graph (SPARQL) | Yes (Sparq WASM) | Yes |
| Vector search (Qdrant) | No (needs server) | Yes |
| ActivityPub federation | No (needs public server) | Yes |
| Multi-user (pod-per-user) | No | Yes |

## Connecting to a Local Ollama

For fully offline operation with local models:

1. Install and start Ollama:
   ```bash
   ollama serve
   ollama pull llama3.3
   ```

2. Open the static Porter site in your browser.

3. Log in with Solid OIDC (or skip if using local-only mode).

4. Porter auto-detects Ollama at `http://localhost:11434` and registers available models.

5. Create a team, launch a session — agents call Ollama directly from the browser via `fetch`.

No API keys, no cloud services, no server — just your browser and Ollama.

## CLI Bridge for Filesystem Access

When agents need to read/write files on your local machine:

```bash
porter bridge --port 3333 --workspace /path/to/project
```

Then in the browser Porter UI, add an MCP server:
- **Name:** local-bridge
- **Transport:** HTTP
- **URL:** `http://localhost:3333/mcp`

The bridge exposes `read_file`, `write_file`, `edit_file`, `bash`, `git`, `glob`, `grep`, `list_dir` as MCP tools. Agents use them transparently alongside Pod tools and service MCP tools.

## Pod Workspace

Without the CLI bridge, agents use the Solid Pod as their workspace:

```
{pod}/porter/sessions/{session-name}/workspace/
  src/
    app.ts        ← agent-created file
    lib/
      utils.ts    ← agent-created file
  README.md       ← agent-created file
```

Every file is a real Pod resource — URI-addressable, access-controlled, and shareable. Grant a collaborator access to the session container and they see the same workspace.

The workspace persists after the session ends. Browse it via the Pod's file manager or share the URI.

## Progressive Enhancement

The same `dist/` files work across all deployment levels:

```
Level 0: Static host (GitHub Pages)
  + Solid Pod login
  + Direct model API calls (Ollama, OpenAI)
  + MCP servers via Streamable HTTP
  = Full agent orchestration, zero backend

Level 1: + CLI bridge (porter bridge)
  = Local filesystem tools available

Level 2: + Porter API server (porter serve)
  = Server-side sessions, CORS proxy, AP federation

Level 3: + OpenShift (porter router)
  = Multi-user, pod-per-user, full infrastructure
```

Each level adds capabilities. No code changes between levels — just what services are available.

## Internationalization

The static build includes vocabulary files in `dist/vocab/`:
- `porter.ttl` — ontology with `@en` labels
- `shapes.ttl` — SHACL validation shapes
- `context.jsonld` — JSON-LD context

Translation files at `dist/vocab/i18n/`:
- `es.ttl` — Spanish
- `fr.ttl` — French

The UI resolves labels from the user's `navigator.language`. To add a language, create a new `.ttl` file with `@{lang}` tagged `rdfs:label` values and place it in `dist/vocab/i18n/`.

## Security Considerations

- **API keys:** Never hardcode API keys in the static build. Use the model setup UI to enter keys at runtime — they're stored encrypted on the user's Pod with owner-only ACL.
- **CORS:** Browser-native mode requires providers that allow browser origins. Ollama (localhost) and OpenAI work. Anthropic requires a CORS proxy or the CLI bridge.
- **Pod ACL:** Session workspaces default to owner-only access. Explicitly grant access to collaborators via the sharing UI.
- **CLI bridge:** Runs on localhost only. No authentication — anyone with access to `localhost:3333` can read/write files. Only run it on trusted networks.
