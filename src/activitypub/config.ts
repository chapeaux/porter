/**
 * ActivityPub federation configuration.
 */

/** How follow requests are approved. */
export type ApprovalMode = "open" | "allowlist" | "manual";

/** ActivityPub configuration block within PorterConfig. */
export interface ActivityPubConfig {
  /** Enable ActivityPub federation. */
  enabled: boolean;
  /** Public domain for actor URLs (e.g. "porter.example.com"). */
  domain: string;
  /** How follow requests are handled. Default: "allowlist". */
  approval_mode: ApprovalMode;
  /** Allowed domains or acct handles when approval_mode is "allowlist". */
  allowlist?: string[];
  /** Post session summaries publicly. Default: false (followers-only). */
  public_summaries?: boolean;
  /** Max concurrent AP-initiated sessions per follower. Default: 1. */
  max_sessions_per_follower?: number;
}

/** Resolve AP config from explicit config, env vars, or defaults. */
export function resolveApConfig(
  explicit?: Partial<ActivityPubConfig>,
): ActivityPubConfig | null {
  const enabled =
    explicit?.enabled ??
    (Deno.env.get("PORTER_AP_ENABLED") === "true");

  if (!enabled) return null;

  const domain =
    explicit?.domain ??
    Deno.env.get("PORTER_AP_DOMAIN") ??
    "";

  if (!domain) {
    console.error(
      "[activitypub] AP enabled but no domain configured. " +
      "Set activitypub.domain in porter.json or PORTER_AP_DOMAIN env var.",
    );
    return null;
  }

  return {
    enabled: true,
    domain,
    approval_mode: explicit?.approval_mode ?? "allowlist",
    allowlist: explicit?.allowlist,
    public_summaries: explicit?.public_summaries ?? false,
    max_sessions_per_follower: explicit?.max_sessions_per_follower ?? 1,
  };
}

/** Build the base URL for AP endpoints from the configured domain. */
export function apBaseUrl(config: ActivityPubConfig): string {
  return `https://${config.domain}`;
}
