import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

// Criptare compatibilă cu OpenSSL („openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256”),
// ca backup-ul să poată fi decriptat și fără DAX:
//   openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -in backup.tar.gz.enc -out backup.tar.gz
// Format: "Salted__" + sare (8 octeți) + date criptate; cheia și IV-ul vin din PBKDF2-SHA256(parolă, sare).

export const OPENSSL_ITERATIONS = 100_000;
const MAGIC = Buffer.from('Salted__');

function deriveKeyIv(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const material = pbkdf2Sync(passphrase, salt, OPENSSL_ITERATIONS, 48, 'sha256');
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/** Criptează un flux; primul bloc emis e antetul OpenSSL. */
export async function* encryptStream(source: AsyncIterable<Buffer>, passphrase: string): AsyncGenerator<Buffer> {
  if (passphrase.length < 12) throw new Error('Parola de criptare a backup-ului e prea scurtă.');
  const salt = randomBytes(8);
  const { key, iv } = deriveKeyIv(passphrase, salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  yield Buffer.concat([MAGIC, salt]);
  for await (const chunk of source) {
    const out = cipher.update(chunk);
    if (out.length) yield out;
  }
  yield cipher.final();
}

/** Decriptare (folosită de teste și de comanda de restaurare). */
export async function* decryptStream(source: AsyncIterable<Buffer>, passphrase: string): AsyncGenerator<Buffer> {
  let header = Buffer.alloc(0);
  let decipher: ReturnType<typeof createDecipheriv> | null = null;
  for await (const chunk of source) {
    if (!decipher) {
      header = Buffer.concat([header, chunk]);
      if (header.length < 16) continue;
      if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Fișierul nu e un backup criptat DAX/OpenSSL.');
      const { key, iv } = deriveKeyIv(passphrase, header.subarray(8, 16));
      decipher = createDecipheriv('aes-256-cbc', key, iv);
      const rest = header.subarray(16);
      if (rest.length) yield decipher.update(rest);
      continue;
    }
    yield decipher.update(chunk);
  }
  if (!decipher) throw new Error('Fișier criptat incomplet.');
  yield decipher.final();
}
