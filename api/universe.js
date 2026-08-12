import { toVercelHandler } from './_lib/adapter.js';
import { universeHandler } from './_lib/handlers.js';

export default toVercelHandler(universeHandler);
