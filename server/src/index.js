// server/src/index.js - Обновленная версия с мониторингом и улучшенной обработкой ошибок

// Import Durable Object classes
import { TunnelRegistry } from './durable-objects/tunnel-registry.js';
import { RequestQueue } from './durable-objects/request-queue.js';
import ResponseBuilder from './utils/response-builder.js';

// Global monitor for tracking
let globalMonitor = null;

// Initialize monitor on first use
function getGlobalMonitor() {
  if (!globalMonitor) {
    // Simple monitor implementation inline to avoid import issues
    globalMonitor = {
      metrics: {
        requests: { total: 0, successful: 0, failed: 0, errors502: 0, errors503: 0, errors504: 0 },
        performance: { avgResponseTime: 0, maxResponseTime: 0, minResponseTime: Infinity },
        durable_objects: { registry_calls: 0, registry_errors: 0, queue_calls: 0, queue_errors: 0, overload_events: 0 }
      },
      startTime: Date.now(),
      trackRequest: function(method, path, status, responseTime, error) {
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
      },
      trackDurableObjectCall: function(type, success, error) {
        if (type === 'registry') {
          this.metrics.durable_objects.registry_calls++;
          if (!success) this.metrics.durable_objects.registry_errors++;
        } else if (type === 'queue') {
          this.metrics.durable_objects.queue_calls++;
          if (!success) this.metrics.durable_objects.queue_errors++;
        }
        if (error && error.overloaded) this.metrics.durable_objects.overload_events++;
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

// Export Durable Object classes for Cloudflare
export { TunnelRegistry, RequestQueue };

/**
 * Main worker entry point with enhanced error handling
 */
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    let status = 200;
    let error = null;
    
    try {
      const response = await handleRequest(request, env, ctx);
      status = response.status;
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
          'X-Error-Message': err.message
        }
      });
    } finally {
      // Track all requests
      const responseTime = Date.now() - startTime;
      const url = new URL(request.url);
      getGlobalMonitor().trackRequest(request.method, url.pathname, status, responseTime, error);
    }
  }
};

/**
 * Enhanced request handler with comprehensive monitoring
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const prefix = env.PREFIX || '';
  const authKey = env.AUTH_KEY;
  
  if (!authKey) {
    console.error('❌ AUTH_KEY not configured');
    return new Response('Server configuration error', { status: 500 });
  }

  // Build API path prefix
  const apiPrefix = prefix ? `/${prefix}` : '';
  
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  // Route API endpoints (require auth)
  if (url.pathname.startsWith(apiPrefix + '/')) {
    return handleApiRequest(request, env, url, apiPrefix);
  }

  // Handle public requests (proxy to tunnels)
  return handlePublicRequestWithMonitoring(request, env, ctx);
}

/**
 * Handle API requests with monitoring
 */
async function handleApiRequest(request, env, url, apiPrefix) {
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
        response = await handlePoll(request, env);
        break;
        
      case '/response':
        response = await handleResponse(request, env);
        break;
        
      case '/heartbeat':
        response = await handleHeartbeat(request, env);
        break;
        
      case '/stats':
        response = await handleStatsWithMonitoring(request, env);
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
 * Enhanced public request handling with comprehensive monitoring
 */
async function handlePublicRequestWithMonitoring(request, env, ctx) {
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
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
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
        setTimeout(() => reject(new Error('Serialization timeout')), 5000)
      )
    ]);
    
    // 4. Queue request with retry and monitoring
    const response = await queueRequestWithRetryAndMonitoring(requestData, tunnelInfo.tunnel_id, env);
    
    // 5. Log performance
    const duration = Date.now() - startTime;
    if (duration > 5000) {
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
    
    // Enhanced error responses based on error type
    if (error.overloaded) {
      return new Response('Service Temporarily Unavailable - Overloaded', { 
        status: 503,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain',
          'Retry-After': '10',
          'X-Error-Type': 'overloaded'
        })
      });
    }
    
    if (error.retryable) {
      return new Response('Service Temporarily Unavailable - Retry', { 
        status: 503,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain',
          'Retry-After': '5',
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
 * Find tunnel with retry and monitoring
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
      
      // Track successful call
      getGlobalMonitor().trackDurableObjectCall('registry', true);
      
      if (response.status === 404) {
        return null; // No tunnel found - not an error
      }

      if (!response.ok) {
        throw new Error(`Tunnel lookup failed: ${response.status} ${response.statusText}`);
      }

      return await response.json();
      
    } catch (error) {
      const callDuration = Date.now() - callStartTime;
      lastError = error;
      
      // Track failed call
      getGlobalMonitor().trackDurableObjectCall('registry', false, error);
      
      console.warn(`🔄 Tunnel lookup attempt ${attempt} failed (${callDuration}ms):`, {
        error: error.message,
        overloaded: error.overloaded || false,
        retryable: error.retryable !== false
      });
      
      // Don't retry on certain errors
      if (error.overloaded) {
        console.warn(`🚨 Tunnel registry overloaded on attempt ${attempt}`);
        throw error; // Fail fast on overload
      }
      
      if (attempt < maxRetries && error.retryable !== false) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Queue request with retry and monitoring
 */
async function queueRequestWithRetryAndMonitoring(requestData, tunnelId, env, maxRetries = 2) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const callStartTime = Date.now();
    
    try {
      const requestQueue = getRequestQueue(env);
      
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
          'X-Timeout': '30000',
          'Content-Type': 'application/octet-stream'
        }
      }));

      // Track successful call
      getGlobalMonitor().trackDurableObjectCall('queue', true);

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
        
        // Add metadata about the error
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
      
      return await responseBuilder.buildResponse({
        status: responseStatus,
        headers: responseHeaders,
        body: responseBody
      });
      
    } catch (error) {
      const callDuration = Date.now() - callStartTime;
      lastError = error;
      
      // Track failed call
      getGlobalMonitor().trackDurableObjectCall('queue', false, error);
      
      console.warn(`🔄 Queue request attempt ${attempt} failed (${callDuration}ms):`, {
        error: error.message,
        overloaded: error.overloaded || false,
        retryable: error.retryable !== false
      });
      
      // Don't retry on overload
      if (error.overloaded) {
        throw error;
      }
      
      if (attempt < maxRetries && error.retryable !== false) {
        const delay = Math.min(1000 * attempt, 3000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Enhanced request serialization with validation
 */
async function serializeRequestWithValidation(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new Error('Invalid URL');
  }
  
  // Collect headers efficiently
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  // Get body with size check
  let body = new ArrayBuffer(0);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      // Pre-check size from headers
      const contentLength = request.headers.get('content-length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > 10 * 1024 * 1024) {
          throw new Error('Request body too large');
        }
      }
      
      const arrayBuffer = await request.arrayBuffer();
      if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
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

/**
 * Enhanced stats endpoint with monitoring data
 */
async function handleStatsWithMonitoring(request, env) {
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
    const requestQueue = getRequestQueue(env);
    
    const [tunnelResponse, queueResponse] = await Promise.allSettled([
      tunnelRegistry.fetch(new Request('https://dummy/stats')),
      requestQueue.fetch(new Request('https://dummy/stats'))
    ]);

    let tunnelStats = { error: 'Failed to fetch tunnel stats' };
    let queueStats = { error: 'Failed to fetch queue stats' };
    
    if (tunnelResponse.status === 'fulfilled' && tunnelResponse.value.ok) {
      tunnelStats = await tunnelResponse.value.json();
    }
    
    if (queueResponse.status === 'fulfilled' && queueResponse.value.ok) {
      queueStats = await queueResponse.value.json();
    }
    
    // Get monitoring stats
    const monitoringStats = getGlobalMonitor().getStats();
    
    const stats = {
      server: {
        uptime: Date.now(),
        version: '2.0.2',
        environment: env.ENVIRONMENT || 'unknown',
        durable_objects: true,
        monitoring_enabled: true
      },
      tunnels: tunnelStats,
      queues: queueStats,
      monitoring: monitoringStats,
      recommendations: generateRecommendations(monitoringStats, queueStats)
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
 * New health check endpoint
 */
async function handleHealthCheck(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const healthStats = getGlobalMonitor().getStats();
  const healthStatus = healthStats.health_status;
  
  const response = {
    status: healthStatus.status,
    timestamp: new Date().toISOString(),
    uptime: healthStats.uptime_readable,
    issues: healthStatus.issues,
    metrics: {
      requests_total: healthStats.requests.total,
      success_rate: healthStats.requests.success_rate_percent + '%',
      error_502_rate: healthStats.requests.error_502_rate_percent + '%',
      avg_response_time: healthStats.performance.avg_response_time_ms + 'ms',
      durable_objects: {
        registry_error_rate: healthStats.durable_objects.registry_error_rate + '%',
        queue_error_rate: healthStats.durable_objects.queue_error_rate + '%',
        overload_events: healthStats.durable_objects.overload_events
      }
    }
  };
  
  const httpStatus = healthStatus.status === 'healthy' ? 200 :
                    healthStatus.status === 'warning' ? 200 : 503;
  
  return new Response(JSON.stringify(response, null, 2), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}

/**
 * Generate recommendations based on stats
 */
function generateRecommendations(monitoringStats, queueStats) {
  const recommendations = [];
  
  // Check 502 error rate
  const error502Rate = parseFloat(monitoringStats.requests.error_502_rate_percent);
  if (error502Rate > 5) {
    recommendations.push({
      type: 'error_rate',
      severity: error502Rate > 10 ? 'critical' : 'warning',
      message: `High 502 error rate (${error502Rate}%). Consider reducing request size or increasing client concurrency.`
    });
  }
  
  // Check overload events
  const overloadEvents = monitoringStats.durable_objects.overload_events;
  if (overloadEvents > 10) {
    recommendations.push({
      type: 'overload',
      severity: 'warning',
      message: `${overloadEvents} overload events detected. Consider implementing request throttling or load balancing.`
    });
  }
  
  // Check response time
  const avgResponseTime = monitoringStats.performance.avg_response_time_ms;
  if (avgResponseTime > 5000) {
    recommendations.push({
      type: 'performance',
      severity: avgResponseTime > 10000 ? 'critical' : 'warning',
      message: `High average response time (${avgResponseTime}ms). Check origin server performance.`
    });
  }
  
  // Check queue health
  if (queueStats.is_overloaded) {
    recommendations.push({
      type: 'queue',
      severity: 'warning',
      message: 'Request queue is overloaded. Consider reducing request rate or increasing polling frequency.'
    });
  }
  
  return recommendations;
}

/**
 * Get Durable Object instances (unchanged)
 */
function getTunnelRegistry(env) {
  const id = env.TUNNEL_REGISTRY.idFromName('global');
  return env.TUNNEL_REGISTRY.get(id);
}

function getRequestQueue(env) {
  const id = env.REQUEST_QUEUE.idFromName('global');
  return env.REQUEST_QUEUE.get(id);
}

/**
 * Validates auth token from request (unchanged)
 */
function validateAuth(request, expectedAuth) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader) {
    return false;
  }
  
  const token = authHeader.replace(/^Bearer\s+/, '');
  return token === expectedAuth;
}

/**
 * Enhanced handlers with monitoring (keeping existing logic but adding error tracking)
 */
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

async function handlePoll(request, env) {
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

  try {
    // Update polling activity in tunnel registry
    const tunnelRegistry = getTunnelRegistry(env);
    
    await tunnelRegistry.fetch(new Request('https://dummy/update-polling', {
      method: 'POST',
      body: JSON.stringify({ tunnel_id: tunnelId }),
      headers: { 'Content-Type': 'application/json' }
    }));

    // Poll for requests from request queue
    const requestQueue = getRequestQueue(env);
    const pollUrl = new URL('https://dummy/poll');
    pollUrl.searchParams.set('tunnel_id', tunnelId);
    pollUrl.searchParams.set('timeout', '30000');

    const response = await requestQueue.fetch(new Request(pollUrl.toString(), {
      method: 'GET'
    }));

    getGlobalMonitor().trackDurableObjectCall('queue', response.ok);

    // Forward response with CORS headers
    if (response.status === 204) {
      return new Response(null, { 
        status: 204,
        headers: addCORSHeaders({})
      });
    }

    const responseBody = await response.arrayBuffer();
    const headers = addCORSHeaders({});
    
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
    getGlobalMonitor().trackDurableObjectCall('queue', false, error);
    console.error('Poll error:', error.message);
    return new Response(JSON.stringify({ error: 'Polling failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

async function handleResponse(request, env) {
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
    const requestQueue = getRequestQueue(env);
    
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
    getGlobalMonitor().trackDurableObjectCall('queue', response.ok);
    
    const responseText = await response.text();
    
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    getGlobalMonitor().trackDurableObjectCall('queue', false, error);
    console.error('Response error:', error.message);
    return new Response(JSON.stringify({ error: 'Response processing failed: ' + error.message }), {
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
    const requestQueue = getRequestQueue(env);
    
    const [tunnelsResponse, queuesResponse] = await Promise.allSettled([
      tunnelRegistry.fetch(new Request('https://dummy/list-tunnels')),
      requestQueue.fetch(new Request('https://dummy/stats'))
    ]);
    
    let tunnels = [];
    let queueStats = {};
    
    if (tunnelsResponse.status === 'fulfilled' && tunnelsResponse.value.ok) {
      tunnels = await tunnelsResponse.value.json();
    }
    
    if (queuesResponse.status === 'fulfilled' && queuesResponse.value.ok) {
      queueStats = await queuesResponse.value.json();
    }
    
    const debug = {
      tunnels: tunnels,
      queues: {
        total_queued: queueStats.total_queued || 0,
        total_pending: queueStats.total_pending || 0,
        active_queues: queueStats.active_queues || 0,
        is_overloaded: queueStats.is_overloaded || false
      },
      monitoring: getGlobalMonitor().getStats(),
      timestamp: Date.now(),
      durable_objects: true
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

/**
 * Handles CORS preflight requests (unchanged)
 */
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

/**
 * Adds CORS headers to response headers (unchanged)
 */
function addCORSHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}