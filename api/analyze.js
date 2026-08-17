import { toVercelHandler } from './_lib/adapter.js';
import { analyzeHandler } from './_lib/analyze.js';

export default toVercelHandler(analyzeHandler);
