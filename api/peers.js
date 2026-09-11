import { toVercelHandler } from './_lib/adapter.js';
import { peersHandler } from './_lib/handlers.js';

export default toVercelHandler(peersHandler);
