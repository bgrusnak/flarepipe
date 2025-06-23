// server/src/durable-objects/request-queue.js - ИСПРАВЛЕННАЯ ВЕРСИЯ

export class RequestQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    
    // In-memory queues for performance
    this.requestQueues = new Map(); // tunnelId -> request[]
    this.pendingResponses = new Map(); // requestId -> resolver
    this.requestBodies = new Map(); // requestId -> ArrayBuffer
    
    // Performance metrics
    this.performanceMetrics = {
      requestsProcessed: 0,
      avgProcessingTime: 0,
      overloadCount: 0,
      lastOverloadTime: 0
    };
    
    // Configuration with dynamic adjustment
    this.maxQueueSize = 50; // Уменьшено с 100
    this.requestTimeout = 30000; // 30 seconds
    this.pollTimeout = 30000; // 30 seconds  
    this.maxRequestSize = 5 * 1024 * 1024; // Уменьшено до 5MB
    this.maxConcurrentRequests = 10; // Ограничение конкурентности
    
    this.initialized = false;
    this.cleanupInterval = 30000; // 30 seconds
    this.currentLoad = 0; // Отслеживание нагрузки
    
    // Start cleanup using alarm
    this.scheduleNextCleanup();
  }

  /**
   * Initialize from persistent storage if needed
   */
  async initialize() {
    if (this.initialized) return;
    
    // For request queue, we don't restore from storage as:
    // 1. Requests are transient
    // 2. Pending responses would be stale
    // 3. Client will re-poll anyway
    
    this.initialized = true;
    console.log('RequestQueue initialized');
  }

  /**
   * Schedule next cleanup using Durable Object alarms
   */
  scheduleNextCleanup() {
    this.state.storage.setAlarm(Date.now() + this.cleanupInterval);
  }

  /**
   * Проверка перегрузки с адаптивным поведением
   */
  isOverloaded() {
    const totalQueued = Array.from(this.requestQueues.values())
      .reduce((sum, queue) => sum + queue.length, 0);
    const totalPending = this.pendingResponses.size;
    
    // Динамические пороги в зависимости от текущей нагрузки
    const queueThreshold = Math.max(this.maxQueueSize * 0.8, 10);
    const pendingThreshold = this.maxConcurrentRequests;
    
    const isOverloaded = totalQueued > queueThreshold || 
                        totalPending > pendingThreshold ||
                        this.currentLoad > 0.9;
    
    if (isOverloaded) {
      this.performanceMetrics.overloadCount++;
      this.performanceMetrics.lastOverloadTime = Date.now();
      console.warn(`RequestQueue overloaded: queued=${totalQueued}, pending=${totalPending}, load=${this.currentLoad}`);
    }
    
    return isOverloaded;
  }

  /**
   * Handle HTTP requests to this Durable Object
   */
  async fetch(request) {
    await this.initialize();
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      switch (path) {
        case '/queue':
          return await this.handleQueueRequest(request);
        case '/poll':
          return await this.handlePoll(request);
        case '/response':
          return await this.handleResponse(request);
        case '/cancel':
          return await this.handleCancel(request);
        case '/stats':
          return await this.handleStats(request);
        case '/emergency-cleanup':
          return await this.handleEmergencyCleanup(request);
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('RequestQueue error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Enhanced queue request with overload protection
   */
  async handleQueueRequest(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const startTime = Date.now();
    this.currentLoad = Math.min(this.currentLoad + 0.1, 1.0);
    
    try {
      // Быстрая проверка перегрузки
      if (this.isOverloaded()) {
        const error = new Error('Queue overloaded');
        error.overloaded = true;
        throw error;
      }

      // Extract metadata
      const tunnelId = request.headers.get('X-Tunnel-ID');
      const requestId = request.headers.get('X-Request-ID');
      const method = request.headers.get('X-Method');
      const path = request.headers.get('X-Path');
      const query = request.headers.get('X-Query');
      const headersJson = request.headers.get('X-Headers');
      const timeout = Math.min(parseInt(request.headers.get('X-Timeout') || '30000', 10), 30000);

      if (!tunnelId || !requestId || !method || !path) {
        throw new Error('Missing required headers');
      }

      // Streamlined body reading
      const body = await this.readRequestBody(request);
      
      // Parse headers efficiently
      let requestHeaders = {};
      if (headersJson) {
        try {
          requestHeaders = JSON.parse(headersJson);
        } catch (e) {
          console.warn('Failed to parse request headers');
        }
      }

      // Проверка дубликатов
      if (this.pendingResponses.has(requestId)) {
        throw new Error('Duplicate request ID');
      }

      // Get or create queue with limits
      const queue = this.getOrCreateQueue(tunnelId);
      if (queue.length >= this.maxQueueSize) {
        throw new Error('Tunnel queue is full');
      }

      // Store body separately for memory efficiency
      if (body.byteLength > 0) {
        this.requestBodies.set(requestId, body);
      }

      // Create request data
      const requestData = {
        id: requestId,
        method: method,
        path: path,
        query: query || '',
        headers: requestHeaders,
        body_size: body.byteLength,
        timestamp: Date.now(),
        timeout_at: Date.now() + timeout
      };

      // Add to queue
      queue.push(requestData);

      // Promise with enhanced timeout handling
      const response = await this.createResponsePromise(requestId, tunnelId, timeout);
      
      // Update metrics
      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime);
      
      return this.buildSuccessResponse(response);
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime, true);
      
      console.error('Queue request failed:', {
        error: error.message,
        processingTime,
        overloaded: error.overloaded || false
      });
      
      if (error.overloaded) {
        return new Response(JSON.stringify({ 
          error: 'Queue overloaded',
          retryAfter: 5,
          currentLoad: this.currentLoad
        }), {
          status: 503,
          headers: { 
            'Content-Type': 'application/json',
            'Retry-After': '5',
            ...this.getCORSHeaders() 
          }
        });
      }
      
      const status = error.message.includes('queue is full') ? 429 : 
                    error.message.includes('too large') ? 413 : 400;
      
      return new Response(JSON.stringify({ error: error.message }), {
        status: status,
        headers: { 'Content-Type': 'application/json', ...this.getCORSHeaders() }
      });
    } finally {
      // Decrease load
      this.currentLoad = Math.max(this.currentLoad - 0.1, 0);
    }
  }
  
  /**
   * Оптимизированное чтение тела запроса
   */
  async readRequestBody(request) {
    const contentLength = request.headers.get('content-length');
    
    // Pre-check size from headers
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > this.maxRequestSize) {
        throw new Error(`Request too large: ${size} bytes`);
      }
    }
    
    const body = await request.arrayBuffer();
    
    // Post-check actual size
    if (body.byteLength > this.maxRequestSize) {
      throw new Error(`Request too large: ${body.byteLength} bytes`);
    }
    
    return body;
  }
  
  /**
   * Метрики производительности
   */
  updateMetrics(processingTime, failed = false) {
    this.performanceMetrics.requestsProcessed++;
    
    if (!failed) {
      const count = this.performanceMetrics.requestsProcessed;
      const currentAvg = this.performanceMetrics.avgProcessingTime;
      this.performanceMetrics.avgProcessingTime = 
        (currentAvg * (count - 1) + processingTime) / count;
    }
  }
  
  /**
   * Получить или создать очередь с лимитами
   */
  getOrCreateQueue(tunnelId) {
    let queue = this.requestQueues.get(tunnelId);
    if (!queue) {
      // Limit total number of queues
      if (this.requestQueues.size >= 50) {
        throw new Error('Too many active tunnels');
      }
      queue = [];
      this.requestQueues.set(tunnelId, queue);
    }
    return queue;
  }
  
  /**
   * Создание promise с улучшенным таймаутом
   */
  async createResponsePromise(requestId, tunnelId, timeout) {
    return new Promise((resolve, reject) => {
      const responseHandler = {
        resolve,
        reject,
        tunnel_id: tunnelId,
        created_at: Date.now(),
        timeout_at: Date.now() + timeout
      };
      
      this.pendingResponses.set(requestId, responseHandler);

      // Enhanced timeout with cleanup
      const timeoutId = setTimeout(() => {
        const pending = this.pendingResponses.get(requestId);
        if (pending) {
          this.pendingResponses.delete(requestId);
          this.requestBodies.delete(requestId);
          
          const error = new Error('Request timeout');
          error.retryable = true;
          reject(error);
        }
      }, timeout);
      
      // Store timeout ID for potential early cleanup
      responseHandler.timeoutId = timeoutId;
    });
  }
  
  /**
   * Построение успешного ответа
   */
  buildSuccessResponse(response) {
    return new Response(response.body || new ArrayBuffer(0), {
      status: 200,
      headers: {
        'X-Response-Status': String(response.status || 200),
        'X-Response-Headers': JSON.stringify(response.headers || {}),
        'X-Processing-Time': String(Date.now()),
        ...this.getCORSHeaders()
      }
    });
  }

  /**
   * Enhanced poll with better performance
   */
  async handlePoll(request) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const tunnelId = url.searchParams.get('tunnel_id');
    const timeout = Math.min(parseInt(url.searchParams.get('timeout') || '30000', 10), 30000);

    if (!tunnelId) {
      return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const requestData = await this.waitForRequestOptimized(tunnelId, timeout);
      
      if (!requestData) {
        return new Response(null, { status: 204 });
      }

      // Restore body
      const body = this.requestBodies.get(requestData.id) || new ArrayBuffer(0);

      return new Response(body, {
        status: 200,
        headers: {
          'X-Request-ID': requestData.id,
          'X-Method': requestData.method,
          'X-Path': requestData.path,
          'X-Query': requestData.query,
          'X-Headers': JSON.stringify(requestData.headers),
          'X-Timestamp': String(requestData.timestamp),
          'Content-Type': 'application/octet-stream'
        }
      });
    } catch (error) {
      console.error('Poll error:', error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Оптимизированное ожидание запроса
   */
  async waitForRequestOptimized(tunnelId, timeout) {
    const queue = this.requestQueues.get(tunnelId);
    
    // Fast path: immediate availability
    if (queue && queue.length > 0) {
      return this.dequeueValidRequest(queue);
    }

    // Optimized polling with shorter intervals and early exit
    return new Promise((resolve) => {
      const startTime = Date.now();
      const pollInterval = Math.min(timeout / 100, 100); // Adaptive interval
      
      const checkForRequests = () => {
        const queue = this.requestQueues.get(tunnelId);
        
        if (queue && queue.length > 0) {
          const request = this.dequeueValidRequest(queue);
          if (request) {
            resolve(request);
            return;
          }
        }

        if (Date.now() - startTime >= timeout) {
          resolve(null);
          return;
        }

        setTimeout(checkForRequests, pollInterval);
      };

      checkForRequests();
    });
  }
  
  /**
   * Извлечение валидного запроса из очереди
   */
  dequeueValidRequest(queue) {
    while (queue.length > 0) {
      const requestData = queue.shift();
      
      // Check if still valid
      if (requestData.timeout_at && Date.now() > requestData.timeout_at) {
        this.rejectExpiredRequest(requestData.id);
        continue; // Try next request
      }
      
      return requestData;
    }
    return null;
  }

  /**
   * Handle response from tunnel client
   */
  async handleResponse(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const requestId = request.headers.get('X-Request-ID');
    const responseStatus = request.headers.get('X-Response-Status');
    const responseHeadersJson = request.headers.get('X-Response-Headers');

    if (!requestId) {
      return new Response(JSON.stringify({ error: 'Missing X-Request-ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const pending = this.pendingResponses.get(requestId);
    if (!pending) {
      // Normal case - request might have timed out
      return new Response(JSON.stringify({ 
        success: true, 
        note: 'Request already processed or timed out' 
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      // Parse response headers
      let responseHeaders = {};
      if (responseHeadersJson) {
        try {
          responseHeaders = JSON.parse(responseHeadersJson);
        } catch (e) {
          console.warn('Failed to parse response headers');
        }
      }

      // Get response body
      const body = await request.arrayBuffer();

      // Clean up
      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
      
      // Clear timeout if exists
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }

      // Resolve the promise
      pending.resolve({
        status: parseInt(responseStatus, 10) || 200,
        headers: responseHeaders,
        body: body
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Response handling error:', error.message);
      
      // Still clean up
      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
      
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      
      pending.reject(error);
      
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Cancel all requests for a tunnel
   */
  async handleCancel(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const { tunnel_id } = await request.json();
    if (!tunnel_id) {
      return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const canceledCount = this.cancelTunnelRequests(tunnel_id);

    return new Response(JSON.stringify({ 
      success: true, 
      canceled_requests: canceledCount 
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Cancel all requests for a tunnel (internal)
   */
  cancelTunnelRequests(tunnelId) {
    let canceledCount = 0;

    // Remove queue
    const queue = this.requestQueues.get(tunnelId);
    if (queue) {
      for (const request of queue) {
        this.rejectExpiredRequest(request.id);
        canceledCount++;
      }
      this.requestQueues.delete(tunnelId);
    }

    // Cancel pending responses for this tunnel
    const toCancel = [];
    for (const [requestId, pending] of this.pendingResponses) {
      if (pending.tunnel_id === tunnelId) {
        toCancel.push(requestId);
      }
    }

    for (const requestId of toCancel) {
      const pending = this.pendingResponses.get(requestId);
      if (pending) {
        this.pendingResponses.delete(requestId);
        this.requestBodies.delete(requestId);
        pending.reject(new Error('Tunnel disconnected'));
        canceledCount++;
      }
    }

    console.log(`Canceled ${canceledCount} requests for tunnel ${tunnelId}`);
    return canceledCount;
  }

  /**
   * Enhanced cleanup with better performance
   */
  async cleanupExpiredRequests() {
    const now = Date.now();
    let cleanedRequests = 0;
    let cleanedQueues = 0;
    let cleanedBodies = 0;

    // More aggressive cleanup during high load
    const isHighLoad = this.currentLoad > 0.7 || this.isOverloaded();
    const cleanupAggressiveness = isHighLoad ? 0.8 : 1.0;

    // Clean up expired pending responses
    const expiredResponses = [];
    for (const [requestId, pending] of this.pendingResponses) {
      const timeoutThreshold = pending.timeout_at * cleanupAggressiveness;
      if (now > timeoutThreshold) {
        expiredResponses.push(requestId);
      }
    }

    for (const requestId of expiredResponses) {
      this.rejectExpiredRequest(requestId);
      cleanedRequests++;
    }

    // Clean up expired requests in queues
    const emptyQueues = [];
    for (const [tunnelId, queue] of this.requestQueues) {
      const originalLength = queue.length;
      
      const validRequests = queue.filter(request => {
        const timeoutThreshold = request.timeout_at * cleanupAggressiveness;
        if (now > timeoutThreshold) {
          this.rejectExpiredRequest(request.id);
          return false;
        }
        return true;
      });

      this.requestQueues.set(tunnelId, validRequests);
      cleanedRequests += (originalLength - validRequests.length);

      if (validRequests.length === 0) {
        emptyQueues.push(tunnelId);
      }
    }

    // Remove empty queues
    for (const tunnelId of emptyQueues) {
      this.requestQueues.delete(tunnelId);
      cleanedQueues++;
    }

    // Clean up orphaned request bodies
    const activePendingIds = new Set(this.pendingResponses.keys());
    const activeQueuedIds = new Set();
    
    for (const queue of this.requestQueues.values()) {
      for (const request of queue) {
        activeQueuedIds.add(request.id);
      }
    }
    
    for (const [requestId] of this.requestBodies) {
      if (!activePendingIds.has(requestId) && !activeQueuedIds.has(requestId)) {
        this.requestBodies.delete(requestId);
        cleanedBodies++;
      }
    }

    // Адаптивная настройка лимитов на основе нагрузки
    this.adjustLimitsBasedOnLoad();

    if (cleanedRequests > 0 || cleanedQueues > 0 || cleanedBodies > 0) {
      console.log(`RequestQueue cleanup: removed ${cleanedRequests} expired requests, ${cleanedQueues} empty queues, ${cleanedBodies} orphaned bodies. Load: ${this.currentLoad.toFixed(2)}`);
    }

    return { cleanedRequests, cleanedQueues, cleanedBodies };
  }

  /**
   * Адаптивная настройка лимитов
   */
  adjustLimitsBasedOnLoad() {
    const baseMaxQueueSize = 50;
    const baseMaxConcurrent = 10;
    
    if (this.performanceMetrics.overloadCount > 10) {
      // If frequently overloaded, reduce limits
      this.maxQueueSize = Math.max(baseMaxQueueSize * 0.7, 10);
      this.maxConcurrentRequests = Math.max(baseMaxConcurrent * 0.7, 5);
    } else if (this.currentLoad < 0.3 && this.performanceMetrics.avgProcessingTime < 1000) {
      // If underutilized and fast, increase limits
      this.maxQueueSize = Math.min(baseMaxQueueSize * 1.2, 100);
      this.maxConcurrentRequests = Math.min(baseMaxConcurrent * 1.2, 20);
    } else {
      // Reset to base values
      this.maxQueueSize = baseMaxQueueSize;
      this.maxConcurrentRequests = baseMaxConcurrent;
    }
  }

  /**
   * Enhanced alarm handling with load balancing
   */
  async alarm() {
    await this.initialize();
    
    const cleanupResult = await this.cleanupExpiredRequests();
    
    // Динамический интервал очистки на основе нагрузки
    let nextCleanupInterval = this.cleanupInterval;
    
    if (this.isOverloaded()) {
      nextCleanupInterval = 15000; // More frequent cleanup when overloaded
    } else if (this.currentLoad < 0.2) {
      nextCleanupInterval = 60000; // Less frequent when idle
    }
    
    // Schedule next cleanup
    this.scheduleNextCleanup();
  }

  /**
   * Enhanced reject expired request with cleanup
   */
  rejectExpiredRequest(requestId) {
    const pending = this.pendingResponses.get(requestId);
    if (pending) {
      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
      
      // Clear timeout if exists
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      
      const error = new Error('Request timeout');
      error.retryable = true;
      pending.reject(error);
    }
  }

  /**
   * Ручная очистка для экстренных случаев
   */
  async handleEmergencyCleanup(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    console.warn('Emergency cleanup initiated');
    
    // Clear all queues and pending requests
    let clearedRequests = 0;
    
    // Clear all pending responses
    for (const [requestId, pending] of this.pendingResponses) {
      pending.reject(new Error('Emergency cleanup'));
      clearedRequests++;
    }
    this.pendingResponses.clear();
    
    // Clear all queues
    for (const [tunnelId, queue] of this.requestQueues) {
      clearedRequests += queue.length;
    }
    this.requestQueues.clear();
    
    // Clear all bodies
    this.requestBodies.clear();
    
    // Reset metrics
    this.currentLoad = 0;
    this.performanceMetrics.overloadCount = 0;
    
    console.warn(`Emergency cleanup completed: cleared ${clearedRequests} requests`);
    
    return new Response(JSON.stringify({ 
      success: true,
      cleared_requests: clearedRequests,
      message: 'Emergency cleanup completed'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Enhanced statistics with performance metrics
   */
  async handleStats(request) {
    let totalQueued = 0;
    let totalPending = this.pendingResponses.size;
    let activeQueues = 0;
    let totalStoredBodies = this.requestBodies.size;
    let maxQueueSize = 0;

    for (const [tunnelId, queue] of this.requestQueues) {
      if (queue.length > 0) {
        activeQueues++;
        totalQueued += queue.length;
        maxQueueSize = Math.max(maxQueueSize, queue.length);
      }
    }

    const stats = {
      // Basic stats
      total_queued: totalQueued,
      total_pending: totalPending,
      active_queues: activeQueues,
      total_queues: this.requestQueues.size,
      stored_bodies: totalStoredBodies,
      max_queue_size_configured: this.maxQueueSize,
      max_queue_size_actual: maxQueueSize,
      request_timeout: this.requestTimeout,
      poll_timeout: this.pollTimeout,
      max_request_size: this.maxRequestSize,
      max_concurrent_requests: this.maxConcurrentRequests,
      
      // Performance metrics
      current_load: this.currentLoad,
      performance: {
        requests_processed: this.performanceMetrics.requestsProcessed,
        avg_processing_time: Math.round(this.performanceMetrics.avgProcessingTime),
        overload_count: this.performanceMetrics.overloadCount,
        last_overload_time: this.performanceMetrics.lastOverloadTime,
        time_since_last_overload: this.performanceMetrics.lastOverloadTime ? 
          Date.now() - this.performanceMetrics.lastOverloadTime : null
      },
      
      // System info
      is_overloaded: this.isOverloaded(),
      memory_usage: {
        request_queues: this.requestQueues.size,
        pending_responses: this.pendingResponses.size,
        stored_bodies: this.requestBodies.size
      },
      
      durable_object_id: this.state.id.toString(),
      timestamp: Date.now()
    };

    return new Response(JSON.stringify(stats, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Get CORS headers
   */
  getCORSHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
  }
}