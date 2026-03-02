/**
 * Performance Monitoring Utility
 * Tracks execution time of critical operations
 */

class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.slowOperationThreshold = 1000; // 1 second
  }

  /**
   * Start timing an operation
   * @param {string} operationName - Name of the operation
   * @returns {function} - Function to call when operation completes
   */
  start(operationName) {
    const startTime = Date.now();
    
    return () => {
      const duration = Date.now() - startTime;
      this.record(operationName, duration);
      
      if (duration > this.slowOperationThreshold) {
        console.warn(`⚠️ SLOW OPERATION: ${operationName} took ${duration}ms`);
      }
      
      return duration;
    };
  }

  /**
   * Record a metric
   */
  record(operationName, duration) {
    if (!this.metrics.has(operationName)) {
      this.metrics.set(operationName, {
        count: 0,
        totalTime: 0,
        minTime: Infinity,
        maxTime: 0,
        avgTime: 0
      });
    }

    const metric = this.metrics.get(operationName);
    metric.count++;
    metric.totalTime += duration;
    metric.minTime = Math.min(metric.minTime, duration);
    metric.maxTime = Math.max(metric.maxTime, duration);
    metric.avgTime = metric.totalTime / metric.count;
  }

  /**
   * Get metrics for an operation
   */
  getMetrics(operationName) {
    return this.metrics.get(operationName) || null;
  }

  /**
   * Get all metrics
   */
  getAllMetrics() {
    const result = {};
    this.metrics.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics.clear();
  }

  /**
   * Print summary
   */
  printSummary() {
    console.log('\n📊 Performance Summary:');
    console.log('═'.repeat(80));
    
    this.metrics.forEach((metric, name) => {
      console.log(`\n${name}:`);
      console.log(`  Count: ${metric.count}`);
      console.log(`  Avg: ${metric.avgTime.toFixed(2)}ms`);
      console.log(`  Min: ${metric.minTime}ms`);
      console.log(`  Max: ${metric.maxTime}ms`);
      console.log(`  Total: ${metric.totalTime}ms`);
    });
    
    console.log('\n' + '═'.repeat(80));
  }
}

// Singleton instance
const monitor = new PerformanceMonitor();

module.exports = monitor;
