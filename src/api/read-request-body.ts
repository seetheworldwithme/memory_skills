import type { IncomingMessage } from "node:http";

/**
 * 请求体读取器：主服务 HTTP API 与远程 MCP 入口共用的 1MB 红线执行点。
 *
 * 超限时不能直接中断读取（在 for await 中 throw/break 会触发流的 return()
 * 销毁请求流）：残余 body 无人接收时客户端的写会阻塞在半路，而 HTTP/1.1
 * 客户端往往要写完请求才处理响应——在小缓冲区管道（如 Linux CI Runner）
 * 上双方互相等待形成死锁，错误响应永远到不了客户端。
 * 因此超限后切换为丢弃式排空，让客户端把 body 写完、完整收到错误响应；
 * 排空总量超过 DRAIN_LIMIT_BYTES 则判定对端在恶意拖长连接，直接断开。
 */

/** 超限后最多继续排空的字节数；超过即断开连接，防御无限 chunked body。 */
const DRAIN_LIMIT_BYTES = 8_000_000;

/** 请求体超限错误：由各入口按自身契约映射状态码（HTTP API 400、远程 MCP 413）。 */
export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** 读取请求体至多 maxBytes；超限时排空残余数据后抛 RequestBodyTooLargeError。 */
export function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let overLimit = false;
    let settled = false;
    const settle = (run: () => void) => {
      if (!settled) {
        settled = true;
        run();
      }
    };
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (overLimit) {
        // 排空模式：丢弃残余数据，仅监视恶意拖长
        if (received > maxBytes + DRAIN_LIMIT_BYTES) request.destroy();
        return;
      }
      if (received > maxBytes) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => settle(() => {
      if (overLimit) {
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      resolve(Buffer.concat(chunks));
    }));
    request.on("error", (error) => settle(() => reject(error)));
    // close 兼作兜底：排空被断开时按超限报，正常路径已被 settled 挡住
    request.on("close", () => settle(() => (
      overLimit
        ? reject(new RequestBodyTooLargeError(maxBytes))
        : reject(new Error("request body interrupted"))
    )));
  });
}
