import { toVercelHandler } from './_lib/adapter.js';
import { fundamentalsHandler } from './_lib/fundamentals.js';

export default toVercelHandler(fundamentalsHandler);
