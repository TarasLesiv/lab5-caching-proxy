import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Command } from 'commander';

const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];

const program = new Command();

program
  .name('main.js')
  .description('Кешуючий HTTP-проксі-сервер для картинок із сайту https://http.cat')
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса сервера (обов’язково)')
  .requiredOption('-p, --port <number>', 'порт сервера (обов’язково)')
  .requiredOption('-c, --cache <path>', 'шлях до теки кешу (обов’язково)');

program.parse(process.argv);

const options = program.opts();
const host = options.host;
const port = Number(options.port);
const cacheDir = path.resolve(options.cache);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Помилка: --port має бути цілим числом від 1 до 65535');
  process.exit(1);
}

try {
  await fs.mkdir(cacheDir, { recursive: true });
} catch (mkdirError) {
  console.error(`Помилка створення теки кешу "${cacheDir}": ${mkdirError.message}`);
  process.exit(1);
}

function sendText(res, statusCode, message, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(message);
}

function extractStatusCode(rawUrl) {
  try {
    const { pathname } = new URL(rawUrl, 'http://localhost');
    const match = /^\/([1-9]\d{2})$/.exec(pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_METHODS.includes(req.method)) {
      sendText(res, 405, `Method Not Allowed: метод ${req.method} не підтримується\n`, {
        Allow: ALLOWED_METHODS.join(', '),
      });
      return;
    }

    const code = extractStatusCode(req.url);
    if (!code) {
      sendText(res, 400, 'Bad Request: шлях URL має містити трицифровий код стану HTTP (наприклад, /200)\n');
      return;
    }

    sendText(res, 501, 'Not Implemented\n');
  } catch (handlerError) {
    console.error(`Помилка обробки запиту ${req.method} ${req.url}: ${handlerError.message}`);
    if (!res.headersSent) {
      sendText(res, 500, 'Internal Server Error: внутрішня помилка сервера\n');
    } else {
      res.end();
    }
  }
});

try {
  server.listen(port, host);
  await once(server, 'listening');
  console.log(`Сервер слухає http://${host}:${port}`);
  console.log(`Тека кешу: ${cacheDir}`);
} catch (listenError) {
  console.error(`Помилка запуску сервера: ${listenError.message}`);
  process.exit(1);
}
