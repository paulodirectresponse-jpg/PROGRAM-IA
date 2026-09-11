import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { initializeDatabase } from './server/db/index.js';
import { router as apiRouter } from './server/routes.js';

dotenv.config();

// Initialize SQLite database and run migrations
initializeDatabase();

const app = express();
const PORT = 3000;

// Middleware for parsing JSON with generous size limit for project files/diffs
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
