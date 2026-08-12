import { toVercelHandler } from './_lib/adapter.js';
import { valuationHandler } from './_lib/handlers.js';

export default toVercelHandler(valuationHandler);
