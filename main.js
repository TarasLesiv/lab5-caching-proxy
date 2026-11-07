import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';

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
