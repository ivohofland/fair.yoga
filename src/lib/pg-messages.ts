/** pg-pool's own text for a pool wait that outlived `connectionTimeoutMillis` (driver text). */
export const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/** pg-pool's own text for a connect that outlived `connectionTimeoutMillis` while a new client's `connect` was still running, before any client was handed out (driver text). */
export const PG_CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

/** pg's own text for a socket that ended cleanly while the client was not ending it, with no `ErrorResponse` before it; a reset arrives as `ECONNRESET` instead (driver text). */
export const PG_CONNECTION_TERMINATED_MESSAGE = 'Connection terminated unexpectedly';
