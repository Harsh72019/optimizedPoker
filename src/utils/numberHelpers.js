/**
 * Utility functions for handling floating-point precision issues in poker chip calculations
 */

/**
 * Round a number to 2 decimal places to avoid floating-point precision errors
 * @param {number} value - The value to round
 * @returns {number} - Rounded value
 */
const roundChips = (value) => {
  if (typeof value !== 'number' || isNaN(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
};

/**
 * Safely add two chip amounts
 * @param {number} a - First amount
 * @param {number} b - Second amount
 * @returns {number} - Sum rounded to 2 decimals
 */
const addChips = (a, b) => {
  return roundChips((a || 0) + (b || 0));
};

/**
 * Safely subtract two chip amounts
 * @param {number} a - Amount to subtract from
 * @param {number} b - Amount to subtract
 * @returns {number} - Difference rounded to 2 decimals
 */
const subtractChips = (a, b) => {
  return roundChips((a || 0) - (b || 0));
};

/**
 * Safely multiply chip amount
 * @param {number} a - Amount
 * @param {number} multiplier - Multiplier
 * @returns {number} - Product rounded to 2 decimals
 */
const multiplyChips = (a, multiplier) => {
  return roundChips((a || 0) * (multiplier || 0));
};

/**
 * Safely divide chip amount
 * @param {number} a - Amount to divide
 * @param {number} divisor - Divisor
 * @returns {number} - Quotient rounded to 2 decimals
 */
const divideChips = (a, divisor) => {
  if (!divisor || divisor === 0) {
    return 0;
  }
  return roundChips((a || 0) / divisor);
};

/**
 * Get minimum of two chip amounts
 * @param {number} a - First amount
 * @param {number} b - Second amount
 * @returns {number} - Minimum value rounded
 */
const minChips = (a, b) => {
  return roundChips(Math.min(a || 0, b || 0));
};

/**
 * Get maximum of two chip amounts
 * @param {number} a - First amount
 * @param {number} b - Second amount
 * @returns {number} - Maximum value rounded
 */
const maxChips = (a, b) => {
  return roundChips(Math.max(a || 0, b || 0));
};

module.exports = {
  roundChips,
  addChips,
  subtractChips,
  multiplyChips,
  divideChips,
  minChips,
  maxChips,
};
