export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  folderPath: string;
}

export interface DriveDownloadResult {
  buffer: Buffer;
  contentType: string;
  size: number;
}

const GOOGLE_APPS_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

export function isGoogleDriveConfigured(): boolean {
  return !!process.env.GOOGLE_DRIVE_API_KEY;
}

export function parseDriveFolderUrl(input: string): string | null {
  if (!input || !input.trim()) return null;
  const trimmed = input.trim();

  const foldersMatch = trimmed.match(/drive\.google\.com\/(?:drive\/)?(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/);
  if (foldersMatch) return foldersMatch[1];

  const openMatch = trimmed.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (openMatch) return openMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed) && !trimmed.includes('.') && !trimmed.includes('/')) {
    return trimmed;
  }

  return null;
}

async function fetchWithRetry(url: string, signal?: AbortSignal, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, { signal: signal || AbortSignal.timeout(30000) });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e: any) {
      if (attempt === maxRetries - 1) throw e;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

export async function listFolderRecursive(
  folderId: string,
  apiKey?: string,
  folderPath: string = '',
  signal?: AbortSignal,
  depth: number = 0,
  maxDepth: number = 10,
): Promise<DriveFile[]> {
  const key = apiKey || process.env.GOOGLE_DRIVE_API_KEY;
  if (!key) throw new Error('GOOGLE_DRIVE_API_KEY not configured');
  if (depth >= maxDepth) return [];
  if (signal?.aborted) return [];

  const allFiles: DriveFile[] = [];
  let pageToken: string | null = null;

  do {
    if (signal?.aborted) break;

    const params = new URLSearchParams({
      q: `'${folderId}' in parents`,
      key,
      fields: 'files(id,name,mimeType,size,modifiedTime),nextPageToken',
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      signal,
    );
    const data = await res.json();

    if (data.error) {
      throw new Error(`Drive API error (${data.error.code}): ${data.error.message}`);
    }

    for (const file of (data.files || [])) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const subPath = folderPath ? `${folderPath}/${file.name}` : file.name;
        const subFiles = await listFolderRecursive(file.id, key, subPath, signal, depth + 1, maxDepth);
        allFiles.push(...subFiles);
      } else {
        allFiles.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size ? parseInt(file.size, 10) : undefined,
          modifiedTime: file.modifiedTime,
          folderPath: folderPath || '(root)',
        });
      }
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allFiles;
}

export async function downloadDriveFile(
  fileId: string,
  mimeType: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<DriveDownloadResult> {
  const key = apiKey || process.env.GOOGLE_DRIVE_API_KEY;
  if (!key) throw new Error('GOOGLE_DRIVE_API_KEY not configured');

  let url: string;
  if (GOOGLE_APPS_MIME_TYPES.has(mimeType)) {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf&key=${key}`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${key}`;
  }

  const MAX_DOWNLOAD_RETRIES = 5;
  // Backoff delays for rate-limit 403s: 30s, 60s, 90s, 120s, 150s
  const RATE_LIMIT_BACKOFFS = [30000, 60000, 90000, 120000, 150000];

  for (let attempt = 0; attempt < MAX_DOWNLOAD_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');

    const res = await fetch(url, { signal: signal || AbortSignal.timeout(60000) });

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = GOOGLE_APPS_MIME_TYPES.has(mimeType)
        ? 'application/pdf'
        : (res.headers.get('content-type') || mimeType);
      return { buffer, contentType, size: buffer.length };
    }

    if (res.status === 403 || res.status === 429) {
      const bodyText = await res.text().catch(() => '');
      const isRateLimit =
        res.status === 429 ||
        bodyText.includes('automated queries') ||
        bodyText.includes("We're sorry") ||
        bodyText.includes('rate limit') ||
        bodyText.includes('rateLimitExceeded') ||
        bodyText.includes('userRateLimitExceeded');

      if (isRateLimit && attempt < MAX_DOWNLOAD_RETRIES - 1) {
        const delay = RATE_LIMIT_BACKOFFS[attempt] ?? 150000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw new Error(`Drive download failed (${res.status}): ${bodyText.substring(0, 200)}`);
    }

    if (res.status >= 500 && attempt < MAX_DOWNLOAD_RETRIES - 1) {
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Drive download failed (${res.status}): ${await res.text().catch(() => 'unknown')}`);
  }

  throw new Error('Drive download failed: max retries exceeded');
}
