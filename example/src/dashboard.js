import { add } from './math';
import { formatNumber } from './utils';

export function init() {
  console.log('Dashboard initialized');
  const total = add(100, 200);
  const formatted = formatNumber(total);
  console.log(`Dashboard total: ${formatted}`);
}

export function renderChart() {
  console.log('Chart rendered');
}

export function unusedDashboardFn() {
  console.log('This dashboard function is never used');
}
