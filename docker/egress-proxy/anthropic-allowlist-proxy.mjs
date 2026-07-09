import http from 'node:http';
import net from 'node:net';

const allowHost = process.env.ALLOW_HOST ?? 'api.anthropic.com';
const allowPort = Number(process.env.ALLOW_PORT ?? '443');
const port = Number(process.env.PORT ?? '8888');

function denyConnect(socket, reason) {
  socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`);
  socket.destroy();
}

function parseConnectTarget(url) {
  const lastColon = url.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const host = url.slice(0, lastColon).toLowerCase();
  const targetPort = Number(url.slice(lastColon + 1));
  if (!host || !Number.isInteger(targetPort)) return null;
  return { host, port: targetPort };
}

const server = http.createServer((req, res) => {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Only HTTPS CONNECT to the configured allowlisted host is permitted.\n');
});

server.on('connect', (req, clientSocket, head) => {
  const target = parseConnectTarget(req.url ?? '');
  if (!target) {
    denyConnect(clientSocket, 'Malformed CONNECT target.');
    return;
  }

  if (target.host !== allowHost || target.port !== allowPort) {
    denyConnect(clientSocket, `Denied by egress allowlist: ${target.host}:${target.port}`);
    return;
  }

  const upstream = net.connect(target.port, target.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (error) => {
    if (!clientSocket.destroyed) {
      denyConnect(clientSocket, `Upstream connection failed: ${error.message}`);
    }
  });

  clientSocket.on('error', () => {
    upstream.destroy();
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Anthropic egress allowlist proxy listening on ${port}; allowed=${allowHost}:${allowPort}`);
});
