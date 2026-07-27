export class UpstreamError extends Error {
  constructor(
    readonly service: 'sarvam' | 'hermes',
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export const readErrorMessage = async (response: Response): Promise<string> => {
  const fallback = `${response.status} ${response.statusText}`.trim();
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const detail = Reflect.get(body, 'detail');
      const message = Reflect.get(body, 'message');
      if (typeof detail === 'string') return detail;
      if (typeof message === 'string') return message;
    }
  } catch {
    // A safe status-only error is better than returning an upstream HTML body.
  }
  return fallback;
};
