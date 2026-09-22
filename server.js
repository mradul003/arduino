import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Basic abuse protection since this may be a public free-hosted endpoint.
const compileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many compile requests, please slow down.' },
});

app.post('/compile', compileLimiter, async (req, res) => {
  const { code } = req.body || {};

  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'No code provided.' });
  }
  if (code.length > 60000) {
    return res.status(400).json({ ok: false, error: 'Sketch is too large.' });
  }

  const id = randomUUID();
  const workDir = path.join(os.tmpdir(), `awi-${id}`);
  const sketchDir = path.join(workDir, 'sketch');
  const outDir = path.join(workDir, 'build');

  try {
    await fs.mkdir(sketchDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    // arduino-cli requires the .ino file name to match its containing folder name.
    await fs.writeFile(path.join(sketchDir, 'sketch.ino'), code, 'utf8');

    const cmd = `arduino-cli compile --fqbn arduino:avr:uno --output-dir "${outDir}" "${sketchDir}"`;
    const { stdout } = await execAsync(cmd, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });

    const hexPath = path.join(outDir, 'sketch.ino.hex');
    const hex = await fs.readFile(hexPath, 'utf8');

    res.json({ ok: true, hex, log: stdout });
  } catch (err) {
    const message = (err && (err.stderr || err.message)) || String(err);
    res.status(400).json({ ok: false, error: message });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Arduino Web IDE listening on port ${PORT}`);
});
