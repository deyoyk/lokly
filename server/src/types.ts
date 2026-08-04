export interface Env {
  TUNNEL_DO: DurableObjectNamespace<import("./tunnel-do").TunnelDO>;
}

export interface PendingRequest {
  resolve: (response: ProxyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  ws: WebSocket;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
