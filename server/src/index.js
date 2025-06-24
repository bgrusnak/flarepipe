// server/src/index-optimized.js - Оптимизированная версия с шардингом и балансировкой нагрузки

import { TunnelRegistry } from './durable-objects/tunnel-registry.js';
import { RequestQueue } from './durable-objects/request-queue.js';
import ResponseBuilder from './utils/response-builder.js';

// Export Durable Object classes for Cloudflare
export { TunnelRegistry, RequestQueue };

// Global monitor for tracking with circuit breaker
let globalMonitor = null;
let circuitBreaker = null;

// Circuit breaker for Durable Objects
class CircuitBreaker {
  constructor() {
    this.failureThreshold = 5;
    this.recoveryTimeout = 30000; // 30 seconds
    this.monitorWindow = 60000; // 1 minute
    
    // Per-shard state
    this.shardStates = new Map();
    this.globalState = {
      status: 'closed', // closed, open, half-open
      failures: 0,
      lastFailure: 0,
      lastSuccess: 0
    };
  }

  getShardState(shardId) {
    if (!this.shardStates.has(shardId)) {
      this.shardStates.set(shardId, {
        status: 'closed',
        failures: 0,
        lastFailure: 0,
        lastSuccess: 0
      });
    }
    return this.shardStates.get(shardId);
  }

  recordSuccess(shardId = 'global') {
    const state = shardId === 'global' ? this.globalState : this.getShardState(shardId);
    state.failures = 0;
    state.lastSuccess = Date.now();
    state.status = 'closed';
  }

  recordFailure(shardId = 'global') {
    const state = shardId === 'global' ? this.globalState : this.getShardState(shardId);
    state.failures++;
    state.lastFailure = Date.now();
    
    if (state.failures >= this.failureThreshold) {
      state.status = 'open';
      console.warn(`Circuit breaker opened for ${shardId}`);
    }
  }

  canExecute(shardId = 'global') {
    const state = shardId === 'global' ? this.globalState : this.getShardState(shardId);
    const now = Date.now();
    
    if (state.status === 'closed') {
      return true;
    }
    
    if (state.status === 'open') {
      if (now - state.lastFailure > this.recoveryTimeout) {
        state.status = 'half-open';
        return true;
      }
      return false;
    }
    
    // half-open: allow single attempt
    return true;
  }

  getStats() {
    const shardStats = {};
    for (const [shardId, state] of this.shardStates) {
      shardStats[shardId] = { ...state };
    }
    
    return {
      global: { ...this.globalState },
      shards: shardStats,
      total_shards: this.shardStates.size
    };
  }
}

// Initialize circuit breaker and monitor
function getCircuitBreaker() {
  if (!circuitBreaker) {
    circuitBreaker = new CircuitBreaker();
  }
  return circuitBreaker;
}

function getGlobalMonitor() {
  if (!globalMonitor) {
    globalMonitor = {
      metrics: {
        requests: { total: 0, successful: 0, failed: 0, errors502: 0, errors503: 0, errors504: 0 },
        performance: { avgResponseTime: 0, maxResponseTime: 0, minResponseTime: Infinity },
        durable_objects: { registry_calls: 0, registry_errors: 0, queue_calls: 0, queue_errors: 0, overload_events: 0 },
        sharding: { total_shards_used: 0, load_balancer_decisions: 0, shard_failures: 0 }
      },
      startTime: Date.now(),
      trackRequest: function(method, path, status, responseTime, error, shardId) {
        this.metrics.requests.total++;
        if (status >= 200 && status < 400) this.metrics.requests.successful++;
        else this.metrics.requests.failed++;
        if (status === 502) this.metrics.requests.errors502++;
        if (status === 503) this.metrics.requests.errors503++;
        if (status === 504) this.metrics.requests.errors504++;
        if (responseTime) {
          const count = this.metrics.requests.total;
          const currentAvg = this.metrics.performance.avgResponseTime;
          this.metrics.performance.avgResponseTime = (currentAvg * (count - 1) + responseTime) / count;
          this.metrics.performance.maxResponseTime = Math.max(this.metrics.performance.maxResponseTime, responseTime);
          this.metrics.performance.minResponseTime = Math.min(this.metrics.performance.minResponseTime, responseTime);
        }
        if (shardId) {
          this.metrics.sharding.load_balancer_decisions++;
        }
      },
      trackDurableObjectCall: function(type, success, error, shardId) {
        if (type === 'registry') {
          this.metrics.durable_objects.registry_calls++;
          if (!success) this.metrics.durable_objects.registry_errors++;
        } else if (type === 'queue') {
          this.metrics.durable_objects.queue_calls++;
          if (!success) this.metrics.durable_objects.queue_errors++;
        }
        if (error && error.overloaded) this.metrics.durable_objects.overload_events++;
        if (shardId && !success) this.metrics.sharding.shard_failures++;
      },
      getStats: function() {
        const uptime = Date.now() - this.startTime;
        const requestRate = uptime > 0 ? (this.metrics.requests.total / (uptime / 1000)).toFixed(2) : '0';
        const successRate = this.metrics.requests.total > 0 ? 
          ((this.metrics.requests.successful / this.metrics.requests.total) * 100).toFixed(1) : '100';
        const errorRate502 = this.metrics.requests.total > 0 ? 
          ((this.metrics.requests.errors502 / this.metrics.requests.total) * 100).toFixed(2) : '0';
        
        return {
          uptime_ms: uptime,
          requests: { ...this.metrics.requests, rate_per_second: requestRate, success_rate_percent: successRate, error_502_rate_percent: errorRate502 },
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
          sharding: this.metrics.sharding,
          health_status: this.getHealthStatus()
        };
      },
      getHealthStatus: function() {
        const errorRate502 = this.metrics.requests.total > 0 ? 
          (this.metrics.requests.errors502 / this.metrics.requests.total) * 100 : 0;
        const overloadRate = this.metrics.durable_objects.registry_calls > 0 ? 
          (this.metrics.durable_objects.overload_events / this.metrics.durable_objects.registry_calls) * 100 : 0;
        const avgResponseTime = this.metrics.performance.avgResponseTime;
        
        if (errorRate502 > 10 || overloadRate > 20 || avgResponseTime > 10000) {
          return { status: 'critical', issues: [`High 502 error rate: ${errorRate502.toFixed(1)}%`, `High overload rate: ${overloadRate.toFixed(1)}%`].filter(Boolean) };
        }
        if (errorRate502 > 5 || overloadRate > 10 || avgResponseTime > 5000) {
          return { status: 'warning', issues: [`Elevated 502 error rate: ${errorRate502.toFixed(1)}%`].filter(Boolean) };
        }
        return { status: 'healthy', issues: [] };
      }
    };
  }
  return globalMonitor;
}

// Load balancer for request queues with multiple shards
class LoadBalancer {
  constructor() {
    this.shardCount = 4; // Начинаем с 4 шардов
    this.maxShardCount = 16; // Максимум 16 шардов
    this.shardStats = new Map();
    this.lastBalanceCheck = 0;
    this.balanceInterval = 30000; // 30 seconds
  }

  getShardId(tunnelId, requestId) {
    // Консистентное хеширование на основе tunnel_id
    const hash = this.simpleHash(tunnelId || requestId || 'default');
    const shardIndex = hash % this.shardCount;
    return `shard_${shardIndex}`;
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  recordShardCall(shardId, success, responseTime) {
    if (!this.shardStats.has(shardId)) {
      this.shardStats.set(shardId, {
        calls: 0,
        failures: 0,
        totalResponseTime: 0,
        lastUsed: Date.now()
      });
    }
    
    const stats = this.shardStats.get(shardId);
    stats.calls++;
    stats.lastUsed = Date.now();
    
    if (success) {
      stats.totalResponseTime += responseTime || 0;
    } else {
      stats.failures++;
    }
  }

  shouldScale() {
    const now = Date.now();
    if (now - this.lastBalanceCheck < this.balanceInterval) {
      return { scale: false };
    }
    
    this.lastBalanceCheck = now;
    
    // Проверяем нагрузку на шарды
    let totalFailures = 0;
    let totalCalls = 0;
    let avgResponseTime = 0;
    let activeShards = 0;
    
    for (const [shardId, stats] of this.shardStats) {
      if (stats.calls > 0) {
        activeShards++;
        totalCalls += stats.calls;
        totalFailures += stats.failures;
        avgResponseTime += (stats.totalResponseTime / stats.calls);
      }
    }
    
    if (activeShards === 0) return { scale: false };
    
    const failureRate = totalCalls > 0 ? (totalFailures / totalCalls) * 100 : 0;
    avgResponseTime = avgResponseTime / activeShards;
    
    // Масштабирование вверх при высокой нагрузке
    if ((failureRate > 15 || avgResponseTime > 5000) && this.shardCount < this.maxShardCount) {
      console.log(`Scaling up: failure rate ${failureRate.toFixed(1)}%, avg response time ${avgResponseTime.toFixed(0)}ms`);
      return { scale: true, direction: 'up', reason: 'high_load' };
    }
    
    // Масштабирование вниз при низкой нагрузке
    if (failureRate < 2 && avgResponseTime < 1000 && this.shardCount > 2 && activeShards < this.shardCount * 0.5) {
      console.log(`Scaling down: low utilization, active shards ${activeShards}/${this.shardCount}`);
      return { scale: true, direction: 'down', reason: 'low_utilization' };
    }
    
    return { scale: false };
  }

  scale(direction) {
    const oldCount = this.shardCount;
    
    if (direction === 'up' && this.shardCount < this.maxShardCount) {
      this.shardCount = Math.min(this.shardCount * 2, this.maxShardCount);
    } else if (direction === 'down' && this.shardCount > 2) {
      this.shardCount = Math.max(Math.floor(this.shardCount / 2), 2);
    }
    
    if (this.shardCount !== oldCount) {
      console.log(`Scaled ${direction}: ${oldCount} -> ${this.shardCount} shards`);
      // Очищаем старую статистику при изменении количества шардов
      this.shardStats.clear();
    }
  }

  getStats() {
    const shardStatsObj = {};
    for (const [shardId, stats] of this.shardStats) {
      shardStatsObj[shardId] = {
        calls: stats.calls,
        failures: stats.failures,
        failure_rate: stats.calls > 0 ? ((stats.failures / stats.calls) * 100).toFixed(1) + '%' : '0%',
        avg_response_time: stats.calls > 0 ? Math.round(stats.totalResponseTime / stats.calls) : 0,
        last_used: stats.lastUsed
      };
    }
    
    return {
      current_shard_count: this.shardCount,
      max_shard_count: this.maxShardCount,
      active_shards: this.shardStats.size,
      last_balance_check: this.lastBalanceCheck,
      shard_stats: shardStatsObj
    };
  }
}

// Global load balancer
let globalLoadBalancer = null;

function getLoadBalancer() {
  if (!globalLoadBalancer) {
    globalLoadBalancer = new LoadBalancer();
  }
  return globalLoadBalancer;
}

/**
 * Main worker entry point with enhanced error handling and load balancing
 */
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    let status = 200;
    let error = null;
    let shardId = null;
    
    try {
      const response = await handleRequest(request, env, ctx);
      status = response.status;
      shardId = response.headers.get('X-Shard-ID');
      return response;
    } catch (err) {
      error = err;
      status = 500;
      console.error('🚨 Unhandled error in main handler:', {
        error: err.message,
        stack: err.stack,
        url: request.url,
        method: request.method
      });
      
      return new Response('Internal Server Error', { 
        status: 500,
        headers: { 
          'Content-Type': 'text/plain',
          'X-Error-Type': 'unhandled',
          'X-Error-Message': err.message,
          ...addCORSHeaders({})
        }
      });
    } finally {
      const responseTime = Date.now() - startTime;
      const url = new URL(request.url);
      getGlobalMonitor().trackRequest(request.method, url.pathname, status, responseTime, error, shardId);
    }
  }
};

/**
 * Enhanced request handler with load balancing
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const prefix = env.PREFIX || '';
  const authKey = env.AUTH_KEY;
  
  if (!authKey) {
    console.error('❌ AUTH_KEY not configured');
    return new Response('Server configuration error', { 
      status: 500,
      headers: addCORSHeaders({})
    });
  }

  const apiPrefix = prefix ? `/${prefix}` : '';
  
  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  if (url.pathname.startsWith(apiPrefix + '/')) {
    return handleApiRequestWithLoadBalancing(request, env, url, apiPrefix);
  }

  return handlePublicRequestWithLoadBalancing(request, env, ctx);
}

/**
 * API requests with load balancing for queue operations
 */
async function handleApiRequestWithLoadBalancing(request, env, url, apiPrefix) {
  const apiPath = url.pathname.substring(apiPrefix.length);
  const startTime = Date.now();
  
  try {
    let response;
    
    switch (apiPath) {
      case '/register':
        response = await handleRegister(request, env);
        break;
        
      case '/unregister':
        response = await handleUnregister(request, env);
        break;
        
      case '/poll':
        response = await handlePollWithLoadBalancing(request, env);
        break;
        
      case '/response':
        response = await handleResponseWithLoadBalancing(request, env);
        break;
        
      case '/heartbeat':
        response = await handleHeartbeat(request, env);
        break;
        
      case '/stats':
        response = await handleStatsWithLoadBalancing(request, env);
        break;
        
      case '/debug/tunnels':
        response = await handleDebugTunnels(request, env);
        break;
        
      case '/health':
        response = await handleHealthCheck(request, env);
        break;
        
      default:
        response = new Response('Not Found', { 
          status: 404,
          headers: addCORSHeaders({})
        });
    }
    
    return response;
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`❌ API error for ${apiPath}:`, {
      error: error.message,
      responseTime,
      overloaded: error.overloaded || false,
      retryable: error.retryable || false
    });
    
    getGlobalMonitor().trackDurableObjectCall('api', false, error);
    
    return new Response(JSON.stringify({ 
      error: 'API request failed',
      details: error.message,
      overloaded: error.overloaded || false,
      retryable: error.retryable || false
    }), {
      status: error.overloaded ? 503 : 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json',
        'X-Error-Type': error.overloaded ? 'overloaded' : 'internal'
      })
    });
  }
}

/**
 * Enhanced public request handling with load balancing
 */
async function handlePublicRequestWithLoadBalancing(request, env, ctx) {
  const url = new URL(request.url);
  const startTime = Date.now();
  
  try {
    // 1. Find tunnel with retry and monitoring
    const tunnelInfo = await findTunnelWithRetryAndMonitoring(url.pathname, env, 3);
    
    if (!tunnelInfo) {
      return new Response('Not Found', { 
        status: 404,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain',
          'X-Tunnel-Status': 'no-tunnel-found'
        })
      });
    }

    // 2. Pre-validation
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) { // Уменьшен лимит
      return new Response('Request Too Large', { 
        status: 413,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain'
        })
      });
    }

    // 3. Serialize with timeout
    const requestData = await Promise.race([
      serializeRequestWithValidation(request),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Serialization timeout')), 3000) // Уменьшен таймаут
      )
    ]);
    
    // 4. Queue request with load balancing
    const response = await queueRequestWithLoadBalancing(requestData, tunnelInfo.tunnel_id, env);
    
    // 5. Log performance
    const duration = Date.now() - startTime;
    if (duration > 3000) { // Уменьшен порог
      console.warn(`⚠️ Slow request: ${duration}ms for ${request.method} ${url.pathname}`);
    }
    
    return response;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Public request failed after ${duration}ms:`, {
      method: request.method,
      path: url.pathname,
      error: error.message,
      overloaded: error.overloaded || false,
      retryable: error.retryable || false
    });
    
    if (error.overloaded) {
      return new Response('Service Temporarily Unavailable - Overloaded', { 
        status: 503,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain',
          'Retry-After': '5',
          'X-Error-Type': 'overloaded'
        })
      });
    }
    
    if (error.retryable) {
      return new Response('Service Temporarily Unavailable - Retry', { 
        status: 503,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain',
          'Retry-After': '3',
          'X-Error-Type': 'retryable'
        })
      });
    }
    
    if (error.message.includes('timeout') || error.message.includes('Request timeout')) {
      return new Response('Gateway Timeout', { 
        status: 504,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain',
          'X-Error-Type': 'timeout'
        })
      });
    }
    
    return new Response('Bad Gateway', { 
      status: 502,
      headers: addCORSHeaders({
        'Content-Type': 'text/plain',
        'X-Error-Type': 'unknown',
        'X-Error-Message': error.message,
        'X-Duration-Ms': duration.toString()
      })
    });
  }
}

/**
 * Load-balanced queue request handling
 */
async function queueRequestWithLoadBalancing(requestData, tunnelId, env, maxRetries = 2) {
  const loadBalancer = getLoadBalancer();
  const circuitBreaker = getCircuitBreaker();
  
  // Проверяем необходимость масштабирования
  const scaleDecision = loadBalancer.shouldScale();
  if (scaleDecision.scale) {
    loadBalancer.scale(scaleDecision.direction);
  }
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let shardId = loadBalancer.getShardId(tunnelId, requestData.id);
    
    // Проверяем circuit breaker для шарда
    if (!circuitBreaker.canExecute(shardId)) {
      console.warn(`Circuit breaker open for shard ${shardId}, trying another shard`);
      // Пробуем следующий шард
      const alternativeShardId = loadBalancer.getShardId(tunnelId + '_alt_' + attempt, requestData.id);
      if (!circuitBreaker.canExecute(alternativeShardId)) {
        continue; // Переходим к следующей попытке
      }
      // Используем альтернативный шард
      shardId = alternativeShardId;
    }
    
    const callStartTime = Date.now();
    
    try {
      const requestQueue = getRequestQueueShard(env, shardId);
      
      const response = await requestQueue.fetch(new Request('https://dummy/queue', {
        method: 'POST',
        body: requestData.body,
        headers: {
          'X-Tunnel-ID': tunnelId,
          'X-Request-ID': requestData.id,
          'X-Method': requestData.method,
          'X-Path': requestData.path,
          'X-Query': requestData.query,
          'X-Headers': JSON.stringify(requestData.headers),
          'X-Timeout': '15000', // Уменьшен таймаут
          'Content-Type': 'application/octet-stream'
        }
      }));

      const callDuration = Date.now() - callStartTime;
      
      // Track successful call
      getGlobalMonitor().trackDurableObjectCall('queue', response.ok, null, shardId);
      loadBalancer.recordShardCall(shardId, response.ok, callDuration);
      
      if (response.ok) {
        circuitBreaker.recordSuccess(shardId);
      } else {
        circuitBreaker.recordFailure(shardId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Queue request failed: ${response.status}`;
        
        try {
          const parsed = JSON.parse(errorText);
          errorMessage = parsed.error || errorMessage;
        } catch (e) {
          // Use default message
        }
        
        const error = new Error(errorMessage);
        
        if (response.status === 429 || response.status === 503) {
          error.overloaded = true;
        }
        if (response.status >= 500 && response.status < 600) {
          error.retryable = true;
        }
        
        throw error;
      }

      // Extract response data
      const responseStatus = parseInt(response.headers.get('X-Response-Status') || '200', 10);
      const responseHeadersJson = response.headers.get('X-Response-Headers');
      const responseBody = await response.arrayBuffer();

      // Parse response headers
      let responseHeaders = {};
      if (responseHeadersJson) {
        try {
          responseHeaders = JSON.parse(responseHeadersJson);
        } catch (e) {
          console.warn('Failed to parse response headers:', e.message);
        }
      }

      // Build final response using ResponseBuilder
      const responseBuilder = new ResponseBuilder();
      
      const finalResponse = await responseBuilder.buildResponse({
        status: responseStatus,
        headers: responseHeaders,
        body: responseBody
      });
      
      // Add shard information to response headers
      finalResponse.headers.set('X-Shard-ID', shardId);
      
      return finalResponse;
      
    } catch (error) {
      const callDuration = Date.now() - callStartTime;
      lastError = error;
      
      // Track failed call
      getGlobalMonitor().trackDurableObjectCall('queue', false, error, shardId);
      loadBalancer.recordShardCall(shardId, false, callDuration);
      circuitBreaker.recordFailure(shardId);
      
      console.warn(`🔄 Queue request attempt ${attempt} failed for shard ${shardId} (${callDuration}ms):`, {
        error: error.message,
        overloaded: error.overloaded || false,
        retryable: error.retryable !== false
      });
      
      // Don't retry on overload
      if (error.overloaded) {
        throw error;
      }
      
      if (attempt < maxRetries && error.retryable !== false) {
        const delay = Math.min(1000 * attempt, 2000); // Уменьшена задержка
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Load-balanced polling
 */
async function handlePollWithLoadBalancing(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  const url = new URL(request.url);
  const tunnelId = url.searchParams.get('tunnel_id');
  
  if (!tunnelId) {
    return new Response('Missing tunnel_id parameter', { 
      status: 400,
      headers: addCORSHeaders({})
    });
  }

  const loadBalancer = getLoadBalancer();
  const circuitBreaker = getCircuitBreaker();
  const shardId = loadBalancer.getShardId(tunnelId);
  
  if (!circuitBreaker.canExecute(shardId)) {
    return new Response(JSON.stringify({ 
      error: 'Shard temporarily unavailable',
      shardId: shardId,
      retryAfter: 5
    }), { 
      status: 503,
      headers: addCORSHeaders({
        'Content-Type': 'application/json',
        'Retry-After': '5'
      })
    });
  }

  try {
    // Update polling activity in tunnel registry
    const tunnelRegistry = getTunnelRegistry(env);
    
    await tunnelRegistry.fetch(new Request('https://dummy/update-polling', {
      method: 'POST',
      body: JSON.stringify({ tunnel_id: tunnelId }),
      headers: { 'Content-Type': 'application/json' }
    }));

    // Poll for requests from request queue shard
    const requestQueue = getRequestQueueShard(env, shardId);
    const pollUrl = new URL('https://dummy/poll');
    pollUrl.searchParams.set('tunnel_id', tunnelId);
    pollUrl.searchParams.set('timeout', '10000'); // Уменьшен таймаут

    const response = await requestQueue.fetch(new Request(pollUrl.toString(), {
      method: 'GET'
    }));

    const callDuration = Date.now() - Date.now(); // Placeholder for actual timing
    
    getGlobalMonitor().trackDurableObjectCall('queue', response.ok, null, shardId);
    loadBalancer.recordShardCall(shardId, response.ok, callDuration);
    
    if (response.ok) {
      circuitBreaker.recordSuccess(shardId);
    } else {
      circuitBreaker.recordFailure(shardId);
    }

    // Forward response with CORS headers
    if (response.status === 204) {
      return new Response(null, { 
        status: 204,
        headers: addCORSHeaders({
          'X-Shard-ID': shardId
        })
      });
    }

    const responseBody = await response.arrayBuffer();
    const headers = addCORSHeaders({
      'X-Shard-ID': shardId
    });
    
    // Copy response headers (metadata from DO)
    for (const [key, value] of response.headers.entries()) {
      if (key.startsWith('x-')) {
        headers[key] = value;
      }
    }

    return new Response(responseBody, {
      status: response.status,
      headers: headers
    });
  } catch (error) {
    getGlobalMonitor().trackDurableObjectCall('queue', false, error, shardId);
    circuitBreaker.recordFailure(shardId);
    console.error('Poll error:', error.message);
    return new Response(JSON.stringify({ 
      error: 'Polling failed: ' + error.message,
      shardId: shardId
    }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Load-balanced response handling
 */
async function handleResponseWithLoadBalancing(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  const tunnelId = request.headers.get('X-Tunnel-ID');
  const requestId = request.headers.get('X-Request-ID');
  
  if (!tunnelId || !requestId) {
    return new Response(JSON.stringify({ error: 'Missing tunnel or request ID' }), {
      status: 400,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }

  const loadBalancer = getLoadBalancer();
  const shardId = loadBalancer.getShardId(tunnelId, requestId);

  try {
    const requestQueue = getRequestQueueShard(env, shardId);
    
    const forwardRequest = new Request('https://dummy/response', {
      method: 'POST',
      body: await request.arrayBuffer(),
      headers: {
        'X-Request-ID': request.headers.get('X-Request-ID'),
        'X-Tunnel-ID': request.headers.get('X-Tunnel-ID'),
        'X-Response-Status': request.headers.get('X-Response-Status'),
        'X-Response-Headers': request.headers.get('X-Response-Headers'),
        'Content-Type': 'application/octet-stream'
      }
    });

    const response = await requestQueue.fetch(forwardRequest);
    getGlobalMonitor().trackDurableObjectCall('queue', response.ok, null, shardId);
    
    const responseText = await response.text();
    
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json',
        'X-Shard-ID': shardId
      })
    });
  } catch (error) {
    getGlobalMonitor().trackDurableObjectCall('queue', false, error, shardId);
    console.error('Response error:', error.message);
    return new Response(JSON.stringify({ 
      error: 'Response processing failed: ' + error.message,
      shardId: shardId
    }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Enhanced stats with load balancing information
 */
async function handleStatsWithLoadBalancing(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const loadBalancer = getLoadBalancer();
    
    // Get tunnel stats
    const tunnelResponse = await tunnelRegistry.fetch(new Request('https://dummy/stats'));
    let tunnelStats = { error: 'Failed to fetch tunnel stats' };
    if (tunnelResponse.ok) {
      tunnelStats = await tunnelResponse.json();
    }
    
    // Get stats from all active shards
    const shardStats = {};
    const shardPromises = [];
    
    for (let i = 0; i < loadBalancer.shardCount; i++) {
      const shardId = `shard_${i}`;
      const requestQueue = getRequestQueueShard(env, shardId);
      shardPromises.push(
        requestQueue.fetch(new Request('https://dummy/stats'))
          .then(response => response.ok ? response.json() : { error: 'Failed to fetch' })
          .then(stats => ({ shardId, stats }))
          .catch(error => ({ shardId, stats: { error: error.message } }))
      );
    }
    
    const shardResults = await Promise.all(shardPromises);
    for (const { shardId, stats } of shardResults) {
      shardStats[shardId] = stats;
    }
    
    // Get monitoring stats
    const monitoringStats = getGlobalMonitor().getStats();
    const circuitBreakerStats = getCircuitBreaker().getStats();
    const loadBalancerStats = loadBalancer.getStats();
    
    const stats = {
      server: {
        uptime: Date.now(),
        version: '2.0.2-optimized',
        environment: env.ENVIRONMENT || 'unknown',
        durable_objects: true,
        monitoring_enabled: true,
        load_balancing_enabled: true,
        sharding_enabled: true
      },
      tunnels: tunnelStats,
      shards: {
        count: loadBalancer.shardCount,
        stats: shardStats
      },
      load_balancer: loadBalancerStats,
      circuit_breaker: circuitBreakerStats,
      monitoring: monitoringStats,
      recommendations: generateOptimizedRecommendations(monitoringStats, loadBalancerStats, circuitBreakerStats)
    };

    return new Response(JSON.stringify(stats, null, 2), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    return new Response(JSON.stringify({ 
      error: 'Stats failed', 
      details: error.message 
    }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Generate optimized recommendations
 */
function generateOptimizedRecommendations(monitoringStats, loadBalancerStats, circuitBreakerStats) {
  const recommendations = [];
  
  // Check 502 error rate
  const error502Rate = parseFloat(monitoringStats.requests.error_502_rate_percent);
  if (error502Rate > 3) { // Снижен порог
    recommendations.push({
      type: 'error_rate',
      severity: error502Rate > 7 ? 'critical' : 'warning',
      message: `High 502 error rate (${error502Rate}%). Consider enabling more shards or reducing request size.`
    });
  }
  
  // Check circuit breaker status
  if (circuitBreakerStats.global.status === 'open') {
    recommendations.push({
      type: 'circuit_breaker',
      severity: 'critical',
      message: 'Global circuit breaker is open. System is protecting itself from overload.'
    });
  }
  
  // Check shard distribution
  const activeShards = loadBalancerStats.active_shards;
  const totalShards = loadBalancerStats.current_shard_count;
  if (activeShards < totalShards * 0.5) {
    recommendations.push({
      type: 'shard_utilization',
      severity: 'warning',
      message: `Low shard utilization (${activeShards}/${totalShards}). Consider scaling down.`
    });
  }
  
  // Check response time
  const avgResponseTime = monitoringStats.performance.avg_response_time_ms;
  if (avgResponseTime > 3000) { // Снижен порог
    recommendations.push({
      type: 'performance',
      severity: avgResponseTime > 5000 ? 'critical' : 'warning',
      message: `High average response time (${avgResponseTime}ms). Consider scaling up or optimizing request processing.`
    });
  }
  
  return recommendations;
}

/**
 * Get request queue shard with proper ID generation
 */
function getRequestQueueShard(env, shardId) {
  const id = env.REQUEST_QUEUE.idFromName(shardId);
  return env.REQUEST_QUEUE.get(id);
}

/**
 * Get tunnel registry (unchanged)
 */
function getTunnelRegistry(env) {
  const id = env.TUNNEL_REGISTRY.idFromName('global');
  return env.TUNNEL_REGISTRY.get(id);
}

/**
 * Find tunnel with retry and monitoring (unchanged from original)
 */
async function findTunnelWithRetryAndMonitoring(pathname, env, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const callStartTime = Date.now();
    
    try {
      const tunnelRegistry = getTunnelRegistry(env);
      const findUrl = new URL('https://dummy/find-tunnel');
      findUrl.searchParams.set('path', pathname);
      
      const response = await tunnelRegistry.fetch(new Request(findUrl.toString()));
      
      getGlobalMonitor().trackDurableObjectCall('registry', true);
      
      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Tunnel lookup failed: ${response.status} ${response.statusText}`);
      }

      return await response.json();
      
    } catch (error) {
      const callDuration = Date.now() - callStartTime;
      lastError = error;
      
      getGlobalMonitor().trackDurableObjectCall('registry', false, error);
      
      console.warn(`🔄 Tunnel lookup attempt ${attempt} failed (${callDuration}ms):`, {
        error: error.message,
        overloaded: error.overloaded || false,
        retryable: error.retryable !== false
      });
      
      if (error.overloaded) {
        throw error;
      }
      
      if (attempt < maxRetries && error.retryable !== false) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 3000); // Уменьшена максимальная задержка
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Enhanced request serialization (unchanged but with smaller limits)
 */
async function serializeRequestWithValidation(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new Error('Invalid URL');
  }
  
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  let body = new ArrayBuffer(0);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const contentLength = request.headers.get('content-length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > 5 * 1024 * 1024) { // Уменьшен лимит
          throw new Error('Request body too large');
        }
      }
      
      const arrayBuffer = await request.arrayBuffer();
      if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
        throw new Error('Request body too large');
      }
      body = arrayBuffer;
    } catch (error) {
      if (error.message === 'Request body too large') {
        throw error;
      }
      console.warn('Failed to read request body:', error.message);
    }
  }

  return {
    id: crypto.randomUUID(),
    method: request.method,
    path: url.pathname,
    query: url.search.substring(1),
    headers: headers,
    body: body,
    timestamp: Date.now()
  };
}

// Unchanged handlers with monitoring
async function handleRegister(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const response = await tunnelRegistry.fetch(new Request('https://dummy/register', {
      method: 'POST',
      body: await request.text(),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    getGlobalMonitor().trackDurableObjectCall('registry', response.ok);

    const responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    getGlobalMonitor().trackDurableObjectCall('registry', false, error);
    console.error('Register error:', error.message);
    return new Response(JSON.stringify({ error: 'Registration failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

async function handleUnregister(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const response = await tunnelRegistry.fetch(new Request('https://dummy/unregister', {
      method: 'POST',
      body: await request.text(),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    getGlobalMonitor().trackDurableObjectCall('registry', response.ok);

    const responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    getGlobalMonitor().trackDurableObjectCall('registry', false, error);
    console.error('Unregister error:', error.message);
    return new Response(JSON.stringify({ error: 'Unregistration failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

async function handleHeartbeat(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const response = await tunnelRegistry.fetch(new Request('https://dummy/heartbeat', {
      method: 'POST',
      body: await request.text(),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    getGlobalMonitor().trackDurableObjectCall('registry', response.ok);

    const responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    getGlobalMonitor().trackDurableObjectCall('registry', false, error);
    console.error('Heartbeat error:', error.message);
    return new Response(JSON.stringify({ error: 'Heartbeat failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

async function handleDebugTunnels(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const loadBalancer = getLoadBalancer();
    
    const [tunnelsResponse] = await Promise.allSettled([
      tunnelRegistry.fetch(new Request('https://dummy/list-tunnels'))
    ]);
    
    let tunnels = [];
    
    if (tunnelsResponse.status === 'fulfilled' && tunnelsResponse.value.ok) {
      tunnels = await tunnelsResponse.value.json();
    }
    
    // Get shard stats
    const shardStats = {};
    for (let i = 0; i < loadBalancer.shardCount; i++) {
      const shardId = `shard_${i}`;
      try {
        const requestQueue = getRequestQueueShard(env, shardId);
        const response = await requestQueue.fetch(new Request('https://dummy/stats'));
        if (response.ok) {
          shardStats[shardId] = await response.json();
        }
      } catch (error) {
        shardStats[shardId] = { error: error.message };
      }
    }
    
    const debug = {
      tunnels: tunnels,
      shards: shardStats,
      load_balancer: loadBalancer.getStats(),
      circuit_breaker: getCircuitBreaker().getStats(),
      monitoring: getGlobalMonitor().getStats(),
      timestamp: Date.now(),
      optimized_version: true
    };

    return new Response(JSON.stringify(debug, null, 2), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Debug tunnels error:', error.message);
    return new Response(JSON.stringify({ error: 'Debug failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

async function handleHealthCheck(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const healthStats = getGlobalMonitor().getStats();
  const healthStatus = healthStats.health_status;
  const circuitBreakerStats = getCircuitBreaker().getStats();
  const loadBalancerStats = getLoadBalancer().getStats();
  
  // Enhanced health check with circuit breaker and load balancer status
  let overallStatus = healthStatus.status;
  const issues = [...healthStatus.issues];
  
  if (circuitBreakerStats.global.status === 'open') {
    overallStatus = 'critical';
    issues.push('Global circuit breaker is open');
  }
  
  if (loadBalancerStats.active_shards < loadBalancerStats.current_shard_count * 0.3) {
    if (overallStatus === 'healthy') overallStatus = 'warning';
    issues.push('Low shard availability');
  }
  
  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: healthStats.uptime_readable,
    issues: issues,
    version: '2.0.2-optimized',
    features: {
      load_balancing: true,
      circuit_breaker: true,
      sharding: true,
      monitoring: true
    },
    metrics: {
      requests_total: healthStats.requests.total,
      success_rate: healthStats.requests.success_rate_percent + '%',
      error_502_rate: healthStats.requests.error_502_rate_percent + '%',
      avg_response_time: healthStats.performance.avg_response_time_ms + 'ms',
      active_shards: loadBalancerStats.active_shards,
      total_shards: loadBalancerStats.current_shard_count,
      circuit_breaker_status: circuitBreakerStats.global.status
    }
  };
  
  const httpStatus = overallStatus === 'healthy' ? 200 :
                    overallStatus === 'warning' ? 200 : 503;
  
  return new Response(JSON.stringify(response, null, 2), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}

function validateAuth(request, expectedAuth) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader) {
    return false;
  }
  
  const token = authHeader.replace(/^Bearer\s+/, '');
  return token === expectedAuth;
}

function handleCORS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function addCORSHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}