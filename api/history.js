import { toVercelHandler } from './_lib/adapter.js';
import { historyHandler } from './_lib/handlers.js';

export default toVercelHandler(historyHandler);
