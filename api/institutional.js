import { toVercelHandler } from './_lib/adapter.js';
import { institutionalHandler } from './_lib/handlers.js';

export default toVercelHandler(institutionalHandler);
