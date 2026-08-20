import { toVercelHandler } from './_lib/adapter.js';
import { marketIndexHandler } from './_lib/marketIndex.js';

export default toVercelHandler(marketIndexHandler);
