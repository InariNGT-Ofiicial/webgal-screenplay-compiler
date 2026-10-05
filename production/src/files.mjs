import fs from 'node:fs';
import path from 'node:path';
// Writes and removals must stay in an explicitly owned directory, including real paths.
export function ownedPath(root, relative) {
  if (typeof relative !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(s => !s || s === '.' || s === '..')) throw Error('Unsafe owned file path');
  root = path.resolve(root);
  let current = root;
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw Error('Owned root cannot be a symbolic link');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Owned file path contains a symbolic link');
  }
  return current;
}
