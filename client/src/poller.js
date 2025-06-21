// client/src/poller.js

const { v4: uuidv4 } = require('uuid');

class Poller {
  /**
   * Creates a new poller instance
   * @param {string} host - CF Worker host URL
   * @param {object} options - Configuration options
   */
  constructor(host, options = {}) {
    this.host = host.startsWith('http') ? host : `https://${host}`;
    this.concurrency = options.concurrency || 16;
    this.timeout = options.timeout || 30000; // 30 seconds
    this.retryDelay = options.retryDelay || 1000; // 1 second
    this.maxRetryDelay = options.maxRetryDelay || 30000; // 30 seconds
    this.maxRequestSize = options.maxRequestSize || 10 * 1024 * 1024; // 10MB
    this.heartbeatInterval = options.heartbeatInterval || 60000; // 1 minute
    this.authKey = options.authKey || null;
    this.prefix = options.prefix || '';
    
    this.isRunning = false;
    this.pollingWorkers = [];
    this.activeControllers = new Set();
    this.workerPool = null;
    this.requestHandler = null;
    this.tunnelId = null;
    this.heartbeatTimer = null;
    this.lastHeartbeat = null;
    this.client = null; // NEW: For auto-reconnect
  }

  /**
   * Sets the worker pool for processing requests
   * @param {WorkerPool} workerPool - Worker pool instance
   */
  setWorkerPool(workerPool) {
    this.workerPool = workerPool;
  }

  /**
   * Sets the request handler function
   * @param {Function} handler - Async function to handle requests
   */
  setRequestHandler(handler) {
    this.requestHandler = handler;
  }

  /**
   * Sets the tunnel ID for this client
   * @param {string} tunnelId - Unique tunnel identifier
   */
  setTunnelId(tunnelId) {
    this.tunnelId = tunnelId;
  }

  /**
   * Set client reference for auto-reconnection
   * @param {TunnelClient} client - Client instance
   */
  setClient(client) {
    this.client = client;
  }

  /**
   * Gets base headers for server requests
   * @returns {object} - Headers object
   */
  getBaseHeaders() {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'flarepipe-client/1.2.0'
    };
    
    if (this.authKey) {
      headers['Authorization'] = `Bearer ${this.authKey}`;
    }
    
    return headers;
  }

  /**
   * Builds API URL with prefix
   * @param {string} endpoint - API endpoint (e.g., 'register', 'poll')
   * @returns {string} - Full API URL
   */
  buildApiUrl(endpoint) {
    if (this.prefix) {
      return `${this.host}/${this.prefix}/${endpoint}`;
    }
    return `${this.host}/${endpoint}`;
  }

  /**
   * Starts polling with multiple concurrent workers
   */
  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.requestHandler) {
      throw new Error('Request handler must be set before starting');
    }

    this.isRunning = true;
    this.lastHeartbeat = Date.now();
    
    // Start heartbeat monitoring
    this.startHeartbeat();
    
    // Start multiple polling workers
    for (let i = 0; i < this.concurrency; i++) {
      const worker = this.createPollingWorker(i);
      this.pollingWorkers.push(worker);
    }
  }

  /**
   * Stops all polling workers
   */
  async stop() {
    this.isRunning = false;
    
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    // Abort all active requests
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    
    // Wait for all workers to finish
    await Promise.allSettled(this.pollingWorkers);
    this.pollingWorkers = [];
  }

  /**
   * Starts heartbeat monitoring
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
        this.lastHeartbeat = Date.now();
      } catch (error) {
        console.error('Heartbeat failed:', error.message);
        // If heartbeat fails multiple times, consider reconnecting
        const timeSinceLastSuccess = Date.now() - this.lastHeartbeat;
        if (timeSinceLastSuccess > this.heartbeatInterval * 3) {
          console.warn('Multiple heartbeat failures, connection may be lost');
        }
      }
    }, this.heartbeatInterval);
  }

  /**
   * Sends heartbeat to server
   */
  async sendHeartbeat() {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...this.getBaseHeaders()
      };

      const response = await fetch(this.buildApiUrl('heartbeat'), {
        method: 'POST',
        signal: controller.signal,
        headers: headers,
        body: JSON.stringify({
          tunnel_id: this.tunnelId,
          timestamp: Date.now()
        })
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed during heartbeat`);
        }
        throw new Error(`Heartbeat failed: ${response.status}`);
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Enhanced polling with auto-reconnect for Durable Objects
   */
  async createPollingWorker(workerId) {
    let currentRetryDelay = this.retryDelay;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    while (this.isRunning) {
      try {
        await this.pollOnce();
        // Reset retry delay and error count on successful poll
        currentRetryDelay = this.retryDelay;
        consecutiveErrors = 0;
      } catch (error) {
        if (!this.isRunning) {
          break;
        }

        consecutiveErrors++;

        // Don't log abort errors
        if (error.name !== 'AbortError') {
          console.error(`Poller worker ${workerId} error (${consecutiveErrors}/${maxConsecutiveErrors}):`, error.message);
        }

        // Handle specific errors
        if (error.message.includes('404') || error.message.includes('Tunnel not found')) {
          console.log('🔄 Tunnel lost, attempting to re-register...');
          try {
            await this.handleTunnelLost();
            consecutiveErrors = 0; // Reset on successful re-registration
            continue;
          } catch (reregisterError) {
            console.error('Failed to re-register tunnel:', reregisterError.message);
          }
        }

        // If too many consecutive errors, try to reconnect
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.warn(`Too many consecutive errors (${consecutiveErrors}), attempting full reconnect...`);
          try {
            await this.handleFullReconnect();
            consecutiveErrors = 0;
            currentRetryDelay = this.retryDelay;
            continue;
          } catch (reconnectError) {
            console.error('Full reconnect failed:', reconnectError.message);
          }
        }
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.1 * currentRetryDelay;
        await this.sleep(currentRetryDelay + jitter);
        currentRetryDelay = Math.min(currentRetryDelay * 2, this.maxRetryDelay);
      }
    }
  }

  /**
   * Handle tunnel lost scenario (404 errors)
   */
  async handleTunnelLost() {
    if (!this.client) {
      throw new Error('No client reference available for re-registration');
    }

    console.log('🔄 Re-registering tunnel after loss...');
    
    // Re-register tunnel
    await this.client.registerTunnel();
    
    // Update tunnel ID
    this.setTunnelId(this.client.tunnelId);
    
    console.log(`✅ Tunnel re-registered with new ID: ${this.client.tunnelId}`);
  }

  /**
   * Handle full reconnection (multiple errors)
   */
  async handleFullReconnect() {
    if (!this.client) {
      throw new Error('No client reference available for reconnection');
    }

    console.log('🔄 Performing full reconnect...');
    
    try {
      // Stop current operations
      const oldTunnelId = this.tunnelId;
      
      // Try to unregister old tunnel (best effort)
      if (oldTunnelId) {
        try {
          await this.client.unregisterTunnel();
        } catch (error) {
          console.warn('Failed to unregister old tunnel:', error.message);
        }
      }
      
      // Re-register with new tunnel
      await this.client.registerTunnel();
      this.setTunnelId(this.client.tunnelId);
      
      console.log(`✅ Full reconnect completed with new tunnel: ${this.client.tunnelId}`);
      
    } catch (error) {
      console.error('Full reconnect failed:', error.message);
      throw error;
    }
  }

  /**
   * Enhanced pollOnce with better error handling
   */
  async pollOnce() {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    
    try {
      const pollUrl = `${this.buildApiUrl('poll')}${this.tunnelId ? `?tunnel_id=${this.tunnelId}` : ''}`;
      
      const response = await fetch(pollUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: this.getBaseHeaders()
      });

      // Handle specific HTTP error codes
      if (response.status === 404) {
        throw new Error('Tunnel not found (404) - tunnel may have expired');
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error('Authentication failed - check auth key');
      }

      if (response.status === 204) {
        // No requests available, continue polling
        return;
      }

      if (!response.ok) {
        throw new Error(`Poll request failed: ${response.status} ${response.statusText}`);
      }

      // Extract metadata from headers
      const requestId = response.headers.get('X-Request-ID');
      const method = response.headers.get('X-Method');
      const path = response.headers.get('X-Path');
      const query = response.headers.get('X-Query');
      const headersJson = response.headers.get('X-Headers');
      const timestamp = response.headers.get('X-Timestamp');

      if (!requestId || !method || !path) {
        throw new Error('Missing required request metadata in headers');
      }

      // Parse request headers
      let requestHeaders = {};
      if (headersJson) {
        try {
          requestHeaders = JSON.parse(headersJson);
        } catch (parseError) {
          console.warn('Failed to parse request headers:', parseError.message);
        }
      }

      // Get RAW BINARY body as ArrayBuffer
      const body = await response.arrayBuffer();

      // Check content size
      if (body.byteLength > this.maxRequestSize) {
        throw new Error(`Request too large: ${body.byteLength} bytes`);
      }

      // Reconstruct request data
      const requestData = {
        id: requestId,
        method: method,
        path: path,
        query: query || '',
        headers: requestHeaders,
        body: body, // ArrayBuffer - RAW BINARY
        timestamp: timestamp ? parseInt(timestamp, 10) : Date.now()
      };
      
      if (requestData && requestData.id) {
        // Process request through worker pool with timeout
        const requestPromise = this.processRequestWithTimeout(requestData);
        
        if (this.workerPool) {
          this.workerPool.execute(() => requestPromise);
        } else {
          // Fallback: process directly
          setImmediate(() => requestPromise);
        }
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Processes request with timeout to prevent memory leaks
   * @param {object} requestData - Request data from server
   */
  async processRequestWithTimeout(requestData) {
    const requestTimeout = 5 * 60 * 1000; // 5 minutes max per request
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), requestTimeout);
    });

    try {
      await Promise.race([
        this.processRequest(requestData),
        timeoutPromise
      ]);
    } catch (error) {
      console.error(`Request ${requestData.id} failed:`, error.message);
    }
  }

  /**
   * Processes a single HTTP request
   * @param {object} requestData - Request data from server
   */
  async processRequest(requestData) {
    try {
      const response = await this.requestHandler(requestData);
      await this.sendResponse(requestData.id, response);
    } catch (error) {
      console.error('Error processing request:', error.message);
      
      // Send error response
      await this.sendResponse(requestData.id, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
        body: new TextEncoder().encode('Internal tunnel error').buffer // ArrayBuffer
      });
    }
  }

  /**
   * Sends response back to the server
   * @param {string} requestId - Request identifier
   * @param {object} response - Response data with ArrayBuffer body
   */
  async sendResponse(requestId, response) {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    
    try {
      const responseUrl = this.buildApiUrl('response');
      
      const headers = {
        'X-Request-ID': requestId,
        'X-Tunnel-ID': this.tunnelId,
        'X-Response-Status': String(response.status || 200),
        'X-Response-Headers': JSON.stringify(response.headers || {}),
        ...this.getBaseHeaders()
      };

      // Send ArrayBuffer directly as body - NO JSON serialization
      const result = await fetch(responseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: headers,
        body: response.body || new ArrayBuffer(0) // Direct ArrayBuffer transmission
      });

      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          console.error(`Authentication failed when sending response`);
        } else {
          console.error(`Failed to send response: ${result.status} ${result.statusText}`);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error sending response:', error.message);
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Sleep utility function
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Gets current poller status
   * @returns {object} - Status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeWorkers: this.pollingWorkers.length,
      activeRequests: this.activeControllers.size,
      host: this.host,
      prefix: this.prefix,
      tunnelId: this.tunnelId,
      concurrency: this.concurrency,
      lastHeartbeat: this.lastHeartbeat,
      heartbeatHealthy: this.lastHeartbeat && (Date.now() - this.lastHeartbeat) < this.heartbeatInterval * 2,
      authKeySet: !!this.authKey,
      version: '1.2.0'
    };
  }
}

module.exports = Poller;