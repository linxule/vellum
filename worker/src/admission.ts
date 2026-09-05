import { CONTRACT, type EndpointExample } from './contract'
import { envelope, errorResponse } from './errors'

class BodyTooLarge extends Error {}

/** Count bytes before JSON parsing, including when Content-Length is missing or false. */
export async function admitBody(request: Request, endpoint?: EndpointExample, maxBytes: number = CONTRACT.bodyMaxBytes): Promise<{ text: string } | { response: Response }> {
  const tooLarge = () => ({ response: errorResponse(envelope('PAYLOAD_TOO_LARGE', 'The request body is too large.', {
    hint: `max ${maxBytes} bytes`, example: endpoint?.example,
  }), 413) })
  const length = request.headers.get('content-length')
  if (length !== null && Number(length) > maxBytes) return tooLarge()
  if (!request.body) return { text: '' }
  let bytes = 0
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) throw new BodyTooLarge()
      controller.enqueue(chunk)
    },
  }))
  try {
    return { text: await new Response(bounded).text() }
  } catch (error) {
    if (error instanceof BodyTooLarge) return tooLarge()
    return { response: errorResponse(envelope('INVALID_JSON', 'The request body could not be read.', { example: endpoint?.example, error: 'Invalid JSON' }), 400) }
  }
}
