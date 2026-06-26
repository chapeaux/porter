FROM docker.io/denoland/deno:2.9.0
RUN apt-get update && apt-get install -y --no-install-recommends git tmux ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -r porter && useradd -r -g porter -d /app porter
RUN git config --system user.email "porter@chapeaux.io" && git config --system user.name "Porter Agent"
WORKDIR /app
COPY --chown=porter:porter deno.json deno.lock ./
COPY --chown=porter:porter . .
RUN deno check mod.ts cli.ts worker.ts isolate.ts src/ui/server.ts
USER 1001
EXPOSE 8787
EXPOSE 3000
CMD ["deno", "run", "--allow-all", "cli.ts", "serve", "--port", "3000", "--headless"]
