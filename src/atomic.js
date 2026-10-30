import fs from 'node:fs';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// На Windows rename поверх существующего файла иногда падает с EPERM,
// если файл в этот момент держит антивирус или индексатор.
export function writeFileAtomic(file, data, options = {}) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, options);

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code)) throw err;
      if (attempt >= 3) {
        fs.writeFileSync(file, data, options);
        fs.rmSync(tmp, { force: true });
        return;
      }
      sleep(120);
    }
  }
}
