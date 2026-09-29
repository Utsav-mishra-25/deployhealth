/**
 * The request body, or null once it passes `max` bytes. Counts while streaming, so a chunked
 * upload without Content-Length can't make the server buffer more than the cap.
 */
export async function readBodyUpTo(request: Request, max: number): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
