// Pornește serverul (port 3000) și interfața Vite (port 5173) în paralel, pentru dezvoltare.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit', env: process.env }),
  spawn('npm', ['run', 'dev', '-w', 'web'], { stdio: 'inherit', env: process.env }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && stop());
