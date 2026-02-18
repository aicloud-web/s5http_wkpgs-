const pyip = ['[2a00:1098:2b::1:6815:5881]','pyip.ygkkk.dpdns.org']; //自定义proxyip：''之间可使用IP或者域名，IPV6需[]，不支持带端口
const token = '';//''之间可使用任意字符密码，客户端token保持一致

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const encoder = new TextEncoder();
import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url); // این خط معمولاً در کدت هست

      // --- 🟢 کد تست را دقیقاً اینجا قرار بده 🟢 ---
      if (url.pathname === "/check-my-token") {
        const debugToken = env.TOKEN || env.token || "❌ توکن در داشبورد یافت نشد";
        return new Response(`مقدار توکن ذخیره شده: ${debugToken}`, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
      // --- 🔴 پایان بخش تست 🔴 ---
      
      // ۱. استخراج توکن از داشبورد کلودفلر (اگر نبود، از مقدار پیش‌فرض استفاده کن)
      const activeToken = env.TOKEN ; 
      
      const upgradeHeader = request.headers.get('Upgrade');

      // ۲. فیلتر ترافیک عادی (نمایش سایت ادیتور AI)
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return await env.ASSETS.fetch(request);
      }

      // ۳. بررسی توکن امنیتی برای اتصال پروکسی
      // اگر کاربر توکن ست کرده باشد ولی در درخواست نباشد -> نمایش سایت نقاب
      const clientProtocol = request.headers.get('Sec-WebSocket-Protocol');
      if (activeToken && clientProtocol !== activeToken) {
        return await env.ASSETS.fetch(request);
      }

      // ۴. برقراری اتصال WebSocket (بخش اصلی پروکسی)
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      
      // اجرای هندل کردن سشن (ارسال ترافیک به سمت Proxy IP)
      handleSession(server).catch(() => safeCloseWebSocket(server));

      const responseInit = {
        status: 101, // Switching Protocols
        webSocket: client
      };

      // برگرداندن توکن در هدر پاسخ برای تایید هندشیک
      if (activeToken) {
        responseInit.headers = { 'Sec-WebSocket-Protocol': activeToken };
      }

      return new Response(null, responseInit);

    } catch (err) {
      // در صورت بروز خطای داخلی، سایت را نشان بده تا سیستم از کار نیفتد
      console.error(err);
      return await env.ASSETS.fetch(request);
    }
  },
};
async function handleSession(webSocket) {
  let remoteSocket, remoteWriter, remoteReader;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    try { remoteWriter?.releaseLock(); } catch {}
    try { remoteReader?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}
    remoteWriter = remoteReader = remoteSocket = null;
    safeCloseWebSocket(webSocket);
  };
  const pumpRemoteToWebSocket = async () => {
    try {
      while (!isClosed && remoteReader) {
        const { done, value } = await remoteReader.read();

        if (done) break;
        if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
        if (value?.byteLength > 0) webSocket.send(value);
      }
    } catch {}

    if (!isClosed) {
      try { webSocket.send('CLOSE'); } catch {}
      cleanup();
    }
  };
  const parseAddress = (addr) => {
    if (addr[0] === '[') {
      const end = addr.indexOf(']');
      return {
        host: addr.substring(1, end),
        port: parseInt(addr.substring(end + 2), 10)
      };
    }
    const sep = addr.lastIndexOf(':');
    return {
      host: addr.substring(0, sep),
      port: parseInt(addr.substring(sep + 1), 10)
    };
  };
  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('cloudflare');
  };
  const parseClientPyip = (s) => {
    if (!s) return null;
    const trimmed = String(s).trim();
    if (!trimmed.toUpperCase().startsWith('PYIP=')) return null;

    const val = trimmed.substring(5).trim();
    if (!val) return null;

    const arr = val.split(',')
      .map(x => x.trim())
      .filter(Boolean);

    return arr.length ? arr : null;
  };
  const connectToRemote = async (targetAddr, firstFrameData, clientPyip) => {
    const { host, port } = parseAddress(targetAddr);

    const pyipList = (Array.isArray(clientPyip) && clientPyip.length)
      ? clientPyip
      : pyip;
    const attempts = [null, ...pyipList];
    for (let i = 0; i < attempts.length; i++) {
      try {
        remoteSocket = connect({
          hostname: attempts[i] || host,
          port
        });
        if (remoteSocket.opened) await remoteSocket.opened;
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();
        if (firstFrameData) {
          await remoteWriter.write(encoder.encode(firstFrameData));
        }
        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket();
        return;
      } catch (err) {
        try { remoteWriter?.releaseLock(); } catch {}
        try { remoteReader?.releaseLock(); } catch {}
        try { remoteSocket?.close(); } catch {}
        remoteWriter = remoteReader = remoteSocket = null;

        if (!isCFError(err) || i === attempts.length - 1) {
          throw err;
        }
      }
    }
  };
  webSocket.addEventListener('message', async (event) => {
    if (isClosed) return;
    try {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.startsWith('CONNECT:')) {
          const parts = data.substring(8).split('|');
          const targetAddr = parts[0] || '';
          const firstFrameData = parts[1] ?? '';
          const clientPyip = parseClientPyip(parts[2]);
          await connectToRemote(targetAddr, firstFrameData, clientPyip);
        }
        else if (data.startsWith('DATA:')) {
          if (remoteWriter) {
            await remoteWriter.write(encoder.encode(data.substring(5)));
          }
        }
        else if (data === 'CLOSE') {
          cleanup();
        }
      }
      else if (data instanceof ArrayBuffer && remoteWriter) {
        await remoteWriter.write(new Uint8Array(data));
      }
    } catch (err) {
      try { webSocket.send('ERROR:' + err.message); } catch {}
      cleanup();
    }
  });
  webSocket.addEventListener('close', cleanup);
  webSocket.addEventListener('error', cleanup);
}
function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN ||
        ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}
