// server/src/utils/monitoring.js - Новый модуль для мониторинга

/**
 * Enhanced monitoring and error tracking for FlarePipe
 */
export class TunnelMonitor {
    constructor() {
      this.metrics = {
        requests: {
          total: 0,
          successful: 0,
          failed: 0,
          errors502: 0,
          errors503: 0,
          errors504: 0
        },
        performance: {
          avgResponseTime: 0,
          maxResponseTime: 0,
          minResponseTime: Infinity
        },
        tunnels: {
          active: 0,
          registered: 0,
          expired: 0
        },
        durable_objects: {
          registry_calls: 0,
          registry_errors: 0,
          queue_calls: 0,
          queue_errors: 0,
          overload_events: 0
        }
      };
      
      this.errorHistory = [];
      this.maxErrorHistory = 100;
      this.startTime = Date.now();
    }
  
    /**
     * Track request metrics
     */
    trackRequest(method, path, status, responseTime, error = null) {
      this.metrics.requests.total++;
      
      if (status >= 200 && status < 400) {
        this.metrics.requests.successful++;
      } else {
        this.metrics.requests.failed++;
        
        // Track specific error types
        if (status === 502) this.metrics.requests.errors502++;
        if (status === 503) this.metrics.requests.errors503++;
        if (status === 504) this.metrics.requests.errors504++;
      }
      
      // Update performance metrics
      if (responseTime) {
        this.updatePerformanceMetrics(responseTime);
      }
      
      // Log errors
      if (error) {
        this.logError(method, path, status, error, responseTime);
      }
    }
  
    /**
     * Track Durable Object calls
     */
    trackDurableObjectCall(type, success, error = null) {
      if (type === 'registry') {
        this.metrics.durable_objects.registry_calls++;
        if (!success) this.metrics.durable_objects.registry_errors++;
      } else if (type === 'queue') {
        this.metrics.durable_objects.queue_calls++;
        if (!success) this.metrics.durable_objects.queue_errors++;
      }
      
      if (error && error.overloaded) {
        this.metrics.durable_objects.overload_events++;
      }
    }
  
    /**
     * Update performance metrics
     */
    updatePerformanceMetrics(responseTime) {
      const count = this.metrics.requests.total;
      const currentAvg = this.metrics.performance.avgResponseTime;
      
      this.metrics.performance.avgResponseTime = 
        (currentAvg * (count - 1) + responseTime) / count;
      
      this.metrics.performance.maxResponseTime = 
        Math.max(this.metrics.performance.maxResponseTime, responseTime);
      
      this.metrics.performance.minResponseTime = 
        Math.min(this.metrics.performance.minResponseTime, responseTime);
    }
  
    /**
     * Log error with context
     */
    logError(method, path, status, error, responseTime) {
      const errorEntry = {
        timestamp: Date.now(),
        method,
        path,
        status,
        error: error.message,
        responseTime,
        overloaded: error.overloaded || false,
        retryable: error.retryable || false,
        stack: error.stack
      };
      
      this.errorHistory.push(errorEntry);
      
      // Keep only recent errors
      if (this.errorHistory.length > this.maxErrorHistory) {
        this.errorHistory.shift();
      }
      
      // Enhanced logging for 502 errors
      if (status === 502) {
        console.error('🚨 502 ERROR DETECTED:', {
          method,
          path,
          error: error.message,
          responseTime,
          overloaded: error.overloaded,
          retryable: error.retryable,
          timestamp: new Date().toISOString()
        });
      }
    }
  
    /**
     * Get comprehensive statistics
     */
    getStats() {
      const uptime = Date.now() - this.startTime;
      const requestRate = uptime > 0 ? (this.metrics.requests.total / (uptime / 1000)).toFixed(2) : '0';
      const successRate = this.metrics.requests.total > 0 ? 
        ((this.metrics.requests.successful / this.metrics.requests.total) * 100).toFixed(1) : '100';
      
      const errorRate502 = this.metrics.requests.total > 0 ? 
        ((this.metrics.requests.errors502 / this.metrics.requests.total) * 100).toFixed(2) : '0';
      
      return {
        uptime_ms: uptime,
        uptime_readable: this.formatUptime(uptime),
        requests: {
          ...this.metrics.requests,
          rate_per_second: requestRate,
          success_rate_percent: successRate,
          error_502_rate_percent: errorRate502
        },
        performance: {
          avg_response_time_ms: Math.round(this.metrics.performance.avgResponseTime),
          max_response_time_ms: this.metrics.performance.maxResponseTime,
          min_response_time_ms: this.metrics.performance.minResponseTime === Infinity ? 0 : this.metrics.performance.minResponseTime
        },
        durable_objects: {
          ...this.metrics.durable_objects,
          registry_error_rate: this.metrics.durable_objects.registry_calls > 0 ? 
            ((this.metrics.durable_objects.registry_errors / this.metrics.durable_objects.registry_calls) * 100).toFixed(2) : '0',
          queue_error_rate: this.metrics.durable_objects.queue_calls > 0 ? 
            ((this.metrics.durable_objects.queue_errors / this.metrics.durable_objects.queue_calls) * 100).toFixed(2) : '0'
        },
        recent_errors: this.getRecentErrors(),
        health_status: this.getHealthStatus()
      };
    }
  
    /**
     * Get recent errors
     */
    getRecentErrors() {
      const last10Errors = this.errorHistory.slice(-10);
      return last10Errors.map(error => ({
        timestamp: new Date(error.timestamp).toISOString(),
        method: error.method,
        path: error.path,
        status: error.status,
        error: error.error,
        response_time: error.responseTime,
        overloaded: error.overloaded,
        retryable: error.retryable
      }));
    }
  
    /**
     * Determine health status
     */
    getHealthStatus() {
      const errorRate502 = this.metrics.requests.total > 0 ? 
        (this.metrics.requests.errors502 / this.metrics.requests.total) * 100 : 0;
      
      const overloadRate = this.metrics.durable_objects.registry_calls > 0 ? 
        (this.metrics.durable_objects.overload_events / this.metrics.durable_objects.registry_calls) * 100 : 0;
      
      const avgResponseTime = this.metrics.performance.avgResponseTime;
      
      if (errorRate502 > 10 || overloadRate > 20 || avgResponseTime > 10000) {
        return {
          status: 'critical',
          issues: [
            errorRate502 > 10 ? `High 502 error rate: ${errorRate502.toFixed(1)}%` : null,
            overloadRate > 20 ? `High overload rate: ${overloadRate.toFixed(1)}%` : null,
            avgResponseTime > 10000 ? `Slow responses: ${avgResponseTime.toFixed(0)}ms avg` : null
          ].filter(Boolean)
        };
      }
      
      if (errorRate502 > 5 || overloadRate > 10 || avgResponseTime > 5000) {
        return {
          status: 'warning',
          issues: [
            errorRate502 > 5 ? `Elevated 502 error rate: ${errorRate502.toFixed(1)}%` : null,
            overloadRate > 10 ? `Elevated overload rate: ${overloadRate.toFixed(1)}%` : null,
            avgResponseTime > 5000 ? `Slow responses: ${avgResponseTime.toFixed(0)}ms avg` : null
          ].filter(Boolean)
        };
      }
      
      return {
        status: 'healthy',
        issues: []
      };
    }
  
    /**
     * Format uptime
     */
    formatUptime(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
      if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    }
  
    /**
     * Reset metrics (for testing or periodic resets)
     */
    reset() {
      this.metrics = {
        requests: { total: 0, successful: 0, failed: 0, errors502: 0, errors503: 0, errors504: 0 },
        performance: { avgResponseTime: 0, maxResponseTime: 0, minResponseTime: Infinity },
        tunnels: { active: 0, registered: 0, expired: 0 },
        durable_objects: { registry_calls: 0, registry_errors: 0, queue_calls: 0, queue_errors: 0, overload_events: 0 }
      };
      this.errorHistory = [];
      this.startTime = Date.now();
    }
  }
  
  // Global monitor instance
  export const globalMonitor = new TunnelMonitor();