# Deployment Guide -- OpenShift

This guide covers deploying Porter to OpenShift in multi-user router mode.
Porter uses a 3-component architecture where the router authenticates users
via OIDC, provisions per-user orchestrator pods on demand, and
reverse-proxies all traffic to the user's pod.

## Architecture

```
                              +-------------------+
Browser --> Route --> porter-router (OIDC + proxy)
                              |
                   +----------+----------+
                   |          |          |
              User-A Pod  User-B Pod  User-N Pod
              (serve       (serve      (serve
               --single)    --single)   --single)
                   |          |          |
                   +----------+----------+
                              |
              +---------------+---------------+
              |                               |
        porter-qdrant:6333              porter-minio:9000
        (vector search)                 (S3 object storage)
```

All three infrastructure components share the label `app.kubernetes.io/part-of: porter`
so they appear as a single application group in the OpenShift topology view.

| Component | Manifest | Purpose |
|-----------|----------|---------|
| Router | `deploy/router.yaml` | OIDC authentication, pod-per-user provisioning, reverse proxy |
| Qdrant | `deploy/qdrant.yaml` | Vector database for embedding-level agent coordination |
| MinIO | `deploy/minio.yaml` | S3-compatible storage for credentials, AP state, snapshots |

## Prerequisites

- OpenShift cluster with `oc` CLI authenticated
- Container image built and pushed to a registry (e.g., Quay.io)
- OIDC provider configured (required for user identification)

### Required Secrets

Create these three secrets before deploying:

```bash
NAMESPACE=my-namespace

# 1. OIDC client secret
oc create secret generic porter-oidc \
  --from-literal=client-secret='<from your OIDC provider>' \
  -n $NAMESPACE

# 2. Session encryption key
oc create secret generic porter-session \
  --from-literal=session-key="$(openssl rand -hex 32)" \
  -n $NAMESPACE

# 3. MinIO root credentials
oc create secret generic porter-minio \
  --from-literal=root-user='porteradmin' \
  --from-literal=root-password="$(openssl rand -hex 16)" \
  -n $NAMESPACE
```

Register the redirect URI in your OIDC provider:
`https://<route-hostname>/auth/callback`

## Step-by-Step Deployment

All manifests use `envsubst` for template variables. Applying the raw YAML
without `envsubst` will create resources with literal `${...}` names that
will not function.

### Step 1: Deploy MinIO

MinIO provides S3-compatible object storage. It must be running before the
router so the router can connect on startup.

```bash
NAMESPACE=my-namespace \
  envsubst < deploy/minio.yaml | oc apply -f - -n $NAMESPACE
```

Wait for the pod to become ready:

```bash
oc rollout status deployment/porter-minio -n $NAMESPACE
```

### Step 2: Create the MinIO Bucket

The router and user pods expect a bucket named `porter`. Use the MinIO CLI
(`mc`) or port-forward to the console to create it:

```bash
# Port-forward to the MinIO API
oc port-forward svc/porter-minio 9000:9000 -n $NAMESPACE &

# Configure mc with the credentials from the secret
mc alias set porter-local http://localhost:9000 porteradmin <root-password>

# Create the bucket
mc mb porter-local/porter

# Stop the port-forward
kill %1
```

Alternatively, use the MinIO web console on port 9001:

```bash
oc port-forward svc/porter-minio 9001:9001 -n $NAMESPACE
# Open http://localhost:9001 and create the "porter" bucket
```

### Step 3: Deploy Qdrant

Qdrant provides vector search for embedding-level agent coordination.
Storage is ephemeral -- vectors are derived from the SPARQL graph and
rebuilt as agents produce output in new sessions.

```bash
NAMESPACE=my-namespace \
  envsubst < deploy/qdrant.yaml | oc apply -f - -n $NAMESPACE
```

Wait for the pod to become ready:

```bash
oc rollout status deployment/porter-qdrant -n $NAMESPACE
```

### Step 4: Deploy the Router

```bash
NAMESPACE=my-namespace \
IMAGE=quay.io/myorg/porter:latest \
OIDC_ISSUER_URL=https://keycloak.example.com/realms/porter \
OIDC_CLIENT_ID=porter \
OIDC_REDIRECT_URI=https://porter.example.com/auth/callback \
PORTER_LWS_BASE_URL= \
  envsubst < deploy/router.yaml | oc apply -f - -n $NAMESPACE
```

The router manifest creates:

| Resource | Name | Purpose |
|----------|------|---------|
| ServiceAccount | `porter-router` | Identity for K8s API calls |
| Role + RoleBinding | `porter-router` | RBAC for pod provisioning |
| Deployment | `porter-router` | Router process |
| Service | `porter-router` | ClusterIP :3000 |
| Route | `porter` | External HTTPS access |

### Step 5: Verify

```bash
# Check all three components
oc rollout status deployment/porter-router -n $NAMESPACE
oc rollout status deployment/porter-qdrant -n $NAMESPACE
oc rollout status deployment/porter-minio -n $NAMESPACE

# Test the health endpoint
curl https://porter-$NAMESPACE.apps.<cluster-domain>/healthz
# Expected: ok

# Check router logs
oc logs deployment/porter-router -n $NAMESPACE
```

## PORTER_USER_POD_IMAGE

By default, the router uses the same image as itself for user pods. To use a
different image (e.g., a pinned tag while the router runs latest), set:

```bash
- name: PORTER_USER_POD_IMAGE
  value: "quay.io/myorg/porter:v0.14.1"
```

If unset, the fallback is:
`image-registry.openshift-image-registry.svc:5000/${NAMESPACE}/porter:latest`

To pull from a private registry, also set:

```bash
- name: PORTER_IMAGE_PULL_SECRET
  value: "my-pull-secret"
```

## Environment Variables Reference

### Router Deployment

| Variable | Source | Description |
|----------|--------|-------------|
| `PORTER_OIDC_ISSUER_URL` | envsubst | OIDC issuer URL |
| `PORTER_OIDC_CLIENT_ID` | envsubst | OIDC client ID |
| `PORTER_OIDC_REDIRECT_URI` | envsubst | OIDC redirect URI |
| `PORTER_OIDC_CLIENT_SECRET` | Secret `porter-oidc` | OIDC client secret |
| `PORTER_SESSION_KEY` | Secret `porter-session` | Session cookie encryption key |
| `PORTER_IDLE_TIMEOUT` | Deployment env | Minutes before idle pod cleanup (default: 30) |
| `PORTER_NAMESPACE` | envsubst | Namespace for user pods |
| `PORTER_LWS_BASE_URL` | envsubst | LWS Pod storage URL (optional) |
| `QDRANT_URL` | Deployment env | Qdrant endpoint (`http://porter-qdrant:6333`) |
| `S3_ENDPOINT` | Deployment env | MinIO endpoint (`http://porter-minio:9000`) |
| `S3_BUCKET` | Deployment env | MinIO bucket name (`porter`) |
| `S3_REGION` | Deployment env | S3 region (`us-east-1`) |
| `S3_ACCESS_KEY` | Secret `porter-minio` | MinIO access key |
| `S3_SECRET_KEY` | Secret `porter-minio` | MinIO secret key |
| `PORTER_USER_POD_IMAGE` | Deployment env | Override image for user pods (optional) |
| `PORTER_IMAGE_PULL_SECRET` | Deployment env | Image pull secret name (optional) |

### Propagated to User Pods

The router automatically propagates these env vars to user pods when set:
`PORTER_LWS_BASE_URL`, `PORTER_SESSION_KEY`, `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `QDRANT_URL`.

## RBAC Requirements

The router's ServiceAccount needs permissions to manage user pods:

| API Group | Resource | Verbs |
|-----------|----------|-------|
| `apps` | `deployments` | get, list, create, delete, patch |
| `""` (core) | `services`, `secrets`, `pods` | get, list, create, delete |
| `networking.k8s.io` | `networkpolicies` | get, list, create, delete |

These are defined in the `porter-router` Role and RoleBinding in
`deploy/router.yaml`.

## Resource Limits

### Router

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 250m | 1 |
| Memory | 256Mi | 512Mi |

### User Pods (set in PodRegistry)

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 500m | 2 |
| Memory | 512Mi | 1Gi |

### Qdrant

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 100m | 500m |
| Memory | 256Mi | 512Mi |

### MinIO

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 100m | 500m |
| Memory | 256Mi | 512Mi |

## Updating and Upgrading

### Updating the Router Image

```bash
IMAGE=quay.io/myorg/porter:v0.15.0

# Update the router deployment
oc set image deployment/porter-router router=$IMAGE -n $NAMESPACE

# If using PORTER_USER_POD_IMAGE, update that too
oc set env deployment/porter-router PORTER_USER_POD_IMAGE=$IMAGE -n $NAMESPACE
```

Existing user pods continue running the old image until they are
deprovisioned (idle timeout or manual cleanup). To force all users to the
new version, delete existing user pods:

```bash
# List user pods
oc get deployments -l component=user-orchestrator -n $NAMESPACE

# Delete all user pods (users will get new pods on next access)
oc delete deployments -l component=user-orchestrator -n $NAMESPACE
oc delete services -l component=user-orchestrator -n $NAMESPACE
```

### Service Worker Cache Versioning

The service worker caches UI assets under a versioned name (currently
`porter-v19` in `src/ui/sw.js`). When deploying a new version with UI
changes:

1. Bump the `CACHE_NAME` constant in `src/ui/sw.js` (e.g., `porter-v19` to
   `porter-v20`)
2. Build and push the new image
3. Deploy the updated image

The service worker automatically deletes old caches with the `porter-`
prefix when a new version activates. Users who had the old version cached
will get the update on their next visit.

### Qdrant Data

Qdrant uses ephemeral storage (`emptyDir`). Vectors are rebuilt from the
SPARQL graph as agents run, so no migration is needed when upgrading
Qdrant. To reset:

```bash
oc rollout restart deployment/porter-qdrant -n $NAMESPACE
```

### MinIO Data

MinIO uses a PersistentVolumeClaim (`porter-minio-data`, 5Gi). Data
persists across pod restarts. To upgrade the MinIO image:

```bash
oc set image deployment/porter-minio minio=minio/minio:RELEASE.2026-06-01T00-00-00Z -n $NAMESPACE
```

## Monitoring

### Pod Status

```bash
# All Porter components
oc get pods -l app=porter -n $NAMESPACE

# Just user pods
oc get pods -l component=user-orchestrator -n $NAMESPACE

# Topology view (all three components)
oc get pods -l app.kubernetes.io/part-of=porter -n $NAMESPACE
```

### Logs

```bash
# Router logs (OIDC events, pod provisioning, proxy errors)
oc logs deployment/porter-router -n $NAMESPACE -f

# Qdrant logs
oc logs deployment/porter-qdrant -n $NAMESPACE

# MinIO logs
oc logs deployment/porter-minio -n $NAMESPACE

# Specific user pod logs
oc logs deployment/porter-user-<sanitized-id> -n $NAMESPACE
```

### Health Checks

All three components expose health endpoints:

| Component | Endpoint | Port |
|-----------|----------|------|
| Router | `/healthz` | 3000 |
| Qdrant | `/healthz` | 6333 |
| MinIO | `/minio/health/live` | 9000 |

## Troubleshooting

### Route Returns 503

The Route needs a NetworkPolicy allowing ingress from the OpenShift HAProxy
router pods. The router's RBAC includes permission to create NetworkPolicies
for user pods, but the router's own ingress is handled by the cluster's
default policies.

If 503 persists, verify the Route target:

```bash
oc get route porter -n $NAMESPACE -o yaml
oc get endpoints porter-router -n $NAMESPACE
```

### OIDC Errors

The router exits on OIDC init failure. Check the logs:

```bash
oc logs deployment/porter-router -n $NAMESPACE | grep OIDC
```

Common causes:
- OIDC issuer URL unreachable from the cluster (firewall, DNS)
- Wrong client secret in `porter-oidc`
- Redirect URI not registered in the OIDC provider

### User Pod Not Starting

```bash
# Check if the deployment was created
oc get deployment -l porter.io/user -n $NAMESPACE

# Check pod events
oc describe pod -l porter.io/user=<sanitized-id> -n $NAMESPACE

# Check router logs for provisioning errors
oc logs deployment/porter-router -n $NAMESPACE | grep provision
```

Common causes:
- Image pull failure (wrong registry, missing pull secret)
- Insufficient quota in the namespace
- RBAC permissions missing for the `porter-router` ServiceAccount

### MinIO Connection Errors

If the router cannot connect to MinIO, credentials and AP state will not
persist across pod restarts. Check:

```bash
# Verify the MinIO service is reachable
oc exec deployment/porter-router -n $NAMESPACE -- \
  curl -s http://porter-minio:9000/minio/health/live

# Verify the bucket exists
oc port-forward svc/porter-minio 9000:9000 -n $NAMESPACE &
mc ls porter-local/porter
```

### Qdrant Connection Errors

If Qdrant is unreachable, Porter continues to function without vector
search. Semantic search tools will return a message stating the vector
store is unavailable. Check:

```bash
oc exec deployment/porter-router -n $NAMESPACE -- \
  curl -s http://porter-qdrant:6333/healthz
```

### TLS Certificate Errors

If the OIDC provider or LWS server uses certificates signed by an internal
CA, mount the CA bundle into the router container:

```bash
oc create configmap redhat-ca-bundle \
  --from-file=ca-bundle.crt=/path/to/ca-bundle.crt \
  -n $NAMESPACE
```

The router manifest already mounts `redhat-ca-bundle` at
`/etc/porter-certs` (optional: true -- the deployment works without it).

### WebSocket Timeouts

The Route includes `haproxy.router.openshift.io/timeout: 3600s` for
long-lived WebSocket connections. If connections drop before the timeout,
verify the annotation is present:

```bash
oc get route porter -n $NAMESPACE -o jsonpath='{.metadata.annotations}'
```

### Stale User Pods After Upgrade

After deploying a new image, old user pods continue running. Users see the
old version until their pod idles out (default: 30 minutes). To force
immediate cleanup:

```bash
oc delete deployments -l component=user-orchestrator -n $NAMESPACE
oc delete services -l component=user-orchestrator -n $NAMESPACE
```

Users will be reprovisioned with the new image on their next request.

## LWS / Pod Sync Configuration

To enable persistent configuration storage across pod restarts, set
`PORTER_LWS_BASE_URL` in the router deployment. The router performs a
token exchange at SSO login time:

1. The Keycloak ID token is exchanged for a Tudor/LWS access token
2. The LWS token is stored server-side (not in the cookie)
3. User pods access the token via `POST /auth/lws-token`

```bash
PORTER_LWS_BASE_URL=https://lws.example.com/pods
```

## CA Bundle

If using an internal CA, the router manifest mounts a ConfigMap named
`redhat-ca-bundle` at `/etc/porter-certs`. To use it with Deno, add:

```yaml
- name: DENO_CERT
  value: /etc/porter-certs/ca-bundle.crt
```
