export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export function unusedFn() {
  console.log('This function is never used and should be tree-shaken');
  return multiply(1, 2);
}
