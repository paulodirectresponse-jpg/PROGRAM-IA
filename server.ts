import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { initializeDatabase } from './server/db/index.js';
import { router as apiRouter } from './server/routes.js';

dotenv.config();

// Initialize SQLite database and run migrations
initializeDatabase();

const app = express();
const PORT = 3000;

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware for cookies and parsing JSON with generous size limit for project files/diffs
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CSRF Protection & Token Distribution
app.use((req, res, next) => {
  let csrfToken = req.cookies?.['forge_csrf'];
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(24).toString('hex');
    res.cookie('forge_csrf', csrfToken, {
      httpOnly: false, // Accessible to client JS for header inclusion
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), app: 'Forge Agent' });
});

// Mount API routes
app.use('/api', apiRouter);


// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Forge Agent full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
