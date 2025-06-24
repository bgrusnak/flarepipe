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
      lastOverloadTime: 0,
      consecutiveOverloads: 0
    };
    
    // ЗНАЧИТЕЛЬНО уменьшенные лимиты для предотвращения перегрузки
    this.maxQueueSize = 10; // Уменьшено с 50
    this.requestTimeout = 20000; // Уменьшено до 20 секунд
    this.pollTimeout = 15000; // Уменьшено до 15 секунд  
    this.maxRequestSize = 2 * 1024 * 1024; // Уменьшено до 2MB
    this.maxConcurrentRequests = 5; // Уменьшено с 10
    this.maxTotalPendingRequests = 20; // Новый лимит
    
    this.initialized = false;
    this.cleanupInterval = 15000; // Более частая очистка
    this.currentLoad = 0;
    this.shardId = this.getShardId(); // Идентификация шарда
    
    // Адаптивные лимиты
    this.adaptiveLimits = {
      enabled: true,
      baseQueueSize: 10,
      baseConcurrency: 5,
      adjustmentFactor: 0.5,
      lastAdjustment: 0
    };
    
    this.scheduleNextCleanup();
  }

  /**
   * Получение ID шарда из Durable Object ID
   */
  getShardId() {
    return this.state.id.toString().substring(0, 8);
  }

  /**
   * Значительно улучшенная проверка перегрузки
   */
  isOverloaded() {
    const totalQueued = Array.from(this.requestQueues.values())
      .reduce((sum, queue) => sum + queue.length, 0);
    const totalPending = this.pendingResponses.size;
    
    // Адаптивные пороги
    const dynamicQueueThreshold = this.adaptiveLimits.enabled ? 
      Math.max(this.maxQueueSize * 0.6, 3) : this.maxQueueSize * 0.8;
    const dynamicPendingThreshold = this.adaptiveLimits.enabled ?
      Math.max(this.maxConcurrentRequests * 0.6, 2) : this.maxConcurrentRequests;
    
    // Проверка множественных критериев
    const queueOverload = totalQueued > dynamicQueueThreshold;
    const pendingOverload = totalPending > dynamicPendingThreshold;
    const loadOverload = this.currentLoad > 0.8;
    const totalOverload = (totalQueued + totalPending) > this.maxTotalPendingRequests;
    
    // Проверка на последовательные перегрузки
    const timeBasedOverload = this.performanceMetrics.consecutiveOverloads > 3;
    
    const isOverloaded = queueOverload || pendingOverload || loadOverload || 
                        totalOverload || timeBasedOverload;
    
    if (isOverloaded) {
      this.performanceMetrics.overloadCount++;
      this.performanceMetrics.lastOverloadTime = Date.now();
      this.performanceMetrics.consecutiveOverloads++;
      
      console.warn(`RequestQueue ${this.shardId} overloaded:`, {
        queued: totalQueued,
        pending: totalPending,
        load: this.currentLoad.toFixed(2),
        consecutive: this.performanceMetrics.consecutiveOverloads,
        reason: queueOverload ? 'queue' : pendingOverload ? 'pending' : 
               loadOverload ? 'load' : totalOverload ? 'total' : 'consecutive'
      });
      
      // Адаптивное снижение лимитов при перегрузке
      this.adjustLimitsDown();
    } else {
      // Сброс счетчика последовательных перегрузок
      if (this.performanceMetrics.consecutiveOverloads > 0) {
        this.performanceMetrics.consecutiveOverloads = Math.max(0, 
          this.performanceMetrics.consecutiveOverloads - 1);
      }
    }
    
    return isOverloaded;
  }

  /**
   * Адаптивное снижение лимитов
   */
  adjustLimitsDown() {
    if (!this.adaptiveLimits.enabled) return;
    
    const now = Date.now();
    if (now - this.adaptiveLimits.lastAdjustment < 5000) return; // Не чаще раза в 5 секунд
    
    this.maxQueueSize = Math.max(2, Math.floor(this.maxQueueSize * 0.8));
    this.maxConcurrentRequests = Math.max(1, Math.floor(this.maxConcurrentRequests * 0.8));
    this.maxTotalPendingRequests = Math.max(5, Math.floor(this.maxTotalPendingRequests * 0.8));
    
    this.adaptiveLimits.lastAdjustment = now;
    
    console.warn(`RequestQueue ${this.shardId} limits reduced:`, {
      queue: this.maxQueueSize,
      concurrent: this.maxConcurrentRequests,
      total: this.maxTotalPendingRequests
    });
  }

  /**
   * Адаптивное увеличение лимитов при низкой нагрузке
   */
  adjustLimitsUp() {
    if (!this.adaptiveLimits.enabled) return;
    
    const now = Date.now();
    if (now - this.adaptiveLimits.lastAdjustment < 30000) return; // Не чаще раза в 30 секунд
    
    // Только если нет недавних перегрузок
    if (now - this.performanceMetrics.lastOverloadTime < 60000) return;
    
    this.maxQueueSize = Math.min(this.adaptiveLimits.baseQueueSize, 
      Math.floor(this.maxQueueSize * 1.2));
    this.maxConcurrentRequests = Math.min(this.adaptiveLimits.baseConcurrency, 
      Math.floor(this.maxConcurrentRequests * 1.2));
    this.maxTotalPendingRequests = Math.min(20, 
      Math.floor(this.maxTotalPendingRequests * 1.2));
    
    this.adaptiveLimits.lastAdjustment = now;
  }

  /**
   * Быстрая проверка на раннее отклонение запросов
   */
  canAcceptRequest() {
    // Быстрые проверки без тяжелых вычислений
    if (this.pendingResponses.size >= this.maxTotalPendingRequests) {
      return { accept: false, reason: 'max_pending_exceeded' };
    }
    
    if (this.currentLoad > 0.9) {
      return { accept: false, reason: 'high_load' };
    }
    
    if (this.performanceMetrics.consecutiveOverloads > 5) {
      return { accept: false, reason: 'consecutive_overloads' };
    }
    
    return { accept: true };
  }

  /**
   * Оптимизированная обработка запроса в очередь
   */
  async handleQueueRequest(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const startTime = Date.now();
    
    // Быстрая проверка перед тяжелой обработкой
    const acceptCheck = this.canAcceptRequest();
    if (!acceptCheck.accept) {
      return new Response(JSON.stringify({ 
        error: 'Queue overloaded',
        reason: acceptCheck.reason,
        retryAfter: 3,
        shardId: this.shardId
      }), {
        status: 503,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': '3',
          ...this.getCORSHeaders() 
        }
      });
    }

    this.currentLoad = Math.min(this.currentLoad + 0.2, 1.0);
    
    try {
      // Extract metadata
      const tunnelId = request.headers.get('X-Tunnel-ID');
      const requestId = request.headers.get('X-Request-ID');
      const method = request.headers.get('X-Method');
      const path = request.headers.get('X-Path');
      const query = request.headers.get('X-Query');
      const headersJson = request.headers.get('X-Headers');
      const timeout = Math.min(parseInt(request.headers.get('X-Timeout') || '15000', 10), 20000);

      if (!tunnelId || !requestId || !method || !path) {
        throw new Error('Missing required headers');
      }

      // Проверка дубликатов
      if (this.pendingResponses.has(requestId)) {
        throw new Error('Duplicate request ID');
      }

      // Streamlined body reading с ранней проверкой размера
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > this.maxRequestSize) {
        throw new Error(`Request too large: ${contentLength} bytes`);
      }

      const body = await request.arrayBuffer();
      if (body.byteLength > this.maxRequestSize) {
        throw new Error(`Request too large: ${body.byteLength} bytes`);
      }

      // Parse headers efficiently
      let requestHeaders = {};
      if (headersJson) {
        try {
          requestHeaders = JSON.parse(headersJson);
        } catch (e) {
          console.warn('Failed to parse request headers');
        }
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
      
      if (error.overloaded || error.message.includes('overloaded') || 
          error.message.includes('queue is full')) {
        return new Response(JSON.stringify({ 
          error: 'Queue overloaded',
          retryAfter: 5,
          shardId: this.shardId,
          details: error.message
        }), {
          status: 503,
          headers: { 
            'Content-Type': 'application/json',
            'Retry-After': '5',
            ...this.getCORSHeaders() 
          }
        });
      }
      
      const status = error.message.includes('too large') ? 413 : 400;
      
      return new Response(JSON.stringify({ 
        error: error.message,
        shardId: this.shardId 
      }), {
        status: status,
        headers: { 'Content-Type': 'application/json', ...this.getCORSHeaders() }
      });
    } finally {
      // Decrease load более агрессивно
      this.currentLoad = Math.max(this.currentLoad - 0.3, 0);
    }
  }

  /**
   * Оптимизированный long-polling с более коротким таймаутом
   */
  async handlePoll(request) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const tunnelId = url.searchParams.get('tunnel_id');
    const timeout = Math.min(parseInt(url.searchParams.get('timeout') || '10000', 10), 15000);

    if (!tunnelId) {
      return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const requestData = await this.waitForRequestOptimized(tunnelId, timeout);
      
      if (!requestData) {
        return new Response(null, { 
          status: 204,
          headers: { 'X-Shard-ID': this.shardId }
        });
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
          'X-Shard-ID': this.shardId,
          'Content-Type': 'application/octet-stream'
        }
      });
    } catch (error) {
      console.error(`Poll error in shard ${this.shardId}:`, error.message);
      return new Response(JSON.stringify({ 
        error: error.message,
        shardId: this.shardId 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Значительно оптимизированное ожидание с более короткими интервалами
   */
  async waitForRequestOptimized(tunnelId, timeout) {
    const queue = this.requestQueues.get(tunnelId);
    
    // Fast path: immediate availability
    if (queue && queue.length > 0) {
      return this.dequeueValidRequest(queue);
    }

    // Более короткие интервалы опроса для быстрого ответа
    return new Promise((resolve) => {
      const startTime = Date.now();
      const pollInterval = Math.min(timeout / 50, 50); // Более частый опрос
      let attempts = 0;
      const maxAttempts = Math.floor(timeout / pollInterval);
      
      const checkForRequests = () => {
        attempts++;
        
        const queue = this.requestQueues.get(tunnelId);
        
        if (queue && queue.length > 0) {
          const request = this.dequeueValidRequest(queue);
          if (request) {
            resolve(request);
            return;
          }
        }

        if (attempts >= maxAttempts || Date.now() - startTime >= timeout) {
          resolve(null);
          return;
        }

        // Увеличиваем интервал при отсутствии запросов
        const dynamicInterval = Math.min(pollInterval * (1 + attempts * 0.1), 200);
        setTimeout(checkForRequests, dynamicInterval);
      };

      checkForRequests();
    });
  }

  /**
   * Агрессивная очистка с учетом нагрузки
   */
  async cleanupExpiredRequests() {
    const now = Date.now();
    let cleanedRequests = 0;
    let cleanedQueues = 0;
    let cleanedBodies = 0;

    // Более агрессивная очистка при высокой нагрузке
    const isHighLoad = this.currentLoad > 0.5 || this.isOverloaded();
    const cleanupAggressiveness = isHighLoad ? 0.6 : 0.8; // Более агрессивная очистка

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

    // Попытка восстановления лимитов при низкой нагрузке
    if (!isHighLoad && cleanedRequests === 0) {
      this.adjustLimitsUp();
    }

    if (cleanedRequests > 0 || cleanedQueues > 0 || cleanedBodies > 0) {
      console.log(`RequestQueue ${this.shardId} cleanup: removed ${cleanedRequests} expired requests, ${cleanedQueues} empty queues, ${cleanedBodies} orphaned bodies. Load: ${this.currentLoad.toFixed(2)}`);
    }

    return { cleanedRequests, cleanedQueues, cleanedBodies };
  }

  /**
   * Адаптивная настройка интервала очистки
   */
  async alarm() {
    await this.initialize();
    
    const cleanupResult = await this.cleanupExpiredRequests();
    
    // Динамический интервал очистки на основе нагрузки
    let nextCleanupInterval = this.cleanupInterval;
    
    if (this.isOverloaded() || this.performanceMetrics.consecutiveOverloads > 2) {
      nextCleanupInterval = 5000; // Очень частая очистка при перегрузке
    } else if (this.currentLoad > 0.5) {
      nextCleanupInterval = 10000; // Частая очистка при высокой нагрузке
    } else if (this.currentLoad < 0.1) {
      nextCleanupInterval = 30000; // Редкая очистка при низкой нагрузке
    }
    
    // Schedule next cleanup
    this.state.storage.setAlarm(Date.now() + nextCleanupInterval);
  }

  /**
   * Расширенная статистика
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
      // Shard info
      shard_id: this.shardId,
      
      // Basic stats
      total_queued: totalQueued,
      total_pending: totalPending,
      active_queues: activeQueues,
      total_queues: this.requestQueues.size,
      stored_bodies: totalStoredBodies,
      
      // Current configuration
      limits: {
        max_queue_size: this.maxQueueSize,
        max_concurrent_requests: this.maxConcurrentRequests,
        max_total_pending: this.maxTotalPendingRequests,
        request_timeout: this.requestTimeout,
        poll_timeout: this.pollTimeout,
        max_request_size: this.maxRequestSize
      },
      
      // Adaptive limits
      adaptive_limits: {
        enabled: this.adaptiveLimits.enabled,
        base_queue_size: this.adaptiveLimits.baseQueueSize,
        base_concurrency: this.adaptiveLimits.baseConcurrency,
        last_adjustment: this.adaptiveLimits.lastAdjustment
      },
      
      // Performance metrics
      current_load: this.currentLoad,
      performance: {
        requests_processed: this.performanceMetrics.requestsProcessed,
        avg_processing_time: Math.round(this.performanceMetrics.avgProcessingTime),
        overload_count: this.performanceMetrics.overloadCount,
        consecutive_overloads: this.performanceMetrics.consecutiveOverloads,
        last_overload_time: this.performanceMetrics.lastOverloadTime,
        time_since_last_overload: this.performanceMetrics.lastOverloadTime ? 
          Date.now() - this.performanceMetrics.lastOverloadTime : null
      },
      
      // Health status
      is_overloaded: this.isOverloaded(),
      can_accept_requests: this.canAcceptRequest(),
      
      durable_object_id: this.state.id.toString(),
      timestamp: Date.now()
    };

    return new Response(JSON.stringify(stats, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ... остальные методы остаются такими же ...
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    console.log(`RequestQueue ${this.shardId} initialized`);
  }

  scheduleNextCleanup() {
    this.state.storage.setAlarm(Date.now() + this.cleanupInterval);
  }

  getOrCreateQueue(tunnelId) {
    let queue = this.requestQueues.get(tunnelId);
    if (!queue) {
      if (this.requestQueues.size >= 20) { // Уменьшено количество туннелей
        throw new Error('Too many active tunnels');
      }
      queue = [];
      this.requestQueues.set(tunnelId, queue);
    }
    return queue;
  }

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
      
      responseHandler.timeoutId = timeoutId;
    });
  }

  buildSuccessResponse(response) {
    return new Response(response.body || new ArrayBuffer(0), {
      status: 200,
      headers: {
        'X-Response-Status': String(response.status || 200),
        'X-Response-Headers': JSON.stringify(response.headers || {}),
        'X-Processing-Time': String(Date.now()),
        'X-Shard-ID': this.shardId,
        ...this.getCORSHeaders()
      }
    });
  }

  updateMetrics(processingTime, failed = false) {
    this.performanceMetrics.requestsProcessed++;
    
    if (!failed) {
      const count = this.performanceMetrics.requestsProcessed;
      const currentAvg = this.performanceMetrics.avgProcessingTime;
      this.performanceMetrics.avgProcessingTime = 
        (currentAvg * (count - 1) + processingTime) / count;
    }
  }

  dequeueValidRequest(queue) {
    while (queue.length > 0) {
      const requestData = queue.shift();
      
      if (requestData.timeout_at && Date.now() > requestData.timeout_at) {
        this.rejectExpiredRequest(requestData.id);
        continue;
      }
      
      return requestData;
    }
    return null;
  }

  rejectExpiredRequest(requestId) {
    const pending = this.pendingResponses.get(requestId);
    if (pending) {
      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
      
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      
      const error = new Error('Request timeout');
      error.retryable = true;
      pending.reject(error);
    }
  }

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
      return new Response(JSON.stringify({ 
        success: true, 
        note: 'Request already processed or timed out',
        shardId: this.shardId
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      let responseHeaders = {};
      if (responseHeadersJson) {
        try {
          responseHeaders = JSON.parse(responseHeadersJson);
        } catch (e) {
          console.warn('Failed to parse response headers');
        }
      }

      const body = await request.arrayBuffer();

      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
      
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }

      pending.resolve({
        status: parseInt(responseStatus, 10) || 200,
        headers: responseHeaders,
        body: body
      });

      return new Response(JSON.stringify({ 
        success: true,
        shardId: this.shardId 
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Response handling error:', error.message);
      
      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
      
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      
      pending.reject(error);
      
      return new Response(JSON.stringify({ 
        error: error.message,
        shardId: this.shardId 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

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
      canceled_requests: canceledCount,
      shardId: this.shardId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  cancelTunnelRequests(tunnelId) {
    let canceledCount = 0;

    const queue = this.requestQueues.get(tunnelId);
    if (queue) {
      for (const request of queue) {
        this.rejectExpiredRequest(request.id);
        canceledCount++;
      }
      this.requestQueues.delete(tunnelId);
    }

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

    console.log(`Canceled ${canceledCount} requests for tunnel ${tunnelId} in shard ${this.shardId}`);
    return canceledCount;
  }

  async handleEmergencyCleanup(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    console.warn(`Emergency cleanup initiated in shard ${this.shardId}`);
    
    let clearedRequests = 0;
    
    for (const [requestId, pending] of this.pendingResponses) {
      pending.reject(new Error('Emergency cleanup'));
      clearedRequests++;
    }
    this.pendingResponses.clear();
    
    for (const [tunnelId, queue] of this.requestQueues) {
      clearedRequests += queue.length;
    }
    this.requestQueues.clear();
    
    this.requestBodies.clear();
    
    // Reset metrics and limits
    this.currentLoad = 0;
    this.performanceMetrics.overloadCount = 0;
    this.performanceMetrics.consecutiveOverloads = 0;
    
    // Reset adaptive limits
    this.maxQueueSize = this.adaptiveLimits.baseQueueSize;
    this.maxConcurrentRequests = this.adaptiveLimits.baseConcurrency;
    this.maxTotalPendingRequests = 20;
    
    console.warn(`Emergency cleanup completed in shard ${this.shardId}: cleared ${clearedRequests} requests`);
    
    return new Response(JSON.stringify({ 
      success: true,
      cleared_requests: clearedRequests,
      shard_id: this.shardId,
      message: 'Emergency cleanup completed'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  getCORSHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
  }

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
      console.error(`RequestQueue ${this.shardId} error:`, error);
      return new Response(JSON.stringify({ 
        error: error.message,
        shardId: this.shardId 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}