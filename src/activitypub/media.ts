/**
 * ActivityPub media attachments.
 *
 * Handles storing media files (images, text outputs, diffs) for AP
 * posts and serving them via GET /ap/media/{id}.
 */

import type { APAttachment } from "./types.ts";
import { dirname } from "@std/path";

// ---------------------------------------------------------------------------
// Media type mapping
// ---------------------------------------------------------------------------

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "";
  return path.slice(dot).toLowerCase();
}

function mediaTypeFromExtension(ext: string): string {
  return EXTENSION_MEDIA_TYPES[ext] ?? "application/octet-stream";
}

function attachmentType(ext: string): "Image" | "Document" {
  return IMAGE_EXTENSIONS.has(ext) ? "Image" : "Document";
}

// ---------------------------------------------------------------------------
// Storage directory
// ---------------------------------------------------------------------------

/** Where media files are stored locally. */
function mediaDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/activitypub/media`;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

/**
 * Store a file as an AP media attachment and return the attachment metadata.
 * Copies the file to the media directory with a UUID filename.
 */
export async function storeMediaFile(
  sourcePath: string,
  baseUrl: string,
  description?: string,
): Promise<APAttachment> {
  const ext = getExtension(sourcePath);
  const uuid = crypto.randomUUID();
  const filename = ext ? `${uuid}${ext}` : uuid;

  const dir = mediaDir();
  await Deno.mkdir(dir, { recursive: true });

  const destPath = `${dir}/${filename}`;
  await Deno.copyFile(sourcePath, destPath);

  const mediaType = mediaTypeFromExtension(ext);
  const type = attachmentType(ext);

  const attachment: APAttachment = {
    type,
    mediaType,
    url: `${baseUrl}/ap/media/${filename}`,
  };

  if (description !== undefined) {
    attachment.name = description;
  }

  return attachment;
}

/**
 * Store text content as a media attachment (for large outputs).
 */
export async function storeTextMedia(
  content: string,
  baseUrl: string,
  filename: string,
  description?: string,
): Promise<APAttachment> {
  const uuid = crypto.randomUUID();
  const storedName = `${uuid}_${filename}`;
  const ext = getExtension(filename);

  const dir = mediaDir();
  await Deno.mkdir(dir, { recursive: true });

  const destPath = `${dir}/${storedName}`;
  await Deno.writeTextFile(destPath, content);

  const mediaType = mediaTypeFromExtension(ext);

  const attachment: APAttachment = {
    type: "Document",
    mediaType,
    url: `${baseUrl}/ap/media/${storedName}`,
  };

  if (description !== undefined) {
    attachment.name = description;
  }

  return attachment;
}

// ---------------------------------------------------------------------------
// Serve endpoint
// ---------------------------------------------------------------------------

/**
 * Handle GET /ap/media/{id} — serve a stored media file.
 */
export async function handleMediaRequest(
  mediaId: string,
): Promise<Response> {
  const filePath = `${mediaDir()}/${mediaId}`;

  try {
    const data = await Deno.readFile(filePath);
    const ext = getExtension(mediaId);
    const contentType = mediaTypeFromExtension(ext);

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}
