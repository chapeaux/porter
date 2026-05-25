# Deployment Guide -- OpenShift

This guide covers deploying Porter to OpenShift in serve mode. Porter runs as
a single container with all sessions created dynamically via the web
dashboard.

## Prerequisites

- OpenShift cluster with `oc` CLI authenticated
- Container image built and pushed to a registry (e.g., Quay.io)
- OIDC provider configured (if using SSO)
- API credentials for at least one model provider

## Build the Container Image

```bash
podman build -t quay.io/myorg/porter:latest .
podman push quay.io/myorg/porter:latest
```

The `Dockerfile` in the project root packages the Deno runtime and Porter
source into a single image.

## Step 1: Create Secrets

Porter needs API credentials and optionally OIDC configuration. Create these
secrets before applying the deployment manifest.

### API Key Secret

```bash
NAMESPACE=my-namespace
SESSION=porter

# For Anthropic direct API
oc create secret generic porter-${SESSION}-api-key \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-your-key-here \
  -n $NAMESPACE

# Or use a placeholder if using Vertex AI exclusively
oc create secret generic porter-${SESSION}-api-key \
  --from-literal=ANTHROPIC_API_KEY=placeholder \
  -n $NAMESPACE
```

### GCP Application Default Credentials (Vertex AI)

If using Claude via Vertex AI or Gemini models:

```bash
oc create secret generic porter-${SESSION}-gcp-adc \
  --from-file=application_default_credentials.json=~/.config/gcloud/application_default_credentials.json \
  -n $NAMESPACE
```

### OIDC Secret (SSO)

If using OIDC authentication:

```bash
oc create secret generic porter-${SESSION}-oidc \
  --from-literal=PORTER_OIDC_CLIENT_SECRET='<from your OIDC provider>' \
  --from-literal=PORTER_SESSION_KEY="$(openssl rand -hex 32)" \
  -n $NAMESPACE
```

Register the redirect URI in your OIDC provider:
`https://<route-hostname>/auth/callback`

## Step 2: Apply the Manifest

The `deploy/orchestrator.yaml` template uses environment variable
substitution. Always use `envsubst` before applying:

```bash
SESSION=porter \
NAMESPACE=my-namespace \
IMAGE=quay.io/myorg/porter:latest \
  envsubst < deploy/orchestrator.yaml | oc apply -f - -n $NAMESPACE
```

Applying the raw YAML without `envsubst` will create resources with literal
`${...}` names that will not function.

## Step 3: Router Shard Label

On some OpenShift clusters (ROSA, RHOAI), Routes must have a `shard` label
for the ingress router to pick them up. The `deploy/orchestrator.yaml` Route
includes `shard: internal` by default.

If your cluster uses a different shard, edit the Route label before applying:

```yaml
metadata:
  labels:
    shard: internal   # adjust for your cluster
```

## Step 4: Verify

```bash
# Check rollout status
oc rollout status deployment/porter-${SESSION}-orchestrator -n $NAMESPACE

# Test the health endpoint
curl https://porter-${NAMESPACE}.apps.<cluster-domain>/healthz
# Expected: ok

# Check pod logs
oc logs deployment/porter-${SESSION}-orchestrator -n $NAMESPACE
```

## Resource Summary

The manifest creates the following resources:

| Resource | Name | Purpose |
|----------|------|---------|
| Deployment | `porter-${SESSION}-orchestrator` | Porter platform (serve mode) |
| Service | `porter` | ClusterIP :3000 to UI |
| Route | `porter` | External HTTPS access |
| NetworkPolicy | `allow-porter-${SESSION}-orchestrator-ui-ingress` | HAProxy to pod port 3000 |
| Secret | `porter-${SESSION}-api-key` | API credentials |
| Secret | `porter-${SESSION}-gcp-adc` | GCP ADC for Vertex AI |
| Secret | `porter-${SESSION}-oidc` | OIDC client secret + session key |
| PVC | `porter-home` | Persistent storage |

## Environment Variables Reference

These are set in the Deployment manifest or injected from Secrets:

| Variable | Source | Description |
|----------|--------|-------------|
| `ANTHROPIC_API_KEY` | Secret `porter-${SESSION}-api-key` | Anthropic API key |
| `GOOGLE_APPLICATION_CREDENTIALS` | Secret `porter-${SESSION}-gcp-adc` (mount) | Path to GCP ADC JSON |
| `CLAUDE_CODE_USE_VERTEX` | Deployment env | Set to `1` for Vertex AI |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Deployment env | GCP project ID |
| `CLOUD_ML_REGION` | Deployment env | GCP region |
| `PORTER_OIDC_ISSUER_URL` | Deployment env | OIDC issuer URL |
| `PORTER_OIDC_CLIENT_ID` | Deployment env | OIDC client ID |
| `PORTER_OIDC_CLIENT_SECRET` | Secret `porter-${SESSION}-oidc` | OIDC client secret |
| `PORTER_SESSION_KEY` | Secret `porter-${SESSION}-oidc` | Session cookie key |
| `HOME` | Deployment env | Set to PVC mount for persistence |

## Persistent Storage

The PVC `porter-home` is mounted at the container's `$HOME` directory. It
stores:

| Path | Contents |
|------|----------|
| `~/.porter/sessions.json` | Session registry |
| `~/.porter/teams/` | Saved team configurations |
| `~/.porter/agents/` | Agent library |
| `~/.porter/messages/` | JSONL message history per session |
| `~/.porter/snapshots/` | Session conversation snapshots |
| `~/.porter/credentials/` | Per-user encrypted credentials |
| `~/.porter/metrics/` | Session metrics |

## Multi-user Router Deployment

For production multi-tenant deployments, Porter supports a pod-per-user
architecture where each authenticated user gets their own isolated
orchestrator container.

### Architecture

```
Browser --> Router Pod (OIDC auth + provisioning + reverse proxy)
              +--> User-A Pod (porter serve --single-user)
              +--> User-B Pod (porter serve --single-user)
              +--> ...
```

The router is a lightweight proxy that authenticates users, provisions
per-user pods on demand, and reverse-proxies all HTTP and WebSocket traffic
to the user's pod.

### Prerequisites

- OpenShift cluster with `oc` CLI authenticated
- Container image built and pushed to a registry
- OIDC provider configured (required for user identification)

### Step 1: Create Secrets

```bash
NAMESPACE=my-namespace

# OIDC client secret
oc create secret generic porter-oidc \
  --from-literal=client-secret='<from your OIDC provider>' \
  -n $NAMESPACE

# Session encryption key
oc create secret generic porter-session \
  --from-literal=session-key="$(openssl rand -hex 32)" \
  -n $NAMESPACE
```

Register the redirect URI in your OIDC provider:
`https://<route-hostname>/auth/callback`

### Step 2: Apply the Router Manifest

```bash
NAMESPACE=my-namespace \
IMAGE=quay.io/myorg/porter:latest \
OIDC_ISSUER_URL=https://keycloak.example.com/realms/porter \
OIDC_CLIENT_ID=porter \
OIDC_REDIRECT_URI=https://porter.example.com/auth/callback \
  envsubst < deploy/router.yaml | oc apply -f - -n $NAMESPACE
```

### Step 3: Verify

```bash
# Check the router is running
oc rollout status deployment/porter-router -n $NAMESPACE

# Test the health endpoint
curl https://porter-$NAMESPACE.apps.<cluster-domain>/healthz
# Expected: ok
```

### How It Works

1. User visits the Porter URL and sees the login chooser page (SSO or Solid/LWS)
2. After SSO authentication, the router exchanges the Keycloak ID token for
   a Tudor/LWS access token (if `PORTER_LWS_BASE_URL` is configured)
3. The router checks if a pod exists for the user
4. If no pod exists, the router provisions a Deployment + ClusterIP Service
5. While the pod starts, the user sees a loading page (`loading.html`) that
   polls for readiness
6. Once ready, all requests are reverse-proxied to the user's pod
7. After the idle timeout (default: 30 minutes), the pod is deprovisioned

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORTER_IDLE_TIMEOUT` | `30` | Minutes of inactivity before pod cleanup |
| `PORTER_NAMESPACE` | `porter` | Namespace for user pods |
| `PORTER_USER_POD_IMAGE` | Same as router | Container image for user pods |
| `PORTER_LWS_BASE_URL` | | LWS Pod storage base URL (e.g., `https://lws.example.com/pods`) |

### LWS / Pod Sync Configuration

To enable persistent configuration storage across pod restarts, configure
the LWS base URL. The router performs a token exchange at SSO login time:

1. The Keycloak ID token is exchanged for a Tudor/LWS access token using
   `urn:ietf:params:oauth:grant-type:token-exchange`
2. The LWS token is stored server-side (not in the cookie -- 4 KB limit)
3. User pods access the token via `POST /auth/lws-token`
4. Pod writes use `POST` for resource creation and `PUT` with `If-Match`
   (ETag) for updates

```bash
# Add to the router deployment env
PORTER_LWS_BASE_URL=https://lws.example.com/pods
```

Ensure the LWS server's token exchange endpoint accepts tokens from your
Keycloak realm. The exchange uses the subject token type
`urn:ietf:params:oauth:token-type:id_token`.

CLI flags for `porter router`:

```
--port <port>           Listen port (default: 3000)
--idle-timeout <min>    Idle timeout in minutes (default: 30)
--namespace <ns>        OpenShift namespace for user pods
```

### RBAC Requirements

The router's ServiceAccount needs permissions to manage user pods. Without
these permissions, the router cannot provision or clean up user pods.

| Resource | Verbs |
|----------|-------|
| `apps/deployments` | get, list, create, delete, patch |
| `core/services` | get, list, create, delete |
| `core/secrets` | get, list, create, delete |
| `core/pods` | get, list |

These are defined in the `porter-router` Role and RoleBinding in
`deploy/router.yaml`. Apply them before deploying the router.

### NetworkPolicy

The router manifest includes a NetworkPolicy that allows ingress from the
OpenShift HAProxy router pods (namespace `openshift-ingress`) on port 3000.
User pods also need a NetworkPolicy allowing traffic from the router pod.
Both policies are included in `deploy/router.yaml`.

If the Route returns 503, verify the NetworkPolicy is applied:

```bash
oc get networkpolicy -n $NAMESPACE
```

### CA Bundle

If the OIDC provider or LWS server uses certificates signed by an internal
CA, mount the CA bundle into the router container:

```bash
oc create configmap porter-ca --from-file=ca-bundle.crt=/path/to/ca-bundle.crt -n $NAMESPACE
```

Then set `DENO_CERT` in the router Deployment to point to the mounted file:

```yaml
- name: DENO_CERT
  value: /etc/ssl/certs/ca-bundle.crt
```

### Resource Limits

Default resource limits for user pods (set in PodRegistry):

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 500m | 2 |
| Memory | 512Mi | 1Gi |

The router itself uses fewer resources:

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 250m | 1 |
| Memory | 256Mi | 512Mi |

### Scaling Considerations

The router is stateless except for its in-memory pod registry (the map of
userId to podUrl). This means:

- A single router replica handles all user traffic
- If the router restarts, it loses its pod registry but discovers existing
  pods on next user access (via `oc get pod -l porter.io/user=...`)
- For high availability, the pod registry could be backed by a ConfigMap or
  external store (not yet implemented)
- User pods are independently resilient -- they survive router restarts

## Hybrid Remote Mode

For running the orchestrator locally with worker pods on OpenShift:

### Configure Remote Workers

Add `remote` to `porter.json`:

```json
{
  "remote": {
    "type": "openshift",
    "namespace": "my-namespace",
    "image": "quay.io/myorg/porter-worker:latest"
  }
}
```

### Build and Push the Worker Image

```bash
podman build -t quay.io/myorg/porter-worker:latest .
podman push quay.io/myorg/porter-worker:latest
```

### Deploy Workers

```bash
porter login --server https://api.example.com --token sha256~...
porter start --config team.json     # local orchestrator
porter deploy                       # deploy worker pods
```

### Teardown

```bash
porter teardown
```

## Troubleshooting

### TLS Certificate Errors

If the container cannot verify TLS certificates for your OIDC provider or
API endpoints, ensure the cluster's CA bundle is mounted into the container.
On OpenShift, the trusted CA bundle is typically available at
`/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`.

For custom CAs:

```bash
oc create configmap custom-ca --from-file=ca-bundle.crt=/path/to/ca-bundle.crt
```

Then mount it and set `NODE_EXTRA_CA_CERTS` in the Deployment.

### Git SSL Verification

If agents need to clone from internal Git servers with self-signed
certificates:

```bash
# In the Deployment env section
- name: GIT_SSL_NO_VERIFY
  value: "true"
```

Or mount the CA certificate and set:

```bash
- name: GIT_SSL_CAINFO
  value: "/etc/ssl/certs/custom-ca.crt"
```

### NetworkPolicy Blocking

If the Route returns 503, verify the NetworkPolicy allows ingress from the
HAProxy router pods. The default manifest creates a policy that allows
traffic on port 3000 from the `openshift-ingress` namespace.

Check the policy:

```bash
oc get networkpolicy -n $NAMESPACE
oc describe networkpolicy allow-porter-${SESSION}-orchestrator-ui-ingress -n $NAMESPACE
```

### Pod Crash Loops

Check logs for common issues:

```bash
oc logs deployment/porter-${SESSION}-orchestrator -n $NAMESPACE --previous
```

Common causes:
- Missing or invalid API key in the secret
- OIDC issuer URL unreachable from the cluster
- PVC not bound (check `oc get pvc -n $NAMESPACE`)
- Port conflicts if running multiple Porter deployments in the same namespace

### WebSocket Connection Failures

The Route must support WebSocket upgrades. On OpenShift, this requires the
`haproxy.router.openshift.io/timeout` annotation for long-lived connections:

```yaml
metadata:
  annotations:
    haproxy.router.openshift.io/timeout: 3600s
```

The default manifest includes this annotation.
