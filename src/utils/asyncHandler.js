/**
 * ---------------------------------------------------------------------------
 * ASYNC HANDLER
 * ---------------------------------------------------------------------------
 * Wraps an async route handler so a rejected promise reaches the central error
 * handler instead of becoming an unhandled rejection.
 *
 *     router.get('/:id', asyncHandler(async (req, res) => {
 *       const book = await bookService.getById(req.params.id);   // may throw
 *       return ok(res, book);
 *     }));
 *
 * Without it, every handler needs its own try/catch whose only job is
 * `catch (e) { next(e) }` — noise that obscures the actual logic, and that
 * someone eventually forgets to write.
 *
 * NOTE ON EXPRESS 5: Express 5 forwards rejected promises from async handlers
 * automatically, so this is no longer strictly required. It is kept anyway for
 * three reasons: it makes the intent explicit at each route, it keeps handlers
 * working identically if the app is ever run on Express 4, and it gives one
 * place to add cross-cutting behaviour (timing, tracing) later. The cost is a
 * single function call per request.
 * ---------------------------------------------------------------------------
 */

/**
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} handler
 * @returns {import('express').RequestHandler}
 */
export const asyncHandler = (handler) => (req, res, next) => {
  // Promise.resolve() handles both async functions and plain ones that happen
  // to return a promise, so the wrapper is safe to apply to anything.
  Promise.resolve(handler(req, res, next)).catch(next);
};

/**
 * Same idea for error-handling middleware, which Express identifies by its
 * four-parameter signature. That arity must be preserved exactly, or Express
 * treats the function as ordinary middleware and never passes it an error.
 *
 * @param {(err: Error, req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} handler
 */
export const asyncErrorHandler = (handler) => (err, req, res, next) => {
  Promise.resolve(handler(err, req, res, next)).catch(next);
};

export default asyncHandler;
