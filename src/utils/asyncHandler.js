/**
 * Wraps an async route handler so a rejected promise reaches the central error
 * handler instead of becoming an unhandled rejection.
 */

/**
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
 */
export const asyncErrorHandler = (handler) => (err, req, res, next) => {
  Promise.resolve(handler(err, req, res, next)).catch(next);
};

export default asyncHandler;
