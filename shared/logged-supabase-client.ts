// @ts-nocheck
import { logDbQuery, logError } from './server-logger.js';

function summarizeArgs(args) {
  return args.map((arg) => {
    if (arg === null || arg === undefined) {
      return arg;
    }

    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
      return arg;
    }

    if (Array.isArray(arg)) {
      return arg.slice(0, 10);
    }

    if (typeof arg === 'object') {
      return Object.fromEntries(Object.entries(arg).slice(0, 10));
    }

    return String(arg);
  });
}

function summarizeResult(result) {
  return {
    hasData: result?.data !== undefined,
    rowCount: Array.isArray(result?.data) ? result.data.length : (result?.data ? 1 : 0),
    count: result?.count ?? null,
    status: result?.status ?? null,
    error: result?.error
      ? {
          message: result.error.message,
          code: result.error.code,
          details: result.error.details,
          hint: result.error.hint,
        }
      : null,
  };
}

function wrapQueryBuilder(builder, context) {
  if (!builder || typeof builder !== 'object') {
    return builder;
  }

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        return (onFulfilled, onRejected) => target.then(
          (result) => {
            logDbQuery({
              scope: context.scope,
              table: context.table,
              operations: context.operations,
              durationMs: Date.now() - context.startedAt,
              result: summarizeResult(result),
            });

            if (typeof onFulfilled === 'function') {
              return onFulfilled(result);
            }

            return result;
          },
          (error) => {
            logDbQuery({
              scope: context.scope,
              table: context.table,
              operations: context.operations,
              durationMs: Date.now() - context.startedAt,
              result: { error: { message: error?.message, code: error?.code || null } },
            });
            logError('supabase-query-failed', error, {
              scope: context.scope,
              table: context.table,
              operations: context.operations,
            });

            if (typeof onRejected === 'function') {
              return onRejected(error);
            }

            throw error;
          },
        );
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return (...args) => {
        const next = value.apply(target, args);
        if (prop !== 'then' && prop !== 'catch' && prop !== 'finally') {
          context.operations.push({ method: String(prop), args: summarizeArgs(args) });
        }

        return wrapQueryBuilder(next, context);
      };
    },
  });
}

export function createLoggedSupabaseClient(client, scope) {
  if (!client) {
    return null;
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table) => wrapQueryBuilder(target.from(table), {
          scope,
          table,
          startedAt: Date.now(),
          operations: [{ method: 'from', args: [table] }],
        });
      }

      if (prop === 'rpc') {
        return async (fn, args, options) => {
          const startedAt = Date.now();
          try {
            const result = await target.rpc(fn, args, options);
            logDbQuery({
              scope,
              rpc: fn,
              operations: [{ method: 'rpc', args: summarizeArgs([fn, args, options]) }],
              durationMs: Date.now() - startedAt,
              result: summarizeResult(result),
            });
            return result;
          } catch (error) {
            logDbQuery({
              scope,
              rpc: fn,
              operations: [{ method: 'rpc', args: summarizeArgs([fn, args, options]) }],
              durationMs: Date.now() - startedAt,
              result: { error: { message: error?.message, code: error?.code || null } },
            });
            logError('supabase-rpc-failed', error, { scope, rpc: fn, args: summarizeArgs([args, options]) });
            throw error;
          }
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}