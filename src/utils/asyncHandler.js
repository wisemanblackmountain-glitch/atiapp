/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Express 4 does not await handlers. Without this, any rejection inside an
 * async handler becomes an unhandled rejection and the request hangs until the
 * client times out — the error page never renders and nothing is logged
 * through the normal path.
 *
 * Express 5 handles this natively; this wrapper can be dropped on upgrade.
 */

'use strict';

module.exports = function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
