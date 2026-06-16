import { add, subtract, multiply, unusedFn } from './math';
import { formatNumber } from './utils';
import logger from './logger';
import './side-effects';

const result1 = add(10, 20);
const result2 = subtract(50, 30);
const formatted = formatNumber(result1);

console.log(`10 + 20 = ${result1}`);
console.log(`50 - 30 = ${result2}`);
console.log(`Formatted: ${formatted}`);

logger.log('Application started');

async function loadDashboard() {
  const dashboard = await import('./dashboard');
  dashboard.init();
}

loadDashboard();

if (typeof globalThis !== 'undefined') {
  globalThis.loadDashboard = loadDashboard;
}
