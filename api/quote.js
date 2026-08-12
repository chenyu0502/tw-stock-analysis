import { toVercelHandler } from './_lib/adapter.js';
import { quoteHandler } from './_lib/handlers.js';

export default toVercelHandler(quoteHandler);
