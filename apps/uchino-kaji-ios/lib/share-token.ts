export function parseShareToken(value: string, expectedOrigin: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.origin !== expectedOrigin || !url.hash.startsWith('#share=')) return null;
    const token = url.hash.slice(7);
    return /^[A-Za-z0-9_-]{40,60}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
