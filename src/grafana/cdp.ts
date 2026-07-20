// Chrome DevTools Protocol(CDP) 클라이언트.
// CDP 직결 방식 — 외부 브라우저 조작 CLI 의존 없음.
import WebSocket from 'ws';

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const base = (port: number) => `http://127.0.0.1:${port}`;

/** CDP HTTP 엔드포인트가 살아있는지 (브라우저 기동 여부) */
export async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${base(port)}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 브라우저 레벨 WebSocket URL (Target.createTarget 등 브라우저 단위 명령용) */
export async function browserWsUrl(port: number): Promise<string | null> {
  try {
    const res = await fetch(`${base(port)}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    return info.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

export async function listTargets(port: number): Promise<CdpTarget[] | null> {
  try {
    const res = await fetch(`${base(port)}/json`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as CdpTarget[];
  } catch {
    return null;
  }
}

/** 새 탭 생성. Chrome 111+는 PUT을 요구한다. */
export async function createTarget(port: number, url: string): Promise<CdpTarget | null> {
  try {
    const res = await fetch(`${base(port)}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as CdpTarget;
  } catch {
    return null;
  }
}

export async function closeTarget(port: number, targetId: string): Promise<void> {
  try {
    await fetch(`${base(port)}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) });
  } catch {
    /* 닫기 실패는 무시 */
  }
}

/** 탭 하나에 붙는 CDP 세션. call()은 id 매칭으로 응답을 기다린다. */
export class CdpSession {
  private mid = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private ws: WebSocket) {
    ws.on('message', (data) => {
      let msg: { id?: number; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    });
    ws.on('error', () => {
      /* close 이후 에러 무시 — pending은 타임아웃으로 정리됨 */
    });
  }

  static connect(wsUrl: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
      ws.once('open', () => resolve(new CdpSession(ws)));
      ws.once('error', (e) => reject(e));
    });
  }

  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.mid;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
    });
  }

  /** JS 실행 후 값 반환 (returnByValue) */
  async eval(expression: string): Promise<any> {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}
