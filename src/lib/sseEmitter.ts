export interface SSEProgressData {
  stage: string;
  message: string;
  status: 'started' | 'complete' | 'error';
  timestamp?: string;
  timing?: {
    elapsed_ms: number;
    estimated_remaining_ms?: number;
  };
  cost?: {
    usd: number;
  };
  data?: Record<string, any>;
}

export class SSEEmitter {
  private context: any;
  private stream: any;
  private startTime: number;

  constructor(context: any, stream: any) {
    this.context = context;
    this.stream = stream;
    this.startTime = Date.now();
  }

  /**
   * Emit a progress event
   */
  async emit(data: SSEProgressData): Promise<void> {
    const event = {
      id: crypto.randomUUID(),
      event: 'progress',
      data: {
        ...data,
        timestamp: data.timestamp || new Date().toISOString(),
        timing: {
          elapsed_ms: Date.now() - this.startTime,
          ...data.timing
        }
      }
    };

    await this.send(event);
  }

  /**
   * Emit final completion event
   */
  async complete(data: any, cost: number): Promise<void> {
    const event = {
      id: crypto.randomUUID(),
      event: 'complete',
      data: {
        stage: 'complete',
        message: 'Enrichment complete',
        status: 'complete' as const,
        timestamp: new Date().toISOString(),
        timing: {
          elapsed_ms: Date.now() - this.startTime
        },
        cost: {
          usd: cost
        },
        data
      }
    };

    await this.send(event);
  }

  /**
   * Emit error event
   */
  async error(error: Error): Promise<void> {
    const event = {
      id: crypto.randomUUID(),
      event: 'error',
      data: {
        stage: 'error',
        message: error.message,
        status: 'error' as const,
        timestamp: new Date().toISOString(),
        timing: {
          elapsed_ms: Date.now() - this.startTime
        }
      }
    };

    await this.send(event);
  }

  /**
   * Send SSE formatted message
   */
  private async send(event: { id: string; event: string; data: any }): Promise<void> {
    const sseMessage = `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    try {
      await this.stream.write(sseMessage);
    } catch (err) {
      console.error('Failed to write SSE message:', err);
    }
  }
}

/**
 * Helper to create SSE response headers
 */
export function createSSEHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  };
}
