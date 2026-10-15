import { toVercelHandler } from './_lib/adapter.js';
import { intradayHandler } from './_lib/handlers.js';

export default toVercelHandler(intradayHandler);
