import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Command } from 'commander';
import superagent from 'superagent';

const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];

// Розбір параметрів командного рядка
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

// Підготовка теки кешу до початку приймання запитів
try {
  await fs.mkdir(cacheDir, { recursive: true });
} catch (mkdirError) {
  console.error(`Помилка створення теки кешу "${cacheDir}": ${mkdirError.message}`);
  process.exit(1);
}

// Надсилання текстової відповіді
function sendText(res, statusCode, message, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(message);
}

// Перевірка шляху URL: дозволено лише трицифрові коди 100..999
function extractStatusCode(rawUrl) {
  try {
    const { pathname } = new URL(rawUrl, 'http://localhost');
    const match = /^\/([1-9]\d{2})$/.exec(pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getCacheFilePath(code) {
  return path.join(cacheDir, `${code}.jpg`);
}

// Асинхронне читання двійкового тіла запиту через проміс-ітератор потоку
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Атомарний запис картинки в кеш через тимчасовий файл і перейменування
async function saveToCache(filePath, imageBuffer) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, imageBuffer);
    await fs.rename(tempPath, filePath);
  } catch (writeError) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ігноруємо, якщо тимчасовий файл не було створено
    }
    throw writeError;
  }
}

// Обробка GET: повернення з кешу або завантаження з http.cat
async function handleGet(code, res) {
  const filePath = getCacheFilePath(code);

  try {
    const cachedImage = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': cachedImage.length,
      'X-Image-Source': 'cache',
    });
    res.end(cachedImage);
    return;
  } catch (readError) {
    if (readError.code !== 'ENOENT') {
      throw readError;
    }
  }

  let upstreamResponse;
  try {
    upstreamResponse = await superagent.get(`https://http.cat/${code}`);
  } catch {
    sendText(res, 404, `Not Found: картинку для коду ${code} не знайдено ні в кеші, ні на http.cat\n`);
    return;
  }

  const imageBuffer = upstreamResponse.body;
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    sendText(res, 404, `Not Found: некоректна відповідь від http.cat для коду ${code}\n`);
    return;
  }

  await saveToCache(filePath, imageBuffer);

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': imageBuffer.length,
    'X-Image-Source': 'http.cat',
  });
  res.end(imageBuffer);
}

// Обробка PUT: збереження або заміна картинки в кеші
async function handlePut(code, req, res) {
  const imageBuffer = await readRequestBody(req);
  if (imageBuffer.length === 0) {
    sendText(res, 400, 'Bad Request: тіло PUT-запиту не може бути порожнім\n');
    return;
  }

  const filePath = getCacheFilePath(code);
  await saveToCache(filePath, imageBuffer);
  sendText(res, 201, `Created: картинку для коду ${code} збережено в кеш\n`);
}

// Обробка DELETE: видалення картинки з кешу
async function handleDelete(code, res) {
  const filePath = getCacheFilePath(code);

  try {
    await fs.unlink(filePath);
    sendText(res, 200, `OK: картинку для коду ${code} видалено з кешу\n`);
  } catch (unlinkError) {
    if (unlinkError.code === 'ENOENT') {
      sendText(res, 404, `Not Found: картинки для коду ${code} немає в кеші\n`);
      return;
    }
    throw unlinkError;
  }
}

// Єдиний дозволений колбек — async-обробник запиту для http.createServer()
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

    if (req.method === 'GET') {
      await handleGet(code, res);
      return;
    }

    if (req.method === 'PUT') {
      await handlePut(code, req, res);
      return;
    }

    if (req.method === 'DELETE') {
      await handleDelete(code, res);
      return;
    }
  } catch (handlerError) {
    console.error(`Помилка обробки запиту ${req.method} ${req.url}: ${handlerError.message}`);
    if (!res.headersSent) {
      sendText(res, 500, 'Internal Server Error: внутрішня помилка сервера\n');
    } else {
      res.end();
    }
  }
});

// Запуск сервера з очікуванням події listening через проміс
try {
  server.listen(port, host);
  await once(server, 'listening');
  console.log(`Сервер слухає http://${host}:${port}`);
  console.log(`Тека кешу: ${cacheDir}`);
} catch (listenError) {
  console.error(`Помилка запуску сервера: ${listenError.message}`);
  process.exit(1);
}
