import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Share the same handlers between local dev and the Vercel app-root deployment.
import rateRouter from './api/rate.ts';
import walletRouter from './api/wallet.ts';
import createVirtualAccountRouter from './api/create-virtual-account.ts';
import paymentPointWebhookRouter from './api/paymentpoint-webhook.ts';
import verifyPaymentRouter from './api/verify-payment.ts';
import startSessionRouter from './api/start-session.ts';
import sessionStatusRouter from './api/session-status.ts';
import endSessionRouter from './api/end-session.ts';
import versionRouter from './api/version.ts';
import { supabaseAdminConfigError } from './api/supabase.ts';
import { logError, logRequest } from '../shared/server-logger.js';

const app = express();
const PORT = process.env.PORT || 3000;
const decartConfigError = process.env.DECART_API_KEY?.trim()
  ? null
  : 'Missing DECART_API_KEY';

// Middleware
app.use(cors());
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  logRequest({
    event: 'request-start',
    requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });

  res.on('finish', () => {
    logRequest({
      event: 'request-finish',
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});
app.use('/api/paymentpoint-webhook', express.raw({ type: '*/*' }), paymentPointWebhookRouter);
app.use(express.json());

// API Routes
app.use('/api/rate', rateRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/create-virtual-account', createVirtualAccountRouter);
app.use('/api/verify-payment', verifyPaymentRouter);
app.use('/api/start-session', startSessionRouter);
app.use('/api/session-status', sessionStatusRouter);
app.use('/api/end-session', endSessionRouter);
app.use('/api/version', versionRouter);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (supabaseAdminConfigError) {
    console.warn(`[config] ${supabaseAdminConfigError}`);
  }
  if (decartConfigError) {
    console.warn(`[config] ${decartConfigError}`);
  }
});

app.use((error, req, res, next) => {
  logError('express-unhandled-error', error, {
    requestId: req?.requestId,
    method: req?.method,
    path: req?.originalUrl,
  });

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ status: 'failed', message: 'Internal server error' });
});
