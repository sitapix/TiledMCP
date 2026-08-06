import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * A transport wrapper for the roots-deferred boot.
 *
 * When no `--project-dir` is given, the sandbox comes from the client's MCP
 * roots -- which the client can only be asked for after `initialize`
 * completes. Until the sandbox exists no project-bound tool is registered, so
 * an early `tools/list` would cache an empty tool list at the client. This
 * wrapper lets the handshake through, buffers every other incoming request
 * and notification, and replays them in arrival order once {@link release} is
 * called after the tools are wired.
 *
 * Responses always pass: the server's own `roots/list` request is answered
 * through this same transport, and gating that answer would deadlock the
 * boot.
 */
export class GatedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;
  sessionId?: string;

  private released = false;
  private readonly buffered: Array<
    [JSONRPCMessage, MessageExtraInfo | undefined]
  > = [];

  constructor(private readonly inner: Transport) {}

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      this.route(message, extra);
    };
    this.inner.onclose = () => {
      this.onclose?.();
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    await this.inner.start();
    if (this.inner.sessionId !== undefined) {
      this.sessionId = this.inner.sessionId;
    }
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  /** Open the gate and replay everything buffered, in arrival order. */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const [message, extra] of this.buffered.splice(0)) {
      this.onmessage?.(message, extra);
    }
  }

  private route(
    message: JSONRPCMessage,
    extra: MessageExtraInfo | undefined,
  ): void {
    if (this.released || passesGate(message)) {
      this.onmessage?.(message, extra);
      return;
    }
    this.buffered.push([message, extra]);
  }
}

function passesGate(message: JSONRPCMessage): boolean {
  if (!("method" in message)) {
    // Responses and errors: the boot's own roots/list answer arrives here.
    return true;
  }
  return (
    message.method === "initialize" ||
    message.method === "notifications/initialized" ||
    message.method === "notifications/cancelled" ||
    message.method === "ping"
  );
}
