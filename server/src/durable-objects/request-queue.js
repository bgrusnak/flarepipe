// server/src/durable-objects/request-queue.js

export class RequestQueue {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.storage = state.storage;
      
      // In-memory queues for performance
      this.requestQueues = new Map(); // tunnelId -> request[]
      this.pendingResponses = new Map(); // requestId -> resolver
      this.requestBodies = new Map(); // requestId -> ArrayBuffer
      
      // Configuration
      this.maxQueueSize = 100;
      this.requestTimeout = 60000; // 30 seconds
      this.pollTimeout = 60000; // 30 seconds
      this.maxRequestSize = 10 * 1024 * 1024; // 10MB
      
      this.initialized = false;
      this.cleanupInterval = 60000; // 1 minute
      
      // Start cleanup
      this.startCleanupTimer();
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
     * Queue a request for a tunnel
     */
    async handleQueueRequest(request) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      // Extract tunnel info from headers
      const tunnelId = request.headers.get('X-Tunnel-ID');
      const requestId = request.headers.get('X-Request-ID');
      const method = request.headers.get('X-Method');
      const path = request.headers.get('X-Path');
      const query = request.headers.get('X-Query');
      const headersJson = request.headers.get('X-Headers');
      const timeout = parseInt(request.headers.get('X-Timeout') || '30000', 10);
  
      if (!tunnelId || !requestId || !method || !path) {
        return new Response(JSON.stringify({ error: 'Missing required headers' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Get request body as ArrayBuffer
      const body = await request.arrayBuffer();
      
      if (body.byteLength > this.maxRequestSize) {
        return new Response(JSON.stringify({ error: 'Request too large' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Parse headers
      let requestHeaders = {};
      if (headersJson) {
        try {
          requestHeaders = JSON.parse(headersJson);
        } catch (e) {
          console.warn('Failed to parse request headers');
        }
      }
  
      // Get or create queue
      let queue = this.requestQueues.get(tunnelId);
      if (!queue) {
        queue = [];
        this.requestQueues.set(tunnelId, queue);
      }
  
      // Check queue size
      if (queue.length >= this.maxQueueSize) {
        return new Response(JSON.stringify({ error: 'Tunnel queue is full' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Store body separately
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
  
      // Create response promise
      const responsePromise = new Promise((resolve, reject) => {
        this.pendingResponses.set(requestId, {
          resolve,
          reject,
          tunnel_id: tunnelId,
          created_at: Date.now(),
          timeout_at: Date.now() + timeout
        });
  
        // Set timeout
        setTimeout(() => {
          const pending = this.pendingResponses.get(requestId);
          if (pending) {
            this.pendingResponses.delete(requestId);
            this.requestBodies.delete(requestId);
            reject(new Error('Request timeout'));
          }
        }, timeout);
      });
  
      // Wait for response
      try {
        const response = await responsePromise;
        
        return new Response(response.body || new ArrayBuffer(0), {
          status: response.status || 200,
          headers: {
            'X-Response-Status': String(response.status || 200),
            'X-Response-Headers': JSON.stringify(response.headers || {}),
            ...this.getCORSHeaders()
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 504,
          headers: { 'Content-Type': 'application/json', ...this.getCORSHeaders() }
        });
      }
    }
  
    /**
     * Long-polling for tunnel clients
     */
    async handlePoll(request) {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      const url = new URL(request.url);
      const tunnelId = url.searchParams.get('tunnel_id');
      const timeout = parseInt(url.searchParams.get('timeout') || '30000', 10);
  
      if (!tunnelId) {
        return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      try {
        const requestData = await this.waitForRequest(tunnelId, Math.min(timeout, this.pollTimeout));
        
        if (!requestData) {
          // No request available
          return new Response(null, { status: 204 });
        }
  
        // Restore body
        const body = this.requestBodies.get(requestData.id) || new ArrayBuffer(0);
  
        // Return request with metadata in headers
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
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  
    /**
     * Wait for request in queue (internal)
     */
    async waitForRequest(tunnelId, timeout) {
      const queue = this.requestQueues.get(tunnelId);
      
      // Check if request is immediately available
      if (queue && queue.length > 0) {
        const requestData = queue.shift();
        
        // Check if still valid
        if (requestData.timeout_at && Date.now() > requestData.timeout_at) {
          this.rejectExpiredRequest(requestData.id);
          return this.waitForRequest(tunnelId, timeout); // Try next
        }
        
        return requestData;
      }
  
      // No immediate request, set up long polling
      return new Promise((resolve) => {
        const startTime = Date.now();
        
        const checkForRequests = () => {
          const queue = this.requestQueues.get(tunnelId);
          
          if (queue && queue.length > 0) {
            const requestData = queue.shift();
            
            if (requestData.timeout_at && Date.now() > requestData.timeout_at) {
              this.rejectExpiredRequest(requestData.id);
              if (Date.now() - startTime < timeout) {
                setTimeout(checkForRequests, 100);
              } else {
                resolve(null);
              }
              return;
            }
            
            resolve(requestData);
            return;
          }
  
          if (Date.now() - startTime >= timeout) {
            resolve(null);
            return;
          }
  
          setTimeout(checkForRequests, 100);
        };
  
        checkForRequests();
      });
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
        // This is normal - request might have timed out
        console.log(`Response for expired request: ${requestId}`);
        return new Response(JSON.stringify({ success: true, note: 'Request already timed out' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
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
  
      // Remove from pending
      this.pendingResponses.delete(requestId);
      this.requestBodies.delete(requestId);
  
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
     * Reject an expired request
     */
    rejectExpiredRequest(requestId) {
      const pending = this.pendingResponses.get(requestId);
      if (pending) {
        this.pendingResponses.delete(requestId);
        this.requestBodies.delete(requestId);
        pending.reject(new Error('Request timeout'));
      }
    }
  
    /**
     * Start cleanup timer using Durable Object alarms
     */
    startCleanupTimer() {
      this.state.storage.setAlarm(Date.now() + this.cleanupInterval);
    }
  
    /**
     * Handle alarm for cleanup
     */
    async alarm() {
      await this.initialize();
      await this.cleanupExpiredRequests();
      
      // Schedule next cleanup
      this.state.storage.setAlarm(Date.now() + this.cleanupInterval);
    }
  
    /**
     * Clean up expired requests
     */
    async cleanupExpiredRequests() {
      const now = Date.now();
      let cleanedRequests = 0;
      let cleanedQueues = 0;
      let cleanedBodies = 0;
  
      // Clean up expired pending responses
      const expiredResponses = [];
      for (const [requestId, pending] of this.pendingResponses) {
        if (now > pending.timeout_at) {
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
          if (request.timeout_at && now > request.timeout_at) {
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
  
      if (cleanedRequests > 0 || cleanedQueues > 0 || cleanedBodies > 0) {
        console.log(`RequestQueue cleanup: removed ${cleanedRequests} expired requests, ${cleanedQueues} empty queues, ${cleanedBodies} orphaned bodies`);
      }
  
      return { cleanedRequests, cleanedQueues, cleanedBodies };
    }
  
    /**
     * Get statistics
     */
    async handleStats(request) {
      let totalQueued = 0;
      let totalPending = this.pendingResponses.size;
      let activeQueues = 0;
      let totalStoredBodies = this.requestBodies.size;
  
      for (const [tunnelId, queue] of this.requestQueues) {
        if (queue.length > 0) {
          activeQueues++;
          totalQueued += queue.length;
        }
      }
  
      const stats = {
        total_queued: totalQueued,
        total_pending: totalPending,
        active_queues: activeQueues,
        total_queues: this.requestQueues.size,
        stored_bodies: totalStoredBodies,
        max_queue_size: this.maxQueueSize,
        request_timeout: this.requestTimeout,
        poll_timeout: this.pollTimeout,
        max_request_size: this.maxRequestSize,
        durable_object_id: this.state.id.toString()
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