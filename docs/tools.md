# Runtime Tools

Porter can inject additional runtime tools into agent pods. By default, the
orchestrator image includes only Deno and git. If your agents need other
tools (Python, curl, Node.js, etc.), declare them in your Porter config.

## Configuration

Add a `runtime_tools` array to your Porter config:

```json
{
  "session": "my-project",
  "runtime_tools": ["python3", "curl"],
  "agents": [...]
}
```

## Available Tools

| Name | Image | Binary |
|------|-------|--------|
| `curl` | ubi9/ubi-minimal | /usr/bin/curl |
| `wget` | ubi9/ubi-minimal | /usr/bin/wget |
| `python3` | ubi9/python-311 | /usr/bin/python3 |
| `nodejs` | ubi9/nodejs-20 | /usr/bin/node |
| `jq` | ubi9/ubi-minimal | /usr/bin/jq |

All images are from the Red Hat Universal Base Image (UBI) catalog --
signed, security-scanned, and RHEL-based.

## Custom Tools

You can also specify custom tool entries with an OCI image and binary path:

```json
{
  "runtime_tools": [
    "python3",
    { "name": "ruby", "image": "registry.access.redhat.com/ubi9/ruby-32:latest", "binPath": "/usr/bin/ruby" }
  ]
}
```

Custom images must come from an approved registry:
- `registry.access.redhat.com`
- `registry.redhat.io`
- `quay.io`

## How It Works

Each requested tool becomes an init container in the user's orchestrator pod.
The init container copies the tool binary from the UBI image into a shared
`emptyDir` volume mounted at `/porter/tools`. The main container adds
`/porter/tools` to its `PATH`.

The volume is ephemeral -- it is cleared when the pod restarts. No persistent
storage is used, minimizing the attack surface.

## Security

- All curated tools use Red Hat UBI images (signed, vulnerability-scanned)
- Custom images must come from the approved registry allowlist
- Init containers run with minimal privileges; they only execute `cp`
- The `/porter/tools` volume is ephemeral (`emptyDir`)
- Unknown tool names are rejected at config validation time
