import { mkdir, copyFile, cp, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
for (const name of ['index.html', '.nojekyll']) await copyFile(path.join(root, name), path.join(root, 'dist', name));
for (const name of ['src', 'assets']) await cp(path.join(root, name), path.join(root, 'dist', name), { recursive: true });
for (const name of ['src/app.js', 'src/styles.css', 'src/domain.js', 'src/exports.js']) await access(path.join(root, 'dist', name));
console.log('Static site built in dist/ (no credentials or server code included).');
