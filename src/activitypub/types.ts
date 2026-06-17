/**
 * ActivityPub type interfaces.
 *
 * Covers the subset of the AP/AS specs needed for Porter federation:
 * actors, activities, collections, and the security vocabulary for
 * HTTP Signatures.
 */

// ---------------------------------------------------------------------------
// JSON-LD base
// ---------------------------------------------------------------------------

export type APContext =
  | "https://www.w3.org/ns/activitystreams"
  | "https://w3id.org/security/v1"
  | string
  | Record<string, string>;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export interface PublicKey {
  id: string;
  owner: string;
  publicKeyPem: string;
}

export interface Endpoints {
  sharedInbox?: string;
}

export interface Actor {
  "@context": APContext | APContext[];
  id: string;
  type: "Service" | "Person" | "Application" | "Group" | "Organization";
  preferredUsername: string;
  name?: string;
  summary?: string;
  url?: string;
  inbox: string;
  outbox: string;
  followers: string;
  following?: string;
  manuallyApprovesFollowers?: boolean;
  publicKey: PublicKey;
  endpoints?: Endpoints;
  icon?: APObject;
  image?: APObject;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export interface APObject {
  id?: string;
  type: string;
  content?: string;
  summary?: string;
  published?: string;
  updated?: string;
  attributedTo?: string;
  inReplyTo?: string | null;
  url?: string;
  to?: string[];
  cc?: string[];
  tag?: APTag[];
  attachment?: APAttachment[];
  mediaType?: string;
  name?: string;
  conversation?: string;
  sensitive?: boolean;
}

export interface APTag {
  type: "Hashtag" | "Mention" | string;
  href?: string;
  name: string;
}

export interface APAttachment {
  type: "Document" | "Image" | string;
  mediaType: string;
  url: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export interface Activity {
  "@context"?: APContext | APContext[];
  id: string;
  type: string;
  actor: string;
  object: string | APObject | Activity;
  to?: string[];
  cc?: string[];
  published?: string;
}

export interface FollowActivity extends Activity {
  type: "Follow";
  object: string;
}

export interface AcceptActivity extends Activity {
  type: "Accept";
  object: Activity | string;
}

export interface RejectActivity extends Activity {
  type: "Reject";
  object: Activity | string;
}

export interface UndoActivity extends Activity {
  type: "Undo";
  object: Activity | string;
}

export interface CreateActivity extends Activity {
  type: "Create";
  object: APObject;
}

export interface DeleteActivity extends Activity {
  type: "Delete";
  object: string | APObject;
}

export interface AnnounceActivity extends Activity {
  type: "Announce";
  object: string;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface OrderedCollection {
  "@context"?: APContext | APContext[];
  id: string;
  type: "OrderedCollection";
  totalItems: number;
  first?: string;
  last?: string;
  orderedItems?: (APObject | string)[];
}

export interface OrderedCollectionPage {
  "@context"?: APContext | APContext[];
  id: string;
  type: "OrderedCollectionPage";
  partOf: string;
  totalItems?: number;
  next?: string;
  prev?: string;
  orderedItems: (APObject | string)[];
}

// ---------------------------------------------------------------------------
// WebFinger
// ---------------------------------------------------------------------------

export interface WebFingerLink {
  rel: string;
  type?: string;
  href?: string;
}

export interface WebFingerResponse {
  subject: string;
  aliases?: string[];
  links: WebFingerLink[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AP_CONTEXT: APContext[] = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
];

export const AP_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export const AP_CONTENT_TYPE = "application/activity+json";
export const AP_ACCEPT = "application/activity+json, application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"";
